// iOS 端末の画面ミラーリング (QuickTime USB プロトコル)。
// 端末の隠し USB コンフィグ (ベンダー固有 / サブクラス 0x2A) を有効化し、バルク転送で
// CoreMedia の SYNC/ASYN パケットをやり取りして H.264 を受け取る。
// 実装は danielpaulus/quicktime_video_hack のプロトコル解析に基づく (実験的)。
// Windows では対象のインターフェースに WinUSB ドライバーが必要 (Zadig 等で導入)。
import type { Device, InEndpoint, OutEndpoint } from "usb";
import type { MirrorHandlers } from "./mirror";
import { PacketType, type StreamSettings } from "./protocol";

const APPLE_VENDOR_ID = 0x05ac;
const QT_SUBCLASS = 0x2a;
const MUX_SUBCLASS = 0xfe;
const START_CODE = Buffer.from([0, 0, 0, 1]);

const M = {
  PING: 0x70696e67,
  SYNC: 0x73796e63,
  ASYN: 0x6173796e,
  RPLY: 0x72706c79,
  TIME: 0x74696d65,
  CWPA: 0x63777061,
  AFMT: 0x61666d74,
  CVRP: 0x63767270,
  CLOK: 0x636c6f6b,
  OG: 0x676f2120,
  SKEW: 0x736b6577,
  STOP: 0x73746f70,
  FEED: 0x66656564,
  EAT: 0x65617421,
  RELS: 0x72656c73,
  HPD1: 0x68706431,
  HPA1: 0x68706131,
  HPD0: 0x68706430,
  HPA0: 0x68706130,
  NEED: 0x6e656564,
  SBUF: 0x73627566,
  OPTS: 0x6f707473,
  STIA: 0x73746961,
  SDAT: 0x73646174,
  FDSC: 0x66647363,
  MDIA: 0x6d646961,
  VDIM: 0x7664696d,
  EXTN: 0x6578746e,
  DICT: 0x64696374,
  KEYV: 0x6b657976,
  STRK: 0x7374726b,
  IDXK: 0x6964786b,
  BULV: 0x62756c76,
  DATV: 0x64617476,
  STRV: 0x73747276,
  NMBV: 0x6e6d6276,
  VIDE: 0x76696465
} as const;

const EMPTY_CF = 1n;
const CM_TIME_SIZE = 24;

interface CmTime {
  value: number;
  scale: number;
}

class CmClock {
  private readonly start = process.hrtime.bigint();
  now(): CmTime {
    return { value: Number(process.hrtime.bigint() - this.start), scale: 1_000_000_000 };
  }
}

function writeCmTime(target: Buffer, offset: number, time: CmTime): void {
  target.writeBigUInt64LE(BigInt(Math.max(0, Math.round(time.value))), offset);
  target.writeUInt32LE(time.scale, offset + 8);
  target.writeUInt32LE(1, offset + 12); // kCMTimeFlags_HasBeenRounded
  target.writeBigUInt64LE(0n, offset + 16);
}

function readCmTime(data: Buffer, offset: number): CmTime {
  return { value: Number(data.readBigUInt64LE(offset)), scale: data.readUInt32LE(offset + 8) };
}

// ---- 辞書のシリアライズ / 解析 ----
function chunk(magic: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(payload.length + 8, 0);
  header.writeUInt32LE(magic, 4);
  return Buffer.concat([header, payload]);
}

function float64(value: number): Buffer {
  const result = Buffer.alloc(9);
  result.writeUInt8(6, 0);
  result.writeDoubleLE(value, 1);
  return result;
}

function uint32Number(value: number): Buffer {
  const result = Buffer.alloc(5);
  result.writeUInt8(3, 0);
  result.writeUInt32LE(value, 1);
  return result;
}

// number は NSNumber を表す Buffer で渡す。ここでは型を分けるため専用ラッパーを使う
class NsNumber {
  constructor(readonly bytes: Buffer) {}
}

type SerValue = boolean | string | Buffer | NsNumber | SerDict;
type SerDict = { key: string; value: SerValue }[];

function serializeValue(value: SerValue): Buffer {
  if (typeof value === "boolean") {
    return chunk(M.BULV, Buffer.from([value ? 1 : 0]));
  }
  if (typeof value === "string") return chunk(M.STRV, Buffer.from(value, "utf8"));
  if (value instanceof NsNumber) return chunk(M.NMBV, value.bytes);
  if (Buffer.isBuffer(value)) return chunk(M.DATV, value);
  return serializeDict(value);
}

function serializeDict(dict: SerDict): Buffer {
  const pairs = dict.map((entry) => {
    const key = chunk(M.STRK, Buffer.from(entry.key, "utf8"));
    return chunk(M.KEYV, Buffer.concat([key, serializeValue(entry.value)]));
  });
  return chunk(M.DICT, Buffer.concat(pairs));
}

function parseValue(data: Buffer): { value: unknown; length: number } {
  const length = data.readUInt32LE(0);
  const magic = data.readUInt32LE(4);
  const body = data.subarray(8, length);
  switch (magic) {
    case M.STRV:
      return { value: body.toString("utf8"), length };
    case M.DATV:
      return { value: Buffer.from(body), length };
    case M.BULV:
      return { value: body[0] === 1, length };
    case M.DICT:
    case M.EXTN:
      return { value: parseDict(data.subarray(0, length)), length };
    default:
      return { value: body, length };
  }
}

// 文字列キー / 整数キーのどちらの辞書も Map<string | number, unknown> として読む
function parseDict(data: Buffer): Map<string | number, unknown> {
  const result = new Map<string | number, unknown>();
  let pos = 8;
  while (pos + 8 <= data.length) {
    const pairLength = data.readUInt32LE(pos);
    if (pairLength < 16 || pos + pairLength > data.length) break;
    const pair = data.subarray(pos + 8, pos + pairLength);
    const keyLength = pair.readUInt32LE(0);
    const keyMagic = pair.readUInt32LE(4);
    const key = keyMagic === M.IDXK ? pair.readUInt16LE(8) : pair.subarray(8, keyLength).toString("utf8");
    result.set(key, parseValue(pair.subarray(keyLength)).value);
    pos += pairLength;
  }
  return result;
}

// ---- サンプルバッファ (映像) の解析 ----
interface VideoSample {
  ptsUs: number;
  nalus: Buffer | null;
  isKey: boolean;
  config: Buffer | null;
}

function toMicroseconds(time: CmTime): number {
  return time.scale ? (time.value * 1_000_000) / time.scale : 0;
}

function parseAvcc(avcc: Buffer): Buffer | null {
  try {
    const spsLength = avcc.readUInt16BE(6);
    const sps = avcc.subarray(8, 8 + spsLength);
    const ppsLength = avcc.readUInt16BE(9 + spsLength);
    const pps = avcc.subarray(11 + spsLength, 11 + spsLength + ppsLength);
    return Buffer.concat([START_CODE, sps, START_CODE, pps]);
  } catch {
    return null;
  }
}

function parseFormatDescription(data: Buffer): Buffer | null {
  let pos = 8;
  while (pos + 8 <= data.length) {
    const length = data.readUInt32LE(pos);
    const magic = data.readUInt32LE(pos + 4);
    if (length < 8) return null;
    if (magic === M.EXTN) {
      const extensions = parseDict(data.subarray(pos, pos + length));
      const avcDict = extensions.get(49);
      const avcc = avcDict instanceof Map ? avcDict.get(105) : undefined;
      return Buffer.isBuffer(avcc) ? parseAvcc(avcc) : null;
    }
    pos += length;
  }
  return null;
}

function avccToAnnexB(data: Buffer): { nalus: Buffer; isKey: boolean } {
  const parts: Buffer[] = [];
  let isKey = false;
  let pos = 0;
  while (pos + 4 <= data.length) {
    const size = data.readUInt32BE(pos);
    pos += 4;
    if (size === 0 || pos + size > data.length) break;
    const nal = data.subarray(pos, pos + size);
    if ((nal[0] & 0x1f) === 5) isKey = true;
    parts.push(START_CODE, nal);
    pos += size;
  }
  return { nalus: Buffer.concat(parts), isKey };
}

function parseSampleBuffer(data: Buffer, video: boolean): VideoSample & { outputPts: CmTime | null } {
  const sample: VideoSample & { outputPts: CmTime | null } = {
    ptsUs: 0,
    nalus: null,
    isKey: false,
    config: null,
    outputPts: null
  };
  if (data.length < 8 || data.readUInt32LE(4) !== M.SBUF) throw new Error("sbuf ではありません");
  let pos = 8;
  while (pos + 8 <= data.length) {
    const length = data.readUInt32LE(pos);
    const magic = data.readUInt32LE(pos + 4);
    if (length < 8 || pos + length > data.length) break;
    const body = data.subarray(pos + 8, pos + length);
    if (magic === M.OPTS && body.length >= CM_TIME_SIZE) {
      sample.outputPts = readCmTime(body, 0);
      sample.ptsUs = toMicroseconds(sample.outputPts);
    } else if (magic === M.STIA && body.length >= CM_TIME_SIZE * 3) {
      sample.ptsUs = toMicroseconds(readCmTime(body, CM_TIME_SIZE));
    } else if (magic === M.SDAT && video) {
      const converted = avccToAnnexB(body);
      sample.nalus = converted.nalus;
      sample.isKey = converted.isKey;
    } else if (magic === M.FDSC && video) {
      sample.config = parseFormatDescription(data.subarray(pos, pos + length));
    }
    pos += length;
  }
  return sample;
}

// ---- メッセージ処理 ----
interface ProcessorHandlers {
  write: (data: Buffer) => void;
  onVideoConfig: (config: Buffer) => void;
  onVideoFrame: (payload: Buffer, ptsUs: number, isKey: boolean) => void;
  onFatal: (message: string) => void;
}

function header(length: number, magic: number, ref: bigint, subtype?: number): Buffer {
  const buffer = Buffer.alloc(subtype === undefined ? 16 : 20);
  buffer.writeUInt32LE(length, 0);
  buffer.writeUInt32LE(magic, 4);
  buffer.writeBigUInt64LE(ref, 8);
  if (subtype !== undefined) buffer.writeUInt32LE(subtype, 16);
  return buffer;
}

function asynDict(dict: SerDict, subtype: number, ref: bigint): Buffer {
  const body = serializeDict(dict);
  const head = header(body.length + 20, M.ASYN, ref, subtype);
  return Buffer.concat([head, body]);
}

function simpleAsyn(subtype: number, ref: bigint): Buffer {
  return header(20, M.ASYN, ref, subtype);
}

function reply(correlation: bigint, extra: Buffer): Buffer {
  const buffer = Buffer.alloc(20 + extra.length);
  buffer.writeUInt32LE(buffer.length, 0);
  buffer.writeUInt32LE(M.RPLY, 4);
  buffer.writeBigUInt64LE(correlation, 8);
  buffer.writeUInt32LE(0, 16);
  extra.copy(buffer, 20);
  return buffer;
}

function clockRefReply(correlation: bigint, clockRef: bigint): Buffer {
  const ref = Buffer.alloc(8);
  ref.writeBigUInt64LE(clockRef, 0);
  return reply(correlation, ref);
}

function hpd1Dict(): SerDict {
  return [
    { key: "Valeria", value: true },
    { key: "HEVCDecoderSupports444", value: true },
    {
      key: "DisplaySize",
      value: [
        { key: "Width", value: new NsNumber(float64(1920)) },
        { key: "Height", value: new NsNumber(float64(1200)) }
      ]
    }
  ];
}

// 48kHz / 16bit / 2ch の LPCM。AudioStreamBasicDescription を 56 バイトで渡す
function audioFormats(): Buffer {
  const asbd = Buffer.alloc(56);
  asbd.writeDoubleLE(48000, 0);
  asbd.writeUInt32LE(0x6c70636d, 8);
  asbd.writeUInt32LE(12, 12);
  asbd.writeUInt32LE(4, 16);
  asbd.writeUInt32LE(1, 20);
  asbd.writeUInt32LE(4, 24);
  asbd.writeUInt32LE(2, 28);
  asbd.writeUInt32LE(16, 32);
  asbd.writeUInt32LE(0, 36);
  asbd.writeDoubleLE(48000, 40);
  asbd.writeDoubleLE(48000, 48);
  return asbd;
}

function hpa1Dict(): SerDict {
  return [
    { key: "BufferAheadInterval", value: new NsNumber(float64(0.07300000000000001)) },
    { key: "deviceUID", value: "Valeria" },
    { key: "ScreenLatency", value: new NsNumber(float64(0.04)) },
    { key: "formats", value: audioFormats() },
    { key: "EDIDAC3Support", value: new NsNumber(uint32Number(0)) },
    { key: "deviceName", value: "Valeria" }
  ];
}

class QtMessageProcessor {
  private clock = new CmClock();
  private localAudioClock = new CmClock();
  private needMessage: Buffer | null = null;
  private deviceAudioClockRef = EMPTY_CF;
  private lastConfig: Buffer | null = null;
  private releases = 0;
  private releaseWaiters: (() => void)[] = [];
  private audioStart: { device: CmTime; local: CmTime } | null = null;
  private audioLast: { device: CmTime; local: CmTime } | null = null;
  videoFrames = 0;

  constructor(private readonly handlers: ProcessorHandlers) {}

  receive(data: Buffer): void {
    try {
      this.dispatch(data);
    } catch (error) {
      this.handlers.onFatal(`iOS からのデータを処理できませんでした: ${error instanceof Error ? error.message : error}`);
    }
  }

  private dispatch(data: Buffer): void {
    if (data.length < 8) return;
    switch (data.readUInt32LE(0)) {
      case M.PING: {
        const ping = Buffer.alloc(16);
        ping.writeUInt32LE(16, 0);
        ping.writeUInt32LE(M.PING, 4);
        ping.writeBigUInt64LE(0x0000000100000000n, 8);
        this.handlers.write(ping);
        return;
      }
      case M.SYNC:
        this.handleSync(data);
        return;
      case M.ASYN:
        this.handleAsyn(data);
        return;
      default:
        this.handlers.onFatal(`不明なパケットを受信しました (0x${data.readUInt32LE(0).toString(16)})。`);
    }
  }

  private handleSync(data: Buffer): void {
    const clockRef = data.readBigUInt64LE(4);
    const type = data.readUInt32LE(12);
    const correlation = data.readBigUInt64LE(16);
    const write = this.handlers.write;
    switch (type) {
      case M.OG:
        write(reply(correlation, Buffer.alloc(4)));
        break;
      case M.CWPA: {
        const deviceClockRef = data.readBigUInt64LE(24);
        const localRef = deviceClockRef + 1000n;
        this.localAudioClock = new CmClock();
        this.deviceAudioClockRef = deviceClockRef;
        const hpd1 = asynDict(hpd1Dict(), M.HPD1, EMPTY_CF);
        write(hpd1);
        write(hpd1);
        write(clockRefReply(correlation, localRef));
        write(asynDict(hpa1Dict(), M.HPA1, deviceClockRef));
        break;
      }
      case M.CVRP: {
        const deviceClockRef = data.readBigUInt64LE(24);
        this.needMessage = simpleAsyn(M.NEED, deviceClockRef);
        write(this.needMessage);
        write(clockRefReply(correlation, deviceClockRef + 0x1000afn));
        break;
      }
      case M.CLOK:
        this.clock = new CmClock();
        write(clockRefReply(correlation, clockRef + 0x10000n));
        break;
      case M.TIME: {
        const time = Buffer.alloc(CM_TIME_SIZE);
        writeCmTime(time, 0, this.clock.now());
        write(reply(correlation, time));
        break;
      }
      case M.AFMT: {
        const body = serializeDict([{ key: "Error", value: new NsNumber(uint32Number(0)) }]);
        write(reply(correlation, body));
        break;
      }
      case M.SKEW: {
        const skew = Buffer.alloc(8);
        skew.writeDoubleLE(this.skew(), 0);
        write(reply(correlation, skew));
        break;
      }
      case M.STOP:
        write(reply(correlation, Buffer.alloc(4)));
        break;
      default:
        this.handlers.onFatal(`不明な SYNC パケットを受信しました (0x${type.toString(16)})。`);
    }
  }

  private skew(): number {
    if (!this.audioStart || !this.audioLast) return 48000;
    const localDiff = this.audioLast.local.value - this.audioStart.local.value;
    const deviceDiff = this.audioLast.device.value - this.audioStart.device.value;
    if (deviceDiff <= 0) return 48000;
    const scaled = localDiff * (this.audioStart.device.scale / this.audioStart.local.scale);
    return (this.audioStart.device.scale * scaled) / deviceDiff;
  }

  private handleAsyn(data: Buffer): void {
    const type = data.readUInt32LE(12);
    switch (type) {
      case M.FEED: {
        try {
          const sample = parseSampleBuffer(data.subarray(16), true);
          if (sample.config && (!this.lastConfig || !this.lastConfig.equals(sample.config))) {
            this.lastConfig = sample.config;
            this.handlers.onVideoConfig(sample.config);
          }
          if (sample.nalus && sample.nalus.length > 0 && this.lastConfig) {
            this.videoFrames++;
            this.handlers.onVideoFrame(sample.nalus, sample.ptsUs, sample.isKey);
          }
        } catch {
          // 壊れたフレームは捨てて次を要求する
        }
        if (this.needMessage) this.handlers.write(this.needMessage);
        break;
      }
      case M.EAT: {
        try {
          const sample = parseSampleBuffer(data.subarray(16), false);
          if (sample.outputPts) {
            const entry = { device: sample.outputPts, local: this.localAudioClock.now() };
            this.audioStart ??= entry;
            this.audioLast = entry;
          }
        } catch {
          // 音声は使わない
        }
        break;
      }
      case M.RELS:
        this.releases++;
        this.releaseWaiters.shift()?.();
        break;
      default:
        // SPRP / TJMP / SRAT / TBAS などは応答不要
        break;
    }
  }

  // 端末へ配信停止を伝え、RELS を最大3秒待つ
  async closeSession(): Promise<void> {
    this.handlers.write(simpleAsyn(M.HPA0, this.deviceAudioClockRef));
    this.handlers.write(simpleAsyn(M.HPD0, EMPTY_CF));
    for (let i = 0; i < 2; i++) {
      const released = await Promise.race([
        new Promise<boolean>((resolve) => this.releaseWaiters.push(() => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
      ]);
      if (!released) return;
    }
    this.handlers.write(simpleAsyn(M.HPD0, EMPTY_CF));
  }
}

// ---- USB ----
type UsbModule = typeof import("usb");

async function loadUsb(): Promise<UsbModule> {
  try {
    return await import("usb");
  } catch (error) {
    throw new Error(`USB ライブラリを読み込めません: ${error instanceof Error ? error.message : error}`);
  }
}

function call<T>(run: (callback: (error: unknown, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value as T)));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSerial(value: string): string {
  return value.replace(/[-\0]/g, "").toLowerCase();
}

function formatUdid(serial: string): string {
  const clean = serial.replace(/\0/g, "");
  return clean.length === 24 ? `${clean.slice(0, 8)}-${clean.slice(8)}` : clean;
}

const DRIVER_HINT =
  "iPhone の USB インターフェースを開けません。Zadig などで「Apple iPhone」(QuickTime 用インターフェース) に WinUSB ドライバーを導入してください (README 参照)。";

interface QtConfigInfo {
  qtConfig: number;
  qtInterface: number;
  muxConfig: number;
}

function inspectConfigs(device: Device): QtConfigInfo {
  let muxConfig = -1;
  let qtConfig = -1;
  let qtInterface = -1;
  for (const config of device.allConfigDescriptors ?? []) {
    for (const alternates of config.interfaces) {
      for (const alt of alternates) {
        if (alt.bInterfaceClass === 0xff && alt.bInterfaceSubClass === QT_SUBCLASS) {
          qtConfig = config.bConfigurationValue;
          qtInterface = alt.bInterfaceNumber;
        } else if (alt.bInterfaceClass === 0xff && alt.bInterfaceSubClass === MUX_SUBCLASS && qtConfig !== config.bConfigurationValue) {
          muxConfig = config.bConfigurationValue;
        }
      }
    }
  }
  return { qtConfig, qtInterface, muxConfig };
}

async function readSerial(device: Device): Promise<string> {
  const index = device.deviceDescriptor.iSerialNumber;
  if (!index) return "";
  return (await call<string>((cb) => device.getStringDescriptor(index, (e, v) => cb(e, v)))) ?? "";
}

async function openByUdid(usb: UsbModule, udid: string): Promise<Device | null> {
  const wanted = normalizeSerial(udid);
  let openFailed = false;
  for (const device of usb.getDeviceList()) {
    if (device.deviceDescriptor.idVendor !== APPLE_VENDOR_ID) continue;
    try {
      device.open();
      const serial = normalizeSerial(await readSerial(device));
      if (serial === wanted) return device;
      device.close();
    } catch {
      openFailed = true;
      try {
        device.close();
      } catch {
        // 未オープン
      }
    }
  }
  if (openFailed) throw new Error(DRIVER_HINT);
  return null;
}

const listCache = new Map<string, { udid: string; name: string } | null>();

/** WinUSB 経由で開ける iOS 端末の一覧。usbmuxd が使えない環境の検出用。 */
export async function listUsbIosDevices(): Promise<{ udid: string; name: string }[]> {
  if (activeSession) return [];
  let usb: UsbModule;
  try {
    usb = await loadUsb();
  } catch {
    return [];
  }
  const found: { udid: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const device of usb.getDeviceList()) {
    if (device.deviceDescriptor.idVendor !== APPLE_VENDOR_ID) continue;
    const key = `${device.busNumber}:${device.deviceAddress}`;
    seen.add(key);
    if (!listCache.has(key)) {
      let entry: { udid: string; name: string } | null = null;
      try {
        device.open();
        const serial = await readSerial(device);
        const productIndex = device.deviceDescriptor.iProduct;
        const name = productIndex ? await call<string>((cb) => device.getStringDescriptor(productIndex, (e, v) => cb(e, v))) : "";
        if (serial) entry = { udid: formatUdid(serial), name: name ?? "" };
      } catch {
        entry = null;
      } finally {
        try {
          device.close();
        } catch {
          // 未オープン
        }
      }
      listCache.set(key, entry);
    }
    const cached = listCache.get(key);
    if (cached) found.push(cached);
  }
  for (const key of [...listCache.keys()]) if (!seen.has(key)) listCache.delete(key);
  return found;
}

// テスト用
export const __testing = { QtMessageProcessor, parseSampleBuffer, serializeDict, NsNumber, float64, chunk };

let activeSession: IosMirrorSession | null = null;

export class IosMirrorSession {
  private device: Device | null = null;
  private inEndpoint: InEndpoint | null = null;
  private outEndpoint: OutEndpoint | null = null;
  private processor: QtMessageProcessor | null = null;
  private muxConfig = -1;
  private rx: Buffer[] = [];
  private rxLength = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private stopped = false;
  private frameTimer: NodeJS.Timeout | null = null;

  constructor(private readonly handlers: MirrorHandlers) {}

  async start(_settings: StreamSettings, udid: string): Promise<void> {
    await this.stopInternal();
    this.stopped = false;
    activeSession = this;
    try {
      await this.open(udid);
    } catch (error) {
      await this.stopInternal();
      throw error;
    }
  }

  stop(): void {
    void this.stopInternal();
  }

  private async open(udid: string): Promise<void> {
    const usb = await loadUsb();
    let device = await openByUdid(usb, udid);
    if (!device) throw new Error("iOS 端末が見つかりません。USB 接続と「信頼」を確認してください。");

    let info = inspectConfigs(device);
    if (info.qtConfig < 0) {
      // 隠し QuickTime コンフィグを有効化する。端末は USB から切断され、再接続される
      await call<unknown>((cb) => device!.controlTransfer(0x40, 0x52, 0x00, 0x02, Buffer.alloc(0), (e, v) => cb(undefined, v))).catch(
        () => undefined
      );
      try {
        device.close();
      } catch {
        // すでに切断済み
      }
      device = null;
      for (let i = 0; i < 12 && !device; i++) {
        await sleep(500);
        const candidate = await openByUdid(usb, udid).catch(() => null);
        if (candidate && inspectConfigs(candidate).qtConfig >= 0) device = candidate;
        else candidate?.close();
      }
      if (!device) throw new Error("iPhone の画面ミラーリング用 USB コンフィグを有効化できませんでした。端末のロックを解除して再試行してください。");
      info = inspectConfigs(device);
    }
    this.device = device;
    this.muxConfig = info.muxConfig;

    if (device.configDescriptor?.bConfigurationValue !== info.qtConfig) {
      await call<void>((cb) => device!.setConfiguration(info.qtConfig, (e) => cb(e)));
    }
    const iface = device.interface(info.qtInterface);
    iface.claim();
    const endpoints = iface.endpoints;
    const input = endpoints.find((e) => e.direction === "in") as InEndpoint | undefined;
    const output = endpoints.find((e) => e.direction === "out") as OutEndpoint | undefined;
    if (!input || !output) throw new Error("iPhone の USB エンドポイントが見つかりません。");
    await call<void>((cb) => input.clearHalt((e) => cb(e))).catch(() => undefined);
    await call<void>((cb) => output.clearHalt((e) => cb(e))).catch(() => undefined);
    this.inEndpoint = input;
    this.outEndpoint = output;

    this.processor = new QtMessageProcessor({
      write: (data) => this.write(data),
      onVideoConfig: (config) => this.handlers.onPacket({ type: PacketType.VideoConfig, ptsUs: 0, payload: new Uint8Array(config) }),
      onVideoFrame: (payload, ptsUs, isKey) => {
        if (this.frameTimer) {
          clearTimeout(this.frameTimer);
          this.frameTimer = null;
        }
        this.handlers.onPacket({
          type: isKey ? PacketType.VideoKeyFrame : PacketType.VideoFrame,
          ptsUs: Math.round(ptsUs),
          payload: new Uint8Array(payload)
        });
      },
      onFatal: (message) => this.fail(message)
    });

    input.on("data", (data: Buffer) => this.onData(data));
    input.on("error", (error: Error) => this.fail(`USB 受信エラー: ${error.message}`));
    input.startPoll(3, 16384);
    this.handlers.onStatus("connected", "iPhone に接続しました。映像を待っています…");
    this.frameTimer = setTimeout(
      () => this.fail("iPhone から映像が届きません。端末のロックを解除し、「このコンピュータを信頼」を確認してください。"),
      20_000
    );
  }

  private write(data: Buffer): void {
    const output = this.outEndpoint;
    if (!output) return;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          try {
            output.transfer(data, () => resolve());
          } catch {
            resolve();
          }
        })
    );
  }

  private onData(data: Buffer): void {
    this.rx.push(data);
    this.rxLength += data.length;
    let buffer = this.rx.length === 1 ? this.rx[0] : Buffer.concat(this.rx);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 8 || length > 64 * 1024 * 1024) {
        this.fail("iPhone から不正なデータを受信しました。");
        return;
      }
      if (buffer.length < length) break;
      this.processor?.receive(Buffer.from(buffer.subarray(4, length)));
      buffer = buffer.subarray(length);
    }
    this.rx = buffer.length ? [buffer] : [];
    this.rxLength = buffer.length;
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.handlers.onStatus("disconnected", message);
    void this.stopInternal();
  }

  private async stopInternal(): Promise<void> {
    if (this.stopped && !this.device) return;
    this.stopped = true;
    if (activeSession === this) activeSession = null;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;

    const device = this.device;
    const input = this.inEndpoint;
    const processor = this.processor;
    this.device = null;
    this.inEndpoint = null;
    this.processor = null;
    if (!device) {
      this.outEndpoint = null;
      return;
    }
    try {
      await processor?.closeSession();
      await this.writeChain;
    } catch {
      // 切断済み
    }
    this.outEndpoint = null;
    try {
      await new Promise<void>((resolve) => (input ? input.stopPoll(() => resolve()) : resolve()));
    } catch {
      // 停止済み
    }
    try {
      await call<unknown>((cb) => device.controlTransfer(0x40, 0x52, 0x00, 0x00, Buffer.alloc(0), (e, v) => cb(undefined, v)));
      if (this.muxConfig >= 0) await call<void>((cb) => device.setConfiguration(this.muxConfig, (e) => cb(e)));
    } catch {
      // 端末が通常コンフィグへ戻る際の切断は無視する
    }
    try {
      device.close();
    } catch {
      // 切断済み
    }
  }
}
