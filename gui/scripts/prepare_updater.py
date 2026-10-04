#!/usr/bin/env python3
"""Prepare signed Tauri updater assets from an already notarized CrownSweep App.

This does not sign the macOS App, upload assets, install an update, or alter any
Keychain. Configure the fixed publisherTeamId once the Developer ID is ready.
The updater signing key is a separate local secret; only its public key belongs
in tauri.conf.json. Both architecture assets can be accumulated in one manifest.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile
import shutil

from sign_release import ROOT, ReleaseError, config, default_app, nested_code, run, verify_release


def publisher_team(root=ROOT):
    value = json.loads((root / 'src-tauri/update-policy.json').read_text()).get('publisherTeamId')
    if not isinstance(value, str) or not re.fullmatch(r'[A-Z0-9]{10}', value):
        raise ReleaseError('Configure the fixed publisherTeamId in src-tauri/update-policy.json after obtaining Developer ID. No updater package was created.')
    return value


def inspect_app(app, version, arch, team):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    if (info.get('CFBundleIdentifier') != 'com.ellaycrown.molegui'
            or info.get('CFBundleShortVersionString') != version
            or info.get('CFBundleExecutable') != 'mole-gui'):
        raise ReleaseError('App identifier, executable or version does not match the configured release.')
    if app.name != 'CrownSweep.app':
        raise ReleaseError('Updater bundles must use the CrownSweep.app root name.')
    verify_release(app)
    for code in [app, *(p for p in nested_code(app) if p.is_file()), app / 'Contents/MacOS/mole-gui']:
        metadata = run(['codesign', '--display', '--verbose=4', str(code)])
        if f'TeamIdentifier={team}' not in (metadata.stdout + metadata.stderr).splitlines():
            raise ReleaseError('App and helper must use the fixed publisher Developer ID Team ID.')
    for executable in ['mole-gui', 'mole-smc']:
        architectures = run(['lipo', '-archs', str(app / 'Contents/MacOS' / executable)]).stdout.split()
        if ('arm64' if arch == 'aarch64' else 'x86_64') not in architectures:
            raise ReleaseError('App or helper architecture does not match the updater target.')
    run(['xcrun', 'stapler', 'validate', str(app)])
    run(['spctl', '--assess', '--type', 'execute', str(app)])
    if any(path.is_symlink() for path in app.rglob('*')):
        raise ReleaseError('This updater archive format does not allow bundle symlinks.')


def release_url(version, filename):
    return f'https://github.com/ywjzywn-coder/CrownSweep/releases/download/gui-v{version}/{filename}'


def read_signature(path, version):
    signature = path.read_text().strip()
    try:
        decoded = base64.b64decode(signature, validate=True).decode()
    except (ValueError, UnicodeDecodeError) as error:
        raise ReleaseError('Tauri produced an invalid update signature.') from error
    if not any(line.startswith('trusted comment:') and f'version:{version}' in line.split('\t') for line in decoded.splitlines()):
        raise ReleaseError('Updater signature must bind the App version; use a Tauri CLI with --app-version support.')
    return signature


def update_manifest(path, version, arch, artifact, signature, notes):
    data = {'version': version, 'notes': notes, 'pub_date': datetime.now(timezone.utc).isoformat(), 'platforms': {}}
    if path.exists():
        existing = json.loads(path.read_text())
        if existing.get('version') != version:
            raise ReleaseError('Output folder contains another version; use a separate output directory.')
        data.update(existing)
        if not isinstance(data.get('platforms'), dict):
            raise ReleaseError('Existing updater manifest platforms are invalid.')
        if notes:
            data['notes'] = notes
    data['platforms'][f'darwin-{arch}'] = {'url': release_url(version, artifact.name), 'signature': signature}
    for platform, entry in data['platforms'].items():
        if platform not in ('darwin-aarch64', 'darwin-x86_64'):
            raise ReleaseError('Existing manifest contains an unsupported platform.')
        filename = f"CrownSweep-{version}-{platform.removeprefix('darwin-')}.app.tar.gz"
        if entry.get('url') != release_url(version, filename):
            raise ReleaseError('Existing manifest points outside this CrownSweep GUI release.')
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.replace(path)


def sign_artifact(artifact, key_path, version):
    # The CLI may print the signature; never forward captured output or secrets.
    environment = os.environ.copy()
    environment.setdefault('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '')
    try:
        result = subprocess.run(['npm', 'run', 'tauri', 'signer', 'sign', '--',
                                 '--private-key-path', str(key_path), '--app-version', version, str(artifact)],
                                cwd=ROOT, env=environment, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ReleaseError('Updater signing could not finish; no captured output or credentials were printed.') from error
    if result.returncode:
        raise ReleaseError('Updater signing failed; check the local key and Tauri CLI. No captured output or credentials were printed.')


def matching_public_key(key_path, data):
    public_path = key_path.with_suffix(key_path.suffix + '.pub')
    expected = data.get('plugins', {}).get('updater', {}).get('pubkey')
    if not expected or not public_path.is_file() or public_path.read_text().strip() != expected:
        raise ReleaseError('The local updater key public file must match the embedded updater pubkey. Do not rotate the installed app key silently.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path)
    parser.add_argument('--arch', choices=['aarch64', 'x86_64'], required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--private-key-path', type=Path, default=Path.home() / '.local/share/crownsweep/release-keys/updater.key')
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        data = config()
        version = data['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+', version):
            raise ReleaseError('Updater publishing requires a stable semantic version.')
        team = publisher_team()
        app = (args.app or default_app()).resolve()
        if args.dry_run:
            print(f'Plan: verify fixed Developer ID, bundle version/architecture, stapled notarization and Gatekeeper for {app.name}; archive and sign darwin-{args.arch}; write crownsweep-update.json.')
            print('Dry run only: no certificate, App, signature or notarization is verified; no files were created.')
            return 0
        key = args.private_key_path.expanduser().resolve()
        if not key.is_file() or key.stat().st_mode & 0o077:
            raise ReleaseError('Updater private key must exist locally and be readable only by its owner (mode 600).')
        matching_public_key(key, data)
        inspect_app(app, version, args.arch, team)
        output = args.output_dir.resolve()
        manifest = output / 'crownsweep-update.json'
        if manifest.exists() and json.loads(manifest.read_text()).get('version') != version:
            raise ReleaseError('Output folder belongs to another version; use a separate output directory.')
        output.mkdir(parents=True, exist_ok=True)
        artifact = output / f'CrownSweep-{version}-{args.arch}.app.tar.gz'
        if artifact.exists() or artifact.with_suffix(artifact.suffix + '.sig').exists():
            raise ReleaseError('Updater artifact already exists; never overwrite a published signed artifact.')
        # A failed signer leaves no final artifact and can be retried. Staging
        # stays on the output filesystem; hard links publish without overwriting.
        with tempfile.TemporaryDirectory(prefix='.crownsweep-updater-build-', dir=output) as working:
            staging = Path(working)
            staged_artifact = staging / artifact.name
            with tarfile.open(staged_artifact, 'w:gz', format=tarfile.USTAR_FORMAT) as archive:
                archive.add(app, arcname=app.name, recursive=True)
            sign_artifact(staged_artifact, key, version)
            staged_signature = staged_artifact.with_suffix(staged_artifact.suffix + '.sig')
            signature = read_signature(staged_signature, version)
            staged_manifest = staging / manifest.name
            if manifest.exists():
                shutil.copyfile(manifest, staged_manifest)
            notes = args.notes_file.read_text() if args.notes_file else ''
            update_manifest(staged_manifest, version, args.arch, artifact, signature, notes)
            final_signature = artifact.with_suffix(artifact.suffix + '.sig')
            os.link(staged_artifact, artifact)
            try:
                os.link(staged_signature, final_signature)
                staged_manifest.replace(manifest)
            except OSError:
                # Only remove files still proven to be our new staging inodes.
                if artifact.exists() and os.path.samefile(artifact, staged_artifact):
                    artifact.unlink()
                if final_signature.exists() and os.path.samefile(final_signature, staged_signature):
                    final_signature.unlink()
                raise
        checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
        print(f'Prepared {artifact.name}\nSHA-256 {checksum}\nUpload the archive, its .sig and crownsweep-update.json to the matching immutable GUI release after review. Nothing was uploaded or installed.')
        return 0
    except (ReleaseError, OSError, ValueError, KeyError, plistlib.InvalidFileException) as error:
        print(str(error) if isinstance(error, ReleaseError) else 'Updater configuration or App could not be read.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
