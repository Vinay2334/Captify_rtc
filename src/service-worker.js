import {
  DEFAULT_CONFIG,
  loadRemoteConfig,
  resolveOverlayApiPrefix,
  resolveSiteUrl,
} from "./remote-config.mjs";

let data = [];

// Tabs currently being captioned. Captions flow offscreen -> service worker
// -> that tab's content script, so each overlay lands on the page the user
// is watching rather than in the hidden offscreen document.
//
// NOTE: Chrome MV3 allows only ONE offscreen document per extension, so we
// keep a single shared offscreen.html that multiplexes one recording session
// per tab (keyed by tabId) instead of one document per tab.
const recordingTabs = new Set();

// The overlay injects only here, on explicit user activation (toolbar
// click, sign-in from the gate/menu): there is no manifest content_scripts
// entry, so opening a page never loads Captify. The click gesture grants
// activeTab, which covers this injection without any <all_urls> host
// permission.
async function ensureCaptionScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      // Order matters: caption-overlay/* are classic scripts that register
      // window.CaptifyOverlay before content-script.js consumes it.
      files: [
        "caption-overlay/lib/constants.js",
        "caption-overlay/lib/state.js",
        "caption-overlay/lib/session.js",
        "caption-overlay/styles/overlay.css.js",
        "caption-overlay/components/dropdown.js",
        "caption-overlay/components/status-bar.js",
        "caption-overlay/components/subtitle-panel.js",
        "caption-overlay/components/captions.js",
        "caption-overlay/lib/icons.js",
        "caption-overlay/lib/supabase-config.js",
        "caption-overlay/lib/supabase-auth.js",
        "caption-overlay/lib/user-store.js",
        "caption-overlay/components/ui.js",
        "caption-overlay/styles/user-menu.css.js",
        "caption-overlay/components/user-menu.js",
        "caption-overlay/styles/sign-in-gate.css.js",
        "caption-overlay/components/sign-in-gate.js",
        "content-script.js",
      ],
    });
  } catch (e) {
    // Expected on chrome://, edge://, Chrome Web Store, etc. where content
    // scripts can't run; anywhere else this runs right after a user
    // gesture, so activeTab covers the injection.
    console.warn("Caption script injection skipped:", e?.message || e);
  }
}

// Public pricing site (from DEFAULT_CONFIG in remote-config.mjs; the
// overlay's classic supabase-config.js mirrors the same value).
// The overlay builds the upgrade URL with the account attached; the worker
// opens it only when it stays on this origin.
const SITE_URL = DEFAULT_CONFIG.site_url;

// Captify only works signed in. The overlay's user store persists its
// state under this key (caption-overlay/lib/user-store.js); the worker is
// the enforcement point — no capture session starts while signed out.
async function isSignedIn() {
  try {
    const res = await chrome.storage.local.get("captifyUserState");
    return !!res?.captifyUserState?.signedIn;
  } catch (e) {
    return false;
  }
}

// The user's own Supabase access token (lib/supabase-auth.js persists it
// under this key). Forwarded to the offscreen document, which attaches it
// to the WebRTC signaling POST; the backend verifies it and bills the
// session to this user. The service_role key never enters the extension.
async function getAccessToken() {
  try {
    const res = await chrome.storage.local.get("captifySupabaseSession");
    return res?.captifySupabaseSession?.access_token || null;
  } catch (e) {
    return null;
  }
}

// The backend rejected the session as expired/invalid: drop the client
// token and the signed-out-pending user state so no new capture can start
// with the dead token. Overlays watching storage fall back to the sign-in
// gate; the explicit session-expired broadcast below clears their
// in-memory auth too.
async function clearExpiredClientSession() {
  try {
    await chrome.storage.local.remove([
      "captifySupabaseSession",
      "captifyUserState",
    ]);
  } catch (e) {
    // Storage unavailable — overlays still sign out from the broadcast.
  }
}

// Expired session: stop every capture like a sign-out (overlays stay up
// showing the gate), then tell each overlay to drop its in-memory auth.
async function handleSessionExpired(tabId) {
  await clearExpiredClientSession();
  await reconcileRecordingTabs();
  const targets = new Set([...recordingTabs]);
  if (tabId != null) targets.add(tabId);
  for (const id of targets) {
    if (recordingTabs.has(id)) {
      await stopTabRecording(id, { teardownOverlay: false });
    }
    await sendToTab(id, { type: "session-expired", tabId: id });
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.warn("Failed to forward caption to tab:", e?.message || e);
  }
}

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({});
  const offscreenDocument = existingContexts.find(
    (c) => c.contextType === "OFFSCREEN_DOCUMENT",
  );
  if (!offscreenDocument) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      // USER_MEDIA covers tabCapture/getUserMedia, WEB_RTC the
      // RTCPeerConnection/DataChannel, AUDIO_PLAYBACK the monitored tab
      // audio plumbed through the offscreen AudioContext. Declaring the
      // actual API usage keeps Chrome from reclaiming the document during
      // silent stretches with no detectable audio.
      reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
      justification:
        "Capture tab audio via tabCapture, run VAD on it, and stream it over a WebRTC DataChannel",
    });
  }
}

// Close the shared offscreen document only when no tab is recording.
// Per-tab teardown just stops that tab's session inside the document.
async function maybeCloseOffscreen() {
  if (recordingTabs.size > 0) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Already closed (e.g. after a service-worker restart) — not an error.
    console.warn("offscreen close skipped:", e?.message || e);
  }
  chrome.action.setIcon({ path: "icons/not-recording.png" });
}

// Reconcile in-memory state after a service-worker restart: the offscreen
// document outlives us, so ask it which tabs are still recording.
async function reconcileRecordingTabs() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "get-recordings",
      target: "offscreen",
    });
    if (res && Array.isArray(res.tabIds)) {
      for (const tabId of res.tabIds) {
        try {
          await chrome.tabs.get(tabId);
          recordingTabs.add(tabId);
        } catch (e) {
          // Tab went away while the service worker was stopped: drop its
          // orphaned session so the document can close once truly idle.
          try {
            await chrome.runtime.sendMessage({
              type: "stop-recording",
              target: "offscreen",
              tabId,
            });
          } catch (stopError) {
            console.warn(
              "orphan stop failed:",
              stopError?.message || stopError,
            );
          }
        }
      }
    }
  } catch (e) {
    console.warn("get-recordings delivery failed:", e?.message || e);
    // No offscreen document yet — nothing to reconcile.
  }
}

async function stopTabRecording(tabId, { teardownOverlay = true } = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: "stop-recording",
      target: "offscreen",
      tabId,
    });
  } catch (e) {
    console.warn("stop-recording delivery failed:", e?.message || e);
  }
  // Sign-out stops the session but keeps the overlay up showing the gate.
  if (teardownOverlay) await sendToTab(tabId, { type: "caption-teardown" });
  recordingTabs.delete(tabId);
  try {
    await chrome.action.setIcon({ path: "icons/not-recording.png", tabId });
  } catch (e) {
    // Tab may already be gone; the global icon reset in
    // maybeCloseOffscreen covers the last-session case.
  }
  await maybeCloseOffscreen();
}

// Start (or restart) captioning for one tab: capture, offscreen session,
// overlay reveal. Shared by the toolbar toggle and the overlay's Retry
// button (which fires after a terminal connection error tore the session
// down). Throws on synchronous failures (e.g. tabCapture denied); backend
// connectivity failures surface later via caption-status from offscreen.
async function startTabRecording(tabId, { initializeOverlay = true } = {}) {
  await ensureOffscreen();

  // Get a MediaStream for the tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId,
  });

  recordingTabs.add(tabId);
  if(initializeOverlay) await ensureCaptionScript(tabId);

  // Send the stream ID to the offscreen document to start this tab's
  // session. The offscreen document may not have registered its onMessage
  // listener yet right after createDocument, in which case sendMessage
  // rejects and the message would be silently lost. Retry until it lands.
  //
  // clientSessionId identifies this logical subtitle session across
  // reconnects/retries so the backend bills it exactly once (idempotent
  // commit). A fresh toolbar start mints a new id; a Retry reuses it.
  const message = {
    type: "start-recording",
    target: "offscreen",
    tabId,
    data: streamId,
    authToken: await getAccessToken(),
    clientSessionId:
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await chrome.runtime.sendMessage(message);
        break;
      } catch (e) {
        if (attempt === 19) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch (e) {
    recordingTabs.delete(tabId);
    await maybeCloseOffscreen();
    throw e;
  }

  chrome.action.setIcon({ path: "/icons/recording.png", tabId });

  // Reveal the tab's overlay immediately so the subtitle box (with its
  // buffering play button) is visible on icon click, before the backend's
  // first transcript arrives. The session's caption-clear broadcast covers
  // this too; this direct message covers already-injected scripts.
  await sendToTab(tabId, { type: "caption-show" });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id == null) return;
  await reconcileRecordingTabs();
  // Toggle recording for the clicked tab only; other tabs keep recording.
  if (recordingTabs.has(tab.id)) {
    await stopTabRecording(tab.id);
    return;
  }

  if (!(await isSignedIn())) {
    // Signed out: reveal the subtitle window with its sign-in gate only.
    // No tabCapture, no offscreen session — Captify runs after sign-in,
    // which arrives as a captify-menu-action from the overlay.
    await ensureCaptionScript(tab.id);
    await sendToTab(tab.id, { type: "caption-show" });
    return;
  }

  await startTabRecording(tab.id);
});

// When a tab closes, stop only that tab's session. The shared offscreen
// document stays alive while other tabs are still recording and closes
// once the last session ends.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!recordingTabs.has(tabId)) return;
  console.log("tab closed, stopping recording for tab", tabId);
  await stopTabRecording(tabId);
});

// A recording tab finished loading: without manifest auto-inject, the
// overlay only still exists if the navigation kept the document (SPA).
// Ping it: an answer means the overlay survived and just needs
// re-showing; silence means the page (and its overlay) is gone, so stop
// that tab's session instead of captioning a document that no longer
// exists (and billing audio nobody watches).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "complete" && recordingTabs.has(tabId)) {
    let alive = false;
    try {
      await chrome.tabs.sendMessage(tabId, { type: "caption-ping" });
      alive = true;
    } catch (e) {
      alive = false;
    }
    if (alive) {
      await sendToTab(tabId, { type: "caption-show" });
    } else {
      console.log("tab navigated away, stopping recording for tab", tabId);
      await stopTabRecording(tabId, { teardownOverlay: false });
    }
  }
});

// The auth form lives on a separate page (signin.html) because the
// subtitle overlay is too small for comfortable input. The gate/menu ask
// for it with "open-signin"; the worker opens a focused popup carrying
// the originating tab id, and the page reports back "sign-in" with it.
async function openSigninPage(tabId) {
  const url = new URL(chrome.runtime.getURL("signin.html"));
  if (tabId != null) url.searchParams.set("tabId", String(tabId));
  try {
    await chrome.windows.create({
      url: url.toString(),
      type: "popup",
      width: 420,
      height: 640,
      focused: true,
    });
  } catch (e) {
    console.warn("open-signin failed:", e?.message || e);
  }
}

// Overlay backend reads (quota display, plan catalog). Content-script
// fetches run under the page's origin, so on public sites Private/Local
// Network Access blocks loopback outright (the page gets a CORS error for
// quota AND plans). The worker fetches with host permissions instead (no
// page origin, no preflight block); auth stays with the overlay (it owns
// the token and passes it as a header, same as its direct fetches did).
// Only backend-API URLs go out (mirrors the upgrade allow-list below) —
// from DEFAULT_CONFIG in remote-config.mjs (derived from the same
// backend_base_url as the overlay's BACKEND_BASE_URL).
const OVERLAY_API_PREFIX = DEFAULT_CONFIG.overlay_api_prefix;

// Over-the-air backend/redirect URLs (see src/remote-config.mjs). The
// storage cache holds the last validated hosted document; the packaged
// remote-config/extension-config.json copy covers offline first runs.
let cachedRemoteConfig = null;

async function getRemoteConfig() {
  if (cachedRemoteConfig) return cachedRemoteConfig;
  try {
    cachedRemoteConfig = await loadRemoteConfig();
  } catch (e) {
    cachedRemoteConfig = null;
  }
  return cachedRemoteConfig;
}

// Refresh the cache in the background on every worker start (workers restart
// often, so this stays fresh without slowing any message handler).
loadRemoteConfig({ refresh: true })
  .then((config) => {
    if (config) cachedRemoteConfig = config;
  })
  .catch(() => {});

// Allow-listed API prefixes: the baked-in prefix plus the validated remote
// one. Both are data from reviewed sources, never code.
async function allowedApiPrefixes() {
  const prefixes = [OVERLAY_API_PREFIX];
  const remote = resolveOverlayApiPrefix(await getRemoteConfig(), OVERLAY_API_PREFIX);
  if (!prefixes.includes(remote)) prefixes.push(remote);
  return prefixes;
}

// Same pair for the pricing-site origin guard on upgrade URLs.
async function allowedSiteUrls() {
  const sites = [SITE_URL];
  const remote = resolveSiteUrl(await getRemoteConfig(), SITE_URL);
  if (!sites.includes(remote)) sites.push(remote);
  return sites;
}

async function fetchForOverlay(url, headers) {
  const prefixes = await allowedApiPrefixes();
  if (
    typeof url !== "string" ||
    !prefixes.some((prefix) => url.startsWith(prefix))
  ) {
    return { status: 0, ok: false, body: null, reason: "blocked_url" };
  }
  try {
    const res = await fetch(url, { headers: headers || {} });
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    return { status: 0, ok: false, body: null, reason: "backend_unreachable" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "captify-overlay-data") {
    fetchForOverlay(message.url, message.headers).then(
      (result) => { try { sendResponse?.({ ok: true, ...result }); } catch (e) {} },
      () => { try { sendResponse?.({ ok: false, status: 0, body: null }); } catch (e) {} },
    );
    return true; // async reply: keep the channel open
  }
  return false;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "open-signin") {
      await openSigninPage(message.tabId ?? sender?.tab?.id);
      sendResponse?.({ ok: true, handled: true });
      return;
    }
    if (message.type === "captify-menu-action") {
      // User-menu / sign-in-gate actions from a tab overlay. The overlay
      // already flipped its local state (caption-overlay/lib/user-store.js);
      // here we enforce it: sign-in starts this tab's session, sign-out
      // stops it (overlay stays up showing the gate).
      const tabId = message.tabId ?? sender?.tab?.id;
      if (message.action === "sign-in" && tabId != null) {
        await reconcileRecordingTabs();
        if (!recordingTabs.has(tabId)) {
          try {
            await startTabRecording(tabId, { initializeOverlay: false });
          } catch (e) {
            console.warn("sign-in start failed:", e?.message || e);
            await sendToTab(tabId, {
              type: "caption-status",
              tabId,
              status: "error",
              message:
                "Couldn't start captions.",
            });
          }
        }
      } else if (message.action === "sign-out") {
        // Signed out everywhere: stop every tab's session. Overlays stay
        // up showing the sign-in gate (their stores sync via storage).
        await reconcileRecordingTabs();
        for (const id of [...recordingTabs]) {
          await stopTabRecording(id, { teardownOverlay: false });
        }
      } else if (message.action === "upgrade") {
        // Open pricing with the account attached (built by the overlay's
        // user store). Only same-origin URLs go out — anything else is a
        // broken config or a spoofed message, never a tab.
        const url = message.url;
        const sites = await allowedSiteUrls();
        if (
          typeof url === "string" &&
          sites.some((base) => url.startsWith(base + "/"))
        ) {
          try {
            await chrome.tabs.create({ url });
          } catch (e) {
            console.warn("upgrade tab open failed:", e?.message || e);
          }
        } else {
          console.warn("upgrade ignored: URL outside SITE_URL");
        }
      }
      sendResponse?.({ ok: true, handled: true });
      return;
    }
    if (message.type === "session-expired") {
      // The backend rejected the token (signaling 401 or an auth error
      // over the DataChannel): remove it client-side, stop capture, and
      // drive every overlay to the signed-out UI.
      const tabId = message.tabId ?? sender?.tab?.id;
      await handleSessionExpired(tabId);
      sendResponse?.({ ok: true, handled: true });
      return;
    }
    if (message.type === "caption-close") {
      // Close button clicked inside the tab's subtitle menu bar:
      // stop this tab's offscreen recording session and tear down offscreen.html
      // once no tabs remain recording.
      const tabId = message.tabId ?? sender?.tab?.id;
      await reconcileRecordingTabs();
      if (tabId != null) {
        await stopTabRecording(tabId);
      }
      sendResponse?.({ ok: true });
      return;
    }
    if (message.type === "caption-retry") {
      // Retry button in the tab overlay's error state. A live session
      // (mid-session drop) just reconnects; a torn-down session (startup
      // failure) needs a full restart with a fresh capture stream.
      const tabId = message.tabId ?? sender?.tab?.id;
      if (tabId !== null && (await isSignedIn())) {
        await reconcileRecordingTabs();
        if (recordingTabs.has(tabId)) {
          try {
            await chrome.runtime.sendMessage({
              type: "retry-connection",
              target: "offscreen",
              tabId,
            });
          } catch (e) {
            console.warn("retry-connection delivery failed:", e?.message || e);
          }
        } else {
          try {
            await startTabRecording(tabId, { initializeOverlay: false });
          } catch (e) {
            console.warn("retry restart failed:", e?.message || e);
            await sendToTab(tabId, {
              type: "caption-status",
              tabId,
              status: "error",
              message: "Couldn't restart captions.",
            });
          }
        }
      }
      return;
    }
    if (message.type === "session-failed") {
      // Offscreen gave up connecting (retries exhausted) and tore the
      // session down. Drop the tab WITHOUT tearing down its overlay (unlike
      // stopTabRecording): the overlay must stay up showing the error +
      // Retry button from the caption-status broadcast that precedes this.
      const tabId = message.tabId;
      if (tabId != null) recordingTabs.delete(tabId);
      try {
        await chrome.action.setIcon({
          path: "icons/not-recording.png",
          tabId,
        });
      } catch (e) {
        // Tab may already be gone.
      }
      await maybeCloseOffscreen();
      sendResponse?.({ ok: true });
      return;
    }
    if (message.type === "caption-language") {
      // Dropdown picks from a tab's subtitle window. The content script has
      // no tabId of its own, so identify the tab from the message sender.
      const tabId = message.tabId ?? sender?.tab?.id;
      if (tabId != null && (await isSignedIn())) {
        try {
          await chrome.runtime.sendMessage({
            type: "caption-language",
            target: "offscreen",
            tabId,
            mode: message.mode,
            targetLang: message.target,
          });
        } catch (e) {
          console.warn("caption-language delivery failed:", e?.message || e);
        }
      }
      return;
    }
    if (message.type === "caption-pause") {
      // Play/pause button in the tab's status bar. Forward as an explicit
      // pause/resume for that tab's offscreen session so pausing also stops
      // audio streaming, not just the overlay.
      const tabId = message.tabId ?? sender?.tab?.id;
      if (tabId != null && (await isSignedIn())) {
        try {
          await chrome.runtime.sendMessage({
            type: message.paused ? "pause-recording" : "resume-recording",
            target: "offscreen",
            tabId,
          });
        } catch (e) {
          console.warn("caption-pause delivery failed:", e?.message || e);
        }
      }
      return;
    }
    if (message.type === "dowload-audio") {
      console.log("on message from offscreen");
      const url = message.url;
      chrome.downloads.download({
        url: url,
        filename: "recording.webm", // Specify the filename for the download
      });
    } else if (
      message.type === "caption" ||
      message.type === "caption-clear" ||
      message.type === "caption-status" ||
      message.type === "quota-update"
    ) {
      // Live transcript from one tab's session in the offscreen document:
      // relay to that tab's caption overlay. Not awaited by the sender
      // (best-effort). Messages without a tabId (old offscreen builds) fall
      // back to broadcast for backwards compatibility.
      if (message.tabId != null) {
        await sendToTab(message.tabId, message);
      } else {
        for (const tabId of recordingTabs) {
          await sendToTab(tabId, message);
        }
      }
    } else if (message.type === "recording-ended") {
      // Legacy path: older offscreen builds sent this when a capture
      // track fired "ended". Current offscreen builds keep the session
      // open through silent stretches and never send it; only explicit
      // stops (action toggle -> stopTabRecording, tab removed) close
      // sessions and the document.
      if (message.tabId != null) {
        recordingTabs.delete(message.tabId);
        try {
          await chrome.action.setIcon({
            path: "icons/not-recording.png",
            tabId: message.tabId,
          });
        } catch (e) {
          // Tab may already be gone.
        }
        await maybeCloseOffscreen();
      }
      sendResponse?.({ ok: true });
    }
  })();
  // Keep the message channel open for the async work above when the sender
  // awaits a response (recording-ended); fire-and-forget messages ignore it.
  return true;
});
