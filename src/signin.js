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
    const firstNameInput = $("signin-firstname");
    const lastNameInput = $("signin-lastname");
    const modeToggle = $("signin-toggle");
    const modeMessage = $("signin-toggle-message");
    const mNameRow = $("signin-name-row");
    const submitBtn = $("signin-submit");
    const googleBtn = $("signin-google");
    const errorLine = $("signin-error");
    const signedinBox = $("signin-signedin");
    const welcomeLine = $("signin-welcome");
    const tabId = tabIdFromQuery(location || {});
    let busy = false;
    let authMode = "signin";

    function setAuthMode(mode) {
      authMode = mode;

      const isSignup = mode === "signup";

      mNameRow.hidden = !isSignup;

      firstNameInput.disabled = !isSignup;
      lastNameInput.disabled = !isSignup;
      firstNameInput.hidden = !isSignup;
      lastNameInput.hidden = !isSignup;

      firstNameInput.required = isSignup;
      lastNameInput.required = isSignup;

      passwordInput.autocomplete = isSignup
        ? "new-password"
        : "current-password";

      submitBtn.textContent = isSignup ? "Create account" : "Sign in";

      modeToggle.textContent = isSignup ? "Sign In" : "Sign Up";

      modeMessage.textContent = isSignup
        ? "Already have an account?"
        : "Don't have an account?";

      errorLine.hidden = true;
      errorLine.textContent = "";
    }
    modeToggle.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode(authMode === "signin" ? "signup" : "signin");
    });
    setAuthMode("signin");

    function showError(err) {
      errorLine.textContent = err?.message || String(err || "Sign-in failed.");
      errorLine.hidden = false;
    }

    // The tab login notification rides the store's own "sign-in"
    // message (originTabId registered below); here just close up.
    function closeAfterLogin() {
      try {
        window.close();
      } catch (e) {
        /* user closes manually */
      }
    }

    function refresh() {
      const s = userStore.getState();
      const signedIn = !!s.signedIn;

      signedinBox.hidden = !signedIn;
      form.hidden = signedIn;
      googleBtn.hidden = signedIn;

      if (signedIn && s.user) {
        welcomeLine.textContent = `Signed in as ${s.user.email || s.user.name}. Captions are unlocked.`;
      }
    }

    async function run(fn) {
      if (busy) return;

      busy = true;
      errorLine.hidden = true;

      submitBtn.disabled = true;
      googleBtn.disabled = true;

      try {
        await fn();
      } catch (e) {
        showError(e);
      } finally {
        busy = false;

        submitBtn.disabled = false;
        googleBtn.disabled = false;
      }
    }

    // Register the opener before any login attempt so the store's
    // "sign-in" notification carries this tab.
    try {
      userStore.setOriginTab?.(tabId);
    } catch (e) {
      /* optional */
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();

      if (!form.reportValidity()) return;

      run(async () => {
        if (authMode === "signup") {
          const res = await userStore.signUpWithPassword(
            emailInput.value.trim(),
            passwordInput.value,
            firstNameInput.value.trim(),
            lastNameInput.value.trim(),
          );

          if (res?.needsConfirmation) {
            setAuthMode("signin");
            errorLine.textContent = "Check your inbox to confirm your email, then sign in.";
            errorLine.hidden = false;
            return;
          }

          closeAfterLogin();
        } else {
          await userStore.signInWithPassword(
            emailInput.value.trim(),
            passwordInput.value,
          );

          closeAfterLogin();
        }
      });
    });
    googleBtn.addEventListener("click", () => {
      run(() => userStore.signInWithGoogle().then(closeAfterLogin));
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
    if (
      typeof document !== "undefined" &&
      document.getElementById?.("signin-form")
    ) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () =>
          createSigninPage({
            document,
            window,
            location,
            userStore: NS.userStore,
          }),
        );
      } else {
        createSigninPage({
          document,
          window,
          location,
          userStore: NS.userStore,
        });
      }
    }
  } catch (e) {
    /* test harness without DOM */
  }
})();
