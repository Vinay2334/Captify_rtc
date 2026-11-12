// Styles for the hamburger button + user-menu popup and the shadcn-style
// primitives in components/ui.js. Appended to the overlay <style> by
// content-script.js (Shadow DOM: host-page CSS cannot reach these nodes).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  NS.userMenuCss = `
    /* Hamburger button (top bar) */
    .captify-hamburger-btn {
      width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0;
      border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.75); display: flex; align-items: center;
      justify-content: center; cursor: pointer; padding: 0; outline: none;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
    }
    .captify-hamburger-btn:hover, .captify-hamburger-btn[aria-expanded="true"] {
      background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.25); color: #fff;
    }
    .captify-hamburger-btn:active { transform: scale(0.93); }
    .captify-hamburger-btn:focus-visible {
      border-color: rgba(255,255,255,0.6); box-shadow: 0 0 0 2px rgba(255,255,255,0.2);
    }

    /* User-menu popup: a second panel in the subtitle window's style */
    .captify-user-menu {
      position: absolute; top: calc(100% + 8px); right: 0; width: 300px;
      max-width: calc(100vw - 24px); padding: 14px; z-index: 30;
      background: rgba(18,18,22,0.94); color: #fafafa;
      backdrop-filter: blur(16px) saturate(180%); -webkit-backdrop-filter: blur(16px) saturate(180%);
      border: 1px solid rgba(255,255,255,0.14); border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.2);
      opacity: 0; visibility: hidden; transform: translateY(-6px) scale(0.98);
      transform-origin: top right; cursor: default; user-select: none;
      transition: opacity 0.18s ease, transform 0.18s cubic-bezier(0.16,1,0.3,1), visibility 0.18s;
    }
    .captify-user-menu.is-open { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }
    .captify-panel.user-menu-open .captify-header-wrap {
      opacity: 1; visibility: visible; transform: translateY(0) scale(1); pointer-events: auto;
    }

    .um-head { display: flex; align-items: center; gap: 10px; }
    .um-head-text { flex: 1; min-width: 0; }
    .um-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .um-email { font-size: 11px; color: rgba(255,255,255,0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .um-section-label {
      display: flex; align-items: center; gap: 6px; margin-bottom: 7px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: rgba(255,255,255,0.55);
    }
    .um-section-label svg { color: rgba(255,255,255,0.7); }
    .um-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .um-value { font-size: 12px; color: rgba(255,255,255,0.85); }
    .um-muted { font-size: 11px; color: rgba(255,255,255,0.5); margin-top: 6px; }
    .um-stack { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .um-plan-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }

    /* shadcn/ui primitives (zinc tokens, dark overlay surface) */
    .ui-avatar {
      width: 34px; height: 34px; border-radius: 999px; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.12); color: #fafafa;
      font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,0.16);
    }
    .ui-badge {
      display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px;
      font-size: 10px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap;
      border: 1px solid transparent;
    }
    .ui-badge--default { background: #fafafa; color: #18181b; }
    .ui-badge--secondary { background: rgba(255,255,255,0.12); color: rgba(255,255,255,0.9); border-color: rgba(255,255,255,0.12); }
    .ui-badge--outline { background: transparent; color: rgba(255,255,255,0.8); border-color: rgba(255,255,255,0.25); }
    .ui-separator { height: 1px; background: rgba(255,255,255,0.12); margin: 12px 0; }
    .ui-progress { height: 8px; border-radius: 999px; background: rgba(255,255,255,0.12); overflow: hidden; }
    .ui-progress-bar { height: 100%; border-radius: 999px; background: #fafafa; transition: width 0.3s ease; }
    .ui-button {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      height: 32px; padding: 0 14px; border-radius: 8px; width: 100%;
      font-size: 12px; font-weight: 500; cursor: pointer; outline: none;
      border: 1px solid transparent; transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
    }
    .ui-button:active { transform: scale(0.98); }
    .ui-button:focus-visible { box-shadow: 0 0 0 2px rgba(255,255,255,0.35); }
    .ui-button-icon { display: inline-flex; }
    .ui-button--default { background: #fafafa; color: #18181b; }
    .ui-button--default:hover { background: rgba(250,250,250,0.86); }
    .ui-button--secondary { background: rgba(255,255,255,0.1); color: #fafafa; border-color: rgba(255,255,255,0.12); }
    .ui-button--secondary:hover { background: rgba(255,255,255,0.18); }
    .ui-button--outline { background: transparent; color: #fafafa; border-color: rgba(255,255,255,0.25); }
    .ui-button--outline:hover { background: rgba(255,255,255,0.1); }
    .ui-button--ghost { background: transparent; color: rgba(255,255,255,0.8); }
    .ui-button--ghost:hover { background: rgba(255,255,255,0.1); color: #fff; }
  `;
})();
