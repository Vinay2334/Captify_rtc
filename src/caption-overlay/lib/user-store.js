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
  // Same-document re-injection re-runs this script: keep the existing store
  // so subscriptions, loaded state and quota survive instead of resetting.
  if (NS.userStore) return;
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

  // Concurrent expiry paths (refresh listener + quota 401) must send one
  // sign-out notification: collapse overlapping signOut calls.
  let signOutActive = null;
  async function doSignOut() {
    try { await NS.supabaseAuth?.signOut?.(); } catch (e) { /* local clear below */ }
    state = structuredClone(DEFAULT_STATE);
    persist();
    emit();
    notifyBackend("sign-out");
  }

  function notifyBackend(action, extra) {
    try {
      const msg = { type: "captify-menu-action", action, ...(extra || {}) };
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
    const name = (meta.first_name || meta.last_name ? `${meta?.first_name} ${meta?.last_name}` : null) || meta?.name || (su.email ? su.email.split("@")[0] : "Captify User");
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
    // A new name with another plan's facts (price/tagline) must not
    // linger: re-enrich from the cached catalog when one is loaded.
    enrichPlanFromCatalog();
    persist();
    emit();
  }

  // Backend reads go through the service worker first. Content-script
  // fetches run under the page's origin, so on public sites Private/Local
  // Network Access blocks loopback outright (quota AND plans fail with a
  // CORS error). The worker fetches with host permissions instead (no
  // page origin, no preflight block). Falls back to a direct fetch when
  // no worker answers (plain-node tests, popup mid-restart, old workers).
  // Either path resolves to { status, ok, body } (never throws).
  async function fetchJson(url, headers) {
    let viaWorker = null;
    try {
      viaWorker = await workerFetchJson(url, headers);
    } catch (e) {
      viaWorker = null; // exotic context (no timers): direct fallback
    }
    if (viaWorker) return viaWorker;
    try {
      const res = await fetch(url, headers ? { headers } : undefined);
      let body = null;
      try { body = await res.json(); } catch (e) { /* non-JSON */ }
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      return { status: 0, ok: false, body: null };
    }
  }

  function workerFetchJson(url, headers) {
    try {
      if (!chrome.runtime?.sendMessage) return Promise.resolve(null);
      const request = (async () => {
        try {
          const res = await chrome.runtime.sendMessage({
            type: "captify-overlay-data",
            url,
            headers: headers || {},
          });
          // A bare { ok } ack (other listeners, old workers) is not data.
          if (!res || typeof res !== "object" || res.status === undefined || res.ok === undefined) {
            return null;
          }
          return res;
        } catch (e) {
          return null; // no receiving end (worker dead): direct fallback
        }
      })();
      // A listener that never answers must not hang the menu: fall back.
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 8000);
      });
      return Promise.race([request, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  async function fetchQuota() {
    // Pick up a moved backend before building the URL (cheap storage read;
    // baked-in defaults stand when nothing cached yet).
    try { await NS.captifyConfig?.loadRemoteConfig?.(); } catch (e) {}
    let token = await NS.supabaseAuth?.getAccessToken?.();
    // Snapshot before the reload below: a concurrent expiry sign-out may
    // flip state while we re-read storage, and the throw must not depend
    // on winning that race.
    const wasSignedIn = state.signedIn;
    if (!token) {
      // The sign-in popup writes the session from another context, which
      // this overlay's in-memory auth may not have seen yet (its state
      // arrived via the storage event, not a reload): re-read storage
      // before concluding the session expired.
      try { await NS.supabaseAuth?.load?.(); } catch (e) { /* keep going */ }
      token = await NS.supabaseAuth?.getAccessToken?.();
    }
    if (!token) {
      // No usable token AND no session left (the refresh rejected the
      // grant and cleared it client-side): fall back to signed-out so the
      // overlay shows the sign-in gate. A session still in memory means a
      // transient refresh failure — stay signed in and retry next time.
      if (wasSignedIn && !NS.supabaseAuth?.getSession?.()) {
        await NS.userStore.signOut();
        throw new Error("Session expired. Please sign in again.");
      }
      return null;
    }
    const url = NS.captifyConfig?.quotaUrl?.();
    if (!url) return null;
    const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
    if (res.status === 401) {
      // Token died between restore and use: drop to signed-out.
      await NS.userStore.signOut();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) throw new Error(`Quota request failed (${res.status})`);
    const snap = res.body;
    if (!snap) throw new Error("Quota request failed (bad_response)");
    if (snap?.email && state.user) {
      state = {
        ...state,
        user: { ...state.user, email: snap.email || state.user.email },
      };
    }
    applyQuotaSnapshot(snap);
    return snap;
  }

  // Live plan catalog (GET /api/v1/plans): the single source of truth for
  // plan order. Cached in memory, cheapest first; the upgrade button
  // derives "one above current" from it so a new plan needs no extension
  // change. Null until the first successful fetch.
  let planCatalog = null;

  function sortCatalog(plans) {
    return [...plans].sort(
      (a, b) =>
        Number(a.display_order ?? 0) - Number(b.display_order ?? 0) ||
        Number(a.price_monthly_usd ?? 0) - Number(b.price_monthly_usd ?? 0) ||
        (String(a.id ?? a.name ?? "") < String(b.id ?? b.name ?? "") ? -1 : 1),
    );
  }

  async function fetchPlanCatalog() {
    try { await NS.captifyConfig?.loadRemoteConfig?.(); } catch (e) {}
    const url = NS.captifyConfig?.plansUrl?.();
    if (!url) return null;
    // fetchJson never throws: unreachable/blocked backends resolve
    // { ok: false } and the menu keeps the legacy fallback.
    const res = await fetchJson(url);
    if (!res?.ok) return null; // billing disabled answers 503: same fallback
    const rows = Array.isArray(res.body?.plans) ? res.body.plans : null;
    if (!rows) return null;
    planCatalog = sortCatalog(rows.filter((p) => p && (p.id || p.name)));
    // Quota snapshots only carry the plan name: enrich the displayed
    // price/tagline from the same rows the pricing page renders.
    if (enrichPlanFromCatalog()) {
      persist();
      emit();
    }
    return planCatalog;
  }

  // Patch the displayed price/tagline for the current plan name from the
  // cached catalog. Runs after every plan-name change (quota snapshot,
  // catalog fetch) so the menu never shows another plan's facts.
  // Returns true when anything changed.
  function enrichPlanFromCatalog() {
    if (!planCatalog) return false;
    const current = planCatalog.find((p) => p.name === state.plan.name);
    if (!current) return false;
    const priceLabel = current.price_label || state.plan.priceLabel;
    const tagline = current.tagline || state.plan.tagline;
    if (priceLabel === state.plan.priceLabel && tagline === state.plan.tagline) return false;
    state = { ...state, plan: { ...state.plan, priceLabel, tagline } };
    return true;
  }

  // The plan one step above `planName` in catalog order ({ name }), or
  // null when already on the top plan (the menu hides the button then).
  // Unknown current plan: offer the cheapest paid plan (parallels the
  // pricing page, where every paid plan is an upgrade from unknown).
  // No catalog yet: legacy fallback — Pro for everyone not already on
  // it, exactly like before.
  function upgradeTargetFor(planName, catalog = planCatalog) {
    if (!catalog?.length) {
      return planName === PRO_PLAN.name ? null : { ...PRO_PLAN };
    }
    const idx = catalog.findIndex((p) => p?.name === planName);
    if (idx === -1) {
      const paid = catalog.filter((p) => Number(p.price_monthly_usd || 0) > 0);
      return paid.length ? { name: String(paid[0].name) } : null;
    }
    const next = catalog[idx + 1];
    return next ? { name: String(next.name) } : null;
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
    try { await NS.captifyConfig?.loadRemoteConfig?.(); } catch (e) {}
    const supa = await NS.supabaseAuth?.load?.();
    if (!supa) {
      // No Supabase session but a stale signed-in flag: sign out cleanly
      // (deduped with the expiry subscriber's in-flight sign-out).
      if (state.signedIn) await NS.userStore.signOut();
      return null;
    }
    let su = supa.user;
    if (!su) {
      try { su = await NS.supabaseAuth.getUser(); } catch (e) { su = null; }
    }
    if (!su && !NS.supabaseAuth.getSession?.()) {
      // The stored session died (expired refresh cleared the client
      // token): sign out instead of staying unlocked with no identity.
      await NS.userStore.signOut();
      return null;
    }
    state = {
      ...state,
      signedIn: true,
      user: userFromSupabase(su) || state.user || { name: "Captify User", email: "", initials: "CU" },
    };
    persist();
    emit();
    try { await fetchQuota(); } catch (e) { /* overlay still works; quota retries on open */ }
    try { await fetchPlanCatalog(); } catch (e) { /* menu retries on open */ }
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
    refreshPlans: fetchPlanCatalog,
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
      // Join an in-flight sign-out; already signed out with no session
      // left means nothing to clear or announce (keeps expiry races to a
      // single worker notification).
      if (signOutActive) return signOutActive;
      if (!state.signedIn && !NS.supabaseAuth?.getSession?.()) return;
      signOutActive = doSignOut().finally(() => { signOutActive = null; });
      return signOutActive;
    },
    // Backend rejected the session (expired/invalid token): the client
    // token is already gone — drive every overlay to the signed-out UI
    // (sign-in gate) and stop capture via the worker's sign-out path.
    async handleSessionExpired() {
      console.log("Supabase session expired: signing out overlay and worker.", NS.supabaseAuth?.getSession?.());
      if (!state.signedIn && !NS.supabaseAuth?.getSession?.()) return;
      await NS.userStore.signOut();
    },
    // Content scripts can't open tabs directly (no chrome.tabs there), so
    // the pricing URL is built here — where the account lives — and the
    // service worker opens it after allow-listing it against SITE_URL.
    upgrade() {
      const s = NS.userStore.getState();
      const url = NS.captifyConfig?.pricingUrl?.(s.user?.email, s.user?.id);
      notifyBackend("upgrade", url ? { url } : undefined);
    },
    getProPlan: () => ({ ...PRO_PLAN }),
    // The upgrade button label's plan ({ name }) or null when the menu
    // should show no upgrade button (already on the top plan).
    getUpgradeTarget: (planName) =>
      upgradeTargetFor(planName ?? NS.userStore.getState().plan.name),
    // Minutes shown in the menu (billing stays in seconds server-side).
    quotaMinutes(s = state) {
      const used = Math.floor((s.quota.usedSeconds || 0) / 60);
      const limit = Math.max(Math.ceil((s.quota.limitSeconds || 0) / 60), 1);
      const remaining = Math.max(Math.ceil((s.quota.remainingSeconds || 0) / 60), 0);
      return { usedMinutes: used, limitMinutes: limit, remainingMinutes: remaining };
    },
  };

  // Expired refreshes already cleared the client token inside supabase-auth;
  // sign the overlay out right away instead of retrying with nothing.
  // Guarded: the module-load-order test loads this store without auth.
  try {
    NS.supabaseAuth?.onSessionExpired?.(() => {
      NS.userStore?.handleSessionExpired?.()?.catch?.(() => {});
    });
  } catch (e) { /* auth unavailable */ }
})();
