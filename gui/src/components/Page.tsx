import type { ReactNode } from "react";
import { useApp } from "../App";

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-heading"><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-desc">{description}</p></header>;
}

export function EmptyState({ icon, title, description, busy = false }: { icon: ReactNode; title: string; description: string; busy?: boolean }) {
  return <div className={`empty-state ${busy ? "is-busy" : ""}`} role="status"><div className="empty-symbol">{busy ? <span className="spin" /> : icon}</div><h2>{title}</h2><p>{description}</p></div>;
}

export function Steps({ labels, active }: { labels: string[]; active: number }) {
  return <ol className="steps" aria-label="操作步骤">{labels.map((label, index) => <li key={label} className={index === active ? "current" : index < active ? "done" : ""} aria-current={index === active ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</li>)}</ol>;
}

export function EngineNotice() {
  const { engine, engineChecked, navigate } = useApp();
  if (engine || !engineChecked) return null;
  return <div className="engine-notice"><span>连接 Mole 引擎后，即可使用此功能。</span><button className="btn small" onClick={() => navigate("settings")}>前往设置</button></div>;
}
