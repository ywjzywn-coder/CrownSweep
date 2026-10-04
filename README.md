# CrownSweep

<img src="gui/public/mole-icon.png" alt="CrownSweep icon" width="96" />

独立维护的 macOS 图形化维护工具，基于 React、TypeScript 和 Tauri 2，调用本机 [tw93/Mole](https://github.com/tw93/Mole) 引擎。
CrownSweep 使用自己的名称和图标，不隶属于 Mole 项目，也不是其官方发行版。

GUI 当前开发版本 **0.4.0**，已完成本机 ARM64 开发构建及安装验证，尚未发布为 GitHub Release。本仓库是 Mole 的 GitHub fork：上游 CLI 文件和历史保留在根目录，GUI 的源码、许可证声明、测试和构建脚本位于 [`gui/`](gui/)。
GUI 和 CLI 使用独立版本；GUI 标签使用 `gui-v*`，不得复用上游 CLI 的 `V*` 发布标签。

0.4.0 增加全局扫描任务与停止、大列表分页和筛选、可识别的任务结果、历史旧数据提示，以及 CrownSweep 自身更新检查。GUI 更新与 Mole 引擎更新独立；当前未配置固定 Developer ID Team ID，应用内安装更新保持禁用。布局与交互可使用明确标识的固定数据开发预览。

## 开始使用和维护

- [GUI 功能、开发与构建](gui/README.md)
- [Agent 接手指南](gui/AGENTS.md)
- [维护手册](gui/docs/MAINTENANCE.md)
- [发布、签名与公证](gui/docs/RELEASE.md)
- [第三方版权和许可证](gui/THIRD_PARTY_NOTICES.md)
- [上游原始 README](UPSTREAM_README.md)

The retained Mole CLI requires macOS 12 or newer and supports Intel and Apple Silicon.

GUI 构建依赖：macOS、Xcode Command Line Tools、Node.js 24、Rust 1.90 或以上。

```sh
cd gui
npm ci
npm test
npm run build
cargo test --lib --locked --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --bundles app
```

当前前端模拟回归和生产构建已通过；最终原生与发布工具验证记录见维护手册。完整 Developer ID 签名、公证安装包尚未发布。引擎交互适配针对 Mole 1.56.1；Intel 原生运行、最低系统 macOS 12 的实机兼容、真实维护最终操作及其他引擎版本仍需验证。

## 来源与许可

上游代码源自 tw93 及 Mole 贡献者，保留其 [GPLv3](LICENSE)、[商标声明](TRADEMARK.md) 和源码历史。
GUI 集成、独立品牌、交互和发布工具由 CrownSweep 项目添加，本轮修改日期 2026-10-03，GUI 同样按 GPLv3 发布。
SMC helper、图标和其他依赖保留各自版权与适用许可，见 [第三方声明](gui/THIRD_PARTY_NOTICES.md)。
分发 App 时必须提供与该 App 对应的源代码、构建脚本和依赖来源，不能只上传二进制。本软件不提供担保。
