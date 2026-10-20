"""Documentation check: links, anchors, JSON examples, CLI names, env names; offline and read-only."""
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
from scripts.doc_check import anchors, cli_tree, json_block, parse, resolve, slug

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
        self.assertEqual("stage-5-the-private-overlay", slug("Stage 5: the private overlay"))
        self.assertEqual("--launcher-the-launcher-file", slug("`--launcher`: the launcher file"))
        self.assertEqual("check-runtime-the-one-action-that-starts-a-process",
                         slug("`check-runtime`: the one action that starts a process"))

    def test_anchors_count_duplicates_and_skip_code(self):
        prose, blocks = parse("# A\n\n## A\n\n```sh\n# not a heading\n```\n## B c\n")
        self.assertEqual({"a", "a-1", "b-c"}, anchors(prose))
        self.assertEqual([("sh", 5, [(6, "# not a heading")])], blocks)

    def test_parser_without_development_modules_keeps_compare(self):
        _, development = cli_tree()
        with mock.patch.object(doc_check.tenant_pi, "HAS_CARRY", False), \
                mock.patch.object(doc_check.tenant_pi, "HAS_LIST", False):
            _, portable = cli_tree()
        self.assertNotIn("carry", portable)
        self.assertNotIn("list", portable)
        self.assertEqual(development["compare"], portable["compare"])

    def test_json_block(self):
        self.assertTrue(json_block(['{"a": 1}']))
        self.assertTrue(json_block(['{"a": 1}', "", '{"b": 2}']))
        self.assertFalse(json_block(['"key": 1']))
        self.assertFalse(json_block(['{"a": 1,}']))
        self.assertFalse(json_block([""]))

    def test_resolve(self):
        self.assertEqual("docs/carry.md", resolve("docs/guides/setup.md", "../carry.md"))
        self.assertEqual("README.md", resolve("docs/guides/setup.md", "../../README.md"))
        self.assertEqual("docs/guides/modules.md", resolve("docs/guides/setup.md", "./modules.md"))
        self.assertIsNone(resolve("docs/guides/setup.md", "../../../x.md"))

    def test_cli_tree_is_the_real_parser(self):
        top, actions = cli_tree()
        self.assertIn("--help", top)
        expected = {"wizard", "compare", "inventory", "check-runtime", "update", "check-herdr", "check-wiki-vault", "remote-plan", "compose-plan",
                    "components", "init-private", "baseline", "check-baseline", "results", "validate", "plan", "generate"}
        if doc_check.tenant_pi.HAS_CARRY:
            expected.add("carry")
        if doc_check.tenant_pi.HAS_LIST:
            expected.add("list")
        self.assertEqual(expected, set(actions))
        self.assertIn("--launcher", actions["generate"])
        self.assertIn("--launcher", actions["plan"])
        self.assertNotIn("--launcher", actions["validate"])
        self.assertNotIn("--target", actions["plan"])
        self.assertIn("--local-dir", actions["validate"])


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
                self.assertEqual(2, len(installs), name)
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

    def test_no_guide_copies_the_component_list(self):
        from scripts.components import RECOMMENDED
        components = json.loads((ROOT / "config/manifest.json").read_text())["components"]
        patterns = [re.compile(r"(?<![\w-])" + re.escape(cid) + r"(?![\w-])") for cid in components]
        for name in (*self.DOCS, "skills/tenant-pi-install/SKILL.md", "docs/guides/setup.md"):
            text = (ROOT / name).read_text(encoding="utf-8")
            for number, line in enumerate(text.splitlines(), 1):
                with self.subTest(name=name, line=number):
                    self.assertLess(sum(bool(pattern.search(line)) for pattern in patterns), 10)
        copied = "Recommended: " + ", ".join(RECOMMENDED)
        self.assertGreaterEqual(sum(bool(pattern.search(copied)) for pattern in patterns), 10)

    def memory_example(self, name):
        """The one JSON example of a guide that holds the consent key and the `memory` block."""
        found = []
        for lang, _, lines in parse(self.texts[name])[1]:
            if lang == "json":
                data = json.loads("\n".join(line.strip() for _, line in lines))
                if type(data) is dict and "memory" in data:
                    found.append(data)
        self.assertEqual(1, len(found), name)
        return found[0]

    def test_the_memory_example_is_valid_with_the_recommended_selection(self):
        from scripts.components import RECOMMENDED, selection
        from scripts.validate import Invalid, manifest, overlay
        known = manifest(json.loads((ROOT / "config/manifest.json").read_text(encoding="utf-8")))
        sample = json.loads((ROOT / "config/config.example.json").read_text(encoding="utf-8"))
        chosen = selection(known, list(RECOMMENDED))
        self.assertEqual([], chosen["added"])
        examples = {name: self.memory_example(name) for name in self.DOCS}
        self.assertEqual(1, len({json.dumps(example, sort_keys=True) for example in examples.values()}))
        for name, example in examples.items():
            with self.subTest(name=name):
                self.assertEqual({"consent", "memory"}, set(example))
                self.assertEqual({"memoryCapture": True, "remoteMemoryWrites": False, "telemetry": False}, example["consent"])
                # No background model call, an ambient vault, and neither remote module.
                self.assertEqual({"schemaVersion": 1, "hermes": {"backgroundReview": False},
                                  "wiki": {"ambientPersonalVault": True, "backgroundTasks": False}, "openviking": None, "agentcore": None},
                                 example["memory"])
                data = {**sample, "target": {"agentDir": "/home/EXAMPLE_USER/.pi/profiles/main"},
                        "selection": chosen["selection"], **example}
                overlay(data, known)
                # Each `overlay:` code of the two modules is a key of the example.
                for cid in ("hermes", "wiki"):
                    for code in chosen["prerequisites"][cid]:
                        if code.startswith("overlay:"):
                            value = example
                            for key in code.split(":", 1)[1].split("."):
                                value = value[key]
                            self.assertTrue(value, code)
                # The sample overlay alone, with this selection, is refused: the consent is a separate act.
                with self.assertRaises(Invalid):
                    overlay({**sample, "selection": chosen["selection"]}, known)

    def test_install_selection_example_matches_the_action(self):
        from scripts.components import selection
        from scripts.validate import manifest
        known = manifest(json.loads((ROOT / "config/manifest.json").read_text(encoding="utf-8")))
        samples = [json.loads("\n".join(line for _, line in lines))
                   for lang, _, lines in parse(self.texts["INSTALL.md"])[1] if lang == "json"]
        core = [sample for sample in samples
                if type(sample) is dict and sample.get("selection", {}).get("enable") == ["core"]]
        self.assertEqual(1, len(core))
        self.assertEqual(selection(known, [])["selection"], core[0]["selection"])


class PublicTextTests(unittest.TestCase):
    def test_lifecycle_links(self):
        targets = ("accepted-drift.md", "launcher.md",
                   "check-runtime.md", "private-directory.md", "profile-inventory.md",
                   "owner-extensions.md#owner-package-paths-in-the-overlay",
                   "owner-extensions.md#owner-skill-and-prompt-directories-in-the-overlay")
        lifecycle = (ROOT / "docs/private-directory.md").read_text(encoding="utf-8")
        for target in targets:
            self.assertIn(f"({target})", lifecycle)

    def test_directory_docs_are_checked_and_denied_docs_are_omitted(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "docs/explainer").mkdir(parents=True)
            (root / "scripts").mkdir()
            name = "docs/explainer/new-guide.md"
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
    # One section for each task of the guide: the update of the kit first, then the check of the base install and the loop.
    SECTIONS = (
        "Get a new version of the kit",
        "Confirm the base install",
        "The one rule: each change is a new candidate",
        "Add or remove a component",
        "Switch a memory module on",
        "Install the declared npm packages of a new candidate",
        "Update the npm packages of one candidate",
        "Keep an accepted difference",
        "What a new candidate does not get",
        "Take over a choice that you made inside Pi",
        "Record the baseline of a new candidate",
        "Remove a candidate that is not used",
        "Move to a new Pi version",
        "Add a provider or a model route",
        "Update a Compose seat",
        "Write the results file again",
    )
    ACTIONS = {"update", "inventory", "check-runtime", "validate", "plan", "generate", "compare",
               "components", "check-wiki-vault", "baseline", "check-baseline", "results"}

    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / cls.NAME).read_text(encoding="utf-8")
        cls.prose, cls.blocks = parse(cls.text)

    def test_the_file_is_in_the_publish_set_and_in_the_checked_set(self):
        from scripts.publish_check import PUBLISH, explicit_files
        self.assertIn(self.NAME, PUBLISH)
        self.assertIn(self.NAME, explicit_files(ROOT, PUBLISH))
        findings, counts = doc_check.check(ROOT, [self.NAME])
        self.assertEqual(1, counts["files"])
        # A list of one file names no guide, so only the guide coverage of the actions can show here.
        self.assertEqual([], [finding for finding in findings if not finding.startswith("action_unguided: ")])

    def test_one_section_for_each_task_in_order(self):
        headings = [match.group(2) for match in (doc_check.HEADING.match(line) for _, line in self.prose)
                    if match and match.group(1) == "##"]
        self.assertEqual(list(self.SECTIONS), headings)

    def test_each_action_exists_with_the_flags_of_the_task(self):
        _, actions = cli_tree()
        named = {}
        for _, text in doc_check.commands(self.prose, self.blocks):
            # The command pattern of the check stops at `>`, so at a placeholder such as `<overlay>`.
            # Without the placeholders, each flag of the line is read.
            for match in doc_check.CLI.finditer(re.sub(r"<[^<>]*>", "PLACEHOLDER", text)):
                words = match.group(1).split()
                if words and not words[0].startswith(("<", "[", "-")):
                    named.setdefault(words[0], set()).update(doc_check.FLAG.findall(match.group(1)))
        self.assertEqual(self.ACTIONS, set(named))
        for action, flags in named.items():
            self.assertLessEqual(flags, actions[action], action)
        self.assertLessEqual({"--overlay", "--format", "--select"}, named["components"])
        self.assertLessEqual({"--facts", "--overlay", "--target", "--out-dir", "--replace"}, named["results"])
        self.assertLessEqual({"--target", "--launcher", "--runtime-report"}, named["generate"])
        for word in ("memory_consent_required", "memory_choices_required", "memory.hermes.backgroundReview",
                     "Before `wiki` goes on", "memory.wiki.wikiHome", "(docs/memory-modules.md#the-vault-check)",
                     "memory.wiki.backgroundTasks", "roles.memory", "pi update --extensions", "unmanaged",
                     "/npmCommand", "INSTALLER_KIT_RESULTS.md", "git pull", "runtime.piAcceptedRange"):
            self.assertIn(word, self.text, word)

    def test_the_first_lines_name_the_reader_and_the_results_file(self):
        head = "\n".join(self.text.split("\n")[:6])
        self.assertIn("base install", head)
        self.assertIn("You do not read `INSTALL.md` again.", head)
        self.assertIn("`<private dir>/INSTALLER_KIT_RESULTS.md`", head)

    def test_each_task_section_has_one_link_for_the_details(self):
        sections = re.split(r"(?m)^## ", self.text)[1:]
        for section in sections:
            title = section.split("\n", 1)[0]
            self.assertTrue(doc_check.LINK.search(section), title)

    def test_stage_10_points_to_the_file(self):
        for name, heading, link in (("INSTALL.md", "## Stage 10: updates", "(POST_INSTALL.md)"),):
            text = (ROOT / name).read_text(encoding="utf-8")
            stage = text[text.index(heading):]
            stage = stage[:stage.index("\n## ", 1)]
            self.assertIn(link, stage, name)
            self.assertIn("the kit changes no profile in place", stage, name)
            # The commands of an update are in the one file; the stage holds no second copy. It names only the
            # one read-only `update` command that starts that section.
            self.assertNotIn("```", stage, name)
            self.assertEqual(["update"], [match.group(1).split()[0] for match in doc_check.CLI.finditer(stage)], name)
            self.assertIn("This stage is one message to the user, and it runs no command.", stage, name)

    def test_the_document_lists_name_the_file(self):
        for name, link in (("README.md", "(POST_INSTALL.md)"), ("EXPLAINER.md", "(POST_INSTALL.md)"),
                           ("docs/guides/setup.md", "(../../POST_INSTALL.md)"),
                           ("skills/tenant-pi-install/SKILL.md", "(../../POST_INSTALL.md)")):
            self.assertIn(link, (ROOT / name).read_text(encoding="utf-8"), name)

    def test_setup_and_skill_point_to_install_without_a_second_flow(self):
        from tests.test_skill_invariants import TRACKER, skill_findings
        self.assertEqual([], skill_findings([ROOT / "skills/tenant-pi-install"], TRACKER,
                                           require_credits=False))
        for name in ("docs/guides/setup.md", "skills/tenant-pi-install/SKILL.md"):
            text = (ROOT / name).read_text(encoding="utf-8")
            self.assertIn("(../../INSTALL.md)", text)
            self.assertNotRegex(text, r"(?m)^#+ Stage \d|^\d+\. ")
            self.assertNotIn("```", text)
            self.assertLess(len(text.splitlines()), 60)
            for anchor in ("stage-0-inventory", "stage-5-the-private-overlay",
                           "stage-9-first-launch-and-checks", "stage-10-updates"):
                self.assertIn("../../INSTALL.md#" + anchor, text)


class TreeTests(unittest.TestCase):
    """`check` on a synthetic tree; the publish set is patched to the synthetic files."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="tenantpi-doc-check-"))
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "config").mkdir()
        shutil.copy(ROOT / "config/manifest.json", self.root / "config/manifest.json")
        (self.root / "docs/guides").mkdir(parents=True)
        guide = "\n".join("python3 scripts/tenant_pi.py " + action + " --help" for action in sorted(cli_tree()[1]))
        self.files = {
            "README.md": "# Kit\n\nSee [setup](docs/guides/setup.md#stage-one) and [ref](docs/ref.md).\n",
            "docs/ref.md": "# Ref\n\n## Part two\n",
            "docs/guides/setup.md": "# Setup\n\n## Stage one\n\n```sh\n" + guide + "\n```\n",
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
        published = set(cli_tree()[1]) - set(doc_check.DEV_ONLY_ACTIONS)
        actions = len(published) + int(doc_check.tenant_pi.HAS_CARRY) + int(doc_check.tenant_pi.HAS_LIST)
        self.assertEqual({"files": 3, "links": 2, "json": 0, "actions": actions}, counts)

    def test_each_rule(self):
        cases = {
            "link_missing": "[x](absent.md)",
            "anchor_missing": "[x](ref.md#" + CANARY.lower() + ")",
            "link_outside": "[x](../../../" + CANARY + ".md)",
            "link_unpublished": "[x](../design.md)",
            "json_example": "```json\n\"" + CANARY + "\": 1\n```",
            "cli_action": "`python3 scripts/tenant_pi.py " + CANARY.lower() + "`",
            "cli_flag": "`python3 scripts/tenant_pi.py plan --target '/x'`",
        }
        (self.root / "design.md").write_text("# Design\n", encoding="utf-8")
        for rule, text in cases.items():
            with self.subTest(rule=rule):
                findings, _ = self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})
                self.assertEqual([rule + ": docs/other.md:3"], findings)
                self.assertNotIn(CANARY, "".join(findings))

    def test_skill_table_is_the_manifest_list(self):
        name = "packages/tenantext/skills/coordinator-skills/README.md"
        skills = json.loads((self.root / "config/manifest.json").read_text())["components"]["coordinator-skills"]["resources"]["skills"]
        rows = ["| `" + skill.rsplit("/", 1)[1] + "` | Use. |" for skill in skills]
        table = lambda rows: "# Skills\n\n| Skill | Use |\n| --- | --- |\n" + "\n".join(rows) + "\n"
        self.assertEqual([], self.run_check({name: table(rows)})[0])
        for case, changed in (("missing", rows[:-1]), ("extra", rows + ["| `" + CANARY.lower() + "` | Use. |"]),
                              ("order", rows[1:] + rows[:1])):
            with self.subTest(case=case):
                findings, _ = self.run_check({name: table(changed)})
                self.assertEqual(["skill_list: " + name], findings)
                self.assertNotIn(CANARY.lower(), "".join(findings))
        # Another table of the README does not feed the rule; a README with no skill table fails.
        other = "\n| Name | Note |\n| --- | --- |\n| `" + CANARY.lower() + "` | Not a skill. |\n"
        self.assertEqual([], self.run_check({name: table(rows) + other})[0])
        self.assertEqual(["skill_list: " + name], self.run_check({name: other})[0])
        self.assertEqual(["skill_list: " + name],
                         self.run_check({name: "| Name | Note |\n| --- | --- |\n" + "\n".join(rows) + "\n"})[0])

    def test_guide_only_rules(self):
        guide = self.files["docs/guides/setup.md"]
        for rule, text in {"cli_flag": "Use `--" + CANARY.lower() + "` here.",
                           "env_name": "Export `TENANTEXT_" + CANARY.upper().replace("-", "_") + "`."}.items():
            with self.subTest(rule=rule):
                findings, _ = self.run_check({"docs/guides/setup.md": guide + "\n" + text + "\n"})
                self.assertEqual([rule + ": docs/guides/setup.md:" + str(guide.count("\n") + 2)], findings)
                # Other reference pages do not use the strict flag and environment rules.
                self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
        self.assertEqual([], self.run_check({"docs/guides/setup.md": guide + "\nUse `--no-approve` and "
                                             "`--launcher` with `TENANTEXT_LITELLM_API_KEY`.\n"})[0])

    def test_install_counts_as_a_guide_and_checks_standalone_flags(self):
        guide = self.files["docs/guides/setup.md"]
        self.files["docs/guides/setup.md"] = "# Setup\n\n## Stage one\n\n[Install](../../INSTALL.md)\n"
        self.assertEqual([], self.run_check({"INSTALL.md": guide})[0])
        findings, _ = self.run_check({"INSTALL.md": guide + "\nUse `--" + CANARY.lower() + "`.\n"})
        self.assertEqual(["cli_flag: INSTALL.md:" + str(guide.count("\n") + 2)], findings)

    def test_continuation_and_brackets(self):
        text = "```sh\npython3 scripts/tenant_pi.py generate --overlay '/a b' \\\n  --target '/c' [--launcher '/d']\n```\n"
        self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text})[0])
        bad = text.replace("--launcher", "--require-launcher")
        self.assertEqual(["cli_flag: docs/other.md:4"], self.run_check({"docs/other.md": "# Other\n\n" + bad})[0])

    def test_action_coverage_excludes_reference_pages(self):
        self.files["docs/guides/setup.md"] = "# Setup\n\n`python3 scripts/tenant_pi.py plan --help`\n"
        findings, _ = self.run_check({"docs/other.md": "`python3 scripts/tenant_pi.py compare --help`\n"})
        self.assertIn("action_unguided: scripts/tenant_pi.py:compare", findings)
        self.assertNotIn("action_unguided: scripts/tenant_pi.py:plan", findings)
        for action in ("carry", "list"):
            self.assertNotIn(f"action_unguided: scripts/tenant_pi.py:{action}", findings)

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
