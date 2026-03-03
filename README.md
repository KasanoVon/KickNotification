# Kick Stream Notifier

Kick.com でフォローしているチャンネルの配信開始をデスクトップ通知でお知らせする Chrome 拡張機能です。

## 機能

- **配信開始通知** — 登録チャンネルのライブ開始を即座にデスクトップ通知
- **フォロー同期** — kick.com のフォロー中チャンネルページから自動取得・一括登録
- **ライブ状況確認** — ポップアップでライブ中チャンネル一覧・視聴者数を表示（ライブ中を上位表示）
- **自動入場** — チャンネルごとに配信開始時に自動でタブを開く設定が可能
- **Kick API 連携** — OAuth 2.1 + PKCE によるログイン対応（Kick Developer アカウント必要）
- **定期チェック** — 1分ごとに配信状態をポーリング、15分ごとにフォロー一覧を自動同期

## インストール

1. このリポジトリをクローン（またはZIPダウンロード）
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」を有効にする
4. 「パッケージ化されていない拡張機能を読み込む」をクリックし、このフォルダを選択

## 使い方

### フォロー中チャンネルを同期する（推奨）

1. kick.com にブラウザでログインした状態で `https://kick.com/following/channels` を開く
2. 拡張機能のポップアップを開き「同期」ボタンをクリック
3. フォロー中チャンネルが自動で登録される

### Kick API でログインする（任意）

Kick Developer Portal で Client ID を取得すると、ブラウザを開かずに API 経由でフォロー同期が可能になります。

1. [kick.com/developers](https://kick.com/developers) でアプリを作成し Client ID を取得
2. ポップアップの設定パネルから「Kick にログイン」をクリック
3. Client ID を入力して認証

### チャンネルを個別管理する

- ポップアップのチャンネル行右の **✕** ボタンで削除
- トグルスイッチで **自動入場** のオン/オフを切り替え

## ファイル構成

```
├── manifest.json       # 拡張機能の設定（Manifest V3）
├── background.js       # Service Worker：API ポーリング・通知・OAuth
├── content.js          # Content Script：kick.com DOM からフォロー一覧を取得
├── popup.html          # ポップアップ UI
├── popup.js            # ポップアップのロジック
├── popup.css           # ポップアップのスタイル
├── icons/              # アイコン画像（16 / 48 / 128px）
└── generate_icons.py   # アイコン生成スクリプト
```

## 必要な権限

| 権限 | 用途 |
|------|------|
| `notifications` | 配信開始のデスクトップ通知 |
| `storage` | チャンネルリスト・ライブ状態の保存 |
| `alarms` | 定期ポーリングのタイマー |
| `tabs` | 自動入場時のタブ操作 |
| `scripting` | フォロー一覧の DOM 取得 |
| `identity` | OAuth 認証フロー |
| `https://kick.com/*` | Kick API へのアクセス |

## 動作環境

- Google Chrome（Manifest V3 対応）
- kick.com へのアクセスが可能なネットワーク環境
