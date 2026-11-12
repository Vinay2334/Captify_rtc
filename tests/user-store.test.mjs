// Coverage for the account store: guest defaults, Supabase-backed
// email/Google sign-in, quota (seconds) display math, live quota updates,
// and sign-out. Classic scripts loaded in a vm with window/chrome/fetch
// stubs; runs on plain node (node --test tests/).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SUPA_USER = {
  id: "user-1",
  email: "ada@captify.local",
  user_metadata: { full_name: "Ada Lovelace" },
};

function stubFetch(url, opts = {}) {
  const u = String(url);
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (u.includes("/token?grant_type=password")) {
    return Promise.resolve(
      ok({ access_token: "atk", refresh_token: "rtk", expires_in: 3600, user: SUPA_USER }),
    );
  }
  if (u.includes("/token?grant_type=refresh_token")) {
    return Promise.resolve(
      ok({ access_token: "atk2", refresh_token: "rtk2", expires_in: 3600, user: SUPA_USER }),
    );
  }
  if (u.includes("/auth/v1/user")) return Promise.resolve(ok(SUPA_USER));
  if (u.includes("/me/quota") && String(opts.headers?.Authorization || "").includes("Bearer")) {
    return Promise.resolve(
      ok({
        user_id: "user-1",
        email: "ada@captify.local",
        plan: "Free",
        used_seconds: 120,
        limit_seconds: 6000,
        remaining_seconds: 5880,
      }),
    );
  }
  return Promise.resolve({ ok: false, status: 401, json: async () => ({ msg: "nope" }) });
}

function loadUserStore({ withGoogle = false } = {}) {
  const sent = [];
  const stored = {};
  const window = {};
  const chromeStub = {
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: stored[key] }),
        set: (obj) => Object.assign(stored, obj),
        remove: (key) => delete stored[key],
      },
    },
    runtime: { sendMessage: (msg) => sent.push(msg) },
  };
  if (withGoogle) {
    chromeStub.identity = {
      getRedirectURL: () => "https://ext.chromiumapp.org/",
      launchWebAuthFlow: async () =>
        "https://ext.chromiumapp.org/#access_token=gatk&refresh_token=grtk&expires_in=3600",
    };
  }
  const context = vm.createContext({
    window,
    structuredClone,
    console,
    fetch: stubFetch,
    chrome: chromeStub,
  });
  for (const file of [
    "lib/icons.js",
    "lib/supabase-config.js",
    "lib/supabase-auth.js",
    "lib/user-store.js",
  ]) {
    vm.runInContext(readFileSync(new URL(`../src/caption-overlay/${file}`, import.meta.url), "utf8"), context);
  }
  return { store: window.CaptifyOverlay.userStore, sent, stored, chromeStub };
}

test("hamburger icon and default guest state", () => {
  const { store } = loadUserStore();
  const s = store.getState();
  assert.equal(s.signedIn, false);
  assert.equal(s.user, null);
  assert.equal(s.plan.name, "Free");
  assert.equal(s.quota.limitSeconds, 6000);
});

test("quota minutes derive from billed seconds", () => {
  const { store } = loadUserStore();
  const mins = store.quotaMinutes({
    quota: { usedSeconds: 150, limitSeconds: 6000, remainingSeconds: 5850 },
  });
  assert.equal(mins.usedMinutes, 2);
  assert.equal(mins.limitMinutes, 100);
  assert.equal(mins.remainingMinutes, 98);
});

test("email sign-in flips state, fetches quota, notifies the worker", async () => {
  const { store, sent } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  const s = store.getState();
  assert.equal(s.signedIn, true);
  assert.equal(s.user.email, "ada@captify.local");
  assert.equal(s.user.initials, "AL");
  assert.equal(s.quota.usedSeconds, 120);
  assert.equal(s.quota.remainingSeconds, 5880);
  assert.deepEqual(sent.map((m) => m.action), ["sign-in"]);
});

test("google sign-in works through the identity flow", async () => {
  const { store } = loadUserStore({ withGoogle: true });
  await store.load();
  await store.signInWithGoogle();
  const s = store.getState();
  assert.equal(s.signedIn, true);
  assert.equal(s.quota.limitSeconds, 6000);
});

test("applyQuota updates the menu numbers live", async () => {
  const { store } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  store.applyQuota({ used_seconds: 300, limit_seconds: 6000, remaining_seconds: 5700, plan: "Free" });
  const s = store.getState();
  assert.equal(s.quota.usedSeconds, 300);
  assert.equal(s.quota.remainingSeconds, 5700);
});

test("sign out clears profile and quota and notifies the worker", async () => {
  const { store, sent } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  await store.signOut();
  const s = store.getState();
  assert.equal(s.signedIn, false);
  assert.equal(s.user, null);
  assert.equal(s.quota.usedSeconds, 0);
  assert.deepEqual(sent.map((m) => m.action), ["sign-in", "sign-out"]);
});

test("getState returns a copy callers cannot mutate", () => {
  const { store } = loadUserStore();
  store.getState().quota.usedSeconds = 999;
  assert.equal(store.getState().quota.usedSeconds, 0);
});
