// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Uninstall from "../src/views/Uninstall";
import History from "../src/views/History";
import type { AppEntry } from "../src/lib/api";

const bridge = vi.hoisted(() => ({
  openTask: vi.fn(), navigate: vi.fn(), uninstallList: vi.fn(), appIcon: vi.fn(), historyRun: vi.fn(),
}));
vi.mock("../src/App", () => ({ useApp: () => ({ engine: { path: "/fixture/mole", version: "1.56.1", config_dir: "/fixture/config" }, engineChecked: true, openTask: bridge.openTask, navigate: bridge.navigate, isTagRunning: () => false }) }));
vi.mock("../src/lib/api", async (original) => ({
  ...await original<typeof import("../src/lib/api")>(),
  api: { uninstallList: bridge.uninstallList, appIcon: bridge.appIcon, historyRun: bridge.historyRun },
}));

let root: Root, host: HTMLDivElement;
const apps: AppEntry[] = Array.from({ length: 50 }, (_, index) => ({
  name: `Fixture ${String(index + 1).padStart(2, "0")}`,
  bundle_id: `fixture.app${index + 1}`, source: "Applications", uninstall_name: `Fixture ${String(index + 1).padStart(2, "0")}`,
  path: `/Applications/Fixture${index + 1}.app`, size: `${100 - index} MB`, size_hint_mb: 100 - index,
}));
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  bridge.openTask.mockReset(); bridge.navigate.mockReset(); bridge.uninstallList.mockReset(); bridge.appIcon.mockReset(); bridge.historyRun.mockReset();
  bridge.uninstallList.mockResolvedValue({ apps, json: true, raw: "" });
  bridge.appIcon.mockResolvedValue("data:image/png;base64,fixture");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render(component: React.ReactNode) { await act(async () => root.render(component)); }
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  expect(button, label).toBeTruthy(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
async function search(value: string) {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="搜索应用"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("pages through every app and loads only each displayed page, reusing icon cache", async () => {
  await render(<Uninstall />); await click("获取应用列表");
  expect(host.querySelectorAll(".app-card")).toHaveLength(24);
  expect(host.textContent).toContain("显示 1–24 项，共 50 项");
  expect(bridge.appIcon.mock.calls.map(([path]) => path)).toEqual(apps.slice(0, 24).map((app) => app.path));
  await click("下一页");
  expect(host.textContent).toContain("显示 25–48 项，共 50 项");
  expect(document.activeElement).toBe(host.querySelector(".app-grid"));
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  expect(host.querySelector('[aria-label="选择 Fixture 25"]')).not.toBeNull();
  await click("下一页");
  expect(host.querySelectorAll(".app-card")).toHaveLength(2);
  expect(host.textContent).toContain("显示 49–50 项，共 50 项");
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="应用列表页码"]')!;
  await act(async () => { select.value = "1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[aria-label="选择 Fixture 01"]')).not.toBeNull();
  expect(bridge.appIcon).toHaveBeenCalledTimes(50);
  await search("50");
  expect(host.querySelectorAll(".app-card")).toHaveLength(1);
  await click("按名称");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="搜索应用"]')!.value).toBe("50");
  expect(host.textContent).toContain("显示 1–1 项，共 1 项");
});

it("keeps icon concurrency bounded and drops queued old-page work on a quick page change", async () => {
  const pending: { path: string; resolve: () => void }[] = [];
  let active = 0, maximum = 0;
  bridge.appIcon.mockImplementation((path: string) => new Promise<string>((resolve) => {
    active += 1; maximum = Math.max(maximum, active);
    pending.push({ path, resolve: () => { active -= 1; resolve("data:image/png;base64,fixture"); } });
  }));
  await render(<Uninstall />); await click("获取应用列表");
  expect(bridge.appIcon).toHaveBeenCalledTimes(4);
  await click("下一页");
  expect(bridge.appIcon).toHaveBeenCalledTimes(4);
  await act(async () => pending.splice(0, 4).forEach((item) => item.resolve()));
  expect(bridge.appIcon.mock.calls.slice(4).map(([path]) => path)).toEqual(apps.slice(24, 28).map((app) => app.path));
  while (pending.length) await act(async () => pending.splice(0).forEach((item) => item.resolve()));
  expect(maximum).toBe(4);
  expect(bridge.appIcon).toHaveBeenCalledTimes(28);
  expect(bridge.appIcon.mock.calls.slice(4).map(([path]) => path)).toEqual(apps.slice(24, 48).map((app) => app.path));
});

it("keeps selections across pages and search, warns about hidden selections, and confirms the full set", async () => {
  await render(<Uninstall />); await click("获取应用列表");
  await click("选择 Fixture 01"); await click("下一页"); await click("选择 Fixture 25");
  await search("02");
  expect(host.textContent).toContain("当前筛选外已选 2 个，卸载时仍会包含");
  await click("仅看已选");
  expect(host.textContent).toContain("没有匹配的应用");
  await click("清空搜索");
  expect(host.querySelectorAll(".app-card")).toHaveLength(2);
  expect(host.querySelector('[aria-label="取消选择 Fixture 01"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="取消选择 Fixture 25"]')).not.toBeNull();
  await click("卸载所选 (2)");
  expect(bridge.openTask).not.toHaveBeenCalled();
  expect(host.querySelector(".modal-list")!.textContent).toContain("Fixture 01");
  expect(host.querySelector(".modal-list")!.textContent).toContain("Fixture 25");
  await click("查看卸载范围");
  expect(bridge.openTask).toHaveBeenCalledWith(expect.objectContaining({ args: ["uninstall", "Fixture 01", "Fixture 25"], tag: "uninstall" }));
});

it("clears the full selection from selected-only view and provides a way back to all apps", async () => {
  await render(<Uninstall />); await click("获取应用列表");
  await click("选择 Fixture 01"); await click("仅看已选"); await click("清空选择");
  expect(host.textContent).toContain("还未选择应用");
  expect(host.querySelectorAll(".app-card")).toHaveLength(0);
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "卸载所选")!.disabled).toBe(true);
  await click("查看全部应用");
  expect(host.querySelectorAll(".app-card")).toHaveLength(24);
  expect(host.querySelector('button[aria-pressed="true"]')!.textContent).toBe("按大小");
  expect(bridge.openTask).not.toHaveBeenCalled();
});

it("labels stale history with its original successful timestamp and clears it only after retry succeeds", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T02:00:00Z"));
  bridge.historyRun.mockResolvedValueOnce({ sessions: [{ started_at: "OLD-SNAPSHOT", command: "clean" }], deletions: [] });
  await render(<History />); await click("加载历史");
  expect(host.querySelector("time")!.dateTime).toBe("2026-10-03T02:00:00.000Z");
  vi.setSystemTime(new Date("2026-10-03T03:00:00Z"));
  bridge.historyRun.mockRejectedValueOnce(new Error("fixture unavailable"));
  await click("刷新历史");
  expect(host.textContent).toContain("旧数据"); expect(host.textContent).toContain("OLD-SNAPSHOT");
  expect(host.textContent).toContain("本次刷新未成功，下方保留上次结果");
  expect(host.querySelector("time")!.dateTime).toBe("2026-10-03T02:00:00.000Z");
  let finish!: (data: unknown) => void;
  bridge.historyRun.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await click("重试加载");
  expect(host.textContent).toContain("旧数据"); expect(host.textContent).toContain("正在刷新，暂时显示上次结果");
  await act(async () => finish({ sessions: [{ started_at: "NEW-SNAPSHOT", command: "analyze" }], deletions: [] }));
  expect(host.textContent).not.toContain("旧数据"); expect(host.textContent).not.toContain("OLD-SNAPSHOT");
  expect(host.textContent).toContain("NEW-SNAPSHOT"); expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("time")!.dateTime).toBe("2026-10-03T03:00:00.000Z");
});

it("offers retry after an initial history failure without pretending old data exists", async () => {
  bridge.historyRun.mockRejectedValueOnce(new Error("fixture initial failure"));
  await render(<History />); await click("加载历史");
  expect(host.textContent).toContain("历史加载失败"); expect(host.textContent).toContain("暂时无法读取历史");
  expect(host.textContent).not.toContain("旧数据"); expect(host.querySelector("time")).toBeNull();
  bridge.historyRun.mockResolvedValueOnce({ sessions: [], deletions: [] });
  await click("重试加载");
  expect(host.textContent).toContain("暂无记录"); expect(host.querySelector('[role="alert"]')).toBeNull();
});
