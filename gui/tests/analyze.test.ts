import { expect, it } from "vitest";
import { analyzePage, parseAnalyzeResult } from "../src/lib/analyze";

const fixture = (count = 1) => ({ path: "/tmp/fixture", scan_status: "complete", total_size: count * 100, entries: Array.from({ length: count }, (_, index) => ({ name: `file-${index.toString().padStart(3, "0")}`, path: `/tmp/fixture/file-${index}`, size: index, is_dir: false, scan_status: "complete" })) });

it("validates engine results and keeps unknown entry sizes unknown", () => {
  const input = fixture(); input.entries[0].size = -1;
  expect(parseAnalyzeResult({ result: input }).entries[0].size).toBeNull();
  for (const input of [{ ...fixture(), total_size: "20" }, { ...fixture(), scan_status: "done" }, { ...fixture(), entries: [{}] }, { ...fixture(), large_files: "none" }]) expect(() => parseAnalyzeResult(input)).toThrow();
});
it("pagination exposes every result beyond the old 40-row cutoff", () => {
  const entries = parseAnalyzeResult(fixture(105)).entries;
  const collected = [1, 2, 3].flatMap((page) => analyzePage(entries, "", "size-desc", page).items);
  expect(collected).toHaveLength(105);
  expect(new Set(collected.map((item) => item.path)).size).toBe(105);
  expect(collected[0].size).toBe(104);
  expect(collected[104].size).toBe(0);
});
it("search includes paths, sorts the entire result set and clamps pages", () => {
  const entries = parseAnalyzeResult(fixture(105)).entries;
  const found = analyzePage(entries, "/file-104", "name", 99);
  expect(found.total).toBe(1); expect(found.page).toBe(1); expect(found.items[0].size).toBe(104);
  expect(analyzePage(entries, "", "size-asc", 1).items[0].size).toBe(0);
  expect(analyzePage(entries, "no-match", "name", 1)).toMatchObject({ items: [], total: 0, first: 0, last: 0 });
});
