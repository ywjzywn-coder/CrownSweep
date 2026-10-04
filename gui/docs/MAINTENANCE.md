# CrownSweep 维护与交接手册

版本基线：0.4.0 开发版，更新于 2026-10-04。本轮已完成本机 ARM64 构建及安装验证，尚未发布为 GitHub Release。本文档描述 GUI 源码及验证边界，接手时仍须核对当前锁文件、版本、运行实例和引擎。公开 fork 根目录是上游 CLI，以下路径均相对 `gui/`。

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
| `src/lib/scanTasks.tsx`、`src/components/ScanProgress.tsx` | 全局扫描登记、运行时间、停止及结果页面入口 |
| `src/lib/taskProtocol.ts`、`terminalPrompt.ts` | 当前提示行识别及显式按钮响应协议 |
| `src/lib/taskResults.ts` | 明确输出的结果归纳及结束/取消/失败/待核对状态 |
| `src/lib/analyze.ts` | 分析结构校验、覆盖状态、未知大小、搜索排序及分页 |
| `src/lib/useAppIcons.ts` | 当前应用列表页图标队列、缓存与并发上限 |
| `src/components/AppUpdateCard.tsx`、`src/lib/appUpdates.ts` | CrownSweep 自身更新检查、状态和安装确认 |
| `src/lib/legalDocuments.ts` | GPL、声明及依赖许可证的按需动态加载 |
| `src/components/ConfirmDialog.tsx` | 执行前确认及键盘焦点处理 |
| `src/views/` | 仪表盘、清理、卸载、分析、优化、历史和设置 |
| `src/lib/api.ts` | invoke 封装、事件及前端类型 |
| `src-tauri/src/lib.rs` | Tauri 命令注册、阻塞任务包装及退出清理 |
| `src-tauri/src/engine/detect.rs`、`mod.rs` | 引擎发现、版本、缓存及 PATH |
| `src-tauri/src/engine/status.rs` | NDJSON 监控流、重连与连接状态 |
| `src-tauri/src/engine/tasks.rs` | 只读命令、超时、解析、保护名单及应用列表 |
| `src-tauri/src/engine/activity.rs` | 本机任务与 App 替换的互斥 permit |
| `src-tauri/src/engine/pty.rs` | 子进程会话、普通输入、秘密输入及退出 |
| `src-tauri/src/updates.rs`、`src-tauri/update-policy.json` | GUI 发行查询、固定发布身份与更新包验证/替换 |
| `src-tauri/src/engine/smc.rs`、`icons.rs` | 传感器读取和本机应用图标提取 |
| `src-tauri/build.rs`、`src-tauri/smc-helper/` | 按 TARGET 编译只读 SMC helper 并提供 sidecar |
| `src-tauri/tauri.conf.json` | 公开名称、版本、窗口、资源和 bundle |
| `app-icon.png`、`scripts/gen_icon.py` | 原创图标母版及平台资源再生成 |
| `scripts/sign_release.py`、`notarize_release.py`、`prepare_updater.py` | 固定证书签名、公证、ZIP 及版本绑定的 updater 资产 |
| `src/dev/previewBridge.ts`、`previewFixtures.ts` | 仅开发 URL 启用的固定数据桥，无原生回退 |
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
| `scan_cancel` | 按登记 ID 停止清理预览或分析扫描，不取消其他进程组 |
| `history_run` | `history --json`，兼容 sessions/deletions/logs |
| `home_dir` / `reveal_path` | 主目录解析及 Finder 定位 |
| `touchid_status` | 检查引擎 Touch ID 配置状态 |
| `smc_read` | 只读温度、转速和风扇信息 |
| `pty_start/write/write_secret/resize/kill` | 会话管理；`pty-data` 为 base64，`pty-exit` 为退出事件 |
| `pty-error` / `pty-exit.outputComplete` | 清理或输出异常；标明结果输出是否完整接收 |
| `app_update_check/install/restart/open_release` | GUI 自身更新查询、显式安装/重启及受限发行页链接 |
| `app-update-progress` | 下载、验证、安装与等待重启状态，按目标版本匹配 |

长耗时命令通过 `spawn_blocking` 包装，避免阻塞窗口。分析等待上限为 300 秒，清理预览为 180 秒；两者通过全局 `scanTasks` 分配 ID，可从原页面或任务面板停止。Rust 在启动前登记取消状态，扫描进程拥有独立进程组；停止/超时由 runner 终止并回收子进程，取消时返回 `SCAN_CANCELLED:`，超时时返回 `SCAN_TIMEOUT:`。取消后的结果不进入页面，也不会沿用上一份清理预览。

分析空路径或 `~` 先解析为主目录；`--json` 必须位于分析路径之前。`api.analyzeRun` 经过 `parseAnalyzeResult` 校验路径、大小和结构：`complete/partial/unavailable` 保留，大小 `-1` 转为未知值 `null`，不可读取的目录不显示为 0。条目和大文件列表每页 40 项，可搜索、排序和翻页到所有结果。

清理预览只接受当前成功命令生成的新预览文件，错误、超时、缺失或旧文件均不能开启清理。读取保护名单失败时显示重试并禁用清理；执行前再次读取保护规则。前端“已保护”的显示仍是字符串判断，最终通配符判定由引擎完成。

引擎检测依次考虑 `/usr/local/bin`、`/opt/homebrew/bin`、系统路径、用户 `.local/bin` / `bin` 及 PATH。配置通常位于 `~/.config/mole`。仓库中的 CLI 与本机被检测的引擎是两个对象；不要假设开发源码会自动替换本机引擎。

历史时间优先读取 `started_at`，兼容 `time/timestamp/date`。适配层仍有宽松 JSON 类型，升级引擎后必须核对实际结构，不能只改版本号。

## 后台任务及 GUI 提示

已访问页面持续挂载，以 `hidden` 切换；任务会话独立于当前页面和面板展开状态。收起、切页、切任务标签后，扫描状态、搜索条件与任务结果保留。退出整个 App 后不恢复任务。

`App.tsx` 合并扫描和 PTY 任务列表。扫描记录区分 running/cancelling/completed/cancelled/failed，最多保留最近 20 个已结束记录；活动扫描不会因该上限被丢弃。任务面板可停止扫描、返回来源页面并查看结果。`engine/activity.rs` 在任务注册/进程启动前取得 permit；App 安装替换必须取得互斥 permit，不能通过前端按钮禁用替代这层保护。

`TaskProgress` 流式解码 PTY 输出，限制日志长度，只从当前未结束的提示行识别交互。适配基线为 Mole 1.56.1：

- 卸载匹配确认后，显式点击扫描关联文件；最终范围需再次确认或取消。
- 系统缓存可选择授权继续或跳过。
- 密码使用专用输入框和 `pty_write_secret`；Rust 先检查 ECHO 关闭并拒绝控制字符。
- 常见是/否及继续提示由按钮处理。未知提示不自动回答，等待时可查看日志或停止。

不要从历史日志重新触发提示，不要恢复自由终端输入或自动应答。停止任务与取消卸载均应保持取消状态，即使引擎最终退出码为 0。结束状态不等于每个维护项成功，需要同时保留引擎结果明细。

`taskResults.ts` 只归纳明确输出，分别列出完成、跳过/保留、失败和需要查看的内容；未识别文本保留在执行详情。输入 write 的回调不得覆盖期间新到达提示的 waiting 状态。日志截断或 `outputComplete=false` 时明确提示摘要可能不完整。

PTY 在允许整组终止前验证 SID/PGID，拒绝共享 GUI 进程组。关闭会话时使用 TERM 后 KILL，App 退出时同步请求组终止；父进程先退出时继续检查残留子进程。最终读取输出后再发送 `pty-exit` 并释放 activity。若权限不足而不能结束已授权子进程，保留 session/activity、阻止安装更新并发出 `pty-error`；App 的全局错误订阅覆盖任务面板已经关闭的情况。此行为使用临时进程 fixture 验证，没有运行真实维护。

## GUI 自身更新

`app_update_*` 独立于设置中的 Mole 引擎频道，只查询 `ywjzywn-coder/CrownSweep` 的稳定 `gui-v*` 标签，忽略 CLI、draft、prerelease 和降级。每个更新包必须属于同一 GUI Release、对应目标架构，并使用版本绑定签名；设置启用 `requireSignedVersion=true`。公开源码只含验证公钥，私钥与 Apple Developer ID 证书分开保管。

下载上限 256 MiB，解压上限 1 GiB / 10,000 个条目；拒绝越界路径、符号链接和设备条目。下载后验证签名及其受信任版本、bundle identifier、主程序/helper 的架构和固定 Team ID、hardened runtime、时间戳、最低系统、stapled 公证票据及 Gatekeeper。安装前再次取得互斥 permit；同卷暂存和可恢复备份的替换步骤见发布手册。成功安装后需用户点击重启，安装状态保持锁定以免旧运行实例再启动维护任务。

事务目录在真实 App 的父目录中，名为 `.crownsweep-update-<random>/`，权限 700。`original.app` 是完整备份，`staging/CrownSweep.app` 是交给官方 updater 的独立副本；最终在 activity gate 内把旧 App 移到 `retired.app` 再替换真实路径。失败恢复旧 App，保留失败副本并报告恢复目录；未知 identifier 的目标不被移动。成功备份保留至下次启动，仅在 marker、source/installed 的 identifier/版本/Team ID/CDHash 和当前 App proof 匹配、目录内容符合允许名单时清理。维护时不要用通配符清理未知备份目录。

当前 `publisherTeamId=null`：检查可以显示源码版、缺少架构资产或待配置发布身份，但此构建不能安装更新，远程清单不能解锁。取得 Developer ID 后先配置固定 Team ID，重新构建/签名/公证并手动安装一次，后续才使用固定身份更新。真实签名、公证与 App 替换尚未验证。

## 大列表及旧数据

应用卸载每页 24 项，搜索和排序变更返回第一页，选择跨页保留。“仅看已选”“清空选择”及筛选外已选数量使最终确认范围可见；卸载仍包含所有已选项。图标只为当前页排队，最多 4 个 native 请求，旧页未启动的队列被丢弃，已完成图标复用。

历史保留最后成功读取时间。刷新失败时显示错误、旧数据标识和重试；首次失败不生成成功时间。统计只描述当前返回的记录，历史本身尚未实现完整分页。

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
python3 scripts/test_updater.py
npm run tauri -- build --bundles app
```

CI 位于仓库根目录 `.github/workflows/gui-ci.yml`。它只验证 GUI 的依赖安装、模拟测试、前端和原生构建，不执行真实维护动作，也不发布二进制。

布局与模拟交互使用开发服务和显式预览 URL：

```sh
npm run dev -- --host 127.0.0.1 --port 5175
# http://127.0.0.1:5175/?preview=1
# http://127.0.0.1:5175/?preview=1&previewCase=history-retry
# http://127.0.0.1:5175/?preview=1&previewCase=unknown-prompt
```

`main.tsx` 在 React 挂载前仅于 DEV 动态导入演示桥，使用 Tauri 官方 `mockIPC` 和 `mockWindows`，事件 ID 与 callback ID 由本桥配对登记和清理，避免 StrictMode/HMR 向过期回调重复发消息。横幅标明固定虚构数据，所有路径为演示标签：100 个应用，分析与大文件各 105 项，66 项清理预览、保护规则、仪表盘/SMC、历史和源码更新信息。扫描可以取消；PTY 演示仅模拟支持的确认、跳过、取消与结果。密码提交、真实授权、引擎安装/更新、权限修改、Finder/外链及未知/失效输入被拒绝，任何情况均无原生 fallback。初始化失败不挂载 App；dispose 后也保持 native 接口禁用，需重新加载。

前端测试核对演示调用没有进入原生 IPC 或网络。生产 JavaScript 排除演示桥和 fixtures；不要仅隐藏横幅而保留开发桥。上述验证只能说明布局和模拟交互，不能说明本机引擎执行过对应维护。

原生验证先确认运行的是哪一份 App，再检查可安全读取的引擎连接、状态、应用列表、历史和导航。普通浏览器缺少 bridge 的错误不能说明原生功能失败或引擎未安装；当前仍没有完整自动化原生端到端套件。

原生窗口默认 1160×760、最小 940×620。逐页检查表格、长路径、按钮换行、滚动与确认弹层。只读分析使用小目录并限定等待；实际清理、卸载、优化、Touch ID 修改及引擎安装/更新仅在当前用户任务明确授权时执行。

## 视觉规范

使用石墨灰底色、暖橙色强调、系统字体和中文主文案。页面依次呈现眉题、标题、简短说明、主操作、状态或结果。命令实现细节放到次要说明。

卡片间距由父级 grid/gap 管理，不叠加子卡片外边距；主要变量为 `--space-card`、`--space-grid`、`--space-section`。复用 `action-bar`、`empty-state`、`summary-strip`、`collection-toolbar` 等既有类名。按钮和输入使用真实语义元素，保持焦点可见；区分等待、未知、空结果和失败。

图标母版为 `app-icon.png`，生成命令为 `python3 scripts/gen_icon.py`。历史侧栏资源文件名 `public/mole-icon.png` 是内部路径，实际图案是 CrownSweep 原创图标；不要替换为上游商标资产。

设置页许可证通过 `legalDocuments.ts` 动态导入 raw 文本，入口显示加载/失败/重试状态。本轮生产构建主 JavaScript 约 250 KB，许可证单独分块；其较大 chunk 仍完整保留，不删除文本来规避体积提示。

## 验证基线及已知限制

0.4.0 验证：62 项前端 Vitest、35 项 Rust、11 项签名/公证脚本 fixture、8 项 updater 资产 fixture 通过，生产前端及 ARM64 App 构建通过。覆盖扫描后台/取消、分页选择、旧数据重试、PTY 提示/结果及异步输入失败、进程组回收、更新身份/签名与失败恢复、演示事件清理和边界。开发包 ad-hoc 签名后严格 bundle 校验通过，已替换本机旧版本；从安装路径运行，设置页版本 0.4.0、本机 Mole 1.56.1 连接及 33 个应用列表已核对。许可证只读核对：ARM64 metadata 的 302 个外部 Rust 包及 6 个生产 Node 包与清单一致，221 份许可证文本存在且 SHA-256 匹配。

浏览器在 940×620 与 1160×760 验证固定演示数据：分页与筛选外选择、105 项分析搜索、维护确认及结果、未知提示停止、历史错误/重试与源码更新状态；未发现页面横向溢出，修复后无重复事件回调警告。生产 JavaScript 不含演示桥或 fixtures。实际清理、卸载、优化和管理员授权没有由 agent 作为回归测试运行；用户自行发起的维护不替代可重复测试。

原生只读补验：仪表盘实时状态及 SMC 读数正常；固定临时目录的一份 16 B 文件经 GUI 分析显示 1 个条目、完成状态，分析结果表和分页正确。真实 GitHub 查询显示公开 `gui-v0.3.1` 为源码发行，当前开发版不会降级或显示可安装包。运行路径与已校验的安装包主程序 SHA-256 一致。

0.3.1 历史基线：10 项 Vitest、2 项 Rust 单元测试、11 项发布脚本 fixture 测试通过，前端及 macOS ARM64 App 构建通过。该历史基线不能替代 0.4.0 验证，脚本测试也不代表真实签名或公证成功。

0.3.0 原生只读检查基线：引擎 1.56.1、实时状态、SMC 读数、应用列表、历史及导航正常，默认与最小窗口布局曾检查。该历史基线不能替代每个新版本的完整原生验证。

- 清理、卸载和优化的真实业务结果没有以用户文件作为回归测试；GUI 提示通过模拟事件验证。
- 只读磁盘分析曾遇到小目录长时间不返回；现在可停止并有超时边界，但不同引擎版本的耗时与结构仍需原生验证。
- 引擎缺少稳定的结构化写入协议，未来提示变动可能需要更新适配，Nightly 尤其不能假定兼容。
- 历史统计是本次返回的数据量；旧数据有明确标识，历史本身未实现完整分页。
- 预览中的“已保护”采用字符串判断，不能完整解释引擎的通配符规则，最终安全判定仍由引擎执行。
- 部分状态仍使用宽松类型；需要继续完善未知值、错误恢复、重连和旧数据提示。
- 尚未完成 Intel 原生运行、最低 macOS 系统验证，以及真实 Developer ID 签名和公证。不能把临时签名构建称为已公证安装包。

## 发布及接手

版本信息与设置页需一致，公开版本更改记录于 `CHANGELOG.md`。公开名称 CrownSweep，内部 `mole-gui` / `mole_gui_lib` 和 `com.ellaycrown.molegui` 为兼容保留，不随品牌改名重置权限身份。保持固定证书及安装路径，具体流程见 [RELEASE.md](RELEASE.md)。

依赖变动后运行 `scripts/generate_third_party_notices.py` 并审阅新增许可证。发布二进制同时提供对应不可变版本的完整源码、锁文件、构建脚本和版权声明。不要提交 node_modules、target、编译后的 sidecar、日志、私钥或证书。

接手任务可从以下说明开始：

> 先阅读 gui/AGENTS.md、README.md 和 docs/MAINTENANCE.md，核对当前版本、引擎与运行实例。针对具体问题检查对应页面、任务协议及 Rust 适配层，延续现有视觉规范。运行相关模拟测试和构建，在原生 App 验证可安全读取的功能，记录已验证与未验证范围并更新 changelog。实际维护及替换已安装 App 以当前用户授权为准。
