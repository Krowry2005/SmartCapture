import { MirrorPlayer } from "./player";
import { PacketType } from "./protocol";

type ConnectResult = { ok: boolean; code?: string; message?: string };
type ListResult =
  | {
      ok: true;
      devices: { serial: string; state: string; model: string }[];
      iosDevices: { udid: string; name: string; state: "device" | "untrusted" | "unknown" }[];
      iosWarning?: string;
      wifiDevices: { serial: string; name: string; connected: boolean }[];
    }
  | { ok: false; code: string; message: string };

declare global {
  interface Window {
    mirroringApp: {
      getAlwaysOnTop: () => Promise<boolean>;
      toggleAlwaysOnTop: () => Promise<boolean>;
      connect: (settings: unknown, serial?: string) => Promise<ConnectResult>;
      listDevices: () => Promise<ListResult>;
      connectWifi: (address: string) => Promise<{ ok: boolean; serial?: string; message: string }>;
      installApk: (
        serial: string
      ) => Promise<{ status: "installed" | "up-to-date" | "no-apk" | "failed"; message: string }>;
      setCaptureMode: (enabled: boolean) => Promise<boolean>;
      setVideoSize: (width: number, height: number) => Promise<void>;
      setView: (view: "idle" | "active") => Promise<void>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      closeWindow: () => Promise<void>;
      disconnect: () => Promise<void>;
      onPacket: (callback: (packet: { type: number; ptsUs: number; payload: Uint8Array }) => void) => void;
      onStatus: (callback: (status: { state: "connected" | "disconnected"; message: string }) => void) => void;
      toggleFullScreen: () => Promise<boolean>;
      onFullScreenChange: (callback: (enabled: boolean) => void) => void;
      startRecording: (extension: string) => Promise<void>;
      writeRecordingChunk: (chunk: Uint8Array) => Promise<void>;
      stopRecording: () => Promise<{ saved: boolean; path?: string; message?: string }>;
    };
  }
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const alwaysOnTopButton = $<HTMLButtonElement>("#always-on-top");
const status = $<HTMLElement>("#status");
const connectButton = $<HTMLButtonElement>("#connect");
const disconnectButton = $<HTMLButtonElement>("#disconnect");
const recordButton = $<HTMLButtonElement>("#record");
const recordTimer = $<HTMLElement>("#record-timer");
const fullscreenButton = $<HTMLButtonElement>("#fullscreen");
const stretchButton = $<HTMLButtonElement>("#stretch");
const canvas = $<HTMLCanvasElement>("#screen");
const thumbCanvas = $<HTMLCanvasElement>("#thumb");
const thumbWrap = $<HTMLElement>("#thumb-wrap");
const deviceSelect = $<HTMLSelectElement>("#device");
const wifiDeviceSelect = $<HTMLSelectElement>("#wifi-device");
const usbModeButton = $<HTMLButtonElement>("#mode-usb");
const wifiModeButton = $<HTMLButtonElement>("#mode-wifi");
const usbDevicePanel = $<HTMLElement>("#usb-device-panel");
const wifiDevicePanel = $<HTMLElement>("#wifi-device-panel");
const rescanButton = $<HTMLButtonElement>("#rescan");
const rescanWifiButton = $<HTMLButtonElement>("#rescan-wifi");
const wifiForm = $<HTMLFormElement>("#wifi-connect-form");
const wifiAddressInput = $<HTMLInputElement>("#wifi-address");
const wifiConnectButton = $<HTMLButtonElement>("#wifi-connect");

let stretchLandscape = false;
const player = new MirrorPlayer(
  canvas,
  (message) => {
    status.textContent = message;
  },
  (width, height) => void window.mirroringApp.setVideoSize(width, height)
);
// サムネイル用。ウィンドウ比率には影響させず、音声は再生しない
const thumbPlayer = new MirrorPlayer(thumbCanvas, () => undefined);

// ---- 画面モード ----
// idle:   待機画面 (端末選択 / サムネイル / 設定 / 接続)
// active: キャプチャ画面 (実映像・録画・OBS・全画面)
type View = "idle" | "active";
// 端末とのストリーム接続の用途。none の間に届いたパケットは古い接続のものとして捨てる
type Link = "none" | "preview" | "main";

let view: View = "idle";
let link: Link = "none";
// 端末の選択が変わるたびに増やし、古い非同期処理の結果を無効にする
let epoch = 0;

function setView(next: View): void {
  if (view === next) return;
  view = next;
  document.body.classList.toggle("view-idle", next === "idle");
  document.body.classList.toggle("view-active", next === "active");
  recordButton.disabled = next !== "active" && !recorder;
  void window.mirroringApp.setView(next);
  if (next === "active") setConnectRequested(false);
  else if (captureMode) void setCaptureMode(false);
}

// ---- 設定 (解像度 / FPS / ビットレート / 消音) ----
interface Settings {
  longEdge: number;
  fps: number;
  bitRate: number;
  muteDevice: boolean;
  stretchLandscape: boolean;
}

const SETTINGS_KEY = "mirror-settings";
const WIFI_ADDRESS_KEY = "wifi-adb-address";
const resolutionSelect = $<HTMLSelectElement>("#set-resolution");
const fpsSelect = $<HTMLSelectElement>("#set-fps");
const bitrateSelect = $<HTMLSelectElement>("#set-bitrate");
const muteCheckbox = $<HTMLInputElement>("#set-mute");

function loadSettings(): void {
  resolutionSelect.value = "1920";
  fpsSelect.value = "60";
  bitrateSelect.value = "8000000";
  muteCheckbox.checked = true;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    if (!saved) return;
    resolutionSelect.value = String(saved.longEdge);
    fpsSelect.value = String(saved.fps);
    bitrateSelect.value = String(saved.bitRate);
    muteCheckbox.checked = saved.muteDevice !== false;
    stretchLandscape = saved.stretchLandscape === true;
  } catch {
    // 壊れた保存値は既定値のまま使う
  }
  // 候補にない値が入った場合は選択が空になるので既定値へ戻す
  if (!resolutionSelect.value) resolutionSelect.value = "1920";
  if (!fpsSelect.value) fpsSelect.value = "60";
  if (!bitrateSelect.value) bitrateSelect.value = "8000000";
}

function currentSettings(): Settings {
  return {
    longEdge: Number(resolutionSelect.value),
    fps: Number(fpsSelect.value),
    bitRate: Number(bitrateSelect.value),
    muteDevice: muteCheckbox.checked,
    stretchLandscape
  };
}

// サムネイルは軽量設定で受信し、端末の音量は変えない
const PREVIEW_SETTINGS: Settings = {
  longEdge: 1280,
  fps: 30,
  bitRate: 2_000_000,
  muteDevice: false,
  stretchLandscape: false
};

loadSettings();
wifiAddressInput.value = localStorage.getItem(WIFI_ADDRESS_KEY) ?? "";
player.setLandscapeStretch(stretchLandscape);
stretchButton.classList.toggle("on", stretchLandscape);
stretchButton.setAttribute("aria-pressed", String(stretchLandscape));
for (const control of [resolutionSelect, fpsSelect, bitrateSelect, muteCheckbox]) {
  // 設定は接続時にだけ端末へ送る。待機画面で変えた内容は次の「接続」から反映される
  control.addEventListener("change", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
  });
}
stretchButton.addEventListener("click", () => {
  stretchLandscape = !stretchLandscape;
  player.setLandscapeStretch(stretchLandscape);
  stretchButton.classList.toggle("on", stretchLandscape);
  stretchButton.setAttribute("aria-pressed", String(stretchLandscape));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings()));
});

// ---- 待機画面: 端末検索・プレビュー・接続 ----
const RETRY_INTERVAL_MS = 3000;
const WAITING_MESSAGE = "接続待機中… (スマホ側で「ミラーリング開始」を押してください)";
const PREVIEW_HINT = "スマホで「ミラーリング開始」を押すとプレビューが表示されます。";

interface Device {
  serial: string;
  state: string;
  model: string;
}

let selectedSerial = "";
let selectedWifiSerial = "";
type ConnectionMode = "usb" | "wifi";
let connectionMode: ConnectionMode = "usb";
let connectRequested = false;
let pollEnabled = true;
let attempting = false;
let pendingRun = false;
let retryTimer: number | null = null;
let lastSignature = "";
let previewLive = false;

function setConnectRequested(value: boolean): void {
  connectRequested = value;
  connectButton.textContent = value ? "接続を待機中… (クリックで中止)" : "接続";
  connectButton.classList.toggle("waiting", value);
}

function cancelRetry(): void {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(): void {
  cancelRetry();
  if (!pollEnabled || view !== "idle") return;
  retryTimer = window.setTimeout(() => void tick(), RETRY_INTERVAL_MS);
}

function deviceLabel(device: Device): string {
  const name = device.model ? `${device.model} (${device.serial})` : device.serial;
  return `[Android] ${device.state === "device" ? name : `${name} [${device.state}]`}`;
}

interface IosDeviceInfo {
  udid: string;
  name: string;
  state: "device" | "untrusted" | "unknown";
}

// iOS は QuickTime USB 方式 (実験的)。プレビューは行わず「接続」で開始する
function iosLabel(device: IosDeviceInfo): string {
  const name = device.name ? `${device.name} (${device.udid})` : device.udid;
  const note = device.state === "untrusted" ? "未承認: 端末で「信頼」をタップ" : "ミラーリング対応(実験的)";
  return `[iOS] ${name} [${note}]`;
}

function renderDevices(devices: Device[], iosDevices: IosDeviceInfo[]): void {
  deviceSelect.replaceChildren();
  const usbDevices = devices.filter((device) => !device.serial.includes(":"));
  const total = usbDevices.length + iosDevices.length;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = total ? "端末を選択…" : "接続中の端末がありません";
  deviceSelect.append(placeholder);
  for (const device of usbDevices) {
    const option = document.createElement("option");
    option.value = device.serial;
    option.textContent = deviceLabel(device);
    option.disabled = device.state !== "device";
    deviceSelect.append(option);
  }
  for (const device of iosDevices) {
    const option = document.createElement("option");
    option.value = `ios:${device.udid}`;
    option.textContent = iosLabel(device);
    option.disabled = device.state === "untrusted";
    deviceSelect.append(option);
  }
  const selectable = [...usbDevices.map((d) => d.serial), ...iosDevices.map((d) => `ios:${d.udid}`)];
  deviceSelect.value = selectable.includes(selectedSerial) ? selectedSerial : "";
}

function renderWifiDevices(
  services: { serial: string; name: string; connected: boolean }[],
  devices: Device[]
): void {
  wifiDeviceSelect.replaceChildren();
  const discovered = new Map(services.map((service) => [service.serial, service]));
  for (const device of devices.filter((item) => item.serial.includes(":"))) {
    if (!discovered.has(device.serial)) {
      discovered.set(device.serial, {
        serial: device.serial,
        name: device.model || device.serial,
        connected: device.state === "device"
      });
    }
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = discovered.size ? "Wi-Fi端末を選択…" : "Wi-Fi端末を検出できません";
  wifiDeviceSelect.append(placeholder);
  for (const service of discovered.values()) {
    const option = document.createElement("option");
    option.value = service.serial;
    option.textContent = `[Wi-Fi] ${service.name} (${service.serial})${service.connected ? " [接続済み]" : " [未接続]"}`;
    wifiDeviceSelect.append(option);
  }
  wifiDeviceSelect.value = [...discovered.keys()].includes(selectedWifiSerial) ? selectedWifiSerial : "";
}

async function setConnectionMode(mode: ConnectionMode): Promise<void> {
  if (connectionMode === mode) return;
  epoch++;
  setConnectRequested(false);
  await stopLink();
  connectionMode = mode;
  if (mode === "usb" && selectedSerial.includes(":") && !selectedSerial.startsWith("ios:")) selectedSerial = "";
  const wifi = mode === "wifi";
  for (const button of [usbModeButton, wifiModeButton]) {
    button.classList.remove("selected");
    button.classList.add("secondary");
  }
  const activeButton = wifi ? wifiModeButton : usbModeButton;
  activeButton.classList.remove("secondary");
  activeButton.classList.add("selected");
  usbModeButton.setAttribute("aria-pressed", String(!wifi));
  wifiModeButton.setAttribute("aria-pressed", String(wifi));
  usbDevicePanel.hidden = wifi;
  wifiDevicePanel.hidden = !wifi;
  $<HTMLElement>("#mode-card-usb").hidden = wifi;
  $<HTMLElement>("#mode-card-wifi").hidden = !wifi;
  setConnectRequested(false);
  status.textContent = wifi ? "Wi-Fi端末を検索しています…" : "USB端末を検索しています…";
  void tick();
}

function resetThumb(): void {
  thumbPlayer.reset();
  previewLive = false;
  thumbWrap.classList.remove("live");
  thumbCanvas.getContext("2d")?.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
}

async function stopLink(): Promise<void> {
  link = "none";
  await window.mirroringApp.disconnect();
  resetThumb();
}

function handleAdbMissing(message: string | undefined): void {
  pollEnabled = false;
  setConnectRequested(false);
  status.textContent = `${message ?? "adb が見つかりません。"} 「再検索」で再試行できます。`;
}

async function startPreview(): Promise<void> {
  const myEpoch = epoch;
  link = "none"; // 接続処理中に届く古いパケットを無視する
  const result = await window.mirroringApp.connect(PREVIEW_SETTINGS, selectedSerial);
  if (myEpoch !== epoch) {
    await window.mirroringApp.disconnect();
    return;
  }
  if (result.ok) {
    link = "preview";
  } else if (result.code === "adb-not-found") {
    handleAdbMissing(result.message);
  } else {
    status.textContent = PREVIEW_HINT;
  }
}

async function connectMain(): Promise<void> {
  const myEpoch = epoch;
  const serial = connectionMode === "wifi" ? selectedWifiSerial : selectedSerial;
  if (!serial) {
    status.textContent = connectionMode === "wifi" ? "Wi-Fi端末を選択してください。" : "USB端末を選択してください。";
    setConnectRequested(false);
    return;
  }
  status.textContent = "端末に接続しています…";
  resetThumb();
  link = "none";
  if (connectionMode === "wifi") {
    const wifiResult = await window.mirroringApp.connectWifi(serial);
    if (myEpoch !== epoch) return;
    if (!wifiResult.ok) {
      status.textContent = wifiResult.message;
      setConnectRequested(false);
      return;
    }
    status.textContent = `${wifiResult.message}。ストリームに接続しています…`;
  }
  const result = await window.mirroringApp.connect(currentSettings(), serial);
  if (myEpoch !== epoch) {
    await window.mirroringApp.disconnect();
    return;
  }
  if (result.ok) {
    // 最初のフレームを受信した時点でキャプチャ画面へ切り替わる
    link = "main";
  } else if (result.code === "adb-not-found") {
    handleAdbMissing(result.message);
  } else if (serial.startsWith("ios:")) {
    // iOS は再試行ループにせず、原因を表示して手動の再接続を待つ
    setConnectRequested(false);
    status.textContent = result.message ?? WAITING_MESSAGE;
  } else {
    status.textContent = WAITING_MESSAGE;
  }
}

// ---- アプリ自動インストール ----
const installDone = new Set<string>();
// インストールに失敗した端末の案内文 (プレビューが出ない理由として表示する)
const installNotes = new Map<string, string>();

async function installToDevices(ready: Device[]): Promise<void> {
  for (const device of ready) {
    if (installDone.has(device.serial)) continue;
    const name = device.model || device.serial;
    status.textContent = `${name} へアプリをインストール中… (スマホの画面ロックを解除してください)`;
    const result = await window.mirroringApp.installApk(device.serial);
    if (result.status === "failed") {
      installNotes.set(device.serial, `${name}: ${result.message}`);
      status.textContent = `${name}: ${result.message}`;
      continue;
    }
    installDone.add(device.serial);
    installNotes.delete(device.serial);
    if (result.status === "installed") {
      status.textContent = `${name}: ${result.message} スマホでアプリを開いて「ミラーリング開始」を押してください。`;
    } else if (result.status === "no-apk") {
      status.textContent = `${name}: ${result.message}`;
    }
  }
}

async function tick(): Promise<void> {
  cancelRetry();
  if (view !== "idle" || link === "main") return;
  if (attempting) {
    pendingRun = true;
    return;
  }
  attempting = true;
  try {
    const listed = await window.mirroringApp.listDevices();
    if (!listed.ok) {
      if (listed.code === "adb-not-found") handleAdbMissing(listed.message);
      else status.textContent = WAITING_MESSAGE;
      return;
    }

    const devices = listed.devices;
    const iosDevices = listed.iosDevices;
    const wifiDevices = listed.wifiDevices;
    deviceSelect.title = listed.iosWarning ?? "接続する端末";
    const ready = devices.filter((d) => d.state === "device");
    const availableWifiSerials = new Set([
      ...wifiDevices.map((device) => device.serial),
      ...devices.filter((device) => device.serial.includes(":")).map((device) => device.serial)
    ]);
    if (selectedWifiSerial && !availableWifiSerials.has(selectedWifiSerial)) {
      epoch++;
      selectedWifiSerial = "";
      setConnectRequested(false);
      await stopLink();
    }
    // 選択中の端末が外されたら選択とプレビューを解除する
    const selectedIsIos = selectedSerial.startsWith("ios:");
    if (
      connectionMode === "usb" &&
      selectedSerial &&
      (selectedIsIos
        ? !iosDevices.some((d) => `ios:${d.udid}` === selectedSerial)
        : !ready.some((d) => d.serial === selectedSerial))
    ) {
      epoch++;
      selectedSerial = "";
      setConnectRequested(false);
      await stopLink();
    }
    // 一覧が変わった時だけ再描画する (開いているプルダウンを閉じないため)
    const signature = `${JSON.stringify(devices)}|${JSON.stringify(iosDevices)}|${JSON.stringify(wifiDevices)}|${selectedSerial}|${selectedWifiSerial}`;
    if (signature !== lastSignature) {
      renderDevices(devices, iosDevices);
      renderWifiDevices(wifiDevices, devices);
      lastSignature = signature;
    }

    // 接続可能な端末へ同梱アプリを自動インストールする (端末ごとに1回。失敗時は「再検索」で再試行)
    await installToDevices(ready);

    if (connectRequested) {
      await connectMain();
    } else if (link === "preview") {
      // プレビュー中は状態表示を変えない
    } else if (connectionMode === "usb" && selectedSerial.startsWith("ios:")) {
      status.textContent = "iOS端末を選択しました。「接続」を押してください (初回は端末で「信頼」が必要です)。";
    } else if (connectionMode === "usb" && selectedSerial) {
      await startPreview();
      const note = installNotes.get(selectedSerial);
      if (note && link !== "preview") status.textContent = note;
    } else if (connectionMode === "wifi" && selectedWifiSerial) {
      const connected = ready.some((device) => device.serial === selectedWifiSerial);
      if (connected) {
        selectedSerial = selectedWifiSerial;
        await startPreview();
      } else {
        status.textContent = "Wi-Fi端末を選択し「接続」を押してください。";
      }
    } else if (ready.length > 0) {
      status.textContent = connectionMode === "wifi"
        ? "Wi-Fi端末を選択してください。"
        : "端末を選択してください。";
    } else if (connectionMode === "wifi" && wifiDevices.length > 0) {
      status.textContent = "Wi-Fi端末を選択してください。";
    } else if (devices.length > 0) {
      status.textContent = "端末が未承認です。スマホの「USBデバッグを許可」を確認してください…";
    } else if (iosDevices.length > 0) {
      status.textContent = "iOS端末を検出しました。選択して「接続」を押してください (実験的対応)。";
    } else {
      status.textContent = "接続中の端末がありません。USB接続とUSBデバッグを確認してください…";
    }
  } catch {
    status.textContent = WAITING_MESSAGE;
  } finally {
    attempting = false;
    if (pendingRun) {
      pendingRun = false;
      void tick();
    } else {
      scheduleRetry();
    }
  }
}

deviceSelect.addEventListener("change", async () => {
  epoch++;
  selectedSerial = deviceSelect.value;
  setConnectRequested(false);
  await stopLink();
  status.textContent = selectedSerial ? "プレビューを準備しています…" : "端末を選択してください。";
  pollEnabled = true;
  void tick();
});

wifiDeviceSelect.addEventListener("change", async () => {
  epoch++;
  selectedWifiSerial = wifiDeviceSelect.value;
  setConnectRequested(false);
  await stopLink();
  status.textContent = selectedWifiSerial
    ? "Wi-Fi端末を選択しました。「接続」を押してください。"
    : "Wi-Fi端末を選択してください。";
  pollEnabled = true;
  void tick();
});

usbModeButton.addEventListener("click", () => void setConnectionMode("usb"));
wifiModeButton.addEventListener("click", () => void setConnectionMode("wifi"));

rescanButton.addEventListener("click", () => {
  pollEnabled = true;
  // 失敗していた端末のインストールを再試行する
  for (const serial of installNotes.keys()) installDone.delete(serial);
  installNotes.clear();
  void tick();
});

rescanWifiButton.addEventListener("click", () => {
  lastSignature = "";
  pollEnabled = true;
  void tick();
});

wifiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = wifiAddressInput.value.trim();
  if (!address) {
    status.textContent = "スマホの IP アドレスとポートを入力してください。";
    wifiAddressInput.focus();
    return;
  }

  wifiConnectButton.disabled = true;
  status.textContent = "Wi-Fi ADB に接続しています…";
  localStorage.setItem(WIFI_ADDRESS_KEY, address);
  try {
    const result = await window.mirroringApp.connectWifi(address);
    status.textContent = result.message;
    if (result.ok) {
      lastSignature = "";
      void tick();
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Wi-Fi ADB 接続に失敗しました。";
  } finally {
    wifiConnectButton.disabled = false;
  }
});

connectButton.addEventListener("click", async () => {
  if (connectRequested) {
    // 待機の中止
    epoch++;
    setConnectRequested(false);
    await stopLink();
    status.textContent = "接続待機を中止しました。";
    pollEnabled = true;
    void tick();
    return;
  }
  if (connectionMode === "usb" ? !selectedSerial : !selectedWifiSerial) {
    status.textContent = connectionMode === "usb" ? "USB端末を選択してください。" : "Wi-Fi端末を選択してください。";
    return;
  }
  setConnectRequested(true);
  pollEnabled = true;
  await player.unlockAudio().catch(() => undefined);
  void tick();
});

disconnectButton.addEventListener("click", async () => {
  epoch++;
  setConnectRequested(false);
  await stopLink();
  if (recorder) recorder.stop();
  player.reset();
  setView("idle");
  status.textContent = "切断しました。";
  pollEnabled = true;
  void tick();
});

window.mirroringApp.onPacket((packet) => {
  if (link === "main") {
    if (view === "idle") {
      setView("active");
      status.textContent = "接続成功・受信中";
    }
    player.handlePacket(packet.type, packet.ptsUs, packet.payload);
    return;
  }
  if (link !== "preview") return;
  if (packet.type === PacketType.AudioConfig || packet.type === PacketType.AudioFrame) return;
  thumbPlayer.handlePacket(packet.type, packet.ptsUs, packet.payload);
  if (!previewLive && (packet.type === PacketType.VideoFrame || packet.type === PacketType.VideoKeyFrame)) {
    previewLive = true;
    thumbWrap.classList.add("live");
    status.textContent = "プレビュー表示中。「接続」でキャプチャを開始します。";
  }
});

window.mirroringApp.onStatus(({ state, message }) => {
  if (state !== "disconnected") return;
  const was = link;
  if (was === "none") return;
  link = "none";

  if (was === "preview") {
    resetThumb();
    status.textContent = PREVIEW_HINT;
    scheduleRetry();
    return;
  }

  if (recorder) recorder.stop();
  player.reset();
  if (view === "active") {
    // 接続がロストしたら待機画面へ戻る。端末が再開すればサムネイルが再び表示される
    setConnectRequested(false);
    setView("idle");
    status.textContent = `${message} 待機画面に戻りました。`;
  } else if (selectedSerial.startsWith("ios:")) {
    setConnectRequested(false);
    status.textContent = message;
  } else {
    status.textContent = WAITING_MESSAGE;
  }
  scheduleRetry();
});

// ---- 録画 ----
let recorder: MediaRecorder | null = null;
let recordTimerId: number | null = null;
let recordStartedAt = 0;

// MP4 (AAC) は環境によって音声付きで EncodingError になるため、動作実績のある WebM を優先する
function pickRecordingFormat(): { mimeType: string; extension: string } {
  const candidates = [
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
    { mimeType: "video/mp4", extension: "mp4" }
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? candidates[2];
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function setRecordingUi(active: boolean): void {
  recordButton.textContent = active ? "停止" : "録画";
  recordButton.classList.toggle("recording", active);
  recordTimer.hidden = !active;
  if (recordTimerId !== null) {
    window.clearInterval(recordTimerId);
    recordTimerId = null;
  }
  if (active) {
    recordStartedAt = Date.now();
    recordTimer.textContent = `● REC ${formatElapsed(0)}`;
    recordTimerId = window.setInterval(() => {
      recordTimer.textContent = `● REC ${formatElapsed(Date.now() - recordStartedAt)}`;
    }, 500);
  }
}

async function startRecording(): Promise<void> {
  const { mimeType, extension } = pickRecordingFormat();
  await window.mirroringApp.startRecording(extension);

  const mediaRecorder = new MediaRecorder(player.createRecordingStream(canvas), {
    mimeType,
    videoBitsPerSecond: 8_000_000
  });
  let writes: Promise<unknown> = Promise.resolve();

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    // チャンクの順序を保つため直列に書き込む
    writes = writes.then(async () => {
      await window.mirroringApp.writeRecordingChunk(new Uint8Array(await event.data.arrayBuffer()));
    });
  });
  mediaRecorder.addEventListener("stop", async () => {
    recorder = null;
    setRecordingUi(false);
    recordButton.disabled = view !== "active";
    try {
      await writes;
      const result = await window.mirroringApp.stopRecording();
      status.textContent = result.saved ? `録画を保存しました: ${result.path}` : result.message ?? "録画を保存できませんでした。";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "録画を保存できませんでした。";
    }
  });
  mediaRecorder.addEventListener("error", () => {
    status.textContent = "録画中にエラーが発生しました。";
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  });

  recorder = mediaRecorder;
  mediaRecorder.start(1000);
  setRecordingUi(true);
  status.textContent = `録画中 (${extension.toUpperCase()})`;
}

recordButton.addEventListener("click", async () => {
  recordButton.disabled = true;
  try {
    if (recorder) {
      recorder.stop();
      return;
    }
    await startRecording();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "録画を開始できませんでした。";
  } finally {
    recordButton.disabled = view !== "active" && !recorder;
  }
});

// ---- フルスクリーン ----
fullscreenButton.addEventListener("click", () => void window.mirroringApp.toggleFullScreen());
canvas.addEventListener("dblclick", () => void window.mirroringApp.toggleFullScreen());
window.mirroringApp.onFullScreenChange((enabled) => {
  document.body.classList.toggle("fullscreen", enabled);
  fullscreenAutohide = enabled;
  updateAutohide();
  fullscreenButton.textContent = enabled ? "全画面解除" : "全画面";
});

// ---- キャプチャモード (OBS向け) / 操作UIの自動非表示 ----
let captureMode = false;
let fullscreenAutohide = false;
let hideTimer: number | null = null;
const captureButton = $<HTMLButtonElement>("#capture");

function updateAutohide(): void {
  const autohide = captureMode || fullscreenAutohide;
  document.body.classList.toggle("autohide", autohide);
  if (!autohide) document.body.classList.remove("show-ui");
}

function showUiTemporarily(): void {
  if (!document.body.classList.contains("autohide")) return;
  document.body.classList.add("show-ui");
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(function hide() {
    // ツールバー操作中は隠さない
    if ($("#toolbar").matches(":hover")) {
      hideTimer = window.setTimeout(hide, 2500);
      return;
    }
    document.body.classList.remove("show-ui");
  }, 2500);
}
document.addEventListener("mousemove", showUiTemporarily);

async function setCaptureMode(enabled: boolean): Promise<void> {
  captureMode = enabled;
  document.body.classList.toggle("capture", enabled);
  captureButton.classList.toggle("on", enabled);
  captureButton.setAttribute("aria-pressed", String(enabled));
  updateAutohide();
  await window.mirroringApp.setCaptureMode(enabled);
  if (enabled) showUiTemporarily();
}

captureButton.addEventListener("click", () => void setCaptureMode(!captureMode));
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    if (view === "active") void setCaptureMode(!captureMode);
  }
});

$<HTMLButtonElement>("#minimize").addEventListener("click", () => void window.mirroringApp.minimize());
$<HTMLButtonElement>("#maximize").addEventListener("click", () => void window.mirroringApp.toggleMaximize());
$<HTMLButtonElement>("#close").addEventListener("click", () => void window.mirroringApp.closeWindow());

function updateAlwaysOnTopButton(enabled: boolean, announce = true): void {
  alwaysOnTopButton.textContent = "手前固定";
  alwaysOnTopButton.classList.toggle("on", enabled);
  alwaysOnTopButton.setAttribute("aria-pressed", String(enabled));
  if (!announce) return;
  status.textContent = enabled
    ? "ウィンドウを常に手前に表示します。"
    : "ウィンドウは通常の表示順です。";
}

alwaysOnTopButton.addEventListener("click", async () => {
  alwaysOnTopButton.disabled = true;

  try {
    updateAlwaysOnTopButton(await window.mirroringApp.toggleAlwaysOnTop());
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "設定を切り替えられませんでした。";
  } finally {
    alwaysOnTopButton.disabled = false;
  }
});

void window.mirroringApp
  .getAlwaysOnTop()
  .then((enabled) => updateAlwaysOnTopButton(enabled, false))
  .catch((error: unknown) => {
    status.textContent =
      error instanceof Error ? error.message : "設定を読み込めませんでした。";
  });

// 起動時は待機画面で端末を検索し、選択された端末のプレビューを表示する
status.textContent = "端末を検索しています…";
void tick();
