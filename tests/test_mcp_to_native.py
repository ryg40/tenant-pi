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


if __name__ == '__main__':
    unittest.main()
