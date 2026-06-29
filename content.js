// v0.9.1
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・送信
//
// [v0.9.1 変更点]
// - assignTrack(): パルス前に元の mode を記憶し、パルス後に必ず復元する
//   → ユーザーが画面字幕をオンにしていた場合に消えたままになる問題を修正
// - reloadAfterSeek(): cues が既にロード済みのトラックはパルス不要なのでスキップ
//   → シーク後に不要な mode 操作が画面字幕に影響していた問題を修正
// - assignTrack(): 前のトラックを解除する際、showing 中なら showing のまま戻す
//   → スロット切り替え時に画面字幕が消える問題を修正

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

  // 各トラックの「拡張機能が触る前の本来の mode」を記憶する
  // Apple TV+ がセットした mode を上書きしないための保険
  const originalModeMap = new WeakMap();

  function rememberOriginalMode(track) {
    if (!originalModeMap.has(track)) {
      originalModeMap.set(track, track.mode);
    }
  }

  function getOriginalMode(track) {
    // 記憶がなければ現在の mode をそのまま返す
    return originalModeMap.get(track) ?? track.mode;
  }

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
      if (!usedByOther) {
        // 前のトラックを解除する際も元の mode に戻す
        prev.mode = getOriginalMode(prev);
      }
    }

    // パルスを当てる前に元の mode を記憶する
    rememberOriginalMode(track);
    const modeToRestore = getOriginalMode(track);

    activeSlots[slot] = track;
    attachCueListener(track, slot);
    safeSend({
      type: "TRACK_ATTACHED",
      slot,
      lang: track.language,
      label: formatLabel(track),
    });

    // cues が既にロード済みならパルス不要（初回のみパルスが必要）
    if (track.cues && track.cues.length > 0) return;

    // cues 未ロード → showing パルスで cues をロードする
    // パルス後は必ず元の mode（modeToRestore）に戻す
    if (track.mode === "disabled") track.mode = "hidden";
    setTimeout(() => {
      track.mode = "showing";
      setTimeout(() => {
        track.mode = modeToRestore;
      }, 1000);
    }, 300);
  }

  function reloadAfterSeek() {
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      if (!track) return;

      // cues が既にロード済みならシーク後のパルスは不要
      if (track.cues && track.cues.length > 0) return;

      // cues が未ロード（まれなケース）の場合のみパルスを打つ
      const modeToRestore = getOriginalMode(track);
      track.mode = "showing";
      setTimeout(() => {
        track.mode = modeToRestore;
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
    video.addEventListener("loadedmetadata\", () => {
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
