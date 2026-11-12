// Logic for the standalone sign-in window (src/signin.html).
// Classic script: shares window.CaptifyOverlay, no imports.
// Reuses lib/user-store.js, so sign-in here flips the same shared state
// every tab overlay listens to; on success it tells the service worker
// which tab to start captions for, then closes itself.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  // Hand-rolled query parse: no URLSearchParams dependency, so this
  // classic script runs in any extension context (and in bare-vm tests).
  function tabIdFromQuery(location) {
    try {
      const search = String(location.search || "").replace(/^[?#]/, "");
      for (const part of search.split("&")) {
        const eq = part.indexOf("=");
        const key = eq < 0 ? part : part.slice(0, eq);
        if (decodeURIComponent(key) === "tabId") {
          const raw = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1));
          const id = raw === "" ? null : Number(raw);
          return Number.isFinite(id) ? id : null;
        }
      }
    } catch (e) {
      // Malformed query string: no tab to report back to.
    }
    return null;
  }

  function createSigninPage(deps) {
    const { document, window, location, userStore } = deps;
    const $ = (id) => document.getElementById(id);
    const form = $("signin-form");
    const emailInput = $("signin-email");
    const passwordInput = $("signin-password");
    const submitBtn = $("signin-submit");
    const googleBtn = $("signin-google");
    const signupBtn = $("signin-signup");
    const errorLine = $("signin-error");
    const signedinBox = $("signin-signedin");
    const welcomeLine = $("signin-welcome");
    const continueBtn = $("signin-continue");
    const closeBtn = $("signin-close");
    const tabId = tabIdFromQuery(location || {});
    let busy = false;

    function showError(err) {
      errorLine.textContent = err?.message || String(err || "Sign-in failed.");
      errorLine.hidden = false;
    }

    // The tab login notification rides the store's own "sign-in"
    // message (originTabId registered below); here just close up.
    function closeAfterLogin() {
      try { window.close(); } catch (e) { /* user closes manually */ }
    }

    // Already signed in (opened the page twice, or session restored):
    // the store won't notify again, so report this tab explicitly.
    function notifySignedIn() {
      try {
        chrome.runtime?.sendMessage({
          type: "captify-menu-action",
          action: "sign-in",
          tabId,
        });
      } catch (e) { /* worker will pick up storage state instead */ }
      closeAfterLogin();
    }

    function refresh() {
      const s = userStore.getState();
      const signedIn = !!s.signedIn;
      signedinBox.hidden = !signedIn;
      form.hidden = signedIn;
      googleBtn.hidden = signedIn;
      signupBtn.hidden = signedIn;
      if (signedIn && s.user) {
        welcomeLine.textContent =
          `Signed in as ${s.user.email || s.user.name}. Captions are unlocked.`;
      }
    }

    async function run(fn) {
      if (busy) return;
      busy = true;
      errorLine.hidden = true;
      for (const b of [submitBtn, googleBtn, signupBtn]) {
        try { b.disabled = true; } catch (e) { /* stub DOM */ }
      }
      try {
        await fn();
      } catch (e) {
        showError(e);
      } finally {
        busy = false;
        for (const b of [submitBtn, googleBtn, signupBtn]) {
          try { b.disabled = false; } catch (e) { /* stub DOM */ }
        }
      }
    }

    // Register the opener before any login attempt so the store's
    // "sign-in" notification carries this tab.
    try { userStore.setOriginTab?.(tabId); } catch (e) { /* optional */ }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      run(() => userStore
        .signInWithPassword(emailInput.value, passwordInput.value)
        .then(closeAfterLogin));
    });
    googleBtn.addEventListener("click", () => {
      run(() => userStore.signInWithGoogle().then(closeAfterLogin));
    });
    signupBtn.addEventListener("click", () => {
      run(() => userStore
        .signUpWithPassword(emailInput.value, passwordInput.value)
        .then((res) => {
          if (res?.needsConfirmation) {
            errorLine.textContent = "Check your inbox to confirm, then sign in.";
            errorLine.hidden = false;
            return;
          }
          closeAfterLogin();
        }));
    });
    continueBtn.addEventListener("click", notifySignedIn);
    closeBtn.addEventListener("click", () => {
      try { window.close(); } catch (e) { /* user closes manually */ }
    });

    const unsubscribe = userStore.subscribe(refresh);
    userStore.load(refresh);
    refresh();

    return { refresh, destroy: () => unsubscribe() };
  }

  NS.createSigninPage = createSigninPage;
  NS.signinTabIdFromQuery = tabIdFromQuery;

  // Real page boot: DOM is parsed before this classic script runs.
  try {
    if (typeof document !== "undefined" && document.getElementById?.("signin-form")) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => createSigninPage({
          document, window, location, userStore: NS.userStore,
        }));
      } else {
        createSigninPage({ document, window, location, userStore: NS.userStore });
      }
    }
  } catch (e) { /* test harness without DOM */ }
})();
