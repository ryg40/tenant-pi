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
        self.assertEqual({"compare", "carry", "inventory", "list", "check-runtime", "check-herdr", "check-wiki-vault", "remote-plan", "compose-plan", "components",
                          "init-private", "baseline", "check-baseline", "results", "validate", "plan", "generate"}, set(actions))
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


class PostInstallTests(unittest.TestCase):
    """`POST_INSTALL.md`: the guide for the time after a base install."""

    NAME = "POST_INSTALL.md"
    # One section for each task of the guide, after the check of the base install and the loop.
    SECTIONS = (
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
        "Get a new version of the kit",
        "Move to a new Pi version",
        "Add a provider or a model route",
        "Update a Compose seat",
        "Write the results file again",
    )
    ACTIONS = {"list", "inventory", "check-runtime", "validate", "plan", "generate", "compare", "carry",
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

    def test_stage_10_of_each_install_text_points_to_the_file(self):
        for name, heading, link in (("INSTALL.md", "## Stage 10: updates", "(POST_INSTALL.md)"),
                                    ("skills/tenant-pi-install/SKILL.md", "## Stage 10: keep it current",
                                     "(../../POST_INSTALL.md)")):
            text = (ROOT / name).read_text(encoding="utf-8")
            stage = text[text.index(heading):]
            stage = stage[:stage.index("\n## ", 1)]
            self.assertIn(link, stage, name)
            self.assertIn("the kit changes no profile in place", stage, name)
            # The commands of an update are in the one file; the stage holds no second copy.
            self.assertNotIn("```", stage, name)
            self.assertNotIn("tenant_pi.py", stage, name)

    def test_the_document_lists_name_the_file(self):
        for name, link in (("README.md", "(POST_INSTALL.md)"), ("EXPLAINER.md", "(POST_INSTALL.md)"),
                           ("docs/guides/setup.md", "(../../POST_INSTALL.md)"),
                           ("docs/guides/candidate-update.md", "(../../POST_INSTALL.md)")):
            self.assertIn(link, (ROOT / name).read_text(encoding="utf-8"), name)
        top = (ROOT / "docs/guides/candidate-update.md").read_text(encoding="utf-8").split("\n")[:4]
        self.assertTrue(any("POST_INSTALL.md" in line for line in top))


class InstallFlowTests(unittest.TestCase):
    """The checklist, the memory consent, the vault rule and the results file in the two agent guides."""

    DOCS = ("INSTALL.md", "skills/tenant-pi-install/SKILL.md")
    CONSENT = ("`hermes` and `wiki` are marked. Both store text of your sessions on this machine. "
               "With the default setting, `wiki` also adds text from your vault to each prompt in each directory, "
               "and that text goes to your model provider. "
               "Keep a mark only when you agree to that. Switch off the number of a module that you do not want.")
    # The commands of the flow, and the texts that an edit must keep.
    TEXT = ("tenant_pi.py components --format text", "tenant_pi.py components --select ",
            "tenant_pi.py check-wiki-vault", "tenant_pi.py results --facts ", "--replace",
            "Do not open a question dialog after the list", "Remove no line and change no line",
            "`added`", "`second_vault`", "`doubled`", "Never set `memory.wiki.embedding` on your own",
            "wiki-vault-baseline.json", '"modified":["meta"]', "INSTALLER_KIT_RESULTS.md", "results-facts.json",
            "The last line is the full path of the results file", "POST_INSTALL.md#switch-a-memory-module-on")
    # The old texts: a bundle question, a list of the IDs, and memory that is off without a question.
    ABSENT = ("Recommended full set", "off by default", "Default is none", "Default no", "Enable memory at all?",
              "Which in-tree extensions and skills?", "compare` (Stage 10)")

    @classmethod
    def setUpClass(cls):
        cls.texts = {name: (ROOT / name).read_text(encoding="utf-8") for name in cls.DOCS}
        cls.components = json.loads((ROOT / "config/manifest.json").read_text(encoding="utf-8"))["components"]

    def test_each_guide_names_the_actions_and_holds_the_consent_sentence(self):
        for name, text in self.texts.items():
            for expected in (self.CONSENT, *self.TEXT):
                with self.subTest(name=name, text=expected[:50]):
                    self.assertIn(expected, text)
            for old in self.ABSENT:
                with self.subTest(name=name, absent=old):
                    self.assertNotIn(old, text)
            # The list comes first, then the selection, then the results file.
            order = [text.index(self.TEXT[index]) for index in (0, 1, 3)]
            self.assertEqual(sorted(order), order, name)

    def test_no_guide_holds_a_copy_of_the_component_list(self):
        ids = [re.compile(r"(?<![\w-])" + re.escape(cid) + r"(?![\w-])") for cid in self.components]
        for name, text in self.texts.items():
            for number, line in enumerate(text.split("\n"), 1):
                with self.subTest(name=name, line=number):
                    self.assertLess(sum(bool(pattern.search(line)) for pattern in ids), 10)
        # The rule finds the old list: the recommended set in one paragraph.
        from scripts.components import RECOMMENDED
        old = "Recommended: " + ", ".join("`" + cid + "`" for cid in RECOMMENDED) + "."
        self.assertGreaterEqual(sum(bool(pattern.search(old)) for pattern in ids), 10)

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
                # No background model call, an ambient vault, and no third module.
                self.assertEqual({"schemaVersion": 1, "hermes": {"backgroundReview": False},
                                  "wiki": {"ambientPersonalVault": True, "backgroundTasks": False}, "openviking": None},
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

    def test_the_setup_guide_uses_the_same_actions_and_the_sample_of_the_action(self):
        from scripts.components import selection
        from scripts.validate import manifest
        known = manifest(json.loads((ROOT / "config/manifest.json").read_text(encoding="utf-8")))
        text = (ROOT / "docs/guides/setup.md").read_text(encoding="utf-8")
        for expected in ("tenant_pi.py components --format text", "tenant_pi.py components --select core,ops-footer",
                         "tenant_pi.py check-wiki-vault", "Both store text of your sessions on this machine.",
                         "With the default setting, `wiki` also adds text from your vault to each prompt in each directory, "
                         "and that text goes to your model provider.",
                         "`npm warn install-scripts`", "`npm warn deprecated`", "The order differs from",
                         "`models-store.json`", "`lastChangelogVersion`", "`pi update` does not write it.",
                         '--out-dir "$HOME/.config/tenant-pi"'):
            with self.subTest(text=expected):
                self.assertIn(expected, text)
        self.assertIn("The order differs from `docs/guides/setup.md`", self.texts["INSTALL.md"])
        # The core-only sample lists each optional component, as `components --select core` prints it.
        samples = [json.loads("\n".join(line for _, line in lines)) for lang, _, lines in parse(text)[1] if lang == "json"]
        core = [sample for sample in samples if type(sample) is dict and sample.get("selection", {}).get("enable") == ["core"]]
        self.assertEqual(1, len(core))
        self.assertEqual(selection(known, [])["selection"], core[0]["selection"])
        self.assertEqual(["context-meter"], selection(known, ["ops-footer"])["added"])

    def test_the_other_documents_state_the_new_defaults(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("The sample overlay enables no memory module.", readme)
        self.assertIn("Without the consent key, nothing is captured.", readme)
        for name in ("README.md", "docs/guides/setup.md", "docs/guides/modules.md", "docs/guides/privacy.md",
                     "docs/memory-modules.md", "EXPLAINER.md", "POST_INSTALL.md"):
            with self.subTest(name=name):
                text = (ROOT / name).read_text(encoding="utf-8")
                self.assertNotIn("memory is off by default", text)
                self.assertNotIn("Recommended full set", text)
        # The sample overlay stays core only.
        sample = json.loads((ROOT / "config/config.example.json").read_text(encoding="utf-8"))
        self.assertEqual(["core"], sample["selection"]["enable"])
        self.assertNotIn("memory", sample)
        # Each list of the files of the private directory names the results file.
        for name in ("INSTALL.md", "docs/guides/privacy.md", "docs/private-directory.md", "EXPLAINER.md"):
            with self.subTest(name=name):
                self.assertIn("INSTALLER_KIT_RESULTS.md", (ROOT / name).read_text(encoding="utf-8"))


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
        self.assertEqual({"files": 3, "links": 2, "json": 0, "actions": 17}, counts)

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


class HerdrStageTests(unittest.TestCase):
    """The Herdr and question tool stage of the two agent guides: the same rules, no invented source."""

    DOCS = {"INSTALL.md": "## Stage 4a: Herdr and the question tool",
            "skills/tenant-pi-install/SKILL.md": "## Stage 8: Herdr and the question tool (optional)"}
    ASSET = "https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64"
    DIGEST = "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7"

    def stage(self, name):
        text = (ROOT / name).read_text(encoding="utf-8")
        start = text.index(self.DOCS[name] + "\n")
        return text[start:text.index("\n## Stage ", start + 1)]

    def test_each_guide_asks_the_same_decisions(self):
        for name in self.DOCS:
            stage = self.stage(name)
            for expected in ("on this machine, on a remote Linux host over SSH, or in a container on this machine", "existing", "privileged actions",
                             "approves or refuses each item", "id -un", "command -v herdr && herdr --version",
                             "tenant_pi.py check-herdr", "packages/tenantext/skills/herdr/install.sh",
                             "separate approval", "`questions`", "plain text", "no Pi extension into Claude Code",
                             "complete and the actions that are not"):
                with self.subTest(name=name, expected=expected):
                    self.assertIn(expected, stage)

    def test_the_herdr_source_is_the_pinned_release_and_no_command_pipes_a_script_or_upgrades_it(self):
        for name in self.DOCS:
            stage = self.stage(name)
            with self.subTest(name=name):
                self.assertNotIn("<reviewed Herdr source>", stage)
                for expected in ("`herdrdev/herdr`", "Apache-2.0", "reads it before it runs", "`herdr-macos-aarch64`",
                                 "`herdr-macos-x86_64`", "a non-login shell or in an SSH command",
                                 "never edits a shell startup file"):
                    self.assertIn(expected, stage)
                # The addresses are the pinned release asset, the home page and the official install script.
                self.assertLessEqual(set(re.findall(r"https?://[^\s`)]+", stage)),
                                     {self.ASSET, "https://herdr.dev", "https://herdr.dev/install.sh"})
                blocks = re.findall(r"```(?:sh|text)\n(.*?)```", stage, re.S)
                commands = "\n".join(blocks)
                # The preferred form: the pinned asset, the digest check, then the install without root.
                for expected in ("curl -fsSLO " + self.ASSET + " &&",
                                 "echo '" + self.DIGEST + "  herdr-linux-x86_64' | sha256sum -c - &&",
                                 "install -m 755 herdr-linux-x86_64 ~/.local/bin/herdr"):
                    self.assertIn(expected, commands)
                self.assertIsNone(re.search(r"\|\s*(?:ba|z|da)?sh\b", commands))
                for forbidden in ("herdr update", "herdr channel set", "herdr server", "wget",
                                  "StrictHostKeyChecking", "UserKnownHostsFile", "install.sh"):
                    self.assertNotIn(forbidden, commands)
                # Host key verification is named only as a rule that forbids its removal.
                self.assertIn("host key verification", stage)

    def test_the_fact_document_names_each_part_and_the_unverified_claims(self):
        text = (ROOT / "docs/herdr-setup.md").read_text(encoding="utf-8")
        for expected in ("The kit does not install, update or start it.", "@juicesharp/rpiv-ask-user-question@2.11.0",
                         "installs no Pi extension into Claude Code", "the agent asks in plain text"):
            self.assertIn(expected, text)
        # Each value of the code is in the document, so a new value needs a new line there.
        from scripts.check_runtime import HERDR_STATUSES
        from scripts.profile_inventory import NOT_MEASURED
        from scripts.profile_plan import HERDR_CLI_GAP, HERDR_CLI_GAPS, HERDR_SESSION_GAP
        for value in (*HERDR_STATUSES, *NOT_MEASURED, *NOT_MEASURED.values(), HERDR_CLI_GAP, *HERDR_CLI_GAPS.values(),
                      HERDR_SESSION_GAP, "readable", "not_readable", "not_declared", "declared", "installed",
                      "question_ui_unverified"):
            with self.subTest(value=value):
                self.assertIn("`" + value + "`", text)
        live = text[text.index("### Live checks that the owner approves"):text.index("## The remote plan")]
        # No live check is recorded as done.
        self.assertEqual(4, live.count("| Not run |"))
        self.assertNotIn("| Passed |", live)


if __name__ == "__main__":
    unittest.main()
