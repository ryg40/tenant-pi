"""Offline checks for pushed range unions and staged blob classification."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ScanScopeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="scan-scope-"))
        self.addCleanup(shutil.rmtree, self.root)
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "test",
                    "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "test",
                    "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            self.env.pop(key, None)
        self.git("init", "-q")
        (self.root / "file").write_text("clean\n")
        self.git("add", "file")
        self.git("commit", "-qm", "initial")
        self.base = self.git("rev-parse", "HEAD")
        (self.root / "scripts").mkdir()
        (self.root / "scripts/scan.sh").write_text(
            '#!/bin/sh\nprintf "%s\\n" "$@" >>calls\n')

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, env=self.env,
                              text=True, capture_output=True, check=True).stdout.strip()

    def commit(self, text):
        (self.root / "file").write_text(text + "\n")
        self.git("add", "file")
        self.git("commit", "-qm", text)
        return self.git("rev-parse", "HEAD")

    def hook(self, rows):
        result = subprocess.run(["sh", str(ROOT / "scripts/git-hooks/pre-push"), "scratch"],
                                cwd=self.root, env=self.env, input="\n".join(rows) + "\n",
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.root / "calls"
        return result, calls.read_text().splitlines() if calls.exists() else []

    def test_overlapping_ranges_use_exact_union_and_strictest_level(self):
        first = self.commit("first")
        second = self.commit("second")
        result, calls = self.hook([
            f"refs/heads/topic {second} refs/heads/topic {first}",
            f"refs/heads/portable {first} refs/heads/release {self.base}",
        ])
        self.assertEqual(calls[:3], ["--level", "fail", "history"])
        self.assertEqual(len(calls), 4)
        self.assertEqual(set(calls[3].split()[1:]), {first, second})
        self.assertEqual(calls[3].split()[0], "--no-walk=unsorted")
        self.assertEqual(calls[3], calls[3].strip())
        self.assertEqual(result.stderr.count("pre-push: result"), 1)

    def test_shared_annotated_tag_peels_and_deduplicates(self):
        tip = self.commit("shared")
        self.git("tag", "-am", "release", "portable/test")
        tag = self.git("rev-parse", "portable/test")
        self.git("update-ref", "refs/remotes/scratch/main", self.base)
        _, calls = self.hook([
            f"refs/heads/topic {tip} refs/heads/main {self.base}",
            f"refs/tags/portable/test {tag} refs/tags/portable/test {'0' * 40}",
        ])
        self.assertEqual(calls[:3], ["--level", "fail", "history"])
        self.assertEqual(calls[3].split(), ["--no-walk=unsorted", tip])

    def test_empty_and_deleted_refs_start_no_scan(self):
        result, calls = self.hook([
            f"refs/heads/topic {self.base} refs/heads/topic {self.base}",
            f"(delete) {'0' * 40} refs/heads/deleted {self.base}",
        ])
        self.assertEqual(calls, [])
        self.assertIn("range empty (no new commit)", result.stderr)

    def test_binary_version_accepts_both_forms_and_rejects_other_versions(self):
        source = (ROOT / "scripts/scan.sh").read_text()
        function = source.split("select_engine() {", 1)[1].split("\n}\n", 1)[0]
        harness = self.root / "version.sh"
        harness.write_text('''
BETTERLEAKS_VERSION=1.9.0
BETTERLEAKS_BIN=betterleaks
die() { echo "$*" >&2; exit 2; }
betterleaks() { echo "$TEST_VERSION"; }
select_engine() {''' + function + '\n}\nselect_engine\n')
        for version, expected in (("1.9.0", 0), ("v1.9.0", 0), ("1.8.0", 2), ("", 2)):
            with self.subTest(version=version):
                result = subprocess.run(["sh", str(harness)], cwd=self.root,
                                        env={**self.env, "TEST_VERSION": version},
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_staged_classification_covers_new_content_and_renames_only(self):
        # Load the actual functions, but do not start a scanner or its main block.
        source = (ROOT / "scripts/scan.sh").read_text()
        functions = source[source.index("\nrepo_top=\n"):source.index('\n[ -n "$level" ] || level=')]
        harness = self.root / "functions.sh"
        harness.write_text(functions + '''
work=$PWD/scratch
mkdir -p "$work"
: >"$work/findings"
gl() { :; }
mode=staged
scan_staged
cat "$work/findings"
''')
        (self.root / "old.zip").write_text("old\n")
        self.git("add", "old.zip")
        self.git("commit", "-qm", "existing policy fixture")
        self.git("mv", "file", "renamed.zip")
        (self.root / "new.bin").write_bytes(bytes.fromhex("1f8b") + b"synthetic")
        (self.root / "link").symlink_to("target")
        self.git("add", "new.bin", "link")
        result = subprocess.run(["sh", str(harness)], cwd=self.root, env=self.env,
                                text=True, capture_output=True, check=True)
        self.assertIn("policy-archive\trenamed.zip", result.stdout)
        self.assertIn("policy-archive\tnew.bin", result.stdout)
        self.assertNotIn("old.zip", result.stdout)
        blobs = (self.root / "scratch/blobs").read_text()
        self.assertIn("\tlink\t", blobs)
        self.assertNotIn("\tfile\t", blobs)


if __name__ == "__main__":
    unittest.main()
