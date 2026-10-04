# CrownSweep GUI 发布手册

本文适用于 `gui/` 的独立发布。上游 CLI 的标签、发布与安装渠道继续按上游约定维护；GUI 发布不得覆盖上游 tag 或修改其 Homebrew 渠道。

## 状态和版本

0.3.1 为首个 CrownSweep 公开源码基线，当前开发版本为 0.4.0，已完成本机 ARM64 构建及安装验证，尚未发布为 GitHub Release。本机包使用 ad-hoc 开发签名，严格 bundle 校验通过；真实 Developer ID 签名、公证及 Gatekeeper 验证仍待配置证书后执行。源码公开与二进制公开分发应分别记录，不得把本机开发版称为已公证安装包。

同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、设置页和 changelog。GUI 稳定发行标签使用 `gui-v<version>`（例如 `gui-v0.4.0`），避免与上游 CLI 的 tag 混淆；标签对应的提交和已发布资产不可重写。使用者看得到源码提交不代表存在对应的二进制 Release。

产品名称为 CrownSweep；bundle identifier 保留 `com.ellaycrown.molegui`，内部 package/crate 名称保留 `mole-gui`。更新公开名称不需要更换身份。首次从旧临时签名迁移到固定证书后仍可能需要授权一次，不承诺系统永不提示。

## 构建和依赖声明

从公开仓库的 `gui/` 执行：

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

本机 App 默认输出为 `src-tauri/target/release/bundle/macos/CrownSweep.app`。显式 `--target aarch64-apple-darwin` 或 `--target x86_64-apple-darwin` 时，输出在 `src-tauri/target/<target>/release/bundle/macos/`；相应 Rust target 需预先安装。`build.rs` 按目标编译 SMC helper；跨架构构建成功不等于在该架构运行验证通过。

Node 24、Rust ≥1.90 和 Xcode Command Line Tools 是开发前提。配置声明目标为 macOS 12.0 及更新版本；最低系统和 Intel 的实机兼容性尚未验证。CI 使用 macOS 14 ARM64 与 macOS 15 Intel runner，运行构建及模拟测试，不执行维护或签名公证。

布局与模拟交互另用开发服务的 `?preview=1`。预览有固定数据横幅，全部命令走 fixture 或拒绝；生产 JavaScript 应排除 `src/dev/` 桥和数据。生产构建成功、开发预览通过或 updater fixture 通过，均不能替代签名 App 的真实安装/重启验收。

依赖锁文件改变后生成和审阅许可证：

```sh
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
python3 scripts/generate_third_party_notices.py --target aarch64-apple-darwin
```

如发布 Intel 版本，对 `x86_64-apple-darwin` 另做依赖审查。保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `licenses/` 的文本与归属。不得只提交最终安装包而遗漏对应源码及构建脚本。

0.4.0 本轮 ARM64 清单与 302 个外部 Rust 包、6 个生产 Node 包一致；221 份许可证文本的 SHA-256 核对通过。更新锁文件后仍须重新生成/审阅，不能把该记录用于另一个版本或目标。

## 更新身份准备

GUI 自身更新与 Mole 引擎更新独立，只接受此 fork 的稳定 `gui-v*` Release。当前 `src-tauri/update-policy.json` 中 `publisherTeamId=null`，已构建的 App 只可查询，不能安装更新；远程 manifest 不能替它指定发布身份。没有对应 updater 资产的 Release 显示源码版。

取得有效 Developer ID 后，先把证书的固定 10 位 Team ID 写入 `src-tauri/update-policy.json`，再重新构建、签名和公证。首次从 Team ID 为 null 的构建迁移，需要手动安装该固定身份版本一次，之后才可接收同一身份的应用内更新。

`src-tauri/tauri.conf.json` 只提交 updater 公钥，并保留 `requireSignedVersion=true`。签名私钥与 Apple 证书是两个独立身份：私钥放在维护者本机仓库外，限所有者读写（600），其相邻 `.pub` 必须与嵌入公钥一致。后续发布复用原私钥，不自动生成或轮换；遗失私钥需明确的手动迁移方案，不能让已安装 App 信任一个远程新公钥。不提交密码、证书、私钥或签名工具捕获的输出。

## Developer ID 签名

在维护者已自行准备有效的 Developer ID Application 身份后，检查可用证书：

```sh
security find-identity -v -p codesigning
```

在本地设置 `CROWNSWEEP_SIGNING_IDENTITY` 为完整证书名称或 SHA-1。旧环境变量 `MOLE_SIGNING_IDENTITY` 仅作为兼容别名。不要把证书文件、私钥或凭据提交到仓库。

```sh
python3 scripts/sign_release.py --dry-run
python3 scripts/sign_release.py
```

脚本从配置读取 App 名称，先签内部 helper / 可执行代码，再签外层 App，启用 hardened runtime 和安全时间戳，进行严格校验。它拒绝 `-` 临时签名及非 Developer ID 身份，不创建证书、不修改钥匙串、不安装 App。`--dry-run` 不执行签名，也不能证明证书或 bundle 有效。Tauri 未签名开发产物不能预期通过正式 bundle 签名校验。

交叉编译输出需使用 `--app 'src-tauri/target/<target>/release/bundle/macos/CrownSweep.app'` 显式指定产物。

## 公证和公开二进制

使用已配置的钥匙串公证 profile，通过本地环境变量 `CROWNSWEEP_NOTARY_PROFILE` 指定；或提供本地 App Store Connect key 的路径和 ID（`CROWNSWEEP_NOTARY_KEY_PATH`、`CROWNSWEEP_NOTARY_KEY_ID`）。team key 还需 `CROWNSWEEP_NOTARY_ISSUER`；individual key 不设 issuer。两种方式不能混用，不在聊天或源码中粘贴秘密。

```sh
python3 scripts/notarize_release.py --dry-run
python3 scripts/notarize_release.py
```

脚本验证固定签名，上传临时 ZIP 并等待公证结果；只有 Accepted 才 staple、验证 ticket、执行 Gatekeeper assessment 并输出最终 ZIP。默认名为 `CrownSweep-<version>-mac.zip`；两个架构分别指定 `--app` 和带架构标识的 `--output`，避免文件名覆盖。

生成的 `.notary-log.json` 供本地排查，不自动公开。不能把仅构建出的 DMG 宣称为已公证产物；本流程默认分发经验证的 ZIP。若另做 DMG，需单独完成其签名、公证、staple 和 Gatekeeper 验证。

公开分发前核对：

1. App 的 Info.plist 版本、identifier、最低系统、主程序及 helper 架构正确。
2. 内外层严格签名校验通过，Developer ID、hardened runtime 及 timestamp 已核对。
3. 公证 Accepted，stapler validate 及 Gatekeeper assessment 通过。
4. 原生 App 在目标架构及声明的最低系统上完成必要运行检查；未验证的范围明确列出。
5. 源码提交与二进制版本一致，提供不可变 GUI tag 的完整源码链接、构建步骤、GPL 和第三方归属。
6. Release 附件的 SHA-256 已计算，名称包含版本与架构；不包含日志、凭据或私有路径。

## 应用内更新资产

普通分发 ZIP 与 updater 包是不同附件。完成上面的固定身份签名、公证、staple 和 Gatekeeper 验证后，运行资产准备脚本。每个版本使用单独输出目录；以下变量由维护者填写，不包含私钥内容：

```sh
RELEASE_APP='path/to/CrownSweep.app'
RELEASE_OUTPUT='path/to/release-assets/<version>'
UPDATER_KEY="$HOME/.local/share/crownsweep/release-keys/updater.key"
python3 scripts/prepare_updater.py --app "$RELEASE_APP" --arch aarch64 \
  --output-dir "$RELEASE_OUTPUT" --private-key-path "$UPDATER_KEY" \
  --notes-file CHANGELOG.md
```

Intel 使用对应的已验证 App 和 `--arch x86_64`，输出目录仍是同一版本的目录。脚本检查 bundle identifier、版本、主程序/helper 架构、固定 Team ID、公证及 Gatekeeper，拒绝 bundle 符号链接；使用 Tauri CLI `--app-version` 为 tar.gz 生成版本绑定签名。脚本不上传、公证、安装或修改钥匙串，也不会打印私钥或签名工具捕获内容。

生成的附件为：

- `CrownSweep-<version>-aarch64.app.tar.gz` / `.tar.gz.sig`。
- `CrownSweep-<version>-x86_64.app.tar.gz` / `.tar.gz.sig`（若发布 Intel）。
- `crownsweep-update.json`：合并本次已准备架构，platform key 为 `darwin-aarch64` / `darwin-x86_64`。

manifest 的 version 与目标 GUI tag 一致，url 固定为同一 `gui-v<version>` Release 下对应架构的附件。审阅后上传 archive、各自 `.sig` 和 manifest 到该不可变 GUI Release，同时提供对应 tag 的完整源码、锁文件、构建脚本、许可证与依赖源码来源。其他架构资产尚未完成时，不把它写进 manifest。脚本先在临时目录完成归档、签名与清单检查，再发布到最终文件名；签名失败不会遗留最终 archive，可修复原因后重试。已经存在的最终 archive/signature 不会被覆盖。

客户端拒绝 CLI 标签、draft、prerelease、降级、其他仓库/版本资产和不受信任跳转。下载上限 256 MiB，解压上限 1 GiB / 10,000 个条目，拒绝路径穿越、链接及设备；验证签名内容与受信任版本后，核对 bundle、架构、最低系统、固定 Developer ID、hardened runtime、时间戳、公证和 Gatekeeper。metadata 查询/资产校验通过仍不等于 App 已安装。

安装替换前由 Rust activity permit 阻止扫描/维护并发。客户端在真实 App 的父目录创建同卷 `.crownsweep-update-<random>/`，权限 700：`original.app` 保存完整备份，`staging/CrownSweep.app` 是交给官方 updater 的独立副本。父目录只读、跨卷、开发裸 binary 和 symlink 目标均拒绝安装。最终 gate 内先把旧 App rename 为事务目录中的 `retired.app`，再把新 App rename 到真实路径。

替换失败会恢复旧 App，保留失败副本并显示恢复目录；如果真实目标已变成未知 identifier 的应用，不移动该目标。成功后保留备份直到下一次 App 启动，只有 `marker.json` 的固定 kind/schema、source/installed 的 identifier/版本/Team ID/CDHash、当前 App proof 及目录内容允许名单全部匹配，才清理本事务。未知、失败或内容异常的目录保留给维护者核对，不自动通配清理。

成功安装后显示等待重启，由用户点击重启；旧运行实例不再接受新维护任务。事务行为通过临时目录 fixture 验证；真实固定证书签名、公证、应用内下载安装和重启仍未验证，正式二进制发布前必须补齐目标环境验收。

## 本机升级

只在当前用户任务授权安装时执行。退出旧 App，核对源与目标 identifier，将旧副本保存在可恢复位置，完整复制新 bundle 到 Applications，避免覆盖正在运行的 App 或混合资源。复制后再验证版本、签名和主程序校验和，从安装路径启动并确认实际运行路径。

品牌更名后目标路径可为 `/Applications/CrownSweep.app`；处理历史 `Mole GUI.app` 前必须核对它确为相同 identifier。不得删除本机 Mole CLI、保护名单、配置和日志，不通过修改 TCC 或放宽代码签名要求规避权限询问。
