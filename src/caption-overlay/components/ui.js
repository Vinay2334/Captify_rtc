// shadcn/ui-style primitives, ported to vanilla DOM.
//
// Real shadcn/ui is React + Radix + Tailwind, which cannot run in this
// classic-script, Shadow-DOM content script (no bundler entry, MV3 CSP).
// These factories mirror its prebuilt assets — Button, Badge, Progress,
// Separator, Avatar — with the same zinc design tokens and class hooks
// (ui-button, ui-badge, ... styled in styles/user-menu.css.js).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // variant: "default" | "secondary" | "outline" | "ghost" | "destructive"
  function button({ variant = "default", label, icon, onClick } = {}) {
    const btn = el("button", `ui-button ui-button--${variant}`);
    btn.type = "button";
    if (icon) {
      const span = el("span", "ui-button-icon");
      span.innerHTML = icon;
      btn.appendChild(span);
    }
    btn.appendChild(el("span", null, label));
    if (onClick) btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return btn;
  }

  function badge(text, variant = "secondary") {
    return el("span", `ui-badge ui-badge--${variant}`, text);
  }

  function separator() {
    const node = el("div", "ui-separator");
    node.setAttribute("role", "separator");
    return node;
  }

  // value: 0..max — shadcn Progress (Radix) semantics: role + aria values.
  function progress(used, limit) {
    const wrap = el("div", "ui-progress");
    wrap.setAttribute("role", "progressbar");
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", String(limit));
    wrap.setAttribute("aria-valuenow", String(Math.min(used, limit)));
    const bar = el("div", "ui-progress-bar");
    bar.style.width = `${limit > 0 ? Math.min(100, (used / limit) * 100) : 0}%`;
    wrap.appendChild(bar);
    return wrap;
  }

  function avatar(initials) {
    return el("span", "ui-avatar", initials || "?");
  }

  NS.ui = { el, button, badge, separator, progress, avatar };
})();
