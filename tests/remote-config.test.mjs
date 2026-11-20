// Coverage for the over-the-air config: shape validation (data only, never
// logic) and the network -> cache -> packaged-fallback load order. Runs on
// plain node (node --test tests/); no chrome.* or DOM needed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEV_FORCE_LOCAL_BACKEND,
  REMOTE_CONFIG_URL,
  loadRemoteConfig,
  resolveOverlayApiPrefix,
  resolveSignalUrl,
  resolveSiteUrl,
  validateRemoteConfig,
} from "../src/remote-config.mjs";

const GOOD = {
  version: 1,
  backend_base_url: "https://api.example.com",
  signal_url: "https://api.example.com/api/v1/transcription/webrtc/offer",
  overlay_api_prefix: "https://api.example.com/api/",
  site_url: "https://example.com",
  supabase_url: "https://xyz.supabase.co",
  supabase_anon_key: "sb_publishable_test",
  ice_servers: [{ urls: "stun:stun.l.google.com:19302" }],
  data_channel_label: "audio",
};

function fakeStorage(seed) {
  const data = { ...(seed || {}) };
  return {
    data,
    local: {
      get: async (key) => ({ [key]: data[key] ?? null }),
      set: async (obj) => Object.assign(data, obj),
    },
  };
}

test("points at the hosted workers.dev document", () => {
  assert.equal(
    REMOTE_CONFIG_URL,
    "https://floral-dust-d2f5.vinaybhardwaj2334.workers.dev/extension-config.json",
  );
});

test("accepts a well-formed document and drops unknown fields", () => {
  const out = validateRemoteConfig({ ...GOOD, eval: "alert(1)", logic: {} });
  assert.equal(out.backend_base_url, GOOD.backend_base_url);
  assert.equal(out.signal_url, GOOD.signal_url);
  assert.ok(!("eval" in out), "code-like fields must not survive validation");
  assert.ok(!("logic" in out));
});

test("rejects non-https backends but keeps http loopback for dev", () => {
  assert.equal(
    validateRemoteConfig({ backend_base_url: "http://evil.example.com" }),
    null,
  );
  assert.equal(
    validateRemoteConfig({ backend_base_url: "ftp://api.example.com" }),
    null,
  );
  const loopback = validateRemoteConfig({
    backend_base_url: "http://127.0.0.1:8000",
  });
  assert.equal(loopback.backend_base_url, "http://127.0.0.1:8000");
});

test("rejects hostile input without throwing", () => {
  for (const bad of [null, undefined, 42, "https://x", [], "arrays"]) {
    assert.equal(validateRemoteConfig(bad), null);
  }
  assert.equal(validateRemoteConfig({ data_channel_label: "a;b" }), null);
  assert.equal(
    validateRemoteConfig({ ice_servers: [{ urls: 42 }] }),
    null,
    "malformed ice entries invalidate the document",
  );
});

test("derives signal and prefix URLs from the base when explicit ones are absent", () => {
  const remote = validateRemoteConfig({
    backend_base_url: "https://api.example.com",
  });
  assert.equal(
    resolveSignalUrl(remote, "http://127.0.0.1:8000/api/v1/transcription/webrtc/offer"),
    "https://api.example.com/api/v1/transcription/webrtc/offer",
  );
  assert.equal(
    resolveOverlayApiPrefix(remote, "http://127.0.0.1:8000/api/"),
    "https://api.example.com/api/",
  );
  assert.equal(resolveSiteUrl(null, "http://localhost:8080"), "http://localhost:8080");
});

test("network success is cached and returned", async () => {
  const storage = fakeStorage();
  const out = await loadRemoteConfig({
    fetchImpl: async () => ({ ok: true, json: async () => GOOD }),
    storage,
    getUrl: () => null,
    refresh: true,
  });
  assert.equal(out.backend_base_url, GOOD.backend_base_url);
  assert.equal(
    storage.data.captifyRemoteConfig.backend_base_url,
    GOOD.backend_base_url,
  );
});

test("network failure falls back to the storage cache", async () => {
  const storage = fakeStorage({ captifyRemoteConfig: GOOD });
  const out = await loadRemoteConfig({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    storage,
    getUrl: () => {
      throw new Error("must not reach the bundled copy when cached");
    },
    refresh: true,
  });
  assert.equal(out.backend_base_url, GOOD.backend_base_url);
});

test("empty cache falls back to the packaged copy", async () => {
  const out = await loadRemoteConfig({
    fetchImpl: async (url) => {
      assert.match(String(url), /extension-config\.json$/);
      return { ok: true, json: async () => GOOD };
    },
    storage: fakeStorage(),
    getUrl: (path) => `chrome-extension://id/${path}`,
  });
  assert.equal(out.backend_base_url, GOOD.backend_base_url);
});

test("local-dev switch ships off so production uses the hosted config", () => {
  assert.equal(
    DEV_FORCE_LOCAL_BACKEND,
    false,
    "flip DEV_FORCE_LOCAL_BACKEND back to false before publishing",
  );
});

test("an invalid hosted document falls back to the cache, not defaults", async () => {
  const storage = fakeStorage({ captifyRemoteConfig: GOOD });
  const out = await loadRemoteConfig({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ backend_base_url: "http://evil.example.com" }),
    }),
    storage,
    getUrl: () => {
      throw new Error("valid cache must win over the bundled copy");
    },
    refresh: true,
  });
  assert.equal(out.backend_base_url, GOOD.backend_base_url);
});
