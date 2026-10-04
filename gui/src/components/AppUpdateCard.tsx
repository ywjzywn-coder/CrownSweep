import { useEffect, useRef, useState } from "react";
import { version } from "../../package.json";
import { onEvent } from "../lib/api";
import { APP_RELEASES_URL, appUpdates, downloadPercent, formatDownloadBytes, updateBadge, type AppUpdateInfo, type AppUpdateProgress } from "../lib/appUpdates";
import ConfirmDialog from "./ConfirmDialog";
import { IconDownload, IconRefresh } from "./icons";

interface Props { busy: boolean }

export default function AppUpdateCard({ busy }: Props) {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [progressReady, setProgressReady] = useState(false);
  const installingVersion = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onEvent<AppUpdateProgress>("app-update-progress", (event) => {
      if (!disposed && event.version === installingVersion.current) setProgress(event);
    }).then((stop) => { if (disposed) stop(); else { unlisten = stop; setProgressReady(true); } }).catch(() => {
      if (!disposed) setError("更新进度监听不可用，请重启应用后重试");
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  async function check() {
    setChecking(true); setError(null); setConfirm(false);
    try {
      const result = await appUpdates.check();
      setInfo(result); setCheckedAt(new Date()); setStale(false);
    } catch (reason) {
      setError(String(reason)); setStale(true);
    } finally { setChecking(false); }
  }

  async function install() {
    setConfirm(false);
    if (busy || !progressReady || !info?.latestVersion || info.availability !== "installable" || stale) return;
    installingVersion.current = info.latestVersion;
    setError(null); setInstalling(true);
    setProgress({ version: info.latestVersion, phase: "downloading", downloaded: 0, total: null });
    try {
      await appUpdates.install(info.latestVersion);
      setInstalled(true);
    } catch (reason) {
      setError(String(reason)); setProgress(null);
    } finally {
      installingVersion.current = null; setInstalling(false);
    }
  }

  async function openRelease() {
    try { await appUpdates.openRelease(info?.releaseUrl ?? APP_RELEASES_URL); }
    catch (reason) { setError(String(reason)); }
  }

  const progressLabel = progress?.phase === "verifying" ? "正在验证更新签名与 macOS 公证"
    : progress?.phase === "installing" ? "正在安装更新" : progress?.phase === "installed" ? "更新已安装" : "正在下载更新";
  const percent = progress ? downloadPercent(progress) : undefined;
  return <section className="card app-update-card" aria-labelledby="app-update-title">
    <div className="app-update-header">
      <div><h3 id="app-update-title">CrownSweep 应用更新</h3><p className="note">当前应用 {version} · macOS 桌面客户端</p></div>
      <span className={`badge ${installed ? "green" : info?.availability === "installable" && !stale ? "yellow" : "dim"}`}>
        {installed ? "等待重启" : checking ? "正在检查" : stale ? "查询失败" : info ? updateBadge(info) : "尚未检查"}
      </span>
    </div>
    <div className="app-update-status" aria-live="polite">
      <p>{installed ? "新版已安装，重启后开始使用。" : info?.message ?? "检查 CrownSweep 自身的版本与发行说明。Mole 引擎在下方独立管理。"}</p>
      {info?.relation === "development" && <p className="note">当前 {info.currentVersion} 高于已发布的 {info.latestVersion}，不会降级安装。</p>}
      {stale && info && <p className="note">以下保留上次查询结果，暂不能据此安装更新。</p>}
    </div>
    {info && <div className="app-update-meta">
      <span>已发布 GUI：{info.latestVersion ?? "暂无"}</span>
      <span>适用架构：{info.platform === "darwin-aarch64" ? "Apple Silicon" : "Intel"}</span>
      {info.publishedAt && <span>发布于 {new Date(info.publishedAt).toLocaleDateString()}</span>}
    </div>}
    {info?.notes && <details className="app-update-notes"><summary>查看发行说明{info.title ? ` · ${info.title}` : ""}</summary><pre>{info.notes}</pre></details>}
    {progress && <div className="app-update-progress" role="status">
      <div className="row"><span>{progressLabel}</span><span className="mono">{formatDownloadBytes(progress.downloaded)}{progress.total != null && ` / ${formatDownloadBytes(progress.total)}`}{percent != null && ` · ${percent}%`}</span></div>
      <progress max={100} value={progress.phase === "installed" ? 100 : progress.phase === "downloading" ? percent : undefined} aria-label={progressLabel} />
    </div>}
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="row wrap">
      <button className="btn" disabled={checking || installing || installed} onClick={() => { void check(); }}><IconRefresh size={14} />{checking ? "检查中…" : "检查应用更新"}</button>
      <button className="btn" disabled={installing} onClick={() => { void openRelease(); }}>项目发行页</button>
      {info?.availability === "installable" && !installed && <button className="btn primary" disabled={checking || installing || busy || stale || !progressReady} onClick={() => setConfirm(true)}><IconDownload size={14} />{installing ? "更新中…" : "下载并安装"}</button>}
      {installed && <button className="btn primary" disabled={busy} onClick={() => { void appUpdates.restart().catch(reason => setError(String(reason))); }}>重启 CrownSweep</button>}
    </div>
    {info?.availability === "installable" && busy && <p className="note">请等待扫描和维护任务结束后再安装更新。</p>}
    <p className="note">发布源：GitHub · ywjzywn-coder/CrownSweep{checkedAt && ` · 上次查询 ${checkedAt.toLocaleString()}`}</p>
    <ConfirmDialog open={confirm} title={`安装 CrownSweep ${info?.latestVersion ?? ""}`} confirmText="下载并安装" onCancel={() => setConfirm(false)} onConfirm={() => { void install(); }}>
      <p>将下载适用于此 Mac 的更新包，验证更新签名、固定 Developer ID 与 macOS 公证后替换应用。</p>
      <p className="note">安装完成后由你点击重启。请先完成正在运行的扫描和维护任务。</p>
    </ConfirmDialog>
  </section>;
}
