// Coverage for the user menu's state store (classic script, loaded in a vm
// with a minimal window/chrome stub). Runs on plain node (node --test tests/).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadUserStore() {
  const sent = [];
  const stored = {};
  const window = {};
  const context = vm.createContext({
    window,
    structuredClone,
    console,
    chrome: {
      storage: {
        local: {
          get: (key, cb) => cb({ [key]: stored[key] }),
          set: (obj) => Object.assign(stored, obj),
        },
      },
      runtime: { sendMessage: (msg) => sent.push(msg) },
    },
  });
  for (const file of ["lib/icons.js", "lib/user-store.js"]) {
    vm.runInContext(readFileSync(new URL(`../src/caption-overlay/${file}`, import.meta.url), "utf8"), context);
  }
  return { store: window.CaptifyOverlay.userStore, icons: window.CaptifyOverlay.icons, sent };
}

test("hamburger icon and default guest state", () => {
  const { store, icons } = loadUserStore();
  assert.match(icons.menu, /<svg/);
  const s = store.getState();
  assert.equal(s.signedIn, false);
  assert.equal(s.user, null);
  assert.equal(s.plan.name, "Free");
  assert.equal(s.quota.limitMinutes, 100);
});

test("sign in/out updates plan/quota-facing state and notifies the worker", () => {
  const { store, sent } = loadUserStore();
  store.signIn();
  let s = store.getState();
  assert.equal(s.signedIn, true);
  assert.equal(s.user.email, "user@captify.local");
  assert.ok(s.quota.usedMinutes > 0 && s.quota.usedMinutes <= s.quota.limitMinutes);
  store.signOut();
  s = store.getState();
  assert.equal(s.signedIn, false);
  assert.equal(s.quota.usedMinutes, 0);
  assert.deepEqual(sent.map((m) => m.action), ["sign-in", "sign-out"]);
});

test("getState returns a copy callers cannot mutate", () => {
  const { store } = loadUserStore();
  store.getState().quota.usedMinutes = 999;
  assert.equal(store.getState().quota.usedMinutes, 0);
});
