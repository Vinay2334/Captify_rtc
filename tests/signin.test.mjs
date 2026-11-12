// Coverage for the standalone sign-in page: email + Google + signup
// flows flip the shared store, report the originating tab to the worker,
// and close the window. Classic scripts in a vm with stub DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeEl {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._text = "";
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  click() { this.fire("click", { stopPropagation() {} }); }
}

const SUPA_USER = {
  id: "user-1", email: "ada@captify.local",
  user_metadata: { full_name: "Ada Lovelace" },
};

function loadPage({ search = "?tabId=7", signupNeedsConfirm = false } = {}) {
  const els = {};
  for (const [tag, id] of [
    ["form", "signin-form"], ["input", "signin-email"], ["input", "signin-password"],
    ["button", "signin-submit"], ["button", "signin-google"], ["button", "signin-signup"],
    ["p", "signin-error"], ["div", "signin-signedin"], ["p", "signin-welcome"],
    ["button", "signin-continue"], ["button", "signin-close"],
  ]) {
    els[id] = new FakeEl(tag, id);
  }
  els["signin-error"].hidden = true;
  const sent = [];
  const stored = {};
  let closed = false;
  const context = vm.createContext({
    structuredClone, console,
    location: { search },
    window: { close: () => { closed = true; } },
    document: {
      readyState: "complete",
      getElementById: (id) => els[id] || null,
      addEventListener: () => {},
    },
    fetch: async (url) => {
      const u = String(url);
      const ok = (data) => ({ ok: true, status: 200, json: async () => data });
      if (u.includes("/signup")) {
        return signupNeedsConfirm
          ? ok({ user: SUPA_USER })
          : ok({ access_token: "a", refresh_token: "r", expires_in: 3600, user: SUPA_USER });
      }
      if (u.includes("/token?grant_type=")) {
        return ok({ access_token: "a", refresh_token: "r", expires_in: 3600, user: SUPA_USER });
      }
      if (u.includes("/auth/v1/user")) return ok(SUPA_USER);
      if (u.includes("/me/quota")) {
        return ok({ user_id: "u1", plan: "Free", used_seconds: 0, limit_seconds: 6000, remaining_seconds: 6000 });
      }
      return ok({});
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => ({ [keys]: stored[keys] }),
          set: async (obj) => Object.assign(stored, obj),
          remove: async (key) => delete stored[key],
        },
      },
      runtime: { sendMessage: (msg) => { sent.push(msg); } },
      identity: {
        getRedirectURL: () => "https://ext.chromiumapp.org/",
        launchWebAuthFlow: async () =>
          "https://ext.chromiumapp.org/#access_token=g&expires_in=3600",
      },
    },
  });
  for (const file of [
    "lib/icons.js", "lib/supabase-config.js", "lib/supabase-auth.js",
    "lib/user-store.js", "signin.js",
  ]) {
    const base = file === "signin.js" ? "../src/" : "../src/caption-overlay/";
    vm.runInContext(readFileSync(new URL(base + file, import.meta.url), "utf8"), context);
  }
  return {
    NS: context.window?.CaptifyOverlay ?? vm.runInContext("window.CaptifyOverlay", context),
    els, sent, closed: () => closed,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Messages cross the vm realm boundary (different Object prototype), so
// compare their JSON shape, not object identity.
const norm = (v) => JSON.parse(JSON.stringify(v));

test("email sign-in reports the tab and closes the window", async () => {
  const { NS, els, sent, closed } = loadPage();
  els["signin-email"].value = "ada@captify.local";
  els["signin-password"].value = "secret";
  els["signin-form"].fire("submit", { preventDefault() {} });
  await sleep(20);
  assert.equal(NS.userStore.getState().signedIn, true);
  assert.deepEqual(norm(sent), [{ type: "captify-menu-action", action: "sign-in", tabId: 7 }]);
  assert.equal(closed(), true);
});

test("google sign-in reports the tab and closes the window", async () => {
  const { NS, els, sent, closed } = loadPage({ search: "?tabId=12" });
  els["signin-google"].click();
  await sleep(20);
  assert.equal(NS.userStore.getState().signedIn, true);
  assert.deepEqual(norm(sent), [{ type: "captify-menu-action", action: "sign-in", tabId: 12 }]);
  assert.equal(closed(), true);
});

test("signup without confirmation signs in; with confirmation it waits", async () => {
  const direct = loadPage();
  direct.els["signin-email"].value = "ada@captify.local";
  direct.els["signin-password"].value = "secret";
  direct.els["signin-signup"].click();
  await sleep(20);
  assert.equal(direct.NS.userStore.getState().signedIn, true);
  assert.equal(direct.closed(), true);

  const confirm = loadPage({ signupNeedsConfirm: true });
  confirm.els["signin-email"].value = "ada@captify.local";
  confirm.els["signin-password"].value = "secret";
  confirm.els["signin-signup"].click();
  await sleep(20);
  assert.equal(confirm.NS.userStore.getState().signedIn, false);
  assert.equal(confirm.closed(), false);
  assert.match(confirm.els["signin-error"].textContent, /inbox/);
});

test("signed-in state shows continue; invalid tab id sends null", async () => {
  const { NS, els, sent } = loadPage({ search: "?tabId=abc" });
  assert.equal(NS.signinTabIdFromQuery({ search: "?tabId=abc" }), null);
  assert.equal(NS.signinTabIdFromQuery({ search: "" }), null);
  els["signin-email"].value = "ada@captify.local";
  els["signin-password"].value = "secret";
  els["signin-form"].fire("submit", { preventDefault() {} });
  await sleep(20);
  assert.equal(els["signin-signedin"].hidden, false);
  assert.equal(els["signin-form"].hidden, true);
  assert.match(els["signin-welcome"].textContent, /ada@captify.local/);
  assert.deepEqual(norm(sent), [{ type: "captify-menu-action", action: "sign-in", tabId: null }]);
});
