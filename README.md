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

### content.js

Apple TV+ のページに inject されるスクリプト。

- `video.textTracks` を監視してトラック一覧を送信（`TRACKS_LIST`）
- `chrome.storage.sync` から `preferredLangA` / `preferredLangB` を読み込み自動割り当て
- 割り当てたトラックを `showing → hidden` 方式で監視し `cuechange` イベントを捕捉
- 字幕テキストを `SUBTITLE_CUE` として送信
- シーク後にトラックを再ロード

### background.js が中継するメッセージ一覧

| メッセージ       | 方向                | 内容                             |
| ---------------- | ------------------- | -------------------------------- |
| `TRACKS_LIST`    | content → sidepanel | 有効な字幕トラック一覧           |
| `SUBTITLE_CUE`   | content → sidepanel | 字幕テキスト（slot, lang, text） |
| `TRACK_ATTACHED` | content → sidepanel | トラック割り当て完了通知         |
| `SELECT_TRACK`   | sidepanel → content | ユーザーがトラックを選択         |

### sidepanel.html / sidepanel.js / sidepanel.css

サイドパネルの UI。

- トラックリスト受信時にセレクトボックスを自動生成
- `preferredLang` に基づき選択肢を自動ハイライト
- 字幕をリアルタイムに表示 + 履歴リストに追加
- 履歴は A・B ペアで表示（片方のみの場合は保留バッファに待機）

## 字幕の取得方式

Apple TV+ の字幕は VTTCue（`cuechange` イベント）でリアルタイムに発火するため、**再生していない部分の字幕は取得できません**。字幕トラックの `.vtt` ファイルへの直接アクセスも DRM により不可。

トラックを `showing` にしないと cues がロードされないため、`showing → hidden` 方式を採用しています（画面上の字幕表示には影響しません）。

## chrome.storage.sync のキー

| キー             | 内容                                |
| ---------------- | ----------------------------------- |
| `preferredLangA` | スロットAの言語コード（例: `"en"`） |
| `preferredLangB` | スロットBの言語コード（例: `"ja"`） |

## 既知の課題

- 履歴のペア表示：A と B のタイミングがずれる場合にペアが正しく組まれないことがある
- ステータスバーが「起動中」のまま変わらない

## バージョン履歴

| バージョン | 変更内容                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| v0.9.0     | セットアップ画面廃止・未設定方式に変更。preferredLang 自動復元。履歴ペア表示 |
| v0.8.0     | showing → hidden 方式に変更。Port 接続によるメッセージ中継                   |
