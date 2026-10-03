# CrownSweep GUI 发布手册

本文适用于 `gui/` 的独立发布。上游 CLI 的标签、发布与安装渠道继续按上游约定维护；GUI 发布不得覆盖上游 tag 或修改其 Homebrew 渠道。

## 状态和版本

0.3.1 为首个 CrownSweep 公开源码版本。目前没有完成真实 Developer ID 证书下的签名、公证及 Gatekeeper 验证，源码公开与二进制公开分发应分别记录。不得把 ad-hoc 本机预览称为已公证安装包。

同步 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、设置页和 changelog。GUI 标签建议使用 `gui-v0.3.1`，避免与上游 CLI 的 tag 混淆；标签对应的提交不可随意重写。

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
npm run tauri -- build --bundles app
```

本机 App 默认输出为 `src-tauri/target/release/bundle/macos/CrownSweep.app`。显式 `--target aarch64-apple-darwin` 或 `--target x86_64-apple-darwin` 时，输出在 `src-tauri/target/<target>/release/bundle/macos/`；相应 Rust target 需预先安装。`build.rs` 按目标编译 SMC helper；跨架构构建成功不等于在该架构运行验证通过。

Node 24、Rust ≥1.90 和 Xcode Command Line Tools 是开发前提。配置声明目标为 macOS 12.0 及更新版本；最低系统和 Intel 的实机兼容性尚未验证。CI 使用 macOS 14 ARM64 与 macOS 15 Intel runner，运行构建及模拟测试，不执行维护或签名公证。

依赖锁文件改变后生成和审阅许可证：

```sh
cargo fetch --locked --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin
python3 scripts/generate_third_party_notices.py --target aarch64-apple-darwin
```

如发布 Intel 版本，对 `x86_64-apple-darwin` 另做依赖审查。保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和 `licenses/` 的文本与归属。不得只提交最终安装包而遗漏对应源码及构建脚本。

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

## 本机升级

只在当前用户任务授权安装时执行。退出旧 App，核对源与目标 identifier，将旧副本保存在可恢复位置，完整复制新 bundle 到 Applications，避免覆盖正在运行的 App 或混合资源。复制后再验证版本、签名和主程序校验和，从安装路径启动并确认实际运行路径。

品牌更名后目标路径可为 `/Applications/CrownSweep.app`；处理历史 `Mole GUI.app` 前必须核对它确为相同 identifier。不得删除本机 Mole CLI、保护名单、配置和日志，不通过修改 TCC 或放宽代码签名要求规避权限询问。
