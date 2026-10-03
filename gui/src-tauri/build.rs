use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // Compile the SMC helper (GPL-2+, from smcFanControl's smc-command) FIRST —
    // tauri_build below validates the externalBin sidecar path. The helper lets
    // the dashboard read Apple Silicon temperature/fan sensors that the mole
    // engine cannot see. Read-only; it never writes SMC keys.
    let target = env::var("TARGET").expect("Cargo must supply TARGET");
    if target.ends_with("-apple-darwin") {
        let arch = match target.as_str() {
            "aarch64-apple-darwin" => "arm64",
            "x86_64-apple-darwin" => "x86_64",
            _ => panic!("unsupported macOS SMC helper target: {target}"),
        };
        let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
        let src = PathBuf::from(&manifest).join("smc-helper/smc.c");
        let out = env::var("OUT_DIR").unwrap();
        let helper = PathBuf::from(&out).join("mole-smc");
        let status = Command::new("clang")
            .args(["-O2", "-DCMD_TOOL_BUILD", "-Wno-deprecated-declarations"])
            .args(["-arch", arch])
            .arg(&src)
            .args(["-framework", "IOKit", "-framework", "CoreFoundation"])
            .arg("-o")
            .arg(&helper)
            .status()
            .expect("clang (from Command Line Tools) to be available");
        assert!(status.success(), "failed to compile the SMC helper");

        // Copy only when contents differ: tauri dev watches the sidecar file
        // and unconditionally rewriting it (mtime churn) triggers an endless
        // rebuild loop.
        let copy_if_changed = |src: &Path, dst: &Path| {
            let contents = std::fs::read(src).expect("compiled SMC helper must be readable");
            if std::fs::read(dst).is_ok_and(|existing| existing == contents) {
                return;
            }
            std::fs::copy(src, dst)
                .unwrap_or_else(|error| panic!("cannot copy SMC helper to {}: {error}", dst.display()));
        };

        // Sidecar location for bundling: src-tauri/binaries/mole-smc-<triple>.
        let bindir = PathBuf::from(&manifest).join("binaries");
        std::fs::create_dir_all(&bindir).expect("cannot create SMC sidecar directory");
        copy_if_changed(&helper, &bindir.join(format!("mole-smc-{target}")));

        // Dev runs: next to the dev binary (target/debug/mole-smc).
        let profile_dir = PathBuf::from(&out)
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .expect("Cargo OUT_DIR must be inside <profile>/build/<package>/out")
            .to_path_buf();
        copy_if_changed(&helper, &profile_dir.join("mole-smc"));

        println!("cargo:rerun-if-changed=smc-helper/smc.c");
        println!("cargo:rerun-if-changed=smc-helper/smc.h");
        println!("cargo:rerun-if-env-changed=MACOSX_DEPLOYMENT_TARGET");
    }

    tauri_build::build();
}
