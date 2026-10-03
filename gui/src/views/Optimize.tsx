import { useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import { PageHeader, EngineNotice } from "../components/Page";
import { useApp } from "../App";
import { IconBolt, IconGlobe, IconSearch, IconTrash, IconCpu } from "../components/icons";

const ITEMS = [
  { icon: <IconGlobe size={17} />, title: "网络与搜索", desc: "刷新 DNS、路由与 ARP 缓存，检查 Spotlight 并按需修复索引与过期规则。" },
  { icon: <IconSearch size={17} />, title: "Finder 与应用状态", desc: "刷新缩略图、修复偏好设置和共享列表，清理旧应用状态；调整外部卷 .DS_Store 偏好。" },
  { icon: <IconTrash size={17} />, title: "数据库与记录", desc: "压缩可处理的应用数据库，清理下载追踪、旧通知与使用记录；运行中的应用可能跳过。" },
  { icon: <IconCpu size={17} />, title: "系统检查与维护", desc: "检查磁盘、用户目录权限、登录项与失效启动项，执行到期维护脚本并检查旧系统覆盖设置。" },
];

export default function Optimize() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { engine, openTask, isTagRunning } = useApp();
  const running = isTagRunning("optimize");

  const startWizard = () => {
    if (!engine) return;
    setConfirmOpen(false);
    openTask({
      title: "系统优化",
      note: "完整维护 · 引擎按系统状态决定执行或跳过",
      program: engine.path,
      args: ["optimize"],
      tag: "optimize",
      mode: "panel",
    });
  };

  return (
    <div>
      <ConfirmDialog open={confirmOpen} title="确认运行系统维护" confirmText="开始维护" onCancel={() => setConfirmOpen(false)} onConfirm={startWizard}><p>将运行下方各类完整维护项目，可能刷新网络缓存、修改 Finder 偏好、修复权限并清理旧记录。引擎根据系统状态跳过不适用或受保护的项目。</p><p>需要管理员权限时将显示授权输入框。你可随时停止后续步骤，已执行的维护无法自动撤销。</p></ConfirmDialog>
      <PageHeader eyebrow="SYSTEM CARE" title="系统优化" description="集中处理常见的系统维护任务，让你的 Mac 保持良好状态。" />
      <EngineNotice />

      <div className="care-intro"><div className="care-symbol"><IconBolt size={32} /></div><div><h2>一次维护，更轻松的日常</h2><p>集中运行引擎提供的维护流程。遇到管理员授权时，任务面板会展开提示。</p></div><span className="badge dim">按需维护</span></div>
      <div className="grid cols-2 care-grid">
        {ITEMS.map((it) => (
          <div className="card care-card" key={it.title}>
            <div className="care-icon">{it.icon}</div>
            <div style={{ fontWeight: 600, marginBottom: 3, fontSize: 13 }}>{it.title}</div>
            <div className="note">{it.desc}</div>
          </div>
        ))}
      </div>

      <div className="action-bar">
        <button className="btn primary" onClick={() => setConfirmOpen(true)} disabled={!engine || running}>
          <IconBolt size={14} /> 开始维护
        </button>
        <span className="note">执行状态与授权会显示在任务面板中，结果保留到你手动关闭。</span>
      </div>
    </div>
  );
}
