// Shared retry/backoff policy for the transcription transport.
//
// Pure module: no chrome.* or DOM APIs, so it can be unit-tested with plain
// node. Imported by offscreen.js (bundled by Vite); content-script.js is a
// classic script that cannot import ESM, so it hardcodes the watchdog value
// documented below (see CONNECT_WATCHDOG_MS).

// How many times a (re)connect sequence is attempted before the session
// reports a terminal error to the tab overlay.
export const MAX_CONNECT_ATTEMPTS = 4;

// Delay before the Nth retry (1-based): base * 2^(N-1), capped so a
// server-down at startup surfaces an error after ~7 s (1s + 2s + 4s) instead
// of spinning the overlay's "Waiting for subtitles" state forever.
export const BASE_RETRY_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 8000;

// Aborts one signaling round-trip (SDP offer/answer POST) so a hung backend
// fails fast into the retry loop instead of hanging a single attempt.
export const SIGNAL_TIMEOUT_MS = 8000;

// How long one attempt waits for the negotiated DataChannel to open before
// the attempt counts as failed. Signaling can succeed while the channel
// never opens, so without this the overlay would stick on "connecting".
export const CHANNEL_OPEN_TIMEOUT_MS = 10000;

// Content-script watchdog: a session that never reports "connected" (and
// delivers no caption) within this long is shown as an error with a Retry
// button, even if no explicit error arrived (e.g. a message was lost while
// the service worker restarted). Kept here so the value is documented next
// to the retry budget; content-script.js mirrors it as a literal.
export const CONNECT_WATCHDOG_MS = 20000;

// 1-based failed-attempt number -> ms to wait before the next attempt.
export function computeRetryDelay(failedAttempt) {
  if (!Number.isFinite(failedAttempt) || failedAttempt < 1) {
    return BASE_RETRY_DELAY_MS;
  }
  return Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * 2 ** (failedAttempt - 1),
  );
}
