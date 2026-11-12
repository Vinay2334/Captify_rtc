// Sign-in gate shown directly inside the subtitle window when signed out.
// Captify does not run until sign-in: content-script.js hides the caption
// body/status bar and drops captions while this is visible (and the service
// worker refuses to start capture). createSignInGate() -> { el, destroy }.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  function createSignInGate() {
    const { ui, icons, userStore } = NS;

    const el = ui.el("div", "captify-auth-gate");
    el.setAttribute("role", "alert");

    const title = ui.el("div", "auth-gate-title", "Sign in to use Captify");
    const message = ui.el(
      "p", "auth-gate-message",
      "Subtitles are off until you sign in. Sign in to start live captions for this tab.",
    );
    const signInBtn = ui.button({
      variant: "default", label: "Sign in", icon: icons.logIn,
      onClick: () => userStore.signIn(),
    });
    signInBtn.classList.add("auth-gate-btn");
    el.append(title, message, signInBtn);

    function refresh() {
      el.hidden = !!userStore.getState().signedIn;
    }
    const unsubscribe = userStore.subscribe(refresh);
    userStore.load(refresh);
    refresh();

    return { el, refresh, destroy: () => unsubscribe() };
  }

  NS.createSignInGate = createSignInGate;
})();
