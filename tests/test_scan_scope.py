"""Offline checks for pushed range unions and staged blob classification."""
import contextlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from publish_portable import push_snapshot  # noqa: E402


class ScanScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix="scan-scope-"))
        self.addCleanup(shutil.rmtree, self.temp)
        self.root = self.temp / "repo with space,colon:"
        self.root.mkdir()
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "test",
                    "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "test",
                    "GIT_COMMITTER_EMAIL": "test@example.invalid", "TMPDIR": str(self.root)}
        for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            self.env.pop(key, None)
        self.git("init", "-q")
        (self.root / "file").write_text("clean\n")
        self.git("add", "file")
        self.git("commit", "-qm", "initial")
        self.base = self.git("rev-parse", "HEAD")
        (self.root / "scripts").mkdir()
        (self.root / "scripts/scan.sh").write_text(
            '#!/bin/sh\nprintf "%s\\n" "$@" >>calls\ncat >scanned\n')

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
        self.assertEqual(calls[3], "--stdin")
        self.assertEqual(set((self.root / "scanned").read_text().splitlines()), {first, second})
        self.assertEqual(result.stderr.count("pre-push: result"), 1)

    def test_shared_annotated_tag_peels_and_deduplicates(self):
        tip = self.commit("shared")
        self.git("tag", "-am", "release", "portable/test")
        tag = self.git("rev-parse", "portable/test")
        self.git("update-ref", "refs/remotes/scratch/main", self.base)
        result, calls = self.hook([
            f"refs/heads/topic {tip} refs/heads/main {self.base}",
            f"refs/tags/portable/test {tag} refs/tags/portable/test {'0' * 40}",
        ])
        self.assertEqual(calls[:3], ["--level", "fail", "history"])
        self.assertEqual(calls[3], "--stdin")
        self.assertEqual((self.root / "scanned").read_text().splitlines(), [tip])
        self.assertIn(f"pre-push: result pass; range --no-walk=unsorted {tip}; level fail", result.stderr)

    def test_empty_and_deleted_refs_start_no_scan(self):
        result, calls = self.hook([
            f"refs/heads/topic {self.base} refs/heads/topic {self.base}",
            f"(delete) {'0' * 40} refs/heads/deleted {self.base}",
        ])
        self.assertEqual(calls, [])
        self.assertIn("range empty (no new commit)", result.stderr)

    def import_commits(self, ref, count):
        stream = [f"reset {ref}\nfrom {self.base}\n\n"]
        for index in range(count):
            message = f"synthetic {ref} {index}\n"
            stream.append(f"commit {ref}\ncommitter test <test@example.invalid> 1 +0000\n"
                          f"data {len(message)}\n{message}\n")
        subprocess.run(["git", "fast-import", "--quiet"], input="".join(stream),
                       cwd=self.root, env=self.env, text=True, capture_output=True, check=True)
        return self.git("rev-parse", ref)

    def test_summary_threshold_and_refusal_keep_result_contract(self):
        for count in (8, 9):
            with self.subTest(count=count):
                tip = self.import_commits("refs/heads/topic", count)
                commits = sorted(self.git("rev-list", f"{self.base}..{tip}").splitlines())
                result, _ = self.hook([
                    f"refs/heads/topic {tip} refs/heads/topic {self.base}",
                ])
                if count == 8:
                    summary = "--no-walk=unsorted " + " ".join(commits)
                else:
                    summary = f"{count} commits, first {commits[0]} last {commits[-1]}"
                self.assertIn(f"pre-push: result pass; range {summary}; level warn", result.stderr)
        (self.root / "scripts/scan.sh").write_text("#!/bin/sh\nexit 2\n")
        result = subprocess.run(["sh", str(ROOT / "scripts/git-hooks/pre-push"), "scratch"],
                                cwd=self.root, env=self.env,
                                input=f"refs/heads/topic {tip} refs/heads/topic {self.base}\n",
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"pre-push: result fail; range {summary}; level warn", result.stderr)

    def test_large_push_scans_one_union_and_publisher_keeps_short_record(self):
        self.import_commits("refs/heads/topic", 1601)
        self.import_commits("refs/heads/portable", 1601)
        commits = sorted(self.git("rev-list", "topic", "portable").splitlines())
        self.assertEqual(len(commits), 3203)
        self.assertGreater(len(" ".join(commits)), 128 * 1024)
        remote = self.root / "remote.git"
        self.git("init", "--bare", "-q", str(remote))
        self.git("remote", "add", "scratch", str(remote))
        hook = self.root / ".git/hooks/pre-push"
        shutil.copyfile(ROOT / "scripts/git-hooks/pre-push", hook)
        hook.chmod(0o755)
        with patch.dict(os.environ, self.env, clear=True), contextlib.redirect_stdout(io.StringIO()):
            result, lines = push_snapshot(self.root, ["push", "scratch", "topic", "portable"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "calls").read_text().splitlines(),
                         ["--level", "fail", "history", "--stdin"])
        self.assertEqual((self.root / "scanned").read_text().splitlines(), commits)
        self.assertEqual(lines, [f"pre-push: result pass; range {len(commits)} commits, "
                                 f"first {commits[0]} last {commits[-1]}; level fail"])
        self.assertLess(len(lines[0]), 200)
        self.assertEqual(self.git("--git-dir", str(remote), "rev-list", "--count", "--all"), "3203")

    def test_history_stdin_reaches_git_and_metadata_without_ancestor_walk(self):
        first = self.commit("first")
        excluded = self.commit("excluded")
        tip = self.commit("tip")
        blob = self.git("rev-parse", "HEAD:file")
        tree = self.git("rev-parse", "HEAD^{tree}")
        source = (ROOT / "scripts/scan.sh").read_text()
        functions = source[source.index("\nrepo_top=\n"):source.index('\n[ -n "$level" ] || level=')]
        harness = self.root / "history.sh"
        harness.write_text('set -eu\n' + functions + '''
work=$PWD/history-work
mkdir -p "$work"
: >"$work/findings"
git_shim=
trap '[ -z "$git_shim" ] || rm -rf "$git_shim"' EXIT
die() { echo "$*" >&2; exit 2; }
gl() {
    printf '%s\\n' "$@" >>"$PWD/engine-calls"
    if [ "$1" = git ]; then
        # Betterleaks starts Git with a closed stdin, not its own stdin.
        python3 -c 'import subprocess, sys
args = sys.argv[1].removeprefix("--log-opts=").split()
subprocess.run(["git", "log", "--format=%H", *args], stdin=subprocess.DEVNULL, check=True)' "$2" >"$PWD/content-commits"
    fi
}
scan_history --stdin
''')
        for text, expected in ((f"{first}\n{tip}\n{first}\n", 0), ("", 0),
                               ("--all\n", 2), ("HEAD\n", 2), ("f" * 40 + "\n", 2),
                               (blob + "\n", 2), (tree + "\n", 2)):
            with self.subTest(text=text):
                result = subprocess.run(["sh", str(harness)], cwd=self.root, env=self.env,
                                        input=text, text=True, capture_output=True)
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected == 0 and text:
                    self.assertEqual((self.root / "content-commits").read_text().splitlines(), [first, tip])
                    self.assertEqual((self.root / "history-work/commits").read_text().splitlines(), [first, tip])
                    metadata = self.root / "history-work/hist/meta"
                    self.assertTrue((metadata / f"msg-{first}").exists())
                    self.assertTrue((metadata / f"names-{tip}").exists())
                    self.assertFalse((metadata / f"msg-{excluded}").exists())
                    calls = (self.root / "engine-calls").read_text().splitlines()
                    self.assertEqual(calls.count("git"), 1)
                    self.assertIn("--log-opts=--diff-merges=first-parent --no-walk=unsorted --stdin", calls)

    def test_history_stdin_requires_the_engine_to_feed_the_commit_list(self):
        engine = self.root / "engine.sh"
        engine.write_text('''#!/bin/sh
if [ "$1" = version ]; then echo 1.9.0; exit 0; fi
if [ "$1" = git ] && [ "$TEST_ENGINE_MODE" != skip ]; then
    git log --no-walk=unsorted --stdin --format=%H </dev/null >/dev/null || exit 2
    if [ "$TEST_ENGINE_MODE" = mismatch ]; then
        echo 0 >"$SCAN_COMMITS_FED"
    fi
fi
''')
        engine.chmod(0o755)
        message = "scan: the engine did not read the commit list; the content scan did not run"
        for mode, expected in (("skip", 2), ("normal", 0), ("mismatch", 2)):
            with self.subTest(mode=mode):
                result = subprocess.run(
                    ["sh", str(ROOT / "scripts/scan.sh"), "history", "--stdin"],
                    cwd=self.root,
                    env={**self.env, "BETTERLEAKS_BIN": str(engine), "TEST_ENGINE_MODE": mode},
                    input=self.base + "\n", text=True, capture_output=True)
                self.assertEqual(result.returncode, expected, result.stderr)
                if expected == 2:
                    self.assertEqual(result.stderr.splitlines().count(message), 1)
                    self.assertNotIn("scan: 0 secret finding(s)", result.stdout)
                else:
                    self.assertNotIn(message, result.stderr)
                    self.assertIn("scan: 0 secret finding(s)", result.stdout)

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
