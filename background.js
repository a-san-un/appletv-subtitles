// v0.14.1
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

function bgLog(msg) {
  const line = `[BG ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  for (const [, entry] of tabPorts) {
    if (entry.port) {
      try { entry.port.postMessage({ type: "DEBUG_LOG", line }); } catch (e) {
        console.error(`[BG] bgLog postMessage失敗: ${e.message}`);
      }
    }
  }
}

// tabId → { port, queue, ctLogQueue }
// port:       現在接続中の sidepanel Port（閉じると null）
// queue:      panel 未接続中に受信した通常メッセージのバックログ
// ctLogQueue: panel 未接続中に受信した CT_LOG のバックログ（専用・独立管理）
const tabPorts = new Map();
const QUEUE_LIMIT = 50;         // 通常キュー上限（溢れたメッセージは破棄）
const CT_LOG_QUEUE_LIMIT = 20;  // CT_LOG 専用キュー上限

// --- sidepanel.js からの接続 ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "subtitle-panel") return;

  let boundTabId = null;

  port.onMessage.addListener((msg) => {
    if (msg.type === "PANEL_INIT") {
      // sidepanel が開いた（または再オープンした）タイミングで呼ばれる
      boundTabId = msg.tabId;
      if (!tabPorts.has(boundTabId)) {
        tabPorts.set(boundTabId, { port, queue: [], ctLogQueue: [] });
      } else {
        tabPorts.get(boundTabId).port = port;
      }

      const entry = tabPorts.get(boundTabId);
      bgLog(`PANEL_INIT tabId=${boundTabId} queueSize=${entry.queue.length} ctLogQueueSize=${entry.ctLogQueue.length}`);

      // CT_LOG 専用キューを先に送出する（時系列を保つため）
      if (entry.ctLogQueue.length > 0) {
        bgLog(`CT_LOG キュー送出 ${entry.ctLogQueue.length} 件 tabId=${boundTabId}`);
        while (entry.ctLogQueue.length) {
          try { port.postMessage(entry.ctLogQueue.shift()); } catch (e) {
            bgLog(`CT_LOG キュー送出失敗: ${e.message}`);
          }
        }
      }

      // 通常キューを送出する
      if (entry.queue.length > 0) {
        bgLog(`キュー送出 ${entry.queue.length} 件 tabId=${boundTabId}`);
        while (entry.queue.length) {
          try { port.postMessage(entry.queue.shift()); } catch (e) {
            bgLog(`キュー送出失敗: ${e.message}`);
          }
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

  // CT_LOG は専用キューで別管理する
  if (msg.type === "CT_LOG") {
    const entry = tabPorts.get(tabId);
    if (entry) {
      if (entry.port) {
        // ポートがある時は即転送（キューには積まない）
        try { entry.port.postMessage(msg); } catch (e) {
          bgLog(`CT_LOG postMessage失敗: ${e.message}`);
        }
      } else {
        // ポートがない時は専用キューに積む
        if (entry.ctLogQueue.length < CT_LOG_QUEUE_LIMIT) {
          entry.ctLogQueue.push(msg);
        }
        // 溢れた分は静かに破棄（ログ自体のログは出さない）
      }
    } else {
      // 初回受信：エントリを新規作成して専用キューに積む
      tabPorts.set(tabId, { port: null, queue: [], ctLogQueue: [msg] });
    }
    return;
  }

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
      try { entry.port.postMessage(msg); } catch (e) {
        bgLog(`postMessage失敗 type=${msg.type}: ${e.message}`);
      }
    } else {
      // パネルが閉じていればキューに積む
      if (entry.queue.length < QUEUE_LIMIT) {
        entry.queue.push(msg);
        bgLog(`queued type=${msg.type} (${entry.queue.length}/${QUEUE_LIMIT}) tabId=${tabId}`);
      } else {
        bgLog(`queue FULL 破棄 type=${msg.type} tabId=${tabId}`);
      }
    }
  } else {
    // 初回受信：エントリを新規作成してキューに積む
    bgLog(`new entry + queued type=${msg.type} tabId=${tabId}`);
    tabPorts.set(tabId, { port: null, queue: [msg], ctLogQueue: [] });
  }
});

// --- タブ閉じた時のクリーンアップ ---
// ★ Apple TV+ のタブが閉じられた際に tabPorts からエントリを削除する。
// これがないと長時間使用時に不要なキュー・ポート情報が湎積しメモリリークになる。
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabPorts.has(tabId)) {
    bgLog(`タブ閉鎖検知: tabId=${tabId} の tabPorts エントリを削除`);
    tabPorts.delete(tabId);
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
