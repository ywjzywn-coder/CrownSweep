// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Clean from "../src/views/Clean";
import Analyze from "../src/views/Analyze";
import { ScanProvider } from "../src/lib/scanTasks";

const bridge = vi.hoisted(() => ({ whitelist: vi.fn(), preview: vi.fn(), analyze: vi.fn(), cancel: vi.fn(), openTask: vi.fn(), reveal: vi.fn() }));
vi.mock("../src/App", () => ({ useApp: () => ({ engine: { path: "fixture", version: "1.56.1" }, engineError: null, openTask: bridge.openTask, isTagRunning: () => false }) }));
vi.mock("../src/lib/api", () => ({ api: { whitelistList: bridge.whitelist, cleanPreview: bridge.preview, analyzeRun: bridge.analyze, scanCancel: bridge.cancel, homeDir: async () => "/tmp/fixture", revealPath: bridge.reveal }, fmtBytes: (value: number | null | undefined) => value == null ? "—" : `${value} B` }));
vi.mock("../src/components/Page", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>, EngineNotice: () => null, EmptyState: ({ title }: { title: string }) => <p>{title}</p>, Steps: () => null }));
let root: Root, host: HTMLDivElement;
const preview = { groups: [{ title: "缓存", items: [{ path: "/tmp/fixture/cache", size: "1KB", size_bytes: 1024 }] }], paths: ["/tmp/fixture/cache"], summary: [], raw: "", timed_out: false };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.reveal.mockResolvedValue(undefined); bridge.whitelist.mockResolvedValue([]); bridge.preview.mockResolvedValue(preview); bridge.cancel.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(page: React.ReactNode) { await act(async () => root.render(<ScanProvider>{page}</ScanProvider>)); }
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === label)!;
async function click(label: string) { expect(button(label)).toBeTruthy(); await act(async () => button(label).click()); }

it("protection-list failure disables cleanup and protecting paths until a successful retry", async () => {
  bridge.whitelist.mockRejectedValueOnce(new Error("fixture permission denied"));
  await render(<Clean />);
  await click("扫描可清理项");
  expect(host.textContent).toContain("保护名单读取失败，清理已禁用");
  expect(button("确认清理").disabled).toBe(true);
  expect(button("保护路径").disabled).toBe(true);
  expect(host.textContent).not.toContain("已保护路径0");
  await click("重试读取");
  expect(button("确认清理").disabled).toBe(false);
  expect(button("保护路径").disabled).toBe(false);
  expect(bridge.openTask).not.toHaveBeenCalled();
});
it("a failed protection refresh at confirmation prevents the actual cleanup task", async () => {
  await render(<Clean />); await click("扫描可清理项"); await click("确认清理");
  bridge.whitelist.mockRejectedValueOnce(new Error("fixture permission changed"));
  await click("开始清理");
  expect(bridge.openTask).not.toHaveBeenCalled();
  expect(host.textContent).toContain("保护名单读取失败");
});
it("a cancelled garbage scan cannot display a late response or enable cleanup", async () => {
  let resolve!: (value: typeof preview) => void;
  bridge.preview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(<Clean />); await click("扫描可清理项"); await click("停止扫描");
  await act(async () => resolve(preview));
  expect(host.textContent).toContain("未采用本次结果");
  expect(host.textContent).not.toContain("/tmp/fixture/cache");
  expect(button("确认清理").disabled).toBe(true);
});
it("disk analysis renders later pages and Finder receives the exact selected path", async () => {
  bridge.analyze.mockResolvedValue({ path: "/tmp/fixture", scan_status: "complete", total_size: 5000, entries: Array.from({ length: 105 }, (_, index) => ({ name: `file-${index}`, path: `/tmp/fixture/file-${index}`, size: index, is_dir: false, scan_status: "complete", cleanable: false, insight: false })), large_files: [] });
  await render(<Analyze />); await click("开始分析");
  expect(host.textContent).toContain("file-104");
  await click("下一页"); await click("下一页");
  expect(host.textContent).toContain("81–105 / 105 项");
  expect(host.textContent).toContain("file-0");
  await act(async () => host.querySelector<HTMLButtonElement>('button[title="在 Finder 中显示 /tmp/fixture/file-0"]')!.click());
  expect(bridge.reveal).toHaveBeenCalledWith("/tmp/fixture/file-0");
});
