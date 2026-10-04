import ConfirmDialog from "../components/ConfirmDialog";
import { PageHeader, EmptyState, Steps, EngineNotice } from "../components/Page";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../App";
import { IconSearch } from "../components/icons";
import { api, CleanItem, CleanPreview, fmtBytes } from "../lib/api";
import { isScanCancelled, useScans } from "../lib/scanTasks";

export default function Clean() {
  const { engine, openTask, isTagRunning } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<CleanPreview | null>(null);
  const { scans, runScan, cancelScan } = useScans();
  const active = scans.find((scan) => scan.tag === "clean-preview" && (scan.status === "running" || scan.status === "cancelling"));
  const scanning = !!active;
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [whitelistState, setWhitelistState] = useState<"loading" | "ready" | "failed">("loading");
  const [whitelistError, setWhitelistError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const wizardRunning = isTagRunning("clean");

  const loadWhitelist = async () => {
    setWhitelistState("loading"); setWhitelistError(null);
    try { setWhitelist(await api.whitelistList()); setWhitelistState("ready"); }
    catch (error) { setWhitelistState("failed"); setWhitelistError(String(error)); }
  };
  useEffect(() => { void loadWhitelist(); }, []);

  const scan = async () => {
    if (!engine || scanning) return;
    setError(null); setNotice(null); setPreview(null); setExpanded(new Set());
    try {
      setPreview(await runScan({ title: "垃圾扫描", tag: "clean-preview", detail: "只读检查缓存与临时文件" }, (id) => api.cleanPreview(id), (data) => `扫描完成 · ${data.paths.length} 项可查看`));
    } catch (error) {
      if (isScanCancelled(error)) setNotice("扫描已停止，未采用本次结果。重新扫描后才能执行清理。");
      else setError(String(error));
      setPreview(null);
    }
  };

  const addWhitelist = async (path: string) => {
    if (whitelistState !== "ready") return;
    setAdding(path);
    try {
      const next = await api.whitelistAdd(path);
      setWhitelist(next);
    } catch (e) {
      setWhitelistState("failed");
      setWhitelistError(String(e));
    } finally {
      setAdding(null);
    }
  };

  const removeWhitelist = async (pattern: string) => {
    if (whitelistState !== "ready") return;
    setAdding(pattern);
    try {
      const next = await api.whitelistRemove(pattern);
      setWhitelist(next);
    } catch (e) {
      setWhitelistState("failed");
      setWhitelistError(String(e));
    } finally { setAdding(null); }
  };

  const groups = useMemo(() => preview?.groups ?? [], [preview]);
  const totalBytes = useMemo(
    () => groups.reduce((acc, g) => acc + g.items.reduce((a, i) => a + (String(i.size).includes("counted under") ? 0 : (i.size_bytes ?? 0)), 0), 0),
    [groups],
  );
  const totalCount = useMemo(() => groups.reduce((acc, g) => acc + g.items.length, 0), [groups]);
  const whitelisted = useMemo(() => new Set(whitelist), [whitelist]);

  const openWizard = async () => {
    if (!engine || whitelistState !== "ready" || wizardRunning || scanning || !preview || preview.timed_out) return;
    // Re-read before the actual cleanup. A failed refresh must not allow the
    // last successful list to be mistaken for current protection rules.
    setWhitelistState("loading"); setConfirmOpen(false);
    try { setWhitelist(await api.whitelistList()); setWhitelistState("ready"); }
    catch (error) { setWhitelistState("failed"); setWhitelistError(String(error)); return; }
    openTask({
      title: "空间清理",
      note: "按当前保护名单执行清理",
      program: engine.path,
      args: ["clean"],
      tag: "clean",
      onExit: () => {
        // Refresh the preview so freed space disappears from the list.
        void scan();
      },
    });
  };

  return (
    <div>
      <ConfirmDialog open={confirmOpen} title="确认执行完整清理" danger confirmText="开始清理" onCancel={() => setConfirmOpen(false)} onConfirm={() => void openWizard()}><p>将按 Mole 当前规则清理缓存、临时文件及符合条件的其他项目，可能包含废纸篓内容。部分删除无法撤销。</p><p>扫描结果是预览，执行时引擎会重新检查；当前 {whitelist.length} 条保护规则继续生效。系统缓存是否包含，会在下一步单独询问。</p></ConfirmDialog>
      <PageHeader eyebrow="SPACE CLEANUP" title="空间清理" description="先扫描预览，再保护需要保留的路径；确认后按引擎规则执行完整清理。" />
      <EngineNotice />

      <Steps labels={["扫描空间", "查看与保护", "执行清理"]} active={wizardRunning ? 2 : preview ? 1 : 0} />

      {error && <div className="error-box">{error}</div>}
      {notice && <div className="scan-inline-state" role="status">{notice}</div>}
      {whitelistState !== "ready" && <div className={`protection-state ${whitelistState === "failed" ? "error-box" : "engine-notice"}`} role="status">
        <div><strong>{whitelistState === "loading" ? "正在读取保护名单" : "保护名单读取失败，清理已禁用"}</strong><p className="note">{whitelistError ?? "确认规则可读取后，才能保护路径和执行清理。"}</p></div>
        {whitelistState === "failed" && <button className="btn small" onClick={() => void loadWhitelist()}>重试读取</button>}
      </div>}

      <div className="action-bar">
        <button className="btn primary" onClick={() => void scan()} disabled={scanning || wizardRunning || !engine}>
          {scanning ? <span className="spin" /> : <IconSearch size={14} />} 扫描可清理项
        </button>
        {active && <button className="btn" disabled={active.status === "cancelling"} onClick={() => void cancelScan(active.id).catch((error) => setError(String(error)))}>{active.status === "cancelling" ? "正在停止…" : "停止扫描"}</button>}
        <button className="btn" onClick={() => setConfirmOpen(true)} disabled={!engine || !preview || preview.timed_out || whitelistState !== "ready" || wizardRunning || scanning || adding !== null}>
          确认清理
        </button>
        {preview && (
          <span className="note">
            {totalCount} 项 · 约 {fmtBytes(totalBytes, 1)}{preview.summary.length > 0 ? ` · ${preview.summary[preview.summary.length - 1]}` : ""}
          </span>
        )}
      </div>

      {(!preview || scanning) && <EmptyState icon={<IconSearch size={32} />} busy={scanning} title={scanning ? active?.status === "cancelling" ? "正在停止扫描" : "正在查找可释放空间" : "给你的 Mac 腾出一点空间"} description={scanning ? "正在检查缓存与临时文件，扫描期间不会删除任何内容。" : "点击「扫描可清理项」开始。扫描只做检查，实际清理需要单独确认。"} />}
      {preview && !scanning && <div className="summary-strip"><div><span>扫描发现</span><strong>{fmtBytes(totalBytes, 1)}</strong></div><div><span>待查看项目</span><strong>{totalCount}<small> 项</small></strong></div><div><span>已保护路径</span><strong>{whitelistState === "ready" ? whitelist.length : "—"}<small> 条</small></strong></div></div>}
      {preview?.timed_out && <div className="engine-notice">扫描已超时，当前仅显示部分结果。你可以重新扫描。</div>}

      {preview && groups.length > 0 && (
        <div className="clean-results">
          {groups.map((g, gi) => {
            const gBytes = g.items.reduce((a, i) => a + (String(i.size).includes("counted under") ? 0 : (i.size_bytes ?? 0)), 0);
            return (
              <div className="card" key={gi}>
                <h3>
                  {g.title}
                  <span style={{ float: "right", textTransform: "none", letterSpacing: 0, color: "var(--text-dim)" }}>
                    {g.items.length} 项 · {fmtBytes(gBytes, 1)}
                  </span>
                </h3>
                {g.items.length === 0 ? (
                  <div className="empty">空分组</div>
                ) : (
                  <table className="list">
                    <tbody>
                      {g.items.slice(0, expanded.has(gi) ? g.items.length : 60).map((it: CleanItem, ii: number) => {
                        const wl = whitelistState === "ready" && whitelisted.has(it.path);
                        return (
                          <tr key={ii}>
                            <td className="mono" title={it.path} style={{ maxWidth: 330, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {it.path}
                            </td>
                            <td className="num" style={{ width: 70, whiteSpace: "nowrap" }}>{it.size}</td>
                            <td style={{ width: 84 }}>
                              {wl ? (
                                <span className="badge green">已保护</span>
                              ) : (
                                <button className="btn small" onClick={() => addWhitelist(it.path)} disabled={adding !== null || wizardRunning || whitelistState !== "ready"}>
                                  保护路径
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {g.items.length > 60 && (
                        <tr>
                          <td colSpan={3} style={{ textAlign: "center", color: "var(--text-faint)" }}>
                            <button className="btn small" onClick={() => setExpanded(prev => { const next = new Set(prev); next.has(gi) ? next.delete(gi) : next.add(gi); return next; })}>{expanded.has(gi) ? "收起列表" : `展开其余 ${g.items.length - 60} 项`}</button>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {preview && groups.length === 0 && (
        <div className="card">
          <h3>扫描详情</h3>
          <pre className="raw">{preview.raw}</pre>
        </div>
      )}

      {whitelist.length > 0 && (
        <div className="card">
          <h3>{whitelistState === "ready" ? "保护名单" : "上次读取的保护名单（当前未确认）"} · {whitelist.length} 条</h3>
          <table className="list">
            <tbody>
              {whitelist.map((w) => (
                <tr key={w}>
                  <td className="mono">{w}</td>
                  <td style={{ width: 60, textAlign: "right" }}>
                    <button className="btn small danger" onClick={() => removeWhitelist(w)} disabled={wizardRunning || adding !== null || whitelistState !== "ready"}>
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {wizardRunning && (
        <div className="engine-notice">
          清理正在任务面板中运行，切换页面也不会中断。完成后将重新扫描。
        </div>
      )}
    </div>
  );
}
