// Focused coverage for the sign-in gate shown in the subtitle window:
// signed-out users see the message + Sign in button, signed-in users don't,
// and clicking the button flips the shared user store. Plain node + vm with
// a minimal DOM stub (no framework added).
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

function loadGate() {
  const window = {};
  const document = { createElement: (tag) => new FakeEl(tag) };
  const context = vm.createContext({
    window, document, structuredClone, console,
    chrome: {
      storage: { local: { get: (k, cb) => cb({}), set: () => {} } },
      runtime: { sendMessage: () => {} },
    },
  });
  const base = "../src/caption-overlay/";
  for (const file of ["lib/icons.js", "lib/user-store.js", "components/ui.js", "components/sign-in-gate.js"]) {
    vm.runInContext(readFileSync(new URL(base + file, import.meta.url), "utf8"), context);
  }
  return window.CaptifyOverlay;
}

test("signed-out: gate visible with message and Sign in button", () => {
  const NS = loadGate();
  const gate = NS.createSignInGate();
  assert.equal(gate.el.className, "captify-auth-gate");
  assert.equal(gate.el.hidden, false);
  assert.match(gate.el.textContent, /Sign in to use Captify/);
  const btn = gate.el.findAll((el) => el.tagName === "BUTTON")[0];
  assert.ok(btn, "gate must contain a button");
  assert.match(btn.textContent, /Sign in/);
  gate.destroy();
});

test("clicking Sign in signs in and hides the gate; sign-out shows it again", () => {
  const NS = loadGate();
  const gate = NS.createSignInGate();
  gate.el.findAll((el) => el.tagName === "BUTTON")[0].click();
  assert.equal(NS.userStore.getState().signedIn, true);
  assert.equal(gate.el.hidden, true);
  NS.userStore.signOut();
  assert.equal(gate.el.hidden, false);
  gate.destroy();
});
