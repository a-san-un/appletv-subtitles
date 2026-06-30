# Apple TV+ Subtitle Panel

Chrome 拡張機能。Apple TV+ の動画再生中に2言語の字幕をサイドパネルに並べて表示します。

## 機能

- 2スロット（A・B）で異なる言語の字幕を同時表示
- 動画再生開始時に字幕トラックを自動検出・自動割り当て
- 選択した言語を記憶して次回以降も自動適用
- A・B をペアにして履歴表示（英語 → 日本語の順）
- 字幕更新の一時停止（freeze）・履歴クリア

## ファイル構成

```
.
├── manifest.json
├── background.js
├── content.js
├── sidepanel.html
├── sidepanel.js
└── sidepanel.css
```

## 各ファイルの役割

### manifest.json

拡張機能の設定ファイル。`storage` / `sidePanel` / `tabs` パーミッションを宣言。

### background.js

Service Worker。サイドパネル（Port接続）と content.js（runtime.sendMessage）の間でメッセージを中継する。

```
content.js  →  runtime.sendMessage  →  background.js
                                              ↓
sidepanel.js  ←  port.postMessage  ←  background.js
```

サイドパネルが閉じている間に受信したメッセージはキュー（最大50件）に蓄積し、
再オープン時（`PANEL_INIT`）に一括送出する。

### content.js

Apple TV+ のページに inject されるスクリプト。

- `video.textTracks` を監視してトラック一覧を送信（`TRACKS_LIST`）
- `chrome.storage.sync` から `preferredLangA` / `preferredLangB` を読み込み自動割り当て
- 割り当てたトラックを `showing → hidden` 方式で監視し `cuechange` イベントを捕捉
- 字幕テキストを `SUBTITLE_CUE` として送信（`ts` でペアマッチング用タイムスタンプ付き）
- シーク後に cues が空になったトラックを再ロード
- `PANEL_INIT` 受信時は現在の状態（`TRACKS_LIST` / `TRACK_ATTACHED` / `READY`）を再送

### background.js が中継するメッセージ一覧

| メッセージ       | 方向                | 内容                                   |
| ---------------- | ------------------- | -------------------------------------- |
| `PANEL_INIT`     | sidepanel → bg → content | パネル起動・再オープン通知。bg はキューを送出し content に転送する |
| `TRACKS_LIST`    | content → sidepanel | 有効な字幕トラック一覧                 |
| `TRACK_ATTACHED` | content → sidepanel | トラック割り当て完了通知               |
| `READY`          | content → sidepanel | 初期化完了通知                         |
| `SUBTITLE_CUE`   | content → sidepanel | 字幕テキスト（slot, lang, text, ts）   |
| `SELECT_TRACK`   | sidepanel → content | ユーザーがトラックを選択               |

### sidepanel.html / sidepanel.js / sidepanel.css

サイドパネルの UI。

- 起動時に `PANEL_INIT` を background.js へ送信してルーティングを登録する
- トラックリスト受信時にセレクトボックスを自動生成
- `preferredLang` に基づき選択肢を自動ハイライト（CC より subtitles を優先）
- 字幕をリアルタイムに表示 + 履歴リストに追加
- 履歴は A・B のペア表示（`ts` 差が `PAIR_MATCH_MS` 以内ならペア化）

## Apple TV+ の字幕仕様

### 字幕の取得方式

Apple TV+ の字幕は VTTCue（`cuechange` イベント）でリアルタイムに発火する。
そのため **再生していない部分の字幕は取得できない**。`.vtt` ファイルへの直接アクセスも DRM により不可。

トラックを `showing` にしないと cues がロードされないため **`showing → hidden` 方式**を採用している
（約 1 秒後に `hidden` に戻すため、画面上の字幕表示には影響しない）。

### テキストトラックの種類

Apple TV+ には同一言語のトラックが複数存在することがある。

| kind | 説明 | 本拡張での扱い |
| --- | --- | --- |
| `subtitles` | 通常の字幕 | 優先して使用 |
| `captions` | クローズドキャプション（音声説明付き） | `subtitles` がある場合は非優先。ラベルに `CC` を付与 |
| `forced`    | 外国語セリフのみを表示する常時字幕 | 一覧・自動割り当てから除外 |

### video.textTracks の動的生成

Apple TV+ はページ読み込み直後に `textTracks` が空の場合がある。
`addtrack` イベントをリッスンして、トラックが追加されるたびに `TRACKS_LIST` を再送する（300ms デバウンス）。

エピソード切替時は `<video>` 要素自体が作り直されるため、`MutationObserver` で DOM 変化を常時監視している。
新しい `<video>` を検出したら `loadedmetadata` を待ってスロットをリセット・再初期化する。

### シーク後の再ロード

シーク後は `cues` が空になるトラックがある。
`seeked` イベントを検知し、cues が空になったスロットのみ `activateTrack` を再実行して再ロードを促す。

### DRM 制約まとめ

| 制約 | 内容 |
| --- | --- |
| `.vtt` 直接取得 | 不可（DRM 保護） |
| 過去字幕の取得 | 不可（再生済み部分は遡れない） |
| `disabled` トラックの cues | ロードされない（`showing` が必要） |

## 実装予定の機能

### 辞書機能

字幕テキスト内の単語をクリックまたはタップしたときに、単語の意味・発音・品詞をポップアップ表示する機能。

**実装方針**

- `sidepanel.js` の字幕表示エリアで `mouseup` / `selectionchange` イベントを監視し、選択テキストを取得する
- 取得した単語を外部辞書 API（例: [Free Dictionary API](https://dictionaryapi.dev/)）へリクエストする
- 結果（定義・品詞・発音記号・音声）をポップアップまたはインライン展開で表示する
- API キーが不要な無料 API を優先し、必要に応じて `chrome.storage.sync` でユーザー独自キーを保存できるようにする

**追加が必要なパーミッション（manifest.json）**

```json
"host_permissions": ["https://api.dictionaryapi.dev/*"]
```

**候補 API**

| API | 料金 | 特徴 |
| --- | --- | --- |
| [Free Dictionary API](https://dictionaryapi.dev/) | 無料・キー不要 | 英語のみ。定義・品詞・音声 URL 付き |
| [Merriam-Webster API](https://dictionaryapi.com/) | 無料枠あり | 英語。APIキー必要 |
| [Jisho API](https://jisho.org/api/v1/) | 無料・キー不要 | 日英辞書。日本語学習向け |

---

### AI 翻訳機能

字幕スロット A（英語）の内容を自動で翻訳してスロット B に表示、または履歴ペアに翻訳を添えて表示する機能。
Apple TV+ に日本語字幕トラックがない作品でも対訳を見られるようにすることを目的とする。

**実装方針**

- `SUBTITLE_CUE` を `sidepanel.js` で受信したタイミングで翻訳 API を呼び出す
- 翻訳結果を擬似スロット（`slot: "B-translated"` など）として履歴に追加する
- 翻訳のオン/オフをトグルボタンで切り替えられるようにする
- API キーは `chrome.storage.sync` に保存し、設定画面（サイドパネル内）から入力できるようにする
- レート制限対策として、同一テキストの翻訳結果はセッション内でキャッシュする

**追加が必要なパーミッション（manifest.json）**

```json
"host_permissions": [
  "https://api.openai.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://api-free.deepl.com/*"
]
```

**候補 API**

| API | 料金 | 特徴 |
| --- | --- | --- |
| [DeepL API Free](https://www.deepl.com/pro-api) | 月50万字まで無料 | 高精度。APIキー必要 |
| [Google Gemini API](https://ai.google.dev/) | 無料枠あり | 文脈を考慮した翻訳が可能。APIキー必要 |
| [OpenAI API](https://platform.openai.com/) | 従量課金 | GPT-4o-mini で安価に高品質な翻訳 |

**実装時の注意点**

- 字幕は短い断片（1〜2文）で頻繁に届くため、翻訳リクエストのデバウンス（200〜300ms）が必要
- 翻訳結果が字幕より遅れて届くことがあるため、対応する元テキストと紐付けて表示する（`ts` を利用）
- Chrome 拡張機能では `fetch()` による外部 API 呼び出しは Service Worker（background.js）経由で行う方が CORS 問題を回避しやすい

## chrome.storage.sync のキー

| キー             | 内容                                |
| ---------------- | ----------------------------------- |
| `preferredLangA` | スロットAの言語コード（例: `"en"`） |
| `preferredLangB` | スロットBの言語コード（例: `"ja"`） |

> **リセット方法**: Chrome の拡張機能ページ → Service Worker コンソールで
> `chrome.storage.sync.remove("preferredLangA")` などを実行する。

## 既知の課題

| # | 課題 | 状況 |
| --- | --- | --- |
| 1 | ペアタイムアウト値の調整 | `PAIR_TIMEOUT_MS` / `PAIR_MATCH_MS` を要調整 |
| 2 | `forced` 字幕の混入 | 除外ロジックあり、稀にすり抜ける可能性 |
| 3 | `pulse showing` の画面干渉 | `activateTrack` の showing 期間中に字幕が一瞬表示される可能性 |

## バージョン履歴

| バージョン | 変更内容                                                                          |
| ---------- | --------------------------------------------------------------------------------- |
| v0.12.0    | コメント整備・README 更新（Apple TV+ 仕様・既知の課題・辞書/AI翻訳実装計画）     |
| v0.11.0    | ペアマッチング ts 方式・setStatus 整理                                            |
| v0.10.0    | PANEL_INIT 再送フロー・キューモード実装                                           |
| v0.9.0     | セットアップ画面廃止・未設定方式に変更。preferredLang 自動復元。履歴ペア表示      |
| v0.8.0     | showing → hidden 方式に変更。Port 接続によるメッセージ中継                        |
