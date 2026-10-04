import { useEffect, useState } from 'react';
import type { ScanRecord } from '../lib/scanTasks';

const labels: Record<ScanRecord['status'], string> = {
  running: '正在扫描', cancelling: '正在停止扫描', completed: '扫描完成', cancelled: '扫描已取消', failed: '扫描未完成',
};

export default function ScanProgress({ scan, onNavigate }: { scan: ScanRecord; onNavigate: () => void }) {
  const [now, setNow] = useState(Date.now());
  const active = scan.status === 'running' || scan.status === 'cancelling';
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = Math.max(0, Math.floor(((scan.finishedAt ?? now) - scan.startedAt) / 1000));
  return <div className="job-progress scan-progress">
    <div className={`job-status phase-${scan.status}`} role="status">
      <span className={active ? 'spin' : 'job-status-icon'} aria-hidden="true">{active ? '' : scan.status === 'completed' ? '✓' : scan.status === 'cancelled' ? '—' : '!'}</span>
      <div><strong>{labels[scan.status]}</strong><p>{scan.status === 'cancelling'
        ? '正在结束扫描进程及其子进程，停止后不会采用本次结果。'
        : scan.detail ?? '扫描仅检查文件，切换页面后会继续运行。'}</p></div>
      <span className="badge dim">{Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</span>
    </div>
    {scan.error && <div className="error-box" role="alert">{scan.error}</div>}
    <div className="scan-result-link"><p className="note">扫描状态和结果会保留，详情可在对应页面查看。</p><button className="btn" onClick={onNavigate}>{active ? '返回扫描页面' : '查看扫描页面'}</button></div>
  </div>;
}
