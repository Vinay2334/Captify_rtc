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
  if (u.includes("/api/v1/plans")) {
    return Promise.resolve(
      ok({
        plans: [
          { id: "studio", name: "Studio", price_label: "$29 / month", tagline: "For teams", price_monthly_usd: 29, display_order: 2, is_featured: false },
          { id: "pro", name: "Pro", price_label: "$12 / month", tagline: "For daily viewers", price_monthly_usd: 12, display_order: 1, is_featured: true },
          { id: "free", name: "Free", price_label: "$0 / month", tagline: "For trying Captify", price_monthly_usd: 0, display_order: 0, is_featured: false },
        ],
      }),
    );
  }
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

// Values cross the vm realm boundary (different Object prototype), so
// compare their JSON shape, not object identity.
const norm = (v) => JSON.parse(JSON.stringify(v));

const WORKER_PLANS = [
  { id: "free", name: "Free", price_label: "$0 / month", tagline: "For trying Captify", price_monthly_usd: 0, display_order: 0, is_featured: false },
  { id: "pro", name: "Pro", price_label: "$12 / month", tagline: "For daily viewers", price_monthly_usd: 12, display_order: 1, is_featured: true },
  { id: "studio", name: "Studio", price_label: "$29 / month", tagline: "For teams", price_monthly_usd: 29, display_order: 2, is_featured: false },
];

function loadUserStore({ withGoogle = false, withWorker = false, workerQuotaStatus = 200 } = {}) {
  const sent = [];
  const stored = {};
  const window = {};
  // Direct page-context fetches (what the worker relay replaces): recorded
  // so relay-path tests can prove the overlay never touches the backend.
  const directCalls = [];
  const chromeStub = {
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: stored[key] }),
        set: (obj) => Object.assign(stored, obj),
        remove: (key) => delete stored[key],
      },
    },
    runtime: withWorker
      ? { sendMessage: async (msg) => {
          sent.push(msg);
          if (!msg || msg.type !== "captify-overlay-data") return undefined;
          const u = String(msg.url || "");
          if (u.includes("/api/v1/plans")) {
            return { ok: true, status: 200, body: { plans: WORKER_PLANS } };
          }
          if (u.includes("/me/quota")) {
            if (workerQuotaStatus !== 200) {
              return { ok: false, status: workerQuotaStatus, body: { msg: "expired" } };
            }
            return {
              ok: true, status: 200,
              body: { user_id: "user-1", email: "ada@captify.local", plan: "Pro", used_seconds: 600, limit_seconds: 60000, remaining_seconds: 59400 },
            };
          }
          return { ok: false, status: 404, body: null };
        } }
      : { sendMessage: (msg) => sent.push(msg) },
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
    setTimeout,
    clearTimeout,
    fetch: (url, opts) => {
      directCalls.push(String(url));
      return stubFetch(url, opts);
    },
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
  return { store: window.CaptifyOverlay.userStore, sent, stored, chromeStub, directCalls };
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
  // Relay traffic (captify-overlay-data) is internal: the worker contract
  // is asserted by the relay tests, not here.
  const actions = sent.filter((m) => m && m.type === "captify-menu-action").map((m) => m.action);
  assert.deepEqual(actions, ["sign-in"]);
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
  const actions = sent.filter((m) => m && m.type === "captify-menu-action").map((m) => m.action);
  assert.deepEqual(actions, ["sign-in", "sign-out"]);
});

test("getState returns a copy callers cannot mutate", () => {
  const { store } = loadUserStore();
  store.getState().quota.usedSeconds = 999;
  assert.equal(store.getState().quota.usedSeconds, 0);
});

test("upgrade target is one step above current in catalog order", async () => {
  const { store } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  await store.refreshPlans();
  assert.deepEqual(norm(store.getUpgradeTarget("Free")), { name: "Pro" });
  assert.deepEqual(norm(store.getUpgradeTarget()), { name: "Pro" });
  store.applyQuota({ used_seconds: 120, limit_seconds: 60000, remaining_seconds: 59880, plan: "Pro" });
  assert.deepEqual(norm(store.getUpgradeTarget()), { name: "Studio" });
  store.applyQuota({ used_seconds: 120, limit_seconds: 240000, remaining_seconds: 239880, plan: "Studio" });
  assert.equal(store.getUpgradeTarget(), null);
});

test("plan change after catalog load re-enriches without refetch", async () => {
  const { store } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  await store.refreshPlans();
  assert.equal(store.getState().plan.priceLabel, "$0 / month");
  store.applyQuota({ used_seconds: 120, limit_seconds: 60000, remaining_seconds: 59880, plan: "Pro" });
  assert.equal(store.getState().plan.priceLabel, "$12 / month");
  assert.equal(store.getState().plan.tagline, "For daily viewers");
  store.applyQuota({ used_seconds: 120, limit_seconds: 240000, remaining_seconds: 239880, plan: "Studio" });
  assert.equal(store.getState().plan.priceLabel, "$29 / month");
  assert.deepEqual(norm(store.getUpgradeTarget()), null);
});

test("unknown current plan offers the cheapest paid plan", async () => {
  const { store } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  await store.refreshPlans();
  store.applyQuota({ used_seconds: 0, limit_seconds: 6000, remaining_seconds: 6000, plan: "Custom" });
  assert.deepEqual(norm(store.getUpgradeTarget()), { name: "Pro" });
});

test("catalog enriches the displayed price and tagline", async () => {
  const { store } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  store.applyQuota({ used_seconds: 120, limit_seconds: 60000, remaining_seconds: 59880, plan: "Pro" });
  assert.equal(store.getState().plan.priceLabel, "$0 / month");
  await store.refreshPlans();
  assert.equal(store.getState().plan.priceLabel, "$12 / month");
  assert.equal(store.getState().plan.tagline, "For daily viewers");
});

test("quota and plans load through the worker relay (no direct fetch)", async () => {
  const { store, directCalls } = loadUserStore({ withWorker: true });
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  await store.refreshPlans();
  // Page-context fetches never touch the backend API: only the IdP did.
  assert.ok(directCalls.every((u) => !u.includes("/me/quota") && !u.includes("/api/v1/plans")));
  const s = store.getState();
  assert.equal(s.signedIn, true);
  assert.equal(s.plan.name, "Pro");
  assert.equal(s.plan.priceLabel, "$12 / month");
  assert.deepEqual(norm(store.getUpgradeTarget()), { name: "Studio" });
});

test("relay 401 signs out like a direct 401", async () => {
  const { store } = loadUserStore({ withWorker: true, workerQuotaStatus: 401 });
  await store.load();
  await assert.rejects(store.signInWithPassword("ada@captify.local", "secret"));
  assert.equal(store.getState().signedIn, false);
});

test("no catalog yet keeps the legacy Pro fallback", () => {
  const { store } = loadUserStore();
  assert.equal(store.getUpgradeTarget("Free").name, "Pro");
  assert.equal(store.getUpgradeTarget("Pro"), null);
});

test("upgrade opens pricing with the account attached", async () => {
  const { store, sent } = loadUserStore();
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  sent.length = 0;
  store.upgrade();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "upgrade");
  const url = String(sent[0].url || "");
  assert.ok(url.includes("/pricing.html?"));
  assert.ok(url.includes("from=extension"));
  assert.ok(url.includes("user_id=user-1"));
  assert.ok(url.includes("email=" + encodeURIComponent("ada@captify.local")));
});
