#!/usr/bin/env python3
"""Sign the configured macOS App with Developer ID, inside out.

CROWNSWEEP_SIGNING_IDENTITY must be an exact Developer ID Application name or
certificate SHA-1. MOLE_SIGNING_IDENTITY remains an alias for older local setup.
--dry-run prints the plan without invoking tools, changing files or the keychain;
it does not verify that the certificate exists. Notarization is a separate step.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
MACHO_MAGIC = {bytes.fromhex(value) for value in (
    'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
    'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
)}


class ReleaseError(Exception):
    pass


def config(root=ROOT):
    data = json.loads((root / 'src-tauri/tauri.conf.json').read_text())
    product = data.get('productName', '')
    if not product or '/' in product or '\\' in product or product in ('.', '..'):
        raise ReleaseError('tauri.conf.json must contain a safe productName.')
    return data


def default_app(root=ROOT):
    return root / 'src-tauri/target/release/bundle/macos' / f"{config(root)['productName']}.app"


def signing_identity(environ=None):
    environ = os.environ if environ is None else environ
    identity = (environ.get('CROWNSWEEP_SIGNING_IDENTITY') or environ.get('MOLE_SIGNING_IDENTITY', '')).strip()
    if not identity or identity == '-':
        raise ReleaseError('Set CROWNSWEEP_SIGNING_IDENTITY to a Developer ID Application certificate. Ad-hoc signing is refused.')
    if not identity.startswith('Developer ID Application: ') and not re.fullmatch(r'[a-fA-F0-9]{40}', identity):
        raise ReleaseError('Use an exact Developer ID Application certificate name or its SHA-1.')
    return identity


def select_identity(identity, available):
    identities = re.findall(r'\)\s+([A-Fa-f0-9]{40})\s+"([^\"]+)"', available)
    matches = [(sha, name) for sha, name in identities if identity.lower() == sha.lower() or identity == name]
    if len(matches) != 1 or not matches[0][1].startswith('Developer ID Application: '):
        raise ReleaseError('The identity must match exactly one valid Developer ID Application certificate. Check security find-identity -v -p codesigning.')
    return matches[0][0]


def run(command, timeout=120, check=True):
    # Never include argument values or captured tool output in error messages.
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ReleaseError(f'{Path(command[0]).name} could not finish; check that Xcode command line tools are installed.') from error
    if check and result.returncode:
        raise ReleaseError(f'{Path(command[0]).name} failed (exit {result.returncode}). Inspect the release locally; no credentials were printed.')
    return result


def is_macho(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open('rb') as handle:
        return handle.read(4) in MACHO_MAGIC


def nested_code(app):
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    executable = info.get('CFBundleExecutable')
    if not executable or Path(executable).name != executable:
        raise ReleaseError('App Info.plist has no valid CFBundleExecutable.')
    main = app / 'Contents/MacOS' / executable
    if not is_macho(main):
        raise ReleaseError('App main executable is missing or is not Mach-O.')
    paths = list((app / 'Contents').rglob('*'))
    binaries = [path for path in paths if path != main and is_macho(path)]
    bundles = [path for path in paths if path.is_dir() and not path.is_symlink()
               and path.suffix in ('.app', '.framework', '.xpc', '.appex')]
    # Sign files first, then enclosing bundles from the deepest level outward.
    return sorted(binaries, key=lambda p: (-len(p.parts), str(p))) + sorted(bundles, key=lambda p: (-len(p.parts), str(p)))


def validate_sidecars(app, data):
    for sidecar in data.get('bundle', {}).get('externalBin', []):
        path = app / 'Contents/MacOS' / Path(sidecar).name
        if not is_macho(path):
            raise ReleaseError(f'Configured sidecar {Path(sidecar).name} is missing or is not Mach-O.')


def signature_commands(app, identity, nested):
    commands = []
    for path in [*nested, app]:
        commands.append(['codesign', '--force', '--sign', identity, '--options', 'runtime', '--timestamp', str(path)])
        commands.append(['codesign', '--verify', '--strict', str(path)])
    commands.append(['codesign', '--verify', '--deep', '--strict', str(app)])
    return commands


def verify_release(app):
    nested = nested_code(app)
    run(['codesign', '--verify', '--deep', '--strict', str(app)])
    for path in [*(p for p in nested if p.is_file()), app]:
        result = run(['codesign', '--display', '--verbose=4', str(path)])
        metadata = result.stdout + result.stderr
        if ('Authority=Developer ID Application: ' not in metadata
                or not re.search(r'^CodeDirectory .*flags=.*\bruntime\b', metadata, re.MULTILINE)
                or not re.search(r'^Timestamp=.+', metadata, re.MULTILINE)):
            raise ReleaseError('Every executable must have Developer ID, hardened runtime and a secure timestamp before notarization.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, help='App path; defaults to tauri.conf.json productName')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        app = (args.app or default_app()).resolve()
        if app.suffix != '.app':
            raise ReleaseError('--app must point to an .app bundle.')
        identity = signing_identity()
        if app.is_dir():
            validate_sidecars(app, config())
            nested = nested_code(app)
        elif args.dry_run:
            nested = [app / 'Contents/MacOS' / Path(sidecar).name for sidecar in config().get('bundle', {}).get('externalBin', [])]
        else:
            raise ReleaseError('Build the App first: npm run tauri -- build --bundles app')
        if args.dry_run:
            for command in signature_commands(app, '<Developer ID Application certificate>', nested):
                print(' '.join(command))
            print('Dry run only: certificate presence, bundle contents and signatures are not verified.')
            return 0
        selected = select_identity(identity, run(['security', 'find-identity', '-v', '-p', 'codesigning']).stdout)
        for command in signature_commands(app, selected, nested):
            run(command)
        verify_release(app)
        print(f'Developer ID signatures verified: {app.name}. Run notarize_release.py before distribution.')
        return 0
    except (ReleaseError, OSError, ValueError, plistlib.InvalidFileException) as error:
        print(str(error) if isinstance(error, ReleaseError) else 'Release configuration or bundle could not be read.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
