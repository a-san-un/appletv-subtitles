// v0.9.4
// 役割: content.js ↔ sidepanel.js の双方向メッセージ中継（タブ単位ルーティング）
//
// [v0.9.4 変更点]
// - panelPort 単一管理 → tabPorts Map に変更
//   タブIDをキーに { port, queue } を管理することで
//   複数タブで同時に拡張機能を使っても字幕が混線しない
// - sidepanel.js から PANEL_INIT { tabId } を受け取り、
//   そのポートをタブIDに紐づける
// - content.js からのメッセージは sender.tab.id でルーティング

// tabId → { port, queue: [] }
const tabPorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "subtitle-panel") return;

  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    // サイドパネルが自分のタブIDを名乗る
    if (msg.type === "PANEL_INIT") {
      boundTabId = msg.tabId;
      if (!tabPorts.has(boundTabId)) {
        tabPorts.set(boundTabId, { port, queue: [] });
      } else {
        tabPorts.get(boundTabId).port = port;
      }
      // キューに溜まっていたメッセージを送出
      const entry = tabPorts.get(boundTabId);
      while (entry.queue.length) port.postMessage(entry.queue.shift());
      return;
    }

    // sidepanel → content.js への SELECT_TRACK 中継
    if (msg.type === "SELECT_TRACK" && boundTabId) {
      chrome.tabs.sendMessage(boundTabId, msg);
    }
  });

  port.onDisconnect.addListener(() => {
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
  ].includes(msg.type)) return;

  const entry = tabPorts.get(tabId);
  if (entry) {
    entry.port.postMessage(msg);
  } else {
    // パネルがまだ開いていない場合はキューに保存
    tabPorts.set(tabId, { port: null, queue: [msg] });
    const q = tabPorts.get(tabId).queue;
    if (q.length > 10) q.shift();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("tv.apple.com")) {
    chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
