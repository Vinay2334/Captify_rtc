// The overlay must inject on demand, never on page load: opening a page
// must not load Captify. Plain node (node --test tests/).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("no content_scripts auto-inject: overlay loads only on activation", () => {
  assert.ok(
    !("content_scripts" in manifest),
    "manifest must not declare content_scripts: injection happens " +
    "through the service worker's executeScript after user activation",
  );
});

test("on-demand injection keeps its permissions and worker entry", () => {
  assert.ok(
    (manifest.permissions || []).includes("scripting"),
    "scripting is required for executeScript injection",
  );
  assert.ok(
    (manifest.permissions || []).includes("activeTab"),
    "the activation click grants activeTab covering the injection",
  );
  assert.equal(manifest.background?.service_worker, "service-worker.js");
});
