import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface IosDevice {
  udid: string;
  name: string;
  // device: 名前まで取得できた / untrusted: 端末側で「信頼」が未操作 / unknown: 名前を取得するツールがない
  state: "device" | "untrusted" | "unknown";
}

export interface IosScan {
  devices: IosDevice[];
  // 検出手段が全く使えない時の案内 (端末が0台の理由として表示する)
  warning?: string;
}

const USBMUXD_PORT = 27015; // Windows の Apple Mobile Device Service (iTunes / Apple デバイス)
const UDID_PATTERN = /^[0-9A-Za-z-]{8,64}$/;

const nameCache = new Map<string, string>();

// 優先順位: IDEVICE_PATH > exe 同梱 (libimobiledevice フォルダー) > PATH
function findTool(name: string): string | null {
  const file = `${name}.exe`;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const exeDir = path.dirname(process.execPath);
  const dirs = [
    process.env.IDEVICE_PATH,
    resources && path.join(resources, "libimobiledevice"),
    path.join(exeDir, "libimobiledevice"),
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => d.replace(/^"|"$/g, ""))
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, file);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 存在しない
    }
  }
  return null;
}

function run(tool: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    execFile(tool, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, text: `${stdout}\n${stderr}`.trim() });
    });
  });
}

async function listWithTool(tool: string): Promise<string[] | null> {
  const result = await run(tool, ["-l"]);
  if (!result.ok) return null;
  return result.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => UDID_PATTERN.test(line));
}

// usbmuxd へ ListDevices (plist) を問い合わせる。ツール不要で USB 接続の UDID を取得できる
function listWithUsbmuxd(): Promise<string[] | null> {
  return new Promise((resolve) => {
    const body = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>' +
        "<key>MessageType</key><string>ListDevices</string>" +
        "<key>ClientVersionString</key><string>SmartCapture</string>" +
        "<key>ProgName</key><string>SmartCapture</string>" +
        "</dict></plist>",
      "utf8"
    );
    const header = Buffer.alloc(16);
    header.writeUInt32LE(16 + body.length, 0);
    header.writeUInt32LE(1, 4); // version: plist
    header.writeUInt32LE(8, 8); // message: plist payload
    header.writeUInt32LE(1, 12); // tag

    const socket = net.connect({ host: "127.0.0.1", port: USBMUXD_PORT });
    let received = Buffer.alloc(0);
    let done = false;
    const finish = (value: string[] | null): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(3000, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => socket.write(Buffer.concat([header, body])));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 16) return;
      const total = received.readUInt32LE(0);
      if (received.length < total) return;
      finish(parseUsbmuxdList(received.subarray(16, total).toString("utf8")));
    });
  });
}

export function parseUsbmuxdList(xml: string): string[] {
  const udids: string[] = [];
  for (const block of xml.matchAll(/<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const props = block[1];
    const connection = /<key>ConnectionType<\/key>\s*<string>([^<]*)<\/string>/.exec(props)?.[1];
    const udid = /<key>SerialNumber<\/key>\s*<string>([^<]*)<\/string>/.exec(props)?.[1];
    // Wi-Fi 経由で見えている端末は対象外 (USB 接続のみ)
    if (connection === "USB" && udid && UDID_PATTERN.test(udid)) udids.push(udid);
  }
  return [...new Set(udids)];
}

async function readName(infoTool: string | null, udid: string): Promise<{ name: string; state: IosDevice["state"] }> {
  const cached = nameCache.get(udid);
  if (cached) return { name: cached, state: "device" };
  if (!infoTool) return { name: "", state: "unknown" };
  const result = await run(infoTool, ["-u", udid, "-k", "DeviceName"]);
  const name = result.text.split(/\r?\n/)[0]?.trim() ?? "";
  if (result.ok && name && !/^error/i.test(name)) {
    nameCache.set(udid, name);
    return { name, state: "device" };
  }
  // 「このコンピュータを信頼」が未承認だと lockdownd に接続できない
  return { name: "", state: "untrusted" };
}

/** USB 接続された iPhone / iPad を検出する。失敗しても例外は投げず、Android 側の一覧に影響させない。 */
export async function listIosDevices(): Promise<IosScan> {
  try {
    const idTool = findTool("idevice_id");
    let udids = idTool ? await listWithTool(idTool) : null;
    // libimobiledevice が無い / 失敗した時は usbmuxd へ直接問い合わせる
    udids ??= await listWithUsbmuxd();
    if (udids === null) {
      return {
        devices: [],
        warning: "iOS端末を検出できません。iTunes または Apple デバイスアプリ (Apple Mobile Device Service) をインストールしてください。"
      };
    }

    const infoTool = findTool("ideviceinfo");
    const devices: IosDevice[] = [];
    for (const udid of udids) {
      const info = await readName(infoTool, udid);
      devices.push({ udid, name: info.name, state: info.state });
    }
    return { devices };
  } catch {
    return { devices: [] };
  }
}
