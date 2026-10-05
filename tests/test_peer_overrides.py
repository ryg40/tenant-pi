"""Synthetic npm roots only; the script under test needs Node and no network."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/patch_extension_peers.mjs"
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "node is not installed")
class PeerOverrideTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def manifest(self, name, data=None):
        path = self.root / "node_modules" / name / "package.json"
        if data is not None:
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        return path

    def run_script(self):
        return subprocess.run([NODE, str(SCRIPT), str(self.root)], capture_output=True, text=True, timeout=30)

    def test_moves_host_modules_to_peers_and_is_idempotent(self):
        path = self.manifest("@zosmaai/pi-llm-wiki", {
            "name": "@zosmaai/pi-llm-wiki", "dependencies": {"yaml": "^2.0.0", "typebox": "^1.0.0",
                                                           "@earendil-works/pi-tui": "^0.99.0"}})
        other = self.manifest("unlisted", {"name": "unlisted", "dependencies": {"typebox": "^1.0.0"}})
        before_other = other.read_text(encoding="utf-8")
        result = self.run_script()
        self.assertEqual(0, result.returncode, result.stderr)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual({"yaml": "^2.0.0"}, data["dependencies"])
        self.assertEqual({"typebox": "*", "@earendil-works/pi-tui": "*"}, data["peerDependencies"])
        self.assertEqual(before_other, other.read_text(encoding="utf-8"))
        first = path.read_text(encoding="utf-8")
        again = self.run_script()
        self.assertEqual((0, ""), (again.returncode, again.stdout))
        self.assertEqual(first, path.read_text(encoding="utf-8"))
        self.assertEqual([], list(path.parent.glob("*.tmp.*")))

    def test_missing_packages_are_skipped_and_wrong_name_fails(self):
        self.assertEqual((0, ""), (self.run_script().returncode, self.run_script().stdout))
        path = self.manifest("pi-hermes-memory", {"name": "something-else",
                                                  "dependencies": {"@earendil-works/pi-tui": "^0.99.0"}})
        before = path.read_text(encoding="utf-8")
        self.assertNotEqual(0, self.run_script().returncode)
        self.assertEqual(before, path.read_text(encoding="utf-8"))

    def test_wrapper_reapplies_after_install_and_keeps_stdout_and_status(self):
        wrapper = SCRIPT.with_name("pi_npm_wrapper.sh")
        path = self.manifest("pi-hermes-memory", {"name": "pi-hermes-memory",
                                                  "dependencies": {"@earendil-works/pi-tui": "^0.80.2"}})
        before = path.read_text(encoding="utf-8")
        fake = self.root / "npm"  # Stands in for the package manager; no network, no install.
        fake.write_text("#!/bin/sh\necho FAKE-OUT\n[ \"$1\" = fail ] && exit 7\nexit 0\n", encoding="utf-8")
        fake.chmod(0o700)

        def call(*args):
            return subprocess.run([str(wrapper), "--", str(fake), *args], capture_output=True, text=True, timeout=30)

        view = call("view", "pi-hermes-memory", "version", "--json")
        self.assertEqual((0, "FAKE-OUT\n"), (view.returncode, view.stdout))
        self.assertEqual(before, path.read_text(encoding="utf-8"))
        self.assertEqual(7, call("fail").returncode)
        done = call("install", "pi-hermes-memory@0.9.9", "--prefix", str(self.root), "--legacy-peer-deps")
        self.assertEqual((0, "FAKE-OUT\n"), (done.returncode, done.stdout))
        self.assertIn("Adjusted host-provided peers: pi-hermes-memory", done.stderr)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(({}, {"@earendil-works/pi-tui": "*"}), (data["dependencies"], data["peerDependencies"]))


if __name__ == "__main__":
    unittest.main()
