"""Text invariants of the shipped coordinator skills and of the tracker document.

The check reads each `.md` file recursively in component and KIT_SKILLS directories,
excluding tests/ and node_modules/. It also reads the component README and plugin command.
It is offline: it reads files only. Scripts and JSON retain their protocol identifiers.
A second test plants one violation of each class in a fixture and expects each finding.
The forbidden tracker commands come from one rule line of the tracker document, not from this file.
"""
import re
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPONENT = ROOT / "packages/tenantext/skills/coordinator-skills"
TRACKER = ROOT / "docs/agents/issue-tracker.md"
# Kit skills outside the component that a skill text can load.
KIT_SKILLS = ("herdr", "herdr-relay", "slopscore-pr", "tracker-site")
# The completion marker is a protocol identifier, not prose. Only this exact line in
# the Herdr result contract is exempt from the wording rule, in the kit and plugin.
PROTOCOL_LINES = {("herdr", "roles/contract.md"): {"Marker: SUBAGENT_COMPLETE"}}
# Skills that only the user starts. No other text refers to one as a skill to load.
USER_ONLY_SKILLS = ("grill-me", "to-spec", "to-tickets", "wayfinder", "retro")

# A sentence that forbids the word is a finding too: a shipped text says "a Herdr pane".
SUBAGENT = re.compile(r"sub[-\s]?agent|background agent", re.IGNORECASE)
# The harness clause "the Skill tool in Claude Code" of the approved form has no such verb before it.
SKILL_TOOL = re.compile(r"\b(?:call(?:s|ing)?|invok(?:e|es|ing)|us(?:e|es|ing))\s+the\s+Skill\s+tool\b",
                        re.IGNORECASE)
DASH = re.compile("[–—]")
EMOJI = re.compile("[\U0001F300-\U0001FAFF\U0001F000-\U0001F2FF☀-➿⬀-⯿⌀-⏿"
                   "℀-⅏©®‍⃣️]")
# The one rule line of the tracker document that lists the forbidden commands, each in backticks.
CLI_SECTION = "## Where issues live"
CLI_RULE = re.compile(r"- No (`.+`) command applies to this repository\.")
# A label token runs to its word boundary: `ready-for-agent-x` is one token, and `wayfinder:` starts
# a token whatever precedes it. A colon is in the token only before a further part.
LABEL_TAIL = r"(?:[\w<>-]|:(?=[\w<]))*"
LABEL = re.compile(r"wayfinder:(?=[\w<])" + LABEL_TAIL + r"|(?<![\w:-])size:(?:<\w+>|\w+)" + LABEL_TAIL
                   + r"|(?:ready-for-agent|needs-approval)" + LABEL_TAIL)
PARENT_LABEL = re.compile(r"wayfinder:parent:(?:<map>|\d+)")
# The one form of a cross-skill reference. The case of the first letter is free, the rest is exact.
SKILL_REF = re.compile(r"\bload\s+the\s+(\S+)\s+skill\b", re.IGNORECASE)
SKILL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*|<name>")
SKILL_REF_CLAUSE = ": the Skill tool in Claude Code, a read of its SKILL.md in Pi."
USER_ONLY_REF = re.compile(r"\bthe\s+`?(" + "|".join(USER_ONLY_SKILLS) + r")`?\s+skill\b", re.IGNORECASE)
# Rules for the text of a skill that also apply to the tracker document. The rule `tracker_cli`
# applies to a skill text only: the tracker document names the forbidden commands in its own rule.
TEXT_RULES = (("subagent_wording", SUBAGENT), ("skill_tool_call", SKILL_TOOL), ("dash", DASH),
              ("emoji", EMOJI))


def label_base(token):
    """The base form of a label: `wayfinder:parent:<map>` and `wayfinder:parent:81` are `wayfinder:parent`."""
    return "wayfinder:parent" if PARENT_LABEL.fullmatch(token) else token


def tracker_labels(text):
    """The base forms of the labels in the first column of the table under `## Labels`."""
    labels, inside = set(), False
    for line in text.splitlines():
        if line.startswith("## "):
            inside = line.strip() == "## Labels"
        elif inside and line.startswith("|"):
            cell = line.split("|")[1]
            labels.update(label_base(match.group(0)) for match in LABEL.finditer(cell))
    return labels


def tracker_commands(text):
    """The forbidden commands: the backticked commands of the one rule line under `## Where issues live`."""
    commands, inside = set(), False
    for line in text.splitlines():
        if line.startswith("## "):
            inside = line.strip() == CLI_SECTION
        elif inside:
            match = CLI_RULE.fullmatch(line.strip())
            if match:
                commands.update(" ".join(command.split()) for command in re.findall(r"`([^`]+)`", match.group(1)))
    return commands


def command_pattern(commands):
    """A pattern that finds each command as whole words, or None for no command."""
    if not commands:
        return None
    return re.compile("|".join(r"\b" + r"\s+".join(map(re.escape, command.split())) + r"\b"
                               for command in sorted(commands)))


def line_findings(line, labels, shipped, owner, cli=None):
    """The rules that one line of a skill text or of a component document breaks.

    `owner` is the name of the skill directory of the file, or None for a component document.
    `cli` is the pattern of the forbidden tracker commands.
    """
    rules = {rule for rule, pattern in TEXT_RULES if pattern.search(line)}
    if cli and cli.search(line):
        rules.add("tracker_cli")
    if any(label_base(match.group(0)) not in labels for match in LABEL.finditer(line)):
        rules.add("label_unknown")
    for match in SKILL_REF.finditer(line):
        token = match.group(1)
        name = token.strip("`")
        exact = "oad the " + token + " skill" + SKILL_REF_CLAUSE
        if not SKILL_NAME.fullmatch(token) or not line.startswith(exact, match.start() + 1):
            rules.add("skill_reference_form")
        if name.lower() not in USER_ONLY_SKILLS and name != "<name>" and name not in shipped:
            rules.add("skill_reference")
    if any(match.group(1).lower() != owner for match in USER_ONLY_REF.finditer(line)):
        rules.add("skill_user_only")
    return rules


def skill_markdown(directory):
    """Read all skill Markdown except test fixtures and installed dependencies."""
    return sorted(path for path in directory.rglob("*.md")
                  if not {"tests", "node_modules"}.intersection(path.relative_to(directory).parts[:-1]))


def skill_findings(skill_dirs, tracker, documents=(), require_credits=True):
    """Findings of the skill directories, of the component documents and of the tracker document, sorted.

    Each file from skill_markdown is read, and each file in `documents`.
    Only the adapted component skills require credits; the kit skills do not.
    A finding is `(rule, file, line)`; `line` is 0 for a finding about a whole file or directory.
    """
    findings = []
    tracker = Path(tracker)
    labels, cli = set(), None
    if not tracker.is_file():
        findings.append(("tracker_missing", str(tracker), 0))
    else:
        text = tracker.read_text(encoding="utf-8")
        labels = tracker_labels(text)
        if not labels:
            findings.append(("label_table_missing", str(tracker), 0))
        cli = command_pattern(tracker_commands(text))
        if not cli:
            findings.append(("tracker_cli_list_missing", str(tracker), 0))
        for number, line in enumerate(text.splitlines(), 1):
            findings.extend((rule, str(tracker), number) for rule, pattern in TEXT_RULES if pattern.search(line))
    skill_dirs = [Path(directory) for directory in skill_dirs]
    shipped = {directory.name for directory in skill_dirs} | set(KIT_SKILLS)
    files = [(Path(document), None, set()) for document in documents]
    for directory in skill_dirs:
        if require_credits and not (directory / "CREDITS.md").is_file():
            findings.append(("credits_missing", str(directory), 0))
        if not (directory / "SKILL.md").is_file():
            findings.append(("skill_missing", str(directory), 0))
        files.extend((path, directory.name,
                      PROTOCOL_LINES.get((directory.name, path.relative_to(directory).as_posix()), set()))
                     for path in skill_markdown(directory))
    for path, owner, protocol_lines in files:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            rules = line_findings(line, labels, shipped, owner, cli)
            if line in protocol_lines:
                rules.discard("subagent_wording")
            findings.extend((rule, str(path), number) for rule in rules)
    return sorted(findings)


def shipped_skill_dirs(component=COMPONENT):
    """Each directory of the component; a directory without `SKILL.md` is a finding, not skipped."""
    return sorted(path for path in Path(component).iterdir() if path.is_dir())


TRACKER_FIXTURE = """# Tracker

## Where issues live

Rules:

- No `gh issue`, `gh pr`, `gh api`, `gh repo` or `glab` command applies to this repository.

## Labels

| Label | Kind | Meaning |
| --- | --- | --- |
| `wayfinder:map` | map | A map. |
| `wayfinder:parent:<map>` | child | A child. |
| `ready-for-agent` | triage | An agent can take it. |
| `needs-approval` | triage | The owner approves. |

## Other

| `wayfinder:outside` | not a label | This table is not the label table. |
"""
CLEAN = """---
name: good
description: A clean skill.
---

Load the other skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi.
load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Apply `wayfinder:map` and `wayfinder:parent:12`.
The issue carries `ready-for-agent` or `needs-approval`.
"""
# One planted violation of each class: (rule, line text).
PLANTED = (
    ("subagent_wording", "Start a subagent for the search."),
    ("subagent_wording", "Do not start a Sub-Agent."),
    ("subagent_wording", "A background agent reads the files."),
    ("subagent_wording", "Ask a sub agent."),
    ("skill_tool_call", 'Call the Skill tool with "good".'),
    ("skill_tool_call", "Then call  the skill tool."),
    ("skill_tool_call", "Invoke the Skill tool for it."),
    ("skill_tool_call", "You can use the Skill tool."),
    ("dash", "One thing — another thing."),
    ("dash", "Pages 1–2."),
    ("emoji", "Done \U0001F389"),
    ("emoji", "Sun ☀"),
    ("emoji", "Tile \U0001F004"),
    ("emoji", "Heart \u2764\uFE0F"),
    ("emoji", "Star \u2B50"),
    ("emoji", "Watch \u231A"),
    ("emoji", "Mark \u2122"),
    ("emoji", "Copyright \u00A9"),
    ("emoji", "Registered \u00AE"),
    ("emoji", "Joiner a\u200Db"),
    ("emoji", "Keycap 1\u20E3"),
    ("emoji", "Selector a\uFE0F"),
    ("tracker_cli", "Run `gh issue create` for the ticket."),
    ("tracker_cli", "Run `glab issue list`."),
    ("tracker_cli", "Run `gh pr create` for the branch."),
    ("tracker_cli", "Run `gh api repos/o/r/issues`."),
    ("tracker_cli", "Run `gh repo view`."),
    ("label_unknown", "Apply `wayfinder:unknown`."),
    ("label_unknown", "Apply `wayfinder:outside`."),
    ("label_unknown", "Apply `size:2`."),
    ("label_unknown", "Apply `size:<n>`."),
    ("label_unknown", "Apply `ready-for-agent-x`."),
    ("label_unknown", "Apply `needs-approval-now`."),
    ("label_unknown", "Query labels=x-wayfinder:bogus for the list."),
    ("label_unknown", "Apply `wayfinder:map:extra`."),
    ("label_unknown", "Apply `wayfinder:parent:<other>`."),
    ("skill_reference", "Load the absent skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi."),
    ("skill_reference_form", "Load the herdr skill."),
    ("skill_reference_form", "Load the herdr skill (the Skill tool in Claude Code, a read of its SKILL.md in Pi)."),
    ("skill_reference_form", "Load the `herdr` skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi."),
    ("skill_reference_form", "Load the herdr skill:  the Skill tool in Claude Code, a read of its SKILL.md in Pi."),
    ("skill_user_only", "Load the grill-me skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi."),
    ("skill_user_only", "Then run the `wayfinder` skill."),
)
# A file of a skill directory that is not `SKILL.md`, and a component document: each is read.
PLANTED_NOTES = (("dash", "A note \u2014 with a dash."), ("skill_reference_form", "Load the other skill."))
PLANTED_README = (("tracker_cli", "Run `gh pr create`."), ("skill_user_only", "Use the retro skill here."))


class SkillInvariantTests(unittest.TestCase):
    def test_shipped_skills_and_tracker_document_have_no_finding(self):
        directories = shipped_skill_dirs()
        self.assertIn(COMPONENT / "grilling", directories)
        self.assertIn(COMPONENT / "grill-me", directories)
        for name in ("wayfinder", "research", "prototype", "domain-modeling"):
            self.assertIn(COMPONENT / name, directories)
        self.assertEqual([], skill_findings(directories, TRACKER, [COMPONENT / "README.md"]))
        self.assertLessEqual({"wayfinder:map", "wayfinder:parent", "ready-for-agent", "needs-approval"},
                             tracker_labels(TRACKER.read_text(encoding="utf-8")))

    def test_tracker_skill_text_has_no_finding(self):
        directory = ROOT / "packages/tenantext/skills/tracker-site"
        self.assertTrue((directory / "SKILL.md").is_file())
        # Original kit skills have no adaptation credits requirement.
        self.assertEqual([], skill_findings([], TRACKER, sorted(directory.rglob("*.md"))))
    def test_kit_skills_and_plugin_copies_have_no_finding(self):
        skills = COMPONENT.parent
        plugin = skills.parent / "claude-code"
        directories = [skills / name for name in KIT_SKILLS]
        directories.append(plugin / "skills/herdr")
        self.assertEqual([], skill_findings(directories, TRACKER,
                                           [plugin / "commands/spawn_agent.md"], require_credits=False))

    def test_recursive_markdown_and_exact_protocol_exception(self):
        with tempfile.TemporaryDirectory() as temp:
            skill = Path(temp) / "herdr"
            (skill / "roles/nested").mkdir(parents=True)
            (skill / "SKILL.md").write_text("# Herdr\n", encoding="utf-8")
            contract = skill / "roles/contract.md"
            contract.write_text("Marker: SUBAGENT_COMPLETE\nStart a subagent.\n"
                                "Marker: SUBAGENT_COMPLETE and a subagent\n", encoding="utf-8")
            nested = skill / "roles/nested/notes.md"
            nested.write_text("Marker: SUBAGENT_COMPLETE\n", encoding="utf-8")
            expected = [("subagent_wording", str(contract), 2),
                        ("subagent_wording", str(contract), 3),
                        ("subagent_wording", str(nested), 1)]
            for excluded in ("tests", "node_modules", "roles/tests", "roles/node_modules"):
                directory = skill / excluded
                directory.mkdir(parents=True)
                (directory / "fixture.md").write_text("Start a subagent.\n", encoding="utf-8")
            (skill / "roles.json").write_text('{"session":"subagent"}', encoding="utf-8")
            self.assertEqual(sorted(expected), skill_findings([skill], TRACKER, require_credits=False))

    def test_each_planted_violation_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tracker = root / "issue-tracker.md"
            tracker.write_text(TRACKER_FIXTURE, encoding="utf-8")
            good, other, bad, empty = (root / name for name in ("good", "other", "bad", "empty"))
            for directory in (good, other, bad, empty):
                directory.mkdir()
            for directory in (good, other):
                (directory / "SKILL.md").write_text(CLEAN, encoding="utf-8")
                (directory / "CREDITS.md").write_text("# Credits\n", encoding="utf-8")
            (empty / "CREDITS.md").write_text("# Credits\n", encoding="utf-8")
            readme = root / "README.md"
            readme.write_text('A skill says: "Load the <name> skill: the Skill tool in Claude Code, a read of its '
                              'SKILL.md in Pi." The skill `wayfinder` is for the user.\n', encoding="utf-8")
            self.assertEqual([], skill_findings([good, other], tracker, [readme]))
            # `bad` has no credits note; `empty` has no skill text.
            expected = [("credits_missing", str(bad), 0), ("skill_missing", str(empty), 0)]
            for path, planted in ((bad / "SKILL.md", PLANTED), (bad / "NOTES.md", PLANTED_NOTES),
                                  (readme, PLANTED_README)):
                path.write_text("\n".join(line for _, line in planted) + "\n", encoding="utf-8")
                expected += [(rule, str(path), number) for number, (rule, _) in enumerate(planted, 1)]
            self.assertEqual(sorted(expected), skill_findings([good, other, bad, empty], tracker, [readme]))
            # A skill directory can name its own user-only skill.
            (root / "retro").mkdir()
            (root / "retro" / "CREDITS.md").write_text("The text of the retro skill is adapted.\n", encoding="utf-8")
            (root / "retro" / "SKILL.md").write_text("Write the notes.\n", encoding="utf-8")
            self.assertEqual([], skill_findings([good, other, root / "retro"], tracker))
            # The tracker document: text rules apply. A missing label table, a missing command rule and a
            # missing file are findings.
            tracker.write_text("# Tracker\n\nAsk a subagent — or not.\n", encoding="utf-8")
            self.assertEqual([("dash", str(tracker), 3), ("label_table_missing", str(tracker), 0),
                              *(("label_unknown", str(directory / "SKILL.md"), number)
                                for directory in (good, other) for number in (7, 8)),
                              ("subagent_wording", str(tracker), 3),
                              ("tracker_cli_list_missing", str(tracker), 0)],
                             skill_findings([good, other], tracker))
            self.assertIn(("tracker_missing", str(root / "absent.md"), 0), skill_findings([good], root / "absent.md"))

    def test_a_drift_of_the_command_list_changes_the_findings(self):
        """The list has one source: a command that leaves or enters the document leaves or enters the check."""
        text = TRACKER.read_text(encoding="utf-8")
        rule = next(line for line in text.splitlines() if CLI_RULE.fullmatch(line))
        commands = tracker_commands(text)
        self.assertEqual(set(re.findall(r"`([^`]+)`", rule)), commands)
        self.assertGreater(len(commands), 1)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            drifted, skill = root / "issue-tracker.md", root / "good"
            skill.mkdir()
            (skill / "CREDITS.md").write_text("# Credits\n", encoding="utf-8")
            for command in sorted(commands):
                (skill / "SKILL.md").write_text("Run `" + command + " list`.\n", encoding="utf-8")
                finding = ("tracker_cli", str(skill / "SKILL.md"), 1)
                self.assertIn(finding, skill_findings([skill], TRACKER))
                # The drift: the document loses this one command. The same skill text has no finding.
                kept = "`, `".join(sorted(commands - {command}))
                drifted.write_text(text.replace(rule, "- No `" + kept + "` command applies to this repository."),
                                   encoding="utf-8")
                self.assertEqual(commands - {command}, tracker_commands(drifted.read_text(encoding="utf-8")))
                self.assertNotIn(finding, skill_findings([skill], drifted))
            # The drift the other way: the document gains a command. The check forbids it at once.
            (skill / "SKILL.md").write_text("Run `gh release create`.\n", encoding="utf-8")
            self.assertEqual([], skill_findings([skill], TRACKER))
            drifted.write_text(text.replace(rule, rule.replace("`glab`", "`glab`, `gh release`")), encoding="utf-8")
            self.assertEqual([("tracker_cli", str(skill / "SKILL.md"), 1)], skill_findings([skill], drifted))


if __name__ == "__main__":
    unittest.main()
