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

  NS.captifyConfig = {
    SUPABASE_URL: "https://hsuuleiisdgbidbwkqae.supabase.co",
    SUPABASE_ANON_KEY: "sb_publishable_namQsShONsZJviiyWtulnA_wZ4NWUPW",
    BACKEND_BASE_URL: "http://127.0.0.1:8000",
    // Public pricing site (must match SITE_URL in website/site-config.js).
    // Upgrade opens pricing here with the account attached (?from=,
    // ?email=, ?user_id=) so checkout links carry the user id in metadata.
    SITE_URL: "http://localhost:8080",
  };

  NS.captifyConfig.quotaUrl = function () {
    return `${NS.captifyConfig.BACKEND_BASE_URL.replace(/\/$/, "")}/api/v1/me/quota`;
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
})();
