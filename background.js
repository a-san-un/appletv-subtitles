// v0.16.0
// 役割: content.js ↔ sidepanel.js の双方向メッセージ中継（タブ単位ルーティング）
//
// アーキテクチャ:
//   content.js  → runtime.sendMessage  → background.js
//   sidepanel.js ← port.postMessage   ← background.js
//
// タブIDをキーに tabPorts Map でポート管理。
// パネルが閉じている間に届いたメッセージはキューに蓄積し、
// 再オープン時（PANEL_INIT）に一括送出する。
//
// v0.13.4 変更:
//   - CT_LOG 専用キュー（上限 CT_LOG_QUEUE_LIMIT 件）を追加。
//     ポートがある時は即転送、ない時は専用キューに積み再オープン時に送出する。
//     通常キュー（SUBTITLE_CUE 等）とは独立して管理する。
//   - キューに積む際に msg.type をログ出力するよう変更。
//   - port.postMessage 失敗時に catch で e.message をログ出力するよう変更。
//
// v0.14.1 変更:
//   - chrome.tabs.onRemoved を追加。タブが閉じられた際に tabPorts から
//     該当エントリを削除しメモリリークを防止する。
//
// v0.14.7 変更:
//   - postMessage 失敗時にポートを null にセットするよう修正
//     理由: sidepanel を閉じる際に onDisconnect より先に postMessage が
//     失敗するケースがあり、その後も entry.port がゾンビ状態のまま残り
//     「Attempting to use a disconnected port object」が連続発生していた。
//     失敗を検知した時点で entry.port = null にしてキューモードへ移行する。
//     対象箇所: bgLog / CT_LOG 即時転送 / 通常メッセージ即時転送 の計3箇所。
//
// v0.16.0 変更:
//   - SHOWING_TRACK_CHANGED / SHOWING_TRACK_NONE を中継対象に追加
//   - 未使用の SETUP_REQUIRED を削除

function bgLog(msg) {
  const line = `[BG ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  for (const [tabId, entry] of tabPorts) {
    if (entry.port) {
      try { entry.port.postMessage({ type: "DEBUG_LOG", line }); } catch (e) {
        console.warn(`[BG] bgLog postMessage失敗 tabId=${tabId}: ${e.message}`);
        entry.port = null;
      }
    }
  }
}

const tabPorts = new Map();
const QUEUE_LIMIT = 50;
const CT_LOG_QUEUE_LIMIT = 20;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "subtitle-panel") return;

  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === "PANEL_INIT") {
      boundTabId = msg.tabId;
      if (!tabPorts.has(boundTabId)) {
        tabPorts.set(boundTabId, { port, queue: [], ctLogQueue: [] });
      } else {
        tabPorts.get(boundTabId).port = port;
      }

      const entry = tabPorts.get(boundTabId);
      bgLog(`PANEL_INIT tabId=${boundTabId} queueSize=${entry.queue.length} ctLogQueueSize=${entry.ctLogQueue.length}`);

      if (entry.ctLogQueue.length > 0) {
        bgLog(`CT_LOG キュー送出 ${entry.ctLogQueue.length} 件 tabId=${boundTabId}`);
        while (entry.ctLogQueue.length) {
          try { port.postMessage(entry.ctLogQueue.shift()); } catch (e) {
            bgLog(`CT_LOG キュー送出失敗: ${e.message}`);
          }
        }
      }

      if (entry.queue.length > 0) {
        bgLog(`キュー送出 ${entry.queue.length} 件 tabId=${boundTabId}`);
        while (entry.queue.length) {
          try { port.postMessage(entry.queue.shift()); } catch (e) {
            bgLog(`キュー送出失敗: ${e.message}`);
          }
        }
      }

      bgLog(`PANEL_INIT を content.js へ転送 tabId=${boundTabId}`);
      chrome.tabs.sendMessage(boundTabId, { type: "PANEL_INIT" }).catch(() => {});
      return;
    }

    if (msg.type === "SELECT_TRACK" && boundTabId) {
      bgLog(`SELECT_TRACK slot=${msg.slot} trackIndex=${msg.trackIndex} → tabId=${boundTabId}`);
      chrome.tabs.sendMessage(boundTabId, msg).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    bgLog(`port disconnected tabId=${boundTabId}`);
    if (boundTabId && tabPorts.has(boundTabId)) {
      tabPorts.get(boundTabId).port = null;
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (msg.type === "CT_LOG") {
    const entry = tabPorts.get(tabId);
    if (entry) {
      if (entry.port) {
        try { entry.port.postMessage(msg); } catch (e) {
          bgLog(`CT_LOG postMessage失敗: ${e.message}`);
          entry.port = null;
          if (entry.ctLogQueue.length < CT_LOG_QUEUE_LIMIT) {
            entry.ctLogQueue.push(msg);
          }
        }
      } else {
        if (entry.ctLogQueue.length < CT_LOG_QUEUE_LIMIT) {
          entry.ctLogQueue.push(msg);
        }
      }
    } else {
      tabPorts.set(tabId, { port: null, queue: [], ctLogQueue: [msg] });
    }
    return;
  }

  if (![
    "SUBTITLE_CUE",
    "TRACK_ATTACHED",
    "TRACKS_LIST",
    "READY",
    "SHOWING_TRACK_CHANGED",
    "SHOWING_TRACK_NONE",
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
      try { entry.port.postMessage(msg); } catch (e) {
        bgLog(`postMessage失敗 type=${msg.type}: ${e.message}`);
        entry.port = null;
        if (entry.queue.length < QUEUE_LIMIT) {
          entry.queue.push(msg);
          bgLog(`queued (失敗後) type=${msg.type} (${entry.queue.length}/${QUEUE_LIMIT}) tabId=${tabId}`);
        }
      }
    } else {
      if (entry.queue.length < QUEUE_LIMIT) {
        entry.queue.push(msg);
        bgLog(`queued type=${msg.type} (${entry.queue.length}/${QUEUE_LIMIT}) tabId=${tabId}`);
      } else {
        bgLog(`queue FULL 破棄 type=${msg.type} tabId=${tabId}`);
      }
    }
  } else {
    bgLog(`new entry + queued type=${msg.type} tabId=${tabId}`);
    tabPorts.set(tabId, { port: null, queue: [msg], ctLogQueue: [] });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabPorts.has(tabId)) {
    bgLog(`タブ閉鎖検知: tabId=${tabId} の tabPorts エントリを削除`);
    tabPorts.delete(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("tv.apple.com")) {
    bgLog(`tabs.onUpdated: enabling sidePanel for tabId=${tabId}`);
    chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
  }
});

chrome.action.onClicked.addListener((tab) => {
  bgLog(`action.onClicked tabId=${tab.id} url=${tab.url?.slice(0, 60)}`);
  chrome.sidePanel.open({ tabId: tab.id });
});
