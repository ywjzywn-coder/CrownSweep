import { createContext, useCallback, useContext, useRef, useState, ReactNode } from "react";
import { api } from "./api";

export interface ScanRecord {
  id: string;
  title: string;
  tag: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  detail?: string;
  error?: string;
}

interface ScanContextValue {
  scans: ScanRecord[];
  runScan: <T>(spec: { title: string; tag: string; detail?: string }, execute: (id: string) => Promise<T>, summarize?: (data: T) => string) => Promise<T>;
  cancelScan: (id: string) => Promise<void>;
  dismissScan: (id: string) => void;
}

const ScanContext = createContext<ScanContextValue | null>(null);
const cancelledError = () => new Error("SCAN_CANCELLED: 扫描已取消");
export const isScanCancelled = (error: unknown): boolean => String(error).includes("SCAN_CANCELLED:");

export function ScanProvider({ children }: { children: ReactNode }) {
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const records = useRef<ScanRecord[]>([]);
  const serial = useRef(0);
  const publish = useCallback((next: ScanRecord[]) => {
    const terminalIds = new Set(next.filter((scan) => scan.status !== "running" && scan.status !== "cancelling").slice(-20).map((scan) => scan.id));
    const bounded = next.filter((scan) => scan.status === "running" || scan.status === "cancelling" || terminalIds.has(scan.id));
    records.current = bounded; setScans(bounded);
  }, []);
  const update = useCallback((id: string, patch: Partial<ScanRecord>) => {
    publish(records.current.map((scan) => scan.id === id ? { ...scan, ...patch } : scan));
  }, [publish]);

  const runScan = useCallback(async <T,>(spec: { title: string; tag: string; detail?: string }, execute: (id: string) => Promise<T>, summarize?: (data: T) => string): Promise<T> => {
    if (records.current.some((scan) => scan.tag === spec.tag && (scan.status === "running" || scan.status === "cancelling"))) throw new Error("同类扫描已经运行，请等待或停止当前扫描。");
    const id = `scan-${Date.now()}-${++serial.current}-${Math.random().toString(36).slice(2, 10)}`;
    publish([...records.current, { ...spec, id, startedAt: Date.now(), status: "running" }]);
    try {
      const data = await execute(id);
      if (records.current.find((scan) => scan.id === id)?.status === "cancelling") throw cancelledError();
      update(id, { status: "completed", finishedAt: Date.now(), detail: summarize?.(data) ?? "扫描已完成", error: undefined });
      return data;
    } catch (error) {
      const cancelled = isScanCancelled(error) || records.current.find((scan) => scan.id === id)?.status === "cancelling";
      update(id, { status: cancelled ? "cancelled" : "failed", finishedAt: Date.now(), detail: cancelled ? "扫描已停止，未采用本次结果" : spec.detail, error: cancelled ? undefined : String(error) });
      throw cancelled ? cancelledError() : error;
    }
  }, [publish, update]);

  const cancelScan = useCallback(async (id: string) => {
    const scan = records.current.find((scan) => scan.id === id);
    if (!scan || scan.status !== "running") return;
    update(id, { status: "cancelling", error: undefined });
    try { await api.scanCancel(id); }
    catch (error) {
      if (records.current.find((scan) => scan.id === id)?.status === "cancelling") update(id, { status: "running", error: `停止请求失败：${String(error)}` });
      throw error;
    }
  }, [update]);

  const dismissScan = useCallback((id: string) => {
    publish(records.current.filter((scan) => scan.id !== id || scan.status === "running" || scan.status === "cancelling"));
  }, [publish]);
  return <ScanContext.Provider value={{ scans, runScan, cancelScan, dismissScan }}>{children}</ScanContext.Provider>;
}

export function useScans(): ScanContextValue {
  const context = useContext(ScanContext);
  if (!context) throw new Error("useScans must be inside ScanProvider");
  return context;
}
