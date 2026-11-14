// Same-document re-injection must not duplicate the subtitle overlay.
//
// A recording tab gets the overlay scripts injected twice in the same
// document: once by the manifest `content_scripts` entry on navigation and
// once by the service worker's `chrome.scripting.executeScript` in
// `onUpdated`. Both runs must leave exactly one overlay host behind.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ORDER = [
  "caption-overlay/lib/constants.js",
  "caption-overlay/lib/state.js",
  "caption-overlay/lib/session.js",
  "caption-overlay/styles/overlay.css.js",
  "caption-overlay/components/dropdown.js",
  "caption-overlay/components/status-bar.js",
  "caption-overlay/components/subtitle-panel.js",
  "caption-overlay/components/captions.js",
  "caption-overlay/lib/icons.js",
  "caption-overlay/lib/supabase-config.js",
  "caption-overlay/lib/supabase-auth.js",
  "caption-overlay/lib/user-store.js",
  "caption-overlay/components/ui.js",
  "caption-overlay/styles/user-menu.css.js",
  "caption-overlay/components/user-menu.js",
  "caption-overlay/styles/sign-in-gate.css.js",
  "caption-overlay/components/sign-in-gate.js",
  "content-script.js",
];

function makeElement(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    ownerDocument: doc,
    className: "",
    id: "",
    style: {},
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    innerHTML: "",
    offsetWidth: 0,
    offsetHeight: 0,
    scrollHeight: 0,
    _attrs: {},
    _listeners: {},
    _classSet: new Set(),
    classList: null,
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return el._attrs[k] ?? null; },
    removeAttribute(k) { delete el._attrs[k]; },
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      el._listeners[type] = (el._listeners[type] || []).filter((f) => f !== fn);
    },
    dispatchEvent() { return true; },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) el.appendChild(n);
      return el;
    },
    replaceChildren() {
      for (const c of el.children) c.parentNode = null;
      el.children = [];
    },
    remove() {
      if (!el.parentNode) return;
      el.parentNode.children = el.parentNode.children.filter((c) => c !== el);
      el.parentNode = null;
    },
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentNode;
      }
      return false;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    },
    scrollTo() {},
    scrollIntoView() {},
    setPointerCapture() {},
    focus() {},
    attachShadow() {
      return {
        children: [],
        appendChild(c) { this.children.push(c); return c; },
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
      };
    },
  };
  el.classList = {
    add(...c) { c.forEach((x) => el._classSet.add(x)); },
    remove(...c) { c.forEach((x) => el._classSet.delete(x)); },
    toggle(c, force) {
      if (force === true) el._classSet.add(c);
      else if (force === false) el._classSet.delete(c);
      else if (el._classSet.has(c)) el._classSet.delete(c);
      else el._classSet.add(c);
      return el._classSet.has(c);
    },
    contains(c) { return el._classSet.has(c); },
  };
  return el;
}

function makeDocument() {
  const doc = {
    body: null,
    documentElement: null,
    createElement(tag) { return makeElement(tag, doc); },
    createElementNS(_ns, tag) { return makeElement(tag, doc); },
    getElementById(id) {
      const walk = (node) => {
        if (node.id === id) return node;
        for (const c of node.children || []) {
          const hit = walk(c);
          if (hit) return hit;
        }
        return null;
      };
      return walk(doc.documentElement);
    },
    __hostsById(id) {
      const out = [];
      const walk = (node) => {
        if (node.id === id) out.push(node);
        for (const c of node.children || []) walk(c);
      };
      walk(doc.documentElement);
      return out;
    },
  };
  doc.documentElement = makeElement("html", doc);
  doc.body = makeElement("body", doc);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function makeHarness() {
  const window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
  };
  const listeners = new Set();
  const chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({}),
      onMessage: {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); },
      },
    },
    storage: {
      local: {
        get(_keys, cb) {
          if (typeof cb === "function") cb({});
          return Promise.resolve({});
        },
        set: () => Promise.resolve({}),
        remove: () => Promise.resolve({}),
      },
      onChanged: { addListener() {} },
    },
  };
  const document = makeDocument();
  const context = vm.createContext({
    window,
    document,
    chrome,
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: () => Promise.reject(new Error("offline in test")),
  });
  const loadAll = () => {
    for (const file of ORDER) {
      vm.runInContext(
        readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
        context,
        { filename: file },
      );
    }
  };
  return {
    window,
    listeners,
    loadAll,
    hostCount: () => document.__hostsById(window.CaptifyOverlay.constants.CONTAINER_ID).length,
  };
}

test("re-injecting the overlay scripts in one document keeps a single overlay", () => {
  const h = makeHarness();
  // First injection (manifest content_scripts on navigation).
  h.loadAll();
  assert.equal(h.hostCount(), 1, "first injection creates one overlay host");

  // Second injection in the SAME document (service worker executeScript on
  // onUpdated complete): must not orphan the first host or reset state.
  h.loadAll();
  assert.ok(
    h.window.CaptifyOverlay.state.container,
    "overlay state still references the container after re-injection",
  );
  assert.equal(h.hostCount(), 1, "re-injection leaves exactly one overlay host");

  // A later reveal (caption-show after navigation) must reuse the host,
  // not append a second one.
  assert.equal(h.listeners.size, 1, "exactly one runtime listener stays registered");
  for (const fn of h.listeners) fn({ type: "caption-show" }, {}, () => {});
  assert.equal(h.hostCount(), 1, "caption-show reuses the single overlay host");
});

test("closing the overlay then reopening shows it again", async () => {
  const h = makeHarness();
  h.loadAll();
  const NS = h.window.CaptifyOverlay;

  // Close button path: teardown runs, then the fade-out timer clears refs.
  NS.closeAndTeardown(false);
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(h.window.__captifyCaptionInjected, false, "teardown allows re-injection");
  assert.equal(h.hostCount(), 0, "teardown removes the overlay host");

  // Reopen (extension icon click): fresh injection + caption-show reveal.
  h.loadAll();
  assert.equal(h.listeners.size, 1, "reopen registers one runtime listener");
  for (const fn of h.listeners) fn({ type: "caption-show" }, {}, () => {});
  assert.equal(h.hostCount(), 1, "reopen builds exactly one overlay host");
  assert.equal(
    NS.state.visible,
    true,
    "reopen reveals the overlay instead of staying closed",
  );
});
