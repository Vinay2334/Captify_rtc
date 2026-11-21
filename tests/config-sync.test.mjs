// Single-source-of-truth guard for backend configuration.
//
// The canonical baked-in defaults live in src/remote-config.mjs
// (DEFAULT_CONFIG). The ESM callers (rtc-config.js, service-worker.js)
// import it directly; the classic overlay script
// (caption-overlay/lib/supabase-config.js) can't import ESM — content
// scripts must stay import-free — so it mirrors the values. These tests
// keep the mirror (and the ESM consumers) in sync with the module.
// Runs on plain node (node --test tests/); no chrome.* or DOM needed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  DEFAULT_CONFIG,
  DEV_FORCE_LOCAL_BACKEND,
  resolveBackendBaseUrl,
  resolveOverlayApiPrefix,
  resolveSignalUrl,
  resolveSiteUrl,
  resolveSupabaseAnonKey,
  resolveSupabaseUrl,
} from "../src/remote-config.mjs";

function loadClassicConfig({ cachedRemoteConfig } = {}) {
  const window = {};
  const stored = {};
  if (cachedRemoteConfig !== undefined) {
    stored.captifyRemoteConfig = cachedRemoteConfig;
  }
  const context = vm.createContext({
    window,
    structuredClone,
    console,
    URL,
    chrome: {
      storage: { local: { get: async (key) => ({ [key]: stored[key] ?? null }) } },
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("../src/caption-overlay/lib/supabase-config.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return window.CaptifyOverlay.captifyConfig;
}

test("derived defaults stay consistent with the base URL rule", () => {
  const remote = { backend_base_url: DEFAULT_CONFIG.backend_base_url };
  assert.equal(
    resolveSignalUrl(remote, "fallback"),
    DEFAULT_CONFIG.signal_url,
  );
  assert.equal(
    resolveOverlayApiPrefix(remote, "fallback"),
    DEFAULT_CONFIG.overlay_api_prefix,
  );
  assert.equal(resolveBackendBaseUrl(remote, "fallback"), DEFAULT_CONFIG.backend_base_url);
  assert.equal(resolveSiteUrl({ site_url: DEFAULT_CONFIG.site_url }, "fallback"), DEFAULT_CONFIG.site_url);
  assert.equal(
    resolveSupabaseUrl({ supabase_url: DEFAULT_CONFIG.supabase_url }, "fallback"),
    DEFAULT_CONFIG.supabase_url,
  );
  assert.equal(
    resolveSupabaseAnonKey({ supabase_anon_key: DEFAULT_CONFIG.supabase_anon_key }, "fallback"),
    DEFAULT_CONFIG.supabase_anon_key,
  );
});

test("classic overlay defaults mirror DEFAULT_CONFIG", () => {
  const cfg = loadClassicConfig();
  assert.equal(cfg.SUPABASE_URL, DEFAULT_CONFIG.supabase_url);
  assert.equal(cfg.SUPABASE_ANON_KEY, DEFAULT_CONFIG.supabase_anon_key);
  assert.equal(cfg.BACKEND_BASE_URL, DEFAULT_CONFIG.backend_base_url);
  assert.equal(cfg.SITE_URL, DEFAULT_CONFIG.site_url);
  assert.equal(cfg.DEV_FORCE_LOCAL_BACKEND, DEV_FORCE_LOCAL_BACKEND);
});

test("dev mode pins the localhost backend even with a cached remote doc", async () => {
  const hosted = {
    backend_base_url: "https://api.example.com",
    site_url: "https://example.com",
    supabase_url: "https://xyz.supabase.co",
    supabase_anon_key: "sb_publishable_test",
  };
  const cfg = loadClassicConfig({ cachedRemoteConfig: hosted });

  cfg.DEV_FORCE_LOCAL_BACKEND = true;
  assert.equal(await cfg.loadRemoteConfig(), false);
  assert.equal(cfg.BACKEND_BASE_URL, DEFAULT_CONFIG.backend_base_url);
  assert.equal(cfg.applyRemoteConfig(hosted), false);
  assert.equal(cfg.BACKEND_BASE_URL, DEFAULT_CONFIG.backend_base_url);

  cfg.DEV_FORCE_LOCAL_BACKEND = false;
  assert.equal(await cfg.loadRemoteConfig(), true);
  assert.equal(cfg.BACKEND_BASE_URL, hosted.backend_base_url);
  assert.equal(cfg.SITE_URL, hosted.site_url);
});

test("rtc-config.js takes transport defaults from DEFAULT_CONFIG", () => {
  const src = readFileSync(new URL("../src/rtc-config.js", import.meta.url), "utf8");
  assert.match(src, /from "\.\/remote-config\.mjs"/);
  assert.match(src, /SIGNAL_URL:\s*DEFAULT_CONFIG\.signal_url/);
  assert.match(src, /ICE_SERVERS:\s*\[\.\.\.DEFAULT_CONFIG\.ice_servers\]/);
  assert.match(src, /DATA_CHANNEL_LABEL:\s*DEFAULT_CONFIG\.data_channel_label/);
  assert.ok(!src.includes("http://127.0.0.1"), "no hardcoded backend URL left");
});

test("service-worker.js takes site/API defaults from DEFAULT_CONFIG", () => {
  const src = readFileSync(new URL("../src/service-worker.js", import.meta.url), "utf8");
  assert.ok(src.includes("DEFAULT_CONFIG"), "must import the shared defaults");
  assert.match(src, /const SITE_URL = DEFAULT_CONFIG\.site_url/);
  assert.match(src, /const OVERLAY_API_PREFIX = DEFAULT_CONFIG\.overlay_api_prefix/);
  assert.ok(!src.includes('"http://localhost:8080"'), "no hardcoded site URL left");
  assert.ok(!src.includes('"http://127.0.0.1:8000/api/"'), "no hardcoded API prefix left");
});
