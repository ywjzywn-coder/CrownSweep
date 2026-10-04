import { outputLines } from './taskProtocol';

export type TaskPhase = 'running' | 'waiting' | 'stopping' | 'completed' | 'cancelled' | 'failed' | 'review';
export const isTaskActive = (phase: TaskPhase) => ['running', 'waiting', 'stopping'].includes(phase);

export interface TaskResults {
  completed: string[];
  skipped: string[];
  failed: string[];
  review: string[];
  metrics: { label: string; value: string }[];
  cancelled: boolean;
}

/** Conservative summaries of explicit engine reports, never inferred from exit 0.
 * Unknown formats remain in the log. Counts below describe reports, not files.
 */
export function taskResults(output: string): TaskResults {
  const result: TaskResults = { completed: [], skipped: [], failed: [], review: [], metrics: [], cancelled: false };
  const lines = [...new Set(outputLines(output))];
  const metric = (label: string, value: string) => {
    const previous = result.metrics.find(entry => entry.label === label);
    if (previous) previous.value = value;
    else result.metrics.push({ label, value });
  };
  for (const line of lines) {
    const text = line.replace(/^[│┃|]\s*/, '').replace(/\s*[│┃]$/, '').trim();
    if (/^(?:[◎⊙]\s*)?Cancelled:/i.test(text)) result.cancelled = true;
    if (/\b(?:would|potential space|potential cleanup|dry run)\b/i.test(text)) continue;
    const cleanup = text.match(/^Tracked cleanup:\s*(At least\s+)?([\d.]+\s*(?:[KMGT]B|B))\b/i);
    if (cleanup) metric('引擎统计清理量', `${cleanup[1] ? '至少 ' : ''}${cleanup[2]}`);
    const removed = text.match(/^Removed\s+(\d+)\s+apps?\b.*?,\s*freed\s+([\d.]+\s*(?:[KMGT]B|B))\b/i);
    if (removed) { metric('已卸载应用', removed[1]); metric('引擎报告释放', removed[2]); }
    const applied = text.match(/^Applied\s+(\d+)\s+optimizations\b/i);
    if (applied) metric('已应用优化', applied[1]);
    const cleaned = text.match(/\bItems cleaned:\s*(\d+)\b/);
    if (cleaned) metric('引擎报告清理项目', cleaned[1]);
    if (/^\d+ (?:unchanged|skipped|unavailable|need attention|failed)(?:\s*\||$)/i.test(text)) {
      for (const part of text.split('|').map(value => value.trim())) {
        const entry = part.match(/^(\d+) (unchanged|skipped|unavailable|need attention|failed)$/i);
        if (!entry) continue;
        const count = Number(entry[1]);
        if (count === 0) continue;
        if (entry[2] === 'failed') { metric('引擎报告失败优化', entry[1]); result.failed.push(part); }
        else if (entry[2] === 'need attention') result.review.push(part);
        else if (entry[2] === 'skipped' || entry[2] === 'unavailable') result.skipped.push(part);
      }
      continue;
    }
    if (/^(?:[◎⊙☻!✗]\s*)?(?:Failed:|Error:|A required cleanup step failed\b)/i.test(text)
      || /^(?:[◎⊙]\s*)?[^/]+\s·\s.*(?:\bfailed\b|could not be removed)/i.test(text)) {
      result.failed.push(text);
    } else if (/^(?:[◎⊙✓]\s*)?(?:Skipped:|Kept\s+\d+\b|System-level cleanup skipped\b)/i.test(text)
      || /^(?:[◎⊙✓]\s*)?[^/]+\s·\s.*\b(?:skipped|deferred)\b/i.test(text)) {
      result.skipped.push(text);
    } else if (/^⊙\s/.test(text) || /^(?:[◎⊙]\s*)?(?:System extensions may remain|Background item still running|Review the warnings|Still running during uninstall)\b/i.test(text)) {
      result.review.push(text);
    } else if (/^✓\s/.test(text) || /^(?:Removed\s+\d+\s+apps?\b|Applied\s+\d+\s+optimizations\b|Tracked cleanup:)/i.test(text)) {
      result.completed.push(text);
    }
  }
  return result;
}

export function exitPhase(code: number, cancelled: boolean, results: TaskResults): TaskPhase {
  if (cancelled || results.cancelled) return 'cancelled';
  if (code !== 0) return 'failed';
  if (results.failed.length || results.review.length || results.skipped.length) return 'review';
  return 'completed';
}

export const taskPhaseLabel: Record<TaskPhase, string> = {
  running: '正在处理', waiting: '等待你的操作', stopping: '正在停止',
  completed: '任务已结束', cancelled: '已取消', failed: '任务未完成', review: '已结束 · 请查看结果',
};
