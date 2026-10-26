import { PacketType } from "./protocol";

function findSps(data: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 4 < data.length; i++) {
    const startCode3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const startCode4 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    if (!startCode3 && !startCode4) continue;
    const nal = i + (startCode3 ? 3 : 4);
    if ((data[nal] & 0x1f) === 7 && nal + 3 < data.length) return data.subarray(nal);
  }
  return null;
}

function hex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** H.264 (Annex B) を WebCodecs でデコードし、canvas に最新フレームだけを描画する。 */
class VideoPlayer {
  private decoder: VideoDecoder | null = null;
  private config: Uint8Array | null = null;
  private needKeyFrame = true;
  private pending: VideoFrame | null = null;
  private nativeWidth = 0;
  private nativeHeight = 0;
  private stretchLandscape = false;
  private reportedWidth = 0;
  private reportedHeight = 0;
  private readonly context: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (message: string) => void,
    private readonly onResize: (width: number, height: number) => void
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas を初期化できません。");
    this.context = context;
    requestAnimationFrame(this.render);
  }

  setConfig(config: Uint8Array): void {
    const sps = findSps(config);
    if (!sps) {
      this.onError("映像の SPS を解析できませんでした。");
      return;
    }
    this.config = config;
    this.configure(`avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`);
  }

  decode(payload: Uint8Array, ptsUs: number, isKey: boolean): void {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured" || !this.config) return;
    if (isKey) this.needKeyFrame = false;
    if (this.needKeyFrame) return;

    let data = payload;
    if (isKey) {
      // Annex B ではキーフレームの直前に SPS/PPS を付与する
      data = new Uint8Array(this.config.length + payload.length);
      data.set(this.config);
      data.set(payload, this.config.length);
    }
    decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: ptsUs, data }));
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
    this.pending?.close();
    this.pending = null;
    this.config = null;
    this.needKeyFrame = true;
    this.nativeWidth = 0;
    this.nativeHeight = 0;
    this.reportedWidth = 0;
    this.reportedHeight = 0;
  }

  setLandscapeStretch(enabled: boolean): void {
    this.stretchLandscape = enabled;
    this.updateCanvasSize();
  }

  private configure(codec: string): void {
    this.decoder?.close();
    this.needKeyFrame = true;
    const decoder = new VideoDecoder({
      output: (frame) => {
        this.pending?.close();
        this.pending = frame;
      },
      error: (error) => {
        this.onError(`映像デコードエラー: ${error.message}`);
        // 次のキーフレーム(1秒間隔)で復帰する
        if (this.config && this.decoder === decoder) {
          const sps = findSps(this.config);
          if (sps) this.configure(codec);
        }
      }
    });
    this.decoder = decoder;
    decoder.configure({ codec, optimizeForLatency: true });
  }

  private updateCanvasSize(): void {
    if (!this.nativeWidth || !this.nativeHeight) return;
    const stretch = this.stretchLandscape && this.nativeWidth > this.nativeHeight;
    const width = stretch ? 1920 : this.nativeWidth;
    const height = stretch ? 1080 : this.nativeHeight;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (this.reportedWidth !== width || this.reportedHeight !== height) {
      this.reportedWidth = width;
      this.reportedHeight = height;
      this.onResize(width, height);
    }
  }

  private readonly render = (): void => {
    const frame = this.pending;
    if (frame) {
      this.pending = null;
      if (this.nativeWidth !== frame.displayWidth || this.nativeHeight !== frame.displayHeight) {
        this.nativeWidth = frame.displayWidth;
        this.nativeHeight = frame.displayHeight;
        this.updateCanvasSize();
      }
      this.context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
      frame.close();
    }
    requestAnimationFrame(this.render);
  };
}

/** AAC-LC を AudioDecoder でデコードし、AudioContext で連続再生する。 */
class AudioPlayer {
  private decoder: AudioDecoder | null = null;
  private context: AudioContext | null = null;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;
  private nextTime = 0;

  constructor(private readonly onError: (message: string) => void) {}

  // 録画用。再生音と同じ音声を MediaStream として取り出す
  get stream(): MediaStream | null {
    return this.recordDestination?.stream ?? null;
  }

  // ユーザー操作 (接続ボタン) の中で呼び、自動再生ポリシーを満たす
  async unlock(): Promise<void> {
    this.context ??= new AudioContext({ latencyHint: "interactive" });
    this.recordDestination ??= this.context.createMediaStreamDestination();
    await this.context.resume();
  }

  setConfig(description: Uint8Array): void {
    this.decoder?.close();
    const decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: (error) => this.onError(`音声デコードエラー: ${error.message}`)
    });
    this.decoder = decoder;
    decoder.configure({ codec: "mp4a.40.2", sampleRate: 48_000, numberOfChannels: 2, description });
  }

  decode(payload: Uint8Array, ptsUs: number): void {
    if (this.decoder?.state !== "configured") return;
    this.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: ptsUs, data: payload }));
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
    this.nextTime = 0;
  }

  private play(data: AudioData): void {
    const context = this.context;
    if (!context) {
      data.close();
      return;
    }

    const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
    for (let channel = 0; channel < data.numberOfChannels; channel++) {
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
      buffer.copyToChannel(samples, channel);
    }
    data.close();

    // 遅延が溜まったら詰め、再生が途切れたら少し余裕を持って再開する
    const now = context.currentTime;
    if (this.nextTime < now + 0.02 || this.nextTime > now + 0.3) this.nextTime = now + 0.06;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    if (this.recordDestination) source.connect(this.recordDestination);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }
}

export class MirrorPlayer {
  private readonly video: VideoPlayer;
  private readonly audio: AudioPlayer;

  constructor(
    canvas: HTMLCanvasElement,
    onError: (message: string) => void,
    onResize: (width: number, height: number) => void = () => undefined
  ) {
    this.video = new VideoPlayer(canvas, onError, onResize);
    this.audio = new AudioPlayer(onError);
  }

  unlockAudio(): Promise<void> {
    return this.audio.unlock();
  }

  /** canvas の映像と再生音声をまとめた録画用 MediaStream。 */
  createRecordingStream(canvas: HTMLCanvasElement): MediaStream {
    const stream = canvas.captureStream(60);
    this.audio.stream?.getAudioTracks().forEach((track) => stream.addTrack(track));
    return stream;
  }

  handlePacket(type: number, ptsUs: number, payload: Uint8Array): void {
    switch (type) {
      case PacketType.VideoConfig:
        this.video.setConfig(payload);
        break;
      case PacketType.VideoFrame:
        this.video.decode(payload, ptsUs, false);
        break;
      case PacketType.VideoKeyFrame:
        this.video.decode(payload, ptsUs, true);
        break;
      case PacketType.AudioConfig:
        this.audio.setConfig(payload);
        break;
      case PacketType.AudioFrame:
        this.audio.decode(payload, ptsUs);
        break;
    }
  }

  reset(): void {
    this.video.close();
    this.audio.close();
  }

  setLandscapeStretch(enabled: boolean): void {
    this.video.setLandscapeStretch(enabled);
  }
}
