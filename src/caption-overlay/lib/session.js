// Auth gate + transport/session logic for the caption overlay (classic script: no imports/exports; shares window.CaptifyOverlay).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;

  NS.isSignedIn = function() {
    return S.authLoaded && S.authSignedIn;
  }

  NS.applyAuthState = function(authState) {
    const wasSignedIn = S.authSignedIn;
    S.authLoaded = true;
    S.authSignedIn = !!authState?.signedIn;
    if (!S.container) return;
    S.container.classList.toggle("is-signed-out", !S.authSignedIn);
    if (!S.authSignedIn) {
      S.modeDropdown?.close();
      S.targetDropdown?.close();
      NS.clearWatchdog();
      if (S.body) S.body.innerHTML = "";
      S.currentLine = null;
      S.currentItemId = null;
    } else if (!wasSignedIn) {
      // Just unlocked: announce the dropdown defaults the blocked
      // sendConfig() calls skipped, and re-enter the waiting state.
      NS.sendConfig();
      if (S.visible && !S.paused) {
        S.buffering = true;
        NS.armWatchdog();
      }
      NS.updateStatusUI();
    }
  }

  NS.updateTargetVisibility = function() {
    if (!S.modeDropdown || !S.targetDropdown) return;
    const isTranslation = S.modeDropdown.getValue() === "translation";
    S.targetDropdown.el.style.display = isTranslation ? "" : "none";
    if (!isTranslation) S.targetDropdown.close();
  }

  NS.sendConfig = function() {
    if (!S.modeDropdown || !S.targetDropdown || S.isClosing) return;
    NS.updateTargetVisibility();
    if (!NS.isSignedIn()) return;
    const mode = S.modeDropdown.getValue();
    try {
      chrome.runtime.sendMessage({
        type: "caption-language",
        mode,
        target: mode === "translation" ? S.targetDropdown.getValue() : null,
      });
    } catch (e) {
      // Extension context gone (e.g. during unload); selection is best-effort.
    }
  }

  NS.sendPauseState = function() {
    if (S.isClosing || !NS.isSignedIn()) return;
    try {
      chrome.runtime.sendMessage({ type: "caption-pause", paused: S.paused });
    } catch (e) {
      // Extension context gone; UI state still updates locally.
    }
  }

  NS.clearWatchdog = function() {
    if (S.watchdogTimer) {
      clearTimeout(S.watchdogTimer);
      S.watchdogTimer = null;
    }
  }

  NS.armWatchdog = function() {
    NS.clearWatchdog();
    S.watchdogTimer = setTimeout(() => {
      S.watchdogTimer = null;
      if (S.isClosing || !S.buffering) return;
      if (S.connStatus === "connected" || S.connStatus === "error") return;
      S.connStatus = "error";
      S.connMessage =
        "Couldn't reach the transcription server. Check that the backend is running, then retry.";
      S.connAttempt = null;
      S.connMaxAttempts = null;
      S.buffering = false;
      NS.updateStatusUI();
    }, C.CONNECT_WATCHDOG_MS);
  }

  NS.handleConnectionStatus = function(message) {
    if (S.isClosing || !NS.isSignedIn()) return;
    const status = message?.status;
    if (status === "connected") {
      S.connStatus = "connected";
      S.connMessage = null;
      S.connAttempt = null;
      S.connMaxAttempts = null;
      NS.clearWatchdog();
      NS.updateStatusUI();
    } else if (status === "connecting" || status === "reconnecting") {
      S.connStatus = status;
      S.connMessage = null;
      S.connAttempt = message?.attempt ?? null;
      S.connMaxAttempts = message?.maxAttempts ?? null;
      if (!S.paused) S.buffering = true;
      // Transport is alive enough to report: keep waiting, don't error.
      NS.armWatchdog();
      NS.updateStatusUI();
    } else if (status === "error") {
      S.connStatus = "error";
      S.connMessage = message?.message || null;
      S.connAttempt = message?.attempt ?? null;
      S.connMaxAttempts = message?.maxAttempts ?? null;
      S.buffering = false;
      NS.clearWatchdog();
      NS.updateStatusUI();
    }
  }

  NS.requestRetry = function() {
    if (S.isClosing || !NS.isSignedIn()) return;
    S.connStatus = "reconnecting";
    S.connMessage = null;
    S.connAttempt = null;
    S.connMaxAttempts = null;
    if (!S.paused) S.buffering = true;
    NS.updateStatusUI();
    NS.armWatchdog();
    try {
      chrome.runtime.sendMessage({ type: "caption-retry" });
    } catch (e) {
      // Extension context gone; the error state stays with a Retry button.
    }
  }

  NS.setPaused = function(next) {
    if (S.isClosing || !NS.isSignedIn()) return;
    S.paused = next;
    if (!S.paused) {
      // Resuming re-enters the waiting state until the backend's next
      // subtitle arrives; the button spins meanwhile.
      S.buffering = true;
    }
    NS.updateStatusUI();
    NS.sendPauseState();
  }

  NS.revealForRecording = function() {
    if (S.isClosing) return;
    NS.ensureOverlay();
    clearTimeout(S.hideTimeout);
    if (!S.visible) {
      S.visible = true;
      requestAnimationFrame(() => {
        S.container?.classList.add("is-visible");
      });
    } else {
      S.container?.classList.add("is-visible");
    }
  }

})();
