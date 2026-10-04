import { PageHeader, EmptyState, EngineNotice } from "../components/Page";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../App";
import { IconPie, IconFolder, IconFile } from "../components/icons";
import { api, fmtBytes } from "../lib/api";
import { AnalyzeEntry, AnalyzeFile, AnalyzeResult, AnalyzeSort, analyzePage } from "../lib/analyze";
import { isScanCancelled, useScans } from "../lib/scanTasks";

function ResultTable({ title, items, totalSize, onError }: { title: string; items: (AnalyzeFile | AnalyzeEntry)[]; totalSize?: number; onError: (error: string) => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AnalyzeSort>("size-desc");
  const [page, setPage] = useState(1);
  const visible = useMemo(() => analyzePage(items, query, sort, page), [items, query, sort, page]);
  useEffect(() => setPage(1), [items]);
  return <div className="card">
    <h3>{title} <span className="section-count">{items.length} 个条目</span></h3>
    <div className="collection-toolbar">
      <input className="text" aria-label={`${title}搜索`} placeholder="搜索名称或路径" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
      <select className="select" aria-label={`${title}排序`} value={sort} onChange={(event) => { setSort(event.target.value as AnalyzeSort); setPage(1); }}>
        <option value="size-desc">大小从大到小</option><option value="size-asc">大小从小到大</option><option value="name">按名称</option>
      </select>
    </div>
    {visible.total === 0 ? <div className="empty">{items.length ? "没有匹配的条目，请调整搜索条件" : "本次扫描没有发现条目"}</div> : <div className="analysis-table-wrap"><table className="list">
      <thead><tr><th>名称</th><th>路径</th><th className="num">大小</th></tr></thead>
      <tbody>{visible.items.map((item) => {
        const entry = "is_dir" in item ? item : null;
        const partial = entry && entry.scan_status !== "complete";
        return <tr key={item.path}>
          <td><span className="cell-ico">{entry?.is_dir ? <IconFolder size={14} /> : <IconFile size={14} />}<span>{item.name}</span>{entry?.insight && <span className="badge blue">开发缓存</span>}{partial && <span className="badge yellow">{entry.scan_status === "unavailable" ? "不可读取" : "部分结果"}</span>}</span></td>
          <td className="mono"><button className="path-link" title={`在 Finder 中显示 ${item.path}`} onClick={() => void api.revealPath(item.path).catch((error) => onError(String(error)))}>{item.path}</button></td>
          <td className="num size-cell">{fmtBytes(item.size)}{partial && item.size !== null ? "+" : ""}{totalSize !== undefined && item.size !== null && <div className="bar"><div style={{ width: `${Math.max(1, Math.min(100, item.size / Math.max(totalSize, 1) * 100))}%` }} /></div>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
    <nav className="collection-pagination" aria-label={`${title}分页`}>
      <span className="note">{visible.first}–{visible.last} / {visible.total} 项{query.trim() ? `（共 ${items.length} 项）` : ""}</span>
      <div className="row"><button className="btn small" disabled={visible.page === 1} onClick={() => setPage(visible.page - 1)}>上一页</button><span className="note">{visible.page} / {visible.pageCount}</span><button className="btn small" disabled={visible.page === visible.pageCount} onClick={() => setPage(visible.page + 1)}>下一页</button></div>
    </nav>
    <p className="note">点击路径可在 Finder 中查看；这里只展示空间信息。</p>
  </div>;
}

export default function Analyze() {
  const { engine, engineError } = useApp();
  const { scans, runScan, cancelScan } = useScans();
  const [path, setPath] = useState("");
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = scans.find((scan) => scan.tag === "analyze" && (scan.status === "running" || scan.status === "cancelling"));
  const scanning = starting || !!active;
  useEffect(() => {
    let disposed = false;
    api.homeDir().then((home) => { if (!disposed) setPath((path) => path || home); }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!active) return;
    const tick = () => setElapsed(Math.floor((Date.now() - active.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [active?.id]);

  const scan = async () => {
    if (!engine || scanning) return;
    setStarting(true); setElapsed(0); setError(null); setNotice(null); setResult(null);
    try {
      const target = path.trim();
      const resolved = !target || target === "~" ? await api.homeDir() : target;
      setResult(await runScan({ title: "磁盘分析", tag: "analyze", detail: resolved }, (id) => api.analyzeRun(resolved, id), (data) => `${data.scan_status === "complete" ? "扫描完成" : "扫描返回部分结果"} · ${data.entries.length} 个条目 · ${fmtBytes(data.total_size)}`));
    } catch (error) {
      if (isScanCancelled(error)) setNotice("扫描已停止，未采用本次结果。可以重新选择目录分析。");
      else setError(String(error));
    } finally { setStarting(false); }
  };
  const partial = result?.scan_status !== "complete";
  return <div>
    <PageHeader eyebrow="STORAGE INSIGHTS" title="磁盘分析" description="查看空间排行与大文件。扫描可在后台继续，也可以随时停止。" />
    <EngineNotice />
    {(error || engineError) && <div className="error-box">{error ?? engineError}</div>}
    {notice && <div className="scan-inline-state" role="status">{notice}</div>}
    <div className="action-bar">
      <input aria-label="扫描目录" className="text" value={path} disabled={scanning} onChange={(event) => setPath(event.target.value)} placeholder="输入绝对目录路径，留空扫描主目录" onKeyDown={(event) => { if (event.key === "Enter" && !scanning) void scan(); }} />
      <button className="btn primary" onClick={() => void scan()} disabled={scanning || !engine}>{scanning ? <span className="spin" /> : <IconPie size={14} />} {scanning ? "正在分析" : "开始分析"}</button>
      {active && <button className="btn" disabled={active.status === "cancelling"} onClick={() => void cancelScan(active.id).catch((error) => setError(String(error)))}>{active.status === "cancelling" ? "正在停止…" : "停止扫描"}</button>}
      {scanning && <span className="note">已扫描 {elapsed} 秒 · 切换页面后继续</span>}
    </div>
    {!result && <EmptyState icon={<IconPie size={34} />} busy={scanning} title={scanning ? active?.status === "cancelling" ? "正在停止扫描" : "正在绘制空间分布" : "了解每一份空间的去向"} description={scanning ? "只读取文件信息；大目录可能需要几分钟，最长等待五分钟。可在任务面板查看或停止。" : "输入想检查的目录，或直接分析主目录。整个过程只读取文件信息。"} />}
    {result && <>
      <div className="grid cols-4">
        <div className="card"><div className="stat"><div className="label">已统计大小</div><div className="value">{fmtBytes(result.total_size)}{partial ? "+" : ""}</div><div className="hint">{result.total_files?.toLocaleString() ?? "—"} 个文件</div></div></div>
        <div className="card"><div className="stat"><div className="label">条目</div><div className="value">{result.entries.length}</div><div className="hint" title={result.path}>路径 {result.path}</div></div></div>
        <div className="card"><div className="stat"><div className="label">扫描状态</div><div className="value"><span className={`badge ${partial ? "yellow" : "green"}`}>{result.scan_status === "complete" ? "完成" : result.scan_status === "partial" ? "部分结果" : "不可读取"}</span></div>{partial && <div className="hint">部分目录不可读取，数值不是完整磁盘占用</div>}</div></div>
        <div className="card"><div className="stat"><div className="label">大文件</div><div className="value">{result.large_files.length}</div><div className="hint">全部结果支持搜索和分页</div></div></div>
      </div>
      <div className="analysis-results"><ResultTable title="空间占用排行" items={result.entries} totalSize={result.total_size} onError={setError} /><ResultTable title="大文件" items={result.large_files} onError={setError} /></div>
    </>}
  </div>;
}
