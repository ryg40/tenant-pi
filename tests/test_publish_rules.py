"""Directory rule tests for the publish set: include, exclude, and an unlisted file.

Also the public reader rules: a negative control for each class, the two exception lists, and
the check on the publish set of this repository.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import publish_check  # noqa: E402
from publish_portable import publish_tracked, snapshot  # noqa: E402
from validate import Invalid  # noqa: E402

RULES = (("packages/demo", ("notes/", "DRAFT.md")),)
TRACKED = {
    "README.md", "packages/demo/index.mjs", "packages/demo/src/a.mjs", "packages/demo/notes/plan.md",
    "packages/demo/DRAFT.md", "packages/demo/src/DRAFT.md", "packages/demo-other/x.txt", "packages/demo.txt",
}


def git(root, *args):
    return subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=True).stdout.strip()


def repository_files(root):
    """Use tracked paths when available, otherwise the same inventory as check()."""
    tracked = publish_check.tracked_files(root)
    if tracked is not None:
        return tracked
    excluded = {".local", ".git", "__pycache__", "node_modules"}
    return {path.relative_to(root).as_posix() for path in root.rglob("*")
            if path.is_file() and not excluded.intersection(path.relative_to(root).parts)
            and not any(path.relative_to(root).as_posix().startswith(name + "/")
                        for name in publish_check.BUILD_DIRS)}


class RuleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-rules-empty-")
        self.addCleanup(temp.cleanup)
        self.empty_root = Path(temp.name)

    def test_rule_includes_each_file_under_the_directory(self):
        published, _ = publish_check.rule_files(TRACKED, RULES)
        self.assertEqual({"packages/demo/index.mjs", "packages/demo/src/a.mjs", "packages/demo/src/DRAFT.md"}, published)

    def test_rule_excludes_a_directory_prefix_and_an_exact_file(self):
        published, excluded = publish_check.rule_files(TRACKED, RULES)
        self.assertEqual({"packages/demo/notes/plan.md", "packages/demo/DRAFT.md"}, excluded)
        self.assertFalse(published & excluded)

    def test_rule_does_not_reach_a_sibling_path(self):
        published, excluded = publish_check.rule_files(TRACKED, RULES)
        self.assertFalse({"packages/demo-other/x.txt", "packages/demo.txt", "README.md"} & (published | excluded))

    def test_publish_files_keeps_the_explicit_tuple_first(self):
        names = publish_check.publish_files(TRACKED, RULES, root=self.empty_root)
        self.assertEqual(publish_check.PUBLISH, names[:len(publish_check.PUBLISH)])
        self.assertEqual(("packages/demo/index.mjs", "packages/demo/src/DRAFT.md", "packages/demo/src/a.mjs"),
                         names[len(publish_check.PUBLISH):])

    def test_no_rule_gives_the_explicit_tuple(self):
        self.assertEqual(publish_check.PUBLISH, publish_check.publish_files(TRACKED, (), root=self.empty_root))

    def test_optional_private_list_exact_prefix_missing_and_source_ref(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-excludes-") as temp:
            root = Path(temp)
            names = {"packages/demo/a.txt", "packages/demo/notes/a.md", "packages/demo/notes-other/a.md"}
            rules = (("packages/demo", ()),)
            self.assertEqual(names, set(publish_check.publish_files(names, rules, root=root)) - set(publish_check.PUBLISH))
            path = root / publish_check.DEV_ONLY_REL
            path.parent.mkdir()
            path.write_text("# reviewed\n\npackages/demo/a.txt\npackages/demo/notes/\n")
            self.assertEqual({"packages/demo/notes-other/a.md"},
                             set(publish_check.publish_files(names, rules, root=root)) - set(publish_check.PUBLISH))
            git(root, "init", "-q", "-b", "main")
            git(root, "config", "user.name", "test")
            git(root, "config", "user.email", "test@example.invalid")
            git(root, "add", ".")
            git(root, "commit", "-qm", "list")
            path.write_text("packages/demo/notes-other/\n")
            self.assertEqual({"packages/demo/notes-other/a.md"},
                             set(publish_check.publish_files(names, rules, root=root, ref="HEAD")) - set(publish_check.PUBLISH))
            for text in ("../outside", "/absolute", "a//b", "a/./b"):
                path.write_text(text)
                with self.assertRaises(Invalid):
                    publish_check.private_excludes(root)
            path.write_text("README.md\n")
            with self.assertRaisesRegex(Invalid, "private_excludes_explicit"):
                publish_check.publish_files(names, rules, root=root)

    def test_invalid_exclusions_fail_in_committed_snapshot_and_check(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-exclusion-errors-") as temp:
            root = Path(temp)
            names = {"packages/demo/notes/a.md", "packages/demo/image.png"}
            for name in names:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes(b"\x89PNG\r\n" if name.endswith(".png") else b"note")
            path = root / publish_check.DEV_ONLY_REL
            path.parent.mkdir()
            git(root, "init", "-q", "-b", "main")
            git(root, "config", "user.name", "test")
            git(root, "config", "user.email", "test@example.invalid")
            cases = (
                ("packages/demo/notes", "private_exclude_directory"),
                ("packages/demo/notez/", "private_exclude_unused"),
                ("packages/demo/stale.md", "private_exclude_unused"),
                ("packages/demo/notes/ # private", "private_exclude_text"),
                ("packages/demo/imag.png", "private_exclude_unused"),
            )
            for entry, code in cases:
                with self.subTest(entry=entry):
                    path.write_text(entry + "\n")
                    git(root, "add", ".")
                    git(root, "commit", "-qm", "exclusion fixture")
                    tracked = publish_check.tracked_files(root)
                    with self.assertRaisesRegex(Invalid, "^" + code + ":"):
                        publish_check.publish_files(tracked, (("packages/demo", ()),), root=root, ref="HEAD")
                    with unittest.mock.patch.object(publish_check, "ROOT", root), \
                            unittest.mock.patch.object(publish_check, "tracked_files", return_value=tracked):
                        with self.assertRaisesRegex(Invalid, "^" + code + ":"):
                            publish_check.check()
            path.write_bytes(b"# comment\r\npackages/demo/notes/  \r\npackages/demo/image.png\r\n")
            entries = publish_check.private_excludes(root)
            publish_check.validate_private_excludes(entries, names)
            with unittest.mock.patch.object(Path, "read_text", side_effect=PermissionError):
                with self.assertRaisesRegex(Invalid, "^private_exclude_unreadable:"):
                    publish_check.private_excludes(root)

    def test_tracked_file_under_node_modules_is_rejected(self):
        publish_check.node_modules_guard(TRACKED)
        with self.assertRaisesRegex(Invalid, "^tracked_in_node_modules: packages/demo/node_modules/yaml/package.json$"):
            publish_check.node_modules_guard(TRACKED | {"packages/demo/node_modules/yaml/package.json"})
        with self.assertRaisesRegex(Invalid, "^tracked_in_node_modules: node_modules/x.js$"):
            publish_check.node_modules_guard({"README.md", "node_modules/x.js"})
        # Only a path part with the exact name counts.
        publish_check.node_modules_guard({"docs/node_modules.md", "packages/demo/my_node_modules/a.js"})

    def test_snapshot_holds_the_rule_files_without_the_excludes(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-rules-test-") as temp:
            root = Path(temp)
            git(root, "init", "-q", "-b", "main")
            git(root, "config", "user.email", "test@example.invalid")
            git(root, "config", "user.name", "test")
            for name in TRACKED:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(name + "\n")
            git(root, "add", "-A")
            git(root, "commit", "-q", "-m", "first")
            (root / "packages/demo/untracked.txt").write_text("not tracked\n")
            tracked = publish_check.tracked_files(root, "HEAD")
            self.assertEqual(TRACKED, tracked)
            self.assertEqual(TRACKED, publish_check.tracked_files(root))
            published, _ = publish_check.rule_files(tracked, RULES)
            snapshot(root, published, "HEAD", "portable", message="one")
            self.assertEqual(sorted(published), git(root, "ls-tree", "-r", "--name-only", "portable").splitlines())

    def test_tracked_files_is_none_without_a_repository_at_the_root(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-rules-test-") as temp:
            self.assertIsNone(publish_check.tracked_files(Path(temp)))

    def test_publisher_stops_without_git_metadata(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-rules-test-") as temp:
            with self.assertRaises(SystemExit) as stop:
                publish_tracked(Path(temp), "HEAD")
            self.assertEqual("publish_tracked: git metadata required", str(stop.exception))


# Synthetic values of each class of the public reader rules. Each value is built at run time
# from parts, so that this file holds no match of a rule (it is in the publish set too).
WORD, TICKET, DATE = "iss" + "ue", "tick" + "et", "20" + "30-01-02"
ONE_HOST = "refer" + "ence host"
SYNTHETIC = {
    "tracker-reference": (f"See {WORD} 59 for the reason.", f"({WORD} 59)", f"{WORD.capitalize()}s 59 to 63 give the rule.",
                          f"{TICKET.capitalize()} 9 qualifies it.", f"the {WORD} #12", "ma" + "p 43 has the order",
                          "owner deci" + "sion D9"),
    "machine-path": ("cd /ro" + "ot/.pi/agent", "PI_CODING_AGENT_DIR=/ro" + "ot/x pi", "the clone in /opt/" + "stacks/kit",
                     '"/opt/' + 'stacks"'),
    "host-record": (f"Observed on the {ONE_HOST}: the load fails.", f"Veri" + f"fied on {DATE} with Pi 1.0.2.",
                    "Obser" + f"vation of {DATE}: the file is new.", "Owner deci" + f"sion {DATE}: the pin moves.",
                    f"{DATE}: the pin moved on th" + "is host.", "Seen on the la" + f"b VM on {DATE}."),
}
# Text that looks similar and is not a finding.
CLEAN = ("An issue of the tracker has a number.", "Report an issue to the package author.", "tissue 5 and reissue 7",
         "/rootfs and /optional/stacks", "https://example.invalid/ro" + "ot/a", "~/root is a directory name",
         "The roadmap 2 and the map of 1.5 values", "Write the log on this host.", "Gate 6 needs a clean user.",
         "Observed with Pi 1.0.2: the file is new.", "Not verified: the same on macOS.", "a decision of the maintainer",
         "Released on " + DATE + ".", "version 1.0.3 and " + DATE + "T12:00:00Z")
DENY_VALUE = "host" + "name-" + "canary-51d0"


class PublicReaderTests(unittest.TestCase):
    """The public reader rules on synthetic files in a temporary root."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-public-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def findings(self, lines, name="doc.md", **lists):
        (self.root / name).parent.mkdir(parents=True, exist_ok=True)
        (self.root / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
        options = {"deny": [], "allow": [], "accepted": set(), **lists}
        return publish_check.public_findings([name], self.root, **options)

    def test_negative_control_finds_a_synthetic_value_of_each_class(self):
        self.assertEqual(set(SYNTHETIC), {rule for rule, _ in publish_check.PUBLIC_RULES})
        for rule, values in SYNTHETIC.items():
            for value in values:
                with self.subTest(rule=rule, value=value):
                    self.assertEqual([("doc.md", 2, rule)], self.findings(["clean line", value]))

    def test_negative_control_finds_a_deny_list_value_in_each_case(self):
        deny = [("host-value-local-1", DENY_VALUE)]
        for value in (DENY_VALUE, DENY_VALUE.upper(), "ssh user@" + DENY_VALUE + ":22"):
            with self.subTest(value=value):
                self.assertEqual([("doc.md", 1, "host-value-local-1")], self.findings([value], deny=deny))
        # One line can break two rules; each is one finding.
        both = self.findings([f"{DENY_VALUE} in {WORD} 5"], deny=deny)
        self.assertEqual([("doc.md", 1, "host-value-local-1"), ("doc.md", 1, "tracker-reference")], both)
        # A finding holds the path, the line number and the rule id, never the value.
        self.assertNotIn(DENY_VALUE, repr(both))

    def test_clean_text_gives_no_finding(self):
        self.assertEqual([], self.findings(list(CLEAN), deny=[("host-value-local-1", DENY_VALUE)]))

    def test_the_rule_sources_do_not_match_themselves(self):
        # scripts/publish_check.py and this file are in the publish set.
        for name in ("scripts/publish_check.py", "tests/test_publish_rules.py"):
            with self.subTest(name=name):
                self.assertEqual([], publish_check.public_findings([name], ROOT, deny=[], allow=[], accepted=set()))

    def test_allowed_url_drops_a_deny_value_only_inside_the_url(self):
        deny = [("host-value-local-1", DENY_VALUE)]
        url = "https://" + DENY_VALUE + ".invalid/a/b.git"
        self.assertEqual([], self.findings(["url = " + url], deny=deny, allow=[url]))
        self.assertEqual(1, len(self.findings([f"url = {url} on {DENY_VALUE}"], deny=deny, allow=[url])))
        # A URL that differs in one character is a finding.
        self.assertEqual(1, len(self.findings(["url = " + url[:-1]], deny=deny, allow=[url])))
        # The allow list hides no finding of a rule.
        self.assertEqual([("doc.md", 1, "tracker-reference")], self.findings([f"{url} {WORD} 5"], deny=deny, allow=[url]))

    def test_accepted_line_is_the_exact_text_of_one_file(self):
        line = f"The fixture names {WORD} 18 of a test tracker."
        digest = hashlib.sha256(line.encode()).hexdigest()
        self.assertEqual([], self.findings([line], accepted={("doc.md", digest)}))
        # A changed line, and the same line in another file, are findings again.
        self.assertEqual(1, len(self.findings([line + " "], accepted={("doc.md", digest)})))
        self.assertEqual(1, len(self.findings([line], name="other.md", accepted={("doc.md", digest)})))

    def test_lists_are_read_from_the_files_of_the_scan(self):
        (self.root / "scripts").mkdir()
        line = "host = " + DENY_VALUE
        (self.root / "scripts/host-values.deny").write_text("# tracked list\n", encoding="utf-8")
        (self.root / "scripts/host-values.allow").write_text("# no URL\n", encoding="utf-8")
        (self.root / "scripts/host-values.allow-lines").write_text(
            "# accepted\nok.md\t" + hashlib.sha256(line.encode()).hexdigest() + "\n", encoding="utf-8")
        local = self.root / "local.deny"
        local.write_text("# values of one host\n\n  " + DENY_VALUE.upper() + "  \n", encoding="utf-8")
        for name in ("doc.md", "ok.md"):
            (self.root / name).write_text(line + "\n", encoding="utf-8")
        with unittest.mock.patch.dict(os.environ, {"SCAN_LOCAL_DENY": str(local)}):
            self.assertEqual([("host-value-local-1", DENY_VALUE.upper())], publish_check.deny_rules(self.root))
            self.assertEqual([("doc.md", 1, "host-value-local-1")], publish_check.public_findings(["doc.md", "ok.md"], self.root))
            # A deny list is not searched for its own patterns.
            (self.root / "scripts/host-values.deny").write_text(DENY_VALUE + "\n", encoding="utf-8")
            self.assertEqual([], publish_check.public_findings(["scripts/host-values.deny"], self.root))
        with unittest.mock.patch.dict(os.environ, {"SCAN_LOCAL_DENY": str(self.root / "absent")}):
            self.assertEqual([("host-value-1", DENY_VALUE)], publish_check.deny_rules(self.root))

    def test_publish_set_of_this_repository_has_no_finding(self):
        # The files under a `PUBLIC_PENDING` prefix are not checked yet; an empty tuple checks each file.
        names = [name for name in publish_check.publish_files(repository_files(ROOT))
                 if (ROOT / name).is_file() and not name.startswith(publish_check.PUBLIC_PENDING)]
        self.assertGreater(len(names), 50)
        findings = [f"{rule}: {name}:{line}" for name, line, rule in publish_check.public_findings(names, ROOT)]
        self.assertEqual([], findings, "run `python3 scripts/publish_check.py --public` for the same list")


    def test_public_reader_uses_inventory_without_git_metadata(self):
        with unittest.mock.patch.object(publish_check, "tracked_files", return_value=None):
            self.test_publish_set_of_this_repository_has_no_finding()

    def test_inventory_fallback_does_not_replace_an_empty_git_index(self):
        with unittest.mock.patch.object(publish_check, "tracked_files", return_value=set()):
            self.assertEqual(set(), repository_files(ROOT))


class CheckTests(unittest.TestCase):
    """Run the check on a copy of this tree, so that the checkout stays unchanged."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-rules-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "copy"
        tracked = publish_check.tracked_files(ROOT)
        if tracked is None:
            shutil.copytree(ROOT, self.root, ignore=shutil.ignore_patterns(".git", ".local", "__pycache__"))
        else:
            for name in tracked:
                (self.root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, self.root / name)

    def run_check(self, rules=None, pending=None, arguments=()):
        path = self.root / "scripts/publish_check.py"
        text = path.read_text(encoding="utf-8")
        if rules is not None:
            # Add the test rules before the rules of the in-tree packages.
            self.assertEqual(1, text.count("\nPUBLISH_DIRS = (\n"))
            text = text.replace("\nPUBLISH_DIRS = (\n", f"\nPUBLISH_DIRS = {rules!r} + (\n")
        if pending is not None:
            # The one line that says which paths the public reader rules do not check yet.
            text, count = re.subn(r"(?m)^PUBLIC_PENDING = .*$", f"PUBLIC_PENDING = {pending!r}", text)
            self.assertEqual(1, count)
        path.write_text(text, encoding="utf-8")
        # The copy has no local deny list; a list of the caller must not reach it.
        env = {name: value for name, value in os.environ.items() if name != "SCAN_LOCAL_DENY"}
        return subprocess.run([sys.executable, "-B", "scripts/publish_check.py", *arguments], cwd=self.root, text=True,
                              capture_output=True, env=env)

    def add(self, name, text="content\n"):
        (self.root / name).parent.mkdir(parents=True, exist_ok=True)
        (self.root / name).write_text(text)

    def test_copy_is_valid(self):
        result = self.run_check()
        self.assertEqual(0, result.returncode, result.stderr)

    def test_private_list_excludes_package_file_and_private_prefix(self):
        path = self.root / publish_check.DEV_ONLY_REL
        existing = path.read_text() if path.exists() else ""
        path.write_text(existing + "\npackages/demo/private/\nnotes/\n")
        self.add("packages/demo/index.mjs")
        self.add("packages/demo/private/a.md", f"See {WORD} 59.\n")
        self.add("notes/a.md", "private\n")
        result = self.run_check((("packages/demo", ()),))
        self.assertEqual(0, result.returncode, result.stderr)
        self.add("notes-other/a.md")
        result = self.run_check()
        self.assertIn("unreviewed_file", result.stderr)

    def test_file_under_no_rule_is_rejected(self):
        self.add("packages/demo/index.mjs")
        result = self.run_check()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("unreviewed_file", result.stderr)

    def test_tracked_file_under_a_build_output_directory_is_rejected(self):
        publish_check.build_output_guard(TRACKED)
        with self.assertRaisesRegex(Invalid, "^tracked_build_output: packages/promptr/dist/src/a.mjs$"):
            publish_check.build_output_guard(TRACKED | {"packages/promptr/dist/src/a.mjs"})
        publish_check.build_output_guard({"packages/promptr/distribution.md", "packages/tenantext/dist/a.js"})

    def test_untracked_promptr_build_output_is_ignored(self):
        self.add("packages/promptr/dist/src/extension/index.mjs", "export {};\n")
        result = self.run_check()
        self.assertEqual(0, result.returncode, result.stderr)

    def test_untracked_node_modules_directory_is_ignored(self):
        self.add("packages/tenantext/node_modules/yaml/package.json", "{}\n")
        self.add("node_modules/.package-lock.json", "{}\n")
        result = self.run_check()
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn(f"{len(publish_check.publish_files(repository_files(ROOT)))} files", result.stdout)

    def test_rule_accepts_the_directory_and_counts_its_files(self):
        self.add("packages/demo/index.mjs")
        self.add("packages/demo/src/a.mjs")
        tracked = repository_files(ROOT)
        self.add("packages/demo/notes/plan.md")
        result = self.run_check(RULES)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn(f"{len(publish_check.publish_files(tracked)) + 2} files", result.stdout)

    def test_file_outside_the_rule_directory_is_rejected(self):
        self.add("packages/demo/index.mjs")
        self.add("packages/other/index.mjs")
        result = self.run_check(RULES)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("unreviewed_file", result.stderr)

    def test_rule_file_with_a_secret_pattern_is_rejected(self):
        self.add("packages/demo/index.mjs", "password = " + "Abc123" * 5 + "\n")
        result = self.run_check(RULES)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("publish_secret_pattern", result.stderr)

    def test_explicit_file_with_a_public_reader_finding_is_rejected(self):
        text = (self.root / "README.md").read_text(encoding="utf-8")
        self.add("README.md", text + f"\nSee {WORD} 59.\n")
        result = self.run_check()
        self.assertNotEqual(0, result.returncode)
        self.assertEqual("publish_public_reader: README.md", result.stderr.strip())
        # The report names the line and the rule, and no text of the file.
        report = self.run_check(arguments=("--public",))
        self.assertEqual(1, report.returncode)
        self.assertIn(f"tracker-reference: README.md:{text.count(chr(10)) + 2}\n", report.stdout)
        self.assertNotIn(f"{WORD} 59", report.stdout + report.stderr)
        hashes = self.run_check(arguments=("--public", "--hashes"))
        self.assertIn("README.md\t" + hashlib.sha256(f"See {WORD} 59.".encode()).hexdigest() + "\n", hashes.stdout)

    def test_pending_prefix_is_not_checked_and_an_empty_tuple_checks_each_file(self):
        self.add("packages/demo/index.mjs", f"// {WORD} 59\n")
        self.add("packages/demo/notes/plan.md")
        self.assertEqual(0, self.run_check(RULES, pending=("packages/",)).returncode)
        result = self.run_check(pending=("packages/tenantext/", "packages/promptr/"))
        self.assertNotEqual(0, result.returncode)
        self.assertEqual("publish_public_reader: packages/demo/index.mjs", result.stderr.strip())

    def test_unknown_argument_is_a_usage_error(self):
        result = self.run_check(arguments=("--bogus",))
        self.assertNotEqual(0, result.returncode)
        self.assertIn("usage: publish_check.py", result.stderr)

    def test_explicit_file_under_a_rule_is_a_duplicate(self):
        result = self.run_check((("docs", ()),))
        self.assertNotEqual(0, result.returncode)
        self.assertIn("publish_duplicates", result.stderr)

    def test_allowed_exact_line_passes(self):
        path, line = publish_check.PATTERN_ALLOW[0]
        self.assertIn(line, (self.root / path).read_text(encoding="utf-8").split("\n"))
        self.assertTrue(any(pattern.search(line) for pattern in publish_check.PATTERNS))
        result = self.run_check()
        self.assertEqual(0, result.returncode, result.stderr)

    def test_allowed_line_changed_by_one_character_is_rejected(self):
        path, line = publish_check.PATTERN_ALLOW[0]
        text = (self.root / path).read_text(encoding="utf-8")
        self.add(path, text.replace(line, line[:-1] + " "))
        result = self.run_check()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("publish_secret_pattern: " + path, result.stderr)

    def test_second_allowed_line_changed_by_one_character_is_rejected(self):
        path, line = publish_check.PATTERN_ALLOW[1]
        text = (self.root / path).read_text(encoding="utf-8")
        self.assertIn(line, text.split("\n"))
        self.add(path, text.replace(line, line[:-1] + " "))
        result = self.run_check()
        self.assertNotEqual(0, result.returncode)
        self.assertIn("publish_secret_pattern: " + path, result.stderr)


if __name__ == "__main__":
    unittest.main()
