// v0.11.0

// Port 接続を最初に確立する
const port = chrome.runtime.connect({ name: "subtitle-panel" });
port.onMessage.addListener((msg) => handleMessage(msg));

// ログ機構
const logLines = [];
const debugLogEl = document.getElementById("debug-log");

function panelLog(msg) {
  const line = `[Panel ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  const div = document.createElement("div");
  div.textContent = line;
  debugLogEl.appendChild(div);
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

// 接続直後に自分のタブIDを background.js に伝える
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  panelLog(`PANEL_INIT 送信: tabId=${tabId}`);
  if (tabId) port.postMessage({ type: "PANEL_INIT", tabId });
});

// DEBUG LOG トグル
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

// タイムスタンプマッチング用バッファ。
// 片方のスロットが先に届いたとき、タイムアウトまで相手を待つ。
const PAIR_TIMEOUT_MS = 500; // 相手を待つ最大時間（ms）
const PAIR_MATCH_MS  = 300; // この時間差以内ならペアとみなす（ms）

// slot→{text, ts, timer} を保持
const pairBuffer = {};

const textA = document.getElementById("en-text");
const textB = document.getElementById("ja-text");
const historyEl = document.getElementById("history-list");
const selectA = document.getElementById("select-a");
const selectB = document.getElementById("select-b");

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

function populateSelects(tracks) {
  if (tracks.length === 0) return; // count=0 は無視（内容も content.js 側で抑制済みだが俱備）
  currentTracks = tracks;
  panelLog(`TRACKS_LIST 受信 count=${tracks.length}`);
  chrome.storage.sync.get(["preferredLangA", "preferredLangB"], (prefs) => {
    [
      { sel: selectA, prefKey: prefs.preferredLangA },
      { sel: selectB, prefKey: prefs.preferredLangB },
    ].forEach(({ sel, prefKey }) => {
      const prev = sel.value;
      sel.innerHTML = "";
      tracks.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.index;
        opt.textContent = `${t.label} (${t.language})`;
        sel.appendChild(opt);
      });
      if (prefKey) {
        const match = tracks.find(
          (t) => t.language === prefKey && !t.label.includes("CC"),
        );
        if (match) {
          sel.value = match.index;
          return;
        }
      }
      if (prev !== "") sel.value = prev;
    });
  });
}

selectA.addEventListener("change", () => {
  const idx = parseInt(selectA.value);
  const track = currentTracks.find((t) => t.index === idx);
  if (track) chrome.storage.sync.set({ preferredLangA: track.language });
  panelLog(`SELECT_TRACK 送信 slot=A trackIndex=${idx}`);
  port.postMessage({ type: "SELECT_TRACK", slot: "A", trackIndex: idx });
});

selectB.addEventListener("change", () => {
  const idx = parseInt(selectB.value);
  const track = currentTracks.find((t) => t.index === idx);
  if (track) chrome.storage.sync.set({ preferredLangB: track.language });
  panelLog(`SELECT_TRACK 送信 slot=B trackIndex=${idx}`);
  port.postMessage({ type: "SELECT_TRACK", slot: "B", trackIndex: idx });
});

// 履歴にペアを追加する
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

// タイムスタンプマッチング履歴追加。
// 相手スロットの ts との差が PAIR_MATCH_MS 以内ならペア化。
// 超過したらタイムアウト後に単独追加。
function addHistory(slot, text, ts) {
  const other = slot === "A" ? "B" : "A";

  if (pairBuffer[other]) {
    // 相手がバッファにいる → ts 差をチェック
    if (Math.abs(ts - pairBuffer[other].ts) <= PAIR_MATCH_MS) {
      // ペア成立
      clearTimeout(pairBuffer[other].timer);
      const textA_ = slot === "A" ? text : pairBuffer[other].text;
      const textB_ = slot === "B" ? text : pairBuffer[other].text;
      delete pairBuffer[other];
      flushPair(textA_, textB_);
      return;
    }
    // ts 差が大きい場合は相手を単独追加しバッファを入れ替える
    clearTimeout(pairBuffer[other].timer);
    flushPair(
      other === "A" ? pairBuffer[other].text : undefined,
      other === "B" ? pairBuffer[other].text : undefined,
    );
    delete pairBuffer[other];
  }

  // バッファに登録し、PAIR_TIMEOUT_MS 後に単独フラッシュ
  const timer = setTimeout(() => {
    if (!pairBuffer[slot]) return;
    flushPair(
      slot === "A" ? pairBuffer[slot].text : undefined,
      slot === "B" ? pairBuffer[slot].text : undefined,
    );
    delete pairBuffer[slot];
  }, PAIR_TIMEOUT_MS);

  pairBuffer[slot] = { text, ts, timer };
}

function handleMessage(msg) {
  if (msg.type === "DEBUG_LOG") {
    logLines.push(msg.line);
    if (logLines.length > 500) logLines.shift();
    const div = document.createElement("div");
    div.textContent = msg.line;
    debugLogEl.appendChild(div);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
    return;
  }
  if (msg.type === "TRACKS_LIST") {
    populateSelects(msg.tracks);
    return;
  }
  if (msg.type === "TRACK_ATTACHED") {
    panelLog(`TRACK_ATTACHED slot=${msg.slot} lang=${msg.lang}`);
    const target = msg.slot === "A" ? selectA : selectB;
    const match = currentTracks.find(
      (t) => t.language === msg.lang && !t.label.includes("CC"),
    );
    if (match) target.value = match.index;
    return;
  }
  if (msg.type === "READY") {
    panelLog("READY 受信: content.js トラック割り当て完了");
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
    // ts をペアマッチングに使用
    addHistory(msg.slot, msg.text, msg.ts ?? Date.now());
  }
}

document.getElementById("btn-freeze").addEventListener("click", (e) => {
  frozen = !frozen;
  e.target.textContent = frozen ? "▶" : "⏸";
});

document.getElementById("btn-clear").addEventListener("click", () => {
  historyEl.innerHTML = "";
  // バッファとタイマーもリセット
  Object.values(pairBuffer).forEach((b) => clearTimeout(b.timer));
  Object.keys(pairBuffer).forEach((k) => delete pairBuffer[k]);
  textA.textContent = "— 待機中 —";
  textB.textContent = "— 待機中 —";
  setStatus("ready");
});
