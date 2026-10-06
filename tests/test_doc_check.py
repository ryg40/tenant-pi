"""Documentation check: links, anchors, JSON examples, CLI names, env names; offline and read-only."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
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
        self.assertEqual({"compare", "carry", "inventory", "list", "check-runtime", "init-private",
                          "baseline", "check-baseline", "validate", "plan", "generate"}, set(actions))
        self.assertIn("--launcher", actions["generate"])
        self.assertIn("--launcher", actions["plan"])
        self.assertNotIn("--launcher", actions["validate"])
        self.assertNotIn("--target", actions["plan"])
        self.assertIn("--local-dir", actions["validate"])


class PiInstallRuleTests(unittest.TestCase):
    """The three install documents give one rule for the `pi` status `missing` and `mismatch`."""

    DOCS = ("INSTALL.md", "docs/guides/setup.md", "skills/tenant-pi-install/SKILL.md")
    # Each line is in each document one time, so a change of one document without the others fails.
    LINES = (
        'p="$(npm config get prefix)"; test -w "$p/lib/node_modules" && test -w "$p/bin" '
        '&& echo writable || echo "not writable"',
        'npm install --global --prefix "$HOME/.npm-global" -- @earendil-works/pi-coding-agent@',
        'export PATH="$HOME/.npm-global/bin:$PATH"',
        "- Stop.",
        "- Keep the existing Pi, and record the version mismatch as a gap.",
        "The existing Pi stays in its place. Record the prefix and its `PATH` line as an adaptation.",
        # What the write test writes, and the path after a refused global command.
        "The test writes nothing into the npm prefix. `npm config get prefix` writes one debug log file into "
        "the npm cache directory of the user (default `~/.npm/_logs`), and makes that directory when it is absent.",
        "can refuse the global command and use the prefix form below in its place.",
        # The three options above are the choices; the global command is none of them.
        "The global install command is not the default for a `mismatch`: it replaces the installed Pi for every "
        "profile of the user, and it is a downgrade when the installed Pi is newer.",
    )
    TEXT = ("`not writable`", "`mismatch`", "`missing`", "The kit never edits a shell startup file")
    # `npm config get prefix` writes a log file, so no document calls the write test read-only.
    ABSENT = ("reads only", "changes nothing")

    def test_same_rule_in_each_document(self):
        for name in self.DOCS:
            lines = (ROOT / name).read_text(encoding="utf-8").split("\n")
            for expected in self.LINES:
                with self.subTest(name=name, line=expected):
                    self.assertEqual(1, sum(expected in line for line in lines))
            for expected in self.TEXT:
                with self.subTest(name=name, text=expected):
                    self.assertTrue(any(expected in line for line in lines))
            # The write test comes before the prefix form, and the `PATH` line follows the install line.
            at = [next(i for i, line in enumerate(lines) if expected in line) for expected in self.LINES[:3]]
            self.assertLess(at[0], at[1])
            self.assertEqual(at[1] + 1, at[2])
            for expected in self.ABSENT:
                with self.subTest(name=name, absent=expected):
                    self.assertFalse(any(expected in line for line in lines))
            # The two lines on the write test are between the write test and the prefix form.
            for expected in self.LINES[6:8]:
                with self.subTest(name=name, between=expected):
                    here = next(i for i, line in enumerate(lines) if expected in line)
                    self.assertLess(at[0], here)
                    self.assertLess(here, at[1])
            # The line on the global install command follows the three options of a `mismatch`.
            options = [next(i for i, line in enumerate(lines) if expected in line) for expected in self.LINES[3:6]]
            self.assertEqual([options[0], options[0] + 1, options[0] + 2], options)
            self.assertEqual(options[2] + 2, next(i for i, line in enumerate(lines) if self.LINES[8] in line))

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
                    self.assertEqual("# Run from the kit root.", lines[0][1])
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


class ModelReplyRuleTests(unittest.TestCase):
    """The three install documents give one fixed prompt and one reading rule for the model reply."""

    DOCS = PiInstallRuleTests.DOCS
    PROMPT = "What is 17 plus 26? Reply with the number only."
    EXPECTED = "43"
    # The print mode form: the launch line, then `-p` and the prompt, then the exit status.
    PRINT = ("pi --no-approve -p '" + PROMPT + "'; echo \"exit status: $?\"")
    TEXT = ("The expected reply is the number `43`", "The prompt text does not hold that number",
            '"Model replied"', '"Reply matched"', "Preferred form: print mode", "holds no user line",
            "user line", "model line", "thinking text", "A Pi screen has no labels",
            "A `43` in the user line or in the thinking text is not a reply", "The user line must be the fixed prompt",
            "only when both are yes", "--model '<provider>/<model>'", "`exit status: 0`")
    # The old check accepted any text on the screen, also the text that the user typed.
    ABSENT = ("A one-line prompt gets a reply", "a one-line prompt receives a reply", "Reply with exactly")

    def test_the_expected_reply_is_not_in_the_prompt(self):
        self.assertNotIn(self.EXPECTED, self.PROMPT)
        self.assertEqual(int(self.EXPECTED), 17 + 26)
        # No part of the prompt is the reply: a user who types the prompt cannot put the reply on the screen.
        self.assertFalse(any(self.EXPECTED in word for word in self.PROMPT.split()))

    def test_same_rule_in_each_document(self):
        for name in self.DOCS:
            text = (ROOT / name).read_text(encoding="utf-8")
            with self.subTest(name=name):
                self.assertEqual(1, text.count(self.PRINT))
                # The prompt is given as text, and one time more in the print mode command.
                self.assertEqual(2, text.count(self.PROMPT))
            for expected in self.TEXT:
                with self.subTest(name=name, text=expected):
                    self.assertTrue(expected in text)
            for old in self.ABSENT:
                with self.subTest(name=name, absent=old):
                    self.assertFalse(old in text.replace('such as "Reply with exactly: ..."', ""))
            # Print mode comes before the pasted screen: it is the preferred form.
            self.assertLess(text.index("Preferred form: print mode"), text.index("A Pi screen has no labels"), name)

    def test_the_install_log_template_separates_the_reply_from_the_match(self):
        lines = (ROOT / "config/private/install-log.md").read_text(encoding="utf-8").split("\n")
        replied = [line for line in lines if line.startswith("- Model replied:")]
        matched = [line for line in lines if line.startswith("- Reply matched:")]
        self.assertEqual((1, 1), (len(replied), len(matched)))
        for line in replied + matched:
            self.assertTrue("`yes`, `no` or `not run`" in line)
        self.assertTrue("model line" in matched[0] and "not in the user line" in matched[0])
        self.assertLess(lines.index(replied[0]), lines.index(matched[0]))
        # The template names no expected reply: the log is not the place that tells it to the user.
        self.assertFalse(any(self.EXPECTED in line for line in lines))


class PublicTextTests(unittest.TestCase):
    def test_lifecycle_titles_and_links(self):
        titles = {
            "accepted-drift": "Accepted drift in the overlay",
            "carry": "Carry wanted drift into the overlay",
            "launcher": "Launcher file",
            "candidate-list": "Candidate list",
            "check-runtime": "Runtime version check",
            "private-directory": "Private directory",
            "profile-inventory": "Profile inventory, names only",
            "owner-packages": "Owner package paths in the overlay",
            "owner-resources": "Owner skill and prompt directories in the overlay",
        }
        for name, title in titles.items():
            with self.subTest(name=name):
                text = (ROOT / f"docs/{name}.md").read_text(encoding="utf-8")
                self.assertEqual("# " + title, text.splitlines()[0])
                self.assertIn(slug(title), anchors(parse(text)[0]))
        lifecycle = (ROOT / "docs/profile-lifecycle.md").read_text(encoding="utf-8")
        self.assertNotIn("Suggested order", lifecycle)
        self.assertNotIn("Where the concept is thin today", lifecycle)
        for name in titles:
            self.assertIn(f"({name}.md)", lifecycle)

    def test_empty_readiness_list_requires_versions_and_no_other_gap(self):
        for name in ("INSTALL.md", "EXPLAINER.md", "docs/guides/setup.md"):
            with self.subTest(name=name):
                self.assertIn("with `match` for Node and Pi, and a profile without another gap",
                              (ROOT / name).read_text(encoding="utf-8"))

    def test_private_excluded_package_links_are_not_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "scripts").mkdir()
            (root / "scripts/dev-only-files.txt").write_text("packages/tenantext/private/\n")
            self.assertFalse(doc_check.published("packages/tenantext/private/note.md", root))
            self.assertFalse(doc_check.published("packages/tenantext/private", root))
            self.assertTrue(doc_check.published("packages/tenantext/private-other/note.md", root))

    def test_provider_key_rule_is_shared_without_a_provider_choice(self):
        rule = ("Pi reads a provider key from the environment of the launching shell, "
                "including in a profile with no login.")
        variable_rule = ("Not verified: which variable names Pi reads for each provider. "
                         "Use the name that the Pi documentation gives.")
        for name in (*PiInstallRuleTests.DOCS, "EXPLAINER.md", "docs/launcher.md"):
            with self.subTest(name=name):
                text = (ROOT / name).read_text(encoding="utf-8")
                self.assertEqual(1, text.count(rule))
                self.assertEqual(1, text.count(variable_rule))
                self.assertNotIn("OPENROUTER_API_KEY", text)
        explainer = (ROOT / "EXPLAINER.md").read_text(encoding="utf-8")
        self.assertIn("replace `EXAMPLE_PROVIDER_API_KEY`", explainer)
        self.assertIn("where-the-outputs-come-from", anchors(parse(explainer)[0]))
        self.assertNotIn("update-this-document-for-a-new-release", explainer)
        self.assertNotIn("run for this document", explainer)


class SharedRuleTests(unittest.TestCase):
    """The three install documents give the same rules: one shared line or text for each rule."""

    DOCS = PiInstallRuleTests.DOCS
    REPEATED = (
        "# Run from the kit root.",
        '''pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && ''' + "\\",
    )
    # Each shared line has the same count in each document.
    LINES = (*REPEATED,
        "`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.",
        '`runtime.piAcceptedRange` is the accepted Pi range. `runtime.piVersion` is the tested version.',
        'A newer accepted Pi version works by the range rule. The kit tests ran on the tested version only.',
        'With `untested_in_range`, keep the installed Pi and record `core_runtime_untested_in_range` as a readiness gap.',
        'The Pi install line stays a plain command with `not_needed`, not `replaces_installed`.',
        'With `match` or `untested_in_range`, skip the Pi install.',
        "After the overlay exists, `python3 scripts/tenant_pi.py plan --overlay <file>` prints the same line "
        "in `commands.piInstall`, key `command`.",
        '  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"',
        '  npm install --global --prefix "$HOME/.npm-global" -- @earendil-works/pi-coding-agent@"${pin:?}"',
        # A live agent directory that is a link, a `pi` command of the agent, and the time of the baseline.
        "If the action stops with `not_directory: baseline.dir`, the directory or a directory above it is a symbolic "
        'link. Run `realpath "$HOME/.pi/agent"`, give that path as `--dir` to `baseline` and to `check-baseline`, '
        "and record both paths.",
        "A `pi` command without `PI_CODING_AGENT_DIR` counts as a Pi in the live profile, also `pi --version`, "
        "and also when the installing agent ran it.",
        "Observed with Pi 1.0.2 and a `settings.json` in the directory: a `pi --version` without "
        '`PI_CODING_AGENT_DIR` gives `changed` with empty name lists and `"directoryModified":true`.',
        "Record check 4 as passed only when `recordedAt` is before the first Pi command that names the target.",
        "Check 4 has one more value, not verified.",
        # The runtime report is a file that the reader makes, and the kit cannot date it.
        "Exit code 1 is a finding here, not a failure: the file holds the report.",
        "The kit cannot tell an old report from a current one.",
        # A JSON syntax error gives its place.
        '{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}',
    )
    TEXT = (
        # Each directory that Stage 0 can print has its own baseline file.
        '--dir "$PI_CODING_AGENT_DIR"', "live-baseline-env.json",
        '--dir "$PI_CODING_AGENT_SESSION_DIR"', "session-dir-baseline.json",
        # The command that makes the report, the option, and the mark of the Pi install line.
        "tenant_pi.py check-runtime > ", "/.config/tenant-pi/runtime.json", "--runtime-report",
        "`commands.piInstall`", "`replaces_installed`", "`not_needed`",
        # The cause is in the rule, and the place is near the reported line.
        "`input_missing: overlay.file`", "the end of the line before",
        # The target comes from `--target`; a hand edit is one value, with a syntax check and no fragment.
        'tenant_pi.py init-private --dir "$HOME/.config/tenant-pi" --target "$HOME/.pi/profiles/',
        "`sample_target: overlay.target.agentDir`", "/home/EXAMPLE_USER/new-agent", "Change nothing else",
        "JSON fragment", "python3 -m json.tool ", '>/dev/null && echo "JSON valid"',
    )
    # The old texts: an overlay that starts as a hand copy, a Pi line that the plan always prints,
    # a question that names only a Pi of the user, and a bare `pi --version` claim without its condition.
    ABSENT = ("Start from `config/config.example.json`", "The plan prints this line under `commands.setupDisplayOnly`",
              "The plan prints the Pi line and the declared-package lines", "/path/to/overlay.json",
              "Ask whether a Pi of the user ran",
              "A `pi --version` without `PI_CODING_AGENT_DIR` gives", "a bare `pi --version` changes the modification time")

    def test_same_rule_in_each_document(self):
        for name in self.DOCS:
            text = (ROOT / name).read_text(encoding="utf-8")
            lines = text.split("\n")
            for expected in self.LINES:
                with self.subTest(name=name, line=expected[:60]):
                    self.assertEqual(2 if expected in self.REPEATED else 1, sum(expected in line for line in lines))
            for expected in self.TEXT:
                with self.subTest(name=name, text=expected):
                    self.assertTrue(expected in text)
            for old in self.ABSENT:
                with self.subTest(name=name, absent=old):
                    self.assertFalse(old in text)

    def test_order_of_the_steps_in_each_document(self):
        for name in self.DOCS:
            text = (ROOT / name).read_text(encoding="utf-8")
            with self.subTest(name=name):
                made = text.index("tenant_pi.py init-private --dir")
                syntax = text.index("python3 -m json.tool ")
                validate = text.index("tenant_pi.py validate --overlay")
                # The private directory with its target comes first; the syntax check comes before `validate`.
                self.assertLess(made, syntax)
                self.assertLess(syntax, validate)
                # The report is made before the baseline step, and the baseline before its comparison.
                report = text.index("tenant_pi.py check-runtime > ")
                baseline = text.index("tenant_pi.py baseline --dir")
                self.assertLess(validate, report)
                self.assertLess(report, baseline)
                self.assertLess(baseline, text.index("tenant_pi.py check-baseline --dir"))
                # The link case belongs to the baseline step: it comes before the comparison.
                self.assertLess(text.index("`not_directory: baseline.dir`"), text.index("tenant_pi.py check-baseline --dir"))

    def test_the_commands_of_the_skill_name_the_private_directory(self):
        # The skill gave `/path/to/overlay.json`; each kit command now names the file that `init-private` made.
        text = (ROOT / "skills/tenant-pi-install/SKILL.md").read_text(encoding="utf-8")
        for action in ("validate", "plan", "generate"):
            with self.subTest(action=action):
                self.assertEqual(1, text.count('tenant_pi.py ' + action + ' --overlay "$HOME/.config/tenant-pi/overlay.json"'))
        plan = next(line for line in text.split("\n")
                    if 'tenant_pi.py plan --overlay "$HOME/.config/tenant-pi/overlay.json"' in line)
        self.assertTrue('--runtime-report "$HOME/.config/tenant-pi/runtime.json"' in plan)


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
        self.assertEqual({"files": 3, "links": 2, "json": 0, "actions": 11}, counts)

    def test_each_rule(self):
        cases = {
            "link_missing": "[x](absent.md)",
            "anchor_missing": "[x](ref.md#" + CANARY.lower() + ")",
            "link_outside": "[x](../../../" + CANARY + ".md)",
            "link_unpublished": "[x](design.md)",
            "json_example": "```json\n\"" + CANARY + "\": 1\n```",
            "cli_action": "`python3 scripts/tenant_pi.py " + CANARY.lower() + "`",
            "cli_flag": "`python3 scripts/tenant_pi.py plan --target '/x'`",
        }
        (self.root / "docs/design.md").write_text("# Design\n", encoding="utf-8")
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
                # The same text outside the guides and README.md is not a finding.
                self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
        self.assertEqual([], self.run_check({"docs/guides/setup.md": guide + "\nUse `--no-approve` and "
                                             "`--launcher` with `TENANTEXT_LITELLM_API_KEY`.\n"})[0])

    def test_continuation_and_brackets(self):
        text = "```sh\npython3 scripts/tenant_pi.py generate --overlay '/a b' \\\n  --target '/c' [--launcher '/d']\n```\n"
        self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text})[0])
        bad = text.replace("--launcher", "--require-launcher")
        self.assertEqual(["cli_flag: docs/other.md:4"], self.run_check({"docs/other.md": "# Other\n\n" + bad})[0])

    def test_action_coverage_counts_guides_only(self):
        self.files["docs/guides/setup.md"] = "# Setup\n\n`python3 scripts/tenant_pi.py plan --help`\n"
        findings, _ = self.run_check({"docs/other.md": "`python3 scripts/tenant_pi.py list --help`\n"})
        self.assertIn("action_unguided: scripts/tenant_pi.py:list", findings)
        self.assertNotIn("action_unguided: scripts/tenant_pi.py:plan", findings)

    def test_dev_only_target(self):
        text = "[notes](dev/notes.md)"
        with mock.patch.object(doc_check, "DEV_ONLY_TARGETS", ("docs/dev/notes.md",)):
            self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
            (self.root / "docs/dev").mkdir()
            (self.root / "docs/dev/notes.md").write_text("# Notes\n", encoding="utf-8")
            self.assertEqual([], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])
        # Without the entry, the same link is a finding.
        self.assertEqual(["link_unpublished: docs/other.md:3"], self.run_check({"docs/other.md": "# Other\n\n" + text + "\n"})[0])


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
