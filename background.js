// v0.10.0
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

// tabId → { port: MessagePort|null, queue: Array }
const tabPorts = new Map();

const QUEUE_LIMIT = 50; // キュー上限（TRACKS_LIST 大量発生に備えて余裕を持たせる）

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
      // キューに溜まっていたメッセージを即送出
      const entry = tabPorts.get(boundTabId);
      if (entry.queue.length > 0) {
        bgLog(`キュー送出 ${entry.queue.length} 件 tabId=${boundTabId}`);
        while (entry.queue.length) {
          try { port.postMessage(entry.queue.shift()); } catch (_) {}
        }
      }
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

  // TRACKS_LIST は件数のみ簡潔にログ（デバウンス後は1回なのでそのまま記録）
  if (msg.type === "SUBTITLE_CUE") {
    bgLog(`SUBTITLE_CUE slot=${msg.slot} lang=${msg.lang} tabId=${tabId}`);
  } else if (msg.type === "TRACKS_LIST") {
    bgLog(`TRACKS_LIST count=${msg.tracks?.length} tabId=${tabId}`);
  } else {
    bgLog(`${msg.type} tabId=${tabId}`);
  }

  const entry = tabPorts.get(tabId);
  if (entry) {
    if (entry.port) {
      try { entry.port.postMessage(msg); } catch (_) {}
    } else {
      // Port 未確立（Panel が PANEL_INIT をまだ送っていない）→ キューへ
      if (entry.queue.length < QUEUE_LIMIT) {
        entry.queue.push(msg);
      }
      bgLog(`queued (${entry.queue.length}/${QUEUE_LIMIT}) tabId=${tabId}`);
    }
  } else {
    // tabPorts エントリ自体がない → 初回受信、エントリ作成してキューへ
    bgLog(`new entry + queued tabId=${tabId}`);
    tabPorts.set(tabId, { port: null, queue: [msg] });
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
