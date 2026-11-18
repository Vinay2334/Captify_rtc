// Rolling live-subtitle window for Captify tab capture (thin bootstrap).
// Implementation lives in caption-overlay/* (classic scripts sharing
// window.CaptifyOverlay); this file only guards re-injection, defines the
// runtime-message entry, and mounts the overlay.
(function () {
  console.log("content script loaded");
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  if (window.__captifyCaptionInjected) {
    // Same-document re-injection (the worker's executeScript running the
    // files twice): reuse the single overlay and keep exactly one runtime
    // listener instead of building another overlay host for the same page.
    try {
      chrome.runtime.onMessage.removeListener(NS.onRuntimeMessage);
    } catch (e) {
      // Listener was never registered (or context already gone).
    }
    if (NS.onRuntimeMessage) chrome.runtime.onMessage.addListener(NS.onRuntimeMessage);
    NS.ensureOverlay();
    return;
  }
  window.__captifyCaptionInjected = true;

  const S = NS.state;
  const C = NS.constants;

  // Backend rejected the session: the worker already removed the client
  // token and stopped capture — drop in-memory auth here too so the
  // subtitle window shows the sign-in gate (and menu) signed-out UI.
  function expireSession() {
    try {
      const p = NS.userStore?.handleSessionExpired
        ? NS.userStore.handleSessionExpired()
        : NS.userStore?.signOut?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      // The storage sync from the worker covers this tab as well.
    }
  }

  NS.onRuntimeMessage = function(message, sender, sendResponse) {
    if (S.isClosing) return;
    if (message?.type === "caption") {
      if (!NS.isSignedIn()) {
        NS.revealForRecording();
        return;
      }
      if (S.paused) return;
      const text = (message.text || "").trim();
      if (!text) {
        if (
          message.final === true &&
          S.currentLine &&
          !S.currentLine.textContent.trim()
        ) {
          S.currentLine.remove();
          S.currentLine = null;
          S.currentItemId = null;
          NS.trimLines();
        }
        return;
      }
      NS.show(text, message.item_id, message.final === true);
    } else if (message?.type === "caption-clear") {
      if (S.body) S.body.innerHTML = "";
      S.currentLine = null;
      S.currentItemId = null;
      // A new session starts waiting for backend subtitles: reveal the
      // overlay immediately (icon click) and spin the play button. Reset
      // any previous error: a fresh session gets a fresh watchdog.
      S.connStatus = "unknown";
      S.connMessage = null;
      S.connAttempt = null;
      S.connMaxAttempts = null;
      NS.revealForRecording();
      if (!NS.isSignedIn()) return;
      if (!S.paused) S.buffering = true;
      NS.updateStatusUI();
      NS.armWatchdog();
    } else if (message?.type === "caption-show") {
      // Session (re)start reveal: same fresh-waiting treatment as a clear.
      // Signed out, caption-show only reveals the sign-in gate (the service
      // worker sends it without starting capture in that state).
      if (NS.isSignedIn() && (S.connStatus === "error" || S.connStatus === "unknown")) {
        S.connStatus = "unknown";
        S.connMessage = null;
        S.connAttempt = null;
        S.connMaxAttempts = null;
        if (!S.paused) S.buffering = true;
        NS.armWatchdog();
      }
      NS.revealForRecording();
      NS.updateStatusUI();
    } else if (message?.type === "caption-ping") {
      // Liveness probe from the service worker's navigation check:
      // answering proves this overlay survived the navigation (SPA), so
      // the worker re-shows instead of stopping the session. A full
      // navigation has no listener left, and the send fails instead.
      sendResponse?.({ ok: true, alive: true });
      return;
    } else if (message?.type === "caption-status") {
      // An expired/invalid token must sign out (gate + no retry), not
      // show the Retry error — also covers builds that only send status.
      if (
        message?.status === "error" &&
        /auth_expired|session expired|anonymous/i.test(message?.message || "")
      ) {
        expireSession();
        return;
      }
      NS.handleConnectionStatus(message);
    } else if (message?.type === "session-expired") {
      expireSession();
    } else if (message?.type === "quota-update") {
      // Live quota from the backend (opening state, periodic refresh,
      // final commit): apply to the user menu's remaining-minutes view.
      try {
        NS.userStore?.applyQuota?.(message.quota);
      } catch (e) { /* menu renders stale numbers until next open */ }
    } else if(message?.type === "caption-teardown") {
      NS.closeAndTeardown(false);
    }
  }

  NS.ensureOverlay();
  chrome.runtime.onMessage.addListener(NS.onRuntimeMessage);
})();
