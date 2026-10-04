import type { AppEntry, CleanPreview, EngineInfo } from "../lib/api";
import type { AppUpdateInfo } from "../lib/appUpdates";
import { version } from "../../package.json";

// Synthetic, fixed data only. These paths are labels, never filesystem targets.
export const PREVIEW_HOME = "/Preview/演示用户";
export const PREVIEW_ENGINE: EngineInfo = {
  path: "/Preview/bin/mole", version: "1.56.1", config_dir: `${PREVIEW_HOME}/.config/mole`,
};
const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PREVIEW_APPS: AppEntry[] = Array.from({ length: 100 }, (_, index) => {
  const number = String(index + 1).padStart(3, "0");
  const name = index === 8 ? "演示应用 009 · 用于核对长名称及多行文字对齐" : `演示应用 ${number}`;
  return {
    name, uninstall_name: name, bundle_id: `org.crownsweep.preview.app${number}`,
    source: index % 5 === 0 ? "Homebrew" : "Applications",
    path: `/Preview/Applications/${name}.app`, size: `${1200 - index * 11} MB`, size_hint_mb: 1200 - index * 11,
  };
});

const cleanItems = Array.from({ length: 64 }, (_, index) => ({
  path: `${PREVIEW_HOME}/Library/Caches/演示缓存-${String(index + 1).padStart(3, "0")}${index === 2 ? "/这个很长的路径用于检查保护按钮和容量列在最小窗口下是否换行正确" : ""}`,
  size: `${32 + index} MB`, size_bytes: (32 + index) * MB,
}));
export const PREVIEW_WHITELIST = [cleanItems[0].path, `${PREVIEW_HOME}/Documents/保留的项目资料`];
export const PREVIEW_CLEAN: CleanPreview = {
  groups: [
    { title: "用户缓存（演示）", items: cleanItems },
    { title: "临时文件（演示）", items: [
      { path: `${PREVIEW_HOME}/Library/Logs/演示日志`, size: "48 MB", size_bytes: 48 * MB },
      { path: "/Preview/private/var/tmp/演示临时文件", size: "16 MB", size_bytes: 16 * MB },
    ] },
  ],
  summary: ["演示预览，不检查或删除任何本机文件", "66 个固定演示项目"],
  paths: [...cleanItems.map(item => item.path), `${PREVIEW_HOME}/Library/Logs/演示日志`, "/Preview/private/var/tmp/演示临时文件"],
  raw: "演示数据：没有运行 Mole clean --dry-run。", timed_out: false,
};

export const PREVIEW_ANALYZE = {
  path: PREVIEW_HOME, scan_status: "partial", total_size: 42 * GB, total_files: 12540,
  entries: Array.from({ length: 105 }, (_, index) => {
    const name = index === 3 ? "演示目录 004 · 很长的项目归档名称用于验证表格对齐与省略" : `演示目录 ${String(index + 1).padStart(3, "0")}`;
    const unavailable = index === 104;
    return {
      name, path: `${PREVIEW_HOME}/${name}`, size: unavailable ? -1 : (1200 - index * 10) * MB,
      is_dir: true, scan_status: unavailable ? "unavailable" : index === 103 ? "partial" : "complete",
      insight: index % 8 === 0, cleanable: index % 8 === 0,
    };
  }),
  large_files: Array.from({ length: 105 }, (_, index) => ({
    name: `演示归档 ${String(index + 1).padStart(3, "0")}.zip`,
    path: `${PREVIEW_HOME}/Downloads/演示归档 ${String(index + 1).padStart(3, "0")}.zip`, size: (800 - index * 5) * MB,
  })),
};

export const PREVIEW_HISTORY = {
  sessions: [
    { started_at: "2026-10-03 10:24:00", action: "analyze", size: "演示 · 105 项" },
    { started_at: "2026-10-02 19:45:00", action: "clean", size: "演示 · 384 MB" },
    { started_at: "2026-10-02 18:30:00", action: "uninstall", size: "演示 · 2 个应用" },
    { started_at: "2026-10-01 09:15:00", action: "optimize", size: "演示 · 4 项" },
  ],
  deletions: [
    { time: "2026-10-02 19:45:00", action: `${PREVIEW_HOME}/Library/Caches/演示缓存`, size: "384 MB" },
    { time: "2026-10-02 18:30:00", action: "/Preview/Applications/演示应用.app", size: "1.2 GB" },
  ],
  logs: { operations: `${PREVIEW_HOME}/.config/mole/演示操作记录.log` },
};

export const PREVIEW_UPDATE: AppUpdateInfo = {
  currentVersion: version, platform: "darwin-aarch64", latestVersion: "0.3.1",
  title: "CrownSweep 0.3.1（演示源码版本）", notes: "固定演示数据。当前没有可安装的已签名、公证二进制包。",
  publishedAt: "2026-10-02T00:00:00Z", releaseUrl: "https://github.com/ywjzywn-coder/CrownSweep/releases",
  relation: "development", availability: "source_only", message: "演示：当前仅提供源码，尚无可安装的正式二进制包。",
};

export const PREVIEW_SMC = {
  temps: [{ key: "TC0P", label: "CPU（演示）", value: 48.5 }, { key: "TG0P", label: "GPU（演示）", value: 43.2 }],
  fans: [{ index: 0, current: 1800, min: 1200, max: 6800, target: 1800, mode: "auto" }],
};

const cpuSamples = [12, 18, 24, 15, 32, 26, 19, 22];
export function previewSnapshot(index = 0) {
  const cpu = cpuSamples[index % cpuSamples.length];
  return {
    health_score: 88, health_score_msg: "good", uptime_seconds: 216420,
    hardware: { model: "演示 MacBook Pro", cpu_model: "Apple Silicon（演示）", total_ram: "16 GB", os_version: "macOS 15（演示）" },
    cpu: { usage: cpu, cores: 8, load1: 1.24, p_core_count: 4, e_core_count: 4, per_core: [cpu, 12, 7, 18, 24, 8, 5, 10] },
    memory: { total: 16 * GB, used: 8.4 * GB, used_percent: 52.5 + index % 4, pressure: "normal" },
    network: [{ rx_rate_mbs: 1.24, tx_rate_mbs: 0.38 }],
    network_history: { rx_history: [0.1, 0.8, 1.2, 0.6, 2.1, 1.7, 1.24], tx_history: [0.05, 0.12, 0.32, 0.15, 0.42, 0.29, 0.38] },
    batteries: [{ percent: 82, capacity: 96, cycle_count: 124, status: "charging" }],
    disks: [{ mount: "/", used_percent: 62, used: 310 * GB, total: 500 * GB, smart_status: "Verified" }],
    top_processes: [
      { pid: 101, name: "CrownSweep（演示）", command: "/Preview/CrownSweep.app", cpu: 3.2, memory_bytes: 184 * MB },
      { pid: 102, name: "演示浏览器", command: "/Preview/Browser.app", cpu: 2.5, memory_bytes: 420 * MB },
      { pid: 103, name: "演示编辑器", command: "/Preview/Editor.app", cpu: 1.8, memory_bytes: 240 * MB },
    ],
    process_alerts: [], bluetooth: [{ connected: true, name: "演示无线耳机", battery: "78%" }],
    trash_size: 384 * MB, thermal: { cpu_temp: 48.5, system_power: 13.6 },
    disk_io: { read_rate: 2.3, write_rate: 0.8 }, gpu: [{ name: "GPU（演示）", usage: 8.2, core_count: 8 }],
    procs: 284, zombie_count: 0,
  };
}

export function previewAppIcon(path: string): string {
  const index = PREVIEW_APPS.findIndex(app => app.path === path);
  if (index < 0) throw new Error("演示模式只提供固定应用图标。没有读取本机路径。");
  const colors = ["#d1a168", "#8aaac9", "#92b29d", "#b7a0c6"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="15" fill="${colors[index % colors.length]}"/><text x="32" y="41" text-anchor="middle" font-size="24" font-family="sans-serif" fill="#252728">${String(index + 1).padStart(2, "0")}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
