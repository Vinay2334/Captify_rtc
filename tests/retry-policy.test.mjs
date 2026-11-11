// Focused coverage for the connect retry/error budget used by the overlay's
// "Waiting for subtitles" -> reconnecting -> error flow. Runs on plain node
// (node --test tests/); no chrome.* or DOM needed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_RETRY_DELAY_MS,
  CONNECT_WATCHDOG_MS,
  MAX_CONNECT_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  SIGNAL_TIMEOUT_MS,
  computeRetryDelay,
} from "../src/retry-policy.mjs";

test("retry budget surfaces an error quickly instead of buffering forever", () => {
  assert.ok(MAX_CONNECT_ATTEMPTS >= 2, "must actually retry before failing");
  assert.ok(
    MAX_CONNECT_ATTEMPTS <= 6,
    "must give up and show an error instead of retrying forever",
  );
  const totalWait =
    Array.from({ length: MAX_CONNECT_ATTEMPTS - 1 }, (_, i) =>
      computeRetryDelay(i + 1),
    ).reduce((a, b) => a + b, 0);
  assert.ok(
    totalWait <= 15000,
    `server-down must surface within ~15 s, got ${totalWait} ms of backoff`,
  );
});

test("backoff doubles per failed attempt and caps", () => {
  assert.equal(computeRetryDelay(1), BASE_RETRY_DELAY_MS);
  assert.equal(computeRetryDelay(2), BASE_RETRY_DELAY_MS * 2);
  assert.equal(computeRetryDelay(3), BASE_RETRY_DELAY_MS * 4);
  assert.ok(computeRetryDelay(10) <= MAX_RETRY_DELAY_MS);
  assert.equal(computeRetryDelay(100), MAX_RETRY_DELAY_MS);
});

test("invalid attempt numbers fall back to the base delay", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(computeRetryDelay(bad), BASE_RETRY_DELAY_MS);
  }
});

test("timeouts and watchdog stay consistent with the retry budget", () => {
  assert.ok(SIGNAL_TIMEOUT_MS > 0, "a hung backend must fail one attempt fast");
  assert.ok(
    CONNECT_WATCHDOG_MS >
      Array.from({ length: MAX_CONNECT_ATTEMPTS - 1 }, (_, i) =>
        computeRetryDelay(i + 1),
      ).reduce((a, b) => a + b, 0),
    "watchdog must outlast the auto-retry loop so it only fires when no " +
      "status arrived at all",
  );
});
