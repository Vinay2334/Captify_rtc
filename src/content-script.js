// Rolling live-subtitle window for Captify tab capture.
//
// Injected as a declarative content script (see manifest.json) and, for
// already-open tabs, programmatically via chrome.scripting.executeScript on
// recording start. The offscreen document parses transcript.delta /
// transcript.completed DataChannel messages and the service worker forwards
// them here as { type: "caption", text, item_id, final }.
//
// Layout: a draggable, resizable panel with a hover-reveal header (original
// + translation language dropdowns) and a rolling body that keeps the last
// MAX_LINES subtitles. Language picks are sent extension-side as
// { type: "caption-language", source, target }; the service worker routes
// them to the offscreen document, which forwards them to the backend over
// the DataChannel.
(function () {
  if (window.__captifyCaptionInjected) return;
  window.__captifyCaptionInjected = true;

  const CONTAINER_ID = "__captify-caption-container";
  // Rolling window: older lines are removed once the body holds this many.
  const MAX_LINES = 4;

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

  const FONT = "Roboto, Arial, Helvetica, sans-serif";

  let container = null;
  let body = null;
  let header = null;
  let sourceSelect = null;
  let targetSelect = null;
  let currentLine = null;
  let currentItemId = null;

  function sendLanguage() {
    if (!sourceSelect || !targetSelect) return;
    try {
      chrome.runtime.sendMessage({
        type: "caption-language",
        source: sourceSelect.value,
        target: targetSelect.value,
      });
    } catch (e) {
      // Extension context gone (e.g. during unload); selection is best-effort.
    }
  }

  function makeSelect(defaultCode, labelText) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flex: "1",
      minWidth: "0",
    });

    const label = document.createElement("span");
    label.textContent = labelText;
    Object.assign(label.style, {
      fontFamily: FONT,
      fontSize: "11px",
      fontWeight: "500",
      color: "#ccc",
      whiteSpace: "nowrap",
    });

    const select = document.createElement("select");
    for (const [code, name] of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = name;
      if (code === defaultCode) opt.selected = true;
      select.appendChild(opt);
    }
    Object.assign(select.style, {
      flex: "1",
      minWidth: "0",
      background: "#1c1c1c",
      color: "#fff",
      border: "1px solid rgba(255, 255, 255, 0.25)",
      borderRadius: "6px",
      fontFamily: FONT,
      fontSize: "12px",
      padding: "3px 6px",
      outline: "none",
    });
    select.addEventListener("change", sendLanguage);

    wrap.appendChild(label);
    wrap.appendChild(select);
    return { wrap, select };
  }

  function styleLine(el, streaming) {
    Object.assign(el.style, {
      fontFamily: FONT,
      fontSize: "20px",
      fontWeight: "500",
      lineHeight: "1.45",
      textAlign: "center",
      color: "#fff",
      overflowWrap: "break-word",
      whiteSpace: "pre-wrap",
      padding: "2px 0",
      opacity: streaming ? "0.8" : "1",
    });
  }

  function ensureOverlay() {
    if (container) return container;
    container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");
    Object.assign(container.style, {
      position: "fixed",
      left: "50%",
      bottom: "6%",
      transform: "translateX(-50%)",
      width: "min(78vw, 720px)",
      minWidth: "300px",
      minHeight: "110px",
      maxHeight: "42vh",
      overflow: "hidden",
      resize: "both",
      background: "rgba(0, 0, 0, 0.82)",
      borderRadius: "10px",
      border: "1px solid rgba(255, 255, 255, 0.12)",
      zIndex: "2147483647",
      display: "none",
    });

    header = document.createElement("div");
    Object.assign(header.style, {
      // Hidden until the panel is hovered (see listeners below).
      display: "none",
      alignItems: "center",
      gap: "10px",
      padding: "6px 10px",
      background: "rgba(255, 255, 255, 0.07)",
      borderBottom: "1px solid rgba(255, 255, 255, 0.15)",
      cursor: "move",
      touchAction: "none",
      userSelect: "none",
    });
    const src = makeSelect("en", "Original");
    const tgt = makeSelect("en", "Translate to");
    sourceSelect = src.select;
    targetSelect = tgt.select;
    header.appendChild(src.wrap);
    header.appendChild(tgt.wrap);
    container.appendChild(header);

    body = document.createElement("div");
    Object.assign(body.style, {
      padding: "8px 14px 10px",
      overflowY: "auto",
      maxHeight: "calc(42vh - 45px)",
    });
    container.appendChild(body);

    (document.body || document.documentElement).appendChild(container);

    // The language header only appears while hovering the panel (or while a
    // dropdown has focus, for keyboard users).
    function showHeader() {
      header.style.display = "flex";
    }
    function hideHeader() {
      if (dragging) return;
      // Don't yank the header away while a dropdown is open or focused.
      if (header.contains(document.activeElement)) return;
      header.style.display = "none";
    }
    container.addEventListener("mouseenter", showHeader);
    container.addEventListener("mouseleave", hideHeader);
    container.addEventListener("focusin", showHeader);
    container.addEventListener("focusout", () => {
      if (container.matches(":hover")) return;
      hideHeader();
    });

    // Drag the panel by its header. Dropdowns are excluded so they stay
    // clickable. On the first drag, pin the panel's current position (it
    // starts centered via transform) so it can move freely, clamped to the
    // viewport.
    let dragging = false;
    let dragDX = 0;
    let dragDY = 0;

    function beginDrag(e) {
      if (e.target.closest("select")) return;
      const rect = container.getBoundingClientRect();
      container.style.left = rect.left + "px";
      container.style.top = rect.top + "px";
      container.style.bottom = "auto";
      container.style.transform = "none";
      dragDX = e.clientX - rect.left;
      dragDY = e.clientY - rect.top;
      dragging = true;
      try {
        header.setPointerCapture(e.pointerId);
      } catch (err) {
        // Pointer capture is best-effort; the window listeners below still
        // track the drag.
      }
      e.preventDefault();
    }

    function onDragMove(e) {
      if (!dragging) return;
      const w = container.offsetWidth;
      const h = container.offsetHeight;
      const x = Math.min(
        Math.max(e.clientX - dragDX, 0),
        Math.max(window.innerWidth - w, 0),
      );
      const y = Math.min(
        Math.max(e.clientY - dragDY, 0),
        Math.max(window.innerHeight - h, 0),
      );
      container.style.left = x + "px";
      container.style.top = y + "px";
    }

    function endDrag() {
      dragging = false;
    }

    header.addEventListener("pointerdown", beginDrag);
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    return container;
  }

  // Drop lines beyond the rolling window and dim older ones so the newest
  // subtitle reads as the focus.
  function trimLines() {
    if (!body) return;
    while (body.children.length > MAX_LINES) {
      body.removeChild(body.children[0]);
    }
    const n = body.children.length;
    for (let i = 0; i < n; i++) {
      const el = body.children[i];
      if (el === currentLine) {
        el.style.opacity = "0.8";
      } else {
        el.style.opacity = String(0.55 + (0.45 * (i + 1)) / n);
      }
    }
  }

  function hide() {
    if (container) container.style.display = "none";
    if (body) body.innerHTML = "";
    currentLine = null;
    currentItemId = null;
  }

  function show(text, itemId, final) {
    ensureOverlay();
    container.style.display = "block";

    // A new item_id means a new utterance: roll the previous streaming line
    // into history and start a fresh line. A null item_id (older builds)
    // reuses the current line.
    if (!currentLine || (itemId != null && currentItemId !== itemId)) {
      currentLine = document.createElement("div");
      styleLine(currentLine, true);
      body.appendChild(currentLine);
      currentItemId = itemId != null ? itemId : null;
    }
    currentLine.textContent = text;

    if (final) {
      styleLine(currentLine, false);
      currentLine = null;
      currentItemId = null;
    }
    trimLines();
    body.scrollTop = body.scrollHeight;
  }

  // Build hidden now so the panel exists before the first caption arrives.
  // The default pair (en -> en) already means "no translation", identical to
  // the pre-dropdown behavior, so nothing is announced until the user
  // actually changes a dropdown. That keeps the backend wire byte-identical
  // to before unless the feature is used.
  ensureOverlay();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "caption") {
      const text = (message.text || "").trim();
      if (!text) {
        // Empty completion (silence/VAD artifact): drop an empty streaming
        // line rather than flashing a blank row.
        if (message.final === true && currentLine && !currentLine.textContent.trim()) {
          currentLine.remove();
          currentLine = null;
          currentItemId = null;
          trimLines();
        }
        return;
      }
      show(text, message.item_id, message.final === true);
    } else if (message?.type === "caption-clear") {
      hide();
    }
  });
})();
