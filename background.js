// v0.12.0
// 役割: content.js ↔ sidepanel.js の双方向メッセージ中継（タブ単位ルーティング）
//
// アーキテクチャ:
//   content.js  → runtime.sendMessage  → background.js
//   sidepanel.js ← port.postMessage   ← background.js
//
// タブIDをキーに tabPorts Map でポート管理。
// パネルが閉じている間に届いたメッセージはキューに蓄積し、
// 再オープン時（PANEL_INIT）に一括送出する。

function bgLog(msg) {
  const line = `[BG ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  for (const [, entry] of tabPorts) {
    if (entry.port) {
      try { entry.port.postMessage({ type: "DEBUG_LOG", line }); } catch (_) {}
    }
  }
}

// tabId → { port, queue }
// port: 現在接続中の sidepanel Port（閉じると null）
// queue: panel 未接続中に受信したメッセージのバックログ
const tabPorts = new Map();
const QUEUE_LIMIT = 50; // キュー上限（溢れたメッセージは破棄）

// --- sidepanel.js からの接続 ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "subtitle-panel") return;

  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === "PANEL_INIT") {
      // sidepanel が開いた（または再オープンした）タイミングで呼ばれる
      boundTabId = msg.tabId;
      if (!tabPorts.has(boundTabId)) {
        tabPorts.set(boundTabId, { port, queue: [] });
      } else {
        tabPorts.get(boundTabId).port = port;
      }
      bgLog(`PANEL_INIT tabId=${boundTabId}`);

      // パネル不在中に溜まったメッセージをまとめて送出する
      const entry = tabPorts.get(boundTabId);
      if (entry.queue.length > 0) {
        bgLog(`キュー送出 ${entry.queue.length} 件 tabId=${boundTabId}`);
        while (entry.queue.length) {
          try { port.postMessage(entry.queue.shift()); } catch (_) {}
        }
      }

      // content.js に PANEL_INIT を転送して状態再送を要求する
      // → content.js は TRACKS_LIST / TRACK_ATTACHED / READY を返す
      bgLog(`PANEL_INIT を content.js へ転送 tabId=${boundTabId}`);
      chrome.tabs.sendMessage(boundTabId, { type: "PANEL_INIT" }).catch(() => {});
      return;
    }

    // sidepanel → content.js へのトラック選択指示を転送する
    if (msg.type === "SELECT_TRACK" && boundTabId) {
      bgLog(`SELECT_TRACK slot=${msg.slot} trackIndex=${msg.trackIndex} → tabId=${boundTabId}`);
      chrome.tabs.sendMessage(boundTabId, msg).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    // パネルが閉じられた。port を null にしてキューモードへ移行する。
    bgLog(`port disconnected tabId=${boundTabId}`);
    if (boundTabId && tabPorts.has(boundTabId)) {
      tabPorts.get(boundTabId).port = null;
    }
  });
});

// --- content.js からのメッセージ受信 ---
// runtime.sendMessage で送られてくる字幕・トラック情報を
// 対応タブの sidepanel Port に転送する。
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // 処理対象メッセージ種別のみ受け付ける
  if (![
    "SUBTITLE_CUE",   // 字幕テキスト
    "TRACK_ATTACHED", // トラック割り当て完了通知
    "TRACKS_LIST",    // 有効トラック一覧
    "SETUP_REQUIRED", // （将来用）
    "READY",          // 初期化完了通知
  ].includes(msg.type)) return;

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
      // パネルが開いていれば直接送信する
      try { entry.port.postMessage(msg); } catch (_) {}
    } else {
      // パネルが閉じていればキューに積む
      if (entry.queue.length < QUEUE_LIMIT) entry.queue.push(msg);
      bgLog(`queued (${entry.queue.length}/${QUEUE_LIMIT}) tabId=${tabId}`);
    }
  } else {
    // 初回受信：エントリを新規作成してキューに積む
    bgLog(`new entry + queued tabId=${tabId}`);
    tabPorts.set(tabId, { port: null, queue: [msg] });
  }
});

// --- サイドパネルの有効化 ---
// Apple TV+ のページが読み込み完了したらサイドパネルを有効にする
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("tv.apple.com")) {
    bgLog(`tabs.onUpdated: enabling sidePanel for tabId=${tabId}`);
    chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  }
});

// 拡張機能アイコンクリックでサイドパネルを開く
chrome.action.onClicked.addListener((tab) => {
  bgLog(`action.onClicked tabId=${tab.id} url=${tab.url?.slice(0, 60)}`);
  chrome.sidePanel.open({ tabId: tab.id });
});
