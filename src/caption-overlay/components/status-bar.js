// Bottom status bar: play/pause, retry, live status (classic script: no imports/exports; shares window.CaptifyOverlay).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;
  const SVG_PLAY =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const SVG_PAUSE =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2.5" width="3.4" height="11" rx="1"/><rect x="9.6" y="2.5" width="3.4" height="11" rx="1"/></svg>';

  NS.updateStatusUI = function() {
    if (!S.playBtn || !S.statusText || !S.statusDot) return;
    const isError = S.connStatus === "error";
    // Error state replaces the play button with Retry; every other state
    // keeps the play/pause button.
    if (S.retryBtn) S.retryBtn.hidden = !isError;
    S.playBtn.hidden = isError;
    const showSpinner = S.buffering && !S.paused && !isError;
    S.playBtn.classList.toggle("is-buffering", showSpinner);
    S.playBtn.classList.toggle("is-paused", S.paused);
    if (showSpinner) {
      S.playBtn.innerHTML = '<span class="captify-spinner" aria-hidden="true"></span>';
      S.playBtn.title = "Waiting for Captions";
      S.playBtn.setAttribute("aria-label", "Waiting for Captions");
    } else if (S.paused) {
      S.playBtn.innerHTML = SVG_PLAY;
      S.playBtn.title = "Resume Captions";
      S.playBtn.setAttribute("aria-label", "Resume Captions");
    } else {
      S.playBtn.innerHTML = SVG_PAUSE;
      S.playBtn.title = "Pause Captions";
      S.playBtn.setAttribute("aria-label", "Pause Captions");
    }
    S.statusDot.classList.toggle("is-live", !S.paused && !S.buffering && !isError);
    S.statusDot.classList.toggle("is-paused", S.paused && !isError);
    S.statusDot.classList.toggle("is-error", isError);
    if (isError) {
      S.statusText.textContent =
        S.connMessage || "Connection failed. Check the backend and retry.";
      S.statusText.title = S.statusText.textContent;
    } else if (S.paused) {
      S.statusText.textContent = "Paused";
      S.statusText.removeAttribute("title");
    } else if (S.buffering) {
      if (
        (S.connStatus === "reconnecting" || S.connStatus === "connecting") &&
        S.connAttempt != null &&
        S.connMaxAttempts != null
      ) {
        S.statusText.textContent =
          S.connStatus === "reconnecting"
            ? `Reconnecting\u2026`
            : `Connecting\u2026`;
      } else if (S.connStatus === "reconnecting") {
        S.statusText.textContent = "Reconnecting\u2026";
      } else {
        S.statusText.textContent = "Waiting for Captions\u2026";
      }
      S.statusText.removeAttribute("title");
    } else {
      S.statusText.textContent = "Live";
      S.statusText.removeAttribute("title");
    }
  }

  NS.createStatusBar = function() {
    // Bottom status bar: play/pause button on the left, live status on right.
    S.statusBar = document.createElement("div");
    S.statusBar.className = "captify-statusbar";

    S.playBtn = document.createElement("button");
    S.playBtn.type = "button";
    S.playBtn.className = "captify-play-btn";
    S.playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      NS.setPaused(!S.paused);
    });

    S.retryBtn = document.createElement("button");
    S.retryBtn.type = "button";
    S.retryBtn.className = "captify-retry-btn";
    S.retryBtn.hidden = true;
    S.retryBtn.title = "Reconnect to the transcription server";
    S.retryBtn.setAttribute("aria-label", "Retry connection");
    S.retryBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3"/>
      </svg>
      <span>Retry</span>
    `;
    S.retryBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      NS.requestRetry();
    });

    const statusWrap = document.createElement("div");
    statusWrap.className = "captify-status";
    S.statusDot = document.createElement("span");
    S.statusDot.className = "status-dot";
    S.statusDot.setAttribute("aria-hidden", "true");
    S.statusText = document.createElement("span");
    S.statusText.textContent = "Waiting for Captions\u2026";
    statusWrap.appendChild(S.statusDot);
    statusWrap.appendChild(S.statusText);

    S.statusBar.appendChild(S.playBtn);
    S.statusBar.appendChild(S.retryBtn);
    S.statusBar.appendChild(statusWrap);
    S.container.appendChild(S.statusBar);
    NS.updateStatusUI();
  }
})();
