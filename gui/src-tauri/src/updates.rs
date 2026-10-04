//! CrownSweep updates are separate from the Mole CLI channel.
//! Metadata is read only from the public fork; installation requires both the
//! embedded updater signature and a fixed Developer ID / notarization identity.
use base64::Engine;
use flate2::read::GzDecoder;
use minisign_verify::{PublicKey, Signature};
use reqwest::{redirect::Policy, Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::{Cursor, Read}, path::{Component, Path, PathBuf}, process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock}, time::Duration};
use std::os::unix::process::CommandExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

const REPOSITORY: &str = "ywjzywn-coder/CrownSweep";
const MANIFEST_NAME: &str = "crownsweep-update.json";
const MAX_METADATA: usize = 2 * 1024 * 1024;
const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;
const MAX_EXPANDED: u64 = 1024 * 1024 * 1024;
const MAX_TOOL_OUTPUT: usize = 64 * 1024;
static PREPARED: OnceLock<Mutex<Option<Update>>> = OnceLock::new();
static BUSY: AtomicBool = AtomicBool::new(false);
static INSTALLED: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePolicy { publisher_team_id: Option<String> }

fn publisher_team() -> Result<Option<String>, String> {
    let policy: UpdatePolicy = serde_json::from_str(include_str!("../update-policy.json"))
        .map_err(|_| "应用更新发布身份配置无效".to_string())?;
    match policy.publisher_team_id {
        Some(team) if team.len() == 10 && team.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) => Ok(Some(team)),
        None => Ok(None),
        _ => Err("应用更新发布身份尚未正确配置".into()),
    }
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset { name: String, browser_download_url: String }
#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)] name: Option<String>,
    #[serde(default)] body: Option<String>,
    #[serde(default)] published_at: Option<String>,
    #[serde(default)] draft: bool,
    #[serde(default)] prerelease: bool,
    #[serde(default)] assets: Vec<ReleaseAsset>,
}
#[derive(Debug, Deserialize)]
struct Artifact { url: String, signature: String }
#[derive(Debug, Deserialize)]
struct Manifest { version: String, platforms: HashMap<String, Artifact> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    platform: String,
    latest_version: Option<String>,
    title: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    release_url: String,
    relation: String,
    availability: String,
    message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { version: String, phase: String, downloaded: u64, total: Option<u64> }

struct BusyGuard;
impl BusyGuard {
    fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "应用更新正在进行，请稍后再试".to_string())?;
        Ok(Self)
    }
}
impl Drop for BusyGuard { fn drop(&mut self) { BUSY.store(false, Ordering::Release); } }
fn prepared() -> &'static Mutex<Option<Update>> { PREPARED.get_or_init(|| Mutex::new(None)) }

fn release_version(release: &Release) -> Option<Version> {
    if release.draft || release.prerelease { return None; }
    let spelling = release.tag_name.strip_prefix("gui-v")?;
    let version = Version::parse(spelling).ok()?;
    if !version.pre.is_empty() || spelling != version.to_string() { return None; }
    Some(version)
}
fn newest_gui(releases: &[Release]) -> Option<(&Release, Version)> {
    releases.iter().filter_map(|r| release_version(r).map(|v| (r, v))).max_by(|a, b| a.1.cmp(&b.1))
}
fn asset_url(tag: &str, name: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}")
}
fn platform() -> Result<String, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-aarch64".into()),
        ("macos", "x86_64") => Ok("darwin-x86_64".into()),
        _ => Err("此更新频道仅支持 macOS Intel 和 Apple Silicon".into()),
    }
}
fn trusted_redirect(url: &Url) -> bool {
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        && url.port().is_none() && matches!(url.host_str(), Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"))
}
fn download_redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 || !trusted_redirect(attempt.url()) {
            attempt.error("更新下载来源重定向不受信任")
        } else { attempt.follow() }
    })
}
fn client(assets: bool) -> Result<Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder().user_agent("CrownSweep-update-check")
        .timeout(Duration::from_secs(25)).https_only(true)
        .redirect(if assets { download_redirect_policy() } else { Policy::none() })
        .build().map_err(|_| "无法初始化安全更新连接".into())
}
async fn metadata(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).header("Accept", "application/vnd.github+json")
        .send().await.map_err(|_| "无法连接 GitHub，请检查网络后重试".to_string())?;
    if !response.status().is_success() {
        return Err(if response.status().as_u16() == 403 || response.status().as_u16() == 429 {
            "GitHub 暂时限制更新查询，请稍后重试".into()
        } else { format!("更新查询失败（HTTP {}）", response.status().as_u16()) });
    }
    if response.content_length().is_some_and(|n| n > MAX_METADATA as u64) { return Err("更新元数据超出大小限制".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "更新信息读取中断，请重试".to_string())? {
        if bytes.len() + chunk.len() > MAX_METADATA { return Err("更新元数据超出大小限制".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn validate_manifest(manifest: &Manifest, release: &Release, version: &Version, target: &str) -> Result<Option<String>, String> {
    if manifest.version != version.to_string() { return Err("更新清单版本与发行标签不一致，已拒绝安装".into()); }
    for (key, artifact) in &manifest.platforms {
        let arch = match key.as_str() { "darwin-aarch64" => "aarch64", "darwin-x86_64" => "x86_64", _ => return Err("更新清单包含不支持的平台".into()) };
        let name = format!("CrownSweep-{version}-{arch}.app.tar.gz");
        if artifact.url != asset_url(&release.tag_name, &name)
            || !release.assets.iter().any(|a| a.name == name && a.browser_download_url == artifact.url) {
            return Err("更新包并非此版本的 CrownSweep 发行附件，已拒绝安装".into());
        }
        let decoded = base64::engine::general_purpose::STANDARD.decode(artifact.signature.trim())
            .map_err(|_| "更新包缺少有效签名格式".to_string())?;
        let signature = std::str::from_utf8(&decoded).map_err(|_| "更新签名格式无效".to_string())?;
        if !signature.starts_with("untrusted comment:") || !signature.lines().any(|line| line.starts_with("trusted comment:") && line.split('\t').any(|p| p == format!("version:{version}"))) {
            return Err("更新签名未绑定此发行版本，已拒绝安装".into());
        }
    }
    Ok(manifest.platforms.get(target).map(|a| a.url.clone()))
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let _busy = BusyGuard::acquire()?;
    if INSTALLED.load(Ordering::Acquire) { return Err("应用已更新，请先重启 CrownSweep".into()); }
    *prepared().lock().map_err(|_| "更新状态不可用".to_string())? = None;
    let target = platform()?;
    let current = app.package_info().version.clone();
    let http = client(false)?;
    let mut releases = Vec::new();
    // The fork also has upstream CLI releases. Do not use /releases/latest or
    // mistake the upstream V* tags for CrownSweep GUI releases.
    for page in 1..=5 {
        let bytes = metadata(&http, &format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}")).await?;
        let batch: Vec<Release> = serde_json::from_slice(&bytes).map_err(|_| "GitHub 发行信息格式无效".to_string())?;
        let more = batch.len() == 100;
        releases.extend(batch);
        if !more { break; }
        if page == 5 { return Err("发行记录超过查询范围，请从项目发行页核对版本".into()); }
    }
    let mut info = UpdateInfo {
        current_version: current.to_string(), platform: target.clone(), latest_version: None,
        title: None, notes: None, published_at: None,
        release_url: format!("https://github.com/{REPOSITORY}/releases"),
        relation: "unknown".into(), availability: "source_only".into(),
        message: "项目还没有发布可识别的 CrownSweep GUI 版本".into(),
    };
    let Some((release, latest)) = newest_gui(&releases) else { return Ok(info); };
    info.latest_version = Some(latest.to_string()); info.title = release.name.clone();
    info.notes = release.body.clone(); info.published_at = release.published_at.clone();
    info.release_url = format!("https://github.com/{REPOSITORY}/releases/tag/{}", release.tag_name);
    info.relation = if latest > current { "newer" } else if latest == current { "current" } else { "development" }.into();
    let Some(manifest_asset) = release.assets.iter().find(|a| a.name == MANIFEST_NAME) else {
        info.message = "此 GUI 发行版仅提供源码，尚未发布经过验证的应用更新包".into();
        return Ok(info);
    };
    let manifest_url = asset_url(&release.tag_name, MANIFEST_NAME);
    if manifest_asset.browser_download_url != manifest_url { return Err("更新清单来源无效，已拒绝安装".into()); }
    let bytes = metadata(&client(true)?, &manifest_url).await?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "应用更新清单格式无效".to_string())?;
    let Some(download_url) = validate_manifest(&manifest, release, &latest, &target)? else {
        info.availability = "unavailable_platform".into();
        info.message = "此发行版尚未提供适用于当前 Mac 架构的更新包".into(); return Ok(info);
    };
    if publisher_team()?.is_none() {
        info.availability = "publisher_not_configured".into();
        info.message = "此构建尚未配置固定 Developer ID 发布身份，暂不能安装更新".into(); return Ok(info);
    }
    if latest <= current {
        info.availability = "available".into();
        info.message = if latest == current { "当前版本与已发布 GUI 版本一致" } else { "当前为高于已发布版本的开发构建，不会降级安装" }.into();
        return Ok(info);
    }
    let updater = app.updater_builder().endpoints(vec![Url::parse(&manifest_url).map_err(|_| "更新来源无效".to_string())?])
        .map_err(|_| "无法配置安全更新来源".to_string())?
        .target(&target).timeout(Duration::from_secs(180))
        .configure_client(|builder| builder.https_only(true).redirect(download_redirect_policy()))
        .build().map_err(|_| "无法初始化签名更新服务".to_string())?;
    let update = updater.check().await.map_err(|_| "无法验证更新清单，请稍后重试".to_string())?
        .ok_or_else(|| "发行信息与更新清单不一致，请稍后重试".to_string())?;
    if update.version != latest.to_string() || update.download_url.as_str() != download_url
        || update.signature != manifest.platforms[&target].signature {
        return Err("更新清单在查询期间发生变化，请重新检查".into());
    }
    *prepared().lock().map_err(|_| "更新状态不可用".to_string())? = Some(update);
    info.availability = "installable".into();
    info.message = "发现适用于此 Mac 的更新；安装前会验证更新签名、发布身份和公证".into();
    Ok(info)
}

fn emit(app: &AppHandle, version: &str, phase: &str, downloaded: u64, total: Option<u64>) {
    let _ = app.emit("app-update-progress", Progress { version: version.into(), phase: phase.into(), downloaded, total });
}
fn safe_archive_path(path: &Path) -> bool {
    let mut components = path.components();
    matches!(components.next(), Some(Component::Normal(root)) if root == "CrownSweep.app")
        && components.all(|c| matches!(c, Component::Normal(_)))
}
fn extract_verified_archive(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(GzDecoder::new(Cursor::new(bytes)));
    let entries = archive.entries().map_err(|_| "更新包不是有效的应用压缩包".to_string())?;
    let mut expanded = 0u64;
    let mut count = 0usize;
    for entry in entries {
        let mut entry = entry.map_err(|_| "更新压缩包损坏".to_string())?;
        let path = entry.path().map_err(|_| "更新包路径无效".to_string())?.into_owned();
        let kind = entry.header().entry_type();
        // CrownSweep has no frameworks/symlinks. Reject links and devices rather
        // than allowing archive entries to escape the temporary verification dir.
        if !safe_archive_path(&path) || (!kind.is_file() && !kind.is_dir()) { return Err("更新包包含不安全路径或链接，已拒绝安装".into()); }
        count += 1;
        expanded = expanded.checked_add(entry.size()).ok_or_else(|| "更新包过大".to_string())?;
        if expanded > MAX_EXPANDED || count > 10000 { return Err("更新包超出大小限制".into()); }
        if !entry.unpack_in(destination).map_err(|_| "无法解压更新包进行验证".to_string())? { return Err("更新包路径超出验证目录".into()); }
    }
    Ok(())
}
fn native_tool(program: &str, arguments: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(arguments).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = command.spawn().map_err(|_| "macOS 更新验证工具不可用".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "更新验证输出不可用".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "更新验证输出不可用".to_string())?;
    let output_thread = std::thread::spawn(move || bounded_tool_output(stdout));
    let error_thread = std::thread::spawn(move || bounded_tool_output(stderr));
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|_| "macOS 更新验证工具异常".to_string())? { break status; }
        if started.elapsed() > Duration::from_secs(90) {
            // Kill only this verification process group, including xcrun's child.
            unsafe { nix::libc::kill(-(child.id() as i32), nix::libc::SIGKILL); }
            let _ = child.kill(); let _ = child.wait();
            return Err("macOS 签名或公证验证超时，已拒绝安装".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = output_thread.join().map_err(|_| "更新验证输出异常".to_string())??;
    let stderr = error_thread.join().map_err(|_| "更新验证输出异常".to_string())??;
    if !status.success() { return Err("更新包未通过 macOS 签名或公证检查，已拒绝安装".into()); }
    Ok(format!("{}{}", String::from_utf8_lossy(&stdout), String::from_utf8_lossy(&stderr)))
}
fn bounded_tool_output(mut reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new(); let mut overflow = false; let mut buffer = [0u8; 4096];
    loop {
        let count = reader.read(&mut buffer).map_err(|_| "更新验证输出读取失败".to_string())?;
        if count == 0 { break; }
        if bytes.len() + count > MAX_TOOL_OUTPUT { overflow = true; } else { bytes.extend_from_slice(&buffer[..count]); }
    }
    if overflow { Err("macOS 验证输出超出限制，已拒绝安装".into()) } else { Ok(bytes) }
}
fn validate_identity(metadata: &str, team: &str) -> bool {
    metadata.lines().any(|line| line.starts_with("Authority=Developer ID Application: "))
        && metadata.lines().any(|line| line == format!("TeamIdentifier={team}"))
        && metadata.lines().any(|line| line.strip_prefix("Timestamp=").is_some_and(|stamp| !stamp.is_empty() && stamp != "none" && stamp != "not set"))
        && metadata.lines().any(|line| line.starts_with("CodeDirectory ") && line.contains("runtime"))
}
fn validate_bundle(bytes: &[u8], version: &str, team: &str) -> Result<(), String> {
    let directory = tempfile::tempdir().map_err(|_| "无法创建更新验证临时目录".to_string())?;
    extract_verified_archive(bytes, directory.path())?;
    let bundle = directory.path().join("CrownSweep.app");
    validate_native_bundle(&bundle, version, team)?;
    Ok(())
}
fn validate_native_bundle(bundle: &Path, version: &str, team: &str) -> Result<BundleProof, String> {
    if fs::symlink_metadata(bundle).map_err(|_| "应用包不存在".to_string())?.file_type().is_symlink() { return Err("应用包不能是符号链接".into()); }
    let bundle_arg = bundle.as_os_str();
    native_tool("/usr/bin/codesign", &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), bundle_arg])?;
    let mut code_hash = None;
    for code in [bundle.to_path_buf(), bundle.join("Contents/MacOS/mole-gui"), bundle.join("Contents/MacOS/mole-smc")] {
        let metadata = native_tool("/usr/bin/codesign", &["--display".as_ref(), "--verbose=4".as_ref(), code.as_os_str()])?;
        if !validate_identity(&metadata, team) { return Err("更新包的 Developer ID 发布身份与本应用不一致，已拒绝安装".into()); }
        if code == bundle { code_hash = metadata.lines().find_map(|line| line.strip_prefix("CDHash=")).map(str::to_owned); }
    }
    let plist = bundle.join("Contents/Info.plist");
    for (key, value) in [("CFBundleIdentifier", "com.ellaycrown.molegui"), ("CFBundleShortVersionString", version), ("CFBundleExecutable", "mole-gui")] {
        let actual = native_tool("/usr/libexec/PlistBuddy", &["-c".as_ref(), format!("Print :{key}").as_ref(), plist.as_os_str()])?;
        if actual.trim() != value { return Err("更新包的应用身份或版本与发行信息不一致，已拒绝安装".into()); }
    }
    let minimum = native_tool("/usr/libexec/PlistBuddy", &["-c".as_ref(), "Print :LSMinimumSystemVersion".as_ref(), plist.as_os_str()])?;
    let system = native_tool("/usr/bin/sw_vers", &["-productVersion".as_ref()])?;
    if !supports_system(minimum.trim(), system.trim()) { return Err("此更新要求更新的 macOS，已拒绝安装".into()); }
    let arch = std::env::consts::ARCH;
    let expected_arch = if arch == "aarch64" { "arm64" } else { "x86_64" };
    for executable in ["mole-gui", "mole-smc"] {
        let path = bundle.join("Contents/MacOS").join(executable);
        let arches = native_tool("/usr/bin/lipo", &["-archs".as_ref(), path.as_os_str()])?;
        if !arches.split_whitespace().any(|arch| arch == expected_arch) { return Err("更新包架构不适用于此 Mac，已拒绝安装".into()); }
    }
    native_tool("/usr/bin/xcrun", &["stapler".as_ref(), "validate".as_ref(), bundle_arg])?;
    native_tool("/usr/sbin/spctl", &["--assess".as_ref(), "--type".as_ref(), "execute".as_ref(), bundle_arg])?;
    let code_hash = code_hash.filter(|hash| hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| "应用签名校验和不可用".to_string())?;
    Ok(BundleProof { identifier: "com.ellaycrown.molegui".into(), version: version.into(), team: team.into(), code_hash })
}
fn supports_system(minimum: &str, system: &str) -> bool {
    let parse = |value: &str| -> Option<(u64, u64, u64)> {
        let mut parts = value.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next().unwrap_or("0").parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        if parts.next().is_some() { return None; }
        Some((major, minor, patch))
    };
    matches!((parse(minimum), parse(system)), (Some(minimum), Some(system)) if system >= minimum)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct BundleProof { identifier: String, version: String, team: String, code_hash: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupMarker {
    schema: u32,
    kind: String,
    target: PathBuf,
    source: BundleProof,
    installed: Option<BundleProof>,
    status: String,
}
struct InstallTransaction { root: PathBuf, marker: BackupMarker }
const BACKUP_PREFIX: &str = ".crownsweep-update-";

fn actual_bundle(executable: &Path) -> Result<PathBuf, String> {
    let macos = executable.parent().ok_or_else(|| "无法确定应用运行位置".to_string())?;
    let contents = macos.parent().ok_or_else(|| "无法确定应用运行位置".to_string())?;
    let bundle = contents.parent().ok_or_else(|| "无法确定应用运行位置".to_string())?;
    if macos.file_name().is_none_or(|name| name != "MacOS") || contents.file_name().is_none_or(|name| name != "Contents")
        || executable.file_name().is_none_or(|name| name != "mole-gui") || bundle.extension().is_none_or(|extension| extension != "app") {
        return Err("当前是开发运行实例，请手动安装经过签名公证的 App 后再使用应用更新".into());
    }
    let metadata = fs::symlink_metadata(bundle).map_err(|_| "当前应用包不存在".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("当前 App 必须是完整的应用目录，不能是符号链接".into()); }
    bundle.canonicalize().map_err(|_| "无法确定当前 App 的真实位置".into())
}
fn copy_bundle(source: &Path, destination: &Path) -> Result<(), String> {
    native_tool("/usr/bin/ditto", &[source.as_os_str(), destination.as_os_str()])
        .map_err(|_| "无法复制完整应用备份，原应用尚未替换".to_string())?;
    Ok(())
}
impl InstallTransaction {
    fn prepare(target: PathBuf, source: BundleProof) -> Result<Self, String> {
        let parent = target.parent().ok_or_else(|| "应用目录无效".to_string())?;
        let parent_metadata = fs::metadata(parent).map_err(|_| "无法读取应用目录".to_string())?;
        if parent_metadata.permissions().mode() & 0o222 == 0 {
            return Err("应用目录不可写，请手动安装到你有写入权限的位置；不会请求管理员权限替换应用".into());
        }
        let root = tempfile::Builder::new().prefix(BACKUP_PREFIX).tempdir_in(parent)
            .map_err(|_| "应用父目录不可写，无法建立同卷恢复备份；请手动更新应用".to_string())?.keep();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护恢复备份目录".to_string())?;
        if fs::metadata(&root).map_err(|_| "恢复备份目录不可用".to_string())?.dev() != fs::metadata(&target).map_err(|_| "当前应用不存在".to_string())?.dev() {
            return Err("恢复备份与当前 App 不在同一磁盘，已拒绝更新".into());
        }
        let transaction = Self { root, marker: BackupMarker { schema: 1, kind: "CrownSweep update backup".into(), target, source, installed: None, status: "prepared".into() } };
        let prepared = (|| {
            transaction.write_marker()?;
            copy_bundle(&transaction.marker.target, &transaction.original())?;
            let staging = transaction.root.join("staging");
            fs::create_dir(&staging).map_err(|_| "无法创建更新暂存目录".to_string())?;
            fs::set_permissions(staging, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护暂存目录".to_string())?;
            copy_bundle(&transaction.marker.target, &transaction.staged())?;
            Ok::<_, String>(())
        })();
        prepared.map_err(|reason| format!("{reason}；恢复目录位于 {}", transaction.root.display()))?;
        Ok(transaction)
    }
    fn original(&self) -> PathBuf { self.root.join("original.app") }
    fn staged(&self) -> PathBuf { self.root.join("staging/CrownSweep.app") }
    fn retired(&self) -> PathBuf { self.root.join("retired.app") }
    fn write_marker(&self) -> Result<(), String> {
        let contents = serde_json::to_vec(&self.marker).map_err(|_| "恢复备份记录无效".to_string())?;
        let temporary = self.root.join("marker.tmp");
        fs::write(&temporary, contents).map_err(|_| "无法写入恢复备份记录".to_string())?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)).map_err(|_| "无法保护恢复记录".to_string())?;
        fs::rename(temporary, self.root.join("marker.json")).map_err(|_| "无法保存恢复备份记录".to_string())
    }
    fn replace<F, M>(&mut self, version: &str, validate: &F, move_new: M) -> Result<(), String>
    where F: Fn(&Path, &str, &str) -> Result<BundleProof, String>, M: FnOnce(&Path, &Path) -> std::io::Result<()> {
        let team = &self.marker.source.team;
        if validate(&self.marker.target, &self.marker.source.version, team)? != self.marker.source
            || validate(&self.original(), &self.marker.source.version, team)? != self.marker.source {
            return Err("原应用在更新过程中发生变化，已拒绝替换".into());
        }
        let installed = validate(&self.staged(), version, team)?;
        fs::rename(&self.marker.target, self.retired()).map_err(|_| "应用目录权限发生变化，未替换原应用".to_string())?;
        let result = move_new(&self.staged(), &self.marker.target)
            .map_err(|_| "更新应用移动失败".to_string())
            .and_then(|_| validate(&self.marker.target, version, team))
            .and_then(|proof| if proof == installed { Ok(()) } else { Err("安装后应用验证不一致".into()) });
        if let Err(reason) = result {
            return match self.restore(validate) {
                Ok(()) => Err(format!("{reason}；原应用已恢复。恢复备份保留在 {}", self.root.display())),
                Err(restore_error) => Err(format!("{reason}；{restore_error}。请从恢复备份 {} 手动恢复", self.root.display())),
            };
        }
        self.marker.installed = Some(installed); self.marker.status = "installed".into();
        // A failed marker write keeps the backup, but the installed App is valid.
        // Do not report a failed installation after replacing it successfully.
        let _ = self.write_marker();
        Ok(())
    }
    fn restore<F>(&mut self, validate: &F) -> Result<(), String>
    where F: Fn(&Path, &str, &str) -> Result<BundleProof, String> {
        if validate(&self.retired(), &self.marker.source.version, &self.marker.source.team)? != self.marker.source { return Err("恢复备份完整性验证失败".into()); }
        if self.marker.target.exists() {
            if fs::symlink_metadata(&self.marker.target).map_err(|_| "无法检查安装目录".to_string())?.file_type().is_symlink() {
                return Err("安装位置被符号链接替换，未自动覆盖".into());
            }
            // Only move a known CrownSweep bundle aside. Never remove unknown
            // contents that another process may have placed at the target path.
            let identifier = bundle_identifier(&self.marker.target)?;
            if identifier != self.marker.source.identifier { return Err("安装位置已被其他内容占用，未自动覆盖".into()); }
            fs::rename(&self.marker.target, self.root.join("failed.app")).map_err(|_| "无法保留失败的安装副本".to_string())?;
        }
        fs::rename(self.retired(), &self.marker.target).map_err(|_| "原应用自动恢复失败".to_string())?;
        if validate(&self.marker.target, &self.marker.source.version, &self.marker.source.team)? != self.marker.source { return Err("恢复后的应用完整性验证失败".into()); }
        self.marker.status = "restored".into(); let _ = self.write_marker(); Ok(())
    }
}
fn bundle_identifier(bundle: &Path) -> Result<String, String> {
    let plist = bundle.join("Contents/Info.plist");
    native_tool("/usr/libexec/PlistBuddy", &["-c".as_ref(), "Print :CFBundleIdentifier".as_ref(), plist.as_os_str()]).map(|value| value.trim().to_owned())
}
fn cleanup_backups_at<F>(target: &Path, current: &BundleProof, validate: F) -> Result<(), String>
where F: Fn(&Path, &str, &str) -> Result<BundleProof, String> {
    let parent = target.parent().ok_or_else(|| "应用目录无效".to_string())?;
    for entry in fs::read_dir(parent).map_err(|_| "无法读取恢复目录".to_string())? {
        let entry = entry.map_err(|_| "无法读取恢复目录".to_string())?;
        if !entry.file_name().to_string_lossy().starts_with(BACKUP_PREFIX) { continue; }
        let metadata = entry.path().symlink_metadata().map_err(|_| "无法检查恢复目录".to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { nix::libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 { continue; }
        let marker_path = entry.path().join("marker.json");
        let Ok(marker_metadata) = marker_path.symlink_metadata() else { continue; };
        if marker_metadata.file_type().is_symlink() || marker_metadata.len() > MAX_METADATA as u64 || marker_metadata.uid() != metadata.uid() { continue; }
        let Ok(bytes) = fs::read(marker_path) else { continue; };
        let Ok(marker) = serde_json::from_slice::<BackupMarker>(&bytes) else { continue; };
        if marker.schema != 1 || marker.kind != "CrownSweep update backup" || marker.target != target || marker.status != "installed" || marker.installed.as_ref() != Some(current)
            || marker.source.identifier != current.identifier || marker.source.team != current.team { continue; }
        let original = entry.path().join("original.app");
        if validate(&original, &marker.source.version, &marker.source.team).ok().as_ref() != Some(&marker.source) { continue; }
        if validate(&entry.path().join("retired.app"), &marker.source.version, &marker.source.team).ok().as_ref() != Some(&marker.source)
            || validate(target, &current.version, &current.team).ok().as_ref() != Some(current) { continue; }
        // This directory is ours and its original/installed identities match.
        // Unknown extra content causes retention for inspection instead of loss.
        let allowed = ["marker.json", "original.app", "retired.app", "staging"];
        let Ok(children) = fs::read_dir(entry.path()) else { continue; };
        if children.filter_map(Result::ok).any(|child| !allowed.contains(&child.file_name().to_string_lossy().as_ref())) { continue; }
        let Ok(mut staging) = fs::read_dir(entry.path().join("staging")) else { continue; };
        if staging.next().is_some() { continue; }
        fs::remove_dir_all(entry.path()).map_err(|_| "旧恢复备份暂时无法清理，已保留".to_string())?;
    }
    Ok(())
}
pub fn cleanup_previous_backups(app: &AppHandle) {
    let Ok(_permit) = crate::engine::activity::begin_task() else { return; };
    let Ok(Some(team)) = publisher_team() else { return; };
    let Ok(executable) = std::env::current_exe() else { return; };
    let Ok(target) = actual_bundle(&executable) else { return; };
    let version = app.package_info().version.to_string();
    let Ok(current) = validate_native_bundle(&target, &version, &team) else { return; };
    let _ = cleanup_backups_at(&target, &current, validate_native_bundle);
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle, expected_version: String) -> Result<(), String> {
    let _busy = BusyGuard::acquire()?;
    if INSTALLED.load(Ordering::Acquire) { return Err("应用已更新，请重启 CrownSweep".into()); }
    let team = publisher_team()?.ok_or_else(|| "尚未配置固定 Developer ID 发布身份，无法安装更新".to_string())?;
    let update = prepared().lock().map_err(|_| "更新状态不可用".to_string())?.clone()
        .ok_or_else(|| "请先检查应用更新".to_string())?;
    if update.version != expected_version { return Err("待安装版本已改变，请重新检查更新".into()); }
    let current = app.package_info().version.clone();
    if Version::parse(&update.version).map_err(|_| "更新版本无效".to_string())? <= current { return Err("更新版本必须高于当前版本".into()); }
    emit(&app, &update.version, "downloading", 0, None);
    let bytes = download_bounded(&app, &update).await?;
    emit(&app, &update.version, "verifying", bytes.len() as u64, Some(bytes.len() as u64));
    let public_key = app.config().plugins.0.get("updater").and_then(|value| value.get("pubkey")).and_then(|value| value.as_str())
        .ok_or_else(|| "应用更新验证公钥不可用".to_string())?;
    verify_downloaded_signature(&bytes, &update.signature, public_key, &update.version)?;
    let version = update.version.clone();
    let current_version = current.to_string();
    let preparation_team = team.clone();
    let (mut transaction, bytes) = tauri::async_runtime::spawn_blocking(move || {
        validate_bundle(&bytes, &version, &preparation_team)?;
        let executable = std::env::current_exe().map_err(|_| "无法确定应用位置".to_string())?;
        let target = actual_bundle(&executable)?;
        let source = validate_native_bundle(&target, &current_version, &preparation_team)
            .map_err(|_| "当前应用未通过固定 Developer ID 与公证检查，请先手动安装一次正式签名的 App".to_string())?;
        let transaction = InstallTransaction::prepare(target, source)?;
        if validate_native_bundle(&transaction.original(), &current_version, &preparation_team)? != transaction.marker.source {
            return Err(format!("恢复备份未通过完整性检查，尚未替换应用；恢复目录位于 {}", transaction.root.display()));
        }
        Ok::<_, String>((transaction, bytes))
    }).await.map_err(|_| "更新验证进程异常，尚未替换应用".to_string())??;
    let backup_location = transaction.root.display().to_string();
    let endpoint = asset_url(&format!("gui-v{}", update.version), MANIFEST_NAME);
    // Install only to an owned, writable staging App. The official macOS
    // installer can never delete the real App or request admin privileges here.
    let staging_update = app.updater_builder().executable_path(transaction.staged().join("Contents/MacOS/mole-gui"))
        .endpoints(vec![Url::parse(&endpoint).map_err(|_| "更新来源无效".to_string())?])
        .map_err(|_| "更新来源不可用".to_string())?.target(platform()?).timeout(Duration::from_secs(180))
        .configure_client(|builder| builder.https_only(true).redirect(download_redirect_policy()))
        .build().map_err(|_| format!("无法准备更新；原应用未替换，备份位于 {backup_location}"))?
        .check().await.map_err(|_| format!("无法重新验证更新清单；原应用未替换，备份位于 {backup_location}"))?
        .ok_or_else(|| format!("更新清单已改变；原应用未替换，备份位于 {backup_location}"))?;
    if staging_update.version != update.version || staging_update.download_url != update.download_url || staging_update.signature != update.signature {
        return Err(format!("更新清单在下载期间发生变化；原应用未替换，备份位于 {backup_location}"));
    }
    let app_for_install = app.clone();
    let version = update.version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut permit = crate::engine::activity::begin_install().map_err(|reason| format!("{reason}；原应用未替换，备份位于 {}", transaction.root.display()))?;
        let stage = transaction.staged();
        let probe = transaction.root.join("rename-probe.app");
        // Verify actual rename permission before entering the official installer.
        // Staging is owned/private; inability to rename is a hard rejection.
        fs::rename(&stage, &probe).and_then(|_| fs::rename(&probe, &stage))
            .map_err(|_| format!("更新暂存目录不可写；原应用未替换，备份位于 {}", transaction.root.display()))?;
        emit(&app_for_install, &version, "installing", bytes.len() as u64, Some(bytes.len() as u64));
        staging_update.install(&bytes).map_err(|_| format!("暂存更新失败；原应用未替换，恢复备份位于 {}", transaction.root.display()))?;
        transaction.replace(&version, &validate_native_bundle, |source, target| fs::rename(source, target))
            .map_err(|reason| format!("{reason}；备份目录 {}", transaction.root.display()))?;
        permit.commit();
        INSTALLED.store(true, Ordering::Release);
        emit(&app_for_install, &version, "installed", bytes.len() as u64, Some(bytes.len() as u64));
        Ok::<(), String>(())
    }).await.map_err(|_| format!("更新进程异常，请检查应用；恢复备份位于 {backup_location}"))??;
    Ok(())
}

fn append_download(bytes: &mut Vec<u8>, chunk: &[u8], total: Option<u64>) -> Result<(), String> {
    if !download_size_allowed(bytes.len() as u64, chunk.len() as u64, total) {
        return Err("更新包超过 256 MB 下载限制，已中止且未安装".into());
    }
    bytes.extend_from_slice(chunk); Ok(())
}
fn download_size_allowed(current: u64, chunk: u64, total: Option<u64>) -> bool {
    !total.is_some_and(|size| size > MAX_DOWNLOAD)
        && current.checked_add(chunk).is_some_and(|size| size <= MAX_DOWNLOAD)
}
async fn download_bounded(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    // The official download API buffers without a size cap. Use the same secure
    // endpoint and signature verifier with a hard cap, then the official install.
    let mut response = client(true)?.get(update.download_url.clone()).timeout(Duration::from_secs(180))
        .header("Accept", "application/octet-stream").send().await
        .map_err(|_| "更新包下载失败，请检查网络后重试".to_string())?;
    if !response.status().is_success() { return Err(format!("更新包下载失败（HTTP {}）", response.status().as_u16())); }
    let total = response.content_length();
    if total.is_some_and(|size| size > MAX_DOWNLOAD) { return Err("更新包超过 256 MB 下载限制，已中止且未安装".into()); }
    let mut bytes = Vec::new();
    let mut last_progress = std::time::Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = response.chunk().await.map_err(|_| "更新下载中断，尚未安装，请重试".to_string())? {
        append_download(&mut bytes, &chunk, total)?;
        if last_progress.elapsed() >= Duration::from_millis(100) {
            emit(app, &update.version, "downloading", bytes.len() as u64, total);
            last_progress = std::time::Instant::now();
        }
    }
    if total.is_some_and(|size| size != bytes.len() as u64) { return Err("更新包下载不完整，尚未安装".into()); }
    emit(app, &update.version, "downloading", bytes.len() as u64, total);
    Ok(bytes)
}
fn verify_downloaded_signature(bytes: &[u8], signature: &str, public_key: &str, version: &str) -> Result<(), String> {
    let decode = |value: &str| -> Result<String, String> {
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value.trim()).map_err(|_| "更新签名格式无效".to_string())?)
            .map_err(|_| "更新签名格式无效".to_string())
    };
    let public = PublicKey::decode(&decode(public_key)?).map_err(|_| "更新验证公钥无效".to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|_| "更新签名无效，已拒绝安装".to_string())?;
    public.verify(bytes, &signature, true).map_err(|_| "更新内容或签名已被更改，已拒绝安装".to_string())?;
    // Only inspect trusted comment after the global signature is verified.
    let signed: Vec<_> = signature.trusted_comment().split('\t').filter_map(|field| field.strip_prefix("version:")).collect();
    if signed.len() != 1 || signed[0] != version { return Err("更新签名绑定的版本与发行信息不一致，已拒绝安装".into()); }
    Ok(())
}

#[tauri::command]
pub fn app_update_restart(app: AppHandle) -> Result<(), String> {
    if !INSTALLED.load(Ordering::Acquire) { return Err("此会话尚未成功安装更新".into()); }
    app.restart();
}

#[tauri::command]
pub fn app_update_open_release(url: String) -> Result<(), String> {
    let base = format!("https://github.com/{REPOSITORY}/releases");
    let trusted = url == base || url.strip_prefix(&format!("{base}/tag/gui-v"))
        .and_then(|version| Version::parse(version).ok().map(|parsed| version == parsed.to_string())).unwrap_or(false);
    if !trusted { return Err("发行页来源无效".into()); }
    let output = Command::new("/usr/bin/open").arg(&url).output().map_err(|_| "无法打开发行页".to_string())?;
    if !output.status.success() { return Err("无法打开发行页".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str) -> Release { Release { tag_name: tag.into(), name: None, body: None, published_at: None, draft: false, prerelease: false, assets: vec![] } }
    #[test]
    fn excludes_cli_tags_drafts_prereleases_and_sorts_semver() {
        let mut draft = release("gui-v99.0.0"); draft.draft = true;
        let releases = vec![release("V99.0.0"), release("gui-v0.9.0"), release("gui-v0.10.0"), release("gui-v1.0.0-beta.1"), draft];
        assert_eq!(newest_gui(&releases).unwrap().1, Version::parse("0.10.0").unwrap());
    }
    #[test]
    fn rejects_external_http_credential_and_nested_asset_sources() {
        for url in ["http://github.com/x", "https://evil.com/x", "https://github.com.evil.com/x", "https://user:secret@github.com/x", "https://github.com:443/x"] {
            // Explicit 443 normalizes away and is safe; all other forms rejected.
            if url != "https://github.com:443/x" { assert!(!trusted_redirect(&Url::parse(url).unwrap())); }
        }
        assert!(trusted_redirect(&Url::parse("https://release-assets.githubusercontent.com/x").unwrap()));
    }
    #[test]
    fn rejects_path_traversal_and_other_root_bundles() {
        for path in ["../CrownSweep.app/file", "/CrownSweep.app/file", "CrownSweep.app/../file", "Other.app/file"] { assert!(!safe_archive_path(Path::new(path))); }
        assert!(safe_archive_path(Path::new("CrownSweep.app/Contents/Info.plist")));
    }
    #[test]
    fn identity_requires_fixed_team_developer_id_runtime_timestamp() {
        let good = "Authority=Developer ID Application: Maintainer (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nCodeDirectory v=20400 flags=0x10000(runtime)\nTimestamp=Oct 3 2026\n";
        assert!(validate_identity(good, "ABCDEFGHIJ"));
        assert!(!validate_identity(good, "OTHERTEAM1"));
        assert!(!validate_identity(&good.replace("Developer ID Application", "Apple Development"), "ABCDEFGHIJ"));
        assert!(!validate_identity(&good.replace("Timestamp=Oct 3 2026", ""), "ABCDEFGHIJ"));
        assert!(!validate_identity(&good.replace("Timestamp=Oct 3 2026", "Timestamp=none"), "ABCDEFGHIJ"));
    }
    #[test]
    fn system_requirements_are_not_bypassed() {
        assert!(supports_system("12.0", "12.0.1"));
        assert!(supports_system("12.0", "15.7.1"));
        assert!(!supports_system("15.1", "15.0.9"));
        assert!(!supports_system("12.not-a-number", "15.0"));
    }
    #[test]
    fn manifest_binds_tag_version_asset_and_signed_version() {
        let mut r = release("gui-v0.4.0");
        let name = "CrownSweep-0.4.0-aarch64.app.tar.gz";
        let url = asset_url(&r.tag_name, name);
        r.assets.push(ReleaseAsset { name: name.into(), browser_download_url: url.clone() });
        let signature = base64::engine::general_purpose::STANDARD.encode("untrusted comment: signature\nabc\ntrusted comment: timestamp:1\tversion:0.4.0\nxyz\n");
        let mut manifest = Manifest { version: "0.4.0".into(), platforms: HashMap::from([("darwin-aarch64".into(), Artifact { url: url.clone(), signature })]) };
        assert_eq!(validate_manifest(&manifest, &r, &Version::parse("0.4.0").unwrap(), "darwin-aarch64").unwrap(), Some(url));
        assert_eq!(validate_manifest(&manifest, &r, &Version::parse("0.4.0").unwrap(), "darwin-x86_64").unwrap(), None);
        manifest.platforms.get_mut("darwin-aarch64").unwrap().url = "https://evil.com/archive".into();
        assert!(validate_manifest(&manifest, &r, &Version::parse("0.4.0").unwrap(), "darwin-aarch64").is_err());
    }
    #[test]
    fn rejects_symlinks_before_extracting_and_preserves_outside_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default()));
        let mut header = tar::Header::new_gnu(); header.set_entry_type(tar::EntryType::Symlink); header.set_size(0); header.set_mode(0o777);
        builder.append_link(&mut header, "CrownSweep.app/Contents/link", "../../../outside").unwrap();
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        assert!(extract_verified_archive(&bytes, directory.path()).is_err());
        assert!(!directory.path().join("CrownSweep.app/Contents/link").exists());
    }
    #[test]
    fn verifies_real_signature_and_rejects_tampered_content_version_and_key() {
        let payload = include_bytes!("../tests/fixtures/update-payload.txt");
        let signature = include_str!("../tests/fixtures/update-payload.txt.sig");
        let public = include_str!("../tests/fixtures/update-valid.pub");
        let wrong_public = include_str!("../tests/fixtures/update-wrong.pub");
        assert!(verify_downloaded_signature(payload, signature, public, "0.4.0").is_ok());
        assert!(verify_downloaded_signature(b"modified archive", signature, public, "0.4.0").is_err());
        assert!(verify_downloaded_signature(payload, signature, public, "0.5.0").is_err());
        assert!(verify_downloaded_signature(payload, signature, wrong_public, "0.4.0").is_err());
        let raw = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(signature.trim()).unwrap()).unwrap();
        let changed = base64::engine::general_purpose::STANDARD.encode(raw.replace("version:0.4.0", "version:0.5.0"));
        assert!(verify_downloaded_signature(payload, &changed, public, "0.5.0").is_err());
    }
    #[test]
    fn hard_download_limit_also_applies_without_a_content_length() {
        assert!(download_size_allowed(MAX_DOWNLOAD - 1, 1, None));
        assert!(!download_size_allowed(MAX_DOWNLOAD - 1, 2, None));
        assert!(!download_size_allowed(0, 1, Some(MAX_DOWNLOAD + 1)));
        assert!(!download_size_allowed(u64::MAX, 1, None));
        let mut bytes = Vec::new(); append_download(&mut bytes, b"fixture", None).unwrap();
        assert_eq!(bytes, b"fixture");
        assert!(append_download(&mut bytes, b"bad", Some(MAX_DOWNLOAD + 1)).is_err());
        assert_eq!(bytes, b"fixture");
    }
    #[test]
    fn native_metadata_output_has_a_hard_size_limit() {
        assert_eq!(bounded_tool_output(Cursor::new(b"small output")).unwrap(), b"small output");
        assert!(bounded_tool_output(Cursor::new(vec![0; MAX_TOOL_OUTPUT + 1])).is_err());
    }
    fn fixture_bundle(root: &Path, name: &str, version: &str) -> PathBuf {
        let bundle = root.join(name); fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        fs::write(bundle.join("Contents/Info.plist"), format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.ellaycrown.molegui</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>")).unwrap();
        fs::write(bundle.join("Contents/MacOS/mole-gui"), version).unwrap(); bundle
    }
    // Native signing is independently tested above. These transaction fixtures
    // substitute a fixed proof and perform real copies/renames in a temp folder.
    fn fixture_proof(bundle: &Path, version: &str, team: &str) -> Result<BundleProof, String> {
        let payload = fs::read_to_string(bundle.join("Contents/MacOS/mole-gui")).map_err(|_| "fixture incomplete".to_string())?;
        if payload != version { return Err("fixture version mismatch".into()); }
        Ok(BundleProof { identifier: bundle_identifier(bundle)?, version: version.into(), team: team.into(), code_hash: format!("fixture-proof-{version}") })
    }
    #[test]
    fn transaction_restores_original_after_failed_move_and_retains_backup() {
        let directory = tempfile::tempdir().unwrap();
        let target = fixture_bundle(directory.path(), "CrownSweep.app", "0.4.0");
        let proof = fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap();
        let mut transaction = InstallTransaction::prepare(target.clone(), proof.clone()).unwrap();
        fs::write(transaction.staged().join("Contents/MacOS/mole-gui"), "0.5.0").unwrap();
        let error = transaction.replace("0.5.0", &fixture_proof, |_source, _target| Err(std::io::Error::other("simulated move failure"))).unwrap_err();
        assert!(error.contains("原应用已恢复"));
        assert_eq!(fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap(), proof);
        assert!(transaction.original().exists()); assert!(transaction.root.join("marker.json").exists());
        assert!(transaction.root.exists());
    }
    #[test]
    fn transaction_retains_failed_copy_and_recovers_after_incomplete_install() {
        let directory = tempfile::tempdir().unwrap();
        let target = fixture_bundle(directory.path(), "CrownSweep.app", "0.4.0");
        let proof = fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap();
        let mut transaction = InstallTransaction::prepare(target.clone(), proof.clone()).unwrap();
        fs::write(transaction.staged().join("Contents/MacOS/mole-gui"), "0.5.0").unwrap();
        let error = transaction.replace("0.5.0", &fixture_proof, |source, target| {
            fs::rename(source, target)?; fs::remove_file(target.join("Contents/MacOS/mole-gui"))?; Ok(())
        }).unwrap_err();
        assert!(error.contains("原应用已恢复"));
        assert_eq!(fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap(), proof);
        assert!(transaction.root.join("failed.app").exists());
    }
    #[test]
    fn transaction_success_keeps_backup_until_next_launch_and_skips_unknown_dirs() {
        let directory = tempfile::tempdir().unwrap();
        let target = fixture_bundle(directory.path(), "CrownSweep.app", "0.4.0");
        let proof = fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap();
        let mut transaction = InstallTransaction::prepare(target.clone(), proof).unwrap();
        fs::write(transaction.staged().join("Contents/MacOS/mole-gui"), "0.5.0").unwrap();
        transaction.replace("0.5.0", &fixture_proof, |source, target| fs::rename(source, target)).unwrap();
        assert!(transaction.root.exists()); assert!(transaction.retired().exists());
        let unknown = directory.path().join(".crownsweep-update-unrelated"); fs::create_dir(&unknown).unwrap(); fs::write(unknown.join("keep"), "user file").unwrap();
        let current = fixture_proof(&target, "0.5.0", "ABCDEFGHIJ").unwrap();
        cleanup_backups_at(&target, &current, fixture_proof).unwrap();
        assert!(!transaction.root.exists()); assert!(target.exists()); assert!(unknown.join("keep").exists());
    }
    #[test]
    fn transaction_refuses_read_only_parent_without_touching_app() {
        let directory = tempfile::tempdir().unwrap();
        let target = fixture_bundle(directory.path(), "CrownSweep.app", "0.4.0");
        let proof = fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o500)).unwrap();
        assert!(InstallTransaction::prepare(target.clone(), proof.clone()).is_err());
        assert_eq!(fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap(), proof);
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[test]
    fn transaction_never_overwrites_another_app_when_restore_is_blocked() {
        let directory = tempfile::tempdir().unwrap();
        let target = fixture_bundle(directory.path(), "CrownSweep.app", "0.4.0");
        let proof = fixture_proof(&target, "0.4.0", "ABCDEFGHIJ").unwrap();
        let mut transaction = InstallTransaction::prepare(target.clone(), proof).unwrap();
        fs::write(transaction.staged().join("Contents/MacOS/mole-gui"), "0.5.0").unwrap();
        let error = transaction.replace("0.5.0", &fixture_proof, |_source, target| {
            let other = fixture_bundle(target.parent().unwrap(), target.file_name().unwrap().to_str().unwrap(), "unrelated");
            let plist = other.join("Contents/Info.plist"); let contents = fs::read_to_string(&plist)?;
            fs::write(&plist, contents.replace("com.ellaycrown.molegui", "another.application"))?;
            Err(std::io::Error::other("simulated concurrent target replacement"))
        }).unwrap_err();
        assert!(error.contains("请从恢复备份")); assert!(error.contains(&transaction.root.display().to_string()));
        assert_eq!(bundle_identifier(&target).unwrap(), "another.application");
        assert!(transaction.retired().exists());
    }
    #[test]
    fn bare_executable_and_symbolic_bundle_do_not_become_install_targets() {
        let directory = tempfile::tempdir().unwrap();
        assert!(actual_bundle(&directory.path().join("mole-gui")).is_err());
        let real = fixture_bundle(directory.path(), "CrownSweep.app", "0.4.0");
        let link = directory.path().join("Linked.app"); std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(actual_bundle(&link.join("Contents/MacOS/mole-gui")).is_err());
    }
}
