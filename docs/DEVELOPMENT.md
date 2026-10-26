# Smart Capture（PCミラーリングアプリ）

Androidスマートフォンの画面と内部音声をUSB経由でWindows PCにミラーリングするデスクトップアプリです。仕様に沿ってPhaseごとに実装します。

## Phase 1: プロジェクトのセットアップ

- Electron + TypeScriptの基本構成
- 安全なpreload経由のIPC通信（`contextIsolation`有効、`nodeIntegration`無効）
- メインプロセスでウィンドウの常時手前表示を切り替える機能
- ウィンドウサイズ変更に対応した初期画面

### 必要環境

- Node.js 20.0.0以降
- npm

### 起動方法

```powershell
npm install
npm start
```

`npm start`はTypeScriptとRendererをビルドしてからElectronアプリを起動します。画面の「手前固定」ボタンで、ウィンドウを常に手前に表示する設定を切り替えられます。

### トラブルシューティング: Electronバイナリが見つからない

`Electron failed to install correctly` と表示される場合、`node_modules\electron\dist\electron.exe` と `path.txt` がありません。Node.js 26では、Electronのインストールスクリプトが展開に失敗しても無言で終了することがあります。

Node.js 20/22 LTSに切り替えるのが確実です。切り替えられない場合は、キャッシュ済みzipを手動で展開します。

```powershell
$z = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v36.9.5-win32-x64.zip" | Select-Object -First 1
Expand-Archive $z.FullName -DestinationPath node_modules\electron\dist -Force
Set-Content -NoNewline -Path node_modules\electron\path.txt -Value electron.exe
```

## Phase 2: Android送信側 (Kotlin)

[android/](./android) に Android Studio プロジェクトを用意しています（minSdk 29 / targetSdk 34）。

- [MirrorService.kt](./android/app/src/main/java/com/smartcapture/app/MirrorService.kt): `MediaProjection` で画面を取得し `MediaCodec` で H.264 にエンコード。`AudioPlaybackCapture` の内部音声を AAC-LC にエンコードし、`127.0.0.1:27183` の TCP サーバーから配信します。
- [MainActivity.kt](./android/app/src/main/java/com/smartcapture/app/MainActivity.kt): 権限（マイク・通知）と画面キャプチャの許可を取得して開始/停止する画面。

### ビルドと実行

1. Android Studio で `android/` を開き、Gradle 同期後に実機（Android 10以上）へインストールします。Gradle Wrapperは含まれないため、Android Studioが生成・同期します。
2. アプリの「ミラーリング開始」を押して許可します。
3. PCアプリの「接続」ボタンを押します（`adb forward` はPhase 3で自動実行されます）。

### ストリームのパケット形式（ビッグエンディアン）

`type: u8 | ptsUs: i64 | size: u32 | payload`

| type | 内容 |
|---|---|
| 0 | 映像コンフィグ（SPS/PPS, Annex B） |
| 1 | 映像フレーム（Annex B） |
| 2 | 映像キーフレーム |
| 3 | 音声コンフィグ（AAC AudioSpecificConfig） |
| 4 | 音声フレーム（AAC raw, 48kHz stereo） |

`ptsUs` は映像・音声共通の基準時刻からのマイクロ秒で、同期再生に使います。接続時にコンフィグとキーフレームを再送するため、PC側はいつでも再接続できます。

### Android APK のビルドとインストール

`build-android.bat` で `apk\app-debug.apk` を作り、`install-android.bat` でUSB接続中のスマホへ上書きインストールします。PC側のexe化は `npm.cmd run package`（出力: `release\`）。詳しくは [README.md](../README.md) を参照してください。

## Phase 3: PC受信・描画

データの流れ: `adb forward` → TCP受信（メイン）→ IPC → デコード・描画（レンダラー）

- [src/mirror.ts](./src/mirror.ts): `execFile` で `adb forward tcp:27183 tcp:27183` を実行し、`127.0.0.1:27183` に接続してパケットを受信します。adb は PATH、または環境変数 `ADB_PATH` で指定します。
- [src/protocol.ts](./src/protocol.ts): TCPのチャンク境界に依存せずヘッダー（type/ptsUs/size）を解析してパケットを切り出す `PacketParser`。不正ヘッダーは切断します。
- [src/preload.ts](./src/preload.ts): `contextBridge` で `connect` / `disconnect` / `onPacket` / `onStatus` だけをレンダラーへ公開します。
- [src/player.ts](./src/player.ts): 映像は `VideoDecoder`（H.264）で復号し、最新フレームだけを `requestAnimationFrame` で canvas に描画します。音声は `AudioDecoder`（AAC-LC）で復号し、`AudioContext` で連続再生します。
- [src/renderer.ts](./src/renderer.ts): 「接続/切断」ボタンとステータス表示。音声の自動再生制限は、接続ボタンのクリック内で `AudioContext` を再開して回避します。

## Phase 4: 録画・フルスクリーン

- **録画**: 「録画 / 停止」ボタンで、canvasの映像と再生中の音声を `MediaRecorder` で録画します。MP4（AAC音声つき）は環境によって `EncodingError` になるため、WebM（VP9 + Opus）で保存します。録画中は赤い「● REC 時:分:秒」のタイマーを表示し、データは一時ファイルへ逐次書き込むため長時間録画でもメモリを圧迫しません。停止すると保存ダイアログが開きます（キャンセルすると録画は破棄されます）。接続が切れた場合も録画を自動停止して保存します。
- **フルスクリーン**: F11 または Alt+Enter、「全画面」ボタン、画面のダブルクリックで切り替えます。全画面中はボタン類を隠します。
- 実装: [src/main.ts](./src/main.ts)（キー処理・ファイル保存）、[src/preload.ts](./src/preload.ts)（IPC公開）、[src/renderer.ts](./src/renderer.ts)（録画UI）、[src/player.ts](./src/player.ts)（録画用の音声ストリーム）。

## Phase 5: 機能拡張（回転追従・OBSキャプチャモード・消音・画質設定）

- **回転追従**: 端末の向きが変わると、Android側がエンコーダーを作り直して新しい解像度のコンフィグを送ります。PC側は canvas のサイズ変化を検知し、ウィンドウの縦横比を映像に合わせます（黒帯なし）。
- **キャプチャモード（OBS用）**: 「OBS」ボタンまたは Ctrl+Shift+C。タイトルバーと録画タイマー・ステータスを消し、映像だけのウィンドウにします。マウスを動かした間だけツールバーが重なって表示されます。ウィンドウはフレームレス（独自の − □ ✕ ボタン）です。
- **表示比率とフィット**: キャンバスはスマホ映像のアスペクト比を維持して中央にフィットし、ウィンドウサイズ変更や端末の回転にも追従します。
- **16:9 引き伸ばし**: キャプチャ画面の「16:9」ボタンを有効にすると、横向き映像だけを 1920×1080 に伸ばします。縦向きに回転すると自動的に元の比率へ戻り、設定は次回起動にも引き継がれます。
- **消音**: 配信中、端末のメディア音量を 0 にします（内部音声のキャプチャは音量0でも取得できることを実機で確認）。配信を止める／切断すると元の音量へ戻します。アプリが強制終了した場合は音量が0のまま残ることがあります。設定の「スマホを消音」で無効にできます。
- **画質設定**: 「設定」パネルで解像度（1080p=長辺1920 / 720p=長辺1280 / スマホ原寸）、フレームレート（60/30）、ビットレート（8/4/2 Mbps）を選びます。変更すると自動で再接続して反映します（録画中は次回接続から）。
- **制御パケット（PC→Android、接続直後に1回・12バイト・ビッグエンディアン）**: `"MRCF"` | longEdge: u16（0=原寸）| fps: u8 | flags: u8（bit0=端末を消音）| bitRate: u32。Android側は3秒以内に届かなければ既定値（1920 / 60fps / 8Mbps / 消音なし）で配信します。実装: [src/protocol.ts](./src/protocol.ts)、Android側 `StreamSettings.kt`。
- Android側は `VirtualDisplay` を1回だけ作り、接続ごとにエンコーダーと解像度を差し替えるため、再接続時に画面キャプチャの許可ダイアログは再表示されません。

## 今後の実装

すべてのPhaseを実装済みです。
