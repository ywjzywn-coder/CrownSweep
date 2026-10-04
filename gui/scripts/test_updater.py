#!/usr/bin/env python3
"""Updater publishing tests use temporary App fixtures and mocked tools only."""
import base64
import contextlib
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import prepare_updater as updater
from sign_release import ReleaseError


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.app = self.root / 'CrownSweep.app'
        (self.app / 'Contents/MacOS').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'com.ellaycrown.molegui', 'CFBundleShortVersionString': '0.4.0', 'CFBundleExecutable': 'mole-gui'}))
        for name in ('mole-gui', 'mole-smc'):
            (self.app / 'Contents/MacOS' / name).write_bytes(bytes.fromhex('cffaedfe'))

    def test_refuses_missing_or_invalid_publisher_identity(self):
        (self.root / 'src-tauri').mkdir()
        policy = self.root / 'src-tauri/update-policy.json'
        for value in (None, '', 'Apple Development', 'SHORT'):
            policy.write_text(json.dumps({'publisherTeamId': value}))
            with self.subTest(value=value), self.assertRaises(ReleaseError):
                updater.publisher_team(self.root)
        policy.write_text(json.dumps({'publisherTeamId': 'ABCDEFGHIJ'}))
        self.assertEqual(updater.publisher_team(self.root), 'ABCDEFGHIJ')

    def test_checks_notarization_gatekeeper_team_and_both_binaries(self):
        calls = []
        def fake(command):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, 'arm64 x86_64\n' if command[0] == 'lipo' else 'TeamIdentifier=ABCDEFGHIJ\n', '')
        with patch.object(updater, 'verify_release') as verify, patch.object(updater, 'run', side_effect=fake):
            updater.inspect_app(self.app, '0.4.0', 'aarch64', 'ABCDEFGHIJ')
        verify.assert_called_once_with(self.app)
        self.assertIn(['xcrun', 'stapler', 'validate', str(self.app)], calls)
        self.assertIn(['spctl', '--assess', '--type', 'execute', str(self.app)], calls)
        self.assertEqual(len([call for call in calls if call[0] == 'lipo']), 2)
        with patch.object(updater, 'verify_release'), patch.object(updater, 'run', return_value=subprocess.CompletedProcess([], 0, 'TeamIdentifier=OTHERTEAM1\n', '')):
            with self.assertRaises(ReleaseError):
                updater.inspect_app(self.app, '0.4.0', 'aarch64', 'ABCDEFGHIJ')

    def test_rejects_wrong_app_version_before_tool_calls(self):
        with patch.object(updater, 'run') as runner, self.assertRaises(ReleaseError):
            updater.inspect_app(self.app, '0.5.0', 'aarch64', 'ABCDEFGHIJ')
        runner.assert_not_called()

    def test_merges_architectures_only_with_matching_version_and_origin(self):
        manifest = self.root / 'crownsweep-update.json'
        arm = self.root / 'CrownSweep-0.4.0-aarch64.app.tar.gz'
        intel = self.root / 'CrownSweep-0.4.0-x86_64.app.tar.gz'
        updater.update_manifest(manifest, '0.4.0', 'aarch64', arm, 'fixture signature', 'Release notes')
        updater.update_manifest(manifest, '0.4.0', 'x86_64', intel, 'fixture signature 2', '')
        data = json.loads(manifest.read_text())
        self.assertEqual(set(data['platforms']), {'darwin-aarch64', 'darwin-x86_64'})
        self.assertEqual(data['notes'], 'Release notes')
        self.assertEqual(data['platforms']['darwin-aarch64']['url'], updater.release_url('0.4.0', arm.name))
        with self.assertRaises(ReleaseError):
            updater.update_manifest(manifest, '0.5.0', 'aarch64', arm, 'fixture', '')
        data['platforms']['darwin-aarch64']['url'] = 'https://untrusted.example/archive'
        manifest.write_text(json.dumps(data))
        with self.assertRaises(ReleaseError):
            updater.update_manifest(manifest, '0.4.0', 'x86_64', intel, 'fixture', '')

    def test_requires_version_bound_signature_and_matching_embedded_key(self):
        signature = self.root / 'fixture.sig'
        signature.write_text(base64.b64encode(b'untrusted comment: fixture\nabc\ntrusted comment: timestamp:1\tversion:0.4.0\nxyz').decode())
        self.assertTrue(updater.read_signature(signature, '0.4.0'))
        with self.assertRaises(ReleaseError):
            updater.read_signature(signature, '0.5.0')
        key = self.root / 'fixture.key'; key.with_suffix('.key.pub').write_text('public fixture')
        updater.matching_public_key(key, {'plugins': {'updater': {'pubkey': 'public fixture'}}})
        with self.assertRaises(ReleaseError):
            updater.matching_public_key(key, {'plugins': {'updater': {'pubkey': 'wrong fixture'}}})

    def test_sign_failure_does_not_forward_cli_output_or_secret_key_paths(self):
        output = io.StringIO()
        with patch.object(updater.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'private fixture secret', b'')), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), self.assertRaises(ReleaseError) as error:
            updater.sign_artifact(self.root / 'fixture.tar.gz', self.root / 'private-fixture.key', '0.4.0')
        self.assertNotIn('private fixture secret', str(error.exception) + output.getvalue())
        self.assertNotIn('private-fixture.key', str(error.exception) + output.getvalue())

    def test_dry_run_never_runs_tools_or_creates_output(self):
        output = self.root / 'out'
        with patch.object(updater, 'publisher_team', return_value='ABCDEFGHIJ'), patch.object(updater.subprocess, 'run') as runner, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(updater.main(['--arch', 'aarch64', '--app', str(self.app), '--output-dir', str(output), '--dry-run']), 0)
        runner.assert_not_called(); self.assertFalse(output.exists())

    def test_sign_failure_leaves_no_final_archive_and_allows_retry(self):
        output = self.root / 'output'
        key = self.root / 'fixture.key'; key.write_text('fixture only'); key.chmod(0o600)
        data = {'version': '0.4.0', 'productName': 'CrownSweep'}
        with patch.object(updater, 'config', return_value=data), patch.object(updater, 'publisher_team', return_value='ABCDEFGHIJ'), patch.object(updater, 'matching_public_key'), patch.object(updater, 'inspect_app'), patch.object(updater, 'sign_artifact', side_effect=ReleaseError('fixture sign failure')), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(updater.main(['--arch', 'aarch64', '--app', str(self.app), '--output-dir', str(output), '--private-key-path', str(key)]), 1)
        self.assertEqual(list(output.iterdir()), [])

        def fake_sign(archive, _key, _version):
            archive.with_suffix(archive.suffix + '.sig').write_text(base64.b64encode(b'untrusted comment: fixture\nabc\ntrusted comment: timestamp:1\tversion:0.4.0\nxyz').decode())
        with patch.object(updater, 'config', return_value=data), patch.object(updater, 'publisher_team', return_value='ABCDEFGHIJ'), patch.object(updater, 'matching_public_key'), patch.object(updater, 'inspect_app'), patch.object(updater, 'sign_artifact', side_effect=fake_sign), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(updater.main(['--arch', 'aarch64', '--app', str(self.app), '--output-dir', str(output), '--private-key-path', str(key)]), 0)
        self.assertTrue((output / 'CrownSweep-0.4.0-aarch64.app.tar.gz').exists())
        self.assertTrue((output / 'CrownSweep-0.4.0-aarch64.app.tar.gz.sig').exists())
        self.assertTrue((output / 'crownsweep-update.json').exists())


if __name__ == '__main__':
    unittest.main()
