#!/usr/bin/env python3
"""Generate distributable notices from the checked-in dependency lockfiles.

Run after `npm ci` and `cargo fetch --locked --target aarch64-apple-darwin`.
Only the notices and files under licenses/ are written. Dependency caches are
read; public upstream license files are downloaded only when their crate
archives omit them. No credentials or machine paths are included in outputs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "licenses"
SMC_COMMIT = "e1bd672bcd2d72eddff9b6da7b9cae38e35c4206"
FEATHER_COMMIT = "3dc050d97405062eba78aa57115c0a15c63abdaa"
LUCIDE_COMMIT = "3efde520fcce0716ceb861fcc82adbb43adf36d5"
COPY_NAMES = ("license", "licence", "copying", "notice", "copyright")
MPL_CRATES = {"cssparser", "cssparser-macros", "dtoa-short", "option-ext", "selectors"}
FETCH_CACHE: dict[str, bytes] = {}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str) -> bytes:
    if url not in FETCH_CACHE:
        req = urllib.request.Request(url, headers={"User-Agent": "CrownSweep-license-notices/1"})
        with urllib.request.urlopen(req, timeout=30) as response:
            FETCH_CACHE[url] = response.read()
    return FETCH_CACHE[url]


def license_files(base: pathlib.Path) -> list[pathlib.Path]:
    # Include source-package license/notice files, but not tests named copying.rs.
    return sorted(
        p for p in base.rglob("*")
        if p.is_file()
        and p.name.lower().startswith(COPY_NAMES)
        and p.suffix.lower() not in (".rs", ".c", ".h", ".cpp", ".py", ".js", ".ts")
        and len(p.relative_to(base).parts) <= 4
    )


def store_text(data: bytes, label: str, source: str, texts: dict) -> str:
    sha = digest(data)
    key = sha[:16]
    path = OUT / "texts" / (sha + ".txt")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if key not in texts:
        texts[key] = {"sha256": sha, "file": "texts/" + path.name,
                      "text": data.decode("utf-8", errors="replace"), "sources": []}
    notice = {"label": label, "source": source}
    if notice not in texts[key]["sources"]:
        texts[key]["sources"].append(notice)
    return key


def github_license_overrides(package: dict, base: pathlib.Path) -> list[tuple[bytes, str, str]]:
    vcs_path = base / ".cargo_vcs_info.json"
    if not vcs_path.exists():
        raise RuntimeError("No source commit for missing license: " + package["name"])
    vcs = json.loads(vcs_path.read_text())
    sha = vcs["git"]["sha1"]
    repo = (package.get("repository") or "").removesuffix(".git").rstrip("/")
    names = {
        "https://github.com/dropbox/rust-alloc-no-stdlib": ["LICENSE"],
        "https://github.com/madsmtm/objc2": ["LICENSE.md"],
        "https://github.com/knurling-rs/defmt": ["LICENSE-MIT", "LICENSE-APACHE"],
        "https://github.com/tauri-apps/tauri": ["LICENSE-MIT", "LICENSE-APACHE-2.0"],
        "https://github.com/tauri-apps/plugins-workspace": ["LICENSE_MIT", "LICENSE_APACHE-2.0"],
    }.get(repo)
    if not names:
        raise RuntimeError("Unreviewed package with no license file: " + package["name"])
    results = []
    for name in names:
        url = repo.replace("https://github.com/", "https://raw.githubusercontent.com/") + "/" + sha + "/" + name
        results.append((fetch(url), name, url))
    return results


def source_headers(base: pathlib.Path) -> bytes:
    # Preserve actual MPL file notices for crates that omit a license document.
    headers = []
    for p in sorted(base.rglob("*.rs")):
        lines = p.read_text(errors="replace").splitlines()
        prefix = []
        for line in lines[:25]:
            if line.strip().startswith(("//", "/*", "*", "*/")) or not line.strip():
                prefix.append(line)
            else:
                break
        text = "\n".join(prefix).strip()
        if re.search(r"Mozilla Public[\s*]+License", text):
            headers.append(str(p.relative_to(base)) + "\n" + text)
    if not headers:
        raise RuntimeError("Missing actual MPL source notices")
    return ("MPL notices preserved from the published crate source:\n\n" + "\n\n".join(headers) + "\n").encode()


def rust_inventory(target: str, texts: dict) -> list[dict]:
    raw = subprocess.check_output([
        "cargo", "metadata", "--format-version", "1", "--locked", "--offline",
        "--filter-platform", target,
    ], cwd=ROOT / "src-tauri", stderr=subprocess.PIPE)
    packages = json.loads(raw)["packages"]
    external = sorted((p for p in packages if p.get("source")), key=lambda p: (p["name"], p["version"]))
    mpl_base = next(pathlib.Path(p["manifest_path"]).parent for p in external if p["name"] == "cssparser")
    mpl_document = (mpl_base / "LICENSE").read_bytes()
    result = []
    for package in external:
        name, version = package["name"], package["version"]
        license_id = package.get("license")
        if not license_id:
            raise RuntimeError("Missing declared license: " + name)
        base = pathlib.Path(package["manifest_path"]).parent
        source = "https://crates.io/api/v1/crates/" + name + "/" + version + "/download"
        keys = []
        files = license_files(base)
        for f in files:
            relative = str(f.relative_to(base))
            keys.append(store_text(f.read_bytes(), name + " " + version + ": " + relative,
                                   source + " (archive entry: " + relative + ")", texts))
        if not files and name == "selectors":
            keys.append(store_text(mpl_document, name + " " + version + ": MPL-2.0",
                                   "https://www.mozilla.org/en-US/MPL/2.0/", texts))
            keys.append(store_text(source_headers(base), name + " " + version + ": source notices", source, texts))
        elif not files:
            for data, filename, url in github_license_overrides(package, base):
                keys.append(store_text(data, name + " " + version + ": " + filename, url, texts))
        if name in MPL_CRATES:
            # An Exhibit B in the full license is not a mark attached to a file.
            for f in base.rglob("*.rs"):
                s = f.read_text(errors="replace")
                if re.search(r"This Source Code Form is [\s/\*]*[\"“]?Incompatible With Secondary Licenses", s, re.I):
                    raise RuntimeError("MPL secondary-license restriction requires review: " + name)
        result.append({"ecosystem": "rust", "name": name, "version": version,
                       "license": license_id, "source": source,
                       "repository": package.get("repository"), "authors": package.get("authors", []),
                       "license_texts": list(dict.fromkeys(keys))})
    return result


def node_inventory(texts: dict) -> list[dict]:
    lock = json.loads((ROOT / "package-lock.json").read_text())
    result = []
    for key, package in sorted(lock["packages"].items()):
        if not key or package.get("dev"):
            continue
        base = ROOT / key
        manifest = json.loads((base / "package.json").read_text())
        if manifest["version"] != package["version"]:
            raise RuntimeError("Run npm ci; installed version differs from lockfile")
        name, version = manifest["name"], package["version"]
        license_id = manifest.get("license", package.get("license"))
        if not isinstance(license_id, str) or license_id == "UNKNOWN":
            raise RuntimeError("Missing or unreviewed declared Node license: " + name)
        source = package.get("resolved", "https://www.npmjs.com/package/" + name + "/v/" + version)
        if not source.startswith(("https://registry.npmjs.org/", "https://www.npmjs.com/")):
            raise RuntimeError("Nonpublic dependency source requires review: " + name)
        files = license_files(base)
        if not files:
            raise RuntimeError("No license text in Node package: " + name)
        keys = [store_text(f.read_bytes(), name + " " + version + ": " + str(f.relative_to(base)),
                           source + " (archive entry: " + str(f.relative_to(base)) + ")", texts) for f in files]
        repository = manifest.get("repository")
        if isinstance(repository, dict):
            repository = repository.get("url")
        result.append({"ecosystem": "node", "name": name, "version": version,
                       "license": license_id,
                       "source": source, "repository": repository,
                       "integrity": package.get("integrity"), "license_texts": list(dict.fromkeys(keys))})
    return result


def markdown(packages: list[dict], texts: dict, target: str) -> str:
    intro = """# CrownSweep third-party notices

GUI integration and packaging were added on 2026-10-02. CrownSweep is an
unofficial GUI companion to tw93/Mole. It is not affiliated with, endorsed by,
or an official release of Mole. Names identify their respective projects;
this document does not grant trademark rights.

The GUI is distributed under GPL-3.0. The full, unchanged license is in
`LICENSE`; dependency licenses and copyright notices are retained under
`licenses/`, and combined in `licenses/THIRD_PARTY_LICENSES.txt`. Each original
component remains subject to its applicable license. Copyrights are not
reassigned by this document. The software is provided without warranty; see
the individual license texts.

## Mole engine

Source: <https://github.com/tw93/Mole>. License: GPL-3.0.
The GUI invokes a separately installed engine; the engine is not copied into
the GUI App bundle. A fork must retain the upstream license and notices.
GUI changes are identified separately from upstream code.

## SMC command helper

Source: <https://github.com/hholtmann/smcFanControl/tree/e1bd672bcd2d72eddff9b6da7b9cae38e35c4206/smc-command>.
Copyright (C) 2006 devnull; portions Copyright (C) 2013 Michael Wilber.
Original license: GPL-2.0-or-later; the distributed combination uses GPLv3,
which is one of the versions permitted by that grant.

`src-tauri/smc-helper/smc.c` and `smc.h` are unmodified copies at the fixed
commit above. `src-tauri/build.rs` compiles the helper, and the GUI sensor
adapter/package integration was added on 2026-10-02. The C/H source headers,
copyrights and warranty disclaimer are retained.

- smc.c SHA-256: `13c0336cc51045de9f095d2e38bce6dc36dcccd145b3ff450b9c309768dbcf23`
- smc.h SHA-256: `eda500485ba3663b8597acf88a09c9aa02fd2ed876bb4076ac776425ee8b5244`

## Artwork and stroke icons

The App artwork master `app-icon.png` was generated for this project with
imagegen. It is not the upstream Mole logo. Platform icons are generated from
that master by `scripts/gen_icon.py`.

The hand-written stroke icons describe themselves as Feather/Lucide style.
Their shapes have not been proven wholly independent of those projects, so
the original Feather MIT and Lucide ISC/MIT notices are conservatively
retained for any derived portions:

- Feather: <https://github.com/feathericons/feather/tree/3dc050d97405062eba78aa57115c0a15c63abdaa>.
- Lucide: <https://github.com/lucide-icons/lucide/tree/3efde520fcce0716ceb861fcc82adbb43adf36d5>.

## Audit scope and license compatibility

This is a source and lockfile audit, not a guarantee about every legal risk.
Within the inspected versions, no evident license incompatibility with
GPLv3 was found. MIT, Apache-2.0, BSD, Zlib and Unicode notices must still be
retained where their grants require it. Dual-license expressions below are
the upstream declarations; they are not a replacement license imposed by us.

The MPL-2.0 packages are cssparser, cssparser-macros, dtoa-short, option-ext,
and selectors. Their original MPL notices and source download links are
retained. No actual source-file notice marking these inspected versions
"Incompatible With Secondary Licenses" was found. The Exhibit B sample in
the full MPL license is not itself such a mark. MPL section 3.3 permits a
GPL larger work when its conditions hold; downstream MPL source rights must
remain available. Do not claim every MPL package is automatically GPL
compatible or remove its notices. See the
[MPL text](https://www.mozilla.org/en-US/MPL/2.0/) and
[Mozilla FAQ, questions 14 and 25](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

For public binary releases, provide the corresponding tagged GUI/helper
source and build/install scripts alongside the binary download, with clear
directions for obtaining all required dependency source. Each dependency
has an exact source archive link below. Keep those sources accessible for
the distribution obligations; a moving upstream branch is not a substitute
for the version corresponding to a released binary.

## Locked dependency inventory

Generated by `python3 scripts/generate_third_party_notices.py`. Node entries
are production dependencies from `package-lock.json`; development-only Node
tools are not part of this App inventory. Rust entries are the Cargo graph
resolved for TARGET, including build-time dependencies. This is a conservative
superset of the crates linked into the executable. System libraries supplied
by macOS, such as IOKit, are not redistributed by this repository.

Re-run after a lockfile or target change. License copies are deduplicated by
their SHA-256; package-to-text mappings and source references are in
`licenses/dependency-inventory.json`. Exact upstream source links below also
identify packages that do not ship a license document in their crate archive;
their license document was obtained from the fixed source commit recorded in
that package's `.cargo_vcs_info.json`, or their original MPL header plus the
full MPL-2.0 text was retained.

| Ecosystem | Package | Version | Declared license | Corresponding source | License copies |
| --- | --- | --- | --- | --- | --- |
""".replace("TARGET", "`" + target + "`")
    rows = []
    for p in packages:
        links = ", ".join("[" + k + "](licenses/" + texts[k]["file"] + ")" for k in p["license_texts"])
        rows.append("| " + " | ".join([p["ecosystem"], p["name"], p["version"], p["license"],
                                      "[source](" + p["source"] + ")", links]) + " |")
    return intro + "\n".join(rows) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="aarch64-apple-darwin")
    args = parser.parse_args()
    if args.target not in ("aarch64-apple-darwin", "x86_64-apple-darwin"):
        parser.error("Only reviewed macOS targets are supported")
    OUT.mkdir(exist_ok=True)
    texts: dict = {}
    own_gpl = store_text((ROOT / "LICENSE").read_bytes(), "CrownSweep and Mole: GPL-3.0",
                         "https://github.com/tw93/Mole/blob/main/LICENSE", texts)
    smc_base = "https://raw.githubusercontent.com/hholtmann/smcFanControl/" + SMC_COMMIT + "/smc-command/"
    for name, sha in [("smc.c", "13c0336cc51045de9f095d2e38bce6dc36dcccd145b3ff450b9c309768dbcf23"),
                      ("smc.h", "eda500485ba3663b8597acf88a09c9aa02fd2ed876bb4076ac776425ee8b5244")]:
        data = (ROOT / "src-tauri" / "smc-helper" / name).read_bytes()
        if digest(data) != sha:
            raise RuntimeError("SMC source changed; update its provenance and notices before publishing")
        header = data.split(b"*/", 1)[0] + b"*/\n"
        store_text(header, "smcFanControl smc-command: " + name + " source notice", smc_base + name, texts)
    for project, commit in [("feathericons/feather", FEATHER_COMMIT), ("lucide-icons/lucide", LUCIDE_COMMIT)]:
        url = "https://raw.githubusercontent.com/" + project + "/" + commit + "/LICENSE"
        store_text(fetch(url), project + ": LICENSE", url, texts)
    packages = node_inventory(texts) + rust_inventory(args.target, texts)
    notice = markdown(packages, texts, args.target)
    (ROOT / "THIRD_PARTY_NOTICES.md").write_text(notice)
    inventory = {"format_version": 1, "target": args.target, "project_license": "GPL-3.0",
                 "smc_commit": SMC_COMMIT, "packages": packages,
                 "license_texts": {k: {a: b for a, b in v.items() if a != "text"} for k, v in sorted(texts.items())}}
    (OUT / "dependency-inventory.json").write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n")
    full = ["CrownSweep — license texts and third-party copyright notices\n",
            "Generated from dependency lockfiles. See THIRD_PARTY_NOTICES.md for audit scope and source links.\n"]
    order = [own_gpl] + sorted(k for k in texts if k != own_gpl)
    for k in order:
        item = texts[k]
        full.append("\n" + "=" * 78 + "\nSHA-256: " + item["sha256"] + "\n")
        for source in item["sources"]:
            full.append(source["label"] + "\nSource: " + source["source"] + "\n")
        full.append("\n" + item["text"] + ("" if item["text"].endswith("\n") else "\n"))
    (OUT / "THIRD_PARTY_LICENSES.txt").write_text("".join(full))
    used = {v["file"] for v in texts.values()}
    for f in (OUT / "texts").glob("*.txt"):
        if "texts/" + f.name not in used:
            f.unlink()
    print("Generated notices for", len(packages), "dependencies and", len(texts), "unique notice texts.")


if __name__ == "__main__":
    main()
