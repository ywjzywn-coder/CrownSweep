import { PageHeader, EmptyState, EngineNotice } from "../components/Page";
import { useMemo, useState } from "react";
import { useApp } from "../App";
import ConfirmDialog from "../components/ConfirmDialog";
import { IconBox, IconPlay, IconSearch, IconTrash } from "../components/icons";
import { api, AppEntry, UninstallList, fmtBytes } from "../lib/api";

type SortKey = "size" | "name";

function sizeBytes(entry: AppEntry): number {
  return entry.size_hint_mb * 1024 * 1024;
}

export default function Uninstall() {
  const { engine, openTask, isTagRunning, navigate } = useApp();
  const running = isTagRunning("uninstall");
  const [list, setList] = useState<UninstallList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("size");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [permanent, setPermanent] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const l = await api.uninstallList();
      setList(l);
      // Fetch icons lazily; failures just leave the fallback icon.
      if (l.json) {
        l.apps.forEach((a) => {
          if (!a.path) return;
          api
            .appIcon(a.path)
            .then((data) => setIcons((prev) => ({ ...prev, [a.path]: data })))
            .catch(() => {});
        });
      }
    } catch (e) {
      setError(String(e));
      setList(null);
    } finally {
      setLoading(false);
    }
  };

  const sorted: AppEntry[] = useMemo(() => {
    if (!list?.json) return [];
    const arr = [...list.apps];
    arr.sort((a, b) =>
      sortKey === "size"
        ? b.size_hint_mb - a.size_hint_mb || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name),
    );
    return arr;
  }, [list, sortKey]);

  const visibleApps = sorted.filter((a) => `${a.name} ${a.bundle_id}`.toLowerCase().includes(query.trim().toLowerCase()));

  const selectedApps = useMemo(
    () => sorted.filter((a) => selected.has(a.path)),
    [sorted, selected],
  );

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const startUninstall = () => {
    if (!engine) return;
    const names = selectedApps.map((a) => a.uninstall_name);
    if (names.length === 0) return;
    setConfirmOpen(false);
    openTask({
      title: permanent ? "彻底删除" : `卸载 · ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 等 ${names.length} 个` : ""}`,
      note: "核对应用 → 扫描关联文件 → 确认卸载",
      program: engine.path,
      args: permanent ? ["uninstall", "--permanent", ...names] : ["uninstall", ...names],
      tag: "uninstall",
      mode: "panel",
      onExit: () => {
        // Refresh list + sizes after removal.
        void load();
      },
    });
  };

  const totalSize = selectedApps.reduce((acc, a) => acc + sizeBytes(a), 0);

  return (
    <div>
      <PageHeader eyebrow="APPLICATIONS" title="应用卸载" description="找出不再需要的应用，同时处理关联的配置与缓存。" />
      <EngineNotice />

      {error && <div className="error-box">{error}</div>}

      <div className="action-bar">
        <button className="btn primary" onClick={load} disabled={loading || running || !engine}>
          {loading ? <span className="spin" /> : <IconSearch size={14} />} 获取应用列表
        </button>
        <button
          className="btn danger"
          onClick={() => setConfirmOpen(true)}
          disabled={selectedApps.length === 0 || running}
        >
          <IconTrash size={14} /> 卸载所选{selectedApps.length > 0 ? ` (${selectedApps.length})` : ""}
        </button>
        {list?.json && sorted.length > 0 && (
          <div className="seg">
            <button className={sortKey === "size" ? "on" : ""} onClick={() => setSortKey("size")}>
              按大小
            </button>
            <button className={sortKey === "name" ? "on" : ""} onClick={() => setSortKey("name")}>
              按名称
            </button>
          </div>
        )}
        {selectedApps.length > 0 && (
          <span className="note">已选 {selectedApps.length} 个,约 {fmtBytes(totalSize, 1)}</span>
        )}
      </div>

      {(!list || loading) && <EmptyState icon={<IconBox size={32} />} busy={loading} title={loading ? "正在整理应用列表" : "只留下你需要的应用"} description={loading ? "正在读取应用名称、大小与图标，请稍候。" : "获取应用列表后，按大小排序或搜索名称，选择要卸载的应用。"} />}
      {list?.json && <div className="collection-toolbar"><div><strong>{sorted.length}</strong> 个应用 <span className="note">· 已选 {selectedApps.length} 个</span></div><input className="text app-search" aria-label="搜索应用" placeholder="搜索应用名称…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>}
      {list?.json && visibleApps.length === 0 && <EmptyState icon={<IconSearch size={28} />} title={query ? "没有匹配的应用" : "暂无可卸载应用"} description={query ? "试试其他名称，或清空搜索条件。" : "你可以重新获取列表。"} />}

      {list?.json && (
        <div className="app-grid" style={{ marginBottom: 14 }}>
          {visibleApps.map((a) => {
            const on = selected.has(a.path);
            return (
              <button type="button" disabled={running} aria-pressed={on} key={a.path || a.name} className={`app-card ${on ? "selected" : ""}`} onClick={() => toggle(a.path)}>
                {icons[a.path] ? (
                  <img src={icons[a.path]} alt="" />
                ) : (
                  <div className="icon-fallback">
                    <IconBox size={20} />
                  </div>
                )}
                <div className="meta">
                  <div className="n" title={a.path}>{a.name}</div>
                  <div className="s">
                    {a.size || "—"}
                    {a.source === "Homebrew" && <span className="badge blue">Homebrew</span>}
                  </div>
                </div>
                <span className="tick">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12.5 9.5 18 20 6.5" />
                  </svg>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {list && !list.json && (
        <div className="card">
          <h3>当前引擎未提供可用的应用数据</h3><p className="note">更新引擎后重新获取列表，即可在界面中选择应用。无法识别的数据不会用于卸载。</p><button className="btn" onClick={() => navigate("settings")}>前往更新引擎</button>
          <pre className="raw" style={{ maxHeight: 260 }}>{list.raw}</pre>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={permanent ? "彻底删除所选应用?" : "卸载所选应用?"}
        danger
        confirmText="查看卸载范围"
        onConfirm={startUninstall}
        onCancel={() => setConfirmOpen(false)}
      >
        {permanent ? (
          <>
            将对 <b>{selectedApps.length}</b> 个应用执行 <code>--permanent</code> 直接删除,
            <b style={{ color: "var(--red)" }}>不经过废纸篓,无法撤销</b>。
          </>
        ) : (
          <>默认采用废纸篓模式；关联文件及 Homebrew 应用由引擎按各自规则处理，请核对下一步的实际范围。</>
        )}
        <div className="modal-list">
          {selectedApps.map((a) => (
            <div key={a.path || a.name}>
              <span>{a.name}</span>
              <span className="sz">{a.size}</span>
            </div>
          ))}
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          继续后将扫描并展示实际关联文件，最终卸载前还会请你确认范围。
        </p>
      </ConfirmDialog>
    </div>
  );
}
