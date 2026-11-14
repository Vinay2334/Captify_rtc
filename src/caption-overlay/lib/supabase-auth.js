// Minimal Supabase Auth (GoTrue) client for the extension's classic
// scripts. No bundler dependency: plain fetch against the project's
// Auth REST API, so it runs in content scripts, the service worker, and
// plain-node tests (with fetch/chrome stubbed).
//
// - Email: signUp / signInWithPassword (secure server-side flow; the
//   extension only ever holds the user's own access/refresh tokens).
// - Google: chrome.identity.launchWebAuthFlow against the Supabase
//   authorize endpoint; tokens arrive in the redirect URL fragment.
// - Session persists in chrome.storage.local across browser restarts and
//   is refreshed before expiry; load() restores it on extension start.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  const STORAGE_KEY = "captifySupabaseSession";
  const REFRESH_SKEW_MS = 60 * 1000;

  function cfg() {
    return NS.captifyConfig || {};
  }

  function projectUrl() {
    return (cfg().SUPABASE_URL || "").replace(/\/$/, "");
  }

  function anonKey() {
    return cfg().SUPABASE_ANON_KEY || "";
  }

  async function storageGet(keys) {
    try {
      if (chrome?.storage?.local) {
        return await chrome.storage.local.get(keys);
      }
    } catch (e) { /* memory-only */ }
    return {};
  }

  async function storageSet(obj) {
    try {
      await chrome?.storage?.local?.set(obj);
    } catch (e) { /* memory-only */ }
  }

  async function storageRemove(key) {
    try {
      await chrome?.storage?.local?.remove(key);
    } catch (e) { /* memory-only */ }
  }

  function headers(extra = {}) {
    return {
      apikey: anonKey(),
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async function failMessage(res) {
    try {
      const body = await res.json();
      return body?.msg || body?.message || body?.error_description || `Request failed (${res.status})`;
    } catch (e) {
      return `Request failed (${res.status})`;
    }
  }

  // Normalize the two GoTrue session shapes (token endpoint vs signup)
  // into { access_token, refresh_token, expires_at, user }.
  function toSession(data) {
    if (!data?.access_token) return null;
    const expiresIn = Number(data.expires_in || 3600);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      expires_at: Date.now() + expiresIn * 1000,
      user: data.user || null,
    };
  }

  let session = null;
  let loaded = false;

  async function persist() {
    if (session) await storageSet({ [STORAGE_KEY]: session });
    else await storageRemove(STORAGE_KEY);
  }

  async function refresh() {
    if (!session?.refresh_token) return null;
    const res = await fetch(`${projectUrl()}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) {
      session = null;
      await persist();
      return null;
    }
    session = toSession(await res.json());
    await persist();
    return session;
  }

  function parseFragment(url) {
    const hash = String(url || "").split("#")[1] || "";
    const out = {};
    for (const part of hash.split("&")) {
      const [k, v] = part.split("=");
      if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    return out;
  }

  const api = {
    isLoaded: () => loaded,
    getSession: () => (session ? { ...session } : null),

    async load() {
      const stored = await storageGet(STORAGE_KEY);
      session = stored?.[STORAGE_KEY] || null;
      loaded = true;
      if (session && session.expires_at - Date.now() < REFRESH_SKEW_MS) {
        try { await refresh(); } catch (e) { session = null; }
      }
      return api.getSession();
    },

    async getAccessToken() {
      if (!session) return null;
      if (session.expires_at - Date.now() < REFRESH_SKEW_MS) {
        try { await refresh(); } catch (e) { /* fall through */ }
      }
      return session?.access_token || null;
    },

    async signUp(email, password, firstName, lastName) {
      const res = await fetch(`${projectUrl()}/auth/v1/signup`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: String(email || "").trim(), password, data: { first_name: firstName, last_name: lastName } }),
      });
      if (!res.ok) throw new Error(await failMessage(res));
      const data = await res.json();
      // With "confirm email" on, there is no session yet: the caller
      // shows "check your inbox"; with it off, we are signed in.
      if (data?.access_token) {
        session = toSession(data);
        await persist();
      }
      return { session: api.getSession(), user: data?.user || null };
    },

    async signInWithPassword(email, password) {
      const res = await fetch(`${projectUrl()}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: String(email || "").trim(), password }),
      });
      if (!res.ok) throw new Error(await failMessage(res));
      session = toSession(await res.json());
      await persist();
      return { session: api.getSession(), user: session?.user || null };
    },

    async signInWithGoogle() {
      if (!chrome?.identity?.launchWebAuthFlow) {
        throw new Error("Google sign-in needs a Chromium extension runtime.");
      }
      const redirectUrl = chrome.identity.getRedirectURL();
      const authUrl =
        `${projectUrl()}/auth/v1/authorize?provider=google` +
        `&redirect_to=${encodeURIComponent(redirectUrl)}`;
      let redirected;
      try {
        redirected = await chrome.identity.launchWebAuthFlow({
          url: authUrl,
          interactive: true,
        });
      } catch (e) {
        throw new Error("Google sign-in was cancelled.");
      }
      const params = parseFragment(redirected);
      if (params.error_description || params.error) {
        throw new Error(params.error_description || params.error);
      }
      if (!params.access_token) {
        throw new Error("Google sign-in did not return a session.");
      }
      session = {
        access_token: params.access_token,
        refresh_token: params.refresh_token || null,
        expires_at: Date.now() + Number(params.expires_in || 3600) * 1000,
        user: null,
      };
      // Resolve the profile for the display name/avatar.
      try {
        session.user = await api.getUser(session.access_token);
      } catch (e) { /* name/email come from the quota endpoint instead */ }
      await persist();
      return { session: api.getSession(), user: session?.user || null };
    },

    async getUser(accessToken) {
      const token = accessToken || (await api.getAccessToken());
      if (!token) return null;
      const res = await fetch(`${projectUrl()}/auth/v1/user`, {
        headers: headers({ Authorization: `Bearer ${token}` }),
      });
      if (!res.ok) throw new Error(await failMessage(res));
      const user = await res.json();
      if (session && !accessToken) {
        session.user = user;
        await persist();
      }
      return user;
    },

    async signOut() {
      const token = session?.access_token;
      session = null;
      await persist();
      // Best-effort server revocation; local state is already cleared.
      try {
        if (token) {
          await fetch(`${projectUrl()}/auth/v1/logout`, {
            method: "POST",
            headers: headers({ Authorization: `Bearer ${token}` }),
          });
        }
      } catch (e) { /* already signed out locally */ }
    },
  };

  NS.supabaseAuth = api;
})();
