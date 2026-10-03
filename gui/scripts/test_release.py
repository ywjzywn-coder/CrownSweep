#!/usr/bin/env python3
"""Release tooling tests use fixture bundles and mocked subprocesses only."""
import contextlib
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import notarize_release as notarize
import sign_release as signing


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / 'Fixture.app'
        macos = self.app / 'Contents/MacOS'
        macos.mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'fixture'}))
        (macos / 'fixture').write_bytes(bytes.fromhex('cffaedfe'))
        self.helper = macos / 'mole-smc'
        self.helper.write_bytes(bytes.fromhex('cffaedfe'))

    def test_default_app_uses_configured_product(self):
        (self.root / 'src-tauri').mkdir()
        (self.root / 'src-tauri/tauri.conf.json').write_text(json.dumps({'productName': 'CrownSweep'}))
        self.assertEqual(signing.default_app(self.root).name, 'CrownSweep.app')

    def test_refuses_ad_hoc_and_development_certificates(self):
        for value in ('', '-', 'Apple Development: Fixture'):
            with self.subTest(value=value), self.assertRaises(signing.ReleaseError):
                signing.signing_identity({'CROWNSWEEP_SIGNING_IDENTITY': value})
        sha = 'A' * 40
        available = f' 1) {sha} "Apple Development: Fixture"\n'
        with self.assertRaises(signing.ReleaseError):
            signing.select_identity(sha, available)
        available = f' 1) {sha} "Developer ID Application: Fixture (FIXTURE)"\n'
        self.assertEqual(signing.select_identity(sha.lower(), available), sha)

    def test_nested_signing_precedes_app_and_enables_runtime_timestamp(self):
        nested = signing.nested_code(self.app)
        self.assertEqual(nested, [self.helper])
        commands = signing.signature_commands(self.app, 'fixture certificate', nested)
        sign_commands = [command for command in commands if '--sign' in command]
        self.assertEqual([command[-1] for command in sign_commands], [str(self.helper), str(self.app)])
        for command in sign_commands:
            self.assertIn('--timestamp', command)
            self.assertEqual(command[command.index('--options') + 1], 'runtime')
            self.assertNotIn('--deep', command)

    def test_missing_sidecar_is_rejected(self):
        self.helper.unlink()
        with self.assertRaises(signing.ReleaseError):
            signing.validate_sidecars(self.app, {'bundle': {'externalBin': ['binaries/mole-smc']}})

    def test_signing_dry_run_never_invokes_tools(self):
        output = io.StringIO()
        with patch.dict('os.environ', {'CROWNSWEEP_SIGNING_IDENTITY': 'Developer ID Application: Fixture'}, clear=True), patch('subprocess.run') as runner, contextlib.redirect_stdout(output):
            self.assertEqual(signing.main(['--app', str(self.app), '--dry-run']), 0)
        runner.assert_not_called()
        self.assertIn('--options runtime --timestamp', output.getvalue())

    def test_notary_auth_requires_one_complete_mode(self):
        for environ in ({}, {'CROWNSWEEP_NOTARY_KEY_ID': 'fixture'}, {'CROWNSWEEP_NOTARY_PROFILE': 'fixture', 'CROWNSWEEP_NOTARY_KEY_PATH': 'fixture.p8'}):
            with self.subTest(environ=environ), self.assertRaises(signing.ReleaseError):
                notarize.auth_args(environ)
        self.assertEqual(notarize.auth_args({'CROWNSWEEP_NOTARY_PROFILE': 'fixture'}), ['--keychain-profile', 'fixture'])
        key = self.root / 'fixture.p8'
        key.write_text('fixture only')
        auth = notarize.auth_args({'CROWNSWEEP_NOTARY_KEY_PATH': str(key), 'CROWNSWEEP_NOTARY_KEY_ID': 'fixture-id', 'CROWNSWEEP_NOTARY_ISSUER': 'fixture-issuer'})
        self.assertEqual(auth, ['--key', str(key), '--key-id', 'fixture-id', '--issuer', 'fixture-issuer'])

    def test_notary_dry_run_redacts_auth_and_never_invokes_tools(self):
        output = io.StringIO()
        with patch.dict('os.environ', {'CROWNSWEEP_NOTARY_PROFILE': '--private-fixture-value'}, clear=True), patch('subprocess.run') as runner, contextlib.redirect_stdout(output):
            self.assertEqual(notarize.main(['--app', str(self.app), '--dry-run']), 0)
        runner.assert_not_called()
        self.assertNotIn('--private-fixture-value', output.getvalue())
        self.assertIn('submit', output.getvalue())
        self.assertIn('--wait', output.getvalue())
        self.assertIn('stapler validate', output.getvalue())
        self.assertIn('spctl --assess', output.getvalue())

    def test_tool_failure_does_not_expose_arguments_or_output(self):
        result = subprocess.CompletedProcess([], 1, 'private stdout', 'private stderr')
        with patch('subprocess.run', return_value=result), self.assertRaises(signing.ReleaseError) as caught:
            signing.run(['xcrun', 'notarytool', '--key', 'private-key-path'])
        message = str(caught.exception)
        for private in ('private-key-path', 'private stdout', 'private stderr'):
            self.assertNotIn(private, message)

    def test_notary_signature_preflight_requires_runtime_and_timestamp(self):
        for metadata in (
            'Authority=Developer ID Application: Fixture\nCodeDirectory v=20500 flags=0x0(none)\nTimestamp=fixture',
            'Authority=Developer ID Application: Fixture\nCodeDirectory v=20500 flags=0x10000(runtime)',
            'Signature=adhoc\nCodeDirectory v=20500 flags=0x10000(runtime)\nTimestamp=fixture',
        ):
            result = subprocess.CompletedProcess([], 0, '', metadata)
            with self.subTest(metadata=metadata), patch.object(signing, 'run', return_value=result), self.assertRaises(signing.ReleaseError):
                signing.verify_release(self.app)

    def test_notarization_staples_before_final_archive(self):
        commands = []
        output = self.root / 'release.zip'

        def fake_run(command, timeout=120, check=True):
            commands.append(command)
            if command[0] == 'ditto':
                Path(command[-1]).write_bytes(b'fixture archive')
            stdout = json.dumps({'id': '12345678-1234-1234-1234-123456789abc', 'status': 'Accepted'}) if 'submit' in command else ''
            return subprocess.CompletedProcess(command, 0, stdout, '')

        with patch.dict('os.environ', {'CROWNSWEEP_NOTARY_PROFILE': 'fixture'}, clear=True), patch.object(notarize, 'verify_release'), patch.object(notarize, 'run', side_effect=fake_run), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(notarize.main(['--app', str(self.app), '--output', str(output)]), 0)
        self.assertTrue(output.is_file())
        staple = next(i for i, command in enumerate(commands) if command[:3] == ['xcrun', 'stapler', 'staple'])
        final_zip = max(i for i, command in enumerate(commands) if command[0] == 'ditto')
        self.assertLess(staple, final_zip)
        self.assertTrue(any(command[:3] == ['xcrun', 'stapler', 'validate'] for command in commands))
        self.assertTrue(any(command[0] == 'spctl' for command in commands))

    def test_rejected_notarization_produces_no_release(self):
        output = self.root / 'rejected.zip'
        result = subprocess.CompletedProcess([], 65, json.dumps({'id': '12345678-1234-1234-1234-123456789abc', 'status': 'Invalid'}), '')
        with patch.dict('os.environ', {'CROWNSWEEP_NOTARY_PROFILE': 'fixture'}, clear=True), patch.object(notarize, 'verify_release'), patch.object(notarize, 'run', return_value=result) as runner, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(notarize.main(['--app', str(self.app), '--output', str(output)]), 1)
        self.assertFalse(output.exists())
        self.assertFalse(any(call.args[0][:3] == ['xcrun', 'stapler', 'staple'] for call in runner.call_args_list))


if __name__ == '__main__':
    unittest.main()
