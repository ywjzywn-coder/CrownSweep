import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, EngineInfo, onEvent } from "./lib/api";
import { MoleLogo, IconGauge, IconSparkles, IconBox, IconPie, IconBolt, IconClock, IconSliders, IconTerminal } from "./components/icons";
import ConfirmDialog from "./components/ConfirmDialog";
import TaskProgress from "./components/TaskProgress";
import { isPasswordPrompt } from "./lib/terminalPrompt";
import Dashboard from "./views/Dashboard";
import Clean from "./views/Clean";
import Uninstall from "./views/Uninstall";
import Analyze from "./views/Analyze";
import Optimize from "./views/Optimize";
import History from "./views/History";
import Settings from "./views/Settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = any;

export interface TaskSpec {
  id: string;
  /** drawer title, e.g. "空间清理" */
  title: string;
  /** optional hint line in the drawer header */
  note?: string;
  program: string;
  args: string[];
  /** called once when the spawned process exits */
  onExit?: (code: number) => void;
  /** optional tag so views can tell their own task apart */
  tag?: string;
  /**
   * "panel" (default): drawer opens expanded — for wizards that need
   * interactive selection.
   * "background": drawer starts as a slim status bar — one-click tasks;
   * expands on any supported prompt. Results remain until dismissed.
   */
  mode?: "panel" | "background";
}

interface AppState {
  engine: EngineInfo | null;
  navigate: (view: string) => void;
  engineChecked: boolean;
  refreshEngine: () => Promise<void>;
  snapshot: Snapshot | undefined;
  watchState: "idle" | "connecting" | "live" | "reconnecting" | "stopped";
  engineError: string | null;
  clearEngineError: () => void;
  cpuHistory: number[];
  memHistory: number[];
  /** start a graphical task in the always-visible bottom drawer */
  openTask: (spec: Omit<TaskSpec, "id">) => void;
  /** all live tasks; each keeps its own pty session */
  tasks: TaskSpec[];
  activeTaskId: string | null;
  setActiveTask: (id: string) => void;
  /** per-task status: "running" or the exit code */
  taskStatus: Record<string, "running" | number>;
  taskOpen: boolean;
  toggleTaskOpen: () => void;
  interruptTask: (taskId: string) => void;
  /** kill (if running) and remove a task */
  removeTask: (taskId: string) => void;
  /** true while any task process is alive */
  taskRunning: boolean;
  /** any running task waits for an admin auth prompt */
  anyNeedsPw: boolean;
  /** whether a task with this tag is currently running */
  isTagRunning: (tag: string) => boolean;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

const VIEWS: { key: string; icon: () => JSX.Element; label: string; el: () => JSX.Element }[] = [
  { key: "dashboard", icon: () => <IconGauge size={16} />, label: "仪表盘", el: () => <Dashboard /> },
  { key: "clean", icon: () => <IconSparkles size={16} />, label: "空间清理", el: () => <Clean /> },
  { key: "uninstall", icon: () => <IconBox size={16} />, label: "应用卸载", el: () => <Uninstall /> },
  { key: "analyze", icon: () => <IconPie size={16} />, label: "磁盘分析", el: () => <Analyze /> },
  { key: "optimize", icon: () => <IconBolt size={16} />, label: "系统优化", el: () => <Optimize /> },
  { key: "history", icon: () => <IconClock size={16} />, label: "历史", el: () => <History /> },
  { key: "settings", icon: () => <IconSliders size={16} />, label: "设置", el: () => <Settings /> },
];

const MAX_POINTS = 120;

export default function App() {
  const [view, setView] = useState("dashboard");
  const [visitedViews, setVisitedViews] = useState(() => new Set(["dashboard"]));
  const navigate = useCallback((key: string) => {
    if (!VIEWS.some((item) => item.key === key)) return;
    setVisitedViews((visited) => visited.has(key) ? visited : new Set([...visited, key]));
    setView(key);
  }, []);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineChecked, setEngineChecked] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [watchState, setWatchState] = useState<AppState["watchState"]>("idle");
  const [engineError, setEngineError] = useState<string | null>(null);
  const [cpuHistory, setCpu] = useState<number[]>([]);
  const [memHistory, setMem] = useState<number[]>([]);
  const pointsRef = useRef({ cpu: [] as number[], mem: [] as number[] });

  const refreshEngine = useCallback(async () => {
    try {
      const info = await api.engineDetect();
      setEngine(info);
    } catch {
      setEngine(null);
    } finally {
      setEngineChecked(true);
    }
  }, []);

  useEffect(() => {
    void refreshEngine();
  }, [refreshEngine]);

  // Subscribe once; start the watch stream whenever an engine is present.
  useEffect(() => {
    const unlisteners: Promise<unknown>[] = [
      onEvent<Snapshot>("engine-status", (snap) => {
        setWatchState("live");
        setSnapshot(snap);
        const cpu = pointsRef.current.cpu;
        const mem = pointsRef.current.mem;
        cpu.push(Number(snap?.cpu?.usage ?? 0));
        mem.push(Number(snap?.memory?.used_percent ?? 0));
        if (cpu.length > MAX_POINTS) cpu.shift();
        if (mem.length > MAX_POINTS) mem.shift();
        setCpu([...cpu]);
        setMem([...mem]);
      }),
      onEvent<string>("engine-watch-state", (s) => {
        if (s === "connecting") setWatchState("connecting");
        else if (s === "reconnecting") setWatchState("reconnecting");
        else if (s === "stopped") setWatchState((prev) => (prev === "live" ? "stopped" : prev === "idle" ? "idle" : "stopped"));
      }),
      onEvent<string>("engine-error", (msg) => setEngineError(String(msg))),
    ];
    return () => {
      unlisteners.forEach((p) => void p.then((u) => (u as () => void)()));
      void api.statusStop();
    };
  }, []);

  useEffect(() => {
    if (!engine) return;
    void api.statusStart().catch((e) => setEngineError(String(e)));
  }, [engine]);

  // ---------- task drawer (persistent graphical task runner) ----------
  // Every task keeps its own pty session; launching another one never
  // replaces a running task. All sessions stay mounted so output keeps
  // streaming while the user looks at a different tab (or page).
  const [tasks, setTasks] = useState<TaskSpec[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskStatus, setTaskStatus] = useState<Record<string, "running" | number>>({});
  const [taskOpen, setTaskOpen] = useState(true);
  const [needsPwIds, setNeedsPwIds] = useState<Set<string>>(new Set());
  const [closeAskId, setCloseAskId] = useState<string | null>(null);
  const sessionsRef = useRef<Record<string, string>>({});
  const tasksRef = useRef<TaskSpec[]>([]);
  tasksRef.current = tasks;
  const needsPwRef = useRef<Set<string>>(new Set());

  const openTask = useCallback((spec: Omit<TaskSpec, "id">) => {
    // Reuse a running task of the same kind; independent tasks keep their sessions.
    const existing = tasksRef.current.find((t) => t.tag != null && t.tag === spec.tag);
    if (existing && (taskStatus[existing.id] === "running" || taskStatus[existing.id] === undefined)) {
      setActiveTaskId(existing.id);
      setTaskOpen(true);
      return;
    }
    const id = crypto.randomUUID();
    const next = [
      ...tasksRef.current.filter((t) => !(t.tag != null && t.tag === spec.tag && taskStatus[t.id] !== "running")),
      { ...spec, id },
    ];
    setTasks(next);
    tasksRef.current = next;
    setTaskStatus((prev) => ({ ...prev, [id]: "running" }));
    setActiveTaskId(id);
    setTaskOpen(spec.mode !== "background");
    void getCurrentWindow().setFocus().catch(() => {});
  }, [taskStatus]);

  const removeTask = useCallback((id: string) => {
    needsPwRef.current.delete(id);
    setNeedsPwIds(new Set(needsPwRef.current));
    // Unmounting its TaskProgress kills the session's pty.
    const next = tasksRef.current.filter((t) => t.id !== id);
    setTasks(next);
    tasksRef.current = next;
    setTaskStatus((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    setActiveTaskId((current) => {
      if (current !== id) return current;
      return next.length > 0 ? next[next.length - 1].id : null;
    });
  }, []);

  const clearTaskPrompt = useCallback((taskId: string) => {
    if (!needsPwRef.current.delete(taskId)) return;
    setNeedsPwIds(new Set(needsPwRef.current));
  }, []);

  const handleTaskExit = useCallback((taskId: string, code: number) => {
    clearTaskPrompt(taskId);
    setTaskStatus((prev) => ({ ...prev, [taskId]: code }));
    const spec = tasksRef.current.find((t) => t.id === taskId);
    spec?.onExit?.(code);

  }, [removeTask, clearTaskPrompt]);

  // Sudo authorization surfaces as a password prompt or the Touch ID flow —
  // pop the drawer open and switch to that task so the user can act on it.
  const handleTaskOutput = useCallback((taskId: string, tail: string) => {
    if (!isPasswordPrompt(tail)) return;
    if (needsPwRef.current.has(taskId)) return;
    needsPwRef.current.add(taskId);
    setNeedsPwIds(new Set(needsPwRef.current));
    setActiveTaskId(taskId);
    setTaskOpen(true);
  }, []);

  const interruptTask = useCallback((taskId: string) => {
    // Gentle stop: Ctrl+C lets wizards clean up their alternate screen.
    const ptyId = sessionsRef.current[taskId];
    if (!ptyId) return;
    const bytes = new TextEncoder().encode("\u0003");
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    void api.ptyWrite(ptyId, btoa(bin));
  }, []);

  const taskRunning = tasks.some((t) => taskStatus[t.id] === "running" || taskStatus[t.id] === undefined);
  const runningCount = tasks.filter((t) => taskStatus[t.id] === "running" || taskStatus[t.id] === undefined).length;
  const anyNeedsPw = tasks.some((t) => taskStatus[t.id] === "running" && needsPwIds.has(t.id));
  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? tasks[tasks.length - 1] ?? null;
  const isTagRunning = useCallback(
    (tag: string) => tasks.some((t) => t.tag === tag && (taskStatus[t.id] === "running" || taskStatus[t.id] === undefined)),
    [tasks, taskStatus],
  );

  const state: AppState = {
    navigate,
    engine,
    engineChecked,
    refreshEngine,
    snapshot,
    watchState,
    engineError,
    clearEngineError: () => setEngineError(null),
    cpuHistory,
    memHistory,
    openTask,
    tasks,
    activeTaskId,
    setActiveTask: setActiveTaskId,
    taskStatus,
    taskOpen,
    toggleTaskOpen: () => setTaskOpen((o) => !o),
    interruptTask,
    removeTask,
    taskRunning,
    anyNeedsPw,
    isTagRunning,
  };

  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const renderNav = (v: (typeof VIEWS)[number]) => (
    <button
      key={v.key}
      type="button"
      className={`nav-item ${view === v.key ? "active" : ""}`}
      aria-current={view === v.key ? "page" : undefined}
      onClick={() => navigate(v.key)}
    >
      {v.icon()}
      <span>{v.label}</span>
    </button>
  );
  const active = VIEWS.find((v) => v.key === view) ?? VIEWS[0];

  return (
    <Ctx.Provider value={state}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark"><MoleLogo size={46} /></div>
            <div>
              <div className="name">Crown<span>Sweep</span></div>
              <div className="sub">让 Mac 轻装运行</div>
            </div>
          </div>
          <nav className="primary-nav" aria-label="主导航">
            <div className="nav-group-label">概览</div>
            {VIEWS.slice(0, 1).map(renderNav)}
            <div className="nav-group-label">维护工具</div>
            {VIEWS.slice(1, 5).map(renderNav)}
          </nav>
          <div className="spacer" />
          <nav className="secondary-nav" aria-label="应用导航">
            {VIEWS.slice(5).map(renderNav)}
          </nav>
          <button className="engine-badge" type="button" onClick={() => navigate("settings")} aria-label="查看引擎设置">
            <span className={`dot ${engine ? "ok" : engineChecked ? "bad" : ""}`} />
            <span className="engine-info">
              <strong>{engine ? "Mole 引擎已连接" : engineChecked ? "需要安装引擎" : "正在检测引擎"}</strong>
              <span>{engine ? `版本 ${engine.version}` : engineChecked ? "前往设置完成安装" : "请稍候…"}</span>
            </span>
            <span className="engine-arrow" aria-hidden="true">›</span>
          </button>
          <div className="sidebar-caption">tw93/Mole 非官方伴生应用</div>
        </aside>
        <div className="workspace">
          <header className="workspace-header">
            <div className="breadcrumb"><span>我的 Mac</span><span aria-hidden="true">/</span><strong>{active.label}</strong></div>
            <div className="row" style={{ gap: 10 }}>
              {taskRunning && (
                <button type="button" className={`task-pill ${anyNeedsPw ? "warn" : ""}`} onClick={() => { if (anyNeedsPw) { const t = tasks.find((x) => taskStatus[x.id] === "running" && needsPwIds.has(x.id)); if (t) setActiveTaskId(t.id); } setTaskOpen(true); }}>
                  {anyNeedsPw ? (
                    <>需要管理员授权 · 点此展开</>
                  ) : (
                    <>
                      <span className="spin" style={{ width: 11, height: 11 }} />
                      {runningCount} 个任务运行中{taskOpen ? "" : " · 点此展开"}
                    </>
                  )}
                </button>
              )}
              <span className="workspace-caption">Mac 维护助手</span>
            </div>
          </header>
          <main className="main" ref={mainRef} id="main-content">
            <div className="page-content">
              {/* Keep visited pages mounted so pending jobs and PTYs survive navigation.
                  Unvisited pages stay unmounted to avoid eager API calls. */}
              {VIEWS.filter((item) => visitedViews.has(item.key)).map((item) => (
                <div key={item.key} hidden={view !== item.key} data-view={item.key}>
                  {item.el()}
                </div>
              ))}
            </div>
          </main>
          {tasks.length > 0 && activeTask && (
            <section className={`task-drawer ${taskOpen ? "" : "collapsed"}`} aria-label="运行中的任务">
              <header className="task-drawer-head">
                <button
                  type="button"
                  className="drawer-toggle"
                  onClick={() => setTaskOpen((o) => !o)}
                  aria-expanded={taskOpen}
                  aria-label={taskOpen ? "收起任务面板" : "展开任务面板"}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: taskOpen ? "none" : "rotate(180deg)" }}>
                    <path d="M5 15l7-7 7 7" />
                  </svg>
                </button>
                <div className="task-tabs" role="tablist" aria-label="任务列表">
                  {tasks.map((t) => {
                    const st = taskStatus[t.id] ?? "running";
                    const isActive = t.id === activeTask.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        className={`task-tab ${isActive ? "on" : ""} ${needsPwIds.has(t.id) && st === "running" ? "pw" : ""}`}
                        onClick={() => setActiveTaskId(t.id)}
                      >
                        {t.title}
                        {st === "running" ? (
                          needsPwIds.has(t.id) ? (
                            <span className="dot pw" />
                          ) : (
                            <span className="dot run" />
                          )
                        ) : st === 0 ? (
                          <span className="dot ok" />
                        ) : (
                          <span className="dot err" />
                        )}
                      </button>
                    );
                  })}
                </div>
                {activeTask.note && taskOpen && <span className="drawer-note">{activeTask.note}</span>}
                <div className="grow" />
                {(taskStatus[activeTask.id] ?? "running") === "running" && (
                  <button type="button" className="btn small" onClick={() => interruptTask(activeTask.id)}>
                    停止任务
                  </button>
                )}
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => ((taskStatus[activeTask.id] ?? "running") === "running" ? setCloseAskId(activeTask.id) : removeTask(activeTask.id))}
                >
                  关闭
                </button>
              </header>
              <div className="task-drawer-body" hidden={!taskOpen}>
                  {tasks.map((t) => (
                    <div key={t.id} className="task-pane" hidden={t.id !== activeTask.id}>
                      <TaskProgress
                        key={t.id}
                        program={t.program}
                        args={t.args}
                        runToken={1}
                        registerSession={(id) => {
                          if (id) sessionsRef.current[t.id] = id;
                          else delete sessionsRef.current[t.id];
                        }}
                        onAttention={() => { setActiveTaskId(t.id); setTaskOpen(true); }}
                        onOutput={(tail) => handleTaskOutput(t.id, tail)}
                        onInputSubmit={() => clearTaskPrompt(t.id)}
                        onExit={(code) => handleTaskExit(t.id, code)}
                      />
                    </div>
                  ))}
                </div>
            </section>
          )}
        </div>
        <ConfirmDialog
          open={closeAskId != null}
          title="任务仍在运行"
          danger
          confirmText="结束并关闭"
          onConfirm={() => { if (closeAskId) removeTask(closeAskId); setCloseAskId(null); }}
          onCancel={() => setCloseAskId(null)}
        >
          结束后无法撤销已经完成的步骤。建议先点击「停止任务」，等待引擎退出。
        </ConfirmDialog>
      </div>
    </Ctx.Provider>
  );
}
