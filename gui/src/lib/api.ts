import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface EngineInfo {
  path: string;
  version: string;
  config_dir: string;
}

export interface AppEntry {
  name: string;
  bundle_id: string;
  source: string;
  uninstall_name: string;
  path: string;
  size: string;
  size_hint_mb: number;
}

export interface UninstallList {
  apps: AppEntry[];
  raw: string;
  json: boolean;
}

export interface CleanItem {
  path: string;
  size: string;
  size_bytes: number;
}

export interface CleanGroup {
  title: string;
  items: CleanItem[];
}

export interface CleanPreview {
  groups: CleanGroup[];
  summary: string[];
  paths: string[];
  raw: string;
  timed_out: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const api = {
  engineDetect: () => invoke<EngineInfo | null>("engine_detect"),
  statusStart: () => invoke<void>("status_start"),
  statusStop: () => invoke<void>("status_stop"),
  statusSnapshot: () => invoke<Json>("status_snapshot"),
  analyzeRun: (path: string) => invoke<Json>("analyze_run", { path }),
  historyRun: () => invoke<Json>("history_run"),
  cleanPreview: () => invoke<CleanPreview>("clean_preview"),
  whitelistList: () => invoke<string[]>("whitelist_list"),
  whitelistAdd: (pattern: string) => invoke<string[]>("whitelist_add", { pattern }),
  whitelistRemove: (pattern: string) => invoke<string[]>("whitelist_remove", { pattern }),
  touchidStatus: () => invoke<{ enabled: boolean }>("touchid_status"),
  smcRead: () =>
    invoke<{ temps: { key: string; label: string; value: number }[]; fans: { index: number; current: number; min: number; max: number; target: number; mode: string }[] }>("smc_read"),
  uninstallList: () => invoke<UninstallList>("uninstall_list"),
  appIcon: (path: string) => invoke<string>("app_icon", { path }),
  ptyStart: (id: string, program: string, args: string[], cols: number, rows: number) =>
    invoke<void>("pty_start", { id, program, args, cols, rows }),
  ptyWrite: (id: string, dataB64: string) => invoke<void>("pty_write", { id, data: dataB64 }),
  ptyWriteSecret: (id: string, password: string) => invoke<void>("pty_write_secret", { id, password }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  homeDir: () => invoke<string>("home_dir"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
};

export const onEvent = <T,>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> =>
  listen<T>(name, (e) => handler(e.payload));

export const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const bytesToB64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};

export function fmtBytes(n: number | undefined | null, digits = 1): string {
  if (n == null || isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : digits)} ${units[u]}`;
}

export function fmtDuration(seconds: number | undefined | null): string {
  if (seconds == null || isNaN(seconds)) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}
