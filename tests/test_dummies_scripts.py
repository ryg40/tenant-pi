"""The two scripts of the dummies skill: the state switch and the log page.

Offline: a fake `okknow` command and a fake `herdr` command are on a PATH that holds no
other command of the host. The home directory, the state file and each instruction file are
in a temporary directory. The clock is `DUMMIES_NOW`. No test reads the session of the
agent that runs the tests: the environment of each call is built from an empty one.
Each text with the form of a credential is built from parts when the test runs, so that
no scan of this file finds that form.
"""
import ast
import base64
import contextlib
import io
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from tests.support import slow
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "packages/tenantext/skills/coordinator-skills/dummies"
STATE = SKILL / "scripts/state.py"
PAGE = SKILL / "scripts/page.py"
NOW = "2026-01-05T20:07:30+00:00"
EST = "EST (UTC-05:00)"
BEGIN, END = "<!-- dummies-autostart:begin -->", "<!-- dummies-autostart:end -->"
# The words of a credential name. A test joins a word and a value only when it runs.
TOKEN, SECRET, PASSWORD, KEY = "tok" + "en", "sec" + "ret", "pass" + "word", "k" + "ey"

FAKE_OKKNOW = textwrap.dedent('''\
    #!%(python)s
    """A fake okknow command. The pages are files below FAKE_OK_DIR/pages. FAKE_OK_MODE plants a failure."""
    import json
    import os
    import re
    import sys

    ROOT = os.environ["FAKE_OK_DIR"]
    MODE = os.environ.get("FAKE_OK_MODE", "")


    def path(name):
        return os.path.join(ROOT, "pages", name + ".md")


    def load(name):
        try:
            with open(path(name), encoding="utf-8") as handle:
                return handle.read()
        except FileNotFoundError:
            return None


    def store(name, text):
        os.makedirs(os.path.dirname(path(name)), exist_ok=True)
        with open(path(name), "w", encoding="utf-8") as handle:
            handle.write(text)


    def body_start(text):
        match = re.match(r"---\\n.*?\\n---\\n", text, re.S)
        return match.end() if match else 0


    def fail(message, code):
        print("okknow: " + message, file=sys.stderr)
        sys.exit(code)


    def main():
        argv = sys.argv[1:]
        as_json = argv[:1] == ["--json"]
        argv = argv[1:] if as_json else argv
        command, rest = argv[0], argv[1:]
        stdin = sys.stdin.read() if "-" in rest else ""
        with open(os.path.join(ROOT, "calls.log"), "a", encoding="utf-8") as log:
            log.write(json.dumps({"argv": argv, "stdin": stdin}) + "\\n")
        if MODE == "down":
            fail("cannot reach the knowledge base", 3)
        if command == "read":
            text = load(rest[0])
            if text is None:
                fail("not found: " + rest[0], 1)
            sys.stdout.write(json.dumps({"docName": rest[0], "content": text}) if as_json else text)
        elif command == "write":
            name, position = rest[0], "append" if "--append" in rest else "replace"
            if len(rest[rest.index("--summary") + 1]) > 80:
                fail("--summary is too long", 2)
            current = load(name)
            if position == "replace":
                if current is not None and "--replace" not in rest:
                    fail(name + " exists. Read it first.", 2)
                if not re.match(r"---\\n(?:.*\\n)*?type:\\s*\\S", stdin):
                    fail("refused: a page needs frontmatter with a type", 2)
                store(name, stdin)
            else:
                store(name, (current or "") + stdin)
            print("wrote " + name + " (" + position + ")")
        elif command == "call" and rest[0] == "edit":
            document = json.loads(stdin if rest[1] == "-" else rest[1])["document"]
            text = load(document["path"])
            position = body_start(text or "") - 1
            for _ in range(document.get("occurrence") or 1):
                position = (text or "").find(document["find"], position + 1)
                if position < 0:
                    break
            if text is None or position < 0:
                print(json.dumps({"content": [{"type": "text", "text": "Text not found"}], "isError": True}))
                fail("edit returned isError", 1)
            changed = text[:position] + document["replace"] + text[position + len(document["find"]):]
            if MODE == "edit-lost":
                changed = text
            elif MODE == "edit-damages":
                changed = changed.replace("**Next:**", "**Next:** (changed)")
            elif MODE == "edit-other-writer":
                changed = changed.replace(document["replace"], OTHER + "\\n\\n" + document["replace"])
            elif MODE == "edit-below":
                # The new entry goes to the end of the page, below each older entry.
                entry = document["replace"][:len(document["replace"]) - len(document["find"])].rstrip()
                changed = text.rstrip() + "\\n\\n" + entry + "\\n"
            store(document["path"], changed)
            print(json.dumps({"content": [{"type": "text", "text": "edited"}], "isError": False}))
        elif command == "call" and rest[0] == "exec":
            found = []
            for folder, _, files in os.walk(os.path.join(ROOT, "pages")):
                if "DUMMIES.md" in files:
                    name = os.path.relpath(os.path.join(folder, "DUMMIES.md"), os.path.join(ROOT, "pages"))
                    text = load(name[:-3])
                    zone = re.search(r"(?m)^timezone:\\s*(.+)$", text[:body_start(text)])
                    found.append({"path": name, "frontmatter": {"timezone": zone.group(1)} if zone else {}})
            found.sort(key=lambda item: item["path"])
            if MODE == "exec-plain":
                content = {"text": "\\n".join("./" + item["path"] for item in found)}
            else:
                content = {"text": "", "enrichedPaths": found}
            print(json.dumps({"content": [], "structuredContent": content}))
        else:
            fail("the fake has no command " + command, 2)


    OTHER = ("### Jan 5, 2026, 3:07 PM EST | Agent: Pi | Model: other/model | Entry of another writer\\n\\n"
             "**Goal:** G.\\n\\n**Executed:** E.\\n\\n**Relevance:** ONE MORE WRITER WAS HERE.\\n\\n"
             "**Effects:** F.\\n\\n**Next:** N.")
    main()
    ''')

FAKE_HERDR = textwrap.dedent('''\
    #!%(python)s
    """A fake herdr command: `agent get <pane>` prints the record of FAKE_HERDR_AGENT."""
    import json
    import os
    import sys

    if sys.argv[1:3] != ["agent", "get"] or "FAKE_HERDR_AGENT" not in os.environ:
        sys.exit(1)
    print(json.dumps({"result": {"agent": json.loads(os.environ["FAKE_HERDR_AGENT"])}}))
    ''')

BODY = textwrap.dedent("""\
    **Important:** VERSION 2.4.0 IS MERGED, BUT THE COMMITS ARE NOT PUSHED.
    **Open:** Clients must read the tool list again. The user approves the push.
    **Next:** Push `local-dev` after the approval of the user.
    **Goal:** Update the fork to the newest upstream release and keep the local fixes.

    #### Done

    | # | Step | Resource and result |
    | --- | --- | --- |
    | 1 | Inspect | origin is the private remote |
    | 2 | Fetch | tag v2.4.0 with 31 new commits |
    | 3 | Merge | 3 conflicts in src/search.rs |
    | 4 | Check | just test, 1,833 tests passed |
    | 5 | Record | the entry of this session on the page DUMMIES |

    #### State at completion

    | Item | Result |
    | --- | --- |
    | Source | `local-dev` at the merge commit, not pushed |
    | Checks | just test, 1,833 tests passed |
    """)
# A body in the old form, with the five labels of an older entry. `add` refuses it; `check` accepts such an entry.
OLD_BODY = textwrap.dedent("""\
    **Goal:** Update the fork to the newest upstream release and keep the local fixes.
    **Executed:** I fetched tag v2.4.0, merged it into `local-dev` and resolved 3 conflicts.
    **Relevance:** VERSION 2.4.0 IS MERGED, BUT THE COMMITS ARE NOT PUSHED.
    **Effects:** Clients must read the tool list again.
    **Next:** Push `local-dev` after the approval of the user.
    """)

# A page in the form of an accepted hand-made page: the contract names the entries heading in a
# code span, and the one entry has no record line.
HAND_MADE = textwrap.dedent("""\
    ---
    type: Session Log
    title: Example human session log
    description: Newest-first session outcomes.
    order: newest-first
    timezone: EST (UTC-05:00)
    ---
    # Example human session log

    Read the newest entry first.

    ## Update contract for agents

    2. Insert one entry immediately below `## Session entries`, above older entries.

    ## Session entries

    ### Jan 4, 2026, 10:44 PM EST | Agent: Pi | Model: router/alias | First hand-made entry

    **Goal:** Record the first session.

    **Executed:** I wrote this entry by hand.

    **Relevance:** THE FIRST ENTRY HAS NO RECORD LINE.

    **Effects:** None.

    **Next:** Add the next entry with the script.
    """)


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TextCapture(io.StringIO):
    def reconfigure(self, **options):
        pass


class Sandbox(unittest.TestCase):
    """A temporary home directory, and a PATH with the two fake commands and with Git only."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenantpi-dummies-")
        self.addCleanup(temp.cleanup)
        self.work = Path(temp.name)
        self.home, self.bin, self.tools, self.ok = (self.work / name for name in ("home", "bin", "tools", "ok"))
        for directory in (self.home, self.bin, self.tools, self.ok / "pages"):
            directory.mkdir(parents=True)
        for name, text in (("okknow", FAKE_OKKNOW), ("herdr", FAKE_HERDR)):
            path = self.bin / name
            path.write_text(text % {"python": sys.executable}, encoding="utf-8")
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        if shutil.which("git"):
            (self.tools / "git").symlink_to(shutil.which("git"))

    def env(self, okknow=True, **extra):
        path = (str(self.bin) + os.pathsep if okknow else "") + str(self.tools)
        base = {"PATH": path, "HOME": str(self.home), "LANG": "C", "PYTHONDONTWRITEBYTECODE": "1",
                "FAKE_OK_DIR": str(self.ok), "DUMMIES_NOW": NOW,
                # A temporary directory inside a repository is still no repository for a test.
                "GIT_CEILING_DIRECTORIES": str(self.work.parent)}
        base.update({key: value for key, value in extra.items() if value is not None})
        return base

    def run_script(self, script, *args, stdin=None, okknow=True, **extra):
        # Keep real entry-point, exit-code and stdin coverage in these five tests.
        smoke = {"test_wrong_arguments_exit_2", "test_no_file_means_off_and_status_writes_nothing",
                 "test_without_okknow_each_command_stops_with_exit_4_and_writes_nothing",
                 "test_a_failure_of_okknow_is_exit_3", "test_a_local_file_that_the_user_named_needs_no_okknow"}
        if self._testMethodName in smoke:
            return subprocess.run([sys.executable, str(script), *args], input=stdin, capture_output=True, encoding="utf-8",
                                  env=self.env(okknow, **extra), cwd=self.work)
        out, err = TextCapture(), TextCapture()
        with mock.patch.dict(os.environ, self.env(okknow, **extra), clear=True), contextlib.chdir(self.work), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO((stdin or "").encode()), encoding="utf-8")), \
                mock.patch.object(sys, "argv", [str(script), *args]):
            module = load_module(script, "dummies_" + script.stem)
            try:
                code = module.main(list(args))
            except SystemExit as stop:
                code = stop.code
        return subprocess.CompletedProcess([str(script), *args], code, out.getvalue(), err.getvalue())

    def calls(self):
        log = self.ok / "calls.log"
        return [json.loads(line)["argv"] for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []

    def page_file(self, name="projects/demo/DUMMIES"):
        return self.ok / "pages" / (name + ".md")


class StateTests(Sandbox):
    def state(self, *args, **extra):
        return self.run_script(STATE, *args, **extra)

    def state_file(self):
        return self.home / ".config/dummies-skill/state.json"

    def saved(self):
        return json.loads(self.state_file().read_text(encoding="utf-8"))

    def instruction(self, content, name=".claude/CLAUDE.md"):
        """An instruction file below the home directory with these bytes."""
        path = self.home / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def round_trip(self, path, **extra):
        """(bytes after on --autostart, bytes after off, or None for no file) of an instruction file."""
        extra = extra or {"CLAUDECODE": "1"}
        added = self.state("on", "--autostart", **extra)
        self.assertEqual(0, added.returncode, added.stderr)
        middle = path.read_bytes()
        removed = self.state("off", **extra)
        self.assertEqual(0, removed.returncode, removed.stderr)
        return middle, path.read_bytes() if path.exists() else None

    def test_no_file_means_off_and_status_writes_nothing(self):
        result = self.state(CLAUDECODE="1")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(result.stdout.startswith("dummies: off for claude | pi: off | autostart: none | "), result.stdout)
        self.assertIn("state file: ~/.config/dummies-skill/state.json (absent)", result.stdout)
        self.assertEqual(1, len(result.stdout.splitlines()))
        self.assertFalse(self.state_file().exists())
        self.assertEqual(result.stdout, self.state("status", CLAUDECODE="1").stdout)

    def test_each_word_and_each_harness_has_its_own_value(self):
        on = self.state("on", CLAUDECODE="1")
        self.assertEqual(0, on.returncode, on.stderr)
        self.assertIn("dummies: on for claude (was off)", on.stdout)
        self.assertEqual({"claude": "on"}, json.loads(self.state_file().read_text()))
        self.assertTrue(self.state(CLAUDECODE="1").stdout.startswith("dummies: on for claude | pi: off | "))
        self.assertTrue(self.state(AI_AGENT="pi").stdout.startswith("dummies: off for pi | claude: on | "))
        self.assertIn("dummies: on for pi (was off)", self.state("on", AI_AGENT="pi").stdout)
        self.assertEqual({"claude": "on", "pi": "on"}, json.loads(self.state_file().read_text()))
        off = self.state("off", CLAUDECODE="1")
        self.assertIn("dummies: off for claude (was on)", off.stdout)
        self.assertIn("autostart: no block to remove.", off.stdout)
        self.assertEqual({"claude": "off", "pi": "on"}, json.loads(self.state_file().read_text()))
        self.assertTrue(self.state(AI_AGENT="pi").stdout.startswith("dummies: on for pi | claude: off | "))

    def test_harness_comes_from_the_argument_the_marker_or_herdr(self):
        cases = (({"CLAUDECODE": "1"}, "claude"), ({"AI_AGENT": "claude-code_9-9-9_agent"}, "claude"),
                 ({"PI_CODING_AGENT": "true"}, "pi"), ({"AI_AGENT": "pi", "CLAUDECODE": "1"}, "pi"),
                 ({"AI_AGENT": "claude-code_9-9-9_agent", "PI_CODING_AGENT": "true"}, "claude"))
        for extra, harness in cases:
            with self.subTest(extra=extra):
                self.assertTrue(self.state(**extra).stdout.startswith(f"dummies: off for {harness} | "))
        # The argument wins over a marker. Two markers with no AI_AGENT need Herdr or the argument.
        self.assertTrue(self.state("status", "--harness", "pi", CLAUDECODE="1").stdout.startswith("dummies: off for pi"))
        for extra in ({}, {"CLAUDECODE": "1", "PI_CODING_AGENT": "true"}):
            unknown = self.state(**extra)
            self.assertEqual(2, unknown.returncode)
            self.assertIn("the harness is not known: add --harness pi or --harness claude", unknown.stderr)
        herdr = {"HERDR_ENV": "1", "HERDR_PANE_ID": "w1:p1",
                 "FAKE_HERDR_AGENT": json.dumps({"agent": "pi", "name": "demo-coordinator-1"})}
        self.assertTrue(self.state(**herdr).stdout.startswith("dummies: off for pi | "))

    def test_role_of_a_herdr_pane(self):
        for name, expected in (("demo-coordinator-1", "role: coordinator (Herdr) |"),
                               ("demo-worker-12", "role: worker (Herdr): a task session does not use dummies |"),
                               ("demo-reviewer-2", "role: reviewer (Herdr): a task session does not use dummies |"),
                               (None, "role: not known (the Herdr name has no role): your start prompt decides |")):
            with self.subTest(name=name):
                result = self.state(CLAUDECODE="1", HERDR_ENV="1", HERDR_PANE_ID="w1:p1",
                                    FAKE_HERDR_AGENT=json.dumps({"agent": "claude", "name": name}))
                self.assertIn(expected, result.stdout)
        self.assertIn("role: not known (no Herdr): your start prompt decides |", self.state(CLAUDECODE="1").stdout)

    def test_on_changes_no_instruction_file_without_the_option(self):
        memory = self.home / ".claude/CLAUDE.md"
        memory.parent.mkdir()
        memory.write_text("# My rules\n\nKeep it short.\n", encoding="utf-8")
        result = self.state("on", CLAUDECODE="1")
        self.assertEqual("# My rules\n\nKeep it short.\n", memory.read_text(encoding="utf-8"))
        self.assertIn("autostart: none. A new session uses dummies only after the user starts the skill by name.",
                      result.stdout)
        # The output shows the exact lines and the file that the option changes.
        self.assertIn("run on --autostart. It adds these lines to ~/.claude/CLAUDE.md, and off removes them:", result.stdout)
        block = result.stdout[result.stdout.index("<!-- dummies-autostart:begin -->"):].strip()
        self.assertTrue(block.endswith("<!-- dummies-autostart:end -->"))
        self.assertEqual(3, len(block.splitlines()))
        self.assertIn(f"read the file `{SKILL / 'REPORT.md'}` and apply it", block)
        self.assertIn("dummies is on: a standing order of the user.", block)
        self.assertIn("A task session ignores this block and reads no file of it.", block)
        self.assertNotIn("autostart", json.loads(self.state_file().read_text()))
        # The option adds exactly these lines, and off takes them out again.
        added = self.state("on", "--autostart", CLAUDECODE="1")
        self.assertIn("autostart: added the block to ~/.claude/CLAUDE.md.", added.stdout)
        self.assertEqual("# My rules\n\nKeep it short.\n\n" + block + "\n", memory.read_text(encoding="utf-8"))
        self.assertEqual({"claude": "on", "autostart": {"claude": [str(memory)]}}, json.loads(self.state_file().read_text()))
        self.assertIn("| autostart: ~/.claude/CLAUDE.md |", self.state(CLAUDECODE="1").stdout)
        again = self.state("on", "--autostart", CLAUDECODE="1")
        self.assertIn("autostart: the block is already in ~/.claude/CLAUDE.md.", again.stdout)
        self.assertEqual(1, memory.read_text(encoding="utf-8").count("dummies-autostart:begin"))
        off = self.state("off", CLAUDECODE="1")
        self.assertIn("autostart: removed the block from ~/.claude/CLAUDE.md.", off.stdout)
        self.assertEqual("# My rules\n\nKeep it short.\n", memory.read_text(encoding="utf-8"))
        self.assertEqual({"claude": "off"}, json.loads(self.state_file().read_text()))

    def test_autostart_file_of_each_harness(self):
        agent_dir = self.work / "profile"
        agent_dir.mkdir()
        # Pi with no instruction file: the block makes AGENTS.md, and off removes the file again.
        self.state("on", "--autostart", AI_AGENT="pi", PI_CODING_AGENT_DIR=str(agent_dir))
        self.assertTrue((agent_dir / "AGENTS.md").read_text(encoding="utf-8").startswith("<!-- dummies-autostart:begin -->"))
        self.state("off", AI_AGENT="pi", PI_CODING_AGENT_DIR=str(agent_dir))
        self.assertFalse((agent_dir / "AGENTS.md").exists())
        # Pi loads the first file of its list: the override file gets the block.
        (agent_dir / "AGENTS.md").write_text("Base.\n", encoding="utf-8")
        (agent_dir / "AGENTS.override.md").write_text("Override.", encoding="utf-8")
        self.state("on", "--autostart", AI_AGENT="pi", PI_CODING_AGENT_DIR=str(agent_dir))
        self.assertEqual("Base.\n", (agent_dir / "AGENTS.md").read_text(encoding="utf-8"))
        self.assertIn("dummies-autostart:begin", (agent_dir / "AGENTS.override.md").read_text(encoding="utf-8"))
        # Off in a session of another profile still finds the recorded file.
        self.state("off", AI_AGENT="pi")
        self.assertEqual("Override.", (agent_dir / "AGENTS.override.md").read_text(encoding="utf-8"))
        # Claude Code: the configuration directory variable names the place. The default is ~/.claude.
        config = self.work / "claude-config"
        self.state("on", "--autostart", CLAUDECODE="1", CLAUDE_CONFIG_DIR=str(config))
        self.assertIn("dummies-autostart:end", (config / "CLAUDE.md").read_text(encoding="utf-8"))
        self.assertFalse((self.home / ".claude").exists())
        self.assertFalse((self.home / ".pi").exists())

    def test_a_link_stays_a_link_and_a_damaged_block_stops(self):
        real = self.work / "dotfiles/CLAUDE.md"
        real.parent.mkdir()
        real.write_text("Linked.\n", encoding="utf-8")
        (self.home / ".claude").mkdir()
        (self.home / ".claude/CLAUDE.md").symlink_to(real)
        self.state("on", "--autostart", CLAUDECODE="1")
        self.assertTrue((self.home / ".claude/CLAUDE.md").is_symlink())
        self.assertIn("dummies-autostart:begin", real.read_text(encoding="utf-8"))
        self.state("off", CLAUDECODE="1")
        self.assertTrue((self.home / ".claude/CLAUDE.md").is_symlink())
        self.assertEqual("Linked.\n", real.read_text(encoding="utf-8"))
        damaged = "Text.\n<!-- dummies-autostart:begin -->\nno end line\n"
        real.write_text(damaged, encoding="utf-8")
        for word in (("on", "--autostart"), ("off",)):
            result = self.state(*word, CLAUDECODE="1")
            self.assertEqual(4, result.returncode, result.stdout)
            self.assertIn("damaged dummies block", result.stderr)
            self.assertEqual(damaged, real.read_text(encoding="utf-8"))
        self.assertEqual(0, self.state(CLAUDECODE="1").returncode)

    def test_a_state_file_that_is_not_valid(self):
        self.state_file().parent.mkdir(parents=True)
        for text in ("{not json", "[]", '{"claude": "yes"}', '{"pi": true}', '{"autostart": {"pi": "AGENTS.md"}}',
                     '{"created": {"pi": "AGENTS.md"}}', '{"created": ["AGENTS.md"]}'):
            with self.subTest(text=text):
                self.state_file().write_text(text, encoding="utf-8")
                status = self.state(CLAUDECODE="1")
                self.assertEqual(3, status.returncode)
                self.assertTrue(status.stdout.startswith("dummies: off for claude | state file not valid: "), status.stdout)
                self.assertIn("The state counts as off. Move the file away, then run on or off again.", status.stderr)
                for word in (("on",), ("on", "--autostart"), ("off",)):
                    result = self.state(*word, CLAUDECODE="1")
                    self.assertEqual(3, result.returncode)
                    self.assertEqual("", result.stdout)
                    self.assertEqual(text, self.state_file().read_text(encoding="utf-8"))
                self.assertFalse((self.home / ".claude").exists())

    def test_wrong_arguments_exit_2(self):
        for args in (("start",), ("off", "--autostart"), ("status", "--autostart"), ("on", "--harness", "codex")):
            with self.subTest(args=args):
                self.assertEqual(2, self.state(*args, CLAUDECODE="1").returncode)
        self.assertFalse(self.state_file().exists())

    def test_xdg_config_home_names_the_place(self):
        config = self.work / "xdg"
        self.state("on", CLAUDECODE="1", XDG_CONFIG_HOME=str(config))
        self.assertEqual({"claude": "on"}, json.loads((config / "dummies-skill/state.json").read_text()))
        self.assertFalse(self.state_file().exists())
        # A place that cannot hold the file gives one line and a fixed code, no trace.
        (self.work / "a-file").write_text("x", encoding="utf-8")
        for word in ("status", "on", "off"):
            result = self.state(word, CLAUDECODE="1", XDG_CONFIG_HOME=str(self.work / "a-file"))
            self.assertEqual(3, result.returncode, result.stderr)
            self.assertIn("state file not readable:", result.stderr)
            self.assertIn("The state counts as off.", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
        state = load_module(STATE, "dummies_state")
        with mock.patch.object(state, "write_text", side_effect=PermissionError()):
            with self.assertRaises(state.Stop) as stopped:
                state.save(str(config / "dummies-skill/state.json"), {"claude": "off"})
        self.assertEqual((3, "state file not writable: "), (stopped.exception.code, str(stopped.exception)[:25]))

    def test_a_marker_is_a_complete_line(self):
        # A line of the user that quotes a marker is text of the user: on adds its block below it, and off gives
        # each byte back.
        for name, content in (
                ("both markers in one line", f"Docs: wrap with `{BEGIN}` ... `{END}`.\nKeep this other text.\n"),
                ("one marker only", f"The block starts with `{BEGIN}` in my notes.\nMore.\n"),
                ("a marker after other text", f"See {END}\n"),
                ("a marker with text after it", f"{BEGIN} is the first line of the block.\n")):
            with self.subTest(case=name):
                path = self.instruction(content.encode())
                middle, after = self.round_trip(path)
                self.assertTrue(middle.startswith((content + "\n" + BEGIN + "\n").encode()), middle)
                self.assertTrue(middle.endswith((END + "\n").encode()), middle)
                self.assertEqual(content.encode(), after)
        # One marker line without the other, the end line first, and two blocks: exit 4 and no change.
        for name, content in (("the begin line only", f"A\n{BEGIN}\nB\n"), ("the end line only", f"A\n{END}\nB\n"),
                              ("the end line first", f"{END}\nA\n{BEGIN}\n"),
                              ("two blocks", f"A\n{BEGIN}\nx\n{END}\nB\n{BEGIN}\ny\n{END}\nC\n")):
            with self.subTest(case=name):
                path = self.instruction(content.encode())
                for word in (("on", "--autostart"), ("off",)):
                    result = self.state(*word, CLAUDECODE="1")
                    self.assertEqual(4, result.returncode, result.stdout)
                    self.assertIn("instruction file has a damaged dummies block: ~/.claude/CLAUDE.md", result.stderr)
                    self.assertEqual(content.encode(), path.read_bytes())
        # A block directly below a line of the user, with no empty line: the line end of that line stays.
        path = self.instruction(f"A\n{BEGIN}\nold text\n{END}\nB\n".encode())
        self.assertEqual(0, self.state("off", CLAUDECODE="1").returncode)
        self.assertEqual(b"A\nB\n", path.read_bytes())
        # A marker line with blanks at its end is a marker line: off removes the block.
        path = self.instruction(f"A\n\n{BEGIN}  \nold text\n{END}\t\n".encode())
        self.assertIn("| autostart: ~/.claude/CLAUDE.md (the state is off: run off to remove the block) |",
                      self.state(CLAUDECODE="1").stdout)
        self.assertEqual(0, self.state("off", CLAUDECODE="1").returncode)
        self.assertEqual(b"A\n", path.read_bytes())

    def test_on_autostart_then_off_gives_each_byte_back(self):
        lines = load_module(STATE, "dummies_state_lines").block_lines()
        cases = (("LF", b"# My rules\n\nKeep it short.\n", b"\n"),
                 ("CRLF", b"line1\r\nline2\r\n", b"\r\n"),
                 ("no last line end", b"A\nB", b"\n"),
                 ("CRLF and no last line end", b"A\r\nB", b"\r\n"),
                 ("empty lines at the end", b"A\n\n\n", b"\n"),
                 ("one empty line", b"\n", b"\n"),
                 ("white space only and no last line end", b"  ", b"\n"),
                 ("LF in the last line after CRLF", b"a\r\nb\n", b"\n"),
                 ("CRLF in the last line after LF", b"a\nb\r\n", b"\r\n"),
                 ("a last carriage return", b"A\r", b"\n"),
                 ("a byte order mark and text outside ASCII", b"\xef\xbb\xbfcaf\xc3\xa9 \xe2\x86\x92 text\n", b"\n"))
        for name, content, line_end in cases:
            with self.subTest(case=name):
                path = self.instruction(content)
                path.chmod(0o600)
                middle, after = self.round_trip(path)
                # The text of the user is the start of the file. The block has the line end of the file, with
                # one empty line before it. The file ends with a line end only when it did before.
                block = line_end.join(line.encode() for line in lines)
                self.assertEqual(content + (line_end + block + line_end if content.endswith(b"\n")
                                            else line_end * 2 + block), middle)
                self.assertEqual(content, after)
                self.assertEqual(0o600, stat.S_IMODE(path.stat().st_mode))
        # The same for the context file of Pi.
        path = self.instruction(b"Pi rules.\r\n", ".pi/agent/AGENTS.md")
        self.assertEqual(b"Pi rules.\r\n", self.round_trip(path, AI_AGENT="pi")[1])
        # A second on --autostart changes nothing, and off still gives each byte back.
        path = self.instruction(b"A\r\nB")
        self.state("on", "--autostart", CLAUDECODE="1")
        middle = path.read_bytes()
        self.assertIn("autostart: the block is already in ~/.claude/CLAUDE.md.",
                      self.state("on", "--autostart", CLAUDECODE="1").stdout)
        self.assertEqual(middle, path.read_bytes())
        self.state("off", CLAUDECODE="1")
        self.assertEqual(b"A\r\nB", path.read_bytes())
        # Text that the user adds below the block stays, with the text above the block.
        path = self.instruction(b"Above.\n")
        self.state("on", "--autostart", CLAUDECODE="1")
        path.write_bytes(path.read_bytes() + b"\nBelow.\n")
        self.assertEqual(0, self.state("off", CLAUDECODE="1").returncode)
        self.assertEqual(b"Above.\n\nBelow.\n", path.read_bytes())

    def test_off_removes_only_a_file_that_on_created(self):
        path = self.home / ".claude/CLAUDE.md"
        # No file: on creates it and records that. off removes it again.
        self.assertEqual(0, self.state("on", "--autostart", CLAUDECODE="1").returncode)
        self.assertTrue(path.read_bytes().startswith((BEGIN + "\n").encode()))
        self.assertEqual({"claude": "on", "autostart": {"claude": [str(path)]}, "created": {"claude": [str(path.resolve())]}},
                         self.saved())
        self.assertEqual(0, self.state("off", CLAUDECODE="1").returncode)
        self.assertFalse(path.exists())
        self.assertEqual({"claude": "off"}, self.saved())
        # A file of the user that is empty or holds only white space stays, with its bytes.
        for content in (b"", b" \n\t\n", b"\n\n"):
            with self.subTest(content=content):
                path.write_bytes(content)
                self.assertEqual(0, self.state("on", "--autostart", CLAUDECODE="1").returncode)
                self.assertNotIn("created", self.saved())
                self.assertEqual(0, self.state("off", CLAUDECODE="1").returncode)
                self.assertTrue(path.is_file())
                self.assertEqual(content, path.read_bytes())
        # A file that holds only the block, and that the user made: no record says that on created it.
        block = "\n".join(load_module(STATE, "dummies_state_block").block_lines())
        path.write_text(block + "\n", encoding="utf-8")
        removed = self.state("off", CLAUDECODE="1")
        self.assertIn("autostart: removed the block from ~/.claude/CLAUDE.md.", removed.stdout)
        self.assertTrue(path.is_file())
        self.assertEqual(b"", path.read_bytes())
        # A file that on created and that then got text of the user is not removed.
        path.unlink()
        self.state("on", "--autostart", CLAUDECODE="1")
        self.assertIn("created", self.saved())
        path.write_bytes(b"My rule.\n\n" + path.read_bytes())
        self.state("off", CLAUDECODE="1")
        self.assertEqual(b"My rule.\n", path.read_bytes())
        # An empty file of the user in the place of the created file is a file of the user.
        path.unlink()
        self.state("on", "--autostart", CLAUDECODE="1")
        path.write_bytes(b"")
        self.state("on", "--autostart", CLAUDECODE="1")
        self.assertNotIn("created", self.saved())
        self.state("off", CLAUDECODE="1")
        self.assertEqual(b"", path.read_bytes())
        # A link with no target: on creates the target, and off removes the target. The link stays.
        path.unlink()
        target = self.work / "dotfiles/CLAUDE.md"
        target.parent.mkdir()
        path.symlink_to(target)
        self.state("on", "--autostart", CLAUDECODE="1")
        self.assertTrue(target.is_file())
        self.assertEqual({"claude": [str(target.resolve())]}, self.saved()["created"])
        self.state("off", CLAUDECODE="1")
        self.assertFalse(target.exists())
        self.assertTrue(path.is_symlink())
        # A path in the list of created files that is not in the list of autostart files removes nothing.
        other = self.work / "other/CLAUDE.md"
        other.parent.mkdir()
        other.write_text(block + "\n", encoding="utf-8")
        self.state_file().write_text(json.dumps({"claude": "on", "created": {"claude": [str(other.resolve())]}}))
        self.assertEqual(0, self.state("off", CLAUDECODE="1").returncode)
        self.assertEqual(block + "\n", other.read_text(encoding="utf-8"))
        self.assertEqual({"claude": "off"}, self.saved())

    def test_off_always_saves_the_state(self):
        path = self.instruction(b"A\n")
        self.state("on", "--autostart", CLAUDECODE="1")
        damaged = path.read_bytes().replace((END + "\n").encode(), b"")
        path.write_bytes(damaged)
        off = self.state("off", CLAUDECODE="1")
        self.assertEqual(4, off.returncode, off.stdout)
        self.assertIn("dummies: off for claude (was on)", off.stdout)
        self.assertIn("the state is off, but an instruction file needs a repair by hand: instruction file has a damaged "
                      "dummies block: ~/.claude/CLAUDE.md: correct it by hand.", off.stderr)
        self.assertIn(f"Take the lines from `{BEGIN}` to `{END}` out of the file. Then run off again.", off.stderr)
        self.assertEqual(damaged, path.read_bytes())
        # The state is off, and the file that needs the repair stays in the record.
        self.assertEqual({"claude": "off", "autostart": {"claude": [str(path)]}}, self.saved())
        status = self.state(CLAUDECODE="1")
        self.assertEqual(0, status.returncode)
        self.assertTrue(status.stdout.startswith(
            "dummies: off for claude | pi: off | autostart: instruction file has a damaged dummies block: "
            "~/.claude/CLAUDE.md: correct it by hand | "), status.stdout)
        # After the repair by hand, off ends the record.
        path.write_bytes(b"A\n")
        again = self.state("off", CLAUDECODE="1")
        self.assertEqual(0, again.returncode, again.stderr)
        self.assertIn("autostart: no block to remove.", again.stdout)
        self.assertEqual({"claude": "off"}, self.saved())
        # A file that is not text in UTF-8, and a directory in the place of the file: the same rule.
        for name in ("bytes that are not UTF-8", "a directory"):
            with self.subTest(case=name):
                if name == "a directory":
                    path.unlink()
                    path.mkdir()
                else:
                    path.write_bytes(b"caf\xe9 text\n")
                added = self.state("on", "--autostart", CLAUDECODE="1")
                self.assertEqual(4, added.returncode, added.stdout)
                self.assertIn("instruction file not readable: ~/.claude/CLAUDE.md", added.stderr)
                self.assertEqual("off", self.saved()["claude"])
                self.state_file().write_text(json.dumps({"claude": "on"}), encoding="utf-8")
                off = self.state("off", CLAUDECODE="1")
                self.assertEqual(4, off.returncode, off.stdout)
                self.assertIn("needs a repair by hand: instruction file not readable: ~/.claude/CLAUDE.md", off.stderr)
                self.assertEqual("off", self.saved()["claude"])
                self.assertTrue(self.state(CLAUDECODE="1").stdout.startswith("dummies: off for claude | pi: off | "))
                if name == "a directory":
                    self.assertTrue(path.is_dir())
                else:
                    self.assertEqual(b"caf\xe9 text\n", path.read_bytes())

    def test_off_cleans_each_file_that_it_can_and_names_the_other_files(self):
        profile = self.work / "profile"
        profile.mkdir()
        (profile / "AGENTS.md").write_bytes(b"Profile.\n")
        in_home = self.instruction(b"Home.\n", ".pi/agent/AGENTS.md")
        self.state("on", "--autostart", AI_AGENT="pi", PI_CODING_AGENT_DIR=str(profile))
        self.state("on", "--autostart", AI_AGENT="pi")
        broken = (profile / "AGENTS.md").read_bytes().replace((BEGIN + "\n").encode(), b"")
        (profile / "AGENTS.md").write_bytes(broken)
        off = self.state("off", AI_AGENT="pi")
        self.assertEqual(4, off.returncode, off.stdout)
        self.assertIn("autostart: removed the block from ~/.pi/agent/AGENTS.md.", off.stdout)
        self.assertIn(f"instruction file has a damaged dummies block: {profile / 'AGENTS.md'}", off.stderr)
        self.assertEqual(b"Home.\n", in_home.read_bytes())
        self.assertEqual(broken, (profile / "AGENTS.md").read_bytes())
        self.assertEqual({"pi": "off", "autostart": {"pi": [str(profile / "AGENTS.md")]}}, self.saved())

    def test_a_state_file_that_is_a_link_is_not_used(self):
        other = self.work / "other/tool.json"
        other.parent.mkdir()
        foreign = '{"name": "the settings of another tool", "keep": 1}\n'
        other.write_text(foreign, encoding="utf-8")
        self.state_file().parent.mkdir(parents=True)
        for name, target in (("a link to a JSON object of another tool", other),
                             ("a link with no target", self.work / "outside/directory/new.json")):
            with self.subTest(case=name):
                self.state_file().symlink_to(target)
                status = self.state(CLAUDECODE="1")
                self.assertEqual(3, status.returncode)
                self.assertTrue(status.stdout.startswith(
                    "dummies: off for claude | state file is a link: ~/.config/dummies-skill/state.json: "), status.stdout)
                for word in (("on",), ("on", "--autostart"), ("off",)):
                    result = self.state(*word, CLAUDECODE="1")
                    self.assertEqual(3, result.returncode, result.stdout)
                    self.assertEqual("", result.stdout)
                    self.assertIn("state file is a link: ~/.config/dummies-skill/state.json: the script does not read "
                                  "it and does not write it. The state counts as off. Move the link away, then run "
                                  "on or off again.", result.stderr)
                self.assertTrue(self.state_file().is_symlink())
                self.assertEqual(foreign, other.read_text(encoding="utf-8"))
                self.assertFalse((self.work / "outside").exists())
                self.assertFalse((self.home / ".claude").exists())
                self.state_file().unlink()
        # save refuses a link also when the link comes after the read.
        state = load_module(STATE, "dummies_state_save")
        self.state_file().symlink_to(other)
        with self.assertRaises(state.Stop) as stopped:
            state.save(str(self.state_file()), {"claude": "on"})
        self.assertEqual(3, stopped.exception.code)
        self.assertEqual(foreign, other.read_text(encoding="utf-8"))

    def test_a_relative_xdg_config_home_is_not_used(self):
        for value in ("relative", "./relative/config"):
            with self.subTest(value=value):
                result = self.state("on", CLAUDECODE="1", XDG_CONFIG_HOME=value)
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertIn("| state file: ~/.config/dummies-skill/state.json", result.stdout)
                self.assertEqual({"claude": "on"}, self.saved())
                self.assertTrue(self.state(CLAUDECODE="1", XDG_CONFIG_HOME=value).stdout.startswith(
                    "dummies: on for claude | "))
        # The current directory of each call is the work directory of the test: it got no file.
        self.assertEqual([], sorted(self.work.rglob("relative")))

    def test_a_recorded_path_is_used_only_when_it_is_an_instruction_file(self):
        block = "\n".join(load_module(STATE, "dummies_state_record").block_lines())
        victim = self.work / "victim.txt"
        victim.write_text(f"keep\n\n{block}\n", encoding="utf-8")
        other = self.work / "other-profile/CLAUDE.md"
        other.parent.mkdir()
        other.write_text(f"Other.\n\n{block}\n", encoding="utf-8")
        self.state_file().parent.mkdir(parents=True)
        planted = {"claude": "on", "autostart": {"claude": [str(victim), "CLAUDE.md", str(other)], "pi": [str(victim)]}}
        self.state_file().write_text(json.dumps(planted), encoding="utf-8")
        ignored = f"ignored from the state file, not an instruction file of claude: {victim}, CLAUDE.md"
        status = self.state(CLAUDECODE="1")
        self.assertEqual(0, status.returncode, status.stderr)
        self.assertIn(f"| autostart: {other} ({ignored}) |", status.stdout)
        self.assertEqual(planted, self.saved())
        # off uses the file with the name that Claude Code loads, in each directory. It names the other paths.
        off = self.state("off", CLAUDECODE="1")
        self.assertEqual(0, off.returncode, off.stderr)
        self.assertIn(f"autostart: removed the block from {other}.", off.stdout)
        self.assertIn(f"autostart: {ignored}. The script changed no such path, and the state file does not name such "
                      "a path now.", off.stdout)
        self.assertEqual(f"keep\n\n{block}\n", victim.read_text(encoding="utf-8"))
        self.assertEqual("Other.\n", other.read_text(encoding="utf-8"))
        # The record of the other harness is not the work of this call.
        self.assertEqual({"claude": "off", "autostart": {"pi": [str(victim)]}}, self.saved())
        # on --autostart takes such a path out of the record of its harness, and names it.
        (self.home / ".pi/agent").mkdir(parents=True)
        added = self.state("on", "--autostart", AI_AGENT="pi")
        self.assertEqual(0, added.returncode, added.stderr)
        self.assertIn(f"autostart: ignored from the state file, not an instruction file of pi: {victim}. The state "
                      "file does not name such a path now.", added.stdout)
        self.assertEqual({"pi": [str(self.home / ".pi/agent/AGENTS.md")]}, self.saved()["autostart"])
        self.assertEqual(f"keep\n\n{block}\n", victim.read_text(encoding="utf-8"))
        # For Pi, each name of its list of context files is an instruction file.
        for name in ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"):
            with self.subTest(name=name):
                recorded = self.work / "pi-profile" / name
                recorded.parent.mkdir(exist_ok=True)
                recorded.write_text(f"Pi.\n\n{block}\n", encoding="utf-8")
                self.state_file().write_text(json.dumps({"pi": "on", "autostart": {"pi": [str(recorded)]}}))
                self.assertEqual(0, self.state("off", AI_AGENT="pi").returncode)
                self.assertEqual("Pi.\n", recorded.read_text(encoding="utf-8"))
                recorded.unlink()


class PageTests(Sandbox):
    def page(self, *args, stdin=None, okknow=True, harness=True, **extra):
        if harness and not {"AI_AGENT", "CLAUDECODE", "PI_CODING_AGENT"} & set(extra):
            extra.setdefault("CLAUDECODE", "1")
            extra.setdefault("CLAUDE_CODE_SESSION_ID", "session-a")
        return self.run_script(PAGE, *args, stdin=stdin, okknow=okknow, **extra)

    def init(self, project="demo", zone=EST):
        result = self.page("init", "--project", project, "--zone", zone)
        self.assertEqual(0, result.returncode, result.stderr)
        return result

    def add(self, summary, *args, body=BODY, **extra):
        return self.page("add", "--project", "demo", "--summary", summary, "--model", "example/model", *args,
                         stdin=body, **extra)

    def entries(self, name="projects/demo/DUMMIES"):
        text = self.page_file(name).read_text(encoding="utf-8")
        return [line for line in text.splitlines() if line.startswith("### ")]

    # --- no knowledge base ---

    def test_without_okknow_each_command_stops_with_exit_4_and_writes_nothing(self):
        for args in (("heading",), ("init", "--zone", "UTC"), ("add", "--summary", "S"), ("recent",), ("check",)):
            with self.subTest(command=args[0]):
                result = self.page(*args, "--project", "demo", stdin=BODY, okknow=False)
                self.assertEqual(4, result.returncode, result.stdout)
                self.assertIn("no knowledge base: the okknow command is not on the path. Tell the user.", result.stderr)
                self.assertEqual("", result.stdout)
        self.assertEqual([], [path for path in self.work.rglob("*.md")])

    @slow
    def test_a_failure_of_okknow_is_exit_3(self):
        self.init()
        for args in (("heading",), ("init",), ("add", "--summary", "S"), ("recent",), ("check",)):
            with self.subTest(command=args[0]):
                result = self.page(*args, "--project", "demo", stdin=BODY, FAKE_OK_MODE="down")
                self.assertEqual(3, result.returncode, result.stdout)
                self.assertIn("okknow read failed with exit 3: okknow: cannot reach the knowledge base", result.stderr)

    # --- init ---

    def test_init_makes_a_page_that_follows_the_contract(self):
        result = self.init()
        self.assertEqual("created: projects/demo/DUMMIES | zone: EST (UTC-05:00) (from the argument) | handoffs: none\n",
                         result.stdout)
        text = self.page_file().read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\ntype: Session Log\ntitle: demo human session log\n"))
        for line in ("order: newest-first", "timezone: EST (UTC-05:00)", "  - demo", "# demo human session log",
                     "## Update contract for agents", "## Session entries", "No entry yet."):
            self.assertIn(line, text.splitlines())
        self.assertNotIn("{", text.replace("{title}", ""))
        self.assertNotIn("handoffs", text)
        self.assertEqual("check: valid | projects/demo/DUMMIES | entries: 0 | zone: EST (UTC-05:00)\n",
                         self.page("check", "--project", "demo").stdout)
        # A second init reads the page and writes nothing.
        before = len(self.calls())
        again = self.page("init", "--project", "demo", "--zone", "UTC")
        self.assertEqual("exists: projects/demo/DUMMIES | zone: EST (UTC-05:00) | nothing written\n", again.stdout)
        self.assertEqual([["read", "projects/demo/DUMMIES"]], self.calls()[before:])
        self.assertEqual(text, self.page_file().read_text(encoding="utf-8"))

    @slow
    def test_zone_of_a_new_page(self):
        # No argument and no other page: the agent asks the user. Nothing is written.
        ask = self.page("init", "--project", "demo")
        self.assertEqual(7, ask.returncode)
        self.assertIn("Ask the user one time for the zone of projects/demo/DUMMIES.", ask.stderr)
        self.assertIn('run init --zone "<label> (UTC+HH:MM)". With no answer, run init --zone UTC.', ask.stderr)
        self.assertFalse(self.page_file().exists())
        self.assertNotIn("write", [call[0] for call in self.calls()])
        # A zone that is no label with a fixed offset is refused.
        for zone in ("EST", "America/New_York", "EST (UTC-5)", "EST (UTC-25:00)", "(UTC+00:00)"):
            with self.subTest(zone=zone):
                self.assertEqual(2, self.page("init", "--project", "demo", "--zone", zone).returncode)
        # The short word UTC is the zone of the kit when the user gives none.
        self.assertIn("zone: UTC (UTC+00:00) (from the argument)", self.init("first", "UTC").stdout)
        self.assertIn("timezone: UTC (UTC+00:00)", self.page_file("projects/first/DUMMIES").read_text())
        # Another page of the knowledge base gives its zone: one read-only call finds it.
        self.init("other", "IST (UTC+05:30)")
        self.page_file("projects/first/DUMMIES").unlink()
        taken = self.page("init", "--project", "demo")
        self.assertEqual("created: projects/demo/DUMMIES | zone: IST (UTC+05:30) (from projects/other/DUMMIES) | "
                         "handoffs: none\n", taken.stdout)
        # The same with a knowledge base that answers with paths only.
        self.page_file().unlink()
        plain = self.page("init", "--project", "demo", FAKE_OK_MODE="exec-plain")
        self.assertIn("zone: IST (UTC+05:30) (from projects/other/DUMMIES)", plain.stdout)

    def test_init_adds_one_pointer_line_to_the_handoffs_page(self):
        handoffs = self.page_file("projects/demo/handoffs")
        handoffs.parent.mkdir(parents=True)
        handoffs.write_text("---\ntype: Handoffs\n---\n# Handoffs\n\n- First line.\n", encoding="utf-8")
        result = self.init()
        self.assertTrue(result.stdout.endswith("| handoffs: pointer added\n"), result.stdout)
        lines = handoffs.read_text(encoding="utf-8").splitlines()
        self.assertEqual("- 2026-01-05T20:07Z: The human session log of this project is [DUMMIES](./DUMMIES.md). "
                         "Read its newest entry first. The dummies skill adds one entry at the end of the work of a "
                         "session.", lines[-1])
        self.assertEqual("- First line.", lines[-2])
        self.assertIn("Earlier project context is in [handoffs](./handoffs.md).", self.page_file().read_text())
        appends = [call for call in self.calls() if call[0] == "write" and "--append" in call]
        self.assertEqual(1, len(appends))
        self.assertEqual("projects/demo/handoffs", appends[0][1])
        # A page that names the log already gets no second line.
        self.page_file().unlink()
        self.assertTrue(self.init().stdout.endswith("| handoffs: the pointer is there already\n"))
        self.assertEqual(1, handoffs.read_text(encoding="utf-8").count("DUMMIES.md"))

    # --- heading ---

    def test_heading_has_the_time_of_the_zone_the_agent_and_the_model(self):
        self.init()
        result = self.page("heading", "--project", "demo", "--summary", "Fork updated", "--model", "example/model")
        self.assertEqual(["### Jan 5, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | Fork updated",
                          "Recorded: 2026-01-05T15:07:30-05:00 | Session: session-a", "model source: argument"],
                         result.stdout.splitlines())
        self.assertEqual([["read", "projects/demo/DUMMIES"]], self.calls()[-1:])
        # Midnight and noon in the zone of the page, and a day that changes with the zone.
        for now, expected in (("2026-03-01T05:00:00+00:00", "### Mar 1, 2026, 12:00 AM EST |"),
                              ("2026-03-01T17:05:00+00:00", "### Mar 1, 2026, 12:05 PM EST |"),
                              ("2026-01-01T03:59:59+00:00", "### Dec 31, 2025, 10:59 PM EST |"),
                              ("2026-07-04T13:09:00+02:00", "### Jul 4, 2026, 6:09 AM EST |")):
            with self.subTest(now=now):
                self.assertTrue(self.page("heading", "--project", "demo", DUMMIES_NOW=now).stdout.startswith(expected))
        # With no page the zone comes from the argument, and with none the command stops.
        self.assertEqual(6, self.page("heading", "--project", "absent").returncode)
        self.assertTrue(self.page("heading", "--project", "absent", "--zone", "UTC").stdout.startswith(
            "### Jan 5, 2026, 8:07 PM UTC | Agent: Claude Code | Model: unknown | <summary>\n"))

    def test_model_comes_from_the_session_data_and_is_never_a_guess(self):
        self.init()
        heading = lambda **extra: self.page("heading", "--project", "demo", "--summary", "S", **extra).stdout.splitlines()  # noqa: E731
        # Claude Code: the session file of the session identifier. A side chain and a synthetic line do not count.
        projects = self.home / ".claude/projects/-work-demo"
        projects.mkdir(parents=True)
        rows = [{"type": "user", "message": {"role": "user", "content": "x"}},
                {"type": "assistant", "message": {"role": "assistant", "model": "claude-example-1"}},
                {"type": "assistant", "isSidechain": True, "message": {"role": "assistant", "model": "claude-side-9"}},
                {"type": "assistant", "message": {"role": "assistant", "model": "<synthetic>"}},
                {"type": "assistant", "message": {"role": "assistant", "model": "claude-example-1"}},
                {"type": "assistant", "message": {"role": "assistant", "model": "claude-example-2"}}]
        (projects / "session-a.jsonl").write_text("not json\n" + "\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")
        lines = heading()
        self.assertIn("| Agent: Claude Code | Model: claude-example-1, claude-example-2 | S", lines[0])
        self.assertEqual(["Recorded: 2026-01-05T15:07:30-05:00 | Session: session-a", "model source: session file"], lines[1:])
        # The session data wins over the argument.
        self.assertIn("| Model: claude-example-1, claude-example-2 |",
                      self.page("heading", "--project", "demo", "--model", "guess").stdout)
        # Pi: the session file of the harness, then the selected model of the harness. An alias stays an alias.
        session = self.work / "pi-session.jsonl"
        session.write_text("\n".join(map(json.dumps, [
            {"type": "session", "id": "pi-session-7"},
            {"type": "message", "message": {"role": "assistant", "provider": "router", "model": "router/alias"}}])) + "\n")
        pi = {"AI_AGENT": "pi", "PI_CODING_AGENT": "true", "PI_SESSION_ID": "pi-session-7", "PI_MODEL": "other/selected"}
        lines = heading(PI_SESSION_FILE=str(session), **pi)
        self.assertIn("| Agent: Pi | Model: router/alias | S", lines[0])
        self.assertEqual(["Recorded: 2026-01-05T15:07:30-05:00 | Session: pi-session-7", "model source: session file"], lines[1:])
        lines = heading(**pi)
        self.assertIn("| Agent: Pi | Model: other/selected | S", lines[0])
        self.assertEqual("model source: PI_MODEL", lines[2])
        # Herdr names the session of the pane when the harness gives none.
        record = {"agent": "pi", "name": "demo-coordinator-1", "agent_session": {"kind": "path", "value": str(session)}}
        lines = heading(harness=False, HERDR_ENV="1", HERDR_PANE_ID="w1:p1", FAKE_HERDR_AGENT=json.dumps(record))
        self.assertIn("| Agent: Pi | Model: router/alias | S", lines[0])
        self.assertIn("| Session: pi-session-7", lines[1])
        record = {"agent": "claude", "agent_session": {"kind": "id", "value": "session-a"}}
        lines = heading(harness=False, HERDR_ENV="1", HERDR_PANE_ID="w1:p1", FAKE_HERDR_AGENT=json.dumps(record))
        self.assertIn("| Agent: Claude Code | Model: claude-example-1, claude-example-2 | S", lines[0])
        # No session data and no argument: unknown.
        lines = heading(CLAUDECODE="1", CLAUDE_CODE_SESSION_ID="no-such-session")
        self.assertIn("| Agent: Claude Code | Model: unknown | S", lines[0])
        self.assertEqual("model source: not known", lines[2])
        lines = heading(CLAUDECODE="1")
        self.assertEqual("Recorded: 2026-01-05T15:07:30-05:00 | Session: unknown", lines[1])
        # No harness: the agent name comes from the argument, or the command stops.
        self.assertEqual(2, self.page("heading", "--project", "demo", harness=False).returncode)
        named = self.page("heading", "--project", "demo", "--agent", "Other | Agent", "--model", "m", harness=False)
        self.assertIn("| Agent: Other / Agent | Model: m | <summary>", named.stdout)

    # --- add ---

    def test_add_puts_each_entry_directly_below_the_entries_heading(self):
        self.init()
        first = self.add("Fork updated to v2.4.0")
        self.assertEqual("added: projects/demo/DUMMIES | Jan 5, 2026, 3:07 PM EST | Agent: Claude Code | "
                         "Model: example/model (argument) | older entries unchanged: 0\n", first.stdout)
        text = self.page_file().read_text(encoding="utf-8")
        self.assertNotIn("No entry yet.", text)
        tail = text[text.index("## Session entries"):]
        self.assertTrue(tail.startswith(
            "## Session entries\n\n### Jan 5, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | "
            "Fork updated to v2.4.0\n\nRecorded: 2026-01-05T15:07:30-05:00 | Session: session-a\n\n"
            "**Important:** VERSION 2.4.0 IS MERGED, BUT THE COMMITS ARE NOT PUSHED.\n\n**Open:** "), tail[:400])
        # The body is kept, and each label is its own paragraph. The `Done` table is a table of the page.
        self.assertIn("\n\n**Next:** Push `local-dev` after the approval of the user.\n\n**Goal:** Update the fork to the "
                      "newest upstream release and keep the local fixes.\n\n#### Done\n\n| # | Step | Resource and result |\n"
                      "| --- | --- | --- |\n| 1 | Inspect | origin is the private remote |\n", tail)
        self.assertIn("| 5 | Record | the entry of this session on the page DUMMIES |\n\n#### State at completion\n\n"
                      "| Item | Result |\n", tail)
        self.assertTrue(tail.endswith("| Checks | just test, 1,833 tests passed |\n"))
        first_entry = tail[tail.index("### "):].rstrip()
        # A second session: its entry is above the first one, and the first one is the same text.
        second = self.add("Deployed", CLAUDE_CODE_SESSION_ID="session-b", DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertTrue(second.stdout.endswith("| older entries unchanged: 1\n"), second.stdout)
        self.assertEqual(["### Jan 5, 2026, 9:30 PM EST | Agent: Claude Code | Model: example/model | Deployed",
                          "### Jan 5, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | Fork updated to v2.4.0"],
                         self.entries())
        self.assertTrue(self.page_file().read_text(encoding="utf-8").rstrip().endswith(first_entry))
        self.assertEqual(text[:text.index("## Session entries")],
                         self.page_file().read_text(encoding="utf-8")[:text.index("## Session entries")])
        self.assertEqual(0, self.page("check", "--project", "demo").returncode)
        # Each write is one targeted edit. No call replaces the page, deletes a page or asks for a credential.
        calls = self.calls()
        edits = [call for call in calls if call[:2] == ["call", "edit"]]
        self.assertEqual(2, len(edits))
        self.assertEqual({"read", "write", "call"}, {call[0] for call in calls})
        self.assertEqual({("call", "edit"), ("call", "exec")} & {tuple(call[:2]) for call in calls}, {("call", "edit")})
        self.assertFalse([call for call in calls if "--replace" in call or "--prepend" in call])
        self.assertEqual(1, len([call for call in calls if call[0] == "write"]))
        log = [json.loads(line) for line in (self.ok / "calls.log").read_text(encoding="utf-8").splitlines()]
        requests = [json.loads(item["stdin"]) for item in log if item["argv"][:2] == ["call", "edit"]]
        self.assertEqual("No entry yet.", requests[0]["document"]["find"])
        self.assertEqual("### Jan 5, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | Fork updated to v2.4.0",
                         requests[1]["document"]["find"])
        self.assertNotIn("occurrence", requests[1]["document"])
        self.assertEqual("claude/example/model demo: add DUMMIES entry", requests[1]["summary"])
        self.assertTrue(all(len(request["summary"]) <= 80 for request in requests))

    def test_a_second_entry_of_the_same_session_is_refused(self):
        self.init()
        self.assertEqual(0, self.add("First result").returncode)
        before, text = len(self.calls()), self.page_file().read_text(encoding="utf-8")
        refused = self.add("Second result", DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertEqual(5, refused.returncode, refused.stdout)
        self.assertIn("this session has an entry already (Jan 5, 2026, 3:07 PM EST). Earlier entries stay as they are.",
                      refused.stderr)
        self.assertIn("add a new entry with --again", refused.stderr)
        self.assertEqual([["read", "projects/demo/DUMMIES"]], self.calls()[before:])
        self.assertEqual(text, self.page_file().read_text(encoding="utf-8"))
        # A correction is a new entry. The earlier entry stays as it is.
        again = self.add("Correction: the push is done", "--again", DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertEqual(0, again.returncode, again.stderr)
        self.assertEqual(2, len(self.entries()))
        self.assertTrue(self.page_file().read_text(encoding="utf-8").endswith(text[text.index("\n### "):]))
        # A later task of the same session that ends: one more entry with --again.
        later = self.add("Later work", "--again", DUMMIES_NOW="2026-01-07T02:30:00+00:00")
        self.assertEqual(0, later.returncode, later.stderr)
        self.assertEqual(3, len(self.entries()))
        self.assertEqual(3, self.page_file().read_text(encoding="utf-8").count("| Session: session-a\n"))
        # The same heading two times is refused also with --again: the heading is the mark of the next edit.
        self.assertEqual(5, self.add("Later work", "--again", DUMMIES_NOW="2026-01-07T02:30:59+00:00").returncode)

    def test_add_needs_a_session_identifier(self):
        self.init()
        before, text = len(self.calls()), self.page_file().read_text(encoding="utf-8")
        unknown = {"CLAUDE_CODE_SESSION_ID": None, "CLAUDECODE": "1"}
        # Two calls with no session identifier and with different summaries: each one stops, with --again too.
        for summary in ("First result", "Second result"):
            for again in ((), ("--again",)):
                with self.subTest(summary=summary, again=again):
                    result = self.add(summary, *again, **unknown)
                    self.assertEqual(2, result.returncode, result.stdout)
                    self.assertEqual("", result.stdout)
                    self.assertIn("the session is not known: add --session <id>. Give the identifier that the harness "
                                  "has for this session. When the harness has none, make one new unique text and "
                                  "give it in each add of this session.", result.stderr)
        # The word that the script writes for no identifier is no identifier.
        self.assertEqual(2, self.add("First result", "--session", "unknown", **unknown).returncode)
        self.assertEqual([], self.calls()[before:])
        self.assertEqual(text, self.page_file().read_text(encoding="utf-8"))
        # One new unique text of the agent is the identifier: the second add with it is the second entry.
        first = self.add("First result", "--session", "run 7f3a", **unknown)
        self.assertEqual(0, first.returncode, first.stderr)
        self.assertIn("| Session: run-7f3a\n", self.page_file().read_text(encoding="utf-8"))
        second = self.add("Second result", "--session", "run 7f3a", DUMMIES_NOW="2026-01-06T02:30:00+00:00", **unknown)
        self.assertEqual(5, second.returncode, second.stdout)
        self.assertIn("this session has an entry already (Jan 5, 2026, 3:07 PM EST).", second.stderr)
        again = self.add("Second result", "--session", "run 7f3a", "--again", DUMMIES_NOW="2026-01-06T02:30:00+00:00",
                         **unknown)
        self.assertEqual(0, again.returncode, again.stderr)
        self.assertEqual(2, len(self.entries()))
        # heading writes nothing, so it still prints the word for no identifier.
        self.assertIn("| Session: unknown\n", self.page("heading", "--project", "demo", **unknown).stdout)

    def test_a_refused_body_writes_nothing(self):
        self.init()
        before, text = len(self.calls()), self.page_file().read_text(encoding="utf-8")
        named_value = "to" + "ken = " + "a1b2c3d4e5f6g7h8i9j0k1"
        cases = (
            ("", "the body is empty"),
            ("Just text.\n", "the body starts with four lines in this order and form: **Important:** text, "
                            "**Open:** text, **Next:** text, **Goal:** text"),
            (BODY.replace("**Open:** Clients must read the tool list again. The user approves the push.\n", ""),
             "four lines in this order"),
            (BODY.replace("**Important:**", "**Next:**", 1), "four lines in this order"),
            # A label of the old form is no line of a new entry, and a body in the old form is refused.
            (BODY + "\n**Effects:** None.\n", "four lines in this order"),
            (OLD_BODY, "four lines in this order"),
            (BODY.replace("VERSION 2.4.0 IS MERGED, BUT THE COMMITS ARE NOT PUSHED", "Version 2.4.0 is merged"),
             "CAPITAL LETTERS"),
            (BODY + "\n### A heading of the entry level\n", "A `###` line starts a new entry."),
            (BODY + "\n## Session entries\n", "A `###` line starts a new entry."),
            (BODY + "\n```text\nno end\n", "a fenced block of the body has no end line"),
            (BODY + "\n" + named_value + "\n", "line 23 of the body looks like a credential (named value)"),
            (BODY + "\nAuthorization: Basic " + "QWxhZGRpbjpvcGVu" + "\n", "looks like a credential (authorization header)"),
            (BODY + "\n" + "gh" + "p_" + "A1" * 18 + "\n", "looks like a credential (token form)"),
        )
        for body, message in cases:
            with self.subTest(message=message):
                result = self.add("A result", body=body)
                self.assertEqual(2, result.returncode, result.stdout)
                self.assertIn(message, result.stderr)
                self.assertNotIn("a1b2c3d4e5f6g7h8i9j0k1", result.stderr + result.stdout)
        for summary in ("", "   ", "one two three four five six seven eight nine ten eleven twelve thirteen"):
            with self.subTest(summary=summary):
                result = self.add(summary)
                self.assertEqual(2, result.returncode)
                self.assertIn("--summary is the result of the session in 1 to 12 words", result.stderr)
        self.assertEqual(2, self.add("pass" + "word: " + "Zx9" * 8).returncode)
        self.assertEqual([], self.calls()[before:])
        self.assertEqual(text, self.page_file().read_text(encoding="utf-8"))
        # A path with no digit after a word such as "secret" is no credential.
        self.assertEqual(0, self.add("A result", body=BODY + "\nSecret: scripts/host-values.deny holds the patterns.\n").returncode)
        # Text outside ASCII goes to the page and comes back as it is, in each locale.
        accents = BODY.replace("Clients must read", "Clients of the caf\u00e9 \u2192 must read")
        added = self.add("An accent", body=accents, CLAUDE_CODE_SESSION_ID="session-b", LC_ALL="POSIX",
                         DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertEqual(0, added.returncode, added.stderr)
        self.assertIn("Clients of the caf\u00e9 \u2192 must read", self.page_file().read_text(encoding="utf-8"))
        self.assertIn("caf\u00e9 \u2192", self.page("recent", "--project", "demo", LC_ALL="POSIX").stdout)

    def test_the_credential_guard_refuses_each_secret_form_and_accepts_normal_text(self):
        page = load_module(PAGE, "dummies_page_guard")
        mixed, short = "abcd1234" + "efgh5678" + "ijkl9012", "hunter" + "2"
        blob = base64.b64encode(bytes(range(3, 69))).decode()
        slashes = "wJalrXUtnFEMI" + "/K7MDENG/" + "bPxRfiCYEXAMPLEKEY"
        hex40, hex64 = "0123456789abcdef" * 2 + "01234567", "0123456789abcdef" * 4
        part = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()  # noqa: E731
        web_token = ".".join((part({"alg": "HS256", "typ": "JWT"}), part({"sub": "1234567890", "name": "A user"}),
                              part(["a signature", 1234567890])))
        # The parts give a token of three parts, and Base64 text of 88 characters with a character outside letters and digits.
        self.assertTrue(web_token.startswith("eyJ") and 2 == web_token.count(".") and 88 == len(blob) and "+" in blob,
                        (web_token, blob))
        refused = (
            # The forms of the review. A name with an underscore before the key word:
            ("named value", f"DB_{PASSWORD.upper()}=" + short * 3 + "xx"),
            ("named value", f"GITHUB_{TOKEN.upper()}=" + mixed),
            ("named value", f"aws_{SECRET}_access_{KEY} = " + slashes),
            ("named value", f"DEMO_MASTER_{KEY.upper()}=" + "sk-" + "1234abcd"),
            # a quoted name before the colon:
            ("named value", '{"' + TOKEN + '": "' + mixed[:20] + '"}'),
            # a URL with a user and a password, and a JSON Web Token:
            ("URL with a password", "postgres://user:" + "Sup3rS3cretPw" + "@host/app"),
            ("JSON Web Token", web_token),
            ("JSON Web Token", "The answer was " + web_token + "."),
            # a short value after a clear password name:
            ("named value", f"{PASSWORD}: " + short),
            # an export line:
            ("named value", 'export BW_SESSION="' + blob + '"'),
            # More forms of the same rules. A name in two words is a setting: also 40 hex characters are a value.
            ("named value", f"GITEA_{TOKEN.upper()}=" + hex40),
            ("named value", f"export {TOKEN.upper()}=" + mixed[:12]),
            ("named value", f'"access{TOKEN.capitalize()}": "' + mixed + '"'),
            ("named value", f"x-api-{KEY}: " + mixed),
            ("named value", f"OPENAI_API_{KEY.upper()}_2=" + mixed),
            ("named value", f"The API {KEY}: " + mixed[:12]),
            ("named value", f"--{PASSWORD}=" + short),
            ("named value", f"**{SECRET.capitalize()}:** " + mixed),
            ("named value", f"{PASSWORD}: " + hex40),
            ("named value", f"{SECRET}: " + slashes),
            ("URL with a password", "https://x-access:" + mixed + "@example.com/owner/repository.git"),
        )
        accepted = (
            # The normal text of the review. A commit identifier of 40 or 64 hex characters:
            f"{TOKEN}: {hex40}",
            f"{SECRET}: {hex64}",
            f"{TOKEN} = {hex40.upper()}",
            f"The commit {hex40} holds the fix.",
            # a path with `/`:
            f"{SECRET.capitalize()}: docs/guides/provider2.md describes it",
            f"{SECRET} = vault/kv/demo-project/provider2 holds it",
            f"{PASSWORD}: /run/secrets/db2 holds it",
            f"{TOKEN}: packages/demo/src/Tracker2Client.ts reads it",
            # a name of an environment variable with no value:
            f"{TOKEN}: GITEA_{TOKEN.upper()}_FOR_THE_2ND_RUNNER",
            f"API_{KEY.upper()}=$DEMO_API_{KEY.upper()}2",
            # a sentence that uses the word:
            f"The {TOKEN} of the tracker is in the vault of the host.",
            f"{SECRET.capitalize()}: the place is the vault, and this page holds no value.",
            f"{PASSWORD.capitalize()}: the user types it at the prompt of step 2.",
            f"{PASSWORD}: <the {PASSWORD} of the user>",
            f"DB_{PASSWORD.upper()}=$DB_{PASSWORD.upper()}_2 and {PASSWORD}: <{PASSWORD}-of-db2>",
            f"{PASSWORD}: stored in the vault of the host",
            '"api_' + KEY + '": "REDACTED-BY-THE-AGENT"',
            # Text that is near the forms of the guard.
            f"Output {TOKEN}s: 17 778 of 9 500 000",
            f"MAX_{TOKEN.upper()}S=4096 and {TOKEN}_count = 1554",
            f"{TOKEN}izer: o200k_base",
            '"' + KEY + '": "package:packages/demo:skills/one2"',
            f"{KEY}-value: abc12345 and {KEY}_id = demo2project",
            f"The API {KEY}: it is in the vault of host2, and the map {KEY}: abcd1234efgh5678 is no credential.",
            f"Wire each color to a {TOKEN}: `var(--chart-1..5)` for a chart.",
            f"{TOKEN} = make_{TOKEN}(16) and {SECRET}: os.environ[name2value]",
            "export GIT_COMMIT=" + hex40,
            'export PATH="$HOME/bin:$PATH"',
            "export NODE_OPTIONS=--max-old-space-size=4096",
            "export PI_CODING_AGENT_DIR=/home/user/.pi/profiles/demo2",
            "Recorded: 2026-01-05T15:07:30-05:00 | Session: 0a1b2c3d-1111-2222-3333-444455556666",
            "The page is at https://example.com:8443/path/page2 and the clone is ssh://git@example.com:22/owner/demo.git",
            "postgres://user:<" + PASSWORD + ">@host/app is the form of the address",
            "A JSON Web Token starts with eyJ and has three parts.",
        )
        for kind, line in refused:
            with self.subTest(refused=line[:24]):
                self.assertEqual((1, kind), page.credential(line))
                self.assertEqual((2, kind), page.credential("A first line.\n" + line))
        for line in accepted:
            with self.subTest(accepted=line[:48]):
                self.assertIsNone(page.credential(line))
        # The same through the command. A refusal names the line and the kind, and never the value.
        self.init()
        before, text = len(self.calls()), self.page_file().read_text(encoding="utf-8")
        for kind, line in refused[:10]:
            with self.subTest(command=line[:24]):
                result = self.add("A result", body=BODY + "\n" + line + "\n")
                self.assertEqual(2, result.returncode, result.stdout)
                self.assertEqual(f"page.py: refused: line 23 of the body looks like a credential ({kind}). "
                                 "No credential in a page.\n", result.stderr)
                self.assertEqual("", result.stdout)
        self.assertEqual([], self.calls()[before:])
        self.assertEqual(text, self.page_file().read_text(encoding="utf-8"))
        # Normal text goes to the page, and check finds no credential in it.
        added = self.add("A result", body=BODY + "\n" + "\n\n".join(accepted) + "\n")
        self.assertEqual(0, added.returncode, added.stderr)
        self.assertIn(f"{TOKEN}: {hex40}\n", self.page_file().read_text(encoding="utf-8"))
        self.assertEqual("check: valid | projects/demo/DUMMIES | entries: 1 | zone: EST (UTC-05:00)\n",
                         self.page("check", "--project", "demo").stdout)

    def test_a_write_that_is_not_proven_is_exit_9(self):
        self.init()
        self.assertEqual(0, self.add("First result").returncode)
        lost = self.add("Second result", CLAUDE_CODE_SESSION_ID="session-b", FAKE_OK_MODE="edit-lost")
        self.assertEqual(9, lost.returncode, lost.stdout)
        self.assertIn("the write to projects/demo/DUMMIES is not proven: the new entry is on the page 0 times.", lost.stderr)
        self.assertEqual("", lost.stdout)
        damaged = self.add("Third result", CLAUDE_CODE_SESSION_ID="session-c", FAKE_OK_MODE="edit-damages",
                           DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertEqual(9, damaged.returncode, damaged.stdout)
        self.assertIn("an older entry changed (Jan 5, 2026, 3:07 PM EST)", damaged.stderr)
        self.assertIn("Read the page and its history.", damaged.stderr)
        # The new entry is on the page one time and each older entry is unchanged, but the new entry is below.
        below = self.add("Fourth result", CLAUDE_CODE_SESSION_ID="session-d", FAKE_OK_MODE="edit-below",
                         DUMMIES_NOW="2026-01-07T02:30:00+00:00")
        self.assertEqual(9, below.returncode, below.stdout)
        self.assertEqual("page.py: the write to projects/demo/DUMMIES is not proven: the new entry is not above the "
                         "older entries. Read the page and its history.\n", below.stderr)
        self.assertEqual("", below.stdout)
        self.assertTrue(self.entries()[-1].endswith("| Fourth result"))

    def test_an_entry_of_another_writer_at_the_same_time_is_named(self):
        self.init()
        self.assertEqual(0, self.add("First result").returncode)
        result = self.add("Second result", CLAUDE_CODE_SESSION_ID="session-b", FAKE_OK_MODE="edit-other-writer",
                          DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(result.stdout.endswith("| older entries unchanged: 1 | new entries of other writers: 1\n"), result.stdout)
        self.assertEqual(3, len(self.entries()))
        # The entry of the other writer is above the new entry. It has an older time, so check names the order.
        self.assertTrue(self.entries()[0].endswith("| Entry of another writer"))
        self.assertTrue(self.entries()[1].endswith("| Second result"))
        check = self.page("check", "--project", "demo")
        self.assertEqual(8, check.returncode, check.stdout)
        self.assertEqual("finding: newest_first: entry 2: the entry is newer than the entry above it\n", check.stdout)
        # A later add still works on that page.
        third = self.add("Third result", CLAUDE_CODE_SESSION_ID="session-c", DUMMIES_NOW="2026-01-07T02:30:00+00:00")
        self.assertEqual(0, third.returncode, third.stderr)
        self.assertTrue(third.stdout.endswith("| older entries unchanged: 3\n"), third.stdout)

    @slow
    def test_add_makes_the_page_when_it_is_absent(self):
        ask = self.add("First result")
        self.assertEqual(7, ask.returncode)
        self.assertFalse(self.page_file().exists())
        self.init("other", "IST (UTC+05:30)")
        made = self.add("First result")
        self.assertEqual(["created: projects/demo/DUMMIES | zone: IST (UTC+05:30) (from projects/other/DUMMIES) | "
                          "handoffs: none",
                          "added: projects/demo/DUMMIES | Jan 6, 2026, 1:37 AM IST | Agent: Claude Code | "
                          "Model: example/model (argument) | older entries unchanged: 0"], made.stdout.splitlines())
        self.assertEqual(0, self.page("check", "--project", "demo").returncode)
        # The zone argument of add is for a new page only.
        self.assertEqual(0, self.page("add", "--project", "third", "--summary", "S", "--zone", "UTC", stdin=BODY).returncode)
        self.assertEqual(["### Jan 5, 2026, 8:07 PM UTC | Agent: Claude Code | Model: unknown | S"],
                         self.entries("projects/third/DUMMIES"))

    def test_add_works_on_a_hand_made_page(self):
        self.page_file().parent.mkdir(parents=True)
        self.page_file().write_text(HAND_MADE, encoding="utf-8")
        self.assertEqual("check: valid | projects/demo/DUMMIES | entries: 1 | zone: EST (UTC-05:00)\n",
                         self.page("check", "--project", "demo").stdout)
        result = self.add("Second session")
        self.assertEqual(0, result.returncode, result.stderr)
        # The entry of the hand-made page has the labels of the old form. The read-back proof holds for it.
        self.assertTrue(result.stdout.endswith("| older entries unchanged: 1\n"), result.stdout)
        text = self.page_file().read_text(encoding="utf-8")
        head = HAND_MADE[:HAND_MADE.index("### Jan 4")]
        self.assertTrue(text.startswith(head + "### Jan 5, 2026, 3:07 PM EST | Agent: Claude Code |"), text[:900])
        self.assertTrue(text.endswith(HAND_MADE[HAND_MADE.index("### Jan 4"):]))
        # A page with an entry in the new form above an entry in the old form is valid.
        self.assertEqual("check: valid | projects/demo/DUMMIES | entries: 2 | zone: EST (UTC-05:00)\n",
                         self.page("check", "--project", "demo").stdout)
        # The summary input of an older entry in the old form: its two lines `Relevance` and `Next`.
        lines = self.page("recent", "--project", "demo").stdout.splitlines()
        older = lines.index("### Jan 4, 2026, 10:44 PM EST | Agent: Pi | Model: router/alias | First hand-made entry")
        self.assertEqual(["**Relevance:** THE FIRST ENTRY HAS NO RECORD LINE.",
                          "**Next:** Add the next entry with the script."], lines[older + 1:])
        # With no entry and no mark line, the edit names which of the two heading texts is the heading.
        self.page_file().write_text(HAND_MADE[:HAND_MADE.index("### Jan 4")], encoding="utf-8")
        self.assertEqual(0, self.add("First session").returncode)
        log = [json.loads(line) for line in (self.ok / "calls.log").read_text(encoding="utf-8").splitlines()]
        request = [json.loads(item["stdin"]) for item in log if item["argv"][:2] == ["call", "edit"]][-1]
        self.assertEqual(("## Session entries", 2), (request["document"]["find"], request["document"]["occurrence"]))
        text = self.page_file().read_text(encoding="utf-8")
        self.assertIn("immediately below `## Session entries`, above older entries.", text)
        self.assertIn("\n## Session entries\n\n### Jan 5, 2026, 3:07 PM EST |", text)
        self.assertEqual(0, self.page("check", "--project", "demo").returncode)

    def test_a_page_that_does_not_follow_the_contract_gets_no_entry(self):
        self.page_file().parent.mkdir(parents=True)
        for text, message in ((HAND_MADE.replace("## Session entries\n\n###", "## Entries\n\n###"), "has 0 lines"),
                              (HAND_MADE + "\n## Session entries\n", "has 2 lines"),
                              (HAND_MADE.replace("timezone: EST (UTC-05:00)\n", ""), "has no valid `timezone` field")):
            with self.subTest(message=message):
                self.page_file().write_text(text, encoding="utf-8")
                result = self.add("A result")
                self.assertEqual(8, result.returncode, result.stdout)
                self.assertIn(message, result.stderr)
                self.assertEqual(text, self.page_file().read_text(encoding="utf-8"))
        self.assertNotIn(["call", "edit", "-"], self.calls())

    # --- recent and check ---

    @slow
    def test_recent_prints_only_the_summary_input(self):
        self.assertEqual(6, self.page("recent", "--project", "demo").returncode)
        self.init()
        self.assertIn("The page has no entry.", self.page("recent", "--project", "demo").stdout)
        for number, session in enumerate(("a", "b", "c", "d"), 1):
            self.assertEqual(0, self.add(f"Result {number}", CLAUDE_CODE_SESSION_ID=session,
                                         DUMMIES_NOW=f"2026-01-0{number}T20:07:30+00:00").returncode)
        result = self.page("recent", "--project", "demo")
        lines = result.stdout.splitlines()
        self.assertEqual(["page: projects/demo/DUMMIES | zone: EST (UTC-05:00) | entries: 4",
                          "The page gives the last checked state, not a live status. Check a fact that can change "
                          "before you act on it.", "",
                          "### Jan 4, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | Result 4"], lines[:4])
        # The newest entry is whole. An older entry gives its heading and three lines.
        self.assertIn("| 5 | Record | the entry of this session on the page DUMMIES |", lines)
        self.assertIn("| Checks | just test, 1,833 tests passed |", lines)
        older = lines.index("### Jan 3, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | Result 3")
        self.assertEqual(["**Important:** VERSION 2.4.0 IS MERGED, BUT THE COMMITS ARE NOT PUSHED.",
                          "**Open:** Clients must read the tool list again. The user approves the push.",
                          "**Next:** Push `local-dev` after the approval of the user.", "",
                          "### Jan 2, 2026, 3:07 PM EST | Agent: Claude Code | Model: example/model | Result 2"],
                         lines[older + 1:older + 6])
        self.assertEqual("[older entries on the page: 1]", lines[-1])
        self.assertNotIn("Result 1", result.stdout)
        self.assertNotIn("Update contract", result.stdout)
        self.assertLess(len(result.stdout), len(self.page_file().read_text(encoding="utf-8")) / 2)
        short = self.page("recent", "--project", "demo", "--entries", "1", "--lines", "5").stdout.splitlines()
        self.assertEqual(["[more lines of this entry on the page: 23]", "", "[older entries on the page: 3]"], short[-3:])
        self.assertEqual([["read", "projects/demo/DUMMIES"]], self.calls()[-1:])

    @slow
    def test_check_names_each_rule_that_a_page_breaks(self):
        self.assertEqual(6, self.page("check", "--project", "demo").returncode)
        self.page_file().parent.mkdir(parents=True)
        second = HAND_MADE + textwrap.dedent("""\

            ### Jan 3, 2026, 9:00 AM EST | Agent: Claude Code | Model: unknown | An older entry

            **Goal:** G.

            **Executed:** E.

            **Relevance:** THE OLDER ENTRY IS BELOW.

            **Effects:** F.

            **Next:** N.
            """)
        self.page_file().write_text(second, encoding="utf-8")
        self.assertEqual("check: valid | projects/demo/DUMMIES | entries: 2 | zone: EST (UTC-05:00)\n",
                         self.page("check", "--project", "demo").stdout)
        # The same page with an entry in the new form above the two entries in the old form.
        third = second.replace("## Session entries\n\n", "## Session entries\n\n" + textwrap.dedent("""\
            ### Jan 5, 2026, 9:00 AM EST | Agent: Claude Code | Model: unknown | An entry in the new form

            **Important:** THE NEW FORM IS ABOVE.

            **Open:** O.

            **Next:** NN.

            **Goal:** NG.

            #### Done

            | # | Step | Resource and result |
            | --- | --- | --- |
            | 1 | Check | the page has three entries |

            """))
        self.assertEqual(1, third.count("An entry in the new form"))
        self.page_file().write_text(third, encoding="utf-8")
        self.assertEqual("check: valid | projects/demo/DUMMIES | entries: 3 | zone: EST (UTC-05:00)\n",
                         self.page("check", "--project", "demo").stdout)
        planted = (
            ("frontmatter", second[second.index("# Example"):]),
            ("type", second.replace("type: Session Log\n", "")),
            ("title", second.replace("title: Example human session log\n", "")),
            ("description", second.replace("description: Newest-first session outcomes.\n", "")),
            ("order_field", second.replace("order: newest-first", "order: oldest-first")),
            ("timezone", second.replace("timezone: EST (UTC-05:00)", "timezone: Eastern")),
            ("contract_section", second.replace("## Update contract for agents", "## Rules")),
            ("entries_heading", second.replace("## Session entries\n\n###", "## Session entries\n\n## Session entries\n\n###")),
            ("heading_form", second.replace("### Jan 4, 2026, 10:44 PM EST | Agent: Pi |", "### 2026-01-04 22:44 | Pi |")),
            ("heading_form", second.replace("| Model: router/alias | First", "| First")),
            ("heading_form", second.replace("### Jan 4, 2026,", "### Feb 30, 2026,")),
            ("heading_zone", second.replace("10:44 PM EST |", "10:44 PM UTC |")),
            ("newest_first", second.replace("### Jan 3, 2026, 9:00 AM EST", "### Jan 5, 2026, 9:00 AM EST")),
            ("labels", second.replace("**Effects:** None.\n", "")),
            ("labels", second.replace("**Goal:** G.", "Goal: G.")),
            ("capitals", second.replace("THE OLDER ENTRY IS BELOW.", "The older entry is below.")),
            ("credential", second.replace("**Next:** N.", "**Next:** N.\n\n" + "sec" + "ret=" + "q7w8e9r0t1y2u3i4o5p6")),
            # An entry in the new form has its four labels in its order, and no label of the old form.
            ("labels", third.replace("**Open:** O.\n", "")),
            ("labels", third.replace("**Open:** O.", "**Open:** O.\n\n**Effects:** F.")),
            ("labels", third.replace("**Goal:** NG.", "**Done:** NG.")),
            ("labels", third.replace("**Important:** THE NEW FORM IS ABOVE.\n\n**Open:** O.\n\n**Next:** NN.\n\n**Goal:** NG.",
                                     "**Goal:** NG.\n\n**Important:** THE NEW FORM IS ABOVE.\n\n**Open:** O.\n\n**Next:** NN.")),
            ("capitals", third.replace("THE NEW FORM IS ABOVE.", "The new form is above.")),
        )
        for rule, text in planted:
            with self.subTest(rule=rule):
                self.page_file().write_text(text, encoding="utf-8")
                result = self.page("check", "--project", "demo")
                self.assertEqual(8, result.returncode, result.stdout)
                self.assertEqual([rule], [line.split(": ")[1] for line in result.stdout.splitlines()], result.stdout)
                if rule == "labels":
                    # The finding names the two forms that the check accepts.
                    self.assertIn(": the labels are not Important, Open, Next, Goal in this order, and not Goal, "
                                  "Executed, Relevance, Effects, Next of the old form\n", result.stdout)
                self.assertIn("check: 1 findings in projects/demo/DUMMIES", result.stderr)
                self.assertNotIn("q7w8e9r0t1y2u3i4o5p6", result.stdout + result.stderr)
        self.assertFalse([call for call in self.calls() if call[0] != "read"])

    # --- names, a local file, and the source of the scripts ---

    @slow
    def test_page_name_of_the_project(self):
        self.init()
        before = len(self.calls())
        demo = ("--project", "demo")
        # A name that starts with `-` is an option for the okknow command: the script refuses it.
        for args, message in ((("--project", "Demo"), "the project is a slug"), (("--project", "../x"), "the project is a slug"),
                              (("--project=-x",), "the project is a slug"), (("--project=--yes",), "the project is a slug"),
                              ((*demo, "--page", "projects/../x"), "the page name is not valid"),
                              ((*demo, "--page", "a b"), "the page name is not valid"),
                              ((*demo, "--page=--yes"), "the page name is not valid"),
                              ((*demo, "--page=-h"), "the page name is not valid"),
                              ((*demo, "--page=/-x/DUMMIES"), "the page name is not valid")):
            for command in (("check",), ("add", "--summary", "S")):
                with self.subTest(args=args, command=command[0]):
                    result = self.page(*command, *args, stdin=BODY)
                    self.assertEqual(2, result.returncode, result.stdout)
                    self.assertIn(message, result.stderr)
        self.assertEqual([], self.calls()[before:])
        self.assertEqual(["projects/demo/DUMMIES.md"],
                         sorted(found.relative_to(self.ok / "pages").as_posix() for found in (self.ok / "pages").rglob("*.md")))
        self.assertEqual(0, self.page("check", *demo, "--page", "/projects/demo/DUMMIES.md").returncode)
        # A `-` inside a name is a normal character.
        self.assertEqual(6, self.page("check", "--project", "demo-2", "--page", "projects/demo-2/-notes-/DUMMIES").returncode)
        # The directory of a call is not in a Git repository: its name is no project. Each command asks for the project.
        before = len(self.calls())
        for args in (("heading",), ("init", "--zone", "UTC"), ("add", "--summary", "S"), ("recent",), ("check",),
                     ("check", "--page", "projects/demo/DUMMIES"), ("recent", "--file", str(self.work / "log.md"))):
            with self.subTest(command=args):
                result = self.page(*args, stdin=BODY)
                self.assertEqual(2, result.returncode, result.stdout)
                self.assertEqual("page.py: the project is not known: the current directory is not in a Git repository, "
                                 "or the git command is absent. Add --project <slug>.\n", result.stderr)
                self.assertEqual("", result.stdout)
        self.assertEqual([], self.calls()[before:])
        self.assertFalse((self.ok / "pages/projects" / self.work.name.lower()).exists())
        if not shutil.which("git"):
            self.skipTest("no git command")
        # With no project argument, the name of the repository directory is the project, also in a worktree.
        repository = self.work / "My Repo.v2"
        repository.mkdir()
        git = lambda *args: subprocess.run(["git", *args], cwd=repository, capture_output=True, text=True, check=True,  # noqa: E731
                                           env={"PATH": os.environ["PATH"], "HOME": str(self.home),
                                                "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                                                "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"})
        git("init", "-q")
        git("commit", "-q", "--allow-empty", "-m", "first")
        git("worktree", "add", "-q", str(self.work / "tree-of-a-task"))
        for cwd in (repository, self.work / "tree-of-a-task"):
            with self.subTest(cwd=cwd.name):
                result = subprocess.run([sys.executable, str(PAGE), "check"], capture_output=True, text=True, cwd=cwd,
                                        env=self.env(CLAUDECODE="1"))
                self.assertEqual(6, result.returncode)
                self.assertIn("the page is absent: projects/my-repo-v2/DUMMIES.", result.stderr)

    def test_with_the_log_off_add_runs_no_okknow_command_and_writes_nothing(self):
        config = str(self.work / "config")
        self.assertEqual(0, self.run_script(STATE, "log", "off", XDG_CONFIG_HOME=config).returncode)
        result = self.add("First result", XDG_CONFIG_HOME=config)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual([], self.calls())
        self.assertEqual([], list((self.ok / "pages").rglob("*")))

    def test_a_local_file_that_the_user_named_needs_no_okknow(self):
        log = self.work / "notes/DUMMIES.md"
        log.parent.mkdir()
        file = ("--file", str(log), "--project", "demo")
        self.assertEqual(7, self.page("init", *file, okknow=False).returncode)
        made = self.page("init", *file, "--zone", "UTC", okknow=False)
        self.assertEqual(0, made.returncode, made.stderr)
        self.assertIn("| zone: UTC (UTC+00:00) (from the argument) | handoffs: none", made.stdout)
        added = self.page("add", *file, "--summary", "First result", stdin=BODY, okknow=False)
        self.assertEqual(0, added.returncode, added.stderr)
        self.assertEqual(5, self.page("add", *file, "--summary", "Second", stdin=BODY, okknow=False).returncode)
        second = self.page("add", *file, "--summary", "Second", stdin=BODY, okknow=False, CLAUDE_CODE_SESSION_ID="session-b",
                           DUMMIES_NOW="2026-01-06T02:30:00+00:00")
        self.assertTrue(second.stdout.endswith("| older entries unchanged: 1\n"), second.stdout + second.stderr)
        text = log.read_text(encoding="utf-8")
        self.assertLess(text.index("| Second"), text.index("| First result"))
        self.assertIn("check: valid |", self.page("check", *file, okknow=False).stdout)
        self.assertIn("| entries: 2", self.page("recent", *file, okknow=False).stdout)
        self.assertEqual([], self.calls())
        self.assertEqual([log], sorted(self.work.rglob("*.md")))

    def test_scripts_use_the_standard_library_and_no_path_around_okknow(self):
        allowed = set(sys.stdlib_module_names) | {"dummies_lib"}
        for script in sorted((SKILL / "scripts").glob("*.py")):
            source = script.read_text(encoding="utf-8")
            with self.subTest(script=script.name):
                modules = set()
                for node in ast.walk(ast.parse(source)):
                    if isinstance(node, ast.Import):
                        modules.update(alias.name.split(".")[0] for alias in node.names)
                    elif isinstance(node, ast.ImportFrom):
                        modules.add((node.module or "").split(".")[0])
                self.assertLessEqual(modules, allowed)
                # No network module, no credential variable, no data directory and no loopback port.
                self.assertFalse(modules & {"urllib", "http", "socket", "ssl", "requests"})
                for word in ("OPENKNOWLEDGE_", "auth-header", "docker", "127.0.0.1", "localhost", "4317"):
                    self.assertNotIn(word, source)
        self.assertEqual({"dummies_lib.py", "page.py", "state.py"}, {path.name for path in (SKILL / "scripts").glob("*.py")})

    def test_usage_text_names_the_clock_variable_of_the_tests(self):
        usage = PAGE.read_text(encoding="utf-8").split('"""')[1]
        self.assertIn("The variable DUMMIES_NOW (an ISO time) replaces the clock. It is for tests only:\n"
                      "when it is set, each heading has that time and not the time of the write.", usage)
        shown = self.page("--help")
        self.assertEqual(0, shown.returncode, shown.stderr)
        self.assertIn("The variable DUMMIES_NOW (an ISO time) replaces the clock. It is for tests only.",
                      " ".join(shown.stdout.split()))
        # Without the variable the heading has the time of the clock.
        self.init()
        clock = self.page("heading", "--project", "demo", DUMMIES_NOW="")
        self.assertEqual(0, clock.returncode, clock.stderr)
        self.assertNotIn("Jan 5, 2026, 3:07 PM EST", clock.stdout)

    def test_heading_and_capitals_rules_of_the_module(self):
        page = load_module(PAGE, "dummies_page")
        self.assertTrue(page.HEADING.fullmatch("### Oct 9, 2026, 10:44 PM EST | Agent: Pi | Model: router/alias | A summary, with a comma"))
        for heading in ("### Oct 9, 2026, 10:44 PM EST | Agent: Pi | A summary", "## Oct 9, 2026, 10:44 PM EST | Agent: Pi | Model: m | S",
                        "### October 9, 2026, 10:44 PM EST | Agent: Pi | Model: m | S", "### Oct 9, 2026, 22:44 EST | Agent: Pi | Model: m | S"):
            self.assertIsNone(page.HEADING.fullmatch(heading), heading)
        for text, expected in (("THE DEPLOY FAILED.", True), ("8 OF THE 10 ARE HIGH", True), ("Use HTTP GET here.", False),
                               ("The API and the MCP server", False), ("v2 IS LIVE NOW", True), ("ONE", False)):
            self.assertEqual(expected, page.capitals(text), text)
        self.assertEqual(("IST", "IST (UTC+05:30)"), (page.parse_zone("IST (UTC+05:30)")[0], page.parse_zone("IST (UTC+05:30)")[2]))
        self.assertEqual("UTC (UTC+00:00)", page.parse_zone("utc")[2])
        self.assertIsNone(page.parse_zone("EST"))


if __name__ == "__main__":
    unittest.main()
