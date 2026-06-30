// v0.14.0
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・ background.js へ送信
//
// 主な処理フロー:
//   1. watchForVideo() で <video> 要素の出現を MutationObserver で監視
//   2. <video> 検出後 bindVideoEvents() を呼び出す
//   3. bindVideoEvents() で seeked / addtrack をリッスナーを一度だけ登録する
//   4. init() が TRACKS_LIST 送信 + preferredLang に基づきトラックを自動割り当て
//   5. 割り当てたトラックに cuechange リッスナーを付け SUBTITLE_CUE を送信
//   6. PANEL_INIT 受信時は現在の状態を再送して UI を復元する
//
// v0.13.3 変更:
//   - activateTrack: showing 開始・hidden 復帰・cues 件数のログを追加
//   - reloadAfterSeek: 引数 video を受け取るよう変更し currentTime・cues 件数ログを追加
//   - getValidTracks: forced 除外・重複上書き・最終件数のログを追加
//   - init: seeked リスナーを () => reloadAfterSeek(video) に変更
//
// v0.14.0 変更:
//   - seeked / addtrack リスナーを init() から bindVideoEvents() へ移動し、
//     loadedmetadata 再発火による多重登録を防止
//   - activateTimers を追加し、スロット単位で前回のタイマーを clearTimeout することで
//     連打シーク時の showing/hidden 競合を解消
//   - activateTrack(track, slot) に slot 引数を追加
//   - 各修正箇所に確認用ログを追加

(function () {
  function ctLog(msg) {
    const line = `[CT ${new Date().toISOString()}] ${msg}`;
    console.log(line);
    safeSend({ type: "CT_LOG", line });
  }

  // runtime.sendMessage の失敗を握り潰すラッパー
  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {}
  }

  // --------------------------------
  // トラックラベルの整形
  // --------------------------------
  function formatLabel(track) {
    const raw = track.label || "";
    const trimmed = raw.trim();
    const isForced = trimmed.toLowerCase().includes("forced");
    const base = trimmed.replace(/\s*\(forced\)/i, "").trim();
    if (isForced) return `${base} (forced)`;
    if (raw !== trimmed || track.kind === "captions") return `${base} CC`;
    return base;
  }

  const activeSlots = { A: null, B: null };
  const listenerMap = new WeakMap();

  // ★ スロットごとの activateTrack タイマーID を保持する（競合防止）
  // assignTrack / reloadAfterSeek のどちらから呼ばれても
  // 前回のタイマーをキャンセルしてから新しいタイマーを開始する。
  const activateTimers = { A: null, B: null };

  // --------------------------------
  // cuechange リスナーの着脱
  // --------------------------------
  function attachCueListener(track, slot) {
    if (listenerMap.has(track)) return;
    const handler = () => {
      const cues = [...(track.activeCues || [])];
      if (!cues.length) return;
      const text = cues.map((c) => c.text.replace(/<[^>]*>/g, "")).join("\n");
      ctLog(`cuechange slot=${slot} lang=${track.language} text=${text.slice(0, 30)}`);
      safeSend({
        type: "SUBTITLE_CUE",
        slot,
        lang: track.language,
        label: formatLabel(track),
        text,
        ts: Date.now(),
      });
    };
    track.addEventListener("cuechange", handler);
    listenerMap.set(track, handler);
  }

  function detachCueListener(track) {
    const handler = listenerMap.get(track);
    if (handler) {
      track.removeEventListener("cuechange", handler);
      listenerMap.delete(track);
    }
  }

  // --------------------------------
  // トラックのアクティブ化
  // --------------------------------
  // slot 引数でタイマーをスロット単位に管理する。
  // 前回のタイマーが残っていれば clearTimeout してから新しいタイマーを開始する。
  // これにより連打シーク・手動切り替えでの showing/hidden 競合を防ぐ。
  function activateTrack(track, slot) {
    ctLog(`activateTrack lang=${track.language} slot=${slot ?? "none"} mode=${track.mode} cues=${track.cues?.length ?? "null"}`);

    if (track.cues && track.cues.length > 0) {
      track.mode = "hidden";
      ctLog(`activateTrack: cues あり → hidden (cues=${track.cues.length}) lang=${track.language}`);
      return;
    }

    // ★ 前回のタイマーをキャンセルする
    if (slot && activateTimers[slot] != null) {
      clearTimeout(activateTimers[slot]);
      activateTimers[slot] = null;
      ctLog(`activateTrack: 前タイマーキャンセル slot=${slot}`);
    }

    if (track.mode === "disabled") track.mode = "hidden";

    const t1 = setTimeout(() => {
      ctLog(`activateTrack: showing 開始 lang=${track.language} slot=${slot ?? "none"}`);
      track.mode = "showing";
      const t2 = setTimeout(() => {
        ctLog(`activateTrack: hidden 復帰 cues=${track.cues?.length ?? "null"} lang=${track.language}`);
        track.mode = "hidden";
        if (slot) activateTimers[slot] = null;
      }, 1000);
      if (slot) activateTimers[slot] = t2;
    }, 300);

    if (slot) activateTimers[slot] = t1;
  }

  // スロットにトラックを割り当て、前のトラックのリスナーを解除する
  function assignTrack(slot, track) {
    ctLog(`assignTrack slot=${slot} lang=${track.language}`);
    const prev = activeSlots[slot];
    if (prev && prev !== track) {
      detachCueListener(prev);
      const usedByOther = Object.entries(activeSlots).some(([s, t]) => s !== slot && t === prev);
      if (!usedByOther) prev.mode = "disabled";
    }
    activeSlots[slot] = track;
    attachCueListener(track, slot);
    safeSend({ type: "TRACK_ATTACHED", slot, lang: track.language, label: formatLabel(track) });
    activateTrack(track, slot); // ★ slot を渡す
  }

  // --------------------------------
  // シーク後の再ロード
  // --------------------------------
  function reloadAfterSeek(video) {
    ctLog(`seeked currentTime=${video.currentTime?.toFixed(2)}`);
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      const cueCount = track?.cues?.length ?? "null";
      ctLog(`seeked slot=${slot} lang=${track?.language ?? "none"} cues=${cueCount}`);
      if (track && (!track.cues || track.cues.length === 0)) {
        ctLog(`seeked: slot=${slot} cues 空のため activateTrack 再実行`);
        activateTrack(track, slot); // ★ slot を渡す
      } else if (track) {
        ctLog(`seeked: slot=${slot} cues=${cueCount} スキップ`);
      }
    });
  }

  // --------------------------------
  // 有効トラック一覧の取得
  // --------------------------------
  function getValidTracks(video) {
    const seen = new Map();
    for (const track of video.textTracks) {
      if (!track.language) continue;
      if (track.label.toLowerCase().includes("forced")) {
        ctLog(`getValidTracks: forced 除外 lang=${track.language} label=${track.label}`);
        continue;
      }
      const key = `${track.language}|${formatLabel(track)}|${track.kind}`;
      const existing = seen.get(key);
      if (!existing || (track.cues && track.cues.length > 0)) {
        if (existing) ctLog(`getValidTracks: 重複上書き key=${key}`);
        seen.set(key, track);
      }
    }
    const result = [...seen.values()];
    ctLog(`getValidTracks: result count=${result.length}`);
    return result;
  }

  // TRACKS_LIST 送信（300ms デバウンス）
  // NOTE: tracksListTimer はグローバル1つ。PANEL_INIT と addtrack が
  // 同時に発火するとデバウンスがリセットされ若干遅延することがあるが実害は軽微。
  let tracksListTimer = null;
  function sendTracksList(video) {
    clearTimeout(tracksListTimer);
    tracksListTimer = setTimeout(() => {
      const tracks = getValidTracks(video);
      if (tracks.length === 0) { ctLog("TRACKS_LIST スキップ (count=0)"); return; }
      ctLog(`TRACKS_LIST 送信 count=${tracks.length}`);
      safeSend({
        type: "TRACKS_LIST",
        tracks: tracks.map((t, i) => ({
          index: i,
          language: t.language,
          label: formatLabel(t),
          kind: t.kind,
        })),
      });
    }, 300);
  }

  // --------------------------------
  // background.js からのメッセージ受信
  // --------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SELECT_TRACK") {
      const video = document.querySelector("video");
      if (!video) return;
      const track = getValidTracks(video)[msg.trackIndex];
      if (!track) return;
      ctLog(`SELECT_TRACK 受信 slot=${msg.slot} trackIndex=${msg.trackIndex}`);
      assignTrack(msg.slot, track);
      chrome.storage.sync.set({ [`preferredLang${msg.slot}`]: track.language });
      return;
    }

    if (msg.type === "PANEL_INIT") {
      const video = document.querySelector("video");
      if (!video) return;
      ctLog("PANEL_INIT 受信: 現在の状態を再送");
      sendTracksList(video);

      const hasAttached = Object.values(activeSlots).some((t) => t !== null);
      if (hasAttached) {
        ["A", "B"].forEach((slot) => {
          const track = activeSlots[slot];
          if (!track) return;
          safeSend({ type: "TRACK_ATTACHED", slot, lang: track.language, label: formatLabel(track) });
        });
        safeSend({ type: "READY" });
        ctLog("PANEL_INIT: 再送完了 (READY 送信)");
      } else {
        initTracks(video);
      }
      return;
    }
  });

  // --------------------------------
  // トラックの自動割り当て
  // --------------------------------
  function initTracks(video) {
    const validTracks = getValidTracks(video);
    ctLog(`initTracks 開始 validTracks=${validTracks.length}`);
    chrome.storage.sync.get(["preferredLangA", "preferredLangB"], (result) => {
      const langA = result.preferredLangA || "en";
      const langB = result.preferredLangB || "ja";
      const trackA = validTracks.find((t) => t.language === langA && t.kind !== "captions");
      const trackB = validTracks.find((t) => t.language === langB && t.kind !== "captions");
      ctLog(`initTracks trackA=${trackA?.language ?? "none"} trackB=${trackB?.language ?? "none"}`);
      if (trackA) assignTrack("A", trackA);
      if (trackB) assignTrack("B", trackB);
      safeSend({ type: "READY" });
      ctLog("READY 送信");
    });
  }

  // --------------------------------
  // init(): トラック割り当て + TRACKS_LIST 送信
  // --------------------------------
  // NOTE: seeked / addtrack リスナーは bindVideoEvents() で1回だけ登録する。
  // init() は loadedmetadata のたびに再呼び出しされるため、
  // ここでリスナーを登録すると多重登録になる。
  function init(video) {
    ctLog("init() 開始");
    sendTracksList(video);
    initTracks(video);
  }

  // --------------------------------
  // <video> 要素へのイベント登録
  // --------------------------------
  // seeked / addtrack は video 単位で1回だけ登録する。
  // loadedmetadata（エピソード切替）のたびに init() を再実行して
  // スロットをリセットし、トラックを再割り当てする。
  let currentVideo = null;

  function bindVideoEvents(video) {
    if (currentVideo === video) return;
    currentVideo = video;
    ctLog("新しい video 要素を検出、イベントを登録");

    // ★ seeked / addtrack をここで1回だけ登録する（init() に書かない）
    video.addEventListener("seeked", () => reloadAfterSeek(video));
    ctLog("seeked リスナー登録");
    video.textTracks.addEventListener("addtrack", () => sendTracksList(video));
    ctLog("addtrack リスナー登録");

    video.addEventListener("loadedmetadata", () => {
      ctLog(`loadedmetadata: スロットをリセットし init() 再実行 src=${video.src?.slice(-40)}`);
      ["A", "B"].forEach((slot) => {
        if (activeSlots[slot]) detachCueListener(activeSlots[slot]);
        activeSlots[slot] = null;
        // ★ スロットのタイマーもリセットする
        if (activateTimers[slot] != null) {
          clearTimeout(activateTimers[slot]);
          activateTimers[slot] = null;
        }
      });
      init(video);
    });

    init(video);
  }

  // --------------------------------
  // <video> 要素の監視
  // --------------------------------
  function watchForVideo() {
    const v = document.querySelector("video");
    if (v) {
      ctLog("watchForVideo: video 即時検知");
      bindVideoEvents(v);
    }

    const obs = new MutationObserver(() => {
      const v2 = document.querySelector("video");
      if (v2 && v2 !== currentVideo) {
        ctLog("MutationObserver: 新しい video 検知");
        bindVideoEvents(v2);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  watchForVideo();
})();
