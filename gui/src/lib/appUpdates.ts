import { invoke } from "@tauri-apps/api/core";

export interface AppUpdateInfo {
  currentVersion: string;
  platform: string;
  latestVersion: string | null;
  title: string | null;
  notes: string | null;
  publishedAt: string | null;
  releaseUrl: string;
  relation: "unknown" | "newer" | "current" | "development";
  availability: "source_only" | "unavailable_platform" | "publisher_not_configured" | "available" | "installable";
  message: string;
}

export interface AppUpdateProgress {
  version: string;
  phase: "downloading" | "verifying" | "installing" | "installed";
  downloaded: number;
  total: number | null;
}

export const APP_RELEASES_URL = "https://github.com/ywjzywn-coder/CrownSweep/releases";
export const appUpdates = {
  check: () => invoke<AppUpdateInfo>("app_update_check"),
  install: (expectedVersion: string) => invoke<void>("app_update_install", { expectedVersion }),
  restart: () => invoke<void>("app_update_restart"),
  openRelease: (url: string) => invoke<void>("app_update_open_release", { url }),
};

export function updateBadge(info: AppUpdateInfo): string {
  if (info.relation === "development") return "开发构建";
  if (info.availability === "source_only") return "源码版";
  if (info.availability === "publisher_not_configured") return "发布身份待配置";
  if (info.availability === "unavailable_platform") return "暂无此架构安装包";
  if (info.relation === "newer") return "发现新版本";
  if (info.relation === "current") return "版本一致";
  return "暂无发行版";
}

export function downloadPercent(progress: AppUpdateProgress): number | undefined {
  if (!progress.total || progress.total <= 0 || !Number.isFinite(progress.total)) return undefined;
  return Math.min(100, Math.max(0, Math.floor(progress.downloaded / progress.total * 100)));
}

export function formatDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
