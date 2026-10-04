// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScanProvider, useScans, isScanCancelled } from "../src/lib/scanTasks";

const bridge = vi.hoisted(() => ({ cancel: vi.fn(async (_id: string) => {}) }));
vi.mock("../src/lib/api", () => ({ api: { scanCancel: bridge.cancel } }));
let controls: ReturnType<typeof useScans>;
function Controls({ visible = true }: { visible?: boolean }) { controls = useScans(); return visible ? <span>{controls.scans.map((scan) => scan.status).join(",")}</span> : null; }
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  bridge.cancel.mockReset(); bridge.cancel.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ScanProvider><Controls /></ScanProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("keeps the scan alive across page hiding and dismiss cannot remove a running scan", async () => {
  let resolve!: (value: number) => void;
  let task!: Promise<number>;
  await act(async () => { task = controls.runScan({ title: "fixture", tag: "analyze" }, () => new Promise((done) => { resolve = done; })); });
  const id = controls.scans[0].id;
  await act(async () => controls.dismissScan(id));
  expect(controls.scans).toHaveLength(1);
  await act(async () => root.render(<ScanProvider><Controls visible={false} /></ScanProvider>));
  expect(bridge.cancel).not.toHaveBeenCalled();
  await act(async () => { resolve(7); await task; });
  expect(controls.scans[0].status).toBe("completed");
});
it("blocks duplicate tags and distinct scans can run concurrently", async () => {
  let resolve!: () => void;
  let first!: Promise<void>;
  await act(async () => { first = controls.runScan({ title: "one", tag: "analyze" }, () => new Promise<void>((done) => { resolve = done; })); });
  await expect(controls.runScan({ title: "two", tag: "analyze" }, async () => 2)).rejects.toThrow("已经运行");
  await act(async () => { await controls.runScan({ title: "clean", tag: "clean-preview" }, async () => 3); resolve(); await first; });
  expect(controls.scans).toHaveLength(2);
});
it("cancellation wins over a late successful response and errors remain distinct", async () => {
  let resolve!: (value: number) => void;
  let task!: Promise<number>;
  await act(async () => { task = controls.runScan({ title: "fixture", tag: "analyze" }, () => new Promise((done) => { resolve = done; })); });
  const rejection = task.catch((error) => error);
  const id = controls.scans[0].id;
  await act(async () => { await controls.cancelScan(id); resolve(1); await rejection; });
  expect(bridge.cancel).toHaveBeenCalledWith(id);
  expect(isScanCancelled(await rejection)).toBe(true);
  expect(controls.scans[0].status).toBe("cancelled");
  await act(async () => { await controls.runScan({ title: "timeout", tag: "analyze" }, async () => { throw new Error("SCAN_TIMEOUT: fixture"); }).catch(() => {}); });
  expect(controls.scans[1].status).toBe("failed");
  expect(controls.scans[1].error).toContain("SCAN_TIMEOUT:");
});
it("a failed stop request restores the running state and reports its error", async () => {
  let resolve!: () => void;
  let task!: Promise<void>;
  await act(async () => { task = controls.runScan({ title: "fixture", tag: "analyze" }, () => new Promise<void>((done) => { resolve = done; })); });
  bridge.cancel.mockRejectedValueOnce(new Error("bridge unavailable"));
  await act(async () => { await controls.cancelScan(controls.scans[0].id).catch(() => {}); });
  expect(controls.scans[0].status).toBe("running");
  expect(controls.scans[0].error).toContain("停止请求失败");
  await act(async () => { resolve(); await task; });
});

it("fixes the terminal elapsed time and bounds completed scan history", async () => {
  await act(async () => {
    for (let index = 0; index < 25; index++) await controls.runScan({ title: `fixture-${index}`, tag: "analyze" }, async () => index);
  });
  expect(controls.scans).toHaveLength(20);
  expect(controls.scans[0].title).toBe("fixture-5");
  expect(controls.scans.every((scan) => scan.finishedAt !== undefined && scan.finishedAt >= scan.startedAt)).toBe(true);
});
