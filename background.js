// v0.9.5
// 役割: content.js ↔ sidepanel.js の双方向メッセージ中継（タブ単位ルーティング）

function bgLog(msg) {
  const line = `[BG ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  // Service Worker 内のログを全ポートにブロードキャスト
  for (const [, entry] of tabPorts) {
    if (entry.port) {
      try { entry.port.postMessage({ type: "DEBUG_LOG", line }); } catch (_) {}
    }
  }
}

// tabId → { port, queue: [] }
const tabPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "subtitle-panel") return;

  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === "PANEL_INIT") {
      boundTabId = msg.tabId;
      if (!tabPorts.has(boundTabId)) {
        tabPorts.set(boundTabId, { port, queue: [] });
      } else {
        tabPorts.get(boundTabId).port = port;
      }
      bgLog(`PANEL_INIT tabId=${boundTabId}`);
      // キューに溜まっていたメッセージを送出
      const entry = tabPorts.get(boundTabId);
      while (entry.queue.length) port.postMessage(entry.queue.shift());
      return;
    }

    // sidepanel → content.js への SELECT_TRACK 中継
    if (msg.type === "SELECT_TRACK" && boundTabId) {
      bgLog(`SELECT_TRACK slot=${msg.slot} trackIndex=${msg.trackIndex} → tabId=${boundTabId}`);
      chrome.tabs.sendMessage(boundTabId, msg);
    }
  });

  port.onDisconnect.addListener(() => {
    bgLog(`port disconnected tabId=${boundTabId}`);
    if (boundTabId) tabPorts.delete(boundTabId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (![
    "SUBTITLE_CUE",
    "TRACK_ATTACHED",
    "TRACKS_LIST",
    "SETUP_REQUIRED",
    "READY",
  ].includes(msg.type)) return;

  if (msg.type === "SUBTITLE_CUE") {
    bgLog(`SUBTITLE_CUE slot=${msg.slot} lang=${msg.lang} tabId=${tabId}`);
  } else {
    bgLog(`${msg.type} tabId=${tabId}`);
  }

  const entry = tabPorts.get(tabId);
  if (entry) {
    if (entry.port) {
      entry.port.postMessage(msg);
    } else {
      bgLog(`port not yet bound for tabId=${tabId}, queuing`);
      entry.queue.push(msg);
    }
  } else {
    bgLog(`no entry for tabId=${tabId}, creating queue`);
    tabPorts.set(tabId, { port: null, queue: [msg] });
    const q = tabPorts.get(tabId).queue;
    if (q.length > 10) q.shift();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("tv.apple.com")) {
    bgLog(`tabs.onUpdated: enabling sidePanel for tabId=${tabId}`);
    chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  bgLog(`action.onClicked tabId=${tab.id} url=${tab.url?.slice(0, 60)}`);
  chrome.sidePanel.open({ tabId: tab.id });
});
