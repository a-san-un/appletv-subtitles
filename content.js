// v0.9.0
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・送信

(function () {
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

  function assignTrack(slot, track) {
    const prev = activeSlots[slot];
    if (prev) {
      detachCueListener(prev);
      const usedByOther = Object.entries(activeSlots).some(
        ([s, t]) => s !== slot && t === prev,
      );
      if (!usedByOther) prev.mode = "hidden";
    }
    activeSlots[slot] = track;
    attachCueListener(track, slot);
    safeSend({
      type: "TRACK_ATTACHED",
      slot,
      lang: track.language,
      label: formatLabel(track),
    });

    if (track.mode === "disabled") track.mode = "hidden";
    setTimeout(() => {
      track.mode = "showing";
      setTimeout(() => {
        track.mode = "hidden";
      }, 1000);
    }, 300);
  }

  function reloadAfterSeek() {
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      if (!track) return;
      track.mode = "showing";
      setTimeout(() => {
        track.mode = "hidden";
      }, 1000);
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

  function sendTracksList(video) {
    const tracks = getValidTracks(video);
    safeSend({
      type: "TRACKS_LIST",
      tracks: tracks.map((t, i) => ({
        index: i,
        language: t.language,
        label: formatLabel(t),
        kind: t.kind,
      })),
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SELECT_TRACK") return;
    const video = document.querySelector("video");
    if (!video) return;
    const track = getValidTracks(video)[msg.trackIndex];
    if (!track) return;
    assignTrack(msg.slot, track);
    chrome.storage.sync.set({ [`preferredLang${msg.slot}`]: track.language });
  });

  function initTracks(video) {
    const validTracks = getValidTracks(video);

    // ▼ setupDone チェック削除。preferredLang がなければ en/ja をデフォルトに
    chrome.storage.sync.get(["preferredLangA", "preferredLangB"], (result) => {
      const langA = result.preferredLangA || "en";
      const langB = result.preferredLangB || "ja";

      const trackA = validTracks.find(
        (t) => t.language === langA && t.kind !== "captions",
      );
      const trackB = validTracks.find(
        (t) => t.language === langB && t.kind !== "captions",
      );
      if (trackA) assignTrack("A", trackA);
      if (trackB) assignTrack("B", trackB);
    });
  }

  function init(video) {
    sendTracksList(video);
    initTracks(video);
    video.addEventListener("seeked", reloadAfterSeek);
    video.textTracks.addEventListener("addtrack", () => sendTracksList(video));
  }

  let currentVideo = null;

  function bindVideoEvents(video) {
    if (currentVideo === video) return;
    currentVideo = video;
    video.addEventListener("loadedmetadata", () => {
      activeSlots.A = null;
      activeSlots.B = null;
      init(video);
    });
    init(video);
  }

  function waitForVideo() {
    const video = document.querySelector("video");
    if (video) {
      bindVideoEvents(video);
    } else {
      const obs = new MutationObserver(() => {
        const v = document.querySelector("video");
        if (v) {
          obs.disconnect();
          bindVideoEvents(v);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }

  waitForVideo();
})();
