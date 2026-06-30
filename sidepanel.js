// v0.13.4
// 役割: サイドパネルの UI 制御・メッセージ受信・履歴表示
//
// 主な処理:
//   - 起動時に background.js へ Port 接続し PANEL_INIT を送信する
//   - TRACKS_LIST 受信でセレクトボックスを自動生成する
//   - SUBTITLE_CUE 受信で字幕テキストを表示し、ペアマッチングして履歴に追加する
//   - ペアマッチング: A と B の ts 差が PAIR_MATCH_MS 以内ならペア化、
//     超過した場合は PAIR_TIMEOUT_MS 後に単独追加する
//
// v0.13.2 修正:
//   - TRACK_ATTACHED 受信時に currentTracks が空の場合でも lang を pendingAttached に保存し、
//     後続の TRACKS_LIST 受信時にセレクトボックスへ正しく反映する。
//     これにより再オープン時に意図しない言語（前回 storage に残った値）が選ばれるバグを修正。
//
// v0.13.4 変更:
//   - populateSelects: pendingAttached / prefKey / langToUse / match 結果をログ出力。
//   - addHistory: diff 値・ペア成立 or 単独追加 or タイムアウトをログ出力。

// Port 接続を最初に確立する（background.js がメッセージを転送する）
const port = chrome.runtime.connect({ name: "subtitle-panel" });
port.onMessage.addListener((msg) => handleMessage(msg));

// ログ機構（画面内デバッグ表示 + コピー・保存機能）
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

// 接続直後に自分のタブIDを background.js に伝える
// background.js はこの tabId でルーティング先を特定する
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs[0]?.id;
  panelLog(`PANEL_INIT 送信: tabId=${tabId}`);
  if (tabId) port.postMessage({ type: "PANEL_INIT", tabId });
});

// DEBUG LOG の開閉トグル
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

let currentTracks = []; // TRACKS_LIST で受け取ったトラック情報のキャッシュ
let frozen = false;     // true のとき字幕表示・履歴追加を一時停止する

// TRACK_ATTACHED で受け取った lang を一時保存する。
// TRACKS_LIST が後から届いたときに preferredLang より優先して使う。
// （再オープン時: TRACK_ATTACHED → TRACKS_LIST の順で届くため）
const pendingAttached = { A: null, B: null };

// --------------------------------
// ペアマッチング設定
// --------------------------------
// A と B の字幕は同時刻には届かないため、ts（タイムスタンプ）で突き合わせてペア化する。
// PAIR_MATCH_MS 以内に相手が届けばペア、それ以降は PAIR_TIMEOUT_MS 後に単独追加。
const PAIR_TIMEOUT_MS = 500; // 相手スロットを待つ最大時間（ms）
const PAIR_MATCH_MS  = 300; // この時間差以内なら同時刻のペアとみなす（ms）

// slot → { text, ts, timer } を一時的に保持するバッファ
const pairBuffer = {};

const textA = document.getElementById("en-text");
const textB = document.getElementById("ja-text");
const historyEl = document.getElementById("history-list");
const selectA = document.getElementById("select-a");
const selectB = document.getElementById("select-b");

const statusTextEl = document.getElementById("status-text");
const statusDotEl  = document.getElementById("status-dot");

// ステータスインジケーターの更新
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

// TRACKS_LIST 受信時にセレクトボックスを生成する。
// 優先順位: (1) pendingAttached の lang（TRACK_ATTACHED で受け取った実際の割り当て）
//           (2) chrome.storage.sync の preferredLang（前回ユーザーが選んだ言語）
// CC より subtitles を優先する。
function populateSelects(tracks) {
  if (tracks.length === 0) return;
  currentTracks = tracks;
  panelLog(`TRACKS_LIST 受信 count=${tracks.length}`);
  panelLog(`populateSelects: pendingA=${pendingAttached.A ?? "null"} pendingB=${pendingAttached.B ?? "null"}`);
  chrome.storage.sync.get(["preferredLangA", "preferredLangB"], (prefs) => {
    panelLog(`populateSelects: prefA=${prefs.preferredLangA ?? "null"} prefB=${prefs.preferredLangB ?? "null"}`);
    [
      { sel: selectA, slot: "A", prefKey: prefs.preferredLangA },
      { sel: selectB, slot: "B", prefKey: prefs.preferredLangB },
    ].forEach(({ sel, slot, prefKey }) => {
      sel.innerHTML = "";
      tracks.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.index;
        opt.textContent = `${t.label} (${t.language})`;
        sel.appendChild(opt);
      });

      // pendingAttached を最優先で使う（再オープン時に content.js の実態を反映）
      const langToUse = pendingAttached[slot] ?? prefKey;
      const match = langToUse
        ? tracks.find((t) => t.language === langToUse && !t.label.includes("CC"))
        : null;
      panelLog(`populateSelects slot=${slot} langToUse=${langToUse ?? "null"} match=${match?.language ?? "none"}`);
      if (match) sel.value = match.index;
    });
  });
}

// セレクトボックス変更 → background → content.js へ SELECT_TRACK を送信する
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

// 履歴に A・B ペアを追加する
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

// ペアマッチング処理
// 相手スロットの ts と比較し、PAIR_MATCH_MS 以内ならペア化する。
// タイムスタンプ差が大きい場合は相手を単独追加してバッファを入れ替える。
function addHistory(slot, text, ts) {
  const other = slot === "A" ? "B" : "A";

  panelLog(`addHistory slot=${slot} ts=${ts} bufferOther=${pairBuffer[other]?.ts ?? "none"}`);

  if (pairBuffer[other]) {
    const diff = Math.abs(ts - pairBuffer[other].ts);
    if (diff <= PAIR_MATCH_MS) {
      // ペア成立：タイマーをキャンセルしてまとめて追加する
      panelLog(`addHistory ペア成立 diff=${diff}ms slot=${slot}+${other}`);
      clearTimeout(pairBuffer[other].timer);
      const textA_ = slot === "A" ? text : pairBuffer[other].text;
      const textB_ = slot === "B" ? text : pairBuffer[other].text;
      delete pairBuffer[other];
      flushPair(textA_, textB_);
      return;
    }
    // ts 差が大きい → 相手を単独追加してバッファをリセットする
    panelLog(`addHistory diff=${diff}ms > PAIR_MATCH_MS → ${other} 単独追加`);
    clearTimeout(pairBuffer[other].timer);
    flushPair(
      other === "A" ? pairBuffer[other].text : undefined,
      other === "B" ? pairBuffer[other].text : undefined,
    );
    delete pairBuffer[other];
  }

  // バッファに登録。PAIR_TIMEOUT_MS 後に相手が来なければ単独追加する。
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
  if (msg.type === "DEBUG_LOG") {
    // background.js のログを画面に表示する
    appendDebugLine(msg.line);
    return;
  }
  if (msg.type === "CT_LOG") {
    // content.js のログを画面に表示する
    appendDebugLine(msg.line);
    return;
  }
  if (msg.type === "TRACKS_LIST") {
    populateSelects(msg.tracks);
    return;
  }
  if (msg.type === "TRACK_ATTACHED") {
    panelLog(`TRACK_ATTACHED slot=${msg.slot} lang=${msg.lang}`);
    // content.js が実際に割り当てた lang を記録する。
    // currentTracks がまだ空の場合でも保持しておき、後続の TRACKS_LIST で使う。
    pendingAttached[msg.slot] = msg.lang;
    const target = msg.slot === "A" ? selectA : selectB;
    const match = currentTracks.find(
      (t) => t.language === msg.lang && !t.label.includes("CC"),
    );
    if (match) target.value = match.index; // currentTracks があれば即反映
    return;
  }
  if (msg.type === "READY") {
    // content.js のトラック割り当てが完了した
    panelLog("レディ受信: content.js トラック割り当て完了");
    setStatus("ready");
    return;
  }
  if (msg.type === "SUBTITLE_CUE") {
    panelLog(`SUBTITLE_CUE slot=${msg.slot} lang=${msg.lang} text=${msg.text?.slice(0, 20)}`);
    if (frozen) return; // freeze 中は更新しない
    if (msg.slot === "A") {
      textA.textContent = msg.text;
    } else {
      textB.textContent = msg.text;
    }
    // ts を使ってペアマッチングを行い履歴に追加する
    addHistory(msg.slot, msg.text, msg.ts ?? Date.now());
  }
}

// 一時停止（freeze）トグル
document.getElementById("btn-freeze").addEventListener("click", (e) => {
  frozen = !frozen;
  e.target.textContent = frozen ? "▶" : "⏸";
});

// 履歴クリア：DOM・バッファ・タイマーをすべてリセットする
document.getElementById("btn-clear").addEventListener("click", () => {
  historyEl.innerHTML = "";
  Object.values(pairBuffer).forEach((b) => clearTimeout(b.timer));
  Object.keys(pairBuffer).forEach((k) => delete pairBuffer[k]);
  textA.textContent = "— 待機中 —";
  textB.textContent = "— 待機中 —";
  setStatus("ready");
});
