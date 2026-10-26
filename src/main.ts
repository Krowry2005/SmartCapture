import { app, BrowserWindow, dialog, ipcMain, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AdbNotFoundError,
  MirrorSession,
  connectAdbWifi,
  ensureApkInstalled,
  listAdbWifiServices,
  listDevices,
  setUserAdbPath
} from "./mirror";
import { listIosDevices } from "./ios-mirror";
import { IosMirrorSession, listUsbIosDevices } from "./ios-capture";
import { sanitizeSettings } from "./protocol";

// 起動時の自動接続でもユーザー操作なしで音声を再生できるようにする
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let mainWindow: BrowserWindow | null = null;

// 録画データは一時ファイルへ逐次書き込み、停止時に保存先へ移す
let recording: { stream: fs.WriteStream; tempPath: string; extension: string } | null = null;

function discardRecording(): void {
  const current = recording;
  recording = null;
  if (!current) return;
  current.stream.destroy();
  fs.rm(current.tempPath, { force: true }, () => undefined);
}

function finishWrite(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.promises.rename(from, to);
  } catch {
    // 別ドライブ間は rename できないためコピーする
    await fs.promises.copyFile(from, to);
    await fs.promises.rm(from, { force: true });
  }
}

function toggleFullScreen(): boolean {
  if (!mainWindow) return false;
  const enabled = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(enabled);
  return enabled;
}

// ツールバーの高さ。キャプチャモードでは 0 (映像だけのウィンドウ)
const TOOLBAR_HEIGHT = 40;
const MIN_WIDTH = 400;
let captureMode = false;
let videoAspect = 0; // 幅 / 高さ。0 は未確定

function chromeHeight(): number {
  return captureMode ? 0 : TOOLBAR_HEIGHT;
}

// 映像のアスペクト比に合わせてウィンドウ比率を固定し、比率が変わった時はサイズも合わせる
function applyAspect(resize: boolean): void {
  const win = mainWindow;
  if (!win || videoAspect <= 0) return;
  const chrome = chromeHeight();
  win.setAspectRatio(videoAspect, { width: 0, height: chrome });
  if (!resize || win.isFullScreen() || win.isMaximized()) return;

  const [contentWidth, contentHeight] = win.getContentSize();
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const maxWidth = Math.floor(area.width * 0.95);
  const maxHeight = Math.floor(area.height * 0.95);

  // 映像領域の長辺を保ったまま新しい比率へ
  const stageLong = Math.max(contentWidth, contentHeight - chrome);
  let width = videoAspect >= 1 ? stageLong : Math.round(stageLong * videoAspect);
  let height = Math.round(width / videoAspect) + chrome;
  const shrink = Math.min(1, maxWidth / width, maxHeight / height);
  width = Math.max(Math.round(width * shrink), MIN_WIDTH);
  height = Math.round(width / videoAspect) + chrome;
  // 拡大してはみ出さないよう、作業領域内へ寄せた上で一度に反映する (フレームレスなので外寸=内寸)
  const current = win.getBounds();
  const x = Math.min(Math.max(current.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(current.y, area.y), area.y + area.height - height);
  win.setBounds({ x, y, width, height });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: MIN_WIDTH,
    minHeight: 260,
    frame: false,
    backgroundColor: "#000000",
    title: "Smart Capture",
    icon: path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, "../build"), "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void mainWindow.loadFile(path.join(__dirname, "../index.html"));

  // F11 / Alt+Enter はフォーカス位置に関係なくここで処理する
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const isF11 = input.key === "F11";
    const isAltEnter = input.alt && input.key === "Enter";
    if (isF11 || isAltEnter) {
      event.preventDefault();
      toggleFullScreen();
    }
  });

  const notifyFullScreen = (value: boolean): void => {
    mainWindow?.webContents.send("window:fullscreen-changed", value);
  };
  mainWindow.on("enter-full-screen", () => notifyFullScreen(true));
  mainWindow.on("leave-full-screen", () => {
    notifyFullScreen(false);
    applyAspect(true);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    discardRecording();
  });
}

ipcMain.handle("window:toggle-fullscreen", () => toggleFullScreen());

ipcMain.handle("window:set-capture-mode", (_event, enabled: unknown) => {
  captureMode = enabled === true;
  applyAspect(true);
  return captureMode;
});

ipcMain.handle("window:video-size", (_event, width: unknown, height: unknown) => {
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return;
  const aspect = width / height;
  const changed = Math.abs(aspect - videoAspect) > 0.01;
  videoAspect = aspect;
  applyAspect(changed);
});

// 待機画面へ戻る時は映像比率の固定を解き、全画面を抜けて既定サイズへ戻す
ipcMain.handle("window:set-view", (_event, view: unknown) => {
  const win = mainWindow;
  if (!win || view !== "idle") return;
  videoAspect = 0;
  win.setAspectRatio(0);
  if (win.isFullScreen()) win.setFullScreen(false);
  else if (!win.isMaximized()) win.setSize(420, 760);
});

ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());

ipcMain.handle("recording:start", async (_event, extension: string) => {
  discardRecording();
  const safeExtension = extension === "mp4" ? "mp4" : "webm";
  const tempPath = path.join(os.tmpdir(), `mirror-recording-${Date.now()}.${safeExtension}`);
  recording = { stream: fs.createWriteStream(tempPath), tempPath, extension: safeExtension };
});

ipcMain.handle("recording:chunk", (_event, chunk: Uint8Array) => {
  recording?.stream.write(chunk);
});

ipcMain.handle("recording:stop", async (): Promise<{ saved: boolean; path?: string; message?: string }> => {
  const current = recording;
  recording = null;
  if (!current) return { saved: false, message: "録画データがありません。" };

  try {
    await finishWrite(current.stream);
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const options = {
      title: "録画を保存",
      defaultPath: path.join(app.getPath("videos"), `mirror-${stamp}.${current.extension}`),
      filters: [{ name: current.extension.toUpperCase(), extensions: [current.extension] }]
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      await fs.promises.rm(current.tempPath, { force: true });
      return { saved: false, message: "保存をキャンセルしました。録画は破棄されました。" };
    }
    await moveFile(current.tempPath, result.filePath);
    return { saved: true, path: result.filePath };
  } catch (error) {
    await fs.promises.rm(current.tempPath, { force: true }).catch(() => undefined);
    return { saved: false, message: error instanceof Error ? error.message : String(error) };
  }
});

const session = new MirrorSession({
  onPacket: (packet) => mainWindow?.webContents.send("mirror:packet", packet),
  onStatus: (state, message) => mainWindow?.webContents.send("mirror:status", { state, message })
});

const iosSession = new IosMirrorSession({
  onPacket: (packet) => mainWindow?.webContents.send("mirror:packet", packet),
  onStatus: (state, message) => mainWindow?.webContents.send("mirror:status", { state, message })
});

const adbConfigPath = (): string => path.join(app.getPath("userData"), "adb-path.json");

function loadAdbPath(): void {
  try {
    const saved = JSON.parse(fs.readFileSync(adbConfigPath(), "utf8")) as { adbPath?: string };
    if (typeof saved.adbPath === "string") setUserAdbPath(saved.adbPath);
  } catch {
    // 未保存
  }
}

// adb が見つからないとき、adb.exe を選んでもらい保存する。選ばれたら true
async function askAdbPath(detail: string): Promise<boolean> {
  const options = {
    type: "warning" as const,
    title: "adb が見つかりません",
    message: "adb.exe が見つかりません。",
    detail,
    buttons: ["adb.exe を指定する", "キャンセル"],
    defaultId: 0,
    cancelId: 1
  };
  const choice = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (choice.response !== 0) return false;

  const pickerOptions = {
    title: "adb.exe を選択",
    properties: ["openFile" as const],
    filters: [{ name: "adb", extensions: ["exe"] }]
  };
  const picked = mainWindow
    ? await dialog.showOpenDialog(mainWindow, pickerOptions)
    : await dialog.showOpenDialog(pickerOptions);
  const file = picked.filePaths[0];
  if (picked.canceled || !file) return false;

  setUserAdbPath(file);
  fs.mkdirSync(path.dirname(adbConfigPath()), { recursive: true });
  fs.writeFileSync(adbConfigPath(), JSON.stringify({ adbPath: file }), "utf8");
  return true;
}

// adb が見つからないときは一度だけ指定ダイアログを出し、指定されたら再実行する
async function withAdbPrompt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof AdbNotFoundError) || !(await askAdbPath(error.message))) throw error;
    return run();
  }
}

function failure(error: unknown): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: error instanceof AdbNotFoundError ? "adb-not-found" : "failed",
    message: error instanceof Error ? error.message : String(error)
  };
}

ipcMain.handle("devices:list", async () => {
  try {
    const devices = await withAdbPrompt(listDevices);
    const [ios, wifiDevices, usbIos] = await Promise.all([listIosDevices(), listAdbWifiServices(devices), listUsbIosDevices()]);
    // usbmuxd が使えない (WinUSB ドライバー導入済みなど) 場合も USB 経由で検出した端末を補う
    const known = new Set(ios.devices.map((d) => d.udid.replace(/-/g, "").toLowerCase()));
    const extra = usbIos
      .filter((d) => !known.has(d.udid.replace(/-/g, "").toLowerCase()))
      .map((d) => ({ udid: d.udid, name: d.name, state: "device" as const }));
    const iosDevices = [...ios.devices, ...extra];
    return {
      ok: true as const,
      devices,
      iosDevices,
      iosWarning: iosDevices.length > 0 ? undefined : ios.warning,
      wifiDevices
    };
  } catch (error) {
    return failure(error);
  }
});

ipcMain.handle("adb:connect-wifi", async (_event, address: unknown) => {
  if (typeof address !== "string") {
    return { ok: false, message: "IPアドレスを入力してください。" };
  }
  try {
    return await withAdbPrompt(() => connectAdbWifi(address));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("device:install", async (_event, serial: unknown) => {
  if (typeof serial !== "string" || !serial) return { status: "failed", message: "端末が指定されていません。" };
  try {
    return await ensureApkInstalled(serial, app.getVersion());
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("mirror:connect", async (_event, settings: unknown, serial: unknown) => {
  const clean = sanitizeSettings(settings);
  if (typeof serial === "string" && serial.startsWith("ios:")) {
    session.stop();
    try {
      await iosSession.start(clean, serial.slice(4));
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  }
  iosSession.stop();
  const target = typeof serial === "string" && serial ? serial : undefined;
  try {
    await withAdbPrompt(() => session.start(clean, target));
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
});

ipcMain.handle("mirror:disconnect", () => {
  session.stop();
  iosSession.stop();
});

ipcMain.handle("window:toggle-always-on-top", () => {
  if (!mainWindow) {
    throw new Error("The application window is not available.");
  }

  const enabled = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(enabled);
  return enabled;
});

ipcMain.handle("window:get-always-on-top", () => {
  return mainWindow?.isAlwaysOnTop() ?? false;
});

app.whenReady().then(() => {
  loadAdbPath();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  session.stop();
  iosSession.stop();
  discardRecording();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
