# CrownSweep GUI 维护指南

本文件位于公开 fork 的 `gui/`，适用于本目录及其子目录。先阅读本目录 `README.md`、`docs/MAINTENANCE.md`、最新 `CHANGELOG.md`；发布时另读 `docs/RELEASE.md`。仓库根目录保留上游 Mole CLI，不要把 GUI 的构建或发布流程套到上游 CLI。

## 项目边界

- CrownSweep 是 macOS Tauri 桌面应用，React + TypeScript 前端负责交互，Rust 适配本机 Mole 引擎。
- 清理、卸载和系统优化交给引擎。不要自行添加文件删除实现、绕过确认，或自动运行这些动作作为测试。
- 只读分析也应选择小型测试目录并限定等待时间。引擎安装、更新、Touch ID 修改和已安装 App 替换，需要当前任务中的用户授权；本文件不提供未来操作授权。
- 不删除用户引擎、配置、保护名单、日志或其他应用。替换本应用前核对 bundle identifier、版本、签名及运行路径。
- UI 修复通常限于 `src/`。沿用原生 CSS 与现有组件，不为样式引入大型框架。

## 任务及密码

- `App.tsx` 保留已访问页面和 `TaskProgress` 实例。切页、收起、切标签仅隐藏；卸载任务组件会结束会话，已结束任务重新展开不能重复启动。
- `taskProtocol.ts` 仅识别当前未结束的提示行，响应必须由用户点击按钮触发。升级引擎后核对实际提示并增加模拟事件测试；未知提示不得自动发送 `y` 或 Enter。
- 密码只走 `pty_write_secret`，后端检查 PTY 已关闭 ECHO。密码不得进入命令参数、日志、持久状态、截图或测试快照。
- 引擎退出码为 0 只说明进程正常结束，不能代表每项维护成功；保留跳过、取消和失败明细。
- 引擎不支持分类清理时，不添加表面可勾选、实际全量执行的控件。

## 界面

- 延续石墨灰和暖橙色视觉，中文主文案，复用 `src/styles.css` 变量。
- 复用 `PageHeader`、`EmptyState`、`Steps`、`EngineNotice` 和 `action-bar`。真实 button/input 提供键盘焦点及可访问标签。
- 区分未加载、等待、空结果与失败；不以 0 冒充未知值。长路径、表格和按钮在最小窗口下仍应可读。
- 更新图标母版 `app-icon.png` 后运行 `python3 scripts/gen_icon.py`，不要只编辑生成的缩略图。

## 验证及交付

- 前端修改执行 `npm run build`；任务流程执行 `npm test`；Rust 改动执行 `cargo test --lib --locked`；原生交付执行 `npm run tauri -- build --bundles app`。
- 发布脚本变更执行 `python3 scripts/test_release.py`；这些测试使用临时 fixture 和模拟工具，不应上传公证或修改钥匙串。
- 在原生 App 验证引擎连接、数据和交互。浏览器只验证布局，检查默认 1160×760、最小 940×620、长路径及滚动。
- 同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`tauri.conf.json` 和设置页版本。
- 更新 GUI changelog 与维护验证记录，明确已验证、静态检查及未验证范围。构建成功不能替代真实业务验证。

## 身份及开源要求

公开名称为 CrownSweep；不要重新使用 Mole 名称或上游图标作为独立产品品牌，也不要暗示官方关联。保留上游版权、GPL、商标说明及第三方声明；依赖锁文件变更后重新生成并审阅许可证清单。

历史内部 package/crate 名称 `mole-gui`、Rust library `mole_gui_lib`、bundle identifier `com.ellaycrown.molegui` 暂时保留，以减少升级兼容风险。公开文案与 productName 使用 CrownSweep。不要随意修改 bundle identifier 或把内部名字当作品牌恢复。

面向公开分发须使用固定 Developer ID Application 证书，内部 helper 先签，外层 App 后签，再公证及验证。脚本拒绝临时签名；缺少证书时报告限制，不修改 TCC、不自动扩大完全磁盘访问权限、不放宽签名要求。旧 ad-hoc 身份迁移到固定证书后可能仍需一次授权。
