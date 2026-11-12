// Overlay shell: build, teardown, drag/resize, header wiring (classic script: no imports/exports; shares window.CaptifyOverlay).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;
  NS.closeAndTeardown = function(notifyServiceWorker = true) {
    if (S.isClosing) return;
    S.isClosing = true;
    S.visible = false;

    if (notifyServiceWorker) {
      try {
        chrome.runtime.sendMessage({ type: "caption-close" });
      } catch (e) {
        // Ignore if extension context was invalidated
      }
    }

    S.modeDropdown?.close();
    S.targetDropdown?.close();
    S.userMenu?.close();
    S.container?.classList.remove("is-visible");

    clearTimeout(S.hideTimeout);
    NS.clearWatchdog();
    S.hideTimeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(NS.onRuntimeMessage);
      S.resizeObserver?.disconnect();
      if (S.onWindowPointerDown)
        window.removeEventListener("pointerdown", S.onWindowPointerDown);
      if (S.onWindowPointerMove)
        window.removeEventListener("pointermove", S.onWindowPointerMove);
      if (S.onWindowPointerUp) {
        window.removeEventListener("pointerup", S.onWindowPointerUp);
        window.removeEventListener("pointercancel", S.onWindowPointerUp);
      }
      S.host?.remove();
      S.host = null;
      S.shadow = null;
      S.container = null;
      S.headerWrap = null;
      S.header = null;
      S.body = null;
      S.statusBar = null;
      S.playBtn = null;
      S.retryBtn = null;
      S.statusText = null;
      S.statusDot = null;
      S.userMenu?.destroy();
      S.userMenu = null;
      S.signInGate?.destroy();
      S.signInGate = null;
      S.unsubscribeAuth?.();
      S.unsubscribeAuth = null;
      S.authLoaded = false;
      S.authSignedIn = false;
      S.currentLine = null;
      S.currentItemId = null;
      S.paused = false;
      S.buffering = true;
      S.connStatus = "unknown";
      S.connMessage = null;
      S.connAttempt = null;
      S.connMaxAttempts = null;
      // Allow re-injection when the user clicks the extension icon again
      window.__captifyCaptionInjected = false;
    }, 280);
  }
  NS.ensureOverlay = function() {
    if (S.container) return S.container;

    S.host = document.createElement("div");
    S.host.id = C.CONTAINER_ID;
    S.shadow = S.host.attachShadow({ mode: "open" });
    S.shadow.appendChild(NS.createStyles());

    S.container = document.createElement("div");
    S.container.className = "captify-panel";
    S.container.setAttribute("aria-live", "polite");
    S.container.setAttribute("aria-atomic", "false");

    S.headerWrap = document.createElement("div");
    S.headerWrap.className = "captify-header-wrap";

    S.header = document.createElement("div");
    S.header.className = "captify-header";

    const grip = document.createElement("div");
    grip.className = "drag-grip";
    grip.innerHTML = `
      <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
        <circle cx="3.5" cy="3" r="1.2"/><circle cx="8.5" cy="3" r="1.2"/>
        <circle cx="3.5" cy="7" r="1.2"/><circle cx="8.5" cy="7" r="1.2"/>
        <circle cx="3.5" cy="11" r="1.2"/><circle cx="8.5" cy="11" r="1.2"/>
      </svg>
    `;

    S.modeDropdown = NS.makeDropdown(C.MODES, "transcription", "Mode", NS.sendConfig, false);
    S.targetDropdown = NS.makeDropdown(C.LANGUAGES, "en", "Translate to", NS.sendConfig);
    NS.updateTargetVisibility();
    // Announce the defaults so the backend starts in the shown mode
    // even when the user never touches the dropdowns.
    NS.sendConfig();

    const divider = document.createElement("div");
    divider.className = "header-divider";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "captify-close-btn";
    closeBtn.title = "Close subtitles";
    closeBtn.setAttribute("aria-label", "Close subtitles");
    closeBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/>
      </svg>
    `;
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      NS.closeAndTeardown(true);
    });

    // Hamburger + user menu (sign-in / quota / plan), built by
    // caption-overlay/components/user-menu.js. Guarded: if its classic
    // scripts failed to load, the rest of the overlay must still work.
    if (window.CaptifyOverlay?.createUserMenu) {
      S.userMenu = window.CaptifyOverlay.createUserMenu({
        onOpenChange(open) {
          S.container?.classList.toggle("user-menu-open", open);
          if (open) {
            S.modeDropdown?.close();
            S.targetDropdown?.close();
          }
        },
      });
    }

    S.header.appendChild(grip);
    S.header.appendChild(S.modeDropdown.el);
    S.header.appendChild(S.targetDropdown.el);
    S.header.appendChild(divider);
    if (S.userMenu) S.header.appendChild(S.userMenu.button);
    S.header.appendChild(closeBtn);
    S.headerWrap.appendChild(S.header);
    if (S.userMenu) S.headerWrap.appendChild(S.userMenu.popup);
    S.container.appendChild(S.headerWrap);

    // Sign-in gate: message + Sign in button directly in the subtitle
    // window. Signed out (the store default until load resolves), the
    // caption body/status bar are hidden by the is-signed-out CSS.
    if (window.CaptifyOverlay?.createSignInGate && window.CaptifyOverlay?.userStore) {
      S.container.classList.add("is-signed-out");
      S.signInGate = window.CaptifyOverlay.createSignInGate();
      S.container.appendChild(S.signInGate.el);
      const store = window.CaptifyOverlay.userStore;
      S.unsubscribeAuth = store.subscribe(NS.applyAuthState);
      store.load(NS.applyAuthState);
    } else {
      // Overlay modules failed to load: don't lock the user out entirely.
      S.authLoaded = true;
      S.authSignedIn = true;
    }

    S.body = document.createElement("div");
    S.body.className = "captify-body";
    S.container.appendChild(S.body);

    NS.createStatusBar();


    const resizeHandle = document.createElement("div");
    resizeHandle.className = "resize-handle";
    resizeHandle.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M8.5 1.5L1.5 8.5M8.5 5.5L5.5 8.5"/>
      </svg>
    `;
    S.container.appendChild(resizeHandle);

    S.shadow.appendChild(S.container);
    (document.body || document.documentElement).appendChild(S.host);

    S.resizeObserver = new ResizeObserver(() => {
      NS.scrollToBottom(true);
    });
    S.resizeObserver.observe(S.body);

    S.onWindowPointerDown = (e) => {
      if (S.host && !S.host.contains(e.target)) {
        S.modeDropdown.close();
        S.targetDropdown.close();
        S.userMenu?.close();
      }
    };
    window.addEventListener("pointerdown", S.onWindowPointerDown);

    S.shadow.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".dd-field")) {
        S.modeDropdown.close();
        S.targetDropdown.close();
      }
      if (!e.target.closest(".captify-user-menu, .captify-hamburger-btn")) {
        S.userMenu?.close();
      }
    });

    function pinCurrentPosition() {
      if (S.container.classList.contains("is-pinned")) return;
      const rect = S.container.getBoundingClientRect();
      S.container.style.left = rect.left + "px";
      S.container.style.top = rect.top + "px";
      S.container.style.bottom = "auto";
      S.container.classList.add("is-pinned");
    }

    // Dragging logic: entire floating menu bar is draggable except the close button & open menu
    let dragging = false;
    let pendingDrag = false;
    let didDrag = false;
    let startClientX = 0;
    let startClientY = 0;
    let dragDX = 0;
    let dragDY = 0;
    let activePointerId = null;

    S.header.addEventListener("pointerdown", (e) => {
      if (
        e.target.closest(".dd-menu") ||
        e.target.closest(".captify-close-btn") ||
        e.target.closest(".captify-hamburger-btn") ||
        e.target.closest(".captify-user-menu")
      )
        return;
      if (e.button !== 0) return;

      const rect = S.container.getBoundingClientRect();
      startClientX = e.clientX;
      startClientY = e.clientY;
      dragDX = e.clientX - rect.left;
      dragDY = e.clientY - rect.top;
      activePointerId = e.pointerId;
      didDrag = false;

      if (e.target.closest(".dd-trigger")) {
        pendingDrag = true;
        return;
      }

      pinCurrentPosition();
      dragging = true;
      S.container.classList.add("is-dragging");
      try {
        S.header.setPointerCapture(e.pointerId);
      } catch (err) {}
      e.preventDefault();
    });

    S.header.addEventListener(
      "click",
      (e) => {
        if (didDrag) {
          e.stopPropagation();
          e.preventDefault();
          didDrag = false;
        }
      },
      true,
    );

    // Corner resize logic
    let resizing = false;
    let startW = 0;
    let startH = 0;
    let startX = 0;
    let startY = 0;

    resizeHandle.addEventListener("pointerdown", (e) => {
      pinCurrentPosition();
      const rect = S.container.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      startX = e.clientX;
      startY = e.clientY;
      resizing = true;
      try {
        resizeHandle.setPointerCapture(e.pointerId);
      } catch (err) {}
      e.preventDefault();
      e.stopPropagation();
    });

    S.onWindowPointerMove = (e) => {
      if (!S.container) return;
      if (pendingDrag && !dragging) {
        const dist = Math.hypot(
          e.clientX - startClientX,
          e.clientY - startClientY,
        );
        if (dist > 4) {
          pendingDrag = false;
          dragging = true;
          didDrag = true;
          pinCurrentPosition();
          S.modeDropdown.close();
          S.targetDropdown.close();
          S.container.classList.add("is-dragging");
          try {
            S.header.setPointerCapture(activePointerId);
          } catch (err) {}
        }
      }

      if (dragging) {
        const w = S.container.offsetWidth;
        const h = S.container.offsetHeight;
        const minTop = (S.headerWrap?.offsetHeight || 52) + 4;
        const x = Math.min(
          Math.max(e.clientX - dragDX, 0),
          Math.max(window.innerWidth - w, 0),
        );
        const y = Math.min(
          Math.max(e.clientY - dragDY, minTop),
          Math.max(window.innerHeight - h, minTop),
        );
        S.container.style.left = x + "px";
        S.container.style.top = y + "px";
      } else if (resizing) {
        const newW = Math.max(
          320,
          Math.min(window.innerWidth - 20, startW + (e.clientX - startX)),
        );
        const newH = Math.max(
          110,
          Math.min(window.innerHeight * 0.7, startH + (e.clientY - startY)),
        );
        S.container.style.width = newW + "px";
        S.container.style.height = newH + "px";
        S.container.style.maxHeight = "none";
        NS.scrollToBottom(true);
      }
    };

    S.onWindowPointerUp = () => {
      pendingDrag = false;
      if (dragging) {
        dragging = false;
        S.container?.classList.remove("is-dragging");
      }
      if (resizing) {
        resizing = false;
      }
    };

    window.addEventListener("pointermove", S.onWindowPointerMove);
    window.addEventListener("pointerup", S.onWindowPointerUp);
    window.addEventListener("pointercancel", S.onWindowPointerUp);

    return S.container;
  }
})();
