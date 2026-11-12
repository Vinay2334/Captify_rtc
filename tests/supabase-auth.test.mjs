// Coverage for the fetch-based Supabase Auth client: email sign-in,
// session persistence across restarts, pre-expiry refresh, and logout.
// Classic scripts in a vm; no network (fetch stubbed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const USER = { id: "u-9", email: "grace@captify.local", user_metadata: { full_name: "Grace Hopper" } };

function loadAuth({ stored = {}, identity = null } = {}) {
  const calls = [];
  const window = {};
  const chromeStub = {
    storage: {
      local: {
        get: async (keys) => ({ [keys]: stored[keys] }),
        set: async (obj) => Object.assign(stored, obj),
        remove: async (key) => delete stored[key],
      },
    },
  };
  if (identity) chromeStub.identity = identity;
  const context = vm.createContext({
    window, structuredClone, console, chrome: chromeStub,
    fetch: async (url, opts = {}) => {
      calls.push(String(url));
      const u = String(url);
      const ok = (data) => ({ ok: true, status: 200, json: async () => data });
      if (u.includes("/signup")) {
        return ok({ access_token: "new-atk", refresh_token: "new-rtk", expires_in: 3600, user: USER });
      }
      if (u.includes("grant_type=password")) {
        return ok({ access_token: "atk", refresh_token: "rtk", expires_in: 3600, user: USER });
      }
      if (u.includes("grant_type=refresh_token")) {
        return ok({ access_token: "atk2", refresh_token: "rtk2", expires_in: 3600, user: USER });
      }
      if (u.includes("/auth/v1/user")) return ok(USER);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  for (const file of ["lib/supabase-config.js", "lib/supabase-auth.js"]) {
    vm.runInContext(readFileSync(new URL(`../src/caption-overlay/${file}`, import.meta.url), "utf8"), context);
  }
  return { auth: window.CaptifyOverlay.supabaseAuth, stored, calls };
}

test("email sign-in persists the session", async () => {
  const { auth, stored } = loadAuth();
  await auth.load();
  await auth.signInWithPassword("grace@captify.local", "pw");
  assert.equal((await auth.getAccessToken()), "atk");
  assert.equal(stored.captifySupabaseSession.access_token, "atk");
});

test("session restores across restarts and refreshes before expiry", async () => {
  const first = loadAuth();
  await first.auth.load();
  await first.auth.signInWithPassword("grace@captify.local", "pw");
  // Simulate a restart with a nearly-expired session.
  const second = loadAuth({
    stored: {
      captifySupabaseSession: {
        ...first.stored.captifySupabaseSession,
        expires_at: Date.now() + 1000,
      },
    },
  });
  await second.auth.load();
  assert.equal(await second.auth.getAccessToken(), "atk2");
  assert.ok(second.calls.some((u) => u.includes("grant_type=refresh_token")));
});

test("logout clears the persisted session", async () => {
  const { auth, stored } = loadAuth();
  await auth.load();
  await auth.signInWithPassword("grace@captify.local", "pw");
  await auth.signOut();
  assert.equal(auth.getSession(), null);
  assert.equal(stored.captifySupabaseSession, undefined);
  assert.equal(await auth.getAccessToken(), null);
});

test("google without an identity runtime fails clearly", async () => {
  const { auth } = loadAuth();
  await auth.load();
  await assert.rejects(auth.signInWithGoogle(), /Chromium extension runtime/);
});
