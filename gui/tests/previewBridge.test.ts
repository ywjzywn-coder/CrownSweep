// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, once } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { disposePreviewBridge, installPreviewBridge, shouldEnablePreview, type PreviewBridge } from "../src/dev/previewBridge";
import { PREVIEW_APPS, PREVIEW_ENGINE, PREVIEW_HOME, PREVIEW_WHITELIST } from "../src/dev/previewFixtures";
import { api, bytesToB64, b64ToBytes } from "../src/lib/api";
import { analyzePage } from "../src/lib/analyze";
import { jobPrompt } from "../src/lib/taskProtocol";
import { exitPhase, taskResults } from "../src/lib/taskResults";
import { version } from "../package.json";

let bridge: PreviewBridge | null;
const native = vi.fn();
const network = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  native.mockReset(); network.mockReset();
  vi.stubGlobal("fetch", network);
  vi.stubEnv("DEV", true);
  window.history.replaceState({}, "", "/?preview=1");
  mockIPC(native);
  bridge = null;
});
afterEach(() => {
  bridge?.dispose(); clearMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  document.querySelector("#preview-mode-banner")?.remove(); delete document.documentElement.dataset.preview;
  expect(native).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});
function install(search = "?preview=1") {
  window.history.replaceState({}, "", `/${search}`);
  bridge = installPreviewBridge(); expect(bridge).not.toBeNull();
}
async function session(id: string, command: string, args: string[] = []) {
  let output = "";
  const exits: number[] = [];
  await listen<{ id: string; data: string }>("pty-data", event => {
    if (event.payload.id === id) output += new TextDecoder().decode(b64ToBytes(event.payload.data));
  });
  await listen<{ id: string; code: number }>("pty-exit", event => { if (event.payload.id === id) exits.push(event.payload.code); });
  await api.ptyStart(id, PREVIEW_ENGINE.path, [command, ...args], 100, 20);
  await vi.advanceTimersByTimeAsync(80);
  return { output: () => output, exits };
}

it("requires both a development build and an explicit preview=1 without replacing native IPC otherwise", () => {
  expect(shouldEnablePreview(false, "?preview=1")).toBe(false);
  expect(shouldEnablePreview(true, "?preview=0")).toBe(false);
  expect(shouldEnablePreview(true, "?preview")).toBe(false);
  expect(shouldEnablePreview(true, "?preview=1")).toBe(true);
  window.history.replaceState({}, "", "/");
  expect(installPreviewBridge()).toBeNull();
  vi.stubEnv("DEV", false);
  window.history.replaceState({}, "", "/?preview=1");
  expect(installPreviewBridge()).toBeNull();
  expect(document.querySelector("#preview-mode-banner")).toBeNull();
});

it("provides marked fixed dashboard, 100 apps, 105 analysis entries and protected clean fixtures only", async () => {
  install();
  expect(document.querySelector("#preview-mode-banner")?.textContent).toContain("不读取本机文件");
  expect(document.documentElement.dataset.preview).toBe("true");
  expect(await api.engineDetect()).toEqual(PREVIEW_ENGINE);
  expect(await api.homeDir()).toBe(PREVIEW_HOME);
  const snapshots: unknown[] = [];
  await listen("engine-status", event => snapshots.push(event.payload));
  await api.statusStart(); await vi.advanceTimersByTimeAsync(320);
  expect(snapshots).toHaveLength(8); await api.statusStop();
  const apps = await api.uninstallList(); expect(apps.apps).toHaveLength(100);
  expect(await api.appIcon(apps.apps[99].path)).toMatch(/^data:image\/svg\+xml;base64,/);
  await expect(api.appIcon("/Applications/real.app")).rejects.toThrow("没有读取本机路径");
  const analyzed = api.analyzeRun(PREVIEW_HOME, "analysis-fixture");
  const cleaned = api.cleanPreview("clean-fixture");
  await vi.advanceTimersByTimeAsync(1200);
  const result = await analyzed, clean = await cleaned;
  expect(result.entries).toHaveLength(105); expect(result.large_files).toHaveLength(105);
  expect(analyzePage(result.entries, "", "name", 3)).toMatchObject({ first: 81, last: 105, total: 105 });
  expect(result.entries[104].size).toBeNull(); expect(result.scan_status).toBe("partial");
  expect(clean.paths).toHaveLength(66); expect(await api.whitelistList()).toEqual(PREVIEW_WHITELIST);
  expect(clean.paths).toContain(PREVIEW_WHITELIST[0]);
  expect((await api.historyRun()).sessions).toHaveLength(4);
  expect(await invoke("app_update_check")).toMatchObject({ currentVersion: version, latestVersion: "0.3.1", relation: "development", availability: "source_only" });
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  expect(getCurrentWindow().label).toBe("main"); await getCurrentWindow().setFocus();
});

it("cancels only the requested pending scan and allows another fixed scan to finish", async () => {
  install();
  const analysis = api.analyzeRun(PREVIEW_HOME, "cancel-this");
  const cancelled = expect(analysis).rejects.toThrow("SCAN_CANCELLED");
  const clean = api.cleanPreview("keep-running");
  await api.scanCancel("cancel-this"); await cancelled;
  await vi.advanceTimersByTimeAsync(1200);
  expect((await clean).paths).toHaveLength(66);
  await expect(api.scanCancel("cancel-this")).rejects.toThrow("已结束或不存在");
  await expect(api.analyzeRun("/Users/real", "bad-path")).rejects.toThrow("不读取输入路径");
});

it("simulates both explicit uninstall confirmations and a zero-exit cancellation without deleting", async () => {
  install();
  const first = await session("uninstall-demo", "uninstall", [PREVIEW_APPS[0].name, PREVIEW_APPS[24].name]);
  expect(jobPrompt(first.output())?.title).toBe("核对匹配的应用"); expect(first.exits).toEqual([]);
  await api.ptyWrite("uninstall-demo", bytesToB64("y\r"));
  expect(jobPrompt(first.output())?.title).toBe("确认卸载范围"); expect(first.exits).toEqual([]);
  await api.ptyWrite("uninstall-demo", bytesToB64("\x1b"));
  expect(first.exits).toEqual([0]);
  expect(exitPhase(0, false, taskResults(first.output()))).toBe("cancelled");
  await expect(api.ptyWrite("uninstall-demo", bytesToB64("\r"))).rejects.toThrow("已结束或不存在");
  const confirmed = await session("confirmed-demo", "uninstall", [PREVIEW_APPS[99].name]);
  await api.ptyWrite("confirmed-demo", bytesToB64("y\r"));
  await api.ptyWrite("confirmed-demo", bytesToB64("\r"));
  expect(confirmed.exits).toEqual([0]);
  expect(taskResults(confirmed.output()).metrics).toContainEqual({ label: "已卸载应用", value: "1" });
  expect(await api.uninstallList()).toMatchObject({ apps: PREVIEW_APPS });
});

it("supports skipping synthetic system cleanup and blocks authorization and every native mutation path", async () => {
  install();
  const skipped = await session("skip-demo", "clean");
  expect(jobPrompt(skipped.output())?.title).toBe("是否包含系统缓存？");
  await api.ptyWrite("skip-demo", bytesToB64(" "));
  expect(skipped.exits).toEqual([0]); expect(taskResults(skipped.output()).skipped).not.toHaveLength(0);
  const denied = await session("auth-demo", "clean");
  await api.ptyWrite("auth-demo", bytesToB64("\r"));
  expect(denied.exits).toEqual([1]); expect(denied.output()).toContain("拒绝管理员授权");
  for (const command of ["pty_write_secret", "app_update_install", "app_update_restart", "app_update_open_release", "reveal_path", "touchid_enable", "unknown_native_command"]) {
    await expect(invoke(command)).rejects.toThrow("演示模式已拒绝");
  }
  const readSecret = vi.fn(() => { throw new Error("Secret payload must not be accessed"); });
  const secret = Object.defineProperty({ id: "expired-demo" }, "password", { get: readSecret });
  await expect(invoke("pty_write_secret", secret)).rejects.toThrow("演示模式已拒绝");
  expect(readSecret).not.toHaveBeenCalled();
  await expect(api.ptyStart("installer", "/bin/zsh", ["-lc", "install"], 80, 20)).rejects.toThrow("演示模式已拒绝");
  await expect(api.ptyStart("update", PREVIEW_ENGINE.path, ["update"], 80, 20)).rejects.toThrow("演示模式已拒绝");
  await expect(api.whitelistAdd("/Users/real")).rejects.toThrow("演示模式已拒绝");
  const extra = `${PREVIEW_HOME}/Library/Caches/额外演示规则`;
  expect(await api.whitelistAdd(extra)).toContain(extra);
  expect(await api.whitelistRemove(extra)).not.toContain(extra);
});

it("never automatically answers unknown prompts, rejects their input and can stop the fake task", async () => {
  install("?preview=1&previewCase=unknown-prompt");
  const unknown = await session("unknown-demo", "optimize");
  expect(jobPrompt(unknown.output())).toBeNull();
  await vi.advanceTimersByTimeAsync(2000); expect(unknown.exits).toEqual([]);
  await expect(api.ptyWrite("unknown-demo", bytesToB64("y\r"))).rejects.toThrow("演示模式已拒绝");
  await api.ptyKill("unknown-demo"); expect(unknown.exits).toEqual([130]);
  expect(taskResults(unknown.output()).cancelled).toBe(true);
});

it("offers a reproducible stale-history retry and remains blocked after disposing the preview", async () => {
  install("?preview=1&previewCase=history-retry");
  const first = await api.historyRun();
  await expect(api.historyRun()).rejects.toThrow("本次历史刷新失败");
  expect(await api.historyRun()).toEqual(first);
  bridge!.dispose();
  await expect(api.engineDetect()).rejects.toThrow("本机接口仍被禁用");
  await expect(api.ptyWriteSecret("expired-demo", "unused fixture token")).rejects.toThrow("本机接口仍被禁用");
});


it("pairs event IDs with callbacks and unregisters only the requested listener", async () => {
  install();
  const first = vi.fn(), second = vi.fn();
  const stopFirst = await listen("fixture-event", first);
  const stopSecond = await listen("fixture-event", second);
  await emit("fixture-event", { value: 1 });
  const firstId = first.mock.calls[0][0].id, secondId = second.mock.calls[0][0].id;
  expect(typeof firstId).toBe("number"); expect(firstId).not.toBe(secondId);
  expect(first.mock.calls[0][0]).toMatchObject({ event: "fixture-event", payload: { value: 1 } });
  await stopFirst(); await emit("fixture-event", { value: 2 });
  expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
  await stopSecond(); await emit("fixture-event", { value: 3 });
  expect(second).toHaveBeenCalledTimes(2);
  const internals = (window as Window & { __TAURI_INTERNALS__: { callbacks: Map<number, unknown> } }).__TAURI_INTERNALS__;
  expect(internals.callbacks.has(firstId)).toBe(false); expect(internals.callbacks.has(secondId)).toBe(false);
});

it("once removes itself before later emits and dispatch tolerates cleanup inside callbacks", async () => {
  install();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const single = vi.fn(); await once("fixture-once", single);
    await emit("fixture-once", 1); await emit("fixture-once", 2);
    expect(single).toHaveBeenCalledTimes(1);
    let removeSecond!: () => void;
    await listen("fixture-reentrant", () => removeSecond());
    const second = vi.fn(); removeSecond = await listen("fixture-reentrant", second);
    await emit("fixture-reentrant", 1);
    expect(second).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

it("handles StrictMode asynchronous mount-cleanup-remount without dead callback warnings", async () => {
  install();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const abandoned = vi.fn(), mounted = vi.fn();
    // React's first mount is disposed before listen() resolves its unlistener.
    const firstMount = listen("engine-status", abandoned);
    const secondMount = listen("engine-status", mounted);
    const cleanupFirst = firstMount.then(stop => stop());
    const cleanupSecond = await secondMount; await cleanupFirst;
    await api.statusStart(); await vi.advanceTimersByTimeAsync(320);
    expect(abandoned).not.toHaveBeenCalled(); expect(mounted).toHaveBeenCalledTimes(8);
    await cleanupSecond(); await vi.advanceTimersByTimeAsync(6000);
    expect(mounted).toHaveBeenCalledTimes(8); expect(warning).not.toHaveBeenCalled();
    await api.statusStop(); expect(vi.getTimerCount()).toBe(0);
  } finally { warning.mockRestore(); }
});

it("HMR teardown clears watch timers/listeners, rejects native calls and allows clean reinstall", async () => {
  install();
  const old = vi.fn(); const oldStop = await listen("engine-status", old);
  await api.statusStart(); await vi.advanceTimersByTimeAsync(40);
  expect(old).toHaveBeenCalledTimes(1);
  disposePreviewBridge();
  expect(vi.getTimerCount()).toBe(0);
  await oldStop(); await vi.advanceTimersByTimeAsync(6000);
  expect(old).toHaveBeenCalledTimes(1);
  await expect(listen("engine-status", vi.fn())).rejects.toThrow("本机接口仍被禁用");
  await expect(api.engineDetect()).rejects.toThrow("本机接口仍被禁用");
  install();
  const current = vi.fn(); await listen("engine-status", current);
  await oldStop(); // Late cleanup from the previous React tree is harmless.
  await api.statusStart(); await vi.advanceTimersByTimeAsync(40);
  expect(current).toHaveBeenCalledTimes(1); expect(old).toHaveBeenCalledTimes(1);
});

it("stopping or disposing from an event handler cannot restart the watch loop", async () => {
  install();
  const first = vi.fn(() => { void api.statusStop(); });
  const stop = await listen("engine-status", first);
  await api.statusStart(); await vi.advanceTimersByTimeAsync(6000);
  expect(first).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  await stop();
  const dispose = vi.fn(() => disposePreviewBridge());
  await listen("engine-status", dispose);
  await api.statusStart(); await vi.advanceTimersByTimeAsync(6000);
  expect(dispose).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it("supports explicit window event targets without sending to an unrelated window", async () => {
  install();
  const main = vi.fn(), other = vi.fn();
  await listen("fixture-target", main, { target: "main" });
  await listen("fixture-target", other, { target: "other" });
  await emitTo("main", "fixture-target", { value: 1 });
  expect(main).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled();
});
