// Main subtitle-window stylesheet (moved verbatim from content-script.js) (classic script: no imports/exports; shares window.CaptifyOverlay).
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const S = NS.state;
  const C = NS.constants;
  NS.createStyles = function() {
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

      /* Bottom status bar: play/pause button on the left, status text right */
      .captify-statusbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
        flex-shrink: 0;
      }

      .captify-play-btn {
        width: 26px;
        height: 26px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.07);
        color: #f3f4f6;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex-shrink: 0;
        padding: 0;
        outline: none;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }

      .captify-play-btn:hover {
        background: rgba(255, 255, 255, 0.14);
        border-color: rgba(255, 255, 255, 0.25);
      }

      .captify-play-btn:active {
        transform: scale(0.93);
      }

      .captify-play-btn:focus-visible {
        border-color: rgba(255, 255, 255, 0.6);
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
      }

      .captify-spinner {
        width: 13px;
        height: 13px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.25);
        border-top-color: #fff;
        animation: captify-spin 0.8s linear infinite;
        display: inline-block;
      }

      @keyframes captify-spin {
        to { transform: rotate(360deg); }
      }

      .captify-status {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        min-width: 0;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.01em;
        color: rgba(255, 255, 255, 0.75);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #f5a623;
        flex-shrink: 0;
        animation: captify-pulse 1.6s ease-in-out infinite;
      }

      .status-dot.is-live {
        background: #34d399;
        animation: none;
      }

      .status-dot.is-paused {
        background: rgba(255, 255, 255, 0.35);
        animation: none;
      }

      .status-dot.is-error {
        background: #f87171;
      }

      .captify-retry-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 12px;
        border-radius: 8px;
        border: 1px solid rgba(248, 113, 113, 0.5);
        background: rgba(248, 113, 113, 0.16);
        color: #fecaca;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        cursor: pointer;
        flex-shrink: 0;
        outline: none;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }

      .captify-retry-btn:hover {
        background: rgba(248, 113, 113, 0.28);
        border-color: rgba(248, 113, 113, 0.75);
      }

      .captify-retry-btn:active {
        transform: scale(0.95);
      }

      .captify-retry-btn:focus-visible {
        border-color: #f87171;
        box-shadow: 0 0 0 2px rgba(248, 113, 113, 0.25);
      }

      .captify-retry-btn[hidden] {
        display: none;
      }

      /* display:flex above beats the hidden attribute; restore it. */
      .captify-play-btn[hidden] {
        display: none;
      }

      @keyframes captify-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }

      @media (prefers-reduced-motion: reduce) {
        .captify-spinner,
        .status-dot {
          animation: none;
        }
        .captify-panel,
        .caption-line {
          transition: none;
        }
      }
    ` + (NS.userMenuCss || "") + (NS.signInGateCss || "");
    return style;
  }
})();
