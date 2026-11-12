// The gate is an opener now: it explains the block and asks the service
// worker to open the standalone sign-in page. Plain node + vm, minimal DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this._text = "";
    this.classList = {
      add: (...cs) => { this.className = [...this.className.split(" "), ...cs].filter(Boolean).join(" "); },
      toggle: (c, on) => { this.classList[on ? "add" : "remove"]?.(c); },
      remove: (...cs) => { this.className = this.className.split(" ").filter((x) => x && !cs.includes(x)).join(" "); },
      contains: (c) => this.className.split(" ").includes(c),
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html || ""; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() {
    for (const fn of this.listeners.click || []) fn({ stopPropagation() {} });
  }
  findAll(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this.children) c.findAll?.(pred, out);
    return out;
  }
}

const SUPA_USER = {
  id: "user-1", email: "ada@captify.local",
  user_metadata: { full_name: "Ada Lovelace" },
};

function stubFetch(url) {
  const u = String(url);
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (u.includes("/token?grant_type=")) {
    return Promise.resolve(
      ok({ access_token: "atk", refresh_token: "rtk", expires_in: 3600, user: SUPA_USER }),
    );
  }
  if (u.includes("/me/quota")) {
    return Promise.resolve(
      ok({ user_id: "u1", plan: "Free", used_seconds: 0, limit_seconds: 6000, remaining_seconds: 6000 }),
    );
  }
  return Promise.resolve({ ok: false, status: 401, json: async () => ({ msg: "no" }) });
}

// Messages cross the vm realm boundary (different Object prototype), so
// compare their JSON shape, not object identity.
const norm = (v) => JSON.parse(JSON.stringify(v));

function loadGate() {
  const window = {};
  const document = { createElement: (tag) => new FakeEl(tag) };
  const sent = [];
  const context = vm.createContext({
    window, document, structuredClone, console, fetch: stubFetch,
    chrome: {
      storage: { local: { get: (k, cb) => cb({}), set: () => {} } },
      runtime: { sendMessage: (msg) => { sent.push(msg); } },
    },
  });
  const base = "../src/caption-overlay/";
  for (const file of [
    "lib/icons.js", "lib/supabase-config.js", "lib/supabase-auth.js",
    "lib/user-store.js", "components/ui.js", "components/sign-in-gate.js",
  ]) {
    vm.runInContext(readFileSync(new URL(base + file, import.meta.url), "utf8"), context);
  }
  return { NS: window.CaptifyOverlay, sent };
}

test("signed-out: gate explains the block with one Sign in button", () => {
  const { NS } = loadGate();
  const gate = NS.createSignInGate();
  assert.equal(gate.el.className, "captify-auth-gate");
  assert.equal(gate.el.hidden, false);
  assert.match(gate.el.textContent, /Sign in to use Captify/);
  assert.match(gate.el.textContent, /sign-in page/);
  // No cramped inputs in the overlay: exactly one button.
  assert.equal(gate.el.findAll((el) => el.tagName === "INPUT").length, 0);
  assert.equal(gate.el.findAll((el) => el.tagName === "BUTTON").length, 1);
  gate.destroy();
});

test("Sign in asks the worker to open the page (no form in the overlay)", () => {
  const { NS, sent } = loadGate();
  const gate = NS.createSignInGate();
  gate.el.findAll((el) => el.tagName === "BUTTON")[0].click();
  assert.deepEqual(norm(sent), [{ type: "open-signin" }]);
  gate.destroy();
});

test("gate hides once the shared store signs in (login happened in the popup)", async () => {
  const { NS } = loadGate();
  const gate = NS.createSignInGate();
  assert.equal(gate.el.hidden, false);
  await NS.userStore.signInWithPassword("ada@captify.local", "secret");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(NS.userStore.getState().signedIn, true);
  assert.equal(gate.el.hidden, true);
  gate.destroy();
});
