// v0.9.2
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・送信
//
// [v0.9.2 変更点]
// - スロットに割り当てたトラックは常に hidden で運用する
//   → hidden でも cuechange は発火する。disabled のときのみ発火しない
//   → 画面字幕 on/off に関わらずサイドパネルに常に表示される
//   → ユーザーが画面字幕を showing にしていても、拡張機能側は hidden に落とす
//     (画面字幕は Apple TV+ のネイティブUIで別途制御することを前提とする)
// - showing パルスは disabled → hidden に昇格する場合のみ使用する
//   → cues の初回ロードに必要。パルス後は常に hidden に戻す
// - reloadAfterSeek() も同様に disabled のトラックのみパルスする
// - originalModeMap を削除（不要になったため）

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

  // disabled のトラックに対して showing パルスを打って cues をロードさせ、
  // パルス後は常に hidden に戻す。
  // hidden / showing のトラックはそのまま hidden に落とすだけで良い。
  function activateTrack(track) {
    if (track.mode === "disabled") {
      // disabled → hidden に昇格したうえでパルス
      track.mode = "hidden";
      setTimeout(() => {
        track.mode = "showing";
        setTimeout(() => {
          track.mode = "hidden";
        }, 1000);
      }, 300);
    } else {
      // hidden または showing → 常に hidden に落とす
      track.mode = "hidden";
    }
  }

  function assignTrack(slot, track) {
    const prev = activeSlots[slot];
    if (prev && prev !== track) {
      detachCueListener(prev);
      const usedByOther = Object.entries(activeSlots).some(
        ([s, t]) => s !== slot && t === prev,
      );
      // 他のスロットで使っていなければ disabled に戻す
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
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      if (!track) return;
      // シーク後に disabled に落ちている場合のみ再起動
      if (track.mode === "disabled") {
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
