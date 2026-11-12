// Audio capture + processing chain, ported 1:1 from the socket extension:
// tab stream -> getUserMedia -> AudioContext -> MediaStreamSource ->
// AudioWorkletNode("recorder-processor") -> 24 kHz Int16 PCM 200 ms chunks.
//
// Only the transport changed: the WebSocket is gone. Chunks are sent over a
// reliable, ordered RTCDataChannel on an RTCPeerConnection negotiated with
// the backend via HTTP signaling (see rtc-config.js SIGNAL_URL).
//
// Multi-tab: Chrome MV3 allows only ONE offscreen document per extension, so
// this single document hosts one independent session per recording tab,
// keyed by tabId. Each session owns its MediaStream, recorder nodes, VAD
// instance, RTCPeerConnection/DataChannel, and caption buffers. All recorder
// chains share one AudioContext (see below); MicVAD keeps one context per
// session because it re-registers its worklet processor on every start.

import { RTC_CONFIG } from "./rtc-config.js";
import {
  CHANNEL_OPEN_TIMEOUT_MS,
  MAX_CONNECT_ATTEMPTS,
  SIGNAL_TIMEOUT_MS,
  computeRetryDelay,
} from "./retry-policy.mjs";
import { MicVAD } from "@ricky0123/vad-web";

// Chunks produced before the DataChannel opens are queued, then flushed on
// "open" (the socket build just dropped them with an error). Bounded so a
// failed negotiation can't grow memory without limit (~10 s at 200 ms/chunk).
const MAX_PENDING_CHUNKS = 50;
const PRE_ROLL_CHUNKS = 2;

const assetBase = chrome.runtime.getURL("vad-assets/");

const sessions = new Map();

// One AudioContext shared by every tab's recorder chain
// (MediaStreamSource -> "recorder-processor" AudioWorkletNode). Previously
// each session built its own, so N tabs meant N contexts plus N more inside
// MicVAD; now the recorder side costs one context total.
//
// MicVAD is deliberately excluded from sharing: each MicVAD.start() calls
// audioWorklet.addModule() for its helper worklet, and registering the same
// processor name twice on one context throws (InvalidStateError) with no
// opt-out in the library. One shared context for our own module is safe
// because we add it exactly once per context lifetime (flag below).
let sharedAudioContext = null;
let recorderModuleAdded = false;

async function getSharedAudioContext() {
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContext();
    recorderModuleAdded = false;
  }
  if (sharedAudioContext.state === "suspended") {
    try {
      await sharedAudioContext.resume();
    } catch (e) {
      console.warn("Shared AudioContext resume failed:", e);
    }
  }
  if (!recorderModuleAdded) {
    await sharedAudioContext.audioWorklet.addModule("recorder-processor.js");
    recorderModuleAdded = true;
  }
  return sharedAudioContext;
}

// Close the shared context only once the last session is gone. Per-tab stop
// just disconnects that tab's nodes and leaves the context running.
async function releaseSharedAudioContext() {
  if (sessions.size === 0 && sharedAudioContext) {
    const ctx = sharedAudioContext;
    sharedAudioContext = null;
    recorderModuleAdded = false;
    try {
      await ctx.close();
    } catch (e) {
      console.warn("Shared AudioContext close failed:", e);
    }
  }
}

function createSession(tabId) {
  return {
    tabId,
    // Supabase access token for the signaling POST (verified backend-side;
    // the session is billed to this user). Never logged.
    authToken: null,
    // Idempotency key for the logical subtitle session: minted per toolbar
    // start, reused across reconnects/retries so the backend bills it once.
    clientSessionId: null,
    // Terminal auth/quota failure code (auth_expired/quota_exceeded):
    // suppresses automatic background reconnects (manual Retry stays).
    authTerminal: null,
    recorderNode: null,
    mediaStreamSource: null,
    audioContext: null,
    mediaStream: null,
    peerConnection: null,
    audioChannel: null,
    pendingChunks: [],
    preRollChunks: [],
    vad: null,
    speechActive: false,
    // True while the tab's play/pause button is paused: audio chunks are
    // dropped and VAD is paused so the backend receives nothing.
    paused: false,
    transcriptBuffers: new Map(), // segKey -> { rev, text }
    currentItemId: null, // now holds the active segKey
    currentText: "",
    connectionPromise: null,
    // Mode/target picked in the tab's subtitle window. Sent to the backend
    // over the DataChannel (see sendLangConfig).
    langConfig: null,
    // Control payloads queued while the DataChannel is not open yet.
    pendingControl: [],
    // Connection lifecycle for the overlay's error/retry UI. While
    // "connecting"/"reconnecting" the tab shows a spinner; only a terminal
    // "error" (retries exhausted) shows the error message + Retry button.
    // Never stuck buffering silently: every terminal failure is broadcast.
    connectionStatus: "idle",
    connectAttempt: 0,
    reconnectTimer: null,
    // Set while stopRecording runs so channel/peer "closed" callbacks from
    // the intentional teardown don't trigger a background reconnect.
    stopping: false,
    // Last terminal connection error, for the startRecording failure path
    // (which re-broadcasts the error after stopRecording's caption-clear).
    lastConnectError: null,
  };
}

// A session is gone (stopped or never created): only log, never throw, so a
// stray timer or message can't crash the document.
function getLiveSession(session) {
  return session && !session.stopping && sessions.get(session.tabId) === session
    ? session
    : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Broadcast one connection-state step to the tab overlay (via the service
// worker, which forwards caption-status to the tab like captions). Best
// effort: the service worker may be restarting; the tab's watchdog covers a
// lost message (see content-script.js).
function notifyConnectionStatus(session, status, detail = {}) {
  session.connectionStatus = status;
  try {
    chrome.runtime.sendMessage({
      type: "caption-status",
      target: "captions",
      tabId: session.tabId,
      status,
      attempt: session.connectAttempt,
      maxAttempts: MAX_CONNECT_ATTEMPTS,
      message: detail.message || null,
    });
  } catch (e) {
    console.warn("Failed to broadcast caption-status:", e);
  }
}

// Language picks that arrived before their tab's session existed (the
// content script announces its defaults on load, which can predate
// start-recording). Applied when the session is created.
const pendingLangConfig = new Map();

// Pause presses that arrived before their tab's session existed. Applied
// when the session is created so an early pause still takes effect.
const pendingPaused = new Map();

function langPayload(config) {
  // Source language is never sent: the backend model auto-detects it.
  // Target is only meaningful (and only sent) in translation mode.
  const payload = {
    type: "language-config",
    mode: config.mode || "translation",
  };
  if (payload.mode === "translation") {
    payload.target_lang = config.target || "en";
  }
  return JSON.stringify(payload);
}

function flushPendingControl(session) {
  while (
    session.pendingControl.length &&
    session.audioChannel?.readyState === "open"
  ) {
    session.audioChannel.send(session.pendingControl.shift());
  }
}

function sendLangConfig(session) {
  if (!session.langConfig) return;
  const payload = langPayload(session.langConfig);
  if (session.audioChannel?.readyState === "open") {
    try {
      session.audioChannel.send(payload);
      return;
    } catch (e) {
      console.warn("language-config send failed, queueing:", e);
    }
  }
  if (session.pendingControl.length > 4) session.pendingControl.shift();
  session.pendingControl.push(payload);
}

function applyLangConfig(tabId, config) {
  pendingLangConfig.set(tabId, config);
  const session = sessions.get(tabId);
  if (session) {
    session.langConfig = config;
    sendLangConfig(session);
  }
}

async function applyPaused(tabId, paused) {
  pendingPaused.set(tabId, paused);
  const session = sessions.get(tabId);
  console.log(`applyPaused(${tabId}, ${paused}) session=${!!session}`);
  if (!session) return;
  session.paused = paused;
  if (paused) {
    // Drop anything already queued so resume starts from fresh audio
    // instead of replaying stale pre-roll.
    session.preRollChunks.length = 0;
    session.pendingChunks.length = 0;
    session.speechActive = false;
    if (session.vad) {
      try {
        await session.vad.pause();
      } catch (e) {
        console.warn("VAD pause failed:", e);
      }
    }
  } else {
    if (session.vad) {
      try {
        await session.vad.start();
      } catch (e) {
        console.warn("VAD resume failed:", e);
      }
    }
    // The backend can time out the RTC session while paused (no audio flows
    // during pause). Without a reconnect here the play button spins forever:
    // chunks queue on a dead channel and no transcripts arrive to clear the
    // buffering state. If the transport is no longer alive, tear down the
    // stale peer connection and start a fresh one now.
    if (!isConnectionAlive(session)) {
      // ensureConnection broadcasts connecting/reconnecting/error itself;
      // on terminal failure the overlay shows Retry and speech retriggers.
      const ok = await ensureConnection(session).catch((e) => {
        console.warn("RTC reconnect on resume failed:", e);
        return false;
      });
      // A fresh server-side session lost the previous language state.
      if (ok) sendLangConfig(session);
    }
  }
}

function updateRecordingHash() {
  window.location.hash = sessions.size > 0 ? "recording" : "";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "get-recordings") {
    sendResponse({ tabIds: [...sessions.keys()] });
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case "start-recording":
          if (message.tabId == null) {
            throw new Error("start-recording missing tabId");
          }
          await startRecording(message.tabId, message.data, {
            authToken: message.authToken || null,
            clientSessionId: message.clientSessionId || null,
          });
          break;
        case "stop-recording":
          if (message.tabId == null) {
            // Legacy global stop (old service worker): stop everything.
            console.warn("stop-recording with no tabId: stopping all sessions");
            await stopAllRecordings();
          } else {
            await stopRecording(message.tabId);
          }
          break;
        case "caption-language":
          if (message.tabId == null) {
            throw new Error("caption-language missing tabId");
          }
          applyLangConfig(message.tabId, {
            mode: message.mode || "translation",
            target: message.targetLang || "en",
          });
          break;
        case "pause-recording":
          if (message.tabId == null) {
            throw new Error("pause-recording missing tabId");
          }
          await applyPaused(message.tabId, true);
          break;
        case "resume-recording":
          if (message.tabId == null) {
            throw new Error("resume-recording missing tabId");
          }
          await applyPaused(message.tabId, false);
          break;
        case "retry-connection":
          // Manual Retry from the tab overlay's error state. Resets the
          // attempt budget and runs one fresh reconnect sequence in the
          // background; progress and the terminal outcome are broadcast as
          // caption-status like every other connection step.
          if (message.tabId == null) {
            throw new Error("retry-connection missing tabId");
          }
          await retryConnection(message.tabId);
          break;
        default:
          if (message.type === "caption" || message.type === "caption-clear") {
            // Our own caption broadcasts (echoed to all contexts); ignore.
            break;
          }
          throw new Error("Unrecognized message:", message.type);
      }
    } catch (e) {
      console.error(`offscreen ${message.type} failed:`, e);
    }
  })();
  return false;
});

function broadcastCaption(session, text, itemId, isFinal) {
  try {
    chrome.runtime.sendMessage({
      type: "caption",
      target: "captions",
      tabId: session.tabId,
      text,
      item_id: itemId,
      final: isFinal,
    });
  } catch (e) {
    // Service worker may be gone during teardown; captions are best-effort.
    console.warn("Failed to broadcast caption:", e);
  }
}

function clearCaptions(session) {
  session.transcriptBuffers.clear();
  session.currentItemId = null;
  session.currentText = "";
  try {
    chrome.runtime.sendMessage({
      type: "caption-clear",
      target: "captions",
      tabId: session.tabId,
    });
  } catch (e) {
    console.warn("Failed to clear captions:", e);
  }
}

function handleServerMessage(session, raw) {
  let msg;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw);
  } catch (e) {
    console.warn("Ignoring non-JSON DataChannel message:", raw);
    return;
  }

  if (msg.type === "transcript.delta") {
    // seg_id is the replace key; item_id stays as the upstream turn id.
    // Missing seg_id/rev means an old backend: fall back to append.
    const seg = msg.seg_id || msg.item_id;
    const rev = msg.rev || 0;
    const prev = session.transcriptBuffers.get(seg);
    let next;
    if (!prev || prev.rev !== rev) {
      next = msg.delta || ""; // new window or new revision: replace
    } else {
      next = prev.text + (msg.delta || ""); // token piece: append
    }
    session.transcriptBuffers.set(seg, { rev, text: next });
    session.currentItemId = seg;
    session.currentText = next;
    broadcastCaption(session, session.currentText, session.currentItemId, false);
  } else if (msg.type === "transcript.completed") {
    const seg = msg.seg_id || msg.item_id;
    const transcript = msg.transcript || "";
    if (transcript) {
      session.transcriptBuffers.set(seg, { rev: -1, text: transcript });
      session.currentItemId = seg;
      session.currentText = transcript;
      broadcastCaption(session, session.currentText, session.currentItemId, true);
      session.currentItemId = null;
      session.currentText = "";
    } else if (seg === session.currentItemId || !transcript) {
      // Empty completion (silence/VAD artifact): hide a stale line rather
      // than flashing an empty box.
      session.transcriptBuffers.delete(seg);
      if (seg === session.currentItemId) {
        session.currentItemId = null;
        session.currentText = "";
        broadcastCaption(session, "", seg, true);
      }
    }
  } else if (msg.type === "quota.update") {
    // Live quota from the backend (opening state, periodic refresh while
    // running, final commit). Forwarded to the tab overlay, which applies
    // it to the user menu's remaining-minutes display.
    try {
      chrome.runtime.sendMessage({
        type: "quota-update",
        target: "captions",
        tabId: session.tabId,
        quota: {
          used_seconds: msg.used_seconds,
          limit_seconds: msg.limit_seconds,
          remaining_seconds: msg.remaining_seconds,
          plan: msg.plan,
        },
      });
    } catch (e) {
      console.warn("Failed to broadcast quota-update:", e);
    }
  } else if (msg.type === "error") {
    // Server-side failure (e.g. backend transcription error): surface it in
    // the overlay instead of only logging. The transport itself is still up,
    // so the session keeps running — the overlay shows the message with a
    // Retry button that re-establishes the session server-side.
    //
    // Auth/quota errors are terminal for this transport: no automatic
    // background reconnect (the user signs in again, or upgrades and hits
    // Retry, which re-authorizes with a fresh signaling round-trip).
    if (msg.code === "quota_exceeded" || msg.code === "auth_expired") {
      session.authTerminal = msg.code;
    }
    console.warn("Transcription server error:", msg.code, msg.message);
    notifyConnectionStatus(session, "error", {
      message:
        msg.message || `Transcription failed${msg.code ? ` (${msg.code})` : ""}.`,
    });
  } else {
    console.log("DataChannel message received:", raw);
  }
}

// True only when audio can actually flow: the peer connection is connected
// AND the DataChannel is open. Anything else (connecting, disconnected,
// failed, closed, or torn down) means the session is no longer alive and the
// caller must reconnect via ensureConnection (which tears down the stale
// peer connection/channel and negotiates a fresh one).
function isConnectionAlive(session) {
  return (
    session.peerConnection?.connectionState === "connected" &&
    session.audioChannel?.readyState === "open"
  );
}

// One raw connect attempt: drop the stale transport, negotiate a fresh one.
async function connectOnce(session) {
  await teardownPeerConnection(session);
  await setupPeerConnection(session);
}

// Connect with bounded retries and exponential backoff, broadcasting every
// step so the tab overlay never sits on "Waiting for subtitles" while the
// backend is down: "connecting" on the first attempt, "reconnecting" while
// retrying, "connected" on success, and a terminal "error" once the budget
// (see retry-policy.mjs) is exhausted. Resolves true on success, false on
// terminal failure; concurrent callers collapse onto the in-flight sequence.
async function ensureConnection(session) {
  if (isConnectionAlive(session)) {
    if (session.connectionStatus !== "connected") {
      notifyConnectionStatus(session, "connected");
    }
    return true;
  }

  if (session.connectionPromise) {
    return session.connectionPromise;
  }

  session.connectionPromise = (async () => {
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      if (!getLiveSession(session)) return false;
      session.connectAttempt = attempt;
      notifyConnectionStatus(
        session,
        attempt === 1 ? "connecting" : "reconnecting",
      );
      try {
        await connectOnce(session);
        if (!getLiveSession(session)) return false;
        session.connectAttempt = 0;
        notifyConnectionStatus(session, "connected");
        return true;
      } catch (e) {
        console.warn(
          `Connection attempt ${attempt}/${MAX_CONNECT_ATTEMPTS} for tab ${session.tabId} failed:`,
          e?.message || e,
        );
        if (attempt >= MAX_CONNECT_ATTEMPTS) {
          if (!getLiveSession(session)) return false;
          session.lastConnectError = e;
          notifyConnectionStatus(session, "error", {
            message: friendlyConnectError(e),
          });
          return false;
        }
        await sleep(computeRetryDelay(attempt));
      }
    }
    return false;
  })();

  try {
    return await session.connectionPromise;
  } finally {
    session.connectionPromise = null;
  }
}

// Short, actionable overlay text for a terminal connection failure.
function friendlyConnectError(e) {
  const detail = e?.message || String(e || "");
  if (/auth_expired|session expired/i.test(detail)) {
    return "Session expired. Sign in again to continue captions.";
  }
  if (/quota_exceeded|quota exhausted/i.test(detail)) {
    return detail.replace(/^quota_exceeded:\s*/, "");
  }
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return "Couldn't reach the transcription server. Check that the backend is running, then retry.";
  }
  if (/signaling failed/i.test(detail)) {
    return `Transcription server refused the connection (${detail}). Retry, or restart the backend.`;
  }
  return "Connection to the transcription server failed. Retry when the backend is back.";
}

// A dropped mid-session transport (peer "failed", channel closed) heals
// itself in the background without tearing down the audio chain: chunks
// queue (bounded) while reconnecting and flush on "open". Terminal failure
// leaves the session up so the overlay's Retry button can reconnect.
function scheduleReconnect(session) {
  const live = getLiveSession(session);
  if (!live || session.connectionPromise || session.reconnectTimer) return;
  // Terminal auth/quota failure: background reconnects would just burn
  // signaling calls. The overlay shows Retry for the user's next action.
  if (live.authTerminal) return;
  if (isConnectionAlive(session)) return;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    const current = getLiveSession(session);
    if (!current || isConnectionAlive(current)) return;
    (async () => {
      const ok = await ensureConnection(current);
      if (ok) {
        // A fresh server-side session lost the previous language state.
        sendLangConfig(current);
      }
    })().catch((e) => {
      console.warn("Background reconnect failed:", e?.message || e);
    });
  }, 500);
}

// Manual Retry from the overlay: fresh attempt budget, then one reconnect
// sequence. Unknown tab (session already torn down) still answers with an
// error status so the overlay never hangs waiting.
async function retryConnection(tabId) {
  const session = sessions.get(tabId);
  if (!session || session.stopping) {
    try {
      chrome.runtime.sendMessage({
        type: "caption-status",
        target: "captions",
        tabId,
        status: "error",
        attempt: MAX_CONNECT_ATTEMPTS,
        maxAttempts: MAX_CONNECT_ATTEMPTS,
        message:
          "Session already stopped. Close this panel and start captions again from the toolbar.",
      });
    } catch (e) {
      console.warn("Failed to broadcast caption-status:", e);
    }
    return;
  }
  if (session.connectionPromise) return;
  session.connectAttempt = 0;
  const ok = await ensureConnection(session);
  if (ok) sendLangConfig(session);
}

async function startRecording(tabId, streamId, opts = {}) {
  let session = sessions.get(tabId);
  if (session?.recorderNode) {
    throw new Error(
      `Called startRecording while recording is in progress for tab ${tabId}.`
    );
  }
  if (!session) {
    session = createSession(tabId);
    sessions.set(tabId, session);
    updateRecordingHash();
  }
  // Fresh toolbar start: new identity for billing; a reconnecting session
  // object keeps the id it was created with.
  session.authToken = opts.authToken || session.authToken || null;
  session.clientSessionId =
    opts.clientSessionId || session.clientSessionId || `tab-${tabId}-${Date.now()}`;
  session.authTerminal = null;
  // Picks announced before this session existed (content-script defaults).
  const knownLang = pendingLangConfig.get(tabId);
  if (knownLang) session.langConfig = knownLang;
  if (pendingPaused.get(tabId) === true) session.paused = true;

  // Set up the peer connection FIRST, before any audio await, mirroring how
  // the socket build opened its WebSocket first so transport failures surf
  // even if getUserMedia/audio setup below throws.
  try {
    const connected = await ensureConnection(session);
    if (!connected) {
      // Retries exhausted (e.g. backend down): don't leave the tab spinning
      // on "Waiting for subtitles". stopRecording's caption-clear would
      // reset the overlay to buffering, so re-broadcast the terminal error
      // AFTER it, then tell the service worker to drop the tab (without
      // overlay teardown — the error + Retry button must stay visible).
      // The overlay's Retry button starts a fresh session via the toolbar
      // flow. The throw keeps the existing failure logging contract.
      const err = session.lastConnectError || new Error("Connection failed.");
      await stopRecording(tabId);
      notifyConnectionStatus(session, "error", {
        message: friendlyConnectError(err),
      });
      try {
        await chrome.runtime.sendMessage({ type: "session-failed", tabId });
      } catch (e) {
        console.warn("session-failed delivery failed:", e);
      }
      throw err;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
    session.mediaStream = stream;

    // A capture track can fire "ended" during a silent stretch with no
    // detectable audio (or a transient capture gap) while the user still
    // wants translation. Never tear the session down here: the document
    // and session stay up until the user explicitly stops translation
    // (action toggle -> explicit stop-recording) or the tab goes away
    // (the service worker sends an explicit stop-recording for that tab).
    // If audio resumes on this stream it keeps flowing; if the track is
    // truly dead the session idles until the explicit stop arrives.
    const tabIdForClosure = tabId;
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        console.warn(
          `Capture track ended for tab ${tabIdForClosure}; keeping session open until explicit stop.`
        );
      });
    }

    session.vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: assetBase,
      onnxWASMBasePath: assetBase,
      getStream: async () => stream,
      pauseStream: async () => {},
      // Resume must reuse the tab capture stream. The library default calls
      // getUserMedia for the microphone, which fails in the offscreen
      // document with NotAllowedError: Permission dismissed.
      resumeStream: async (oldStream) => oldStream ?? stream,
      onSpeechStart: async () => {
        if (session.paused) return;
        session.speechActive = true;
        console.log("Speech detected");
        // Terminal failure is already shown in the overlay with Retry; skip
        // the pre-roll flush then (no transport to flush to).
        const ok = await ensureConnection(session).catch((error) => {
          console.error("Failed to reconnect on speech:", error);
          return false;
        });
        if (!ok) return;
        while (session.preRollChunks.length > 0) {
          sendChunk(session, session.preRollChunks.shift());
        }
      },
      onSpeechEnd() {
        session.speechActive = false;
        console.log("Speech ended");
      },
    });

    session.vad.start();
    if (session.paused) {
      try {
        await session.vad.pause();
      } catch (e) {
        console.warn("VAD initial pause failed:", e);
      }
    }

    session.audioContext = await getSharedAudioContext();

    session.mediaStreamSource =
      session.audioContext.createMediaStreamSource(stream);
    session.recorderNode = new AudioWorkletNode(
      session.audioContext,
      "recorder-processor"
    );

    session.recorderNode.port.onmessage = (event) => {
      // event.data already IS the transferred ArrayBuffer (see
      // recorder-processor.js flushChunk), so send it directly.
      if (session.paused) return;
      const chunk = event.data;
      if (session.speechActive) {
        sendChunk(session, chunk);
        return;
      }

      // Retain recent audio in case speech is detected slightly late.
      session.preRollChunks.push(chunk);

      if (session.preRollChunks.length > PRE_ROLL_CHUNKS) {
        session.preRollChunks.shift();
      }
    };

    session.mediaStreamSource.connect(session.recorderNode);
    session.mediaStreamSource.connect(session.audioContext.destination);
    session.recorderNode.port.postMessage("start");

    clearCaptions(session);
    // Announce the mode/target (queued until the channel opens).
    sendLangConfig(session);
    updateRecordingHash();
    console.log("Windowlocation", window.location);
  } catch (e) {
    console.error("startRecording failed, tearing down session:", e);
    await stopRecording(tabId);
    throw e;
  }
}

async function setupPeerConnection(session) {
  const iceServers = RTC_CONFIG.ICE_SERVERS || [];
  const label = RTC_CONFIG.DATA_CHANNEL_LABEL || "audio";
  session.peerConnection = new RTCPeerConnection({ iceServers });
  session.audioChannel = session.peerConnection.createDataChannel(label, {
    ordered: true,
  });
  session.audioChannel.binaryType = "arraybuffer";
  session.audioChannel.bufferedAmountLowThreshold = 1024 * 1024;

  session.audioChannel.onopen = () => {
    console.log("Audio DataChannel is open now.");
    // Control messages first so the backend knows the languages before the
    // audio they describe starts arriving.
    flushPendingControl(session);
    flushPendingChunks(session);
    const live = getLiveSession(session);
    if (live) {
      live.connectAttempt = 0;
      notifyConnectionStatus(live, "connected");
    }
  };
  session.audioChannel.onclose = () => {
    session.audioChannel = null;
    console.log("Audio DataChannel is closed now.");
    // A mid-session close (backend restart, network drop) heals itself in
    // the background; the overlay shows "reconnecting" until it lands.
    // Intentional stops and in-flight retries are ignored inside.
    scheduleReconnect(session);
  };
  session.audioChannel.onerror = (error) => {
    console.error("DataChannel error observed:", error);
  };
  session.audioChannel.onmessage = (event) => {
    handleServerMessage(session, event.data);
  };
  session.peerConnection.onconnectionstatechange = () => {
    const state = session.peerConnection?.connectionState;
    console.log(`Peer connection state for tab ${session.tabId}:`, state);
    if (state === "failed" || state === "disconnected" || state === "closed") {
      scheduleReconnect(session);
    }
  };

  const offer = await session.peerConnection.createOffer();
  await session.peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(session.peerConnection);
  const answer = await exchangeOffer(session.peerConnection.localDescription, session);
  await session.peerConnection.setRemoteDescription(answer);
  console.log("WebRTC peer connection established.");
  // Signaling can succeed while the channel itself never opens; without this
  // wait the attempt would resolve and the overlay would stick on
  // "connecting" with no transport. Timeout counts as a failed attempt.
  await waitForChannelOpen(session.audioChannel);
}

// Resolves when the channel opens, rejects if it closes/errors first or the
// open takes longer than CHANNEL_OPEN_TIMEOUT_MS. Wraps (never replaces)
// the session handlers attached by setupPeerConnection, so flush/notify on
// open and reconnect-on-close keep working whichever settles first.
function waitForChannelOpen(channel) {
  if (!channel) return Promise.reject(new Error("No audio DataChannel."));
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const prevOpen = channel.onopen;
    const prevClose = channel.onclose;
    const prevError = channel.onerror;
    const timer = setTimeout(() => {
      reject(
        new Error(
          `DataChannel did not open within ${CHANNEL_OPEN_TIMEOUT_MS} ms.`
        )
      );
    }, CHANNEL_OPEN_TIMEOUT_MS);
    channel.onopen = (event) => {
      clearTimeout(timer);
      try {
        prevOpen?.call(channel, event);
      } finally {
        resolve();
      }
    };
    channel.onclose = (event) => {
      clearTimeout(timer);
      try {
        prevClose?.call(channel, event);
      } finally {
        reject(new Error("DataChannel closed before opening."));
      }
    };
    channel.onerror = (event) => {
      clearTimeout(timer);
      try {
        prevError?.call(channel, event);
      } finally {
        reject(
          event instanceof Error ? event : new Error("DataChannel error.")
        );
      }
    };
  });
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, 5000);
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

async function exchangeOffer(localDescription, session) {
  const signalUrl = RTC_CONFIG.SIGNAL_URL;
  console.log("Sending offer to signaling server:", signalUrl);
  const headers = { "Content-Type": "application/json" };
  // The user's own access token; verified backend-side (service_role key
  // never enters the extension).
  if (session?.authToken) {
    headers["Authorization"] = `Bearer ${session.authToken}`;
  }
  // A hung backend must fail this attempt fast (into the retry loop), not
  // hang one attempt forever while the overlay spins.
  const res = await fetch(signalUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sdp: localDescription.sdp,
      type: localDescription.type,
      client_session_id: session?.clientSessionId || undefined,
    }),
    signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    let code = null;
    let quota = null;
    try {
      const body = await res.json();
      code = body?.code || null;
      quota = body?.quota || null;
    } catch (e) { /* non-JSON error page */ }
    if (res.status === 401 || code === "auth_expired") {
      if (session) session.authTerminal = "auth_expired";
      throw new Error("auth_expired: Session expired. Sign in again.");
    }
    if (res.status === 402 || code === "quota_exceeded") {
      if (session) session.authTerminal = "quota_exceeded";
      if (quota && session) broadcastQuota(session, quota);
      throw new Error(
        `quota_exceeded: ${quota ? `${Math.max(Math.ceil((quota.remaining_seconds || 0) / 60), 0)} min left. ` : ""}Subtitle quota exhausted. Upgrade your plan to continue.`,
      );
    }
    throw new Error(`Signaling failed: ${res.status} ${res.statusText}`);
  }
  const answer = await res.json();
  console.log("Received answer from signaling server.");
  // Opening quota state rides the answer so the menu is live immediately.
  if (answer?.quota && session) broadcastQuota(session, answer.quota);
  return new RTCSessionDescription({
    sdp: answer.sdp,
    type: answer.type || "answer",
  });
}

function broadcastQuota(session, quota) {
  try {
    chrome.runtime.sendMessage({
      type: "quota-update",
      target: "captions",
      tabId: session.tabId,
      quota: {
        used_seconds: quota.used_seconds,
        limit_seconds: quota.limit_seconds,
        remaining_seconds: quota.remaining_seconds,
        plan: quota.plan,
      },
    });
  } catch (e) {
    console.warn("Failed to broadcast quota-update:", e);
  }
}

function sendChunk(session, audioData) {
  if (session.paused) return;
  if (session.audioChannel && session.audioChannel.readyState === "open") {
    if (session.pendingChunks.length) flushPendingChunks(session);
    session.audioChannel.send(audioData);
  } else if (session.audioChannel) {
    if (session.pendingChunks.length >= MAX_PENDING_CHUNKS)
      session.pendingChunks.shift();
    session.pendingChunks.push(audioData);
  } else if (session.connectionStatus === "error") {
    // Terminal failure already shown in the overlay with a Retry button;
    // drop quietly instead of logging per chunk (5/s) until reconnect.
  } else {
    console.error("No audio DataChannel. State: no peer connection");
  }
}

function flushPendingChunks(session) {
  while (
    session.pendingChunks.length &&
    session.audioChannel?.readyState === "open"
  ) {
    session.audioChannel.send(session.pendingChunks.shift());
  }
}

async function stopRecording(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    pendingPaused.delete(tabId);
    return;
  }
  // Intentional stop: suppress reconnect triggers from the teardown below.
  session.stopping = true;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  if (session.recorderNode) {
    session.recorderNode.port.postMessage("stop");
    // Let the worklet deliver its final flush chunk before disconnecting.
    await new Promise((r) => setTimeout(r, 100));
    try {
      session.recorderNode.disconnect();
    } catch (e) {
      console.warn("recorderNode.disconnect failed:", e);
    }
    try {
      session.mediaStreamSource?.disconnect();
    } catch (e) {
      console.warn("mediaStreamSource.disconnect failed:", e);
    }
    // Nodes are per-session, but the context is shared: never close it here.
    session.recorderNode = null;
    session.mediaStreamSource = null;
    session.audioContext = null;
  }

  if (session.mediaStream) {
    session.mediaStream.getTracks().forEach((t) => t.stop());
    session.mediaStream = null;
  }

  if (session.vad) {
    await session.vad.pause();
    session.vad = null;
  }
  session.speechActive = false;
  session.preRollChunks.length = 0;
  clearCaptions(session);

  await teardownPeerConnection(session);
  sessions.delete(tabId);
  pendingPaused.delete(tabId);
  updateRecordingHash();
  // Last session out closes the shared recorder context; otherwise it stays
  // up for the remaining tabs.
  await releaseSharedAudioContext();
  console.log(`Session for tab ${tabId} stopped (${sessions.size} left).`);
}

async function stopAllRecordings() {
  for (const tabId of [...sessions.keys()]) {
    await stopRecording(tabId);
  }
}

async function teardownPeerConnection(session) {
  if (session.audioChannel) {
    try {
      if (session.audioChannel.readyState === "open") {
        flushPendingChunks(session);
        await new Promise((r) => setTimeout(r, 200));
      } else if (session.pendingChunks.length) {
        console.warn(
          `Dropping ${session.pendingChunks.length} unsent audio chunks; DataChannel never opened.`,
        );
      }
      session.audioChannel.close();
    } catch (e) {
      console.error("Error closing DataChannel:", e);
    }
    session.audioChannel = null;
  }
  session.pendingChunks = [];

  if (session.peerConnection) {
    try {
      session.peerConnection.close();
    } catch (e) {
      console.error("Error closing peer connection:", e);
    }
    session.peerConnection = null;
  }
}
