// v0.15.0
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・background.js へ送信
//
// 処理フロー:
//   1. watchForVideo() で <video> 要素の出現を MutationObserver で監視
//   2. <video> 検出後 bindVideoEvents() でイベントを一度だけ登録
//   3. init() で TRACKS_LIST 送信 + トラック自動割り当て
//   4. スロットA: 画面の showing トラックを自動反映（ユーザー選択なし）
//      showing トラックがなければ SHOWING_TRACK_NONE を送信
//      showing トラックが変わったら SHOWING_TRACK_CHANGED を送信
//   5. スロットB: preferredLangB に基づき自動割り当て・ユーザー選択可
//   6. 割り当てたトラックに cuechange リスナーを付け SUBTITLE_CUE を送信
//   7. PANEL_INIT 受信時は現在の状態を再送して UI を復元

(function () {
  function ctLog(msg) {
    const line = `[CT ${new Date().toISOString()}] ${msg}`;
    console.log(line);
    safeSend({ type: "CT_LOG", line });
  }

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {}
  }

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
  const activateTimers = { A: null, B: null };
  const checkTimers = { A: null, B: null };

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
  // トラックのアクティブ化（スロットB専用）
  // スロットAは Apple TV+ が showing を管理するため呼ばない
  // --------------------------------
  function activateTrack(track, slot, force = false) {
    const RESTORE_MODE = "hidden";
    ctLog(`activateTrack lang=${track.language} slot=${slot} mode=${track.mode} cues=${track.cues?.length ?? "null"} force=${force}`);

    if (!force && track.cues && track.cues.length > 0) {
      ctLog(`activateTrack: cues あり → mode維持 (cues=${track.cues.length})`);
      return;
    }

    if (slot && activateTimers[slot] != null) {
      clearTimeout(activateTimers[slot]);
      activateTimers[slot] = null;
    }
    if (slot && checkTimers[slot] != null) {
      clearInterval(checkTimers[slot]);
      checkTimers[slot] = null;
    }

    if (force) {
      track.mode = "disabled";
      ctLog(`activateTrack: disabled 経由 (force)`);
    }

    const t1 = setTimeout(() => {
      if (force) track.mode = "hidden";

      const t2 = setTimeout(() => {
        ctLog(`activateTrack: showing 開始 lang=${track.language} slot=${slot}`);
        track.mode = "showing";

        const startTime = performance.now();
        const initialCueCount = track.cues ? track.cues.length : 0;

        if (force && slot) {
          checkTimers[slot] = setInterval(() => {
            const currentCueCount = track.cues ? track.cues.length : 0;
            if (currentCueCount > initialCueCount) {
              const elapsed = performance.now() - startTime;
              ctLog(`[時間計測] データ到着: ${elapsed.toFixed(1)}ms (cues: ${initialCueCount} → ${currentCueCount}) slot=${slot}`);
              clearInterval(checkTimers[slot]);
              checkTimers[slot] = null;
              clearTimeout(activateTimers[slot]);
              activateTimers[slot] = null;
              track.mode = RESTORE_MODE;
              ctLog(`activateTrack: 早期復元 cues=${currentCueCount} → ${RESTORE_MODE}`);
            }
          }, 100);
        }

        const t3 = setTimeout(() => {
          if (slot && checkTimers[slot]) {
            clearInterval(checkTimers[slot]);
            checkTimers[slot] = null;
          }
          ctLog(`activateTrack: タイムアウト(2000ms)による復元 cues=${track.cues?.length ?? "null"} lang=${track.language} → ${RESTORE_MODE}`);
          track.mode = RESTORE_MODE;
          if (slot) activateTimers[slot] = null;
        }, 2000);

        if (slot) activateTimers[slot] = t3;
      }, force ? 50 : 0);
      if (slot) activateTimers[slot] = t2;
    }, 0);

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
    // スロットBのみ activateTrack でセグメント取得を行う
    // スロットAは Apple TV+ の showing をそのまま使うため呼ばない
    if (slot === "B") activateTrack(track, slot);
  }

  // --------------------------------
  // シーク後の再ロード（スロットBのみ）
  // --------------------------------
  function reloadAfterSeek(video) {
    ctLog(`seeked currentTime=${video.currentTime?.toFixed(2)}`);
    const track = activeSlots["B"];
    if (!track) return;

    if (activateTimers["B"] != null) {
      ctLog(`seeked: slot=B activateTrack 進行中 → スキップ`);
      return;
    }

    const hasActiveCue = track.activeCues && track.activeCues.length > 0;
    ctLog(`seeked slot=B lang=${track.language} cues=${track.cues?.length ?? "null"}`);

    if (!hasActiveCue) {
      ctLog(`seeked: slot=B activeCues 無し → 強制ロード (force=true)`);
      activateTrack(track, "B", true);
    } else {
      ctLog(`seeked: slot=B cues=${track.cues?.length} activeCues=${track.activeCues.length} スキップ`);
    }
  }

  // --------------------------------
  // 有効トラック一覧の取得（スロットB用セレクトボックス向け）
  // --------------------------------
  function getValidTracks(video) {
    const seen = new Map();
    for (const track of video.textTracks) {
      if (!track.language) continue;
      if (track.kind === "captions") {
        ctLog(`getValidTracks: captions 除外 lang=${track.language} label=${track.label}`);
        continue;
      }
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

  // --------------------------------
  // 画面の showing トラックを取得（スロットA用）
  // --------------------------------
  function getShowingTrack(video) {
    for (const track of video.textTracks) {
      if (
        track.mode === "showing" &&
        track.kind !== "captions" &&
        !track.label.toLowerCase().includes("forced")
      ) {
        return track;
      }
    }
    return null;
  }

  // TRACKS_LIST 送信（300ms デバウンス）
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

  // showing トラックの状態を通知（スロットA用）
  function notifyShowingTrack(video) {
    const t = getShowingTrack(video);
    if (t) {
      if (t !== activeSlots["A"]) {
        ctLog(`showing トラック変化 → assignTrack slot=A lang=${t.language}`);
        assignTrack("A", t);
      }
      safeSend({ type: "SHOWING_TRACK_CHANGED", lang: t.language, label: formatLabel(t) });
    } else {
      if (activeSlots["A"]) {
        detachCueListener(activeSlots["A"]);
        activeSlots["A"] = null;
      }
      ctLog(`showing トラックなし → SHOWING_TRACK_NONE 送信`);
      safeSend({ type: "SHOWING_TRACK_NONE" });
    }
  }

  // --------------------------------
  // background.js からのメッセージ受信
  // --------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SELECT_TRACK") {
      // スロットBのみ SELECT_TRACK を受け付ける
      if (msg.slot !== "B") return;
      const video = document.querySelector("video");
      if (!video) return;
      const track = getValidTracks(video)[msg.trackIndex];
      if (!track) return;
      ctLog(`SELECT_TRACK 受信 slot=B trackIndex=${msg.trackIndex}`);
      assignTrack("B", track);
      chrome.storage.sync.set({ preferredLangB: track.language });
      return;
    }

    if (msg.type === "PANEL_INIT") {
      const video = document.querySelector("video");
      if (!video) return;
      ctLog("PANEL_INIT 受信: 現在の状態を再送");
      sendTracksList(video);
      notifyShowingTrack(video);

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

    // スロットA: 画面の showing トラックを反映
    notifyShowingTrack(video);

    // スロットB: preferredLangB に基づき割り当て
    chrome.storage.sync.get(["preferredLangB"], (result) => {
      const langB = result.preferredLangB || "ja";
      const trackB = validTracks.find((t) => t.language === langB);
      ctLog(`initTracks trackB=${trackB?.language ?? "none"}`);
      if (trackB) assignTrack("B", trackB);
      safeSend({ type: "READY" });
      ctLog("READY 送信");
    });
  }

  // --------------------------------
  // init(): トラック割り当て + TRACKS_LIST 送信
  // --------------------------------
  function init(video) {
    ctLog("init() 開始");
    sendTracksList(video);
    initTracks(video);
  }

  // --------------------------------
  // <video> 要素へのイベント登録
  // --------------------------------
  let currentVideo = null;

  function bindVideoEvents(video) {
    if (currentVideo === video) return;
    currentVideo = video;
    ctLog("新しい video 要素を検出、イベントを登録");

    video.addEventListener("seeked", () => reloadAfterSeek(video));
    ctLog("seeked リスナー登録");

    video.textTracks.addEventListener("addtrack", () => sendTracksList(video));
    ctLog("addtrack リスナー登録");

    // showing トラックの変化を監視してスロットAを更新
    video.textTracks.addEventListener("change", () => notifyShowingTrack(video));
    ctLog("change リスナー登録");

    video.addEventListener("loadedmetadata", () => {
      ctLog(`loadedmetadata: スロットをリセットし init() 再実行 src=${video.src?.slice(-40)}`);
      ["A", "B"].forEach((slot) => {
        if (activeSlots[slot]) detachCueListener(activeSlots[slot]);
        activeSlots[slot] = null;
        if (activateTimers[slot] != null) { clearTimeout(activateTimers[slot]); activateTimers[slot] = null; }
        if (checkTimers[slot] != null) { clearInterval(checkTimers[slot]); checkTimers[slot] = null; }
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
