import { PageHeader, EmptyState, EngineNotice } from "../components/Page";
import { useState } from "react";
import { useApp } from "../App";
import { IconClock } from "../components/icons";
import { api } from "../lib/api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HistoryData = any;

export default function History() {
  const { engine } = useApp();
  const [data, setData] = useState<HistoryData>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.historyRun());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const sessions: any[] = Array.isArray(data?.sessions) ? data.sessions : [];
  const deletions: any[] = Array.isArray(data?.deletions) ? data.deletions : [];

  const fmtRow = (row: any, i: number) => {
    // history --json 行字段随引擎版本演进,尽量通用渲染
    const when = row.started_at ?? row.time ?? row.timestamp ?? row.date ?? "—";
    const action = row.action ?? row.command ?? row.event;
    const labels: Record<string, string> = { clean: "空间清理", uninstall: "应用卸载", optimize: "系统优化", analyze: "磁盘分析", purge: "缓存清理" };
    const what = action ? labels[String(action)] ?? String(action) : JSON.stringify(row);
    const size = row.size ?? row.bytes ?? row.freed ?? null;
    return (
      <tr key={i}>
        <td className="mono">{String(when)}</td>
        <td>{String(what)}</td>
        <td className="num">{size != null ? `${size}` : "—"}</td>
      </tr>
    );
  };

  return (
    <div>
      <PageHeader eyebrow="ACTIVITY" title="操作历史" description="回顾每一次维护，查看操作记录与删除明细。" />
      <EngineNotice />

      {error && <div className="error-box">{error}</div>}

      <div className="action-bar">
        <button className="btn primary" onClick={load} disabled={loading || !engine}>
          {loading ? <span className="spin" /> : <IconClock size={14} />} 加载历史
        </button>
        {data && (
          <span className="note">
            日志位置:{data.logs?.operations ?? "—"}
          </span>
        )}
      </div>

      {!data && <EmptyState icon={<IconClock size={32} />} busy={loading} title={loading ? "正在读取维护记录" : "每次维护，都有迹可循"} description="点击「加载历史」查看之前的操作。首次使用时，记录会在完成维护后出现。" />}
      {data && <div className="summary-strip"><div><span>操作记录</span><strong>{sessions.length}<small> 次</small></strong></div><div><span>删除明细</span><strong>{deletions.length}<small> 条</small></strong></div></div>}
      {data && (
        <>
          <div className="card">
            <h3>清理/操作记录</h3>
            {sessions.length === 0 ? (
              <div className="empty">暂无记录</div>
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作</th>
                    <th className="num">大小/数量</th>
                  </tr>
                </thead>
                <tbody>{sessions.map(fmtRow)}</tbody>
              </table>
            )}
          </div>

          {deletions.length > 0 && (
            <div className="card">
              <h3>删除明细</h3>
              <table className="list">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>路径/操作</th>
                    <th className="num">大小/数量</th>
                  </tr>
                </thead>
                <tbody>{deletions.map(fmtRow)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
