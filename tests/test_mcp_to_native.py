import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/mcp_to_native.py'
MARKER = 'marker-kept-private'


class ConverterTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.source = self.dir / 'mcp-adapter.json'
        self.target = self.dir / 'mcp.json'
        self.source.write_text(json.dumps({'settings': {'note': MARKER}, 'mcpServers': {
            'one': {'command': 'tool-' + MARKER, 'args': ['$env:' + MARKER], 'env': {'A': '${NAME:-' + MARKER + '}', 'B': '!!' + MARKER},
                    'lifecycle': 'lazy', 'toolPrefix': MARKER},
            'two': {'url': 'http://127.0.0.1:9/' + MARKER, 'headers': {'H': '{env:' + MARKER + '}'}},
            'three': {'socket': MARKER},
        }}))

    def run_script(self):
        return subprocess.run([sys.executable, str(SCRIPT), '--from', str(self.source), '--to', str(self.target)],
                              text=True, capture_output=True, timeout=20)

    def test_prints_no_value_and_writes_mode_0600(self):
        result = self.run_script()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn(MARKER, result.stdout + result.stderr)
        self.assertEqual(0o600, stat.S_IMODE(self.target.stat().st_mode))

    def test_refuses_an_existing_target(self):
        self.target.write_text('kept')
        self.assertNotEqual(0, self.run_script().returncode)
        self.assertEqual('kept', self.target.read_text())

    def test_refuses_a_symlink_target(self):
        other = self.dir / 'other'
        os.symlink(other, self.target)
        self.assertNotEqual(0, self.run_script().returncode)
        self.assertFalse(other.exists())


class ProfileSwitchTest(unittest.TestCase):
    """--profile: a backup, then mcp.json with codemode exposure and the settings; --restore puts the files back."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.profile = Path(temp.name) / 'profile'
        self.profile.mkdir()
        spec = 'npm:' + json.loads((ROOT / 'config/manifest.json').read_text())['components']['mcp']['source']['spec']
        self.files = {
            'settings.json': json.dumps({'packages': [spec, 'own-package'], 'extensions': ['-builtin:mcp', '-builtin:own'],
                                         'own': {'kept': True}}, indent=4).encode(),
            'mcp-adapter.json': json.dumps({'mcpServers': {
                'direct': {'command': 'direct-server', 'directTools': True, 'lifecycle': 'lazy', 'toolPrefix': 'short'},
                'some': {'command': 'some-server', 'directTools': ['one']},
                'search': {'command': 'search-server', 'directTools': 'search'},
                'off': {'command': 'off-server', 'disabled': True},
                'signin': {'url': 'http://127.0.0.1:9/mcp', 'bearerTokenEnv': MARKER},
                'risky': {'command': 'risky-server', 'approveTools': 'destructive'},
                'sse': {'url': 'http://127.0.0.1:9/sse', 'type': 'sse'},
                'noisy': {'command': 'noisy-server', 'excludeTools': ['noisy_rm']},
            }}).encode(),
            'mcp-onboarding.json': b'{"piBuiltinMcpHandledVersion": "7.0.0"}\n',
        }
        for name, data in self.files.items():
            (self.profile / name).write_bytes(data)
            (self.profile / name).chmod(0o644)

    def run_script(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], text=True, capture_output=True, timeout=20)

    def snapshot(self):
        return {str(p.relative_to(self.profile)): (p.read_bytes() if p.is_file() else None)
                for p in self.profile.rglob('*')}

    def backup_folder(self):
        return next((self.profile / 'backups').iterdir())

    def test_every_enabled_server_gets_codemode_and_a_server_that_is_not_safe_stays_off(self):
        result = self.run_script('--profile', str(self.profile))
        self.assertEqual(0, result.returncode, result.stderr)
        servers = json.loads((self.profile / 'mcp.json').read_text())['mcpServers']
        self.assertEqual({'direct', 'some', 'search', 'off', 'signin', 'risky', 'sse', 'noisy'}, set(servers))
        for name, entry in servers.items():
            self.assertEqual('codemode', entry.get('exposure'), name)
            # No direct or deferred override survives; a hidden tool stays unreachable.
            self.assertEqual(set(), set(entry.get('toolExposure', {}).values()) - {'hidden'}, name)
        # An approval, a sign-in field and a transport that Pi lacks keep the server off; an excluded tool is hidden.
        self.assertEqual({'off': False, 'signin': False, 'risky': False, 'sse': False},
                         {name: entry['enabled'] for name, entry in servers.items() if 'enabled' in entry})
        self.assertEqual('hidden', servers['noisy']['toolExposure'].get('rm'))
        # The reason names the server and the field, never the value.
        lines = result.stdout.splitlines()
        self.assertTrue(any('signin' in line and 'bearerTokenEnv' in line for line in lines))
        self.assertTrue(any('risky' in line and 'approveTools' in line for line in lines))
        self.assertNotIn(MARKER, result.stdout + result.stderr)
        self.assertEqual(0o600, stat.S_IMODE((self.profile / 'mcp.json').stat().st_mode))
        settings = json.loads((self.profile / 'settings.json').read_text())
        self.assertEqual(['own-package'], settings['packages'])
        self.assertEqual(['-builtin:own'], settings['extensions'])
        self.assertEqual(['+codemode'], settings['defaultTools'])
        self.assertEqual({'kept': True}, settings['own'])

    def test_the_backup_is_private_and_a_refusal_changes_no_file(self):
        before = self.snapshot()
        # A native file that no switch wrote, and a required server that is not safe: both stop before a change.
        (self.profile / 'mcp.json').write_bytes(b'{"mcpServers": {}}\n')
        conflict = self.snapshot()
        self.assertEqual(2, self.run_script('--profile', str(self.profile)).returncode)
        self.assertEqual(conflict, self.snapshot())
        (self.profile / 'mcp.json').rename(self.profile.parent / 'moved-mcp.json')
        self.assertEqual(2, self.run_script('--profile', str(self.profile), '--require', 'signin').returncode)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        folder = self.backup_folder()
        self.assertEqual(0o700, stat.S_IMODE(folder.stat().st_mode))
        for name, data in self.files.items():
            self.assertEqual(data, (folder / name).read_bytes())
            self.assertEqual(0o600, stat.S_IMODE((folder / name).stat().st_mode))

    def test_a_second_switch_refuses_a_hand_edited_mcp_json(self):
        # A second switch over its own mcp.json runs, also in the same second; after a hand edit it is refused.
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        native = self.profile / 'mcp.json'
        document = json.loads(native.read_text())
        document['mcpServers']['mine'] = {'command': 'my-server'}
        native.write_text(json.dumps(document))
        before = self.snapshot()
        self.assertEqual(2, self.run_script('--profile', str(self.profile)).returncode)
        self.assertEqual(before, self.snapshot())

    def test_the_kit_aws_entry_is_backed_up_kept_and_required(self):
        entry = {'command': 'aws-server', 'lifecycle': 'lazy'}
        adapter = json.loads(self.files['mcp-adapter.json'])
        adapter['mcpServers']['aws-mcp'] = entry
        self.files['mcp-adapter.json'] = json.dumps(adapter).encode()
        self.files['kit-aws.json'] = json.dumps({'mcp': {'mcp-adapter.json': entry}}).encode()
        for name in ('mcp-adapter.json', 'kit-aws.json'):
            (self.profile / name).write_bytes(self.files[name])
        # A kit entry that is not safe stops the run with no change.
        unsafe = json.loads(self.files['mcp-adapter.json'])
        unsafe['mcpServers']['aws-mcp']['bearerTokenEnv'] = MARKER
        (self.profile / 'mcp-adapter.json').write_text(json.dumps(unsafe))
        (self.profile / 'kit-aws.json').write_text(json.dumps({'mcp': {'mcp-adapter.json': unsafe['mcpServers']['aws-mcp']}}))
        before = self.snapshot()
        self.assertEqual(2, self.run_script('--profile', str(self.profile)).returncode)
        self.assertEqual(before, self.snapshot())
        for name in ('mcp-adapter.json', 'kit-aws.json'):
            (self.profile / name).write_bytes(self.files[name])
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        folder = self.backup_folder()
        for name in ('mcp-adapter.json', 'kit-aws.json'):
            self.assertEqual(self.files[name], (folder / name).read_bytes())
        # The kit step then takes its entry out of mcp-adapter.json; a second switch keeps it in mcp.json.
        converted = json.loads((self.profile / 'mcp.json').read_text())['mcpServers']['aws-mcp']
        del adapter['mcpServers']['aws-mcp']
        (self.profile / 'mcp-adapter.json').write_text(json.dumps(adapter))
        (self.profile / 'kit-aws.json').write_text(json.dumps({'mcp': {'mcp.json': converted}}))
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        self.assertEqual(converted, json.loads((self.profile / 'mcp.json').read_text())['mcpServers']['aws-mcp'])

    def test_restore_keeps_a_later_edit_in_the_backup_folder(self):
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        folder = self.backup_folder()
        settings = json.loads((self.profile / 'settings.json').read_text())
        settings['later'] = 'edit of the owner'
        edited = json.dumps(settings).encode()
        (self.profile / 'settings.json').write_bytes(edited)
        self.assertEqual(0, self.run_script('--restore', str(folder)).returncode)
        self.assertEqual(self.files['settings.json'], (self.profile / 'settings.json').read_bytes())
        self.assertIn(edited, [f.read_bytes() for f in folder.iterdir() if f.is_file()])

    def test_restore_gives_back_the_original_bytes_and_moves_a_new_file_aside(self):
        self.assertEqual(0, self.run_script('--profile', str(self.profile)).returncode)
        folder = self.backup_folder()
        converted = (self.profile / 'mcp.json').read_bytes()
        result = self.run_script('--restore', str(folder))
        self.assertEqual(0, result.returncode, result.stderr)
        for name, data in self.files.items():
            self.assertEqual(data, (self.profile / name).read_bytes())
            self.assertEqual(0o644, stat.S_IMODE((self.profile / name).stat().st_mode))
        self.assertFalse(os.path.lexists(self.profile / 'mcp.json'))
        # The converted file is kept, not deleted: it moved into the backup folder.
        self.assertIn(converted, [f.read_bytes() for f in folder.iterdir() if f.is_file()])
        # A second restore of the same folder is refused.
        self.assertEqual(2, self.run_script('--restore', str(folder)).returncode)


if __name__ == '__main__':
    unittest.main()
