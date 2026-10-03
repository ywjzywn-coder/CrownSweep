import { PageHeader, EmptyState, EngineNotice } from "../components/Page";
import { useEffect, useState } from "react";
import { useApp } from "../App";
import { IconPie, IconFolder, IconFile } from "../components/icons";
import { api, fmtBytes } from "../lib/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnalyzeResult = any;

export default function Analyze() {
  const { engine, engineError } = useApp();
  const [path, setPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<AnalyzeResult>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.homeDir().then((h) => { if (!cancelled) setPath((p) => p || h); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const scan = async () => {
    if (!engine || scanning) return;
    setElapsed(0);
    setScanning(true);
    setError(null);
    setResult(null);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    try {
      const target = path.trim();
      const resolved = !target || target === "~" ? await api.homeDir() : target;
      const r = await api.analyzeRun(resolved);
      setResult(r?.result ?? r);
    } catch (e) {
      setError(String(e));
    } finally {
      clearInterval(t);
      setScanning(false);
    }
  };

  const entries: any[] = Array.isArray(result?.entries) ? result.entries : [];
  const largeFiles: any[] = Array.isArray(result?.large_files) ? result.large_files : [];
  const partial = result?.scan_status && result.scan_status !== "complete";

  return (
    <div>
      <PageHeader eyebrow="STORAGE INSIGHTS" title="磁盘分析" description="看看空间用在了哪里，快速定位占用较大的目录与文件。" />
      <EngineNotice />

      {(error || engineError) && <div className="error-box">{error ?? engineError}</div>}

      <div className="action-bar">
        <input
          aria-label="扫描目录"
          className="text"
          style={{ maxWidth: 420 }}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="输入目录路径，留空扫描主目录"
          onKeyDown={(e) => e.key === "Enter" && !scanning && scan()}
        />
        <button className="btn primary" onClick={scan} disabled={scanning || !engine}>
          {scanning ? <span className="spin" /> : <IconPie size={14} />} 开始分析
        </button>
        {scanning && <span className="note">已扫描 {elapsed}s…(大目录较慢,属正常)</span>}
      </div>

      {!result && <EmptyState icon={<IconPie size={34} />} busy={scanning} title={scanning ? "正在绘制空间分布" : "了解每一份空间的去向"} description={scanning ? `已扫描 ${elapsed} 秒，大目录可能需要几分钟。完成后将展示空间排行与大文件。` : "输入想检查的目录，或直接分析主目录。整个过程只读取文件信息。"} />}

      {result && (
        <>
          <div className="grid cols-4">
            <div className="card">
              <div className="stat">
                <div className="label">总大小</div>
                <div className="value">{fmtBytes(result.total_size)}</div>
                <div className="hint">{result.total_files?.toLocaleString() ?? "—"} 个文件</div>
              </div>
            </div>
            <div className="card">
              <div className="stat">
                <div className="label">条目</div>
                <div className="value">{entries.length}</div>
                <div className="hint">路径 {result.path}</div>
              </div>
            </div>
            <div className="card">
              <div className="stat">
                <div className="label">扫描状态</div>
                <div className="value">
                  <span className={`badge ${partial ? "yellow" : "green"}`}>
                    {result.scan_status === "complete" ? "完成" : result.scan_status}
                  </span>
                </div>
                {partial && <div className="hint">部分目录无权限或扫描超时,数值偏低</div>}
              </div>
            </div>
            <div className="card">
              <div className="stat">
                <div className="label">大文件</div>
                <div className="value">{largeFiles.length}</div>
                <div className="hint">见下方列表</div>
              </div>
            </div>
          </div>

          <div className="analysis-results">
            <div className="card">
              <h3>空间占用排行 <span className="section-count">{entries.length} 个条目</span></h3>
              <table className="list">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>路径</th>
                    <th className="num">大小</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.slice(0, 40).map((e, i) => (
                    <tr key={i}>
                      <td>
                        <span className="cell-ico">
                          {e.is_dir ? <IconFolder size={14} /> : <IconFile size={14} />}
                          <span>{e.name}</span>
                          {e.cleanable && <span className="badge green">可清理</span>}
                          {e.insight && <span className="badge blue">开发缓存</span>}
                        </span>
                      </td>
                      <td className="mono">
                        <button className="path-link" onClick={() => void api.revealPath(e.path).catch((e) => setError(String(e)))}>
                          {e.path}
                        </button>
                      </td>
                      <td className="num size-cell">{fmtBytes(e.size)}<div className="bar"><div style={{ width: `${Math.max(1, Math.min(100, (e.size / Math.max(result.total_size || 1, 1)) * 100))}%` }} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>大文件</h3>
              {largeFiles.length === 0 ? (
                <div className="empty">没有超过阈值的大文件</div>
              ) : (
                <table className="list">
                  <thead>
                    <tr>
                      <th>文件</th>
                      <th>路径</th>
                      <th className="num">大小</th>
                    </tr>
                  </thead>
                  <tbody>
                    {largeFiles.map((f, i) => (
                      <tr key={i}>
                        <td>
                          <span className="cell-ico">
                            <IconFile size={14} />
                            <span>{f.name}</span>
                          </span>
                        </td>
                        <td className="mono">
                          <button className="path-link" onClick={() => void api.revealPath(f.path).catch((e) => setError(String(e)))}>
                            {f.path}
                          </button>
                        </td>
                        <td className="num">{fmtBytes(f.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="note">点击路径可在 Finder 中查看文件，再决定如何处理。</p>
            </div>
          </div>
        </>
      )}


    </div>
  );
}
