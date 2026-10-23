// WebRTC signaling + transport settings for the extensionRTC build.
// The audio *processing* chain is unchanged from the socket extension
// (tab capture -> AudioContext -> AudioWorklet downsample to 24 kHz Int16,
// 200 ms chunks). Only the transport changed: WebSocket.send was replaced
// by RTCDataChannel.send over the RTCPeerConnection below.

export const RTC_CONFIG = {
  // Backend endpoint that exchanges an SDP offer for an SDP answer.
  // Request:  POST { sdp: string, type: "offer" } as JSON.
  // Response: { sdp: string, type: "answer" } as JSON.
  // Non-trickle ICE is used, so the offer already contains all candidates.
  SIGNAL_URL: "http://127.0.0.1:8000/api/v1/transcription/webrtc/offer",

  // STUN/TURN servers for the RTCPeerConnection. Add a TURN entry here if
  // the backend is not on the same host/NAT as the browser.
  ICE_SERVERS: [],
  // ICE_SERVERS: [{ urls: "stun:stun.l.google.com:19302" }],

  // Reliable + ordered channel, matching the old WebSocket/TCP semantics.
  DATA_CHANNEL_LABEL: "audio",

  // Must match recorder-processor.js: 24000 Hz, 200 ms => 4800 samples.
  TARGET_SAMPLE_RATE: 24000,
  CHUNK_MS: 200,
};

// Also expose on globalThis for console debugging from the offscreen
// document; the bundled code uses the ESM export above, not this global.
globalThis.RTC_CONFIG = RTC_CONFIG;
