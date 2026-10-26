import { contextBridge, ipcRenderer } from "electron";

interface MirrorPacket {
  type: number;
  ptsUs: number;
  payload: Uint8Array;
}

interface MirrorStatus {
  state: "connected" | "disconnected";
  message: string;
}

contextBridge.exposeInMainWorld("mirroringApp", {
  getAlwaysOnTop: (): Promise<boolean> =>
    ipcRenderer.invoke("window:get-always-on-top"),
  toggleAlwaysOnTop: (): Promise<boolean> =>
    ipcRenderer.invoke("window:toggle-always-on-top"),
  connect: (settings: unknown, serial?: string): Promise<{ ok: boolean; code?: string; message?: string }> =>
    ipcRenderer.invoke("mirror:connect", settings, serial),
  listDevices: (): Promise<
    | {
        ok: true;
        devices: { serial: string; state: string; model: string }[];
        iosDevices: { udid: string; name: string; state: "device" | "untrusted" | "unknown" }[];
        iosWarning?: string;
        wifiDevices: { serial: string; name: string; connected: boolean }[];
      }
    | { ok: false; code: string; message: string }
  > => ipcRenderer.invoke("devices:list"),
  connectWifi: (address: string): Promise<{ ok: boolean; serial?: string; message: string }> =>
    ipcRenderer.invoke("adb:connect-wifi", address),
  installApk: (serial: string): Promise<{ status: "installed" | "up-to-date" | "no-apk" | "failed"; message: string }> =>
    ipcRenderer.invoke("device:install", serial),
  setCaptureMode: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("window:set-capture-mode", enabled),
  setVideoSize: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke("window:video-size", width, height),
  setView: (view: "idle" | "active"): Promise<void> => ipcRenderer.invoke("window:set-view", view),
  minimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("window:close"),
  disconnect: (): Promise<void> => ipcRenderer.invoke("mirror:disconnect"),
  toggleFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke("window:toggle-fullscreen"),
  onFullScreenChange: (callback: (enabled: boolean) => void): void => {
    ipcRenderer.on("window:fullscreen-changed", (_event, enabled: boolean) => callback(enabled));
  },
  startRecording: (extension: string): Promise<void> =>
    ipcRenderer.invoke("recording:start", extension),
  writeRecordingChunk: (chunk: Uint8Array): Promise<void> =>
    ipcRenderer.invoke("recording:chunk", chunk),
  stopRecording: (): Promise<{ saved: boolean; path?: string; message?: string }> =>
    ipcRenderer.invoke("recording:stop"),
  onPacket: (callback: (packet: MirrorPacket) => void): void => {
    ipcRenderer.on("mirror:packet", (_event, packet: MirrorPacket) => callback(packet));
  },
  onStatus: (callback: (status: MirrorStatus) => void): void => {
    ipcRenderer.on("mirror:status", (_event, status: MirrorStatus) => callback(status));
  }
});
