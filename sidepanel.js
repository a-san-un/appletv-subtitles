// v0.15.0
// 役割: サイドパネルの UI 制御・メッセージ受信・履歴表示
//
// 処理:
//   - 起動時に background.js へ Port 接続し PANEL_INIT を送信する
//   - TRACKS_LIST 受信でスロットBのセレクトボックスを自動生成する
//   - SHOWING_TRACK_CHANGED 受信でスロットAの表示言語を更新する
//   - SHOWING_TRACK_NONE 受信でスロットAに「字幕をONにしてください」を表示する
//   - SUBTITLE_CUE 受信で字幕テキストを表示し、ペアマッチングして履歴に追加する
//   - ペアマッチング: A と B の ts 差が PAIR_MATCH_MS 以内ならペア化、
//     超過した場合は PAIR_TIMEOUT_MS 後に単独追加する

const port = chrome.runtime.connect({ name: "subtitle-panel" });
port.onMessage.addListener((msg) => handleMessage(msg));

port.onDisconnect.addListener(() => {
  panelLog("バックグラウンドとの接続が切断されました");
  setStatus("waiting", "接続が切れました。ページをリロードしてください");
  if (selectB) selectB.disabled = true;
});

const logLines = [];
const debugLogEl = document.getElementById("debug-log");

function panelLog(msg) {
  const line = `[Panel ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendDebugLine(line);
}

function appendDebugLine(line) {
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  const div = document.createElement("div");
  div.textContent = line;
  debugLogEl.appendChild(div);
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  panelLog(`PANEL_INIT 送信: tabId=${tabId}`);
  if (tabId) port.postMessage({ type: "PANEL_INIT", tabId });
});

const debugToggle = document.getElementById("debug-toggle");
const debugBody = document.getElementById("debug-body");
debugToggle.addEventListener("click", () => {
  const open = debugBody.classList.toggle("open");
  debugToggle.textContent = (open ? "▼" : "▶") + " DEBUG LOG";
});

document.getElementById("btn-debug-copy").addEventListener("click", () => {
  navigator.clipboard.writeText(logLines.join("\n"));
});

document.getElementById("btn-debug-save").addEventListener("click", () => {
  const blob = new Blob([logLines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `subtitle-debug-${new Date().toISOString().replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("btn-debug-clear").addEventListener("click", () => {
  logLines.length = 0;
  debugLogEl.innerHTML = "";
});

let currentTracks = [];
let frozen = false;
const pendingAttached = { A: null, B: null };

const PAIR_TIMEOUT_MS = 500;
const PAIR_MATCH_MS  = 300;
const pairBuffer = {};

const textA   = document.getElementById("en-text");
const textB   = document.getElementById("ja-text");
const statusA = document.getElementById("status-a");
const historyEl = document.getElementById("history-list");
const selectB   = document.getElementById("select-b");

const statusTextEl = document.getElementById("status-text");
const statusDotEl  = document.getElementById("status-dot");

function setStatus(state, label) {
  const labels = {
    connecting: "起動中...",
    ready:      "接続済み",
    waiting:    "待機中...",
  };
  const text = label ?? labels[state] ?? state;
  if (statusTextEl) statusTextEl.textContent = text;
  if (statusDotEl) {
    statusDotEl.classList.remove("dot-connecting", "dot-ready", "dot-waiting");
    statusDotEl.classList.add(`dot-${state}`);
  }
}

// スロットBのセレクトボックスを生成する
function populateSelects(tracks) {
  if (tracks.length === 0) return;
  currentTracks = tracks;
  panelLog(`TRACKS_LIST 受信 count=${tracks.length}`);
  panelLog(`populateSelects: pendingB=${pendingAttached.B ?? "null"}`);

  if (selectB) selectB.disabled = false;

  chrome.storage.sync.get(["preferredLangB"], (prefs) => {
    panelLog(`populateSelects: prefB=${prefs.preferredLangB ?? "null"}`);
    selectB.innerHTML = "";
    tracks.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.index;
      opt.textContent = `${t.label} (${t.language})`;
      selectB.appendChild(opt);
    });

    const langToUse = pendingAttached["B"] ?? prefs.preferredLangB;
    const match = langToUse
      ? tracks.find((t) => t.language === langToUse && !t.label.includes("CC"))
      : null;
    panelLog(`populateSelects slot=B langToUse=${langToUse ?? "null"} match=${match?.language ?? "none"}`);
    if (match) selectB.value = match.index;
  });
}

selectB.addEventListener("change", () => {
  const idx = parseInt(selectB.value);
  const track = currentTracks.find((t) => t.index === idx);
  if (track) chrome.storage.sync.set({ preferredLangB: track.language });
  panelLog(`SELECT_TRACK 送信 slot=B trackIndex=${idx}`);
  port.postMessage({ type: "SELECT_TRACK", slot: "B", trackIndex: idx });
});

function flushPair(slotA, slotB) {
  const pair = document.createElement("div");
  pair.className = "history-pair";
  const rowA = document.createElement("div");
  rowA.className = "history-item slot-a";
  rowA.textContent = slotA ?? "";
  const rowB = document.createElement("div");
  rowB.className = "history-item slot-b";
  rowB.textContent = slotB ?? "";
  pair.appendChild(rowA);
  pair.appendChild(rowB);
  historyEl.appendChild(pair);
  historyEl.scrollTop = historyEl.scrollHeight;
}

function addHistory(slot, text, ts) {
  const other = slot === "A" ? "B" : "A";
  panelLog(`addHistory slot=${slot} ts=${ts} bufferOther=${pairBuffer[other]?.ts ?? "none"}`);

  if (pairBuffer[other]) {
    const diff = Math.abs(ts - pairBuffer[other].ts);
    if (diff <= PAIR_MATCH_MS) {
      panelLog(`addHistory ペア成立 diff=${diff}ms slot=${slot}+${other}`);
      clearTimeout(pairBuffer[other].timer);
      const textA_ = slot === "A" ? text : pairBuffer[other].text;
      const textB_ = slot === "B" ? text : pairBuffer[other].text;
      delete pairBuffer[other];
      flushPair(textA_, textB_);
      return;
    }
    panelLog(`addHistory diff=${diff}ms > PAIR_MATCH_MS → ${other} 単独追加`);
    clearTimeout(pairBuffer[other].timer);
    flushPair(
      other === "A" ? pairBuffer[other].text : undefined,
      other === "B" ? pairBuffer[other].text : undefined,
    );
    delete pairBuffer[other];
  }

  const timer = setTimeout(() => {
    if (!pairBuffer[slot]) return;
    panelLog(`addHistory TIMEOUT slot=${slot} → 単独追加`);
    flushPair(
      slot === "A" ? pairBuffer[slot].text : undefined,
      slot === "B" ? pairBuffer[slot].text : undefined,
    );
    delete pairBuffer[slot];
  }, PAIR_TIMEOUT_MS);

  pairBuffer[slot] = { text, ts, timer };
}

// --------------------------------
// メッセージ振り分け
// --------------------------------
function handleMessage(msg) {
  if (msg.type === "DEBUG_LOG") { appendDebugLine(msg.line); return; }
  if (msg.type === "CT_LOG")    { appendDebugLine(msg.line); return; }

  if (msg.type === "TRACKS_LIST") {
    populateSelects(msg.tracks);
    return;
  }

  if (msg.type === "SHOWING_TRACK_CHANGED") {
    panelLog(`SHOWING_TRACK_CHANGED lang=${msg.lang}`);
    if (statusA) statusA.textContent = `${msg.label} (${msg.lang})`;
    return;
  }

  if (msg.type === "SHOWING_TRACK_NONE") {
    panelLog("SHOWING_TRACK_NONE");
    if (statusA) statusA.textContent = "— 字幕をONにしてください —";
    textA.textContent = "— 待機中 —";
    return;
  }

  if (msg.type === "TRACK_ATTACHED") {
    panelLog(`TRACK_ATTACHED slot=${msg.slot} lang=${msg.lang}`);
    pendingAttached[msg.slot] = msg.lang;
    if (msg.slot === "B") {
      const match = currentTracks.find(
        (t) => t.language === msg.lang && !t.label.includes("CC"),
      );
      if (match) selectB.value = match.index;
    }
    return;
  }

  if (msg.type === "READY") {
    panelLog("レディ受信: content.js トラック割り当て完了");
    setStatus("ready");
    return;
  }

  if (msg.type === "SUBTITLE_CUE") {
    panelLog(`SUBTITLE_CUE slot=${msg.slot} lang=${msg.lang} text=${msg.text?.slice(0, 20)}`);
    if (frozen) return;
    if (msg.slot === "A") {
      textA.textContent = msg.text;
    } else {
      textB.textContent = msg.text;
    }
    addHistory(msg.slot, msg.text, msg.ts ?? Date.now());
  }
}

document.getElementById("btn-freeze").addEventListener("click", (e) => {
  frozen = !frozen;
  e.target.textContent = frozen ? "▶" : "⏸";
});

document.getElementById("btn-clear").addEventListener("click", () => {
  historyEl.innerHTML = "";
  Object.values(pairBuffer).forEach((b) => clearTimeout(b.timer));
  Object.keys(pairBuffer).forEach((k) => delete pairBuffer[k]);
  textA.textContent = "— 待機中 —";
  textB.textContent = "— 待機中 —";
  setStatus("ready");
});
