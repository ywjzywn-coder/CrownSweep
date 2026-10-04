# CrownSweep

An independent, GPL-3.0 macOS desktop interface for the [tw93/Mole](https://github.com/tw93/Mole) command-line engine.

**CrownSweep 0.4.0（开发版）** 使用 React、TypeScript 和 Tauri 2，为本机 Mole 引擎提供图形化操作、后台任务和结果查看。本轮已完成 macOS ARM64 开发构建及本机安装验证，尚未发布为 GitHub Release。CrownSweep 使用独立名称及原创图标，与 Mole 官方及其商业产品没有关联或背书关系。

本仓库是 tw93/Mole 的 fork：仓库根目录保留上游 CLI，桌面应用源码位于 `gui/`。本文档及其相邻文件属于 GUI；上游说明见仓库根目录的 `UPSTREAM_README.md`。

## 功能

| 页面 | 当前能力 |
| --- | --- |
| 仪表盘 | 健康概览，CPU、内存、网络、电池、磁盘、进程及可用传感器信息 |
| 空间清理 | 可停止的只读预览、保护名单状态与重试、完整范围确认、系统缓存授权或跳过 |
| 应用卸载 | 搜索排序、每页 24 项、仅看已选、筛选外选择提醒、关联文件扫描及再次确认 |
| 磁盘分析 | 可停止的目录扫描、搜索排序、每页 40 项、完整翻页、部分/未知读数及 Finder 定位 |
| 系统优化 | 维护范围说明、执行确认、授权和实际引擎结果 |
| 操作历史 | 操作与删除记录、最后成功读取时间、刷新失败时的旧数据提醒与重试 |
| 设置 | CrownSweep 更新检查、独立引擎管理、Touch ID、版本及按需加载的许可证 |

切页或收起任务面板后，扫描和已启动的维护任务保持运行，并统一出现在任务面板。结果按引擎明确输出归纳完成、跳过、失败和待核对事项；退出码为 0 不代表所有项目成功。确认操作使用按钮，管理员密码使用专用输入框。GUI 通过后台 PTY 复用引擎，不提供终端命令输入，也不会自动确认未知提示。

提示适配基线为 **Mole 1.56.1**。其他版本，尤其 Nightly，需要单独验证。清理、卸载和优化仍会实际修改系统或文件，具体范围与结果以引擎输出为准。现有回归测试使用模拟交互和固定数据；没有以用户文件上的真实维护操作作为测试。

## 开发

开发需要 macOS、Node.js **24**、Rust/Cargo **1.90 或更新版本**、Xcode Command Line Tools。应用配置声明目标为 **macOS 12.0+**；最低系统实机兼容性尚未验证。引擎独立安装，普通浏览器没有 Tauri bridge，不能验证原生业务接口。

```sh
git clone https://github.com/ywjzywn-coder/CrownSweep.git
cd CrownSweep/gui
npm ci
npm run tauri dev
```

```sh
npm test
npm run build
cd src-tauri
cargo test --lib --locked
cd ..
npm run tauri -- build --bundles app
```

检查布局和模拟交互可运行：

```sh
npm run dev -- --host 127.0.0.1 --port 5175
```

打开 `http://127.0.0.1:5175/?preview=1` 启用带横幅的固定数据演示：100 个应用、105 项分析列表、保护名单、历史及确认/取消流程。演示不读取本机文件，不运行引擎；密码、安装、更新、权限修改及未知命令被拒绝，也不会回退到原生接口。仅开发构建启用，生产 JavaScript 不包含演示桥。`previewCase=history-retry` 可复现刷新失败和重试；`previewCase=unknown-prompt` 可检查未知提示与停止。

普通浏览器的演示验证不代表原生业务已验证。原生窗口默认 1160×760，最小 940×620。两种 CPU 架构的兼容性，以发布配置和实际验证记录为准。

## 发布状态

0.3.1 是首个使用 CrownSweep 名称的公开源码基线；0.4.0 是本轮开发版本。开发构建输出位于 `src-tauri/target/release/bundle/macos/CrownSweep.app`；交叉编译时另有目标三元组目录。自构建 App 不等于经过 Developer ID 签名、公证和 Gatekeeper 验证的公开安装包。

应用自身更新只读取此 fork 的稳定 `gui-v*` 发行记录，忽略上游 CLI 标签。没有对应签名资产时显示源码版；`src-tauri/update-policy.json` 的 `publisherTeamId` 当前为 `null`，此构建不能安装更新。取得证书后须先配置固定身份，重新构建、签名、公证并手动安装一次；远程清单不能替旧构建开启该能力。之后的安装仍需确认，且受到运行任务、256 MiB 下载上限、签名版本绑定、固定 Team ID、公证和目标架构检查约束，详见发布手册。

当前未完成有效 Developer ID 证书下的真实签名与公证验证。正式二进制分发须按 [发布手册](docs/RELEASE.md) 完成验证并同时提供对应版本源码。临时 ad-hoc 签名会改变更新身份，可能引起 macOS 再次询问桌面、文稿或下载权限。

## 维护与许可

- [AGENTS.md](AGENTS.md)：维护 agent 的边界与验收要求。
- [维护手册](docs/MAINTENANCE.md)：架构、接口、设计规范、验证基线与已知限制。
- [发布手册](docs/RELEASE.md)：版本、构建、签名、公证及公开分发。
- [CHANGELOG.md](CHANGELOG.md)：GUI 更新记录。
- [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)、[依赖许可证文本](licenses/THIRD_PARTY_LICENSES.txt)：许可与归属。

Copyright © 2026 ellaycrown and CrownSweep contributors. CrownSweep 按 GPL-3.0 分发，不提供担保。Mole 的名称及商标仍属于上游项目；代码许可不授予其品牌使用权。上游 CLI、SMC helper 和依赖的原有版权及许可证均应保留。图标母版为 `app-icon.png`，使用 `python3 scripts/gen_icon.py` 再生成平台资源。
