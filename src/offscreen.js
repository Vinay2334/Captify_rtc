// Audio capture + processing chain, ported 1:1 from the socket extension:
// tab stream -> getUserMedia -> AudioContext -> MediaStreamSource ->
// AudioWorkletNode("recorder-processor") -> 24 kHz Int16 PCM 200 ms chunks.
//
// Only the transport changed: the WebSocket is gone. Chunks are sent over a
// reliable, ordered RTCDataChannel on an RTCPeerConnection negotiated with
// the backend via HTTP signaling (see rtc-config.js SIGNAL_URL).

import { RTC_CONFIG } from "./rtc-config.js";
import { MicVAD } from "@ricky0123/vad-web";

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target === "offscreen") {
    switch (message.type) {
      case "start-recording":
        startRecording(message.data);
        break;
      case "stop-recording":
        stopRecording();
        break;
      default:
        throw new Error("Unrecognized message:", message.type);
    }
  }
});

let recorderNode;
let mediaStreamSource;
let audioContext;
let mediaStream;

let peerConnection = null;
let audioChannel = null;

// Chunks produced before the DataChannel opens are queued, then flushed on
// "open" (the socket build just dropped them with an error). Bounded so a
// failed negotiation can't grow memory without limit (~10 s at 200 ms/chunk).
let pendingChunks = [];
const MAX_PENDING_CHUNKS = 50;

let vad = null;
let speechActive = false;

const preRollChunks = [];
const PRE_ROLL_CHUNKS = 2;

const assetBase = chrome.runtime.getURL("vad-assets/");

let connectionPromise = null;

async function ensureConnection() {
  if (
    peerConnection?.connectionState === "connected" &&
    audioChannel?.readyState === "open"
  ) {
    return;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    await teardownPeerConnection();
    await setupPeerConnection();
  })();

  try {
    await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

async function startRecording(streamId) {
  if (recorderNode) {
    throw new Error("Called startRecording while recording is in progress.");
  }

  // Set up the peer connection FIRST, before any audio await, mirroring how
  // the socket build opened its WebSocket first so transport failures surf
  // even if getUserMedia/audio setup below throws.
  try {
    await ensureConnection();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    });
    mediaStream = stream;

    vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: assetBase,
      onnxWASMBasePath: assetBase,
      getStream: async () => stream,
      pauseStream: async () => {},
      async onSpeechStart() {
        speechActive = true;
        console.log("Speech detected");
        try {
          await ensureConnection();
          while (preRollChunks.length > 0) {
            sendChunk(preRollChunks.shift());
          }
        } catch (error) {
          console.error("Failed to reconnect on speech:", error);
        }
      },
      onSpeechEnd() {
        speechActive = false;
        console.log("Speech ended");
      },
    });

    vad.start();

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("recorder-processor.js");

    mediaStreamSource = audioContext.createMediaStreamSource(stream);
    recorderNode = new AudioWorkletNode(audioContext, "recorder-processor");

    recorderNode.port.onmessage = (event) => {
      // event.data already IS the transferred ArrayBuffer (see
      // recorder-processor.js flushChunk), so send it directly.
      const chunk = event.data;
      if (speechActive) {
        sendChunk(chunk);
        return;
      }

      // Retain recent audio in case speech is detected slightly late.
      preRollChunks.push(chunk);

      if (preRollChunks.length > PRE_ROLL_CHUNKS) {
        preRollChunks.shift();
      }
    };

    mediaStreamSource.connect(recorderNode);
    mediaStreamSource.connect(audioContext.destination);
    recorderNode.port.postMessage("start");

    window.location.hash = "recording";
    console.log("Windowlocation", window.location);
  } catch (e) {
    console.error("startRecording failed, tearing down peer connection:", e);
    await teardownPeerConnection();
    throw e;
  }
}

async function setupPeerConnection() {
  const iceServers = RTC_CONFIG.ICE_SERVERS || [];
  const label = RTC_CONFIG.DATA_CHANNEL_LABEL || "audio";
  peerConnection = new RTCPeerConnection({ iceServers });
  audioChannel = peerConnection.createDataChannel(label, { ordered: true });
  audioChannel.binaryType = "arraybuffer";
  audioChannel.bufferedAmountLowThreshold = 1024 * 1024;

  audioChannel.onopen = () => {
    console.log("Audio DataChannel is open now.");
    flushPendingChunks();
  };
  audioChannel.onclose = () => {
    audioChannel = null;
    console.log("Audio DataChannel is closed now.");
  };
  audioChannel.onerror = (error) => {
    console.error("DataChannel error observed:", error);
  };
  audioChannel.onmessage = (event) => {
    console.log("DataChannel message received:", event.data);
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(peerConnection);
  const answer = await exchangeOffer(peerConnection.localDescription);
  await peerConnection.setRemoteDescription(answer);
  console.log("WebRTC peer connection established.");
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, 5000);
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

async function exchangeOffer(localDescription) {
  const signalUrl = RTC_CONFIG.SIGNAL_URL;
  console.log(
    "Sending offer to signaling server:",
    signalUrl,
    localDescription,
  );
  const res = await fetch(signalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: localDescription.sdp,
      type: localDescription.type,
    }),
  });
  if (!res.ok) {
    throw new Error(`Signaling failed: ${res.status} ${res.statusText}`);
  }
  const answer = await res.json();
  console.log("Received answer from signaling server:", answer);
  return new RTCSessionDescription({
    sdp: answer.sdp,
    type: answer.type || "answer",
  });
}

function sendChunk(audioData) {
  if (audioChannel && audioChannel.readyState === "open") {
    if (pendingChunks.length) flushPendingChunks();
    audioChannel.send(audioData);
  } else if (audioChannel) {
    if (pendingChunks.length >= MAX_PENDING_CHUNKS) pendingChunks.shift();
    pendingChunks.push(audioData);
  } else {
    console.error("No audio DataChannel. State: no peer connection");
  }
}

function flushPendingChunks() {
  while (pendingChunks.length && audioChannel.readyState === "open") {
    audioChannel.send(pendingChunks.shift());
  }
}

async function stopRecording() {
  if (recorderNode) {
    recorderNode.port.postMessage("stop");
    // Let the worklet deliver its final flush chunk before disconnecting.
    await new Promise((r) => setTimeout(r, 100));
    recorderNode.disconnect();
    mediaStreamSource.disconnect();
    audioContext.close();
    recorderNode = null;
    mediaStreamSource = null;
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  // // Update current state in URL
  window.location.hash = "";

  if (vad) {
    await vad.pause();
    vad = null;
  }
  speechActive = false;
  preRollChunks.length = 0;

  await teardownPeerConnection();
  console.log("WebRTC peer connection closed on stop-recording.");
}

async function teardownPeerConnection() {
  if (audioChannel) {
    try {
      if (audioChannel.readyState === "open") {
        flushPendingChunks();
        await new Promise((r) => setTimeout(r, 200));
      } else if (pendingChunks.length) {
        console.warn(
          `Dropping ${pendingChunks.length} unsent audio chunks; DataChannel never opened.`,
        );
      }
      audioChannel.close();
    } catch (e) {
      console.error("Error closing DataChannel:", e);
    }
    audioChannel = null;
  }
  pendingChunks = [];

  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (e) {
      console.error("Error closing peer connection:", e);
    }
    peerConnection = null;
  }
}
