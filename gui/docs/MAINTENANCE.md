# CrownSweep 维护与交接手册

版本基线：0.3.1，更新于 2026-10-02。本文档描述 GUI 源码及验证边界，接手时仍须核对当前锁文件、版本、运行实例和引擎。公开 fork 根目录是上游 CLI，以下路径均相对 `gui/`。

## 架构

CrownSweep 采用 React 18、TypeScript、Vite 6、Tauri 2、Rust 和 portable-pty；样式为原生 CSS。前端负责页面、选择、确认、授权及结果展示，Rust 层运行本机独立安装的 Mole CLI。GUI 不实现文件删除。

```text
React 页面 → src/lib/api.ts → Tauri command → Rust engine 模块 → Mole CLI
                      ↑                         │
                      └── 状态 / PTY 事件 ───────┘
```

| 文件 | 职责 |
| --- | --- |
| `src/App.tsx` | 导航、Context、引擎检测、监控订阅、页面与任务保活 |
| `src/styles.css`、`src/components/Page.tsx` | 视觉变量、布局及共享页面组件 |
| `src/components/TaskProgress.tsx` | PTY 生命周期、流式输出、GUI 确认、密码、取消和结果 |
| `src/lib/taskProtocol.ts`、`terminalPrompt.ts` | 当前提示行识别及显式按钮响应协议 |
| `src/components/ConfirmDialog.tsx` | 执行前确认及键盘焦点处理 |
| `src/views/` | 仪表盘、清理、卸载、分析、优化、历史和设置 |
| `src/lib/api.ts` | invoke 封装、事件及前端类型 |
| `src-tauri/src/lib.rs` | Tauri 命令注册、阻塞任务包装及退出清理 |
| `src-tauri/src/engine/detect.rs`、`mod.rs` | 引擎发现、版本、缓存及 PATH |
| `src-tauri/src/engine/status.rs` | NDJSON 监控流、重连与连接状态 |
| `src-tauri/src/engine/tasks.rs` | 只读命令、超时、解析、保护名单及应用列表 |
| `src-tauri/src/engine/pty.rs` | 子进程会话、普通输入、秘密输入及退出 |
| `src-tauri/src/engine/smc.rs`、`icons.rs` | 传感器读取和本机应用图标提取 |
| `src-tauri/build.rs`、`src-tauri/smc-helper/` | 按 TARGET 编译只读 SMC helper 并提供 sidecar |
| `src-tauri/tauri.conf.json` | 公开名称、版本、窗口、资源和 bundle |
| `app-icon.png`、`scripts/gen_icon.py` | 原创图标母版及平台资源再生成 |
| `scripts/sign_release.py`、`notarize_release.py` | 固定证书签名、公证及 ZIP 分发 |
| `THIRD_PARTY_NOTICES.md`、`licenses/` | 依赖归属、来源、校验和及许可证全文 |

## 原生接口与引擎

| 命令或事件 | 用途 |
| --- | --- |
| `engine_detect` | 探测常用路径与 PATH，读取 `mole version` |
| `status_start` / `status_stop` | `status --watch --interval 2s` 监控流 |
| `engine-status` | JSON 快照，前端保留最多 120 个历史点 |
| `engine-watch-state` / `engine-error` | 连接、重连、停止及错误 |
| `clean_preview` | `clean --dry-run`，返回 groups/summary/raw/timed_out |
| `whitelist_list/add/remove` | 引擎保护名单配置 |
| `uninstall_list` / `app_icon` | 应用列表及图标，兼容 JSON 与文本回退 |
| `analyze_run` | `analyze --json <path>`，返回 result/raw_stderr |
| `history_run` | `history --json`，兼容 sessions/deletions/logs |
| `home_dir` / `reveal_path` | 主目录解析及 Finder 定位 |
| `touchid_status` | 检查引擎 Touch ID 配置状态 |
| `smc_read` | 只读温度、转速和风扇信息 |
| `pty_start/write/write_secret/resize/kill` | 会话管理；`pty-data` 为 base64，`pty-exit` 为退出事件 |

长耗时命令通过 `spawn_blocking` 包装，避免阻塞窗口。当前分析等待上限为 300 秒，没有前端取消按钮。空路径或 `~` 先解析为主目录；`--json` 必须位于分析路径之前。

引擎检测依次考虑 `/usr/local/bin`、`/opt/homebrew/bin`、系统路径、用户 `.local/bin` / `bin` 及 PATH。配置通常位于 `~/.config/mole`。仓库中的 CLI 与本机被检测的引擎是两个对象；不要假设开发源码会自动替换本机引擎。

历史时间优先读取 `started_at`，兼容 `time/timestamp/date`。适配层仍有宽松 JSON 类型，升级引擎后必须核对实际结构，不能只改版本号。

## 后台任务及 GUI 提示

已访问页面持续挂载，以 `hidden` 切换；任务会话独立于当前页面和面板展开状态。收起、切页、切任务标签后，扫描状态、搜索条件与任务结果保留。退出整个 App 后不恢复任务。

`TaskProgress` 流式解码 PTY 输出，限制日志长度，只从当前未结束的提示行识别交互。适配基线为 Mole 1.56.1：

- 卸载匹配确认后，显式点击扫描关联文件；最终范围需再次确认或取消。
- 系统缓存可选择授权继续或跳过。
- 密码使用专用输入框和 `pty_write_secret`；Rust 先检查 ECHO 关闭并拒绝控制字符。
- 常见是/否及继续提示由按钮处理。未知提示不自动回答，等待时可查看日志或停止。

不要从历史日志重新触发提示，不要恢复自由终端输入或自动应答。停止任务与取消卸载均应保持取消状态，即使引擎最终退出码为 0。结束状态不等于每个维护项成功，需要同时保留引擎结果明细。

## 开发和验证

工具要求：macOS、Node 24、Rust ≥1.90、Xcode Command Line Tools。配置声明目标为 macOS 12.0+；最低系统实机兼容性尚未验证。首次安装使用 `npm ci`，按锁文件构建：

```sh
npm ci
npm test
npm run build
cd src-tauri
cargo test --lib --locked
cd ..
python3 scripts/test_release.py
npm run tauri -- build --bundles app
```

CI 位于仓库根目录 `.github/workflows/gui-ci.yml`。它只验证 GUI 的依赖安装、模拟测试、前端和原生构建，不执行真实维护动作，也不发布二进制。

验证时先确认运行的是哪一份 App，再检查引擎连接、状态刷新、应用搜索、历史及页面导航。浏览器只能检查样式；缺少 Tauri bridge 的错误不能说明原生功能失败或引擎未安装。当前没有完整 mock bridge 或自动化原生端到端套件。

原生窗口默认 1160×760、最小 940×620。逐页检查表格、长路径、按钮换行、滚动与确认弹层。只读分析使用小目录并限定等待；实际清理、卸载、优化、Touch ID 修改及引擎安装/更新仅在当前用户任务明确授权时执行。

## 视觉规范

使用石墨灰底色、暖橙色强调、系统字体和中文主文案。页面依次呈现眉题、标题、简短说明、主操作、状态或结果。命令实现细节放到次要说明。

卡片间距由父级 grid/gap 管理，不叠加子卡片外边距；主要变量为 `--space-card`、`--space-grid`、`--space-section`。复用 `action-bar`、`empty-state`、`summary-strip`、`collection-toolbar` 等既有类名。按钮和输入使用真实语义元素，保持焦点可见；区分等待、未知、空结果和失败。

图标母版为 `app-icon.png`，生成命令为 `python3 scripts/gen_icon.py`。历史侧栏资源文件名 `public/mole-icon.png` 是内部路径，实际图案是 CrownSweep 原创图标；不要替换为上游商标资产。

## 验证基线及已知限制

0.3.1 本机验证：10 项 Vitest、2 项 Rust 单元测试、11 项发布脚本 fixture 测试通过，前端及 macOS ARM64 App 构建通过。脚本测试使用模拟工具，不代表真实签名或公证成功。

0.3.0 原生只读检查基线：引擎 1.56.1、实时状态、SMC 读数、应用列表、历史及导航正常，默认与最小窗口布局曾检查。该历史基线不能替代每个新版本的完整原生验证。

- 清理、卸载和优化的真实业务结果没有以用户文件作为回归测试；GUI 提示通过模拟事件验证。
- 只读磁盘分析曾遇到小目录长时间不返回；当前仍需调查引擎行为及结果展示，没有取消按钮。
- 引擎缺少稳定的结构化写入协议，未来提示变动可能需要更新适配，Nightly 尤其不能假定兼容。
- 历史统计是本次返回的数据量；失败重载可能保留旧数据，未实现完整分页。
- 预览中的“已保护”采用字符串判断，不能完整解释引擎的通配符规则，最终安全判定仍由引擎执行。
- 部分状态仍使用宽松类型；需要继续完善未知值、错误恢复、重连和旧数据提示。
- 尚未完成 Intel 原生运行、最低 macOS 系统验证，以及真实 Developer ID 签名和公证。不能把临时签名构建称为已公证安装包。

## 发布及接手

版本信息与设置页需一致，公开版本更改记录于 `CHANGELOG.md`。公开名称 CrownSweep，内部 `mole-gui` / `mole_gui_lib` 和 `com.ellaycrown.molegui` 为兼容保留，不随品牌改名重置权限身份。保持固定证书及安装路径，具体流程见 [RELEASE.md](RELEASE.md)。

依赖变动后运行 `scripts/generate_third_party_notices.py` 并审阅新增许可证。发布二进制同时提供对应不可变版本的完整源码、锁文件、构建脚本和版权声明。不要提交 node_modules、target、编译后的 sidecar、日志、私钥或证书。

接手任务可从以下说明开始：

> 先阅读 gui/AGENTS.md、README.md 和 docs/MAINTENANCE.md，核对当前版本、引擎与运行实例。针对具体问题检查对应页面、任务协议及 Rust 适配层，延续现有视觉规范。运行相关模拟测试和构建，在原生 App 验证可安全读取的功能，记录已验证与未验证范围并更新 changelog。实际维护及替换已安装 App 以当前用户授权为准。
