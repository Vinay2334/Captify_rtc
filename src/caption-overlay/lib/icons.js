// SVG icons for the caption overlay (classic script: no imports/exports).
// Loaded before content-script.js; registers onto the shared namespace.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  const svg = (body, size) =>
    `<svg width="${size || 16}" height="${size || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  NS.icons = {
    // Hamburger (lucide "menu")
    menu: svg('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 14),
    user: svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    gauge: svg('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
    crown: svg('<path d="M11.56 3.27a.5.5 0 0 1 .88 0l2.95 5.88a1 1 0 0 0 1.52.28l3.5-3.18a.5.5 0 0 1 .81.54l-1.92 7.4a1 1 0 0 1-.97.76H5.67a1 1 0 0 1-.97-.76L2.78 6.79a.5.5 0 0 1 .8-.54l3.51 3.18a1 1 0 0 0 1.52-.28Z"/><path d="M5 21h14"/>', 15),
    check: svg('<path d="M20 6 9 17l-5-5"/>', 14),
    logIn: svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>', 15),
    logOut: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>', 15),
    zap: svg('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>', 15),
  };
})();
