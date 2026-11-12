// Caption lines: render, trim, scroll (classic script: no imports/exports; shares window.CaptifyOverlay).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;
  NS.scrollToBottom = function(instant = false) {
    if (!S.body) return;
    requestAnimationFrame(() => {
      S.body?.scrollTo({
        top: S.body.scrollHeight,
        behavior: instant ? "auto" : "smooth",
      });
    });
  }
  NS.trimLines = function() {
    if (!S.body) return;
    const activeLines = Array.from(
      S.body.querySelectorAll(".caption-line:not(.is-exiting)"),
    );

    while (activeLines.length > C.MAX_LINES) {
      const oldest = activeLines.shift();
      oldest.classList.add("is-exiting");
      setTimeout(() => {
        if (oldest.parentNode) oldest.remove();
      }, 260);
    }

    const n = activeLines.length;
    activeLines.forEach((el, i) => {
      if (el === S.currentLine) {
        el.style.opacity = "0.92";
      } else {
        el.style.opacity = String(0.45 + (0.55 * (i + 1)) / n);
      }
    });
  }
  NS.show = function(text, itemId, final) {
    if (!NS.isSignedIn()) {
      // Signed out: show the sign-in gate instead of any caption.
      NS.revealForRecording();
      return;
    }
    if (S.isClosing || S.paused) return;
    NS.ensureOverlay();
    clearTimeout(S.hideTimeout);

    if (!S.visible) {
      S.visible = true;
      requestAnimationFrame(() => {
        S.container?.classList.add("is-visible");
      });
    }

    // First backend subtitle ends the waiting state: stop the button
    // spinner and flip the status bar to Live.
    if (S.buffering) {
      S.buffering = false;
      NS.updateStatusUI();
    }
    // Captions arriving prove the transport works: clear a stale error
    // (e.g. a recovered server-side blip) and disarm the watchdog.
    if (S.connStatus !== "connected") {
      S.connStatus = "connected";
      S.connMessage = null;
      S.connAttempt = null;
      S.connMaxAttempts = null;
      NS.updateStatusUI();
    }
    NS.clearWatchdog();

    if (!S.currentLine || (itemId != null && S.currentItemId !== itemId)) {
      S.currentLine = document.createElement("div");
      S.currentLine.className = "caption-line is-streaming";
      S.body.appendChild(S.currentLine);
      S.currentItemId = itemId != null ? itemId : null;

      requestAnimationFrame(() => {
        if (S.currentLine) S.currentLine.classList.add("is-entered");
      });
    }

    S.currentLine.textContent = text;

    if (final) {
      S.currentLine.classList.remove("is-streaming");
      S.currentLine.classList.add("is-entered");
      S.currentLine = null;
      S.currentItemId = null;
    }

    NS.trimLines();
    NS.scrollToBottom();
  }
})();
