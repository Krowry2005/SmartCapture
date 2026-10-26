# Smart Capture

Android / iOS 端末の画面を Windows PC へ低遅延にミラーリング・キャプチャするデスクトップアプリ（Windows 向け）です。
PC クライアント（Electron / TypeScript）と Android クライアント（Kotlin）で構成されます。

- Android: USB（有線）または Wi-Fi（ワイヤレス ADB）。映像 + 内部音声
- iOS (iPhone / iPad): USB 接続・QuickTime 方式（**実験的**、映像のみ）

## 概要 (Overview)

- Android アプリが `MediaProjection` で画面を取得し、H.264 / AAC にエンコードして端末内の TCP サーバー（`127.0.0.1:27183`）で配信します。
- PC アプリは `adb forward` 経由で受信し、WebCodecs でデコードして描画します。Wi-Fi 不要・USB のみで動作します。
- iOS は QuickTime と同じ USB プロトコル（`usb` / libusb）で H.264 を受信します。
- 録画（WebM）、OBS 用キャプチャモード、画質設定に対応しています。

## 主な機能 (Features)

- Android の USB / Wi-Fi 接続（ADB mDNS による自動検出、IP 手入力に対応）
- iOS (iPhone / iPad) の USB ミラーリング（実験的・音声なし）
- USB 接続の低遅延ミラーリング（映像 + 内部音声）
- **接続端末の選択式接続**: 複数台の端末が接続されていても、一覧から 1 台を選んで接続
- **OBS モード**: フレームレスで映像のみのウィンドウ（`Ctrl+Shift+C`）。ウィンドウキャプチャに最適
- **16:9 強制引き伸ばしモード**: 横向き映像を 1920×1080 に引き伸ばし（縦向きでは自動で元の比率に戻る）
- **自動アスペクト比フィット**: 端末の回転や画面サイズ変更に追従し、黒帯なしで表示
- 録画、フルスクリーン（`F11` / `Alt+Enter`）、端末の消音、解像度 / FPS / ビットレート設定

## システム要件 (Requirements)

| 項目 | 内容 |
|---|---|
| OS | Windows 10 / 11 (x64) |
| Node.js | 20 以降（LTS 推奨）と npm |
| Android 端末 | Android 10 (API 29) 以上、**USB デバッグ有効** |
| ADB | Android SDK Platform-Tools（PATH、または環境変数 `ADB_PATH`、または `platform-tools/` に配置） |
| Android ビルド（任意） | Android SDK (compileSdk 34)、JDK 17、Android Studio または Gradle |

## 導入・ビルド手順 (Getting Started)

### 1. PC アプリ

```powershell
git clone https://github.com/Krowry2005/SmartCapture.git
cd SmartCapture
npm install
npm start          # ビルドして開発起動
npm run package    # インストーラー / ポータブル版を release/ に生成
```

`npm run package` はリポジトリ直下の `apk/app-debug.apk`（下記 Android ビルドで生成）と
`platform-tools/`（`adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll`）を同梱します。事前に用意してください。

### 2. Android アプリ

**方法 A: 同梱スクリプト（Windows）**

```powershell
.\build-android.bat     # apk\app-debug.apk を生成
.\install-android.bat   # USB 接続中の端末へインストール
```

**方法 B: Android Studio**

1. Android Studio で `android/` を開き、Gradle 同期を行う
2. 実機（Android 10 以上）を選択して Run

**方法 C: APK を直接インストール**

```powershell
adb install -r apk\app-debug.apk
```

### 3. 使い方

1. 端末で「開発者向けオプション」→「USBデバッグ」を有効にし、USB で PC に接続して許可する
2. `adb devices` で端末が `device` と表示されることを確認
3. Android アプリで「ミラーリング開始」を押して画面キャプチャを許可
4. PC アプリで端末を選び「接続」を押す

USB ケーブルを使わず接続する場合は、待機画面で「Wi-Fi接続」に切り替えます。ADB の mDNS 検出で見つかった端末を選んで「接続」を押すと、`adb connect` の後にミラーリングを開始します。検出されない場合は、Android の「ワイヤレスデバッグ」に表示される IP アドレスと接続ポートを手入力できます。Android 11 以降で初めて使う場合は、開発者向けオプションで「ワイヤレスデバッグ」を有効にし、必要に応じて先に `adb pair IP:ペア設定ポート` でペア設定してください。PC とスマホは同じネットワークに接続してください。

## iPhone / iPad (実験的)

USB 接続の iOS 端末も、QuickTime と同じ USB プロトコルで画面ミラーリングできます（映像のみ、音声は未対応）。

### 事前準備（Windows）

1. 端末のロックを解除して USB 接続し、「このコンピュータを信頼」をタップします（信頼しないと検出・ミラーリングできません）。
2. [Zadig](https://zadig.akeo.ie/) を起動し、`Options` → `List All Devices` を有効にします。
3. 一覧から iPhone / iPad（`Apple iPhone` など）を選び、ドライバーに **WinUSB** を選んで `Replace Driver` / `Install Driver` を実行します。
4. 一覧から `[iOS]` の端末を選び「接続」を押します。

### 注意

- WinUSB へ差し替えると、その端末は iTunes / Apple Devices から認識されなくなることがあります。元に戻すには、デバイスマネージャーでドライバーを削除（Apple のドライバーを再選択）してください。
- 接続中は端末のロックを解除した状態にしてください。
- 実機での動作確認が十分でない実験的機能のため、環境によっては接続に失敗することがあります。

## 操作とショートカット

| 操作 | 内容 |
|---|---|
| 録画 | 「録画開始」で映像と音声を WebM 保存。停止時に保存ダイアログが開く |
| フルスクリーン | `F11` / `Alt+Enter` / 「全画面」ボタン / 画面ダブルクリック |
| OBS モード | 「OBS」ボタンまたは `Ctrl+Shift+C`。枠なしウィンドウでウィンドウキャプチャに最適 |
| 16:9 | 横向き映像のみ 1920×1080 に引き伸ばし。縦向きでは自動で元の比率に戻る |
| 自動消音 | 接続中、端末のメディア音量を 0 にして PC 側でのみ再生（設定で ON/OFF） |
| 画質設定 | 解像度（1080p / 720p / 原寸）、FPS（60 / 30）、ビットレート（8 / 4 / 2 Mbps） |

## トラブルシューティング

- **「adb が見つかりません」**: `platform-tools` に PATH を通すか、環境変数 `ADB_PATH` を設定してください。アプリの案内からフォルダーを手動指定することもできます。
- **「端末に接続できませんでした」**: 先に端末側で「ミラーリング開始」を押してから、PC 側で「接続」を押してください。
- **映像が映らない**: 画面キャプチャの確認ダイアログで「画面全体」を選んでいるか確認してください。
- **「Electron failed to install correctly」**: Node.js 20 / 22 LTS を使用し、`node_modules` を削除して `npm install` をやり直してください。

## ドキュメント

- [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md): 設計・パケット形式・各機能の実装詳細

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照してください。

iOS ミラーリングは [danielpaulus/quicktime_video_hack](https://github.com/danielpaulus/quicktime_video_hack) のプロトコル解析を参考にしています。
