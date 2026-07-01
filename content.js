// v0.16.0
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
//      cues ロードのため showing → hidden サイクルを使用
//      activatingSlotB フラグで change イベントを抑制しスロットAに干渉しない
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

  let activatingSlotB = false;
  let notifyTimer = null;

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

  function activateTrack(track, slot, force = false) {
    ctLog(`activateTrack lang=${track.language} slot=${slot} mode=${track.mode} cues=${track.cues?.length ?? "null"} force=${force}`);

    if (slot && activateTimers[slot] != null) {
      clearTimeout(activateTimers[slot]);
      activateTimers[slot] = null;
    }

    if (!force && track.cues && track.cues.length > 0) {
      if (track.mode !== "hidden") {
        track.mode = "hidden";
        ctLog(`activateTrack: cues あり → hidden にセット (cues=${track.cues.length})`);
      }
      return;
    }

    activatingSlotB = true;
    track.mode = "showing";
    ctLog(`activateTrack: showing → hidden サイクル開始 lang=${track.language} force=${force}`);

    const t1 = setTimeout(() => {
      track.mode = "hidden";
      activatingSlotB = false;
      ctLog(`activateTrack: hidden にセット lang=${track.language} cues=${track.cues?.length ?? "null"}`);
      if (slot) activateTimers[slot] = null;
    }, 50);
    if (slot) activateTimers[slot] = t1;
  }

  function assignTrack(slot, track) {
    ctLog(`assignTrack slot=${slot} lang=${track.language}`);
    const prev = activeSlots[slot];
    if (prev && prev !== track) {
      detachCueListener(prev);
      if (slot === "B") {
        const usedByOther = Object.entries(activeSlots).some(([s, t]) => s !== slot && t === prev);
        if (!usedByOther) prev.mode = "disabled";
      }
    }
    activeSlots[slot] = track;
    attachCueListener(track, slot);
    safeSend({ type: "TRACK_ATTACHED", slot, lang: track.language, label: formatLabel(track) });
    if (slot === "B") activateTrack(track, slot);
  }

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

  function getShowingTrack(video) {
    for (const track of video.textTracks) {
      if (
        track.mode === "showing" &&
        track.kind !== "captions" &&
        !track.label.toLowerCase().includes("forced") &&
        track !== activeSlots["B"]
      ) {
        return track;
      }
    }
    return null;
  }

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

  function notifyShowingTrack(video) {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
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
    }, 100);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SELECT_TRACK") {
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

  function initTracks(video) {
    const validTracks = getValidTracks(video);
    ctLog(`initTracks 開始 validTracks=${validTracks.length}`);

    notifyShowingTrack(video);

    chrome.storage.sync.get(["preferredLangB"], (result) => {
      const langB = result.preferredLangB || "ja";
      const trackB = validTracks.find((t) => t.language === langB);
      ctLog(`initTracks trackB=${trackB?.language ?? "none"}`);
      if (trackB) assignTrack("B", trackB);
      safeSend({ type: "READY" });
      ctLog("READY 送信");
    });
  }

  function init(video) {
    ctLog("init() 開始");
    sendTracksList(video);
    initTracks(video);
  }

  let currentVideo = null;

  function bindVideoEvents(video) {
    if (currentVideo === video) return;
    currentVideo = video;
    ctLog("新しい video 要素を検出、イベントを登録");

    video.addEventListener("seeked", () => reloadAfterSeek(video));
    ctLog("seeked リスナー登録");

    video.textTracks.addEventListener("addtrack", () => sendTracksList(video));
    ctLog("addtrack リスナー登録");

    video.textTracks.addEventListener("change", () => {
      if (activatingSlotB) {
        ctLog("change イベント: activatingSlotB=true → スキップ");
        return;
      }
      notifyShowingTrack(video);
    });
    ctLog("change リスナー登録");

    video.addEventListener("loadedmetadata", () => {
      ctLog(`loadedmetadata: スロットをリセットし init() 再実行 src=${video.src?.slice(-40)}`);
      activatingSlotB = false;
      clearTimeout(notifyTimer);
      notifyTimer = null;
      ["A", "B"].forEach((slot) => {
        if (activeSlots[slot]) detachCueListener(activeSlots[slot]);
        activeSlots[slot] = null;
        if (activateTimers[slot] != null) { clearTimeout(activateTimers[slot]); activateTimers[slot] = null; }
      });
      init(video);
    });

    init(video);
  }

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
