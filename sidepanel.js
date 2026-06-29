// v0.9.0
const port = chrome.runtime.connect({ name: "subtitle-panel" });
port.onMessage.addListener((msg) => handleMessage(msg));

let currentTracks = [];
let frozen = false;
let pendingPair = {}; // ← 追加

const textA = document.getElementById("en-text");
const textB = document.getElementById("ja-text");
const historyEl = document.getElementById("history-list");
const selectA = document.getElementById("select-a");
const selectB = document.getElementById("select-b");

function populateSelects(tracks) {
  currentTracks = tracks;
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
  port.postMessage({ type: "SELECT_TRACK", slot: "A", trackIndex: idx });
});

selectB.addEventListener("change", () => {
  const idx = parseInt(selectB.value);
  const track = currentTracks.find((t) => t.index === idx);
  if (track) chrome.storage.sync.set({ preferredLangB: track.language });
  port.postMessage({ type: "SELECT_TRACK", slot: "B", trackIndex: idx });
});

function handleMessage(msg) {
  if (msg.type === "TRACKS_LIST") {
    populateSelects(msg.tracks);
    return;
  }
  if (msg.type === "TRACK_ATTACHED") {
    const target = msg.slot === "A" ? selectA : selectB;
    const match = currentTracks.find(
      (t) => t.language === msg.lang && !t.label.includes("CC"),
    );
    if (match) target.value = match.index;
    return;
  }
  if (msg.type === "SUBTITLE_CUE") {
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
  pendingPair = {}; // ← 追加
  textA.textContent = "— 待機中 —";
  textB.textContent = "— 待機中 —";
});
