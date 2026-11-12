// Rolling live-subtitle window for Captify tab capture (thin bootstrap).
// Implementation lives in caption-overlay/* (classic scripts sharing
// window.CaptifyOverlay); this file only guards re-injection, defines the
// runtime-message entry, and mounts the overlay.
(function () {
  console.log("content script loaded");
  if (window.__captifyCaptionInjected) return;
  window.__captifyCaptionInjected = true;

  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;
  NS.onRuntimeMessage = function(message) {
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
    } else if (message?.type === "caption-status") {
      NS.handleConnectionStatus(message);
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
