"""Optional launcher boundary, with stand-in commands only."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / 'packages/tenantext/skills/herdr/scripts/credsync-launch.sh'


class CredsyncLaunch(unittest.TestCase):
    def test_optional_boundary_keeps_starts_and_only_wraps_approved_files(self):
        root = Path(tempfile.mkdtemp(prefix='credsync-launch-test-'))
        tools = root / 'bin'
        tools.mkdir()
        cli = tools / 'credsync'
        cli.write_text('''#!/usr/bin/python3
import json,os,pathlib,sys
p=pathlib.Path('.credsync.json')
if sys.argv[1]=='check': sys.exit(0 if p.read_text()=='approved' else 1)
command=sys.argv[sys.argv.index('--')+1:]
os.environ['PROJECT_TOKEN']='fixture'
os.execvpe(command[0],command,os.environ)
''')
        cli.chmod(0o700)
        # A small script, not a link to /bin/true: macOS has no /bin/true.
        fnox = tools / 'fnox'
        fnox.write_text('#!/bin/sh\nexit 0\n')
        fnox.chmod(0o700)
        env = {'PATH': str(tools) + ':/usr/bin:/bin', 'HOME': str(root), 'UNRELATED_TOKEN': 'fixture',
               'PI_CODING_AGENT_DIR': str(root / 'profile'), 'HERDR_PANE_ID': 'fixture'}

        def launch():
            result = subprocess.run(['/bin/sh', str(WRAPPER), '/usr/bin/env', '-0'], cwd=root,
                                    env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            names = {part.split(b'=', 1)[0].decode() for part in result.stdout.split(b'\0') if part}
            return result, names

        result, names = launch()
        self.assertIn('UNRELATED_TOKEN', names)
        self.assertNotIn('PROJECT_TOKEN', names)
        self.assertEqual(result.stderr, b'')
        project = root / '.credsync.json'
        project.write_text('unapproved')
        result, names = launch()
        self.assertNotIn('PROJECT_TOKEN', names)
        self.assertIn('UNRELATED_TOKEN', names)
        self.assertEqual(len(result.stderr.splitlines()), 1)
        project.write_text('approved')
        result, names = launch()
        self.assertEqual(result.stderr, b'')
        self.assertIn('PROJECT_TOKEN', names)
        self.assertIn('UNRELATED_TOKEN', names)
        for name in ('fnox', 'credsync'):
            (tools / name).rename(tools / (name + '-saved'))
            result, names = launch()
            self.assertNotIn('PROJECT_TOKEN', names)
            self.assertEqual(len(result.stderr.splitlines()), 1)


if __name__ == '__main__':
    unittest.main()
