export const MIRROR_PORT = 27183;

// Android 側 MirrorService の TYPE_* と一致させる
export const PacketType = {
  VideoConfig: 0,
  VideoFrame: 1,
  VideoKeyFrame: 2,
  AudioConfig: 3,
  AudioFrame: 4
} as const;

export interface MirrorPacket {
  type: number;
  ptsUs: number;
  payload: Uint8Array;
}

/** PC から端末へ接続直後に1回だけ送る配信設定。 */
export interface StreamSettings {
  /** 映像の長辺ピクセル数。0 は端末の原寸。 */
  longEdge: number;
  fps: number;
  bitRate: number;
  /** 配信中に端末側のメディア音量を 0 にする。 */
  muteDevice: boolean;
}

export const DEFAULT_SETTINGS: StreamSettings = {
  longEdge: 1920,
  fps: 60,
  bitRate: 8_000_000,
  muteDevice: true
};

const ALLOWED_LONG_EDGES = [0, 1280, 1920];
const ALLOWED_FPS = [30, 60];
const ALLOWED_BIT_RATES = [2_000_000, 4_000_000, 8_000_000];

function pick(value: unknown, allowed: number[], fallback: number): number {
  return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

/** レンダラーから受け取った値を許可リストで検証する。 */
export function sanitizeSettings(input: unknown): StreamSettings {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Partial<StreamSettings>;
  return {
    longEdge: pick(raw.longEdge, ALLOWED_LONG_EDGES, DEFAULT_SETTINGS.longEdge),
    fps: pick(raw.fps, ALLOWED_FPS, DEFAULT_SETTINGS.fps),
    bitRate: pick(raw.bitRate, ALLOWED_BIT_RATES, DEFAULT_SETTINGS.bitRate),
    muteDevice: typeof raw.muteDevice === "boolean" ? raw.muteDevice : DEFAULT_SETTINGS.muteDevice
  };
}

// Android 側 StreamSettings.kt と一致させる
// "MRCF" | longEdge: u16 | fps: u8 | flags: u8 (bit0 = 端末を消音) | bitRate: u32 (ビッグエンディアン)
export const SETTINGS_PACKET_SIZE = 12;

export function encodeSettings(settings: StreamSettings): Buffer {
  const buffer = Buffer.alloc(SETTINGS_PACKET_SIZE);
  buffer.write("MRCF", 0, "ascii");
  buffer.writeUInt16BE(settings.longEdge, 4);
  buffer.writeUInt8(settings.fps, 6);
  buffer.writeUInt8(settings.muteDevice ? 1 : 0, 7);
  buffer.writeUInt32BE(settings.bitRate, 8);
  return buffer;
}

const HEADER_SIZE = 13; // u8 + i64 + u32 (ビッグエンディアン)
const MAX_PAYLOAD_SIZE = 16 * 1024 * 1024;

/** TCP のチャンク境界に依存せず、パケットを切り出すストリームパーサー。 */
export class PacketParser {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): MirrorPacket[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;

    const packets: MirrorPacket[] = [];
    let data = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    let offset = 0;

    while (data.length - offset >= HEADER_SIZE) {
      const type = data.readUInt8(offset);
      const ptsUs = Number(data.readBigInt64BE(offset + 1));
      const size = data.readUInt32BE(offset + 9);

      if (type > PacketType.AudioFrame || size > MAX_PAYLOAD_SIZE) {
        throw new Error(`Invalid packet header (type=${type}, size=${size}).`);
      }
      if (data.length - offset < HEADER_SIZE + size) {
        break;
      }

      const start = offset + HEADER_SIZE;
      // 共有プールを丸ごと IPC に載せないよう、独立した配列にコピーする
      packets.push({ type, ptsUs, payload: new Uint8Array(data.subarray(start, start + size)) });
      offset = start + size;
    }

    const rest = data.subarray(offset);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return packets;
  }
}
