// Account / quota / plan state for the user menu.
//
// Single source of truth for the overlay popup, backed by Supabase Auth
// (lib/supabase-auth.js) and the backend quota endpoint
// (GET <BACKEND_BASE_URL>/api/v1/me/quota). The service worker gates
// capture on `signedIn` under STORAGE_KEY, and the extension never holds
// anything but the user's own access token — usage/plan writes happen
// backend-side with the service_role key.
//
// Quota is stored in seconds (the unit the backend bills) and rendered
// in minutes by the menu; remaining = limit - used, computed server-side.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});
  const STORAGE_KEY = "captifyUserState";

  const DEFAULT_STATE = Object.freeze({
    signedIn: false,
    user: null, // { id, name, email, initials }
    quota: { usedSeconds: 0, limitSeconds: 6000, remainingSeconds: 6000 },
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

  // The popup sign-in page (?tabId=) registers its opener here so the
  // single "sign-in" notification carries the tab the worker must start.
  let originTabId = null;

  function notifyBackend(action) {
    try {
      const msg = { type: "captify-menu-action", action };
      // tabId is always explicit (null when unknown) so the worker can
      // fall back to the sender tab without guessing about missing keys.
      if (action === "sign-in") msg.tabId = originTabId;
      chrome.runtime?.sendMessage(msg);
    } catch (e) { /* extension context gone */ }
    if (action === "sign-in" || action === "sign-out") originTabId = null;
  }

  function initialsFor(user) {
    const name = user?.name || user?.email || "?";
    const parts = String(name).trim().split(/\s+/);
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    const local = String(user?.email || name).split("@")[0];
    return (local.slice(0, 2) || "?").toUpperCase();
  }

  function userFromSupabase(su) {
    if (!su) return null;
    const meta = su.user_metadata || {};
    const name = `${meta.first_name} ${meta.last_name}` || (su.email ? su.email.split("@")[0] : "Captify User");
    const user = { id: su.id || null, name, email: su.email || "" };
    user.initials = initialsFor(user);
    return user;
  }

  function applyQuotaSnapshot(snap) {
    if (!snap) return;
    state = {
      ...state,
      quota: {
        usedSeconds: Number(snap.used_seconds || 0),
        limitSeconds: Number(snap.limit_seconds || 0),
        remainingSeconds: Number(
          snap.remaining_seconds != null
            ? snap.remaining_seconds
            : (snap.limit_seconds || 0) - (snap.used_seconds || 0),
        ),
      },
      plan: snap.plan
        ? { ...state.plan, name: String(snap.plan) }
        : state.plan,
    };
    persist();
    emit();
  }

  async function fetchQuota() {
    const token = await NS.supabaseAuth?.getAccessToken?.();
    if (!token) return null;
    const url = NS.captifyConfig?.quotaUrl?.();
    if (!url) return null;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Token died between restore and use: drop to signed-out.
      await NS.userStore.signOut();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(`Quota request failed (${res.status})`);
    const snap = await res.json();
    if (snap?.email && state.user) {
      state = {
        ...state,
        user: { ...state.user, email: snap.email || state.user.email },
      };
    }
    applyQuotaSnapshot(snap);
    return snap;
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
    const done = (restored) => {
      loaded = true;
      emit();
      onReady?.(structuredClone(state));
      // Restore a persisted Supabase session (survives browser restarts),
      // then pull the live plan + quota from the backend.
      restore().catch(() => {});
    };
    try {
      chrome.storage?.local?.get(STORAGE_KEY, (res) => {
        if (res?.[STORAGE_KEY]) state = { ...structuredClone(DEFAULT_STATE), ...res[STORAGE_KEY] };
        done();
      });
      if (!chrome.storage?.local) done();
    } catch (e) { done(); }
  }

  async function restore() {
    const supa = await NS.supabaseAuth?.load?.();
    if (!supa) {
      // No Supabase session but a stale signed-in flag: sign out cleanly.
      if (state.signedIn) {
        state = structuredClone(DEFAULT_STATE);
        persist();
        emit();
        notifyBackend("sign-out");
      }
      return null;
    }
    let su = supa.user;
    if (!su) {
      try { su = await NS.supabaseAuth.getUser(); } catch (e) { su = null; }
    }
    state = {
      ...state,
      signedIn: true,
      user: userFromSupabase(su) || state.user || { name: "Captify User", email: "", initials: "CU" },
    };
    persist();
    emit();
    try { await fetchQuota(); } catch (e) { /* overlay still works; quota retries on open */ }
    return structuredClone(state);
  }

  async function setSignedIn(su) {
    state = {
      ...state,
      signedIn: true,
      user: userFromSupabase(su) || { name: "Captify User", email: "", initials: "CU" },
    };
    persist();
    emit();
    notifyBackend("sign-in");
    try { await fetchQuota(); } catch (e) { /* surfaced by the gate/menu */ throw e; }
    return structuredClone(state);
  }

  NS.userStore = {
    setOriginTab: (id) => {
      const n = id == null || id === "" ? null : Number(id);
      originTabId = Number.isFinite(n) ? n : null;
    },
    getState: () => structuredClone(state),
    isLoaded: () => loaded,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    load,
    restore,
    refreshQuota: fetchQuota,
    applyQuota: (snap) => applyQuotaSnapshot(snap),
    async signInWithPassword(email, password) {
      const { user } = await NS.supabaseAuth.signInWithPassword(email, password);
      return setSignedIn(user);
    },
    async signUpWithPassword(email, password, firstName, lastName) {
      const { session, user } = await NS.supabaseAuth.signUp(email, password, firstName, lastName);
      // Email confirmation on: no session yet — stay signed out with a
      // message for the gate; the user signs in after clicking the link.
      if (!session) return { needsConfirmation: true, user: userFromSupabase(user) };
      return setSignedIn(user);
    },
    async signInWithGoogle() {
      const { user } = await NS.supabaseAuth.signInWithGoogle();
      return setSignedIn(user);
    },
    // Back-compat alias for the pre-auth demo button contract.
    async signIn() {
      throw new Error("Choose email or Google sign-in.");
    },
    async signOut() {
      try { await NS.supabaseAuth?.signOut?.(); } catch (e) { /* local clear below */ }
      state = structuredClone(DEFAULT_STATE);
      persist();
      emit();
      notifyBackend("sign-out");
    },
    upgrade() { notifyBackend("upgrade"); },
    getProPlan: () => ({ ...PRO_PLAN }),
    // Minutes shown in the menu (billing stays in seconds server-side).
    quotaMinutes(s = state) {
      const used = Math.floor((s.quota.usedSeconds || 0) / 60);
      const limit = Math.max(Math.ceil((s.quota.limitSeconds || 0) / 60), 1);
      const remaining = Math.max(Math.ceil((s.quota.remainingSeconds || 0) / 60), 0);
      return { usedMinutes: used, limitMinutes: limit, remainingMinutes: remaining };
    },
  };
})();
