// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AppUpdateCard from "../src/components/AppUpdateCard";
import Settings from "../src/views/Settings";
import { downloadPercent, updateBadge, type AppUpdateInfo, type AppUpdateProgress } from "../src/lib/appUpdates";

const mocks = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), restart: vi.fn(), openRelease: vi.fn(), listen: vi.fn(), legal: { gpl: vi.fn(), notices: vi.fn(), dependencies: vi.fn() } }));
vi.mock("../src/lib/appUpdates", async (original) => ({ ...await original<typeof import("../src/lib/appUpdates")>(), appUpdates: { check: mocks.check, install: mocks.install, restart: mocks.restart, openRelease: mocks.openRelease } }));
vi.mock("../src/lib/api", () => ({ api: { touchidStatus: () => Promise.resolve({ enabled: false }) }, onEvent: mocks.listen }));
vi.mock("../src/App", () => ({ useApp: () => ({ engine: null, engineChecked: true, taskRunning: false, isTagRunning: () => false }) }));
vi.mock("../src/lib/legalDocuments", () => ({ legalDocuments: {
  gpl: { title: "GPLv3", load: mocks.legal.gpl }, notices: { title: "第三方声明", load: mocks.legal.notices }, dependencies: { title: "依赖许可证", load: mocks.legal.dependencies },
} }));

const source: AppUpdateInfo = { currentVersion: "0.4.0", platform: "darwin-aarch64", latestVersion: "0.3.1", title: "Source release", notes: "Only source; no installer.", publishedAt: "2026-10-02T08:00:00Z", releaseUrl: "https://github.com/ywjzywn-coder/CrownSweep/releases/tag/gui-v0.3.1", relation: "development", availability: "source_only", message: "此 GUI 发行版仅提供源码" };
let root: Root, host: HTMLDivElement;
let progressHandler: (progress: AppUpdateProgress) => void;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of [mocks.check, mocks.install, mocks.restart, mocks.openRelease, mocks.listen, ...Object.values(mocks.legal)]) mock.mockReset();
  mocks.listen.mockImplementation((_name: string, handler: typeof progressHandler) => { progressHandler = handler; return Promise.resolve(() => {}); });
  mocks.check.mockResolvedValue(source); mocks.openRelease.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(node: React.ReactNode) { await act(async () => root.render(node)); }
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === label);
  expect(button, label).toBeTruthy(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}

it("distinguishes source releases and local development versions without offering an installer", async () => {
  await render(<AppUpdateCard busy={false} />); await click("检查应用更新");
  expect(host.textContent).toContain("开发构建"); expect(host.textContent).toContain("当前 0.4.0 高于已发布的 0.3.1");
  expect(host.textContent).toContain("仅提供源码"); expect(host.textContent).not.toContain("已是最新");
  expect([...host.querySelectorAll("button")].some(button => button.textContent === "下载并安装")).toBe(false);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("keeps old notes visibly stale and disables installation after a failed refresh", async () => {
  mocks.check.mockResolvedValue({ ...source, latestVersion: "0.5.0", relation: "newer", availability: "installable" });
  await render(<AppUpdateCard busy={false} />); await click("检查应用更新");
  mocks.check.mockRejectedValue("GitHub rate limit"); await click("检查应用更新");
  expect(host.textContent).toContain("保留上次查询结果");
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "下载并安装")!.disabled).toBe(true);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("requires explicit confirmation, shows actual bytes, and leaves an install error retryable", async () => {
  mocks.check.mockResolvedValue({ ...source, latestVersion: "0.5.0", relation: "newer", availability: "installable" });
  let fail: (reason: string) => void = () => {};
  mocks.install.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  await render(<AppUpdateCard busy={false} />); await click("检查应用更新"); await click("下载并安装");
  expect(mocks.install).not.toHaveBeenCalled(); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  const confirm = host.querySelector<HTMLButtonElement>('[role="dialog"] .btn.primary')!;
  await act(async () => confirm.click()); expect(mocks.install).toHaveBeenCalledWith("0.5.0");
  await act(async () => progressHandler({ version: "0.5.0", phase: "downloading", downloaded: 524288, total: 1048576 }));
  expect(host.textContent).toContain("512.0 KB / 1.0 MB · 50%");
  expect(host.querySelector("progress")!.value).toBe(50);
  await act(async () => progressHandler({ version: "0.5.0", phase: "verifying", downloaded: 1048576, total: 1048576 }));
  expect(host.textContent).toContain("验证更新签名与 macOS 公证");
  await act(async () => fail("Invalid signature"));
  expect(host.textContent).toContain("Invalid signature"); expect(host.querySelector("progress")).toBeNull();
  expect(mocks.restart).not.toHaveBeenCalled();
});

it("blocks an installer while maintenance is running", async () => {
  mocks.check.mockResolvedValue({ ...source, latestVersion: "0.5.0", relation: "newer", availability: "installable" });
  await render(<AppUpdateCard busy={true} />); await click("检查应用更新");
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "下载并安装")!.disabled).toBe(true);
  expect(host.textContent).toContain("请等待扫描和维护任务结束");
});

it("uses indeterminate progress when content length is unknown", () => {
  expect(downloadPercent({ version: "0.5.0", phase: "downloading", downloaded: 200, total: null })).toBeUndefined();
  expect(downloadPercent({ version: "0.5.0", phase: "downloading", downloaded: 200, total: 0 })).toBeUndefined();
  expect(updateBadge({ ...source, relation: "current" })).toBe("源码版");
});

it("loads legal text on demand, ignores stale responses after switching, and retries failures", async () => {
  let resolveGpl: (text: string) => void = () => {};
  mocks.legal.gpl.mockImplementation(() => new Promise<string>(resolve => { resolveGpl = resolve; }));
  mocks.legal.notices.mockResolvedValue("Third-party notices fixture");
  mocks.legal.dependencies.mockRejectedValue(new Error("offline"));
  await render(<Settings />);
  expect(mocks.legal.gpl).not.toHaveBeenCalled(); expect(mocks.legal.dependencies).not.toHaveBeenCalled();
  await click("GPLv3"); expect(host.textContent).toContain("正在加载GPLv3"); await click("第三方声明");
  expect(host.querySelector(".legal-text")!.textContent).toBe("Third-party notices fixture");
  await act(async () => resolveGpl("Stale GPL result"));
  expect(host.querySelector(".legal-text")!.textContent).toBe("Third-party notices fixture");
  await click("依赖许可证"); expect(host.textContent).toContain("许可证加载失败");
  mocks.legal.dependencies.mockResolvedValue("Dependency licenses fixture"); await click("重试加载");
  expect(host.querySelector(".legal-text")!.textContent).toBe("Dependency licenses fixture");
});
