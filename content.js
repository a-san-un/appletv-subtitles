// v0.13.1
// 役割: Apple TV+ の video.textTracks を監視して字幕を取得・ background.js へ送信
//
// 主な処理フロー:
//   1. watchForVideo() で <video> 要素の出現を MutationObserver で監視
//   2. <video> 検出後 init() を呼び出す
//   3. init() が TRACKS_LIST 送信 + preferredLang に基づきトラックを自動割り当て
//   4. 割り当てたトラックに cuechange リスナーを付け SUBTITLE_CUE を送信
//   5. PANEL_INIT 受信時は現在の状態を再送して UI を復元する

(function () {
  function ctLog(msg) {
    const line = `[CT ${new Date().toISOString()}] ${msg}`;
    console.log(line);
    // サイドパネルの DEBUG LOG に転送する
    safeSend({ type: "CT_LOG", line });
  }

  // runtime.sendMessage の失敗を握り潰すラッパー
  // （パネルが閉じているときは接続先がなくてもエラーを出さない）
  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (e) {}
  }

  // --------------------------------
  // トラックラベルの整形
  // --------------------------------
  // Apple TV+ のトラックラベルには「(forced)」「CC」表記が混在する。
  // forced トラック: 外国語セリフのみの字幕（常時表示用）→ フィルタ対象
  // CC (captions): クローズドキャプション（音声説明付き）→ ラベルに CC 付与
  function formatLabel(track) {
    const raw = track.label || "";
    const trimmed = raw.trim();
    const isForced = trimmed.toLowerCase().includes("forced");
    const base = trimmed.replace(/\s*\(forced\)/i, "").trim();
    if (isForced) return `${base} (forced)`;
    if (raw !== trimmed || track.kind === "captions") return `${base} CC`;
    return base;
  }

  // slot A / B に現在割り当て中のトラックを保持する
  const activeSlots = { A: null, B: null };
  // track → cuechange ハンドラ の対応表（WeakMap で GC 安全）
  const listenerMap = new WeakMap();

  // --------------------------------
  // cuechange リスナーの着脱
  // --------------------------------
  function attachCueListener(track, slot) {
    if (listenerMap.has(track)) return; // 二重登録防止
    const handler = () => {
      const cues = [...(track.activeCues || [])];
      if (!cues.length) return;
      // HTML タグを除去してプレーンテキスト化
      const text = cues.map((c) => c.text.replace(/<[^>]*>/g, "")).join("\n");
      ctLog(`cuechange slot=${slot} lang=${track.language} text=${text.slice(0, 30)}`);
      safeSend({
        type: "SUBTITLE_CUE",
        slot,
        lang: track.language,
        label: formatLabel(track),
        text,
        ts: Date.now(), // ペアマッチング用タイムスタンプ
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
  // Apple TV+ の DRM 仕様により、textTrack.mode を一時的に
  // "showing" にしないと VTTCue がロードされない。
  // content.css の ::cue / ::cue-region で画面表示は完全に隠しているため、
  // showing 期間中も字幕・黒帯は画面に出ない。
  // （cues が既にある場合は "hidden" のみで OK）
  function activateTrack(track) {
    ctLog(`activateTrack lang=${track.language} mode=${track.mode} cues=${track.cues?.length ?? "null"}`);
    if (track.cues && track.cues.length > 0) {
      track.mode = "hidden";
      return;
    }
    if (track.mode === "disabled") track.mode = "hidden";
    setTimeout(() => {
      track.mode = "showing";
      setTimeout(() => { track.mode = "hidden"; }, 1000);
    }, 300);
  }

  // スロットにトラックを割り当て、前のトラックのリスナーを解除する
  function assignTrack(slot, track) {
    ctLog(`assignTrack slot=${slot} lang=${track.language}`);
    const prev = activeSlots[slot];
    if (prev && prev !== track) {
      detachCueListener(prev);
      // 他のスロットも同じトラックを使っていなければ disabled に戺す
      const usedByOther = Object.entries(activeSlots).some(([s, t]) => s !== slot && t === prev);
      if (!usedByOther) prev.mode = "disabled";
    }
    activeSlots[slot] = track;
    attachCueListener(track, slot);
    safeSend({ type: "TRACK_ATTACHED", slot, lang: track.language, label: formatLabel(track) });
    activateTrack(track);
  }

  // --------------------------------
  // シーク後の再ロード
  // --------------------------------
  // シーク後は cues が空になることがある。
  // cues が空のスロットだけ activateTrack を再実行して再ロードを促す。
  function reloadAfterSeek() {
    ctLog("シーク後再起動確認");
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      if (track && (!track.cues || track.cues.length === 0)) {
        ctLog(`seeked: slot=${slot} cues空のため activateTrack 再実行`);
        activateTrack(track);
      }
    });
  }

  // --------------------------------
  // 有効トラック一覧の取得
  // --------------------------------
  // Apple TV+ は同一言語のトラックが複数存在することがある。
  // forced トラックを除外し、同一キーは cues のあるものを優先して重複を排除する。
  function getValidTracks(video) {
    const seen = new Map();
    for (const track of video.textTracks) {
      if (!track.language) continue;
      if (track.label.toLowerCase().includes("forced")) continue; // forced を除外
      const key = `${track.language}|${formatLabel(track)}|${track.kind}`;
      const existing = seen.get(key);
      if (!existing || (track.cues && track.cues.length > 0)) seen.set(key, track);
    }
    return [...seen.values()];
  }

  // TRACKS_LIST 送信（300ms デバウンス）
  // addtrack が連続して発火するため、まとめて一回だけ送信する
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
      // ユーザーがセレクトボックスでトラックを選んだ
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
      // パネルが（再）オープンされた → 現在の状態を再送して UI を復元する
      const video = document.querySelector("video");
      if (!video) return;
      ctLog("PANEL_INIT 受信: 現在の状態を再送");
      sendTracksList(video);

      const hasAttached = Object.values(activeSlots).some((t) => t !== null);
      if (hasAttached) {
        // 既にトラックが割り当て済み → TRACK_ATTACHED を再送して UI を復元する
        ["A", "B"].forEach((slot) => {
          const track = activeSlots[slot];
          if (!track) return;
          safeSend({ type: "TRACK_ATTACHED", slot, lang: track.language, label: formatLabel(track) });
        });
        safeSend({ type: "READY" });
        ctLog("PANEL_INIT: 再送完了 (READY 送信)");
      } else {
        // まだ未割り当て → 通常の初期化を実行する
        initTracks(video);
      }
      return;
    }
  });

  // --------------------------------
  // トラックの自動割り当て
  // --------------------------------
  // chrome.storage.sync から preferredLangA / preferredLangB を読み込み、
  // 一致するトラックを自動的に A・B スロットへ割り当てる。
  // （未設定時のデフォルト: A=en / B=ja）
  function initTracks(video) {
    const validTracks = getValidTracks(video);
    ctLog(`initTracks 開始 validTracks=${validTracks.length}`);
    chrome.storage.sync.get(["preferredLangA", "preferredLangB"], (result) => {
      const langA = result.preferredLangA || "en";
      const langB = result.preferredLangB || "ja";
      // CC（captions）より subtitles を優先して選択する
      const trackA = validTracks.find((t) => t.language === langA && t.kind !== "captions");
      const trackB = validTracks.find((t) => t.language === langB && t.kind !== "captions");
      ctLog(`initTracks trackA=${trackA?.language ?? "none"} trackB=${trackB?.language ?? "none"}`);
      if (trackA) assignTrack("A", trackA);
      if (trackB) assignTrack("B", trackB);
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

  // --------------------------------
  // <video> 要素の監視
  // --------------------------------
  // Apple TV+ はエピソード切替時に <video> を作り直すため、
  // MutationObserver で DOM 変化を常時監視して差替えを検出する。
  // loadedmetadata 発火時にスロットをリセットして init() を再実行する。

  let currentVideo = null;

  function bindVideoEvents(video) {
    if (currentVideo === video) return;
    currentVideo = video;
    ctLog("新しい video 要素を検出、イベントを登録");

    video.addEventListener("loadedmetadata", () => {
      ctLog("loadedmetadata: スロットをリセットし init() 再実行");
      // 古いリスナーを解除してクリーンな状態で再初期化する
      ["A", "B"].forEach((slot) => {
        if (activeSlots[slot]) detachCueListener(activeSlots[slot]);
        activeSlots[slot] = null;
      });
      init(video);
    });

    init(video);
  }

  function watchForVideo() {
    // 既存 <video> があれば即バインド
    const v = document.querySelector("video");
    if (v) {
      ctLog("watchForVideo: video 即時検知");
      bindVideoEvents(v);
    }

    // DOM 変化を常時監視して <video> の差替えに対応する
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
