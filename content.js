// v0.14.4
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
//
// v0.14.1 変更:
//   - reloadAfterSeek: cues はあるがシーク先に activeCues が無い場合、
//     track.mode = "hidden" を再代入してブラウザに cuechange 再認識させる（念押し）
//     これにより「cues=33 スキップ → 字幕止まる」バグを修正
//
// v0.14.2 変更:
//   - activateTrack に force 引数（デフォルト false）を追加
//     force=true の場合、過去の cues が残っていても強制的に showing → hidden サイクルを実行
//   - reloadAfterSeek: activeCues が無い場合は force=true で activateTrack を呼び出す
//     これにより大ジャンプシーク後に過去 cues が残っていても新セグメントを取得できるよう修正
//
// v0.14.3 変更:
//   - activateTrack: originalMode を記憶し、サイクル完了後に元の mode へ復元
//     → Apple TV+ のUI字幕設定に干渉しなくなる（画面字幕を独立して制御可能）
//   - activateTrack: force=true 時は disabled → hidden → showing のフルサイクルを経由
//     → HLS セグメント取得トリガーを確実に発生させる
//   - activateTrack: checkTimers によるポーリング（100ms 間隔）を追加
//     → cues 増加を検知したら 2000ms を待たずに早期復元（動的待機）
//     → [時間計測] ログでセグメント取得にかかった実時間を計測可能
//   - checkTimers を追加（activateTimers と同様にスロット単位で管理）
//
// v0.14.4 変更:
//   - activateTrack: originalMode バグ修正
//     復元先を originalMode（呼び出し時の瞬間値）から RESTORE_MODE="hidden" 固定に変更。
//     理由: seeked 連打時に disabled が originalMode に混入し、復元後も
//     cuechange が発火しなくなる（字幕停止）バグを解消するため。
//     hidden は cuechange が発火する最低限のモードであり、画面字幕を表示しない。
//   - activateTrack: showing フェーズ前の待機を 300ms → 0ms に短縮
//     理由: HLS セグメント取得トリガーは disabled の瞬間に発生するため、
//     300ms の待機は不要。これにより画面字幕の一時表示時間を短縮する。
//   - content.css の ::cue 透明化を削除したため、activateTrack の showing 中は
//     Apple TV+ のネイティブ字幕がそのまま表示される（副作用は最小限に抑制済み）。

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

  // スロットごとの activateTrack タイマーID（競合防止）
  const activateTimers = { A: null, B: null };
  // スロットごとのポーリング用インターバルID
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
  // トラックのアクティブ化
  // --------------------------------
  // force=false（デフォルト）: cues があれば mode を維持して終了（初回ロード済み）
  // force=true: disabled → hidden → showing のフルサイクルで HLS セグメント取得を強制。
  //             完了後は RESTORE_MODE="hidden" に復元。
  //             ポーリングにより cues 増加を検知したら 2000ms 前に早期復元する。
  //
  // ★ v0.14.4: originalMode ではなく RESTORE_MODE="hidden" 固定で復元する。
  //   理由: seeked 連打時に track.mode が disabled の瞬間に呼ばれると
  //   originalMode=disabled となり、復元後も cuechange が発火しなくなるため。
  function activateTrack(track, slot, force = false) {
    // ★ 復元先は常に "hidden" 固定（originalMode は使わない）
    const RESTORE_MODE = "hidden";
    ctLog(`activateTrack lang=${track.language} slot=${slot ?? "none"} mode=${track.mode} cues=${track.cues?.length ?? "null"} force=${force} restoreTo=${RESTORE_MODE}`);

    // force=false かつ cues がある場合はセグメント取得済みと判断 → mode 維持
    if (!force && track.cues && track.cues.length > 0) {
      ctLog(`activateTrack: cues あり → mode維持 (cues=${track.cues.length}) lang=${track.language}`);
      return;
    }

    // 前回タイマーキャンセル
    if (slot && activateTimers[slot] != null) {
      clearTimeout(activateTimers[slot]);
      activateTimers[slot] = null;
      ctLog(`activateTrack: 前タイマーキャンセル slot=${slot}`);
    }

    // 前回のポーリングもキャンセル
    if (slot && checkTimers[slot] != null) {
      clearInterval(checkTimers[slot]);
      checkTimers[slot] = null;
    }

    // force=true の場合は disabled を経由して HLS セグメント取得を確実にトリガー
    if (force) {
      track.mode = "disabled";
      ctLog(`activateTrack: disabled 経由 (force) lang=${track.language}`);
    }

    // ★ v0.14.4: 300ms → 0ms に短縮（HLS トリガーは disabled の瞬間に発生するため待機不要）
    const t1 = setTimeout(() => {
      if (force) track.mode = "hidden"; // disabled → hidden の遷移

      // ★ v0.14.4: 100ms → 50ms に短縮（showing への遷移を早める）
      const t2 = setTimeout(() => {
        ctLog(`activateTrack: showing 開始 lang=${track.language} slot=${slot ?? "none"}`);
        track.mode = "showing";

        // ポーリング：100ms ごとに cues 増加を監視し、増えたら早期復元
        const startTime = performance.now();
        const initialCueCount = track.cues ? track.cues.length : 0;

        if (force && slot) {
          checkTimers[slot] = setInterval(() => {
            const currentCueCount = track.cues ? track.cues.length : 0;
            if (currentCueCount > initialCueCount) {
              const elapsed = performance.now() - startTime;
              ctLog(`[時間計測] データ到着: ${elapsed.toFixed(1)}ms (cues: ${initialCueCount} → ${currentCueCount}) slot=${slot}`);

              // データ到着 → 2000ms を待たずに復元
              clearInterval(checkTimers[slot]);
              checkTimers[slot] = null;
              clearTimeout(activateTimers[slot]);
              activateTimers[slot] = null;
              track.mode = RESTORE_MODE; // ★ 常に "hidden" に戻す
              ctLog(`activateTrack: 早期復元 cues=${currentCueCount} lang=${track.language} → ${RESTORE_MODE}`);
            }
          }, 100);
        }

        // 最大 2000ms のタイムアウト（安全装置）
        const t3 = setTimeout(() => {
          if (slot && checkTimers[slot]) {
            clearInterval(checkTimers[slot]);
            checkTimers[slot] = null;
          }
          ctLog(`activateTrack: タイムアウト(2000ms)による復元 cues=${track.cues?.length ?? "null"} lang=${track.language} → ${RESTORE_MODE}`);
          track.mode = RESTORE_MODE; // ★ 常に "hidden" に戻す
          if (slot) activateTimers[slot] = null;
        }, 2000);

        if (slot) activateTimers[slot] = t3;
      }, force ? 50 : 0); // ★ 100ms → 50ms
      if (slot) activateTimers[slot] = t2;
    }, 0); // ★ 300ms → 0ms

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
    activateTrack(track, slot); // force=false（デフォルト）
  }

  // --------------------------------
  // シーク後の再ロード
  // --------------------------------
  function reloadAfterSeek(video) {
    ctLog(`seeked currentTime=${video.currentTime?.toFixed(2)}`);
    ["A", "B"].forEach((slot) => {
      const track = activeSlots[slot];
      if (!track) return;

      const cueCount = track.cues?.length ?? "null";
      const hasActiveCue = track.activeCues && track.activeCues.length > 0;

      ctLog(`seeked slot=${slot} lang=${track.language ?? "none"} cues=${cueCount}`);

      if (!hasActiveCue) {
        // activeCues が無い場合は force=true で強制ロード
        ctLog(`seeked: slot=${slot} activeCues 無し → 強制ロード (force=true)`);
        activateTrack(track, slot, true);
      } else {
        ctLog(`seeked: slot=${slot} cues=${cueCount} activeCues=${track.activeCues.length} スキップ`);
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

    video.addEventListener("loadedmetadata", () => {
      ctLog(`loadedmetadata: スロットをリセットし init() 再実行 src=${video.src?.slice(-40)}`);
      ["A", "B"].forEach((slot) => {
        if (activeSlots[slot]) detachCueListener(activeSlots[slot]);
        activeSlots[slot] = null;
        if (activateTimers[slot] != null) {
          clearTimeout(activateTimers[slot]);
          activateTimers[slot] = null;
        }
        // ポーリングタイマーもリセット
        if (checkTimers[slot] != null) {
          clearInterval(checkTimers[slot]);
          checkTimers[slot] = null;
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
