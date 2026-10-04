import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  PREVIEW_ANALYZE, PREVIEW_APPS, PREVIEW_CLEAN, PREVIEW_ENGINE, PREVIEW_HISTORY,
  PREVIEW_HOME, PREVIEW_SMC, PREVIEW_UPDATE, PREVIEW_WHITELIST, previewAppIcon, previewSnapshot,
} from "./previewFixtures";

export interface PreviewBridge { dispose(): void }
type Timer = ReturnType<typeof setTimeout>;
type PreviewListener = { event: string; callbackId: number; target: { kind: string; label?: string } };
type PreviewInternals = {
  callbacks: Map<number, (data: unknown) => void>;
  runCallback(id: number, data: unknown): void;
  unregisterCallback(id: number): void;
};
type Session = { kind: "clean" | "uninstall" | "optimize"; stage: "starting" | "first" | "final" | "unknown"; count: number };
let activeBridge: PreviewBridge | null = null;

export function shouldEnablePreview(development: boolean, search: string): boolean {
  return development && new URLSearchParams(search).get("preview") === "1";
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value || /[\u0000\n\r]/.test(value)) throw new Error("演示参数无效。");
  return value;
};
const encoded = (value: string): string => {
  let binary = "";
  new TextEncoder().encode(value).forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};
const rejected = (): never => { throw new Error("演示模式已拒绝此操作：不会安装、更新、修改权限、提交密码或调用本机引擎。"); };

/** Installs an entirely synthetic bridge before React mounts. No native fallback.
 * DEV + explicit URL opt-in are both required; production never enables it.
 * Event IDs and callback IDs are explicitly paired. The official event mock
 * currently reads args.id while event.unlisten sends args.eventId, so using it
 * would keep emitting to callbacks already removed by React cleanup.
 */
export function installPreviewBridge(): PreviewBridge | null {
  if (!shouldEnablePreview(import.meta.env.DEV, window.location.search)) return null;
  if (activeBridge) return activeBridge;
  const previewCase = new URLSearchParams(window.location.search).get("previewCase");
  const timers = new Set<Timer>();
  const watchTimers = new Set<Timer>();
  const scans = new Map<string, { timer: Timer; reject: (error: Error) => void }>();
  const sessions = new Map<string, Session>();
  const listeners = new Map<number, PreviewListener>();
  const internals = () => (window as unknown as { __TAURI_INTERNALS__: PreviewInternals }).__TAURI_INTERNALS__;
  const removeListener = (event: unknown, id: unknown) => {
    if (typeof event !== "string" || typeof id !== "number") return;
    const listener = listeners.get(id);
    if (listener?.event !== event) return;
    listeners.delete(id); internals().unregisterCallback(listener.callbackId);
  };
  const eventTarget = (value: unknown): PreviewListener["target"] => {
    if (!value || typeof value !== "object") return { kind: "Any" };
    const target = value as Record<string, unknown>;
    if (typeof target.kind !== "string" || (target.label !== undefined && typeof target.label !== "string")) throw new Error("演示事件目标无效");
    return { kind: target.kind, ...(typeof target.label === "string" ? { label: target.label } : {}) };
  };
  let whitelist = [...PREVIEW_WHITELIST];
  let disposed = false, historyReads = 0, watchIndex = 0, watchGeneration = 0, watching = false;

  const schedule = (run: () => void, delay: number, collection = timers): Timer => {
    const timer = setTimeout(() => {
      timers.delete(timer); collection.delete(timer);
      if (!disposed) run();
    }, delay);
    timers.add(timer); collection.add(timer);
    return timer;
  };
  const send = (name: string, payload: unknown) => { if (!disposed) void emit(name, payload).catch(() => {}); };
  const output = (id: string, data: string) => send("pty-data", { id, data: encoded(data) });
  const finish = (id: string, data: string, code = 0) => {
    if (!sessions.delete(id)) return;
    output(id, data); send("pty-exit", { id, code });
  };
  const sessionFor = (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error("演示会话已结束或不存在，没有发送任何输入。");
    return session;
  };
  const scan = <T,>(idValue: unknown, fixture: T): Promise<T> => {
    const id = idValue === undefined ? `preview-scan-${scans.size + 1}` : text(idValue);
    if (scans.has(id)) throw new Error("演示扫描标识已存在。");
    return new Promise((resolve, reject) => {
      const timer = schedule(() => { scans.delete(id); resolve(clone(fixture)); }, 1200);
      scans.set(id, { timer, reject });
    });
  };
  const stopWatch = () => {
    watching = false; watchGeneration++;
    watchTimers.forEach(timer => { clearTimeout(timer); timers.delete(timer); });
    watchTimers.clear();
  };
  const watchTick = (generation: number) => {
    if (disposed || !watching || generation !== watchGeneration) return;
    send("engine-status", previewSnapshot(watchIndex++));
    if (!disposed && watching && generation === watchGeneration) schedule(() => watchTick(generation), watchIndex < 8 ? 40 : 2000, watchTimers);
  };

  // Visible even if React fails to mount. Parent layout reserves this banner.
  document.documentElement.dataset.preview = "true";
  document.title = "CrownSweep · 固定数据演示";
  const banner = document.createElement("div");
  banner.id = "preview-mode-banner";
  banner.setAttribute("role", "status");
  banner.textContent = "演示模式 · 固定虚构数据 · 不读取本机文件，不执行维护或授权";
  document.body.prepend(banner);

  mockWindows("main");
  mockIPC((command, payload) => {
    const args = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    // React/HMR can finish asynchronous listener registration after disposal.
    // Cleaning those callbacks is always safe, even though all native actions
    // remain blocked. Event IDs are the paired mock callback IDs.
    if (command === "plugin:event|unlisten") { removeListener(args.event, args.eventId); return; }
    if (disposed) {
      if (command === "plugin:event|listen" && typeof args.handler === "number") internals().unregisterCallback(args.handler);
      throw new Error("演示模式已关闭；本机接口仍被禁用，请重新加载页面。");
    }
    switch (command) {
      case "plugin:event|listen": {
        const event = text(args.event), callbackId = args.handler;
        if (typeof callbackId !== "number" || !internals().callbacks.has(callbackId)) throw new Error("演示事件回调无效");
        listeners.set(callbackId, { event, callbackId, target: eventTarget(args.target) });
        return callbackId;
      }
      case "plugin:event|emit":
      case "plugin:event|emit_to": {
        const event = text(args.event);
        const target = command === "plugin:event|emit_to" ? eventTarget(args.target) : null;
        for (const [id, listener] of [...listeners]) {
          if (listener.event !== event || (target && target.kind !== "Any" && listener.target.kind !== "Any" && target.label !== listener.target.label)) continue;
          // unlisten/once may remove another handler during this emission.
          if (listeners.get(id) !== listener) continue;
          if (!internals().callbacks.has(listener.callbackId)) { listeners.delete(id); continue; }
          internals().runCallback(listener.callbackId, { event, id, payload: args.payload });
        }
        return;
      }
      case "engine_detect": return clone(PREVIEW_ENGINE);
      case "home_dir": return PREVIEW_HOME;
      case "status_snapshot": return previewSnapshot();
      case "status_start": {
        stopWatch(); watchIndex = 0; watching = true;
        const generation = watchGeneration;
        send("engine-watch-state", "connecting");
        if (!disposed && watching && generation === watchGeneration) schedule(() => watchTick(generation), 40, watchTimers);
        return;
      }
      case "status_stop": stopWatch(); send("engine-watch-state", "stopped"); return;
      case "smc_read": return clone(PREVIEW_SMC);
      case "uninstall_list": return { apps: clone(PREVIEW_APPS), raw: "固定演示应用列表，没有扫描本机。", json: true };
      case "app_icon": return previewAppIcon(text(args.path));
      case "clean_preview": return scan(args.taskId, PREVIEW_CLEAN);
      case "analyze_run":
        if (text(args.path) !== PREVIEW_HOME) throw new Error(`演示只提供 ${PREVIEW_HOME} 的固定分析结果，不读取输入路径。`);
        return scan(args.taskId, { result: PREVIEW_ANALYZE, raw_stderr: "演示数据，没有运行本机扫描。" });
      case "scan_cancel": {
        const id = text(args.id), pending = scans.get(id);
        if (!pending) throw new Error("演示扫描已结束或不存在。");
        clearTimeout(pending.timer); timers.delete(pending.timer); scans.delete(id);
        pending.reject(new Error("SCAN_CANCELLED: 演示扫描已停止，没有读取本机文件。")); return;
      }
      case "history_run":
        if (previewCase === "history-retry" && ++historyReads === 2) throw new Error("演示：本次历史刷新失败，可重试；保留上次固定数据。");
        return clone(PREVIEW_HISTORY);
      case "whitelist_list": return [...whitelist];
      case "whitelist_add": {
        const pattern = text(args.pattern);
        if (!pattern.startsWith("/Preview/")) return rejected();
        whitelist = [...new Set([...whitelist, pattern])]; return [...whitelist];
      }
      case "whitelist_remove": whitelist = whitelist.filter(pattern => pattern !== text(args.pattern)); return [...whitelist];
      case "touchid_status": return { enabled: false };
      case "app_update_check": return clone(PREVIEW_UPDATE);
      case "plugin:window|set_focus": return;
      case "pty_start": {
        const id = text(args.id);
        if (sessions.has(id)) throw new Error("演示会话标识已存在。");
        if (args.program !== PREVIEW_ENGINE.path || !Array.isArray(args.args) || !args.args.every(value => typeof value === "string")) return rejected();
        const requested = args.args as string[];
        const kind = requested[0];
        if (kind !== "clean" && kind !== "uninstall" && kind !== "optimize") return rejected();
        if (kind === "uninstall") {
          if (requested.length < 2 || requested.slice(1).some(name => !PREVIEW_APPS.some(app => app.uninstall_name === name))) return rejected();
        } else if (requested.length !== 1) return rejected();
        const session: Session = { kind, stage: "starting", count: requested.length - 1 };
        sessions.set(id, session);
        schedule(() => {
          if (sessions.get(id) !== session) return;
          output(id, "演示会话：所有以下输出均为固定模拟，没有运行引擎。\r\n");
          if (previewCase === "unknown-prompt") {
            session.stage = "unknown"; output(id, "Unsupported demonstration prompt: choose a token > "); return;
          }
          session.stage = "first";
          if (kind === "clean") output(id, "System caches need sudo. Enter continue, Space skip: ");
          else if (kind === "uninstall") output(id, `Matched ${session.count} app(s):\r\n${requested.slice(1).join("\r\n")}\r\nProceed with uninstallation? [y/N] `);
          else output(id, "演示优化范围已经核对。\r\nProceed with demonstration? [y/N] ");
        }, 80); return;
      }
      case "pty_write": {
        const id = text(args.id), session = sessionFor(id);
        let input: string;
        try { input = atob(text(args.data)); } catch { throw new Error("演示输入格式无效。"); }
        if (input === "\x03") { finish(id, "\r\nCancelled: 演示任务已停止，没有修改任何文件。\r\n", 130); return; }
        if (session.stage === "starting" || session.stage === "unknown") return rejected();
        if (session.kind === "clean") {
          if (input === " ") finish(id, "\r\nSystem-level cleanup skipped\r\n✓ 演示用户缓存处理结束（模拟）\r\nTracked cleanup: 384 MB\r\nItems cleaned: 42\r\n");
          else if (input === "\r") finish(id, "\r\nError: 演示模式拒绝管理员授权；没有提交密码或执行清理。\r\n", 1);
          else return rejected();
        } else if (session.kind === "uninstall") {
          if (input === "n\r" || input === "\x1b") finish(id, "\r\nCancelled: 演示卸载已取消，没有删除任何文件。\r\n");
          else if (session.stage === "first" && input === "y\r") {
            session.stage = "final";
            output(id, `\r\n演示关联文件：${PREVIEW_HOME}/Library/Application Support/演示应用\r\nReview only: 演示共享资料\r\nRemove ${session.count} apps, 12 MB  Enter confirm, ESC cancel: `);
          } else if (session.stage === "final" && input === "\r") finish(id, `\r\nRemoved ${session.count} apps, freed 12 MB\r\nSkipped: 演示共享资料保留\r\n✓ 模拟卸载流程结束；没有运行删除操作。\r\n`);
          else return rejected();
        } else {
          if (input === "n\r") finish(id, "\r\nCancelled: 演示优化已取消，没有修改系统设置。\r\n");
          else if (input === "y\r") finish(id, "\r\nApplied 4 optimizations\r\n2 skipped | 1 unavailable | 0 failed\r\n✓ 模拟优化流程结束；没有修改系统设置。\r\n");
          else return rejected();
        }
        return;
      }
      case "pty_resize": sessionFor(text(args.id)); return;
      case "pty_kill": finish(text(args.id), "\r\nCancelled: 演示任务已停止，没有修改任何文件。\r\n", 130); return;
      // Secret values are deliberately never accessed, stored, echoed or logged.
      case "pty_write_secret":
      case "app_update_install":
      case "app_update_restart":
      case "app_update_open_release":
      case "reveal_path": return rejected();
      default: return rejected();
    }
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = removeListener;

  activeBridge = { dispose() {
    if (disposed) return;
    disposed = true;
    stopWatch(); timers.forEach(clearTimeout); timers.clear();
    for (const listener of listeners.values()) internals().unregisterCallback(listener.callbackId);
    listeners.clear();
    scans.forEach(pending => pending.reject(new Error("SCAN_CANCELLED: 演示模式已关闭。"))); scans.clear(); sessions.clear();
    banner.textContent = "演示模式已关闭 · 本机接口仍被禁用 · 请重新加载页面";
    activeBridge = null;
    // Keep the rejecting IPC bridge installed. Never restore a native handler.
  } };
  return activeBridge;
}

/** The same teardown is used by tests, explicit disposal and Vite HMR. */
export function disposePreviewBridge(): void { activeBridge?.dispose(); }
if (import.meta.hot) import.meta.hot.dispose(disposePreviewBridge);
