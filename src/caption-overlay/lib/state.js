// Single mutable overlay state. Modules read/write NS.state (alias S).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  NS.state = {
    host: null, shadow: null, container: null, headerWrap: null, header: null,
    body: null, resizeObserver: null, modeDropdown: null, targetDropdown: null,
    currentLine: null, currentItemId: null, visible: false, isClosing: false,
    hideTimeout: null, paused: false, buffering: true, statusBar: null,
    playBtn: null, retryBtn: null, statusText: null, statusDot: null,
    userMenu: null, signInGate: null, unsubscribeAuth: null,
    authLoaded: false, authSignedIn: false, connStatus: "unknown",
    connMessage: null, connAttempt: null, connMaxAttempts: null,
    watchdogTimer: null, onWindowPointerDown: null, onWindowPointerMove: null,
    onWindowPointerUp: null,
  };
})();
