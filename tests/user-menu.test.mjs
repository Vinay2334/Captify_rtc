// Upgrade button follows the live plan catalog: one step above current
// (Free -> Pro -> Studio), hidden on the top plan. Plain node + vm with a
// minimal DOM, mirroring sign-in-gate.test.mjs.
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

function stubFetch(url, opts = {}) {
  const u = String(url);
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (u.includes("/token?grant_type=")) {
    return Promise.resolve(
      ok({ access_token: "atk", refresh_token: "rtk", expires_in: 3600, user: SUPA_USER }),
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
  if (u.includes("/me/quota")) {
    return Promise.resolve(
      ok({ user_id: "user-1", email: "ada@captify.local", plan: "Free", used_seconds: 120, limit_seconds: 6000, remaining_seconds: 5880 }),
    );
  }
  return Promise.resolve({ ok: false, status: 401, json: async () => ({ msg: "no" }) });
}

function loadMenu() {
  const window = {};
  const document = { createElement: (tag) => new FakeEl(tag) };
  const sent = [];
  const context = vm.createContext({
    window, document, structuredClone, console, setTimeout, clearTimeout, fetch: stubFetch,
    chrome: {
      storage: { local: { get: (k, cb) => cb({}), set: () => {} } },
      runtime: { sendMessage: (msg) => { sent.push(msg); } },
    },
  });
  const base = "../src/caption-overlay/";
  for (const file of [
    "lib/icons.js", "lib/supabase-config.js", "lib/supabase-auth.js",
    "lib/user-store.js", "components/ui.js", "components/user-menu.js",
  ]) {
    vm.runInContext(readFileSync(new URL(base + file, import.meta.url), "utf8"), context);
  }
  return { NS: window.CaptifyOverlay, sent };
}

function buttonLabels(menu) {
  return menu.popup
    .findAll((el) => el.tagName === "BUTTON")
    .map((b) => b.textContent);
}

async function openMenuOnPlan(NS, plan) {
  await NS.userStore.signInWithPassword("ada@captify.local", "secret");
  await NS.userStore.refreshPlans();
  if (plan !== "Free") {
    NS.userStore.applyQuota({ used_seconds: 0, limit_seconds: 6000, remaining_seconds: 6000, plan });
  }
  const menu = NS.createUserMenu();
  menu.open();
  return menu;
}

test("Free sees Upgrade to Pro", async () => {
  const { NS } = loadMenu();
  const menu = await openMenuOnPlan(NS, "Free");
  assert.ok(menu.popup.classList.contains("is-open"));
  assert.deepEqual(buttonLabels(menu), ["Sign out", "Upgrade to Pro"]);
  menu.destroy();
});

test("Pro sees Upgrade to Studio (not Pro)", async () => {
  const { NS } = loadMenu();
  const menu = await openMenuOnPlan(NS, "Pro");
  assert.deepEqual(buttonLabels(menu), ["Sign out", "Upgrade to Studio"]);
  menu.destroy();
});

test("Studio (top plan) sees no upgrade button", async () => {
  const { NS } = loadMenu();
  const menu = await openMenuOnPlan(NS, "Studio");
  assert.deepEqual(buttonLabels(menu), ["Sign out"]);
  menu.destroy();
});

test("upgrade button opens pricing with the account attached", async () => {
  const { NS, sent } = loadMenu();
  const menu = await openMenuOnPlan(NS, "Pro");
  const upgrade = menu.popup.findAll(
    (el) => el.tagName === "BUTTON" && el.textContent === "Upgrade to Studio",
  );
  assert.equal(upgrade.length, 1);
  sent.length = 0;
  upgrade[0].click();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "upgrade");
  assert.ok(String(sent[0].url || "").includes("/pricing.html?"));
  menu.destroy();
});
