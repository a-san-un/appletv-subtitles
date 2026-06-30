// v0.10.0

// Port 接続を最初に確立する
// （PANEL_INIT の送信は chrome.tabs.query のコールバック内で行うが、
//   Port 自体は即座に確立しておかないと BG が postMessage できない）
const port = chrome.runtime.connect({ name: "subtitle-panel" });
port.onMessage.addListener((msg) => handleMessage(msg));

// ログ機構（PANEL_INIT より前に定義する必要がある）
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

// コピー
document.getElementById("btn-debug-copy").addEventListener("click", () => {
  navigator.clipboard.writeText(logLines.join("\n"));
});

// .txt 保存
document.getElementById("btn-debug-save").addEventListener("click", () => {
  const blob = new Blob([logLines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `subtitle-debug-${new Date().toISOString().replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// クリア
document.getElementById("btn-debug-clear").addEventListener("click", () => {
  logLines.length = 0;
  debugLogEl.innerHTML = "";
});

let currentTracks = [];
let frozen = false;
let pendingPair = {};

const textA = document.getElementById("en-text");
const textB = document.getElementById("ja-text");
const historyEl = document.getElementById("history-list");
const selectA = document.getElementById("select-a");
const selectB = document.getElementById("select-b");

// ステータスバー要素（存在する場合のみ更新）
const statusEl = document.getElementById("status");
function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function populateSelects(tracks) {
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

function handleMessage(msg) {
  if (msg.type === "DEBUG_LOG") {
    // background.js からのログをパネルに表示
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
    setStatus("接続済み");
    return;
  }
  if (msg.type === "SUBTITLE_CUE") {
    panelLog(`SUBTITLE_CUE slot=${msg.slot} lang=${msg.lang} text=${msg.text?.slice(0, 20)}`);
    if (frozen) return;
    if (msg.slot === "A") {
      textA.textContent = msg.text;
      addHistory("A", msg.text);
    } else {
      textB.textContent = msg.text;
      addHistory("B", msg.text);
    }
  }
}

function addHistory(slot, text) {
  pendingPair[slot] = text;

  if (pendingPair["A"] !== undefined && pendingPair["B"] !== undefined) {
    const pair = document.createElement("div");
    pair.className = "history-pair";

    const rowA = document.createElement("div");
    rowA.className = "history-item slot-a";
    rowA.textContent = pendingPair["A"];

    const rowB = document.createElement("div");
    rowB.className = "history-item slot-b";
    rowB.textContent = pendingPair["B"];

    pair.appendChild(rowA);
    pair.appendChild(rowB);
    historyEl.appendChild(pair);
    historyEl.scrollTop = historyEl.scrollHeight;

    pendingPair = {};
  }
}

document.getElementById("btn-freeze").addEventListener("click", (e) => {
  frozen = !frozen;
  e.target.textContent = frozen ? "▶" : "⏸";
});

document.getElementById("btn-clear").addEventListener("click", () => {
  historyEl.innerHTML = "";
  pendingPair = {};
  textA.textContent = "— 待機中 —";
  textB.textContent = "— 待機中 —";
});
