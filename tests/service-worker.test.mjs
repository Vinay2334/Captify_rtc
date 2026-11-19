// Relay for overlay backend reads (quota display, plan catalog): the
// content script must not fetch loopback itself (page-origin PNA/LNA
// block), so the worker fetches with host permissions. Plain node + vm.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Values cross the vm realm boundary (different Object prototype), so
// compare their JSON shape, not object identity.
const norm = (v) => JSON.parse(JSON.stringify(v));

function loadWorker(fetchImpl) {
  const runtimeListeners = [];
  const fetched = [];
  const chromeStub = {
    runtime: { onMessage: { addListener: (fn) => runtimeListeners.push(fn) } },
    action: { onClicked: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };
  const context = vm.createContext({
    structuredClone,
    console,
    fetch: async (url, opts) => {
      fetched.push({ url: String(url), headers: opts?.headers || {} });
      return fetchImpl(url, opts);
    },
    chrome: chromeStub,
  });
  vm.runInContext(
    readFileSync(new URL("../src/service-worker.js", import.meta.url), "utf8"),
    context,
  );
  // The relay listener is registered before the catch-all overlay listener.
  assert.equal(runtimeListeners.length, 2);
  return { relay: runtimeListeners[0], fetched };
}

function request(relay, msg) {
  return new Promise((resolve) => {
    const keptOpen = relay(msg, { tab: { id: 7 } }, (res) => resolve(res));
    assert.equal(keptOpen, true); // async reply needs an open channel
  });
}

const QUOTA_SNAP = {
  user_id: "user-1", email: "ada@captify.local", plan: "Pro",
  used_seconds: 600, limit_seconds: 60000, remaining_seconds: 59400,
};
const okJson = (data) => Promise.resolve({ ok: true, status: 200, json: async () => data });

test("relays quota with the overlay's auth header", async () => {
  const { relay, fetched } = loadWorker(async (url) => {
    assert.ok(String(url).includes("/me/quota"));
    return okJson(QUOTA_SNAP);
  });
  const res = await request(relay, {
    type: "captify-overlay-data",
    url: "http://127.0.0.1:8000/api/v1/me/quota",
    headers: { Authorization: "Bearer probe-token" },
  });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "http://127.0.0.1:8000/api/v1/me/quota");
  assert.deepEqual(norm(fetched[0].headers), { Authorization: "Bearer probe-token" });
  assert.deepEqual(norm(res), { ok: true, status: 200, body: QUOTA_SNAP });
});

test("relays the plan catalog", async () => {
  const plans = { plans: [{ id: "free", name: "Free", display_order: 0 }] };
  const { relay, fetched } = loadWorker(async () => okJson(plans));
  const res = await request(relay, {
    type: "captify-overlay-data",
    url: "http://127.0.0.1:8000/api/v1/plans",
    headers: {},
  });
  assert.equal(fetched.length, 1);
  assert.deepEqual(norm(res), { ok: true, status: 200, body: plans });
});

test("blocks non-backend URLs without fetching", async () => {
  const { relay, fetched } = loadWorker(async () => okJson({}));
  const res = await request(relay, {
    type: "captify-overlay-data",
    url: "https://evil.example/collect",
    headers: {},
  });
  assert.equal(fetched.length, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "blocked_url");
});

test("backend down resolves unreachable instead of hanging", async () => {
  const { relay, fetched } = loadWorker(async () => { throw new TypeError("fetch failed"); });
  const res = await request(relay, {
    type: "captify-overlay-data",
    url: "http://127.0.0.1:8000/api/v1/plans",
    headers: {},
  });
  assert.equal(fetched.length, 1);
  assert.equal(norm(res).ok, false);
  assert.equal(norm(res).status, 0);
  assert.equal(norm(res).reason, "backend_unreachable");
});

test("other message types fall through to the catch-all listener", async () => {
  const { relay } = loadWorker(async () => okJson({}));
  let responded = false;
  const keptOpen = relay({ type: "open-signin", tabId: 7 }, { tab: { id: 7 } }, () => { responded = true; });
  assert.equal(keptOpen, false);
  assert.equal(responded, false);
});
