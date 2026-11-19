// Session-expiry coverage: when the backend rejects the session, the
// client must drop its own token and fall back to the signed-out overlay
// (sign-in gate), instead of keeping a stale token and retrying forever.
// Classic scripts in a vm with window/chrome/fetch stubs; plain node.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SUPA_USER = {
  id: "user-1",
  email: "ada@captify.local",
  user_metadata: { first_name: "Ada", last_name: "Lovelace" },
};

// Relay traffic (captify-overlay-data) is internal: the stub records the
// worker-bound request in `sent`, but it is not a menu action.
const menuActions = (sent) =>
  sent.filter((m) => m && m.type === "captify-menu-action").map((m) => m.action);

function loadExpiredHarness({ quotaStatus = 200, userStatus = 200, refreshStatus = 200, shared } = {}) {
  const sent = [];
  const stored = shared || {};
  const listeners = [];
  const fire = (changes) => {
    for (const fn of [...listeners]) {
      try { fn(JSON.parse(JSON.stringify(changes)), "local"); } catch (e) { /* ignore */ }
    }
  };
  const window = {};
  const chromeStub = {
    storage: {
      local: {
        // Callback style (user-store load) and promise style (supabase-auth).
        get: (keys, cb) => {
          const res = Array.isArray(keys)
            ? Object.fromEntries(keys.map((k) => [k, stored[k]]))
            : { [keys]: stored[keys] };
          if (typeof cb === "function") { cb(res); return; }
          return Promise.resolve(res);
        },
        set: async (obj) => {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: stored[k], newValue: obj[k] };
          }
          Object.assign(stored, obj);
          fire(changes);
        },
        remove: async (key) => {
          const changes = { [key]: { oldValue: stored[key], newValue: undefined } };
          delete stored[key];
          fire(changes);
        },
      },
      // Fires listeners like chrome would, so a sign-in written by one
      // context (popup) syncs another context's (tab overlay) store.
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: { sendMessage: (msg) => sent.push(msg) },
  };
  const context = vm.createContext({
    window,
    structuredClone,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url, opts = {}) => {
      const u = String(url);
      const ok = (data) => ({ ok: true, status: 200, json: async () => data });
      const fail = (status) => ({ ok: false, status, json: async () => ({ msg: "expired" }) });
      if (u.includes("/token?grant_type=password")) {
        return ok({ access_token: "atk", refresh_token: "rtk", expires_in: 3600, user: SUPA_USER });
      }
      if (u.includes("/token?grant_type=refresh_token")) {
        if (refreshStatus !== 200) return fail(refreshStatus);
        return ok({ access_token: "atk2", refresh_token: "rtk2", expires_in: 3600, user: SUPA_USER });
      }
      if (u.includes("/auth/v1/user")) {
        if (userStatus !== 200) return fail(userStatus);
        return ok(SUPA_USER);
      }
      if (u.includes("/me/quota")) {
        if (quotaStatus !== 200) return fail(quotaStatus);
        return ok({
          user_id: "user-1",
          email: "ada@captify.local",
          plan: "Free",
          used_seconds: 120,
          limit_seconds: 6000,
          remaining_seconds: 5880,
        });
      }
      return fail(401);
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
  return {
    store: window.CaptifyOverlay.userStore,
    auth: window.CaptifyOverlay.supabaseAuth,
    sent,
    stored,
    // Write as another context (the sign-in popup) would: straight to
    // shared storage, delivered to this context via the storage event.
    writeExternal: async (obj) => { await chromeStub.storage.local.set(obj); },
  };
}

test("expired refresh clears the client token and signs the overlay out", async () => {
  const { store, stored, sent } = loadExpiredHarness({ refreshStatus: 401 });
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  assert.equal(store.getState().signedIn, true);

  // Age the session past its skew window so the next access refreshes,
  // and the backend rejects the refresh as expired.
  stored.captifySupabaseSession.expires_at = Date.now() - 1000;
  await assert.rejects(store.refreshQuota(), /Session expired/);

  assert.equal(stored.captifySupabaseSession, undefined);
  const s = store.getState();
  assert.equal(s.signedIn, false);
  assert.equal(s.user, null);
  assert.deepEqual(menuActions(sent), ["sign-in", "sign-out"]);
});

test("transient refresh failure keeps the session and stays signed in", async () => {
  const { store, stored, sent } = loadExpiredHarness({ refreshStatus: 500 });
  await store.load();
  await store.signInWithPassword("ada@captify.local", "secret");
  assert.equal(store.getState().signedIn, true);

  // Age the session so the next access refreshes; the backend hiccups
  // (500) instead of rejecting the grant. The stored token must survive
  // and the overlay must stay signed in.
  stored.captifySupabaseSession.expires_at = Date.now() - 1000;
  await store.refreshQuota();

  assert.ok(stored.captifySupabaseSession);
  assert.equal(store.getState().signedIn, true);
  assert.deepEqual(menuActions(sent), ["sign-in"]);
});

test("popup sign-in heals a stale overlay instead of signing it out", async () => {
  const tab = loadExpiredHarness();
  await tab.store.load();
  assert.equal(tab.store.getState().signedIn, false);
  // Let the initial restore settle: in production it always finishes long
  // before the user completes the popup sign-in; without this the test
  // would race restore against the external write.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tab.store.getState().signedIn, false);

  // Another context (the sign-in popup) signs in: session + user state
  // land in storage, and the tab learns signed-in state through its
  // storage listener while its in-memory auth is still empty.
  await tab.writeExternal({
    captifySupabaseSession: {
      access_token: "atk",
      refresh_token: "rtk",
      expires_at: Date.now() + 3600 * 1000,
      user: SUPA_USER,
    },
    captifyUserState: {
      signedIn: true,
      user: { id: "user-1", name: "Ada Lovelace", email: "ada@captify.local", initials: "AL" },
      quota: { usedSeconds: 0, limitSeconds: 6000, remainingSeconds: 6000 },
      plan: { name: "Free", priceLabel: "$0 / month", tagline: "For trying Captify" },
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(tab.store.getState().signedIn, true);

  // The hamburger menu's quota refresh must pick up the newly stored
  // session, not mistake the stale in-memory auth for an expiry.
  await tab.store.refreshQuota();
  assert.equal(tab.store.getState().signedIn, true);
  assert.equal(tab.store.getState().quota.usedSeconds, 120);
  assert.deepEqual(menuActions(tab.sent), []);
});

test("quota 401 signs out and drops the client token", async () => {
  const { store, stored, sent } = loadExpiredHarness({ quotaStatus: 401 });
  await store.load();
  // Quota fetch during sign-in already sees the expired backend session.
  await assert.rejects(store.signInWithPassword("ada@captify.local", "secret"), /Session expired/);
  assert.equal(stored.captifySupabaseSession, undefined);
  assert.equal(store.getState().signedIn, false);
  assert.deepEqual(menuActions(sent), ["sign-in", "sign-out"]);
});

test("restore with a dead session signs out instead of staying unlocked", async () => {
  const first = loadExpiredHarness();
  await first.store.load();
  await first.store.signInWithPassword("ada@captify.local", "secret");
  assert.equal(first.store.getState().signedIn, true);

  // Restart with a token the backend no longer honors: profile and quota
  // both answer 401, and the refresh is rejected too.
  const second = loadExpiredHarness({ quotaStatus: 401, userStatus: 401, refreshStatus: 401 });
  second.stored.captifySupabaseSession = {
    ...first.stored.captifySupabaseSession,
    expires_at: Date.now() - 1000,
  };
  second.stored.captifyUserState = { ...first.store.getState() };
  await second.store.load();
  // Storage restores + refresh rejection settle asynchronously.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(second.stored.captifySupabaseSession, undefined);
  assert.equal(second.store.getState().signedIn, false);
});
