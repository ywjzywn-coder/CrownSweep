#!/usr/bin/env python3
"""Notarize a Developer ID App, staple its ticket, then create its release ZIP.

Use an existing CROWNSWEEP_NOTARY_PROFILE in the keychain, or configure
CROWNSWEEP_NOTARY_KEY_PATH and CROWNSWEEP_NOTARY_KEY_ID for an App Store Connect
API key. CROWNSWEEP_NOTARY_ISSUER is required for team keys; omit it for individual
keys. This script never imports certificates or stores keychain credentials.
--dry-run invokes no tools, writes no files and redacts authentication arguments.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from sign_release import ReleaseError, config, default_app, run, verify_release


def auth_args(environ=None, check_file=True):
    environ = os.environ if environ is None else environ
    profile = environ.get('CROWNSWEEP_NOTARY_PROFILE', '').strip()
    key_path = environ.get('CROWNSWEEP_NOTARY_KEY_PATH', '').strip()
    key_id = environ.get('CROWNSWEEP_NOTARY_KEY_ID', '').strip()
    issuer = environ.get('CROWNSWEEP_NOTARY_ISSUER', '').strip()
    if profile and any((key_path, key_id, issuer)):
        raise ReleaseError('Choose either an existing keychain profile or App Store Connect API key configuration.')
    if profile:
        return ['--keychain-profile', profile]
    if not key_path or not key_id:
        raise ReleaseError('Set CROWNSWEEP_NOTARY_PROFILE, or CROWNSWEEP_NOTARY_KEY_PATH and CROWNSWEEP_NOTARY_KEY_ID.')
    path = Path(key_path).expanduser().resolve()
    if check_file and not path.is_file():
        raise ReleaseError('The App Store Connect key file does not exist.')
    result = ['--key', str(path), '--key-id', key_id]
    if issuer:
        result.extend(['--issuer', issuer])
    return result


def zip_command(app, archive):
    return ['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(archive)]


def submit_command(archive, auth):
    return ['xcrun', 'notarytool', 'submit', str(archive), *auth, '--wait', '--output-format', 'json']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, help='App path; defaults to tauri.conf.json productName')
    parser.add_argument('--output', type=Path, help='Final stapled ZIP; default <product>-<version>-mac.zip next to bundle')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        app = (args.app or default_app()).resolve()
        if app.suffix != '.app':
            raise ReleaseError('--app must point to an .app bundle.')
        data = config()
        output = (args.output or app.parent / f"{data['productName']}-{data['version']}-mac.zip").resolve()
        if output.suffix.lower() != '.zip' or app == output or app in output.parents:
            raise ReleaseError('--output must be a ZIP outside the App bundle.')
        auth = auth_args(check_file=not args.dry_run)
        if args.dry_run:
            redacted = [item if index % 2 == 0 else '<redacted>' for index, item in enumerate(auth)]
            for command in (
                ['codesign', '--verify', '--deep', '--strict', str(app)],
                zip_command(app, '<temporary submission ZIP>'),
                submit_command('<temporary submission ZIP>', redacted),
                ['xcrun', 'notarytool', 'log', '<submission id>', *redacted, '<local result log>'],
                ['xcrun', 'stapler', 'staple', str(app)],
                ['xcrun', 'stapler', 'validate', str(app)],
                ['spctl', '--assess', '--type', 'execute', '--verbose=2', str(app)],
                zip_command(app, output),
            ):
                print(' '.join(map(str, command)))
            print('Dry run only: no upload, signing, keychain change, stapling or packaging occurred.')
            return 0
        if not app.is_dir():
            raise ReleaseError('Build and Developer ID sign the App before notarization.')
        verify_release(app)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='crownsweep-notary-') as temporary:
            archive = Path(temporary) / 'submission.zip'
            run(zip_command(app, archive), timeout=300)
            result = run(submit_command(archive, auth), timeout=3600, check=False)
            response = json.loads(result.stdout)
            submission = response.get('id', '')
            if not re.fullmatch(r'[a-fA-F0-9-]{36}', submission):
                raise ReleaseError('Notary service returned no valid submission identifier.')
            log = output.with_suffix('.notary-log.json')
            run(['xcrun', 'notarytool', 'log', submission, *auth, str(log)], timeout=300)
            if result.returncode or response.get('status') != 'Accepted':
                raise ReleaseError(f'Notarization was not accepted. Inspect {log.name}; no release ZIP was produced.')
            run(['xcrun', 'stapler', 'staple', str(app)], timeout=300)
            run(['xcrun', 'stapler', 'validate', str(app)], timeout=300)
            run(['spctl', '--assess', '--type', 'execute', '--verbose=2', str(app)], timeout=300)
            final_archive = output.parent / f'.{output.name}.tmp.zip'
            try:
                run(zip_command(app, final_archive), timeout=300)
                os.replace(final_archive, output)
            finally:
                final_archive.unlink(missing_ok=True)
        print(f'Notarization accepted; stapled ticket and Gatekeeper assessment passed. Release: {output}')
        return 0
    except (ReleaseError, OSError, ValueError) as error:
        print(str(error) if isinstance(error, ReleaseError) else 'Release configuration or notarization response could not be read.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
