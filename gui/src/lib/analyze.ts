export type ScanCoverage = "complete" | "partial" | "unavailable";

export interface AnalyzeFile {
  name: string;
  path: string;
  size: number | null;
}

export interface AnalyzeEntry extends AnalyzeFile {
  is_dir: boolean;
  scan_status: ScanCoverage;
  insight: boolean;
  cleanable: boolean;
}

export interface AnalyzeResult {
  path: string;
  scan_status: ScanCoverage;
  total_size: number;
  total_files?: number;
  entries: AnalyzeEntry[];
  large_files: AnalyzeFile[];
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("分析结果结构不兼容，请更新引擎后重试。");
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`分析结果缺少有效的 ${field}`);
  return value;
};
const size = (value: unknown, field: string, unknownAllowed = false): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < (unknownAllowed ? -1 : 0)) throw new Error(`分析结果包含无效的 ${field}`);
  return value < 0 ? null : value;
};
const coverage = (value: unknown): ScanCoverage => {
  if (value !== "complete" && value !== "partial" && value !== "unavailable") throw new Error("分析结果的扫描状态不兼容");
  return value;
};
const boolean = (value: unknown, field: string, optional = false): boolean => {
  if (value === undefined && optional) return false;
  if (typeof value !== "boolean") throw new Error(`分析结果包含无效的 ${field}`);
  return value;
};
const file = (value: unknown): AnalyzeFile => {
  const item = object(value);
  const path = text(item.path, "文件路径");
  if (!path.startsWith("/") || /[\u0000\n\r]/.test(path)) throw new Error("分析结果包含非法文件路径");
  return { name: text(item.name, "文件名"), path, size: size(item.size, "大小", true) };
};

export function parseAnalyzeResult(value: unknown): AnalyzeResult {
  const response = object(value);
  const result = response.result === undefined ? response : object(response.result);
  if (!Array.isArray(result.entries) || (result.large_files !== undefined && !Array.isArray(result.large_files))) throw new Error("分析结果列表不兼容");
  const path = text(result.path, "扫描路径");
  if (!path.startsWith("/")) throw new Error("分析结果的扫描路径无效");
  return {
    path,
    scan_status: coverage(result.scan_status),
    total_size: size(result.total_size, "总大小")!,
    total_files: result.total_files === undefined ? undefined : size(result.total_files, "文件数量")!,
    entries: result.entries.map((value) => {
      const item = object(value);
      return { ...file(value), is_dir: boolean(item.is_dir, "目录类型"), scan_status: coverage(item.scan_status ?? result.scan_status), insight: boolean(item.insight, "缓存提示", true), cleanable: boolean(item.cleanable, "清理提示", true) };
    }),
    large_files: (result.large_files as unknown[] | undefined ?? []).map(file),
  };
}

export type AnalyzeSort = "size-desc" | "size-asc" | "name";

export function analyzePage<T extends AnalyzeFile>(items: T[], query: string, sort: AnalyzeSort, requestedPage: number, pageSize = 40) {
  const search = query.trim().toLocaleLowerCase();
  const filtered = items.filter((item) => !search || `${item.name}\n${item.path}`.toLocaleLowerCase().includes(search));
  filtered.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    if (a.size === null || b.size === null) return a.size === b.size ? a.path.localeCompare(b.path) : a.size === null ? 1 : -1;
    return (sort === "size-asc" ? a.size - b.size : b.size - a.size) || a.path.localeCompare(b.path);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  return { items: filtered.slice((page - 1) * pageSize, page * pageSize), total: filtered.length, pageCount, page, first: filtered.length ? (page - 1) * pageSize + 1 : 0, last: Math.min(page * pageSize, filtered.length) };
}
