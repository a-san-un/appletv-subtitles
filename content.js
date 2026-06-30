// v0.10.1
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・送信

(function () {
  // ctLog はコンソールのみに出力する。
  // background.js への DEBUG_LOG 送信は行わない（bgLog がパネルへブロードキャストするため不要）。
  function ctLog(msg) {
    console.log(`[CT ${new Date().toISOString()}] ${msg}`);
  }

  function safeSend(msg) {
    try {
      chrome.runtime.sendMessage(msg);
    } catch (e) {}
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

  function activateTrack(track) {
    ctLog(`activateTrack lang=${track.language} mode=${track.mode} cues=${track.cues?.length ?? 'null'}`);
    if (track.cues && track.cues.length > 0) {
      track.mode = "hidden";
      ctLog(`activateTrack → cuesあり hidden のまま`);
      return;
    }
    if (track.mode === "disabled") track.mode = "hidden";
    setTimeout(() => {
      ctLog(`activateTrack → pulse showing lang=${track.language}`);
      track.mode = "showing";
      setTimeout(() => {
        track.mode = "hidden";
        ctLog(`activateTrack → pulse 完了 hidden に戻す lang=${track.language}`);
      }, 1000);
    }, 300);
  }

  function assignTrack(slot, track) {
    ctLog(`assignTrack slot=${slot} lang=${track.language} mode=${track.mode} cues=${track.cues?.length ?? 'null'}`);
    const prev = activeSlots[slot];
    if (prev && prev !== track) {
      detachCueListener(prev);
      const usedByOther = Object.entries(activeSlots).some(
        ([s, t]) => s !== slot && t === prev,
      );
      if (!usedByOther) prev.mode = "disabled";
    }

    activeSlots[slot] = track;
    attachCueListener(track, slot);
    safeSend({
      type: "TRACK_ATTACHED",
      slot,
      lang: track.language,
      label: formatLabel(track),
    });

    activateTrack(track);
  }

  function reloadAfterSeek() {
    ctLog("seeked 検知、トラック再起動を確認");
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      if (!track) return;
      if (!track.cues || track.cues.length === 0) {
        ctLog(`seeked: slot=${slot} cues空のため activateTrack 再実行`);
        activateTrack(track);
      }
    });
  }

  function getValidTracks(video) {
    const seen = new Map();
    for (const track of video.textTracks) {
      if (!track.language) continue;
      if (track.label.toLowerCase().includes("forced")) continue;
      const key = `${track.language}|${formatLabel(track)}|${track.kind}`;
      const existing = seen.get(key);
      if (!existing || (track.cues && track.cues.length > 0)) {
        seen.set(key, track);
      }
    }
    return [...seen.values()];
  }

  // addtrack イベントを 300ms デバウンスして連続送信を防ぐ
  let tracksListTimer = null;
  function sendTracksList(video) {
    clearTimeout(tracksListTimer);
    tracksListTimer = setTimeout(() => {
      const tracks = getValidTracks(video);
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SELECT_TRACK") return;
    const video = document.querySelector("video");
    if (!video) return;
    const track = getValidTracks(video)[msg.trackIndex];
    if (!track) return;
    ctLog(`SELECT_TRACK 受信 slot=${msg.slot} trackIndex=${msg.trackIndex}`);
    assignTrack(msg.slot, track);
    chrome.storage.sync.set({ [`preferredLang${msg.slot}`]: track.language });
  });

  function initTracks(video) {
    const validTracks = getValidTracks(video);
    ctLog(`initTracks 開始 validTracks=${validTracks.length}`);
    chrome.storage.sync.get(["preferredLangA", "preferredLangB"], (result) => {
      const langA = result.preferredLangA || "en";
      const langB = result.preferredLangB || "ja";
      ctLog(`initTracks langA=${langA} langB=${langB}`);
      const trackA = validTracks.find(
        (t) => t.language === langA && t.kind !== "captions",
      );
      const trackB = validTracks.find(
        (t) => t.language === langB && t.kind !== "captions",
      );
      ctLog(`initTracks trackA=${trackA?.language ?? 'none'} trackB=${trackB?.language ?? 'none'}`);
      if (trackA) assignTrack("A", trackA);
      if (trackB) assignTrack("B", trackB);

      // トラック割り当て完了を sidepanel に通知（ステータスバー更新用）
      safeSend({ type: "READY" });
      ctLog("READY 送信");
    });
  }

  function init(video) {
    ctLog("init() 開始");
    sendTracksList(video);
    initTracks(video);
    video.addEventListener("seeked", reloadAfterSeek);
    video.textTracks.addEventListener("addtrack", () => sendTracksList(video));
  }

  let currentVideo = null;

  function bindVideoEvents(video) {
    if (currentVideo === video) return;
    currentVideo = video;
    ctLog("video 要素を検知、イベントを登録");
    video.addEventListener("loadedmetadata", () => {
      ctLog("loadedmetadata: スロットをリセットし init() 再実行");
      activeSlots.A = null;
      activeSlots.B = null;
      init(video);
    });
    init(video);
  }

  function waitForVideo() {
    const video = document.querySelector("video");
    if (video) {
      ctLog("waitForVideo: video 即時検知");
      bindVideoEvents(video);
    } else {
      ctLog("waitForVideo: video 未検知、MutationObserver 待機中");
      const obs = new MutationObserver(() => {
        const v = document.querySelector("video");
        if (v) {
          ctLog("MutationObserver: video 検知");
          obs.disconnect();
          bindVideoEvents(v);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  waitForVideo();
})();
