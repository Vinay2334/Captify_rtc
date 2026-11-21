// Backend + Supabase project configuration for the Captify extension.
//
// Fill in SUPABASE_URL and SUPABASE_ANON_KEY from your Supabase dashboard
// (Project Settings -> API). The anon key is public by design: it only
// identifies the project, while user data stays protected by RLS and the
// service_role key never leaves the backend.
//
// BACKEND_BASE_URL must match where `uvicorn app.main:app` listens
// (see rtc-config.js SIGNAL_URL); /api/v1/me/quota is derived from it.
(function () {
  const NS = (window.CaptifyOverlay = window.CaptifyOverlay || {});

  // Baked-in defaults mirror DEFAULT_CONFIG in src/remote-config.mjs
  // (single source of truth). This classic script can't import ESM —
  // content scripts must stay import-free — so keep the values below in
  // sync with it; tests/config-sync.test.mjs enforces this.
  NS.captifyConfig = {
    SUPABASE_URL: "https://hsuuleiisdgbidbwkqae.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_namQsShONsZJviiyWtulnA_wZ4NWUPW",
    BACKEND_BASE_URL: "http://127.0.0.1:8000",
    // Public pricing site (must match SITE_URL in website/site-config.js).
    // Upgrade opens pricing here with the account attached (?from=,
    // ?email=, ?user_id=) so checkout links carry the user id in metadata.
    SITE_URL: "http://localhost:8080",
  };

  // Local development switch. Must match DEV_FORCE_LOCAL_BACKEND in
  // src/remote-config.mjs (same import-free mirror as the URLs above):
  // true forces the localhost backend everywhere — applyRemoteConfig and
  // loadRemoteConfig below become no-ops so a stale storage cache can't
  // point the overlay at the hosted backend mid-dev. Flip back to false
  // before publishing, together with the module flag.
  NS.captifyConfig.DEV_FORCE_LOCAL_BACKEND = true;

  NS.captifyConfig.quotaUrl = function () {
    return `${NS.captifyConfig.BACKEND_BASE_URL.replace(/\/$/, "")}/api/v1/me/quota`;
  };

  NS.captifyConfig.plansUrl = function () {
    return `${NS.captifyConfig.BACKEND_BASE_URL.replace(/\/$/, "")}/api/v1/plans`;
  };

  // Hand-rolled query encoding: classic scripts avoid URLSearchParams so
  // they run in bare-vm tests as well as extension contexts.
  NS.captifyConfig.pricingUrl = function (email, userId) {
    const qs = [`from=${encodeURIComponent("extension")}`];
    if (email) qs.push(`email=${encodeURIComponent(email)}`);
    if (userId) qs.push(`user_id=${encodeURIComponent(userId)}`);
    return `${String(NS.captifyConfig.SITE_URL || "").replace(/\/$/, "")}/pricing.html?${qs.join("&")}`;
  };

  NS.captifyConfig.isConfigured = function () {
    return (
      !!NS.captifyConfig.SUPABASE_URL &&
      !NS.captifyConfig.SUPABASE_URL.includes("YOUR-PROJECT")
    );
  };

  // Over-the-air overrides from the hosted config document. The service
  // worker fetches and validates the document into chrome.storage.local
  // (key below must match REMOTE_CONFIG_STORAGE_KEY in src/remote-config.mjs);
  // the overlay applies the cached copy here before building backend URLs.
  // Same rule as the module validator: https: URLs, http: loopback only,
  // unknown fields ignored, never throws.
  NS.captifyConfig.applyRemoteConfig = function (obj) {
    // Dev mode pins the localhost backend: never apply remote overrides,
    // even when a stale hosted document sits in the storage cache.
    if (NS.captifyConfig.DEV_FORCE_LOCAL_BACKEND) return false;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    let changed = false;
    const setUrl = (key, value) => {
      if (typeof value !== "string" || !value) return;
      let url;
      try {
        url = new URL(value);
      } catch (e) {
        return;
      }
      const host = String(url.hostname || "").toLowerCase();
      const loopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1" ||
        host.indexOf("127.") === 0;
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        return;
      }
      NS.captifyConfig[key] = value;
      changed = true;
    };
    setUrl("BACKEND_BASE_URL", obj.backend_base_url);
    setUrl("SITE_URL", obj.site_url);
    setUrl("SUPABASE_URL", obj.supabase_url);
    if (typeof obj.supabase_anon_key === "string" && obj.supabase_anon_key) {
      NS.captifyConfig.SUPABASE_ANON_KEY = obj.supabase_anon_key;
      changed = true;
    }
    return changed;
  };

  // Reads the service worker's validated cache. False means "keep the
  // baked-in defaults" (offline, no fetch has landed yet, or dev mode
  // pins the localhost backend via DEV_FORCE_LOCAL_BACKEND above).
  NS.captifyConfig.loadRemoteConfig = async function () {
    if (NS.captifyConfig.DEV_FORCE_LOCAL_BACKEND) return false;
    try {
      const res = await chrome.storage?.local?.get("captifyRemoteConfig");
      return NS.captifyConfig.applyRemoteConfig(res?.captifyRemoteConfig);
    } catch (e) {
      return false;
    }
  };
})();
