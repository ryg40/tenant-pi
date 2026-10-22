"""Installer integration tests use disposable homes and a fake Pi executable."""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'install.sh'
MANIFEST = json.loads((ROOT / 'config/manifest.json').read_text())


class InstallTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='install-test-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.home = self.base / "home ' quoted space"
        self.home.mkdir()
        self.bin = self.base / "runtime ' bin"
        self.bin.mkdir()
        self.pi = self.bin / 'pi'
        self.pi.write_text('''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['PI_CODING_AGENT_DIR'])
with (p / 'calls.jsonl').open('a') as f:
    f.write(json.dumps({'args': sys.argv[1:], 'profile': str(p), 'session': os.environ.get('PI_CODING_AGENT_SESSION_DIR'), 'path': os.environ['PATH']}) + '\\n')
sys.exit(int(os.environ.get('FAKE_FAIL', '0')))
''')
        self.pi.chmod(0o700)
        self.profile = self.home / '.pi/profiles/demo'
        self.env = {'HOME': str(self.home), 'PATH': str(self.bin) + ':/usr/bin:/bin',
                    'PYTHONDONTWRITEBYTECODE': '1', 'PI_CODING_AGENT_DIR': '/ignored/suggestion',
                    'INSTALL_TEST_TTY': str(self.home / 'absent-tty')}

    def run_install(self, *args, env=None, script=SCRIPT):
        return subprocess.run(['sh', str(script), *args], env=self.env | (env or {}),
                              stdin=subprocess.DEVNULL, text=True, capture_output=True, timeout=20)

    def install(self, mode='new', shell='bash', modules='none', **kwargs):
        return self.run_install('--' + mode, 'demo', '--shell', shell, '--with', modules, '--yes', **kwargs)

    def success(self, result):
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def snapshot(self):
        return {str(p.relative_to(self.home)): (p.read_bytes() if p.is_file() else None)
                for p in self.home.rglob('*')}

    def interactive(self, answers, *args):
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        process = subprocess.Popen(['sh', str(SCRIPT), *args], env=self.env | {'INSTALL_TEST_TTY': os.ttyname(slave)},
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        transcript = ''
        for prompt, answer in answers:
            deadline = time.monotonic() + 10
            while prompt not in transcript:
                if time.monotonic() > deadline:
                    process.kill()
                    self.fail('missing prompt: ' + prompt + ': ' + transcript)
                if select.select([master], [], [], .1)[0]:
                    transcript += os.read(master, 65536).decode()
            os.write(master, (answer + '\n').encode())
            transcript = ''
        out, err = process.communicate(timeout=15)
        return subprocess.CompletedProcess(process.args, process.returncode, out, err)

    def test_interactive_upgrade_keeps_legacy_state_and_filters(self):
        self.profile.mkdir(parents=True)
        settings = {'packages': [{'source': '/old/kit/packages/tenantext', 'extensions': ['a.ts'], 'skills': []},
                                 'npm:own-package'], 'defaultModel': 'custom', 'unrelated': {'a': 2}}
        (self.profile / 'settings.json').write_text(json.dumps(settings))
        for name in ('auth.json', 'models.json', 'sessions/one', 'memory/one'):
            path = self.profile / name
            path.parent.mkdir(exist_ok=True)
            path.write_text('private custom bytes')
        before = self.snapshot()
        result = self.interactive([('Profile action', 'upgrade'), ('Name of upgrade', 'demo'),
                                   ('Shell', 'bash'), ('Optional modules', 'wiki'), ('Apply', 'yes')])
        self.success(result)
        # The report names the profile path and the startup file; its wording may change.
        for text in (str(self.profile), str(self.home / '.bashrc')):
            self.assertIn(text, result.stdout)
        current = json.loads((self.profile / 'settings.json').read_text())
        settings['packages'][0]['source'] = str(ROOT / 'packages/tenantext')
        self.assertEqual(settings, current)
        for path, data in before.items():
            if data is not None and not path.endswith('settings.json'):
                self.assertEqual(data, (self.home / path).read_bytes())
        self.assertEqual(['demo'], [p.name for p in self.profile.parent.iterdir()])
        self.assertTrue(list(self.profile.glob('settings.json.backup-*')))
        self.assertFalse((self.home / '.config').exists())
        calls = [json.loads(line) for line in (self.profile / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual(['install', 'npm:' + MANIFEST['components']['wiki']['source']['spec']], calls[0]['args'])
        settings['packages'] = []
        original = json.dumps(settings) + '\n'
        (self.profile / 'settings.json').write_text(original)
        self.success(self.install(mode='upgrade'))
        self.assertIn(original, [p.read_text() for p in self.profile.glob('settings.json.backup-*')])

    def test_new_and_collision(self):
        result = self.install(shell='none')
        self.success(result)
        calls = [json.loads(line) for line in (self.profile / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual([['install', 'npm:' + MANIFEST['components']['questions']['source']['spec']]],
                         [call['args'] for call in calls])
        self.assertEqual(str(self.profile), calls[0]['profile'])
        before = self.snapshot()
        self.assertEqual(2, self.install().returncode)
        self.assertEqual(before, self.snapshot())

    def test_bash_alias_launcher_forwarding_and_repeat(self):
        rc = self.home / '.bashrc'
        rc.write_bytes(b'# own content\r\n# OWN=kept\r\n')
        self.success(self.install())
        self.assertEqual(0o700, stat.S_IMODE(self.profile.stat().st_mode))
        self.assertEqual(0o600, stat.S_IMODE((self.profile / 'settings.json').stat().st_mode))
        with rc.open('ab') as stream:
            stream.write(b'# after block\r\n')
        self.success(self.install(mode='upgrade'))
        self.assertTrue(rc.read_bytes().endswith(b'# after block\r\n'))
        self.assertEqual(1, rc.read_text().count('# >>> tenant-pi demo >>>'))
        self.assertTrue(rc.read_bytes().startswith(b'# own content\r\n# OWN=kept\r\n'))
        self.assertTrue(list(self.home.glob('.bashrc.backup-*')))
        command = 'shopt -s expand_aliases\n. "$HOME/.bashrc"\ndemo "two words" "a\'b" "$(printf literal)"\n'
        result = subprocess.run(['bash', '--noprofile', '--norc', '-c', command],
                                env=self.env | {'PI_CODING_AGENT_SESSION_DIR': '/not/shared'}, capture_output=True, text=True)
        self.success(result)
        call = json.loads((self.profile / 'calls.jsonl').read_text().splitlines()[-1])
        self.assertEqual(['two words', "a'b", 'literal'], call['args'])
        self.assertEqual(str(self.profile), call['profile'])
        self.assertIsNone(call['session'])
        self.assertTrue(call['path'].startswith(str(self.bin) + ':'))

    def test_zsh_and_zdotdir(self):
        for directory in (self.home, self.home / "zsh ' space"):
            with self.subTest(directory=directory):
                env = {'ZDOTDIR': str(directory)}
                result = self.install(mode='upgrade' if self.profile.exists() else 'new', shell='zsh', env=env)
                self.success(result)
                rc = directory / '.zshrc'
                self.assertIn('alias demo=', rc.read_text())
                self.assertIn(str(rc), result.stdout)
                self.assertFalse((self.home / '.bashrc').exists())
                if shutil.which('zsh'):
                    result = subprocess.run(['zsh', '-f', '-c', '. "$ZDOTDIR/.zshrc"\neval \'demo "zsh words"\''],
                                            env=self.env | env, capture_output=True, text=True)
                    self.success(result)

    def test_missing_choices_and_cancellation_write_nothing(self):
        for args in ((), ('--new', 'demo'), ('--new', 'demo', '--shell', 'none'),
                     ('--new', 'demo', '--shell', 'none', '--with', 'none')):
            self.assertEqual(2, self.run_install(*args).returncode)
            self.assertEqual({}, self.snapshot())
        result = self.interactive([('Apply', 'no')], '--new', 'demo', '--shell', 'bash', '--with', 'none')
        self.assertEqual(2, result.returncode)
        self.assertEqual({}, self.snapshot())

    def test_invalid_names(self):
        for name in ('', 'Upper', '-x', 'a_b', '../x', 'a' * 33, 'a;touch pwn', 'a\nb'):
            with self.subTest(name=name):
                result = self.run_install('--new', name, '--shell', 'bash', '--with', 'none', '--yes')
                self.assertEqual(2, result.returncode)
                self.assertEqual({}, self.snapshot())

    def test_conflicts_need_separate_approval(self):
        for content in ('alias demo=elsewhere\n', 'demo() { :; }\n', 'function demo { :; }\n',
                        'alias other=true demo=old-command\n', 'alias -- demo=old-command\n',
                        'alias demo="unterminated\n'):
            (self.home / '.bashrc').write_text(content)
            before = self.snapshot()
            self.assertEqual(2, self.install().returncode)
            self.assertEqual(before, self.snapshot())
        other = self.bin / 'tenant-pi'
        other.write_text('#!/bin/sh\nexit 0\n')
        other.chmod(0o700)
        (self.home / '.bashrc').write_text('alias tenant-pi=elsewhere\n')
        before = self.snapshot()
        result = self.run_install('--new', 'tenant-pi', '--shell', 'bash', '--with', 'none', '--yes')
        self.assertEqual(2, result.returncode)
        self.assertEqual(before, self.snapshot())

        command = self.bin / 'demo'
        command.write_text('#!/bin/sh\n')
        command.chmod(0o700)
        self.assertEqual(2, self.install().returncode)
        self.assertEqual(before, self.snapshot())
        command.chmod(0o600)
        launcher = self.home / '.local/bin/demo'
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_text('own launcher')
        before = self.snapshot()
        self.assertEqual(2, self.install().returncode)
        self.assertEqual(before, self.snapshot())

        self.success(self.run_install('--new', 'demo', '--shell', 'bash', '--with', 'none', '--yes', '--replace-alias'))

    def test_failed_module_keeps_old_alias_and_launcher(self):
        self.success(self.install())
        rc = (self.home / '.bashrc').read_bytes()
        launch = (self.home / '.local/bin/demo').read_bytes()
        result = self.install(mode='upgrade', modules='wiki', env={'FAKE_FAIL': '1'})
        self.assertNotEqual(0, result.returncode)
        self.assertEqual(rc, (self.home / '.bashrc').read_bytes())
        self.assertEqual(launch, (self.home / '.local/bin/demo').read_bytes())

    def test_alias_failure_reported_separately(self):
        (self.home / '.local').write_text('not a directory')
        result = self.install()
        self.assertNotEqual(0, result.returncode)
        self.assertTrue((self.profile / 'settings.json').exists())
        self.assertFalse((self.home / '.bashrc').exists())

    def test_clone_quoting_and_claude_links(self):
        kit = self.base / 'kit " quote & |'
        (kit / 'config').mkdir(parents=True)
        shutil.copy(SCRIPT, kit / 'install.sh')
        for file in ('settings.example.json', 'models.example.json', 'manifest.json'):
            shutil.copy(ROOT / 'config' / file, kit / 'config' / file)
        skill = kit / 'packages/tenantext/skills/demo'
        skill.mkdir(parents=True)
        (skill / 'SKILL.md').write_text('demo')
        (self.home / '.claude').mkdir()
        result = self.install(shell='none', script=kit / 'install.sh')
        self.success(result)
        # The plan discloses the skill links: it names their folder.
        self.assertIn(str(self.home / '.claude/skills'), result.stdout)
        settings = json.loads((self.profile / 'settings.json').read_text())
        self.assertEqual(str(kit / 'packages/tenantext'), settings['packages'][0])
        self.assertEqual(skill, (self.home / '.claude/skills/demo').resolve())

    def test_symlink_profiles_cannot_target_live_or_clone(self):
        self.profile.parent.mkdir(parents=True)
        live = self.home / '.pi/agent'
        live.mkdir()
        self.profile.symlink_to(live, target_is_directory=True)
        before = self.snapshot()
        self.assertEqual(2, self.install(mode='upgrade').returncode)
        self.assertEqual(before, self.snapshot())


if __name__ == '__main__':
    unittest.main()
