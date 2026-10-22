"""Documentation check: links, anchors, JSON examples, env names; offline and read-only."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from tests.support import slow
from unittest import mock

from scripts import doc_check
from scripts.doc_check import anchors, json_block, parse, resolve, slug

ROOT = Path(__file__).resolve().parents[1]
CANARY = "CANARY-DOC-7f3a"
EVENTS = []
RECORDING = []
PROCESS_EVENTS = ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.spawn", "os.system", "os.fork")


def _audit(event, args):
    # An audit hook cannot be removed; it records only while a test asks for it.
    if RECORDING and event in ("open", "socket.connect", *PROCESS_EVENTS):
        EVENTS.append((event, args[0] if args else None))


sys.addaudithook(_audit)


class UnitTests(unittest.TestCase):
    def test_slug(self):
        self.assertEqual("what-to-do", slug("What to do"))
        self.assertEqual("optional-modules", slug("Optional modules"))
        self.assertEqual("--version-the-version-flag", slug("`--version`: the version flag"))
        self.assertEqual("check-runtime-the-one-action-that-starts-a-process",
                         slug("`check-runtime`: the one action that starts a process"))

    def test_anchors_count_duplicates_and_skip_code(self):
        prose, blocks = parse("# A\n\n## A\n\n```sh\n# not a heading\n```\n## B c\n")
        self.assertEqual({"a", "a-1", "b-c"}, anchors(prose))
        self.assertEqual([("sh", 5, [(6, "# not a heading")])], blocks)

    def test_json_block(self):
        self.assertTrue(json_block(['{"a": 1}']))
        self.assertTrue(json_block(['{"a": 1}', "", '{"b": 2}']))
        self.assertFalse(json_block(['"key": 1']))
        self.assertFalse(json_block(['{"a": 1,}']))
        self.assertFalse(json_block([""]))

    def test_resolve(self):
        self.assertEqual("docs/packages.md", resolve("docs/guides/setup.md", "../packages.md"))
        self.assertEqual("README.md", resolve("docs/guides/setup.md", "../../README.md"))
        self.assertEqual("docs/guides/modules.md", resolve("docs/guides/setup.md", "./modules.md"))
        self.assertIsNone(resolve("docs/guides/setup.md", "../../../x.md"))

class InstallExampleTests(unittest.TestCase):
    """Executable install blocks and validated JSON examples, without prose pins."""

    DOCS = ("INSTALL.md",)

    @slow
    def test_install_blocks_read_and_use_the_pin_in_one_shell(self):
        shells = ["/bin/sh"]
        if shutil.which("bash"):
            shells.append(shutil.which("bash"))
        with tempfile.TemporaryDirectory(prefix="tenantpi-install-block-") as temp:
            root = Path(temp)
            (root / "config").mkdir()
            binary, home, agent = root / "bin", root / "home", root / "empty-agent"
            for directory in (binary, home, agent):
                directory.mkdir()
            npm = binary / "npm"
            npm.write_text("#!" + sys.executable + "\nimport json, os, pathlib, sys\n"
                           'pathlib.Path(os.environ["HOME"], "npm-call.json").write_text(json.dumps(sys.argv[1:]))\n')
            npm.chmod(0o700)
            env = {"PATH": str(binary) + os.pathsep + str(Path(sys.executable).parent) + ":/usr/bin:/bin",
                   "HOME": str(home), "TMPDIR": temp, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
                   "PI_CODING_AGENT_DIR": str(agent)}
            record = home / "npm-call.json"
            for name in self.DOCS:
                blocks = parse((ROOT / name).read_text(encoding="utf-8"))[1]
                installs = [lines[:3] for language, _, lines in blocks
                            if language == "sh" and any('"${pin:?}"' in line for _, line in lines)]
                self.assertTrue(installs, name)
                for lines in installs:
                    command = "\n".join(line for _, line in lines)
                    for shell in shells:
                        for value in ("9.9.9", "", None):
                            with self.subTest(name=name, command=lines[-1][1], shell=shell, value=value):
                                if record.exists():
                                    record.unlink()
                                (root / "config/manifest.json").write_text(json.dumps({"runtime": {"piVersion": value}})
                                                                         if value is not None else "invalid JSON")
                                result = subprocess.run([shell, "-c", command], cwd=root, env=env,
                                                        stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
                                if value == "9.9.9":
                                    self.assertEqual(0, result.returncode, result.stderr)
                                    self.assertEqual("@earendil-works/pi-coding-agent@9.9.9", json.loads(record.read_text())[-1])
                                else:
                                    self.assertNotEqual(0, result.returncode)
                                    self.assertFalse(record.exists())
                        if record.exists():
                            record.unlink()
                        result = subprocess.run([shell, "-c", command], cwd=home, env=env,
                                                stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
                        self.assertNotEqual(0, result.returncode)
                        self.assertFalse(record.exists())

    @classmethod
    def setUpClass(cls):
        cls.texts = {name: (ROOT / name).read_text(encoding="utf-8") for name in cls.DOCS}

    def test_peer_override_uses_the_clone_path(self):
        shown = re.compile(r"PI_CODING_AGENT_DIR=\S+ node (\S+)")
        for name in (*self.DOCS, "POST_INSTALL.md"):
            text = (ROOT / name).read_text(encoding="utf-8")
            with self.subTest(name=name):
                self.assertNotIn("node scripts/patch_extension_peers.mjs", text)
                paths = shown.findall(text)
                self.assertTrue(paths)
                for path in paths:
                    self.assertIn(path, ("<clone>/scripts/patch_extension_peers.mjs",
                                         '"$HOME/tenant-pi/scripts/patch_extension_peers.mjs"'))

    def test_directory_docs_are_checked_and_denied_docs_are_omitted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "docs/extra").mkdir(parents=True)
            (root / "scripts").mkdir()
            name = "docs/extra/new-guide.md"
            (root / name).write_text("# New guide\n")
            self.assertNotIn(name, doc_check.PUBLISH)
            with mock.patch.object(doc_check, "private_excludes", wraps=doc_check.private_excludes) as excludes:
                self.assertIn(name, doc_check.document_files(root))
                excludes.assert_called_once_with(root)
            (root / doc_check.DEV_ONLY_REL).write_text(name + "\n")
            self.assertNotIn(name, doc_check.document_files(root))
            self.assertFalse(doc_check.published(name, root))

    def test_private_excluded_package_links_are_not_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "scripts").mkdir()
            (root / "scripts/dev-only-files.txt").write_text("packages/tenantext/private/\n")
            self.assertFalse(doc_check.published("packages/tenantext/private/note.md", root))
            self.assertFalse(doc_check.published("packages/tenantext/private", root))
            self.assertTrue(doc_check.published("packages/tenantext/private-other/note.md", root))


class PostInstallTests(unittest.TestCase):
    """`POST_INSTALL.md`: the guide for the time after a base install."""

    NAME = "POST_INSTALL.md"

    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / cls.NAME).read_text(encoding="utf-8")
        cls.prose, cls.blocks = parse(cls.text)

    def test_the_install_skill_has_no_finding(self):
        from tests.test_skill_invariants import TRACKER, skill_findings
        self.assertEqual([], skill_findings([ROOT / "skills/tenant-pi-install"], TRACKER,
                                           require_credits=False))


class TreeTests(unittest.TestCase):
    """`check` on a synthetic tree; the publish set is patched to the synthetic files."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="tenantpi-doc-check-"))
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "config").mkdir()
        shutil.copy(ROOT / "config/manifest.json", self.root / "config/manifest.json")
        (self.root / "docs/guides").mkdir(parents=True)
        self.files = {
            "README.md": "# Kit\n\nSee [setup](docs/guides/setup.md#stage-one) and [ref](docs/ref.md).\n",
            "docs/ref.md": "# Ref\n\n## Part two\n",
            "docs/guides/setup.md": "# Setup\n\n## Stage one\n\n```sh\n./install.sh\n```\n",
        }

    def run_check(self, extra=None):
        files = {**self.files, **(extra or {})}
        for name, text in files.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text(text, encoding="utf-8")
        with mock.patch.object(doc_check, "PUBLISH", tuple(files)):
            return doc_check.check(self.root, files)

    def test_clean_tree(self):
        findings, counts = self.run_check()
        self.assertEqual([], findings)
        self.assertEqual({"files": 3, "links": 2, "json": 0}, counts)

    def test_each_rule(self):
        cases = {
            "link_missing": "[x](absent.md)",
            "anchor_missing": "[x](ref.md#" + CANARY.lower() + ")",
            "link_outside": "[x](../../../" + CANARY + ".md)",
            "link_unpublished": "[x](../design.md)",
            "json_example": "```json\n\"" + CANARY + "\": 1\n```",
        }
        (self.root / "design.md").write_text("# Design\n", encoding="utf-8")
        for rule, text in cases.items():
            with self.subTest(rule=rule):
                findings, _ = self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})
                self.assertEqual([rule + ": docs/other.md:3"], findings)
                self.assertNotIn(CANARY, "".join(findings))

    def test_a_link_into_an_absent_tree_folder_is_no_finding(self):
        link = "# Other\n\n[x](../packages/openviking-pi/README.md)\n"
        self.assertEqual([], self.run_check({"docs/other.md": link})[0])
        # The folder is present, so the missing file is a finding.
        (self.root / "packages/openviking-pi").mkdir(parents=True)
        (self.root / "packages/openviking-pi/index.ts").write_text("export {};\n", encoding="utf-8")
        self.assertEqual(["link_missing: docs/other.md:3"], self.run_check({"docs/other.md": link})[0])

    def test_guide_only_rules(self):
        guide = self.files["docs/guides/setup.md"]
        text = "Export `TENANTEXT_" + CANARY.upper().replace("-", "_") + "`."
        findings, _ = self.run_check({"docs/guides/setup.md": guide + "\n" + text + "\n"})
        self.assertEqual(["env_name: docs/guides/setup.md:" + str(guide.count("\n") + 2)], findings)
        # Other reference pages do not use the strict environment rule.
        self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
        self.assertEqual([], self.run_check({"docs/guides/setup.md": guide + "\nSet `PI_CODING_AGENT_DIR` and "
                                             "`TENANTEXT_LITELLM_API_KEY`.\n"})[0])

    def test_install_counts_as_a_guide(self):
        guide = self.files["docs/guides/setup.md"]
        self.files["docs/guides/setup.md"] = "# Setup\n\n## Stage one\n\n[Install](../../INSTALL.md)\n"
        self.assertEqual([], self.run_check({"INSTALL.md": guide})[0])
        findings, _ = self.run_check({"INSTALL.md": guide + "\nSet `PI_" + CANARY.upper().replace("-", "_") + "`.\n"})
        self.assertEqual(["env_name: INSTALL.md:" + str(guide.count("\n") + 2)], findings)

    def test_dev_only_target(self):
        text = "[notes](dev/notes.md)"
        (self.root / "scripts").mkdir()
        (self.root / doc_check.DEV_ONLY_REL).write_text("docs/dev/\n")
        with mock.patch.object(doc_check, "DEV_ONLY_TARGETS", ("docs/dev/notes.md",)):
            self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
            (self.root / "docs/dev").mkdir()
            (self.root / "docs/dev/notes.md").write_text("# Notes\n", encoding="utf-8")
            self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
        # Without the entry, the same link is a finding.
        self.assertEqual(["link_unpublished: docs/other.md:3"], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])


@slow
class DocCheckRepoTests(unittest.TestCase):
    """The documentation check on the real publish set of this repository: the unit test run holds it."""

    def test_publish_set_has_no_finding_without_process_or_write(self):
        before = {p: p.stat().st_mtime_ns for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts}
        out = io.StringIO()
        EVENTS.clear()
        RECORDING.append(True)
        try:
            findings, counts = doc_check.check(ROOT)
            with contextlib.redirect_stdout(out):
                code = doc_check.main()
        finally:
            RECORDING.clear()
        # Each finding is `rule: path:line`; the failure text names every one.
        self.assertEqual([], findings, "run `python3 scripts/doc_check.py` for the same list")
        self.assertGreater(counts["links"], 0)
        self.assertEqual(0, code, out.getvalue())
        self.assertTrue(out.getvalue().startswith("doc check valid: "))
        self.assertEqual([], [event for event in EVENTS if event[0] != "open"])
        writes = [event for event in EVENTS if event[0] == "open" and isinstance(event[1], str)
                  and not event[1].startswith(str(ROOT))]
        self.assertEqual([], [w for w in writes if not w[1].startswith(sys.prefix) and "/usr/" not in w[1]])
        after = {p: p.stat().st_mtime_ns for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts}
        self.assertEqual(before, after)
        second = io.StringIO()
        with contextlib.redirect_stdout(second):
            doc_check.main()
        self.assertEqual(out.getvalue(), second.getvalue())


if __name__ == "__main__":
    unittest.main()
