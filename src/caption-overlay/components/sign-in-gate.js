// Sign-in gate shown directly inside the subtitle window when signed out.
// The form itself lives on a separate sign-in page (src/signin.html):
// this gate only explains the block and opens that page in a new window,
// keeping the small overlay free of cramped inputs.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  function createSignInGate() {
    const { ui, icons, userStore } = NS;

    const el = ui.el("div", "captify-auth-gate");
    el.setAttribute("role", "alert");

    const title = ui.el("div", "auth-gate-title", "Sign in to use Captify");
    const message = ui.el(
      "p", "auth-gate-message",
      "Subtitles are off until you sign in. Continue on the sign-in page to start live captions for this tab.",
    );

    const errorLine = ui.el("p", "auth-gate-error");
    errorLine.hidden = true;

    const signInBtn = ui.button({
      variant: "default", label: "Sign in", icon: icons.logIn,
      onClick: () => {
        errorLine.hidden = true;
        signInBtn.disabled = true;
        try {
          chrome.runtime?.sendMessage({ type: "open-signin" });
        } catch (e) {
          errorLine.textContent = "Couldn't open the sign-in page. Try again.";
          errorLine.hidden = false;
        } finally {
          signInBtn.disabled = false;
        }
      },
    });
    signInBtn.classList.add("auth-gate-btn");
    el.append(title, message, signInBtn, errorLine);

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
