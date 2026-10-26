import { ExecFileException, execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { MIRROR_PORT, MirrorPacket, PacketParser, StreamSettings, encodeSettings } from "./protocol";

export interface MirrorHandlers {
  onPacket: (packet: MirrorPacket) => void;
  onStatus: (state: "connected" | "disconnected", message: string) => void;
}

export class AdbNotFoundError extends Error {
  constructor(readonly searched: string[]) {
    super(
      "adb が見つかりません。次の場所を探しました:\n" +
        searched.map((p) => `  ${p}`).join("\n") +
        "\nadb.exe の場所を指定するか、環境変数 ADB_PATH を設定してください。"
    );
  }
}

// 設定画面/ダイアログで手動指定され保存された adb.exe (または platform-tools フォルダー)
let userAdbPath = "";

export function setUserAdbPath(value: string): void {
  userAdbPath = value;
}

// 指定がフォルダーなら adb.exe を補い、実在するファイルのときだけ返す
function asAdbFile(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const file = path.join(candidate, "adb.exe");
      return fs.existsSync(file) ? file : null;
    }
  } catch {
    // 存在しない
  }
  return null;
}

// 優先順位: ADB_PATH > exe 同梱 > 手動指定 > PATH > Android SDK の標準場所
export function resolveAdb(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const exeDir = path.dirname(process.execPath);
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).map((d) => d.replace(/^"|"$/g, ""));
  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
  ];

  const groups: Array<Array<string | undefined>> = [
    [process.env.ADB_PATH],
    [
      resources && path.join(resources, "platform-tools"),
      resources && path.join(resources, "adb.exe"),
      path.join(exeDir, "platform-tools"),
      path.join(exeDir, "adb.exe")
    ],
    [userAdbPath],
    pathDirs,
    sdkRoots.map((root) => root && path.join(root, "platform-tools"))
  ];

  const searched: string[] = [];
  for (const candidates of groups) {
    for (const candidate of candidates) {
      if (!candidate) continue;
      const found = asAdbFile(candidate);
      if (found) return found;
      searched.push(candidate);
    }
  }
  throw new AdbNotFoundError(searched);
}

export interface AdbDevice {
  serial: string;
  state: string;
  model: string;
}

export const APP_ID = "com.smartcapture.app";

export type InstallResult =
  | { status: "installed" | "up-to-date"; message: string }
  | { status: "no-apk" | "failed"; message: string };

interface AdbOutput {
  error: ExecFileException | null;
  text: string;
}

function runAdb(args: string[], timeout: number): Promise<AdbOutput> {
  const adb = resolveAdb();
  return new Promise((resolve) => {
    execFile(adb, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, text: `${stdout}\n${stderr}`.trim() });
    });
  });
}

// 同梱 APK。パッケージ版は resources 直下、開発時はプロジェクトの apk フォルダー
export function findBundledApk(): string | null {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resources && path.join(resources, "app-debug.apk"),
    path.join(__dirname, "..", "apk", "app-debug.apk")
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function describeInstallFailure(output: AdbOutput): string {
  const text = output.text;
  if (output.error?.killed) {
    return "端末の応答がありません。スマホの画面ロックを解除し、インストールの確認が出ていれば許可してください。";
  }
  if (/INSTALL_FAILED_USER_RESTRICTED|INSTALL_CANCELED_BY_USER|canceled by user/i.test(text)) {
    return "スマホ側でUSB経由のインストールが許可されていません。端末の確認画面で許可するか、開発者向けオプションの「USB経由でインストール」を有効にしてください。";
  }
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(text)) {
    return "署名の異なる同名アプリが入っています。スマホの「Smart Capture」をアンインストールしてから再試行してください。";
  }
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(text)) {
    return "スマホの空き容量が不足しています。";
  }
  if (/INSTALL_FAILED_OLDER_SDK/i.test(text)) {
    return "このスマホのAndroidバージョンはアプリに対応していません (Android 10 以上が必要です)。";
  }
  if (/unauthorized/i.test(text)) {
    return "端末が未承認です。スマホの「USBデバッグを許可」を確認してください。";
  }
  if (/offline|device not found|no devices/i.test(text)) {
    return "端末との接続が切れています。USBケーブルを確認してください。";
  }
  return `インストールに失敗しました: ${text.split(/\r?\n/).filter(Boolean).pop() ?? output.error?.message ?? "原因不明"}`;
}

/**
 * 同梱 APK を端末へインストールする。端末のアプリが同じバージョンならスキップし、
 * 異なる/未導入なら `adb install -r` で上書きする。署名違いなどは自動でアンインストールしない。
 * APK のバージョンは PC アプリ (package.json) と揃えて管理している前提。
 */
export async function ensureApkInstalled(serial: string, appVersion: string): Promise<InstallResult> {
  const apk = findBundledApk();
  if (!apk) return { status: "no-apk", message: "同梱のAPKが見つかりません。" };

  const info = await runAdb(["-s", serial, "shell", "dumpsys", "package", APP_ID], 15_000);
  if (info.error && !/versionName/.test(info.text)) {
    return { status: "failed", message: describeInstallFailure(info) };
  }
  const installed = /versionName=(\S+)/.exec(info.text)?.[1];
  if (installed === appVersion) {
    return { status: "up-to-date", message: `アプリは最新です (v${installed})。` };
  }

  // 端末側の確認操作を待てるよう長めのタイムアウトにする
  const result = await runAdb(["-s", serial, "install", "-r", apk], 120_000);
  if (!result.error && /Success/i.test(result.text)) {
    return { status: "installed", message: `アプリをインストールしました (v${appVersion})。` };
  }
  return { status: "failed", message: describeInstallFailure(result) };
}

// `adb devices -l` の出力例: "R58M123ABC  device usb:1-1 product:x model:Pixel_7 device:panther transport_id:1"
export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|unauthorized|offline|authorizing|no permissions\S*)\b(.*)$/.exec(line.trim());
    if (!match) continue;
    const model = /\bmodel:(\S+)/.exec(match[3] ?? "")?.[1]?.replace(/_/g, " ") ?? "";
    devices.push({ serial: match[1]!, state: match[2]!, model });
  }
  return devices;
}

export function listDevices(): Promise<AdbDevice[]> {
  const adb = resolveAdb();
  return new Promise((resolve, reject) => {
    execFile(adb, ["devices", "-l"], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve(parseDevices(stdout));
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new AdbNotFoundError([adb]));
      } else {
        reject(new Error(`adb devices に失敗しました: ${stderr.trim() || error.message}`));
      }
    });
  });
}

export interface AdbWifiService {
  serial: string;
  name: string;
  connected: boolean;
}

export function parseAdbWifiServices(output: string, devices: AdbDevice[] = []): AdbWifiService[] {
  const services = new Map<string, AdbWifiService>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const serviceType = parts.find((part) => /^_adb(?:-tls-connect)?\._tcp\.?$/i.test(part));
    if (!serviceType) continue;
    const endpoint = parts.slice(parts.indexOf(serviceType) + 1).find((part) => {
      const address = part.startsWith("[") ? part.slice(1, part.indexOf("]")) : part.split(":")[0];
      return net.isIP(address) !== 0 && part.includes(":");
    });
    if (!endpoint) continue;
    let serial: string;
    try {
      serial = normalizeAdbAddress(endpoint);
    } catch {
      continue;
    }
    const rawName = parts.slice(0, parts.indexOf(serviceType)).join(" ");
    services.set(serial, {
      serial,
      name: rawName.replace(/^adb-/, "").replace(/[^a-zA-Z0-9_-]/g, "") || serial,
      connected: devices.some((device) => device.serial === serial && device.state === "device")
    });
  }
  return [...services.values()];
}

/** adb mDNS で広告されているワイヤレス接続サービスを列挙する。 */
export async function listAdbWifiServices(devices: AdbDevice[] = []): Promise<AdbWifiService[]> {
  const output = await runAdb(["mdns", "services"], 5_000);
  if (output.error) return [];
  return parseAdbWifiServices(output.text, devices);
}

export type AdbConnectResult = { ok: true; serial: string; message: string } | { ok: false; message: string };

function normalizeAdbAddress(value: string): string {
  const input = value.trim();
  let host: string;
  let portText: string | undefined;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(input);
  if (ipv6) {
    host = ipv6[1]!;
    portText = ipv6[2];
    if (net.isIP(host) !== 6) throw new Error("IPアドレスの形式が正しくありません。");
    host = `[${host}]`;
  } else {
    const ipv4 = /^([^:]+)(?::(\d+))?$/.exec(input);
    if (!ipv4 || net.isIP(ipv4[1]!) !== 4) {
      throw new Error("IPv4 アドレスを入力してください (例: 192.168.1.10:5555)。");
    }
    host = ipv4[1]!;
    portText = ipv4[2];
  }

  const port = portText ? Number(portText) : 5555;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ポート番号は 1〜65535 の範囲で入力してください。");
  }
  return `${host}:${port}`;
}

/** Wi-Fi 経由の ADB 接続を開始する。端末側で TCP/IP 接続が有効になっている必要がある。 */
export async function connectAdbWifi(address: string): Promise<AdbConnectResult> {
  let serial: string;
  try {
    serial = normalizeAdbAddress(address);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const result = await runAdb(["connect", serial], 15_000);
  const response = result.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? "";
  if (!result.error && /^(connected to|already connected to)\s+/i.test(response)) {
    return { ok: true, serial, message: `Wi-Fi ADB に接続しました: ${serial}` };
  }
  if (/unable to connect|failed to connect|no route to host|connection refused|timed out/i.test(result.text)) {
    return {
      ok: false,
      message: `接続できませんでした (${serial})。端末の「ワイヤレスデバッグ」または同じ Wi-Fi への接続を確認してください。`
    };
  }
  return {
    ok: false,
    message: result.error
      ? `adb connect に失敗しました: ${response || result.error.message}`
      : `adb connect の応答を確認できませんでした: ${response || "応答なし"}`
  };
}

function runAdbForward(serial?: string): Promise<void> {
  const adb = resolveAdb();
  const port = `tcp:${MIRROR_PORT}`;
  const args = serial ? ["-s", serial, "forward", port, port] : ["forward", port, port];

  return new Promise((resolve, reject) => {
    execFile(
      adb,
      args,
      { timeout: 10_000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
        } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new AdbNotFoundError([adb]));
        } else {
          reject(new Error(`adb forward に失敗しました: ${stderr.trim() || error.message}`));
        }
      }
    );
  });
}

export class MirrorSession {
  private socket: net.Socket | null = null;

  constructor(private readonly handlers: MirrorHandlers) {}

  async start(settings: StreamSettings, serial?: string): Promise<void> {
    this.stop();
    await runAdbForward(serial);

    const socket = net.connect({ host: "127.0.0.1", port: MIRROR_PORT });
    const parser = new PacketParser();
    this.socket = socket;
    socket.setNoDelay(true);

    // adb forward は端末側が未起動でも接続を受け付け、直後に切断する
    let received = false;
    let ended = false;
    const finish = (message: string): void => {
      if (ended) return;
      ended = true;
      if (this.socket === socket) this.socket = null;
      socket.destroy();
      this.handlers.onStatus("disconnected", message);
    };

    socket.on("connect", () => {
      // 端末はこの設定を受け取ってからエンコードを開始する
      socket.write(encodeSettings(settings));
      this.handlers.onStatus("connected", "接続しました。映像を待っています…");
    });
    socket.on("data", (chunk) => {
      received = true;
      try {
        for (const packet of parser.push(chunk)) this.handlers.onPacket(packet);
      } catch (error) {
        finish(error instanceof Error ? error.message : "受信データが不正です。");
      }
    });
    socket.on("error", (error) => finish(`接続エラー: ${error.message}`));
    socket.on("close", () =>
      finish(
        received
          ? "切断されました。"
          : "端末に接続できませんでした。Androidアプリで配信を開始しているか確認してください。"
      )
    );
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.removeAllListeners();
    socket?.on("error", () => undefined);
    socket?.destroy();
  }
}
