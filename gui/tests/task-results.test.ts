import { expect, it } from 'vitest';
import { exitPhase, taskResults } from '../src/lib/taskResults';

it('separates explicit results and retains lower-bound size qualifications', () => {
  const result = taskResults('✓ User caches · cleaned\n◎ Xcode caches · skipped (Xcode running)\n☻ Failed: Fixture permission denied\nTracked cleanup: At least 1.2GB | Items cleaned: 14');
  expect(result.completed).toHaveLength(2);
  expect(result.skipped).toHaveLength(1);
  expect(result.failed).toHaveLength(1);
  expect(result.metrics).toContainEqual({label: '引擎统计清理量', value: '至少 1.2GB'});
  expect(exitPhase(0, false, result)).toBe('review');
});
it('never reports a dry run or unknown zero exit as file deletion', () => {
  const preview = taskResults('Would remove 2 apps, would free 4GB\nPotential space: 5GB');
  expect(preview.completed).toEqual([]); expect(preview.metrics).toEqual([]);
  expect(taskResults('Finished without structured results').metrics).toEqual([]);
  expect(exitPhase(0, true, taskResults('Removed 1 app, freed 22MB'))).toBe('cancelled');
});
it('shows mixed optimization outcomes even when the process exits zero', () => {
  const result = taskResults('Applied 3 optimizations\n2 unchanged | 4 skipped | 1 failed');
  expect(result.metrics).toContainEqual({label: '已应用优化', value: '3'});
  expect(result.metrics).toContainEqual({label: '引擎报告失败优化', value: '1'});
  expect(result.skipped).toEqual(['4 skipped']); expect(result.failed).toEqual(['1 failed']);
  expect(exitPhase(0, false, result)).toBe('review');
});
