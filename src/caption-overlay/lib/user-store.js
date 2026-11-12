// Account / quota / plan state for the user menu.
//
// Single source of truth for the popup. Today there is no auth or billing
// backend in this repo, so sign-in is a local demo profile persisted in
// chrome.storage.local (falling back to memory). Swap `signIn`/`notifyBackend`
// for real calls later — the menu only reads state via getState()/subscribe().
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const STORAGE_KEY = "captifyUserState";

  const DEFAULT_STATE = Object.freeze({
    signedIn: false,
    user: null, // { name, email, initials }
    quota: { usedMinutes: 0, limitMinutes: 100, resetsLabel: "Resets on the 1st" },
    plan: { name: "Free", priceLabel: "$0 / month", tagline: "For trying Captify" },
  });

  const PRO_PLAN = Object.freeze({
    name: "Pro",
    priceLabel: "$12 / month",
    tagline: "Unlimited minutes, priority speed",
  });

  let state = structuredClone(DEFAULT_STATE);
  let loaded = false;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) {
      try { fn(structuredClone(state)); } catch (e) { /* listener error */ }
    }
  }

  function persist() {
    try {
      chrome.storage?.local?.set({ [STORAGE_KEY]: state });
    } catch (e) { /* storage unavailable: memory-only */ }
  }

  function notifyBackend(action) {
    try {
      chrome.runtime?.sendMessage({ type: "captify-menu-action", action });
    } catch (e) { /* extension context gone */ }
  }

  let watchingStorage = false;
  // Keep every tab's overlay in sync: sign-in/out in one tab gates all tabs.
  function watchStorage() {
    if (watchingStorage) return;
    watchingStorage = true;
    try {
      chrome.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local" || !changes[STORAGE_KEY]) return;
        state = { ...structuredClone(DEFAULT_STATE), ...(changes[STORAGE_KEY].newValue || {}) };
        loaded = true;
        emit();
      });
    } catch (e) { /* storage events unavailable */ }
  }

  function load(onReady) {
    watchStorage();
    const done = () => { loaded = true; emit(); onReady?.(structuredClone(state)); };
    try {
      chrome.storage?.local?.get(STORAGE_KEY, (res) => {
        if (res?.[STORAGE_KEY]) state = { ...structuredClone(DEFAULT_STATE), ...res[STORAGE_KEY] };
        done();
      });
      if (!chrome.storage?.local) done();
    } catch (e) { done(); }
  }

  NS.userStore = {
    getState: () => structuredClone(state),
    isLoaded: () => loaded,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    load,
    signIn() {
      state = {
        ...state,
        signedIn: true,
        user: { name: "Captify User", email: "user@captify.local", initials: "CU" },
        quota: { ...state.quota, usedMinutes: state.quota.usedMinutes || 12 },
      };
      persist(); emit(); notifyBackend("sign-in");
    },
    signOut() {
      state = structuredClone(DEFAULT_STATE);
      persist(); emit(); notifyBackend("sign-out");
    },
    upgrade() { notifyBackend("upgrade"); },
    getProPlan: () => ({ ...PRO_PLAN }),
  };
})();
