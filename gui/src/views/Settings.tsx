import { PageHeader } from "../components/Page";
import { useEffect, useState } from "react";
import { useApp } from "../App";
import { MoleLogo, IconRefresh, IconDownload, IconUpload, IconTerminal, IconCpu } from "../components/icons";
import { api } from "../lib/api";
import { version } from "../../package.json";
import gplText from "../../LICENSE?raw";
import noticesText from "../../THIRD_PARTY_NOTICES.md?raw";
import thirdPartyText from "../../licenses/THIRD_PARTY_LICENSES.txt?raw";

const legalDocuments = {
  gpl: { title: "GPLv3", text: gplText },
  notices: { title: "第三方声明", text: noticesText },
  dependencies: { title: "依赖许可证", text: thirdPartyText },
};

export default function Settings() {
  const { engine, engineChecked, refreshEngine, openTask, isTagRunning } = useApp();
  const installRunning = isTagRunning("settings-install");
  const updateRunning = isTagRunning("settings-update");
  const touchIdRunning = isTagRunning("settings-touchid");
  const [nightly, setNightly] = useState(false);
  const [touchId, setTouchId] = useState<boolean | null>(null);
  const [legalView, setLegalView] = useState<keyof typeof legalDocuments | null>(null);

  useEffect(() => {
    api
      .touchidStatus()
      .then((s) => setTouchId(s.enabled))
      .catch(() => setTouchId(null));
  }, []);

  const refresh = async () => {
    await refreshEngine();
    api
      .touchidStatus()
      .then((s) => setTouchId(s.enabled))
      .catch(() => {});
  };

  const manageTouchId = () => {
    if (!engine) return;
    openTask({
      title: "Touch ID 授权(sudo)",
      note: "授权后更改管理员操作的 Touch ID 设置",
      program: engine.path,
      args: ["touchid", touchId ? "disable" : "enable"],
      tag: "settings-touchid",
      onExit: () => {
        api
          .touchidStatus()
          .then((s) => setTouchId(s.enabled))
          .catch(() => {});
      },
    });
  };

  const installEngine = () => {
    openTask({
      title: "安装引擎(官方 install.sh)",
      note: "需要网络访问 GitHub;完成后自动重新检测",
      program: "/bin/zsh",
      args: ["-c", "set -e; set -o pipefail; curl -fsSL https://raw.githubusercontent.com/tw93/mole/main/install.sh | bash -s -- --prefix \"$HOME/.local/bin\""],
      tag: "settings-install",
      mode: "background",
      onExit: () => {
        void refreshEngine();
      },
    });
  };

  const updateEngine = () => {
    if (!engine) return;
    openTask({
      title: nightly ? "更新引擎 · 测试版" : "更新引擎 · 稳定版",
      note: "如需管理员密码会自动弹出面板;完成后自动重新检测",
      program: engine.path,
      args: nightly ? ["update", "--nightly"] : ["update"],
      tag: "settings-update",
      mode: "background",
      onExit: () => {
        void refreshEngine();
      },
    });
  };

  return (
    <div>
      <PageHeader eyebrow="PREFERENCES" title="设置" description="管理 Mole 引擎，查看连接状态与应用信息。" />

      <div className="settings-status"><div className={`status-orb ${engine ? "connected" : ""}`}><IconTerminal size={28} /></div><div><h2>{engine ? "引擎已就绪" : engineChecked ? "连接你的 Mole 引擎" : "正在检测引擎"}</h2><p>{engine ? `Mole ${engine.version} · 已连接本机引擎` : "安装或检测引擎后，即可开始维护 Mac。"}</p></div><span className={`badge ${engine ? "green" : "yellow"}`}>{engine ? "已连接" : "待连接"}</span></div>
      <div className="card">
        <h3>引擎管理</h3>
        {engine ? (
          <table className="list">
            <tbody>
              <tr>
                <td style={{ width: 110, color: "var(--text-dim)" }}>版本</td>
                <td>
                  <b>v{engine.version}</b>
                </td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-dim)" }}>可执行文件</td>
                <td className="mono">{engine.path}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-dim)" }}>配置目录</td>
                <td className="mono">{engine.config_dir}</td>
              </tr>
            </tbody>
          </table>
        ) : engineChecked ? (
          <div className="error-box" style={{ marginBottom: 0 }}>
            未检测到 mole 引擎。可点击下方「安装引擎」（后台执行官方安装脚本）,或参考
            github.com/tw93/Mole 自行安装后点「重新检测」。
          </div>
        ) : (
          <div className="empty">检测中…</div>
        )}
        <div className="row wrap" style={{ marginTop: 20 }}>
          <button className="btn" onClick={refresh}>
            <IconRefresh size={14} /> 重新检测
          </button>
          <button className="btn" onClick={installEngine} disabled={!engineChecked || installRunning}>
            <IconDownload size={14} /> 安装引擎
          </button>
          <select className="text" aria-label="引擎更新频道" value={nightly ? "nightly" : "stable"} disabled={updateRunning} onChange={e => setNightly(e.target.value === "nightly")}><option value="stable">稳定版</option><option value="nightly">测试版 Nightly</option></select>
          <button className="btn" onClick={updateEngine} disabled={!engine || updateRunning}>
            <IconUpload size={14} /> 更新引擎
          </button>
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          默认使用稳定版；测试版可能改变交互格式。更新后自动检测版本，GUI 无需重装。
        </p>

        <div className="settings-auth">
          <div>
            <div className="settings-auth-title"><IconCpu size={15} />Touch ID 授权</div>
            <p className="note">为管理员操作启用指纹认证。通过 Mole 官方机制配置，不保存密码。</p>
          </div>
          <div className="settings-auth-actions">
            <span className={`badge ${touchId == null ? "dim" : touchId ? "green" : "yellow"}`}>{touchId == null ? "未知" : touchId ? "已启用" : "未启用"}</span>
            <button className="btn small" onClick={manageTouchId} disabled={!engine || touchIdRunning || touchId === null}>{touchId ? "关闭 Touch ID" : "启用 Touch ID"}</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="about-brand"><MoleLogo size={56} /><div><h2>CrownSweep <span className="badge dim">{version}</span></h2><p>让 Mac 轻装运行</p></div></div>
        <p className="note" style={{ fontSize: 12 }}>
          CrownSweep 是独立维护的 Mac 图形化工具，通过本机 <b>tw93/Mole</b> 引擎完成清理、卸载、磁盘分析、优化和状态监测。
          本项目不隶属于 Mole 项目，也不是其官方发行版。
          <br />
          <br />
          © 2026 ellaycrown 和 CrownSweep 贡献者。按 GPLv3 发布，不提供担保。上游及依赖的版权和许可证见下方声明。
          引擎提示适配已针对 Mole 1.56.1 验证，升级引擎后需重新检查兼容性。
        </p>
        <div className="legal-actions" aria-label="开源许可证">
          {(Object.keys(legalDocuments) as (keyof typeof legalDocuments)[]).map(key => (
            <button className="btn small" key={key} aria-expanded={legalView === key} aria-controls="legal-document" onClick={() => setLegalView(legalView === key ? null : key)}>{legalDocuments[key].title}</button>
          ))}
        </div>
        {legalView && <pre id="legal-document" className="legal-text" tabIndex={0} aria-label={legalDocuments[legalView].title}>{legalDocuments[legalView].text}</pre>}
      </div>
    </div>
  );
}
