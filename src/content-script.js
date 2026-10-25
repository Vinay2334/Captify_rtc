// Rolling live-subtitle window for Captify tab capture (Floating Header + Close & Teardown).
(function () {
  console.log("content script loaded");
  if (window.__captifyCaptionInjected) return;
  window.__captifyCaptionInjected = true;

  const CONTAINER_ID = "__captify-caption-container";
  const MAX_LINES = 2;

  const LANGUAGES = [
    ["en", "English"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["it", "Italian"],
    ["pt", "Portuguese"],
    ["nl", "Dutch"],
    ["pl", "Polish"],
    ["ru", "Russian"],
    ["uk", "Ukrainian"],
    ["ar", "Arabic"],
    ["tr", "Turkish"],
    ["zh", "Chinese (Mandarin)"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["hi", "Hindi"],
    ["bn", "Bengali"],
    ["ta", "Tamil"],
    ["te", "Telugu"],
    ["mr", "Marathi"],
    ["ur", "Urdu"],
    ["fa", "Persian"],
  ];

  let host = null;
  let shadow = null;
  let container = null;
  let headerWrap = null;
  let header = null;
  let body = null;
  let resizeObserver = null;
  let sourceDropdown = null;
  let targetDropdown = null;
  let currentLine = null;
  let currentItemId = null;
  let visible = false;
  let isClosing = false;
  let hideTimeout = null;

  // Window-level listener references so they can be cleanly removed on teardown
  let onWindowPointerDown = null;
  let onWindowPointerMove = null;
  let onWindowPointerUp = null;

  function sendLanguage() {
    if (!sourceDropdown || !targetDropdown || isClosing) return;
    try {
      chrome.runtime.sendMessage({
        type: "caption-language",
        source: sourceDropdown.getValue(),
        target: targetDropdown.getValue(),
      });
    } catch (e) {
      // Extension context gone (e.g. during unload); selection is best-effort.
    }
  }

  function createStyles() {
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      /* Main Subtitle Box */
      .captify-panel {
        position: fixed;
        left: 50%;
        bottom: 6%;
        transform: translateX(-50%) translateY(10px) scale(0.98);
        width: min(78vw, 720px);
        min-width: 320px;
        min-height: 110px;
        max-height: 42vh;
        display: flex;
        flex-direction: column;
        background: rgba(18, 18, 22, 0.82);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(0, 0, 0, 0.2);
        color: #fff;
        pointer-events: auto;
        opacity: 0;
        visibility: hidden;
        transition:
          opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          visibility 0.28s;
      }

      .captify-panel.is-visible {
        opacity: 1;
        visibility: visible;
        transform: translateX(-50%) translateY(0) scale(1);
      }

      .captify-panel.is-pinned.is-visible {
        transform: translateY(0) scale(1);
      }

      .captify-panel.is-pinned {
        transform: translateY(10px) scale(0.98);
      }

      /* Floating Menu Bar Wrapper (sits above the subtitle box with an 8px hover bridge) */
      .captify-header-wrap {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 100%;
        padding-bottom: 8px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(6px) scale(0.98);
        transform-origin: bottom center;
        pointer-events: none;
        transition:
          opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1),
          transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
          visibility 0.22s;
        z-index: 20;
      }

      .captify-panel:hover .captify-header-wrap,
      .captify-panel.menu-open .captify-header-wrap,
      .captify-panel.is-dragging .captify-header-wrap,
      .captify-panel:focus-within .captify-header-wrap {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      /* Separate Floating Menu Box */
      .captify-header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px 8px 12px;
        background: rgba(18, 18, 22, 0.88);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 12px;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(0, 0, 0, 0.2);
        cursor: grab;
        user-select: none;
        touch-action: none;
      }

      .captify-panel.is-dragging .captify-header,
      .captify-panel.is-dragging .dd-trigger,
      .captify-panel.is-dragging .dd-label {
        cursor: grabbing;
      }

      .drag-grip {
        display: flex;
        align-items: center;
        color: rgba(255, 255, 255, 0.4);
        padding-right: 2px;
        flex-shrink: 0;
      }

      /* Close Button & Divider */
      .header-divider {
        width: 1px;
        height: 18px;
        background: rgba(255, 255, 255, 0.12);
        flex-shrink: 0;
        margin: 0 2px;
      }

      .captify-close-btn {
        width: 26px;
        height: 26px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        outline: none;
        transition:
          background 0.15s ease,
          color 0.15s ease,
          border-color 0.15s ease,
          transform 0.1s ease;
      }

      .captify-close-btn:hover {
        background: rgba(239, 68, 68, 0.22);
        border-color: rgba(239, 68, 68, 0.45);
        color: #fca5a5;
      }

      .captify-close-btn:active {
        transform: scale(0.93);
      }

      .captify-close-btn:focus-visible {
        border-color: rgba(239, 68, 68, 0.75);
        box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.25);
      }

      /* Custom Dropdown */
      .dd-field {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
        position: relative;
      }

      .dd-label {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.02em;
        color: rgba(255, 255, 255, 0.6);
        white-space: nowrap;
      }

      .dd-trigger {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        background: rgba(255, 255, 255, 0.07);
        color: #f3f4f6;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        padding: 5px 9px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        outline: none;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }

      .dd-trigger:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.25);
      }

      .dd-trigger:focus-visible,
      .dd-field.is-open .dd-trigger {
        background: rgba(255, 255, 255, 0.13);
        border-color: rgba(99, 102, 241, 0.75);
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.25);
      }

      .dd-trigger-text {
        display: flex;
        align-items: center;
        gap: 6px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dd-badge {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        padding: 1px 4px;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.85);
      }

      .dd-chevron {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: rgba(255, 255, 255, 0.6);
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }

      .dd-field.is-open .dd-chevron {
        transform: rotate(180deg);
        color: #fff;
      }

      .dd-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        width: max(100%, 190px);
        max-height: 220px;
        overflow-y: auto;
        background: rgba(24, 24, 30, 0.96);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px;
        padding: 4px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
        z-index: 100;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-6px) scale(0.97);
        transform-origin: top right;
        transition:
          opacity 0.16s ease,
          transform 0.16s cubic-bezier(0.16, 1, 0.3, 1),
          visibility 0.16s;
      }

      .dd-field.is-open .dd-menu {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
      }

      .dd-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.82);
        cursor: pointer;
        transition: background 0.1s ease, color 0.1s ease;
      }

      .dd-option:hover,
      .dd-option.is-focused {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .dd-option.is-selected {
        background: rgba(99, 102, 241, 0.22);
        color: #fff;
        font-weight: 500;
      }

      .dd-option-left {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }

      .dd-check {
        width: 14px;
        height: 14px;
        color: #818cf8;
        opacity: 0;
        flex-shrink: 0;
      }

      .dd-option.is-selected .dd-check {
        opacity: 1;
      }

      /* Subtitle Scroll Body */
      .captify-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 12px 18px 14px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        scroll-behavior: smooth;
      }

      .captify-body::-webkit-scrollbar,
      .dd-menu::-webkit-scrollbar {
        width: 5px;
      }

      .captify-body::-webkit-scrollbar-track,
      .dd-menu::-webkit-scrollbar-track {
        background: transparent;
      }

      .captify-body::-webkit-scrollbar-thumb,
      .dd-menu::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.18);
        border-radius: 999px;
      }

      .captify-body::-webkit-scrollbar-thumb:hover,
      .dd-menu::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.32);
      }

      /* Subtitle Lines + Fade Animations */
      .caption-line {
        font-size: 18px;
        font-weight: 400;
        line-height: 1.45;
        text-align: center;
        color: #ffffff;
        overflow-wrap: break-word;
        white-space: pre-wrap;
        padding: 3px 6px;
        border-radius: 6px;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transform: translateY(8px);
        transition:
          opacity 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
          color 0.25s ease;
      }

      .caption-line.is-entered {
        transform: translateY(0);
      }

      .caption-line.is-streaming {
        color: rgba(255, 255, 255, 0.92);
      }

      .caption-line.is-exiting {
        opacity: 0 !important;
        transform: translateY(-8px) scale(0.98) !important;
        pointer-events: none;
      }

      /* Custom Corner Resize Handle */
      .resize-handle {
        position: absolute;
        right: 2px;
        bottom: 2px;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        opacity: 0;
        transition: opacity 0.2s ease;
        display: flex;
        align-items: flex-end;
        justify-content: flex-end;
        padding: 3px;
        color: rgba(255, 255, 255, 0.35);
      }

      .captify-panel:hover .resize-handle {
        opacity: 1;
      }

      .resize-handle:hover {
        color: rgba(255, 255, 255, 0.75);
      }
    `;
    return style;
  }

  function scrollToBottom(instant = false) {
    if (!body) return;
    requestAnimationFrame(() => {
      body?.scrollTo({
        top: body.scrollHeight,
        behavior: instant ? "auto" : "smooth",
      });
    });
  }

  function makeDropdown(defaultCode, labelText, onChange) {
    let selectedCode = defaultCode;
    let isOpen = false;

    const field = document.createElement("div");
    field.className = "dd-field";

    const label = document.createElement("span");
    label.className = "dd-label";
    label.textContent = labelText;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dd-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const triggerText = document.createElement("span");
    triggerText.className = "dd-trigger-text";

    const chevron = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    chevron.setAttribute("viewBox", "0 0 20 20");
    chevron.setAttribute("fill", "currentColor");
    chevron.classList.add("dd-chevron");
    chevron.innerHTML = `<path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />`;

    trigger.appendChild(triggerText);
    trigger.appendChild(chevron);

    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");

    const optionEls = new Map();

    function updateTriggerUI() {
      const entry = LANGUAGES.find(([c]) => c === selectedCode) || LANGUAGES[0];
      triggerText.innerHTML = `<span class="dd-badge">${entry[0]}</span><span>${entry[1]}</span>`;
      optionEls.forEach((el, code) => {
        el.classList.toggle("is-selected", code === selectedCode);
      });
    }

    function openMenu() {
      if (isOpen) return;
      isOpen = true;
      field.classList.add("is-open");
      container?.classList.add("menu-open");
      trigger.setAttribute("aria-expanded", "true");
      const activeEl = optionEls.get(selectedCode);
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }

    function closeMenu() {
      if (!isOpen) return;
      isOpen = false;
      field.classList.remove("is-open");
      trigger.setAttribute("aria-expanded", "false");
      if (shadow && !shadow.querySelector(".dd-field.is-open")) {
        container?.classList.remove("menu-open");
      }
    }

    function selectCode(code) {
      if (code === selectedCode) {
        closeMenu();
        return;
      }
      selectedCode = code;
      updateTriggerUI();
      closeMenu();
      onChange(selectedCode);
    }

    for (const [code, name] of LANGUAGES) {
      const opt = document.createElement("div");
      opt.className = "dd-option";
      opt.setAttribute("role", "option");
      opt.innerHTML = `
        <span class="dd-option-left">
          <span class="dd-badge">${code}</span>
          <span>${name}</span>
        </span>
        <svg class="dd-check" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
        </svg>
      `;
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        selectCode(code);
      });
      optionEls.set(code, opt);
      menu.appendChild(opt);
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      shadow?.querySelectorAll(".dd-field.is-open").forEach((el) => {
        if (el !== field) el.dispatchEvent(new CustomEvent("close-dd"));
      });
      isOpen ? closeMenu() : openMenu();
    });

    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeMenu();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) openMenu();
        const idx = LANGUAGES.findIndex(([c]) => c === selectedCode);
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(LANGUAGES.length - 1, idx + 1)
            : Math.max(0, idx - 1);
        selectCode(LANGUAGES[nextIdx][0]);
      }
    });

    field.addEventListener("close-dd", closeMenu);

    updateTriggerUI();
    field.appendChild(label);
    field.appendChild(trigger);
    field.appendChild(menu);

    return {
      el: field,
      getValue: () => selectedCode,
      close: closeMenu,
    };
  }

  // Tear down the content script UI and notify the service worker to stop
  // this tab's offscreen session and close offscreen.html.
  function closeAndTeardown(notifyServiceWorker = true) {
    if (isClosing) return;
    isClosing = true;
    visible = false;

    if (notifyServiceWorker) {
      try {
        chrome.runtime.sendMessage({ type: "caption-close" });
      } catch (e) {
        // Ignore if extension context was invalidated
      }
    }

    sourceDropdown?.close();
    targetDropdown?.close();
    container?.classList.remove("is-visible");

    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      resizeObserver?.disconnect();
      if (onWindowPointerDown)
        window.removeEventListener("pointerdown", onWindowPointerDown);
      if (onWindowPointerMove)
        window.removeEventListener("pointermove", onWindowPointerMove);
      if (onWindowPointerUp) {
        window.removeEventListener("pointerup", onWindowPointerUp);
        window.removeEventListener("pointercancel", onWindowPointerUp);
      }
      host?.remove();
      host = null;
      shadow = null;
      container = null;
      headerWrap = null;
      header = null;
      body = null;
      currentLine = null;
      currentItemId = null;
      // Allow re-injection when the user clicks the extension icon again
      window.__captifyCaptionInjected = false;
    }, 280);
  }

  function ensureOverlay() {
    if (container) return container;

    host = document.createElement("div");
    host.id = CONTAINER_ID;
    shadow = host.attachShadow({ mode: "open" });
    shadow.appendChild(createStyles());

    container = document.createElement("div");
    container.className = "captify-panel";
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");

    headerWrap = document.createElement("div");
    headerWrap.className = "captify-header-wrap";

    header = document.createElement("div");
    header.className = "captify-header";

    const grip = document.createElement("div");
    grip.className = "drag-grip";
    grip.innerHTML = `
      <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">
        <circle cx="3.5" cy="3" r="1.2"/><circle cx="8.5" cy="3" r="1.2"/>
        <circle cx="3.5" cy="7" r="1.2"/><circle cx="8.5" cy="7" r="1.2"/>
        <circle cx="3.5" cy="11" r="1.2"/><circle cx="8.5" cy="11" r="1.2"/>
      </svg>
    `;

    sourceDropdown = makeDropdown("en", "Original", sendLanguage);
    targetDropdown = makeDropdown("en", "Translate to", sendLanguage);

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
      closeAndTeardown(true);
    });

    header.appendChild(grip);
    header.appendChild(sourceDropdown.el);
    header.appendChild(targetDropdown.el);
    header.appendChild(divider);
    header.appendChild(closeBtn);
    headerWrap.appendChild(header);
    container.appendChild(headerWrap);

    body = document.createElement("div");
    body.className = "captify-body";
    container.appendChild(body);

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "resize-handle";
    resizeHandle.innerHTML = `
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <path d="M8.5 1.5L1.5 8.5M8.5 5.5L5.5 8.5"/>
      </svg>
    `;
    container.appendChild(resizeHandle);

    shadow.appendChild(container);
    (document.body || document.documentElement).appendChild(host);

    resizeObserver = new ResizeObserver(() => {
      scrollToBottom(true);
    });
    resizeObserver.observe(body);

    onWindowPointerDown = (e) => {
      if (host && !host.contains(e.target)) {
        sourceDropdown.close();
        targetDropdown.close();
      }
    };
    window.addEventListener("pointerdown", onWindowPointerDown);

    shadow.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".dd-field")) {
        sourceDropdown.close();
        targetDropdown.close();
      }
    });

    function pinCurrentPosition() {
      if (container.classList.contains("is-pinned")) return;
      const rect = container.getBoundingClientRect();
      container.style.left = rect.left + "px";
      container.style.top = rect.top + "px";
      container.style.bottom = "auto";
      container.classList.add("is-pinned");
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

    header.addEventListener("pointerdown", (e) => {
      if (
        e.target.closest(".dd-menu") ||
        e.target.closest(".captify-close-btn")
      )
        return;
      if (e.button !== 0) return;

      const rect = container.getBoundingClientRect();
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
      container.classList.add("is-dragging");
      try {
        header.setPointerCapture(e.pointerId);
      } catch (err) {}
      e.preventDefault();
    });

    header.addEventListener(
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
      const rect = container.getBoundingClientRect();
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

    onWindowPointerMove = (e) => {
      if (!container) return;
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
          sourceDropdown.close();
          targetDropdown.close();
          container.classList.add("is-dragging");
          try {
            header.setPointerCapture(activePointerId);
          } catch (err) {}
        }
      }

      if (dragging) {
        const w = container.offsetWidth;
        const h = container.offsetHeight;
        const minTop = (headerWrap?.offsetHeight || 52) + 4;
        const x = Math.min(
          Math.max(e.clientX - dragDX, 0),
          Math.max(window.innerWidth - w, 0),
        );
        const y = Math.min(
          Math.max(e.clientY - dragDY, minTop),
          Math.max(window.innerHeight - h, minTop),
        );
        container.style.left = x + "px";
        container.style.top = y + "px";
      } else if (resizing) {
        const newW = Math.max(
          320,
          Math.min(window.innerWidth - 20, startW + (e.clientX - startX)),
        );
        const newH = Math.max(
          110,
          Math.min(window.innerHeight * 0.7, startH + (e.clientY - startY)),
        );
        container.style.width = newW + "px";
        container.style.height = newH + "px";
        container.style.maxHeight = "none";
        scrollToBottom(true);
      }
    };

    onWindowPointerUp = () => {
      pendingDrag = false;
      if (dragging) {
        dragging = false;
        container?.classList.remove("is-dragging");
      }
      if (resizing) {
        resizing = false;
      }
    };

    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("pointercancel", onWindowPointerUp);

    return container;
  }

  function trimLines() {
    if (!body) return;
    const activeLines = Array.from(
      body.querySelectorAll(".caption-line:not(.is-exiting)"),
    );

    while (activeLines.length > MAX_LINES) {
      const oldest = activeLines.shift();
      oldest.classList.add("is-exiting");
      setTimeout(() => {
        if (oldest.parentNode) oldest.remove();
      }, 260);
    }

    const n = activeLines.length;
    activeLines.forEach((el, i) => {
      if (el === currentLine) {
        el.style.opacity = "0.92";
      } else {
        el.style.opacity = String(0.45 + (0.55 * (i + 1)) / n);
      }
    });
  }

  function show(text, itemId, final) {
    if (isClosing) return;
    ensureOverlay();
    clearTimeout(hideTimeout);

    if (!visible) {
      visible = true;
      requestAnimationFrame(() => {
        container?.classList.add("is-visible");
      });
    }

    if (!currentLine || (itemId != null && currentItemId !== itemId)) {
      currentLine = document.createElement("div");
      currentLine.className = "caption-line is-streaming";
      body.appendChild(currentLine);
      currentItemId = itemId != null ? itemId : null;

      requestAnimationFrame(() => {
        if (currentLine) currentLine.classList.add("is-entered");
      });
    }

    currentLine.textContent = text;

    if (final) {
      currentLine.classList.remove("is-streaming");
      currentLine.classList.add("is-entered");
      currentLine = null;
      currentItemId = null;
    }

    trimLines();
    scrollToBottom();
  }

  function onRuntimeMessage(message) {
    if (isClosing) return;
    if (message?.type === "caption") {
      const text = (message.text || "").trim();
      if (!text) {
        if (
          message.final === true &&
          currentLine &&
          !currentLine.textContent.trim()
        ) {
          currentLine.remove();
          currentLine = null;
          currentItemId = null;
          trimLines();
        }
        return;
      }
      show(text, message.item_id, message.final === true);
    } else if (message?.type === "caption-clear") {
      if (body) body.innerHTML = "";
      currentLine = null;
      currentItemId = null;
    } else if(message?.type === "caption-teardown") {
      closeAndTeardown(false);
    }
  }

  ensureOverlay();
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
})();
