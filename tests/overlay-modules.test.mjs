// Guards the content-script split: every caption-overlay classic script must
// load (manifest order) and register its window.CaptifyOverlay surface.
// Runs on plain node (node --test tests/); no chrome.* or DOM needed because
// no module touches them at load time.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ORDER = [
  "lib/constants.js",
  "lib/state.js",
  "lib/session.js",
  "styles/overlay.css.js",
  "components/dropdown.js",
  "components/status-bar.js",
  "components/subtitle-panel.js",
  "components/captions.js",
  "lib/icons.js",
  "lib/user-store.js",
  "components/ui.js",
  "styles/user-menu.css.js",
  "components/user-menu.js",
  "styles/sign-in-gate.css.js",
  "components/sign-in-gate.js",
];

function loadAll() {
  const window = {};
  const context = vm.createContext({ window, structuredClone, console });
  for (const file of ORDER) {
    vm.runInContext(
      readFileSync(new URL(`../src/caption-overlay/${file}`, import.meta.url), "utf8"),
      context,
      { filename: file },
    );
  }
  return window.CaptifyOverlay;
}

test("split modules register the full overlay surface in load order", () => {
  const NS = loadAll();
  for (const key of ["constants", "state", "userStore", "ui", "icons"]) {
    assert.ok(NS[key], `${key} must be registered`);
  }
  for (const fn of [
    "isSignedIn", "applyAuthState", "updateTargetVisibility", "sendConfig",
    "sendPauseState", "updateStatusUI", "clearWatchdog", "armWatchdog",
    "handleConnectionStatus", "requestRetry", "setPaused", "revealForRecording",
    "createStyles", "createStatusBar", "makeDropdown", "closeAndTeardown",
    "ensureOverlay", "scrollToBottom", "trimLines", "show",
    "createUserMenu", "createSignInGate",
  ]) {
    assert.equal(typeof NS[fn], "function", `${fn} must be registered`);
  }
  assert.equal(NS.constants.MAX_LINES, 2);
  assert.ok(NS.constants.CONNECT_WATCHDOG_MS > 0);
  assert.equal(NS.state.visible, false);
  assert.equal(NS.state.buffering, true);
});
