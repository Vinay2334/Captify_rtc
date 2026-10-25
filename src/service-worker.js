let data = [];

// Tabs currently being captioned. Captions flow offscreen -> service worker
// -> that tab's content script, so each overlay lands on the page the user
// is watching rather than in the hidden offscreen document.
//
// NOTE: Chrome MV3 allows only ONE offscreen document per extension, so we
// keep a single shared offscreen.html that multiplexes one recording session
// per tab (keyed by tabId) instead of one document per tab.
const recordingTabs = new Set();

async function ensureCaptionScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content-script.js"],
    });
  } catch (e) {
    // Expected on chrome://, edge://, Chrome Web Store, etc. where content
    // scripts can't run; the declarative content_scripts entry covers
    // ordinary http(s) pages.
    console.warn("Caption script injection skipped:", e?.message || e);
  }
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.warn("Failed to forward caption to tab:", e?.message || e);
  }
}

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({});
  const offscreenDocument = existingContexts.find(
    (c) => c.contextType === "OFFSCREEN_DOCUMENT",
  );
  if (!offscreenDocument) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      // USER_MEDIA covers tabCapture/getUserMedia, WEB_RTC the
      // RTCPeerConnection/DataChannel, AUDIO_PLAYBACK the monitored tab
      // audio plumbed through the offscreen AudioContext. Declaring the
      // actual API usage keeps Chrome from reclaiming the document during
      // silent stretches with no detectable audio.
      reasons: ["USER_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
      justification:
        "Capture tab audio via tabCapture, run VAD on it, and stream it over a WebRTC DataChannel",
    });
  }
}

// Close the shared offscreen document only when no tab is recording.
// Per-tab teardown just stops that tab's session inside the document.
async function maybeCloseOffscreen() {
  if (recordingTabs.size > 0) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // Already closed (e.g. after a service-worker restart) — not an error.
    console.warn("offscreen close skipped:", e?.message || e);
  }
  chrome.action.setIcon({ path: "icons/not-recording.png" });
}

// Reconcile in-memory state after a service-worker restart: the offscreen
// document outlives us, so ask it which tabs are still recording.
async function reconcileRecordingTabs() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "get-recordings",
      target: "offscreen",
    });
    if (res && Array.isArray(res.tabIds)) {
      for (const tabId of res.tabIds) {
        try {
          await chrome.tabs.get(tabId);
          recordingTabs.add(tabId);
        } catch (e) {
          // Tab went away while the service worker was stopped: drop its
          // orphaned session so the document can close once truly idle.
          try {
            await chrome.runtime.sendMessage({
              type: "stop-recording",
              target: "offscreen",
              tabId,
            });
          } catch (stopError) {
            console.warn(
              "orphan stop failed:",
              stopError?.message || stopError,
            );
          }
        }
      }
    }
  } catch (e) {
    console.warn("get-recordings delivery failed:", e?.message || e);
    // No offscreen document yet — nothing to reconcile.
  }
}

async function stopTabRecording(tabId) {
  try {
    await chrome.runtime.sendMessage({
      type: "stop-recording",
      target: "offscreen",
      tabId,
    });
  } catch (e) {
    console.warn("stop-recording delivery failed:", e?.message || e);
  }
  await sendToTab(tabId, { type: "caption-teardown" });
  recordingTabs.delete(tabId);
  try {
    await chrome.action.setIcon({ path: "icons/not-recording.png", tabId });
  } catch (e) {
    // Tab may already be gone; the global icon reset in
    // maybeCloseOffscreen covers the last-session case.
  }
  await maybeCloseOffscreen();
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id == null) return;
  await reconcileRecordingTabs();
  // Toggle recording for the clicked tab only; other tabs keep recording.
  if (recordingTabs.has(tab.id)) {
    await stopTabRecording(tab.id);
    return;
  }

  await ensureOffscreen();

  // Get a MediaStream for the clicked tab.
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  recordingTabs.add(tab.id);
  await ensureCaptionScript(tab.id);

  // Send the stream ID to the offscreen document to start this tab's
  // session. The offscreen document may not have registered its onMessage
  // listener yet right after createDocument, in which case sendMessage
  // rejects and the message would be silently lost. Retry until it lands.
  const message = {
    type: "start-recording",
    target: "offscreen",
    tabId: tab.id,
    data: streamId,
  };
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await chrome.runtime.sendMessage(message);
        break;
      } catch (e) {
        if (attempt === 19) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } catch (e) {
    recordingTabs.delete(tab.id);
    await maybeCloseOffscreen();
    throw e;
  }

  chrome.action.setIcon({ path: "/icons/recording.png", tabId: tab.id });
});

// When a tab closes, stop only that tab's session. The shared offscreen
// document stays alive while other tabs are still recording and closes
// once the last session ends.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!recordingTabs.has(tabId)) return;
  console.log("tab closed, stopping recording for tab", tabId);
  await stopTabRecording(tabId);
});

// Re-inject the caption overlay if a recording tab navigates/reloads; the
// audio session in the offscreen document keeps running.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "complete" && recordingTabs.has(tabId)) {
    await ensureCaptionScript(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "caption-close") {
      // Close button clicked inside the tab's subtitle menu bar:
      // stop this tab's offscreen recording session and tear down offscreen.html
      // once no tabs remain recording.
      const tabId = message.tabId ?? sender?.tab?.id;
      await reconcileRecordingTabs();
      if (tabId != null) {
        await stopTabRecording(tabId);
      }
      sendResponse?.({ ok: true });
      return;
    }
    if (message.type === "caption-language") {
      // Dropdown picks from a tab's subtitle window. The content script has
      // no tabId of its own, so identify the tab from the message sender.
      const tabId = message.tabId ?? sender?.tab?.id;
      if (tabId != null) {
        try {
          await chrome.runtime.sendMessage({
            type: "caption-language",
            target: "offscreen",
            tabId,
            source: message.source,
            targetLang: message.target,
          });
        } catch (e) {
          console.warn("caption-language delivery failed:", e?.message || e);
        }
      }
      return;
    }
    if (message.type === "dowload-audio") {
      console.log("on message from offscreen");
      const url = message.url;
      chrome.downloads.download({
        url: url,
        filename: "recording.webm", // Specify the filename for the download
      });
    } else if (message.type === "caption" || message.type === "caption-clear") {
      // Live transcript from one tab's session in the offscreen document:
      // relay to that tab's caption overlay. Not awaited by the sender
      // (best-effort). Messages without a tabId (old offscreen builds) fall
      // back to broadcast for backwards compatibility.
      if (message.tabId != null) {
        await sendToTab(message.tabId, message);
      } else {
        for (const tabId of recordingTabs) {
          await sendToTab(tabId, message);
        }
      }
    } else if (message.type === "recording-ended") {
      // Legacy path: older offscreen builds sent this when a capture
      // track fired "ended". Current offscreen builds keep the session
      // open through silent stretches and never send it; only explicit
      // stops (action toggle -> stopTabRecording, tab removed) close
      // sessions and the document.
      if (message.tabId != null) {
        recordingTabs.delete(message.tabId);
        try {
          await chrome.action.setIcon({
            path: "icons/not-recording.png",
            tabId: message.tabId,
          });
        } catch (e) {
          // Tab may already be gone.
        }
        await maybeCloseOffscreen();
      }
      sendResponse?.({ ok: true });
    }
  })();
  // Keep the message channel open for the async work above when the sender
  // awaits a response (recording-ended); fire-and-forget messages ignore it.
  return true;
});
