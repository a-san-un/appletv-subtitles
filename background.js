// v0.8.0
// 役割: content.js ↔ sidepanel.js の双方向メッセージ中継

let panelPort = null;
let contentTabId = null;
const queue = [];

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "subtitle-panel") return;
  panelPort = port;
  while (queue.length) panelPort.postMessage(queue.shift());

  // sidepanel から Port 経由で来る SELECT_TRACK を中継
  port.onMessage.addListener((msg) => {
    if (msg.type === "SELECT_TRACK" && contentTabId) {
      chrome.tabs.sendMessage(contentTabId, msg);
    }
  });

  port.onDisconnect.addListener(() => {
    panelPort = null;
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  // content.js → sidepanel への転送
  if (
    [
      "SUBTITLE_CUE",
      "TRACK_ATTACHED",
      "TRACKS_LIST",
      "SETUP_REQUIRED",
    ].includes(msg.type)
  ) {
    if (sender.tab) contentTabId = sender.tab.id;
    if (panelPort) {
      panelPort.postMessage(msg);
    } else {
      queue.push(msg);
      if (queue.length > 10) queue.shift();
    }
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
