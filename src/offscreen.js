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
    // Language pair picked in the tab's subtitle window. Sent to the backend
    // over the DataChannel (see sendLangConfig).
    langConfig: null,
    // Control payloads queued while the DataChannel is not open yet.
    pendingControl: [],
  };
}

// Language picks that arrived before their tab's session existed (the
// content script announces its defaults on load, which can predate
// start-recording). Applied when the session is created.
const pendingLangConfig = new Map();

// Pause presses that arrived before their tab's session existed. Applied
// when the session is created so an early pause still takes effect.
const pendingPaused = new Map();

function langPayload(config) {
  return JSON.stringify({
    type: "language-config",
    source_lang: config.source,
    target_lang: config.target,
  });
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
      try {
        await ensureConnection(session);
        // A fresh server-side session lost the previous language state.
        sendLangConfig(session);
      } catch (e) {
        console.warn(
          "RTC reconnect on resume failed, will retry on speech:",
          e,
        );
      }
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
          await startRecording(message.tabId, message.data);
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
            source: message.source || "en",
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
  } else if (msg.type === "error") {
    console.warn("Transcription server error:", msg.code, msg.message);
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

async function ensureConnection(session) {
  if (
    session.peerConnection?.connectionState === "connected" &&
    session.audioChannel?.readyState === "open"
  ) {
    return;
  }

  if (session.connectionPromise) {
    return session.connectionPromise;
  }

  session.connectionPromise = (async () => {
    await teardownPeerConnection(session);
    await setupPeerConnection(session);
  })();

  try {
    await session.connectionPromise;
  } finally {
    session.connectionPromise = null;
  }
}

async function startRecording(tabId, streamId) {
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
  // Picks announced before this session existed (content-script defaults).
  const knownLang = pendingLangConfig.get(tabId);
  if (knownLang) session.langConfig = knownLang;
  if (pendingPaused.get(tabId) === true) session.paused = true;

  // Set up the peer connection FIRST, before any audio await, mirroring how
  // the socket build opened its WebSocket first so transport failures surf
  // even if getUserMedia/audio setup below throws.
  try {
    await ensureConnection(session);

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
        try {
          await ensureConnection(session);
          while (session.preRollChunks.length > 0) {
            sendChunk(session, session.preRollChunks.shift());
          }
        } catch (error) {
          console.error("Failed to reconnect on speech:", error);
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
    // Announce the language pair (queued until the channel opens).
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
  };
  session.audioChannel.onclose = () => {
    session.audioChannel = null;
    console.log("Audio DataChannel is closed now.");
  };
  session.audioChannel.onerror = (error) => {
    console.error("DataChannel error observed:", error);
  };
  session.audioChannel.onmessage = (event) => {
    handleServerMessage(session, event.data);
  };

  const offer = await session.peerConnection.createOffer();
  await session.peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(session.peerConnection);
  const answer = await exchangeOffer(session.peerConnection.localDescription);
  await session.peerConnection.setRemoteDescription(answer);
  console.log("WebRTC peer connection established.");
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

async function exchangeOffer(localDescription) {
  const signalUrl = RTC_CONFIG.SIGNAL_URL;
  console.log(
    "Sending offer to signaling server:",
    signalUrl,
    localDescription,
  );
  const res = await fetch(signalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: localDescription.sdp,
      type: localDescription.type,
    }),
  });
  if (!res.ok) {
    throw new Error(`Signaling failed: ${res.status} ${res.statusText}`);
  }
  const answer = await res.json();
  console.log("Received answer from signaling server:", answer);
  return new RTCSessionDescription({
    sdp: answer.sdp,
    type: answer.type || "answer",
  });
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
