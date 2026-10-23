# Captify Extension (WebRTC transport)

Port of the socket-based `Extension/` build. The audio **processing** chain is
unchanged; only the **transport** changed from WebSocket to WebRTC.

## Audio pipeline (ported 1:1)

1. `service-worker.js` — toolbar click toggles capture: `chrome.tabCapture.getMediaStreamId`
   for the active tab, then forwards the stream id to the offscreen document
   (with send-retry so the message can't be silently lost).
2. `offscreen.js` — `getUserMedia({ chromeMediaSource: 'tab', ... })` →
   `AudioContext` → `MediaStreamSource` → `AudioWorkletNode('recorder-processor')`.
   Local playback (`connect(audioContext.destination)`) is preserved so the
   user still hears the tab.
3. `recorder-processor.js` — resamples to **24 kHz Int16 mono**, buffers into
   **200 ms chunks (4800 samples)**, and posts each chunk as a transferable
   `ArrayBuffer`.
4. Transport — each `ArrayBuffer` is sent with `RTCDataChannel.send()` on a
   reliable, ordered channel instead of `WebSocket.send()`.

## What changed vs the socket build

| Area | Socket build | This build |
|---|---|---|
| Transport | `WebSocket` to `ws://127.0.0.1:8000/api/v1/transcription/ws` | `RTCDataChannel("audio")` (reliable + ordered) |
| Negotiation | None (direct WS) | SDP offer/answer via `POST` to `SIGNAL_URL` (non-trickle ICE) |
| Chunks before transport is ready | Dropped with an error | Queued (bounded, ~10 s), flushed on channel `open` |
| Resampling | Integer ratios only; other rates silently produced nothing | Linear-interpolation resampler; any source rate works, same 24 kHz Int16 200 ms output |
| Teardown | Closed socket | Flushes queue, closes channel + peer connection, stops tab tracks |

## Backend contract

The server must accept WebRTC instead of raw WebSocket audio:

- `POST <SIGNAL_URL>` with JSON `{ sdp, type: "offer" }`.
- Reply with JSON `{ sdp, type: "answer" }`.
- Read Int16 24 kHz mono PCM frames (4800 samples each) from the `"audio"`
  data channel. Server log lines that used to print WS binary messages now
  read from the data channel.

## Configuration

Edit [rtc-config.js](E:\Programming\Extension\Captify\Extension\extensionRTC\rtc-config.js):

- `SIGNAL_URL` — offer/answer endpoint (default
  `http://127.0.0.1:8000/api/v1/transcription/webrtc/offer`).
- `ICE_SERVERS` — add a TURN server if the backend is off-host.
- `DATA_CHANNEL_LABEL` — must match what the server expects (`"audio"`).

`manifest.json` already allows signaling via `connect-src` + `host_permissions`
for `http://127.0.0.1:8000/*`; widen both if the backend moves.

## Develop / build (Vite)

Source lives in `src/` (`offscreen.html`, `offscreen.js`,
`service-worker.js`, `rtc-config.js`, `recorder-processor.js`);
`manifest.json` and `icons/` stay at the repo root. Vite bundles the
`src/` entries in place into `dist/`.

- `npm run dev` — `vite build --watch`: rebuilds `dist/` on every save.
- `npm run build` — one-off production build into `dist/`.

`vite.config.mjs` bundles the offscreen page + service worker with
stable, hash-free filenames and copies `manifest.json`,
`recorder-processor.js` and `icons/` into `dist/` verbatim. `rtc-config.js`
is an ESM module imported by `offscreen.js`, so there is no more
separate `<script>` tag or `globalThis` load-order race.

## Load it

1. Run `npm run build` (or `npm run dev` and leave it watching).
2. Open `chrome://extensions`, enable Developer mode.
3. Load unpacked → select this folder's `dist/` directory (not the repo root).
4. Click the action icon on a sounding tab to start/stop streaming.
