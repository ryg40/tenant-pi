"""Offline contract checks of the dummies skill text: each rule of the user must be in the text.

`contract_findings` reads the four text files of a skill directory and returns the name of each
rule that is absent. The shipped skill has no finding. A second test makes one broken copy for
each part of each rule in a temporary directory and expects exactly that finding.
The report and the outcome block are one grid: a label column, a text column, and a `Done` table.
`grid_rows` reads that grid from an example.
Two more tests read the sections of the component README about the skill: the facts that a
reader needs, and the arithmetic of the token estimate.
These checks do not prove that an agent obeys the text.
"""
import importlib.util
import re
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "packages/tenantext/skills/coordinator-skills/dummies"
README = SKILL.parent / "README.md"
# The labels of the report and of the outcome block. An entry of the page has the first four, and a `Done` table.
LABELS = ["Important", "Open", "Next", "Goal", "Done"]
OLD_LABELS = ["Goal", "Executed", "Relevance", "Effects", "Next"]
# The text of a label starts in column 12, and the text of a `Done` row in column 23.
TEXT, ROW_TEXT = 11, 22
ROW = re.compile(r"([0-9]+) ([A-Za-z]{1,7}) +(?=\S)")
FILES = ("SKILL.md", "REPORT.md", "LOG.md", "page-template.md")
HEADING_FORM = "### <Mon D, YYYY, H:MM AM|PM> <zone> | Agent: <agent> | Model: <model> | <summary>"

spec = importlib.util.spec_from_file_location("dummies_page_contract", SKILL / "scripts/page.py")
page = importlib.util.module_from_spec(spec)
spec.loader.exec_module(page)


def capital_items(text):
    """The count of items in capital letters: runs of three words or more with no small letter."""
    count = run = strong = 0
    for word in text.split() + ["end"]:
        letters = [letter for letter in word if letter.isalpha()]
        if any(letter.islower() for letter in letters):
            count += run >= 3 and strong >= 2
            run = strong = 0
        else:
            run += 1
            strong += len(letters) >= 2
    return count


def blocks(text):
    """The fenced blocks of a text that have no language tag."""
    return re.findall(r"(?m)^```\n(.*?)\n```$", text, re.S)


def block_below(text, heading):
    """The first fenced block with no language tag below a heading, or an empty text."""
    found = blocks(text[text.find(heading):]) if heading in text else []
    return found[0] if found else ""


def items(text):
    """The items of a grid block: [lines of one label, count of the empty lines below it]. None for a text
    line above the first label or below an empty line."""
    found = []
    for line in text.split("\n"):
        if line[:1].strip():
            found.append([[line], 0])
        elif found and not line.strip():
            found[-1][1] += 1
        elif found and not found[-1][1]:
            found[-1][0].append(line)
        else:
            return None
    return found


def labels_of(text):
    """The first word of each line that starts in column 1, below the first line."""
    return [line.split()[0] for line in text.split("\n")[1:] if line[:1].strip()]


def label_text(text, label):
    """The text of one label of a grid block, as one line."""
    return " ".join(line[TEXT:].strip() for lines, _ in items(text) or [] if lines[0].split()[0] == label
                    for line in lines)


def grid_rows(text, row_lines, label_lines):
    """The count of the `Done` rows of a report or of an outcome block that holds the grid, else None.

    The grid: a first line and five labels in column 1, each with its text in column 12. One empty line
    stands below the first line, below the second item and below the fourth item, and nowhere else. A next
    line of an item starts below its text. The last item is the table: each row has a number from 1, a verb
    of 7 letters or less in a column of 9 characters, and its text in column 23.
    """
    found = items(text)
    if not found or [gap for _, gap in found] != [1, 1, 0, 1, 0, 0]:
        return None
    if not text.isascii() or max(map(len, text.split("\n"))) > 78:
        return None
    indent = lambda line: len(line) - len(line.lstrip())  # noqa: E731
    # `REPORT <n>` is the label of a report.
    starts = [re.match(r"(?:[A-Z]+ [0-9]+|\S+) +(?=\S)" if number == 0 else r"\S+ +(?=\S)", lines[0])
              for number, (lines, _) in enumerate(found)]
    if len(found[0][0]) != 1 or any(not start or start.end() != TEXT for start in starts):
        return None
    for lines, _ in found[1:-1]:
        if len(lines) > label_lines or any(indent(line) != TEXT for line in lines[1:]):
            return None
    numbers, used = [], 0
    for number, line in enumerate(found[-1][0]):
        row = ROW.match(line[TEXT:]) if number == 0 or indent(line) == TEXT else None
        if row and row.end() == ROW_TEXT - TEXT:
            numbers.append(int(row.group(1)))
            used = 1
        elif number and indent(line) == ROW_TEXT and used < row_lines:
            used += 1
        else:
            return None
    return len(numbers) if numbers == list(range(1, len(numbers) + 1)) else None


def words(text):
    """The count of the words of a grid block, without the labels and the step numbers."""
    found = items(text)
    return (len(text.split()) - len(found) - text.startswith("REPORT ")
            - sum(bool(ROW.match(line[TEXT:])) for line in found[-1][0]))


def contract_findings(directory):
    """The sorted names of the rules of the user that the text of a skill directory does not hold."""
    skill, rules, log, template = ((Path(directory) / name).read_text(encoding="utf-8") for name in FILES)
    report, block = block_below(rules, "## 3. The report"), block_below(log, "## The outcome block")
    sections = re.findall(r"(?m)^## (.+)$", rules)
    found = set()

    def need(rule, *conditions):
        if not all(conditions):
            found.add(rule)

    # The five labels of the user, in the order of the user, with what each one holds. The report, the
    # outcome block and the entry of the page have the same labels.
    need("five_labels",
         report.startswith("REPORT "),
         labels_of(report) == LABELS,
         labels_of(block) == LABELS,
         "`Important`: the most important item for a human reader." in rules,
         "`Open`: what is not done or not proven, and who must act, or `None.`" in rules,
         "`Next`: your next step." in rules,
         "`Goal`: what you tried to do or to learn." in rules,
         "`Done`: one numbered row for each action" in rules,
         "Teach a junior developer: short full sentences in Simplified English" in rules,
         re.findall(r"(?m)^\*\*(\w+):\*\* <", log) == LABELS[:4],
         "#### Done\n\n| # | Step | Resource and result |\n" in log,
         "An entry has the labels Important, Open, Next and Goal" in template)
    # One item in capital letters for each report, each outcome block and each entry: the `Important` text.
    need("capitals",
         "Exactly one item of the report is in CAPITAL LETTERS: the `Important` text." in rules,
         capital_items(report) == 1,
         not re.search("[a-z]", label_text(report, "Important")),
         "One item of the block is in CAPITAL LETTERS: the `Important` text." in log,
         capital_items(block) == 1,
         not re.search("[a-z]", label_text(block, "Important")),
         "One item of the four labels is in CAPITAL LETTERS: the Important text, the most important item for a "
         "human reader." in template,
         "**Important:** <ONE ITEM IN CAPITAL LETTERS>" in log)
    # One grid for the report and for the outcome block: the two columns, the groups, the `Done` table.
    rows = grid_rows(block, 2, 3)
    need("grid",
         "The text starts in column 12, and the text of a `Done` row in column 23." in rules,
         "A second line starts below the text of the first line." in rules,
         "a verb of 7 letters or less in a column of 9 characters" in rules,
         "One empty line stands after the first line, after `Important` and after `Next`." in rules,
         grid_rows(report, 1, 2) is not None,
         "The second line starts below the text of the first line, in column 23." in log,
         "One empty line stands after the first line, after `Important` and after `Next`." in log,
         rows is not None)
    # The outcome block at the end of the work: it replaces the last report, and it has five steps, the
    # outcome, the goal and real resources.
    need("outcome_block",
         "ends its work with an outcome block" in rules,
         "When the work is complete, read `LOG.md` beside this file before your last message." in rules,
         "Then end your last message with the outcome block of `LOG.md`; it replaces the report of that turn." in rules,
         "When the work is complete, end your last message with one outcome block. It replaces the report of that "
         "turn" in log,
         "Compress them to exactly five rows." in log,
         block.startswith("OUTCOME "),
         rows in (None, 5),
         "`OUTCOME` is the result at the end of the session, in 12 words or less. It is also the `--summary` text "
         "of the page entry." in log,
         "<the OUTCOME line: the result in 12 words or less>" in log,
         "`Goal` is the goal at the start of the session." in log,
         "Each row names its real resources (a repository, an endpoint, an external tool, a URL) and the most "
         "important item that you found there." in log)
    # An entry in the old form stays on the page as it is.
    need("old_entries",
         "- An older entry can have the labels of the old form: `Goal`, `Executed`, `Relevance`, `Effects` and "
         "`Next`. It stays as it is, and `check` accepts it.\n" in log,
         "An older entry can have the labels Goal, Executed, Relevance, Effects and Next: it stays as it is."
         in template)
    # Only a coordinator session uses the skill, and it knows its role with Herdr and without it.
    need("coordinator_only",
         "2. Coordinator sessions only" in sections,
         "You are a coordinator session when the user talks to you directly and no start prompt gives you a task role."
         in rules,
         "The `role:` part of the state check gives the Herdr role when the pane has one." in rules,
         "A task session (a worker, a reviewer, a researcher, a scout, or a session with a result format of its own) "
         "stops here: its role sets its result form." in rules)
    # One report for a series of turns: the three conditions of the user, and the events that end a series.
    grouping = rules[rules.find("## 4. Grouping"):rules.find("## 5. ")]
    need("grouping",
         "Give no report in this turn when all three are true:" in grouping,
         re.findall(r"(?m)^([0-9])\. ", grouping) == ["1", "2", "3"],
         "1. The turns are steps of the same process." in grouping,
         "2. The turns taught nothing new: a junior developer learns nothing from them that the last report did not say."
         in grouping,
         "3. Your approach did not leave the goal and the plan that you gave at the start." in grouping,
         "The next report then covers the series, and its `REPORT` line gives the count of the turns." in grouping,
         "Report in the same turn after a failure, a surprise, a change of the plan or of the goal, a decision or a "
         "correction of the user, a result that the user must act on, and at the end of the work." in grouping)
    # The entry heading: a simple date and time in the zone of the page, then the agent and the model.
    example = re.search(r"`(### [^`]+)`", template)
    need("entry_heading",
         f"`{HEADING_FORM}`" in log,
         example and page.HEADING.fullmatch(example.group(1)),
         "The time is the time of the write in the zone of the `timezone` field: a label and a fixed UTC offset" in template,
         "The model is the identifier of the session data. An alias stays an alias. A model that is not known is `unknown`."
         in template,
         "Never guess the model behind an alias: with no identifier the script writes `unknown`." in log,
         re.search(r"(?m)^timezone: \{zone\}$", template))
    # The log is a running log: the newest entry first, and earlier entries stay.
    need("newest_first",
         re.search(r"(?m)^order: newest-first$", template),
         "add one entry directly below the entries heading, above each older entry." in template,
         "Read the newest entry first." in template,
         "Earlier entries stay as they are." in template,
         "one entry for each session, the newest first." in log,
         "It adds the entry directly below the entries heading, reads the page back and proves that each older entry "
         "is unchanged." in log,
         "| 5 | This session has an entry | Stop. Earlier entries stay as they are. For a correction, or for later "
         "work of the same session, add a new entry with `--again`. The summary of a correction starts with "
         "`Correction:`. |" in log)
    # On and off: the state check is the first step, and the off state puts no text of the skill into a session.
    need("on_off",
         re.search(r"(?m)^disable-model-invocation: true$", skill.split("\n---\n")[0]),
         not re.search(r"(?m)^## ", skill),
         "Run the state check first. `<word>` is `on`, `off` or `status` when the user gave that word after the skill "
         "name. Else it is `status`." in skill,
         "python3 D/state.py <word>" in skill,
         "| The output starts with `dummies: off` | Stop. Use no other part of this skill." in skill,
         "| The output starts with `dummies: on` | Read `REPORT.md` beside this file and apply it" in skill,
         "Run `python3 D/state.py on --autostart` only after a yes." in skill,
         "After `off`, stop the report form in this session too." in skill,
         sections[:1] == ["1. State check"],
         "Run `python3 D/state.py` first, unless you ran it in this turn. When its output starts with `dummies: off`, "
         "stop: use no part of this file." in rules)
    # The end of the work is a moment that an agent can know. A long session has one entry for each task that ends.
    need("end_of_work",
         "The work is complete each time a task of the user is done and you give your final answer for it." in rules,
         "- The first task of a session that ends gets its entry with the command above. In a long session, each "
         "later task that ends gets a new entry: the same command with `--again`." in log)
    # The answer from the page is the log summary. The word `status` is a word of the switch only.
    need("log_summary",
         "Then give the log summary of `LOG.md` beside this file." in skill,
         re.search(r"(?m)^## Log summary$", log),
         "Give the log summary in eight lines or less: where things stand, what was done and when, and what is open."
         in log,
         "Say that the page gives the last checked state." in log,
         "Before you act on a fact that can change (a branch, a deployment, a service), check it at its source." in log,
         not re.search(r"(?i)status (?:answer|input)", skill + rules + log))
    # No credential in a page: the agent writes none, and the check of the script is a first guard only.
    need("no_credential",
         "- Write no credential. Name the place of a secret, not its value.\n" in log,
         "- The script refuses a line that has the form of a credential, but this is a first guard only: you write "
         "no credential, also in a form that the script does not find.\n" in log,
         "Write no credential into this page." in template)
    # What a result of the page script means, and what the agent does then.
    need("script_results",
         "| 0 | The line ends with `new entries of other writers: <n>` | Another session added `<n>` entries between "
         "the read and the write of the script. Read the page. Change nothing. |" in log,
         "When a line is refused as a credential and holds none, write it in other words." in log,
         "with no session identifier, `add` stops with exit 2. When your harness has no identifier, make one new "
         "unique text for this session and give it as `--session <id>` in each `add` of the session." in log,
         "Outside a Git repository, `--project <slug>` is necessary." in log)
    return sorted(found)


# One broken copy for each part of a rule: (rule, file, text of the shipped skill, text of the broken copy).
BROKEN = (
    ("five_labels", "REPORT.md", "REPORT 2   Key stored", "RESULT 2   Key stored"),
    ("five_labels", "REPORT.md", "Open       Pi must restart", "Effects    Pi must restart"),
    ("five_labels", "REPORT.md", "Goal       Store the", "Aim        Store the"),
    ("five_labels", "REPORT.md", "Done       1 Save", "Executed   1 Save"),
    ("five_labels", "REPORT.md", "`Important`: the most important item for a human reader.", "`Important`: optional."),
    ("five_labels", "REPORT.md", "and who must act, or `None.`", "when you like."),
    ("five_labels", "REPORT.md", "`Next`: your next step.", "`Next`: optional."),
    ("five_labels", "REPORT.md", "`Goal`: what you tried to do or to learn.", "`Goal`: optional."),
    ("five_labels", "REPORT.md", "`Done`: one numbered row for each action", "`Done`: what you did"),
    ("five_labels", "REPORT.md", "Teach a junior developer: short full sentences", "Write short notes"),
    ("five_labels", "LOG.md", "Next       The Strata restart", "Then       The Strata restart"),
    ("five_labels", "LOG.md", "**Open:** <what is not done", "**Effects:** <what is not done"),
    ("five_labels", "LOG.md", "**Goal:** <the goal of the session>\n", ""),
    ("five_labels", "LOG.md", "| # | Step | Resource and result |", "| Step |"),
    ("five_labels", "page-template.md", "the labels Important, Open, Next and Goal,", "five labels,"),
    ("capitals", "REPORT.md", "Exactly one item of the report is in CAPITAL LETTERS", "Mark one item of the report"),
    ("capitals", "REPORT.md", "is in CAPITAL LETTERS: the `Important` text.", "is in CAPITAL LETTERS."),
    ("capitals", "REPORT.md", "STRATA RESTARTS WITH 8 SLOTS; NO CLIENT HAS A CACHE\n           UNTIL THE COPY ENDS IN ABOUT 5 "
     "MINUTES.", "Strata restarts with 8 slots; no client has a cache\n           until the copy ends in about 5 minutes."),
    ("capitals", "REPORT.md", "Goal       Store the Strata key and start the settled plan.",
     "Goal       STORE THE STRATA KEY AND START THE SETTLED PLAN."),
    # One item in capital letters, but it is not the `Important` text.
    ("capitals", "REPORT.md", "STRATA RESTARTS WITH 8 SLOTS; NO CLIENT HAS A CACHE\n           UNTIL THE COPY ENDS IN ABOUT 5 "
     "MINUTES.\n\nOpen       Pi must restart its shell to read the new key.",
     "Strata restarts with 8 slots; no client has a cache\n           until the copy ends in about 5 minutes.\n\n"
     "Open       PI MUST RESTART ITS SHELL TO READ THE NEW KEY."),
    ("capitals", "LOG.md", "One item of the block is in CAPITAL LETTERS", "Mark one item of the block"),
    ("capitals", "LOG.md", "PI DIRECT PROVIDER, 8 SLOTS, ROUTE FLAG, LITELLM FIX WORKER,\n           PILOCAL SERVICE",
     "Pi direct provider, 8 slots, route flag, LiteLLM fix worker,\n           pilocal service"),
    ("capitals", "LOG.md", "Open       The plan waits for the owner's confirmation.",
     "Open       THE PLAN WAITS FOR THE CONFIRMATION OF THE OWNER."),
    ("capitals", "LOG.md", "PI DIRECT PROVIDER, 8 SLOTS, ROUTE FLAG, LITELLM FIX WORKER,\n           PILOCAL SERVICE\n\n"
     "Open       The plan waits for the owner's confirmation.",
     "Pi direct provider, 8 slots, route flag, LiteLLM fix worker,\n           pilocal service\n\n"
     "Open       THE PLAN WAITS FOR THE CONFIRMATION OF THE OWNER."),
    ("capitals", "page-template.md", "is in CAPITAL LETTERS", "is in bold letters"),
    ("capitals", "page-template.md", "the Important text, the most important item", "the most important item"),
    ("capitals", "LOG.md", "<ONE ITEM IN CAPITAL LETTERS>", "<what the result means>"),
    ("grid", "REPORT.md", "The text starts in column 12, and the text of a `Done` row in column 23.",
     "The text starts after the label."),
    ("grid", "REPORT.md", "A second line starts below the text of the first line.", ""),
    ("grid", "REPORT.md", "a verb of 7 letters or less in a column of 9 characters", "a verb"),
    ("grid", "REPORT.md", "One empty line stands after the first line", "No empty line stands after the first line"),
    # The groups of the report: one empty line below the first line, below `Important` and below `Next` only.
    ("grid", "REPORT.md", "workers run\n\nImportant", "workers run\nImportant"),
    ("grid", "REPORT.md", "MINUTES.\n\nOpen", "MINUTES.\nOpen"),
    ("grid", "REPORT.md", "run the checks.\n\nGoal", "run the checks.\nGoal"),
    ("grid", "REPORT.md", "run the checks.\n\nGoal", "run the checks.\n\n\nGoal"),
    ("grid", "REPORT.md", "the new key.\nNext", "the new key.\n\nNext"),
    ("grid", "REPORT.md", "settled plan.\nDone", "settled plan.\n\nDone"),
    # The two columns of the report, and its table.
    ("grid", "REPORT.md", "Open       Pi must restart", "Open      Pi must restart"),
    ("grid", "REPORT.md", "REPORT 2   Key stored", "REPORT 2  Key stored"),
    ("grid", "REPORT.md", "           UNTIL THE COPY ENDS", "          UNTIL THE COPY ENDS"),
    ("grid", "REPORT.md", "UNTIL THE COPY ENDS IN ABOUT 5 MINUTES.", "UNTIL THE COPY ENDS\n           IN ABOUT 5 MINUTES."),
    ("grid", "REPORT.md", "workers run\n", "workers run\n           in two panes\n"),
    ("grid", "REPORT.md", "2 Edit     the profile", "2 Edit    the profile"),
    ("grid", "REPORT.md", "2 Edit     the profile", "2 Edit      the profile"),
    ("grid", "REPORT.md", "3 Start    Strata", "4 Start    Strata"),
    ("grid", "REPORT.md", "1 Save     STRATA_API_KEY", "1 Preserve STRATA_API_KEY"),
    ("grid", "REPORT.md", "1 Save     STRATA_API_KEY", "Save       STRATA_API_KEY"),
    ("grid", "REPORT.md", "1 Save     STRATA_API_KEY with credsync", "1 Save     STRATA_API_KEY\n"
     "                      with credsync"),
    ("grid", "REPORT.md", "Strata, the Pi provider, two workers", "Strata, the Pi provider, two workers \u2192 done"),
    ("grid", "REPORT.md", "Strata, the Pi provider, two workers", "Strata, the Pi provider, two workers, in two panes of "
     "the workspace"),
    ("grid", "LOG.md", "The second line starts below the text of the first line, in column 23.", ""),
    ("grid", "LOG.md", "One empty line stands after the first line", "No empty line stands after the first line"),
    ("grid", "LOG.md", "with the owner\nDone", "with the owner\n\nDone"),
    ("grid", "LOG.md", "changed live.\n\nImportant", "changed live.\nImportant"),
    ("grid", "LOG.md", "                      has two Strata routes", "                     has two Strata routes"),
    ("grid", "LOG.md", "with the AskUserQuestion tool", "with the\n                      AskUserQuestion tool"),
    ("grid", "LOG.md", "the four live checks.", "the four\n           live checks."),
    ("grid", "LOG.md", "           3 Read     strata-profile", "           4 Read     strata-profile"),
    ("outcome_block", "REPORT.md", "ends its work with an outcome block, and", "and"),
    ("outcome_block", "REPORT.md", "Then end your last message with the outcome block of `LOG.md`; it replaces the "
     "report of that turn.", "Then end your last message with the last report."),
    ("outcome_block", "LOG.md", "end your last message with one outcome block. It replaces the report",
     "add one outcome block. It stands below the report"),
    ("outcome_block", "LOG.md", "Compress them to exactly five rows.", "List the steps."),
    ("outcome_block", "LOG.md", "\n           5 Record   OpenViking preference, memory file,\n"
     "                      DUMMIES page projects/strata/DUMMIES", ""),
    ("outcome_block", "LOG.md", "DUMMIES page projects/strata/DUMMIES\n", "DUMMIES page projects/strata/DUMMIES\n"
     "           6 Close    the session\n"),
    ("outcome_block", "LOG.md", "OUTCOME    The plan is settled.", "RESULT     The plan is settled."),
    ("outcome_block", "LOG.md", "It is also the `--summary` text of the page entry.", ""),
    ("outcome_block", "LOG.md", "<the OUTCOME line: the result in 12 words or less>", "<the result in 12 words or less>"),
    ("outcome_block", "LOG.md", "`Goal` is the goal at the start of the session.", ""),
    ("outcome_block", "LOG.md", "(a repository, an endpoint, an external tool, a URL)", "(when it helps)"),
    ("old_entries", "LOG.md", "It stays as it is, and `check` accepts it.", "Change it to the new form."),
    ("old_entries", "page-template.md", "Effects and Next: it stays as it is.", "Effects and Next: change it."),
    ("coordinator_only", "REPORT.md", "## 2. Coordinator sessions only", "## 2. Sessions"),
    ("coordinator_only", "REPORT.md", "stops here: its role sets its result form.", "can use the report too."),
    ("coordinator_only", "REPORT.md", "when the user talks to you directly and no start prompt gives you a task role.",
     "in each session."),
    ("coordinator_only", "REPORT.md", "gives the Herdr role when the pane has one.", "is not used."),
    ("grouping", "REPORT.md", "Give no report in this turn when all three are true:", "Group the turns when you like:"),
    ("grouping", "REPORT.md", "1. The turns are steps of the same process.\n", ""),
    ("grouping", "REPORT.md", "2. The turns taught nothing new", "2. The turns were short"),
    ("grouping", "REPORT.md", "3. Your approach did not leave the goal and the plan that you gave at the start.\n", ""),
    ("grouping", "REPORT.md", "Report in the same turn after a failure, a surprise,", "Report later after a failure,"),
    ("grouping", "REPORT.md", "its `REPORT` line gives the count of the turns.", "it is short."),
    ("entry_heading", "LOG.md", "| Agent: <agent> | Model: <model> | <summary>`", "| <summary>`"),
    ("entry_heading", "page-template.md", "`### Jan 5, 2026, 3:07 PM UTC | Agent: Pi | Model: example/model | Summary`",
     "`### 2026-01-05T15:07Z | Pi | Summary`"),
    ("entry_heading", "page-template.md", "| Agent: Pi | Model: example/model | Summary`", "| Agent: Pi | Summary`"),
    ("entry_heading", "page-template.md", "A model that is not known is `unknown`.", "Guess the model."),
    ("entry_heading", "page-template.md", "timezone: {zone}\n", ""),
    ("entry_heading", "LOG.md", "Never guess the model behind an alias", "Name the likely model behind an alias"),
    ("newest_first", "page-template.md", "order: newest-first", "order: oldest-first"),
    ("newest_first", "page-template.md", "directly below the entries heading, above each older entry.",
     "at the end of the page."),
    ("newest_first", "page-template.md", "Earlier entries stay as they are.", "Correct earlier entries in place."),
    ("newest_first", "LOG.md", "one entry for each session, the newest first.", "one entry for each session."),
    ("newest_first", "LOG.md", "and proves that each older entry is unchanged.", "one time."),
    ("on_off", "SKILL.md", "disable-model-invocation: true\n", ""),
    ("on_off", "SKILL.md", "Run the state check first. `<word>` is `on`, `off` or `status`", "`<word>` is `on` or `status`"),
    ("on_off", "SKILL.md", "Read `REPORT.md` beside this file and apply it from its section 2.", "Continue."),
    ("on_off", "REPORT.md", "## 1. State check", "## 1. Start"),
    ("on_off", "REPORT.md", "When its output starts with `dummies: off`, stop: use no part of this file.", ""),
    ("on_off", "SKILL.md", "python3 D/state.py <word>", "python3 D/state.py status"),
    ("on_off", "SKILL.md", "Stop. Use no other part of this skill.", "Continue with the report form."),
    ("on_off", "SKILL.md", "only after a yes.", "at once."),
    ("on_off", "SKILL.md", "After `off`, stop the report form in this session too.", ""),
    ("newest_first", "LOG.md", "Stop. Earlier entries stay as they are.", "Rewrite the earlier entry."),
    ("newest_first", "LOG.md", "add a new entry with `--again`. The summary of a correction",
     "change the entry. The summary of a correction"),
    ("end_of_work", "REPORT.md", "each time a task of the user is done and you give your final answer for it.",
     "when you think so."),
    ("end_of_work", "LOG.md", "each later task that ends gets a new entry: the same command with `--again`.",
     "one entry is enough."),
    ("log_summary", "SKILL.md", "give the log summary of", "give the status answer of"),
    ("log_summary", "LOG.md", "## Log summary", "## Status answer"),
    ("log_summary", "LOG.md", "Give the log summary in eight lines or less", "Answer at length"),
    ("log_summary", "LOG.md", "Say that the page gives the last checked state.", ""),
    ("log_summary", "LOG.md", "check it at its source.", "trust the page."),
    ("no_credential", "LOG.md", "- Write no credential. Name the place of a secret, not its value.\n", ""),
    ("no_credential", "LOG.md", "this is a first guard only", "this finds each credential"),
    ("no_credential", "LOG.md", "you write no credential, also in a form", "the script also refuses a form"),
    ("no_credential", "page-template.md", "Write no credential into this page.", ""),
    ("script_results", "LOG.md", "Read the page. Change nothing. |", "Remove the other entries. |"),
    ("script_results", "LOG.md", "When a line is refused as a credential and holds none, write it in other words.", ""),
    ("script_results", "LOG.md", "make one new unique text for this session", "use the word `unknown`"),
    ("script_results", "LOG.md", "Outside a Git repository, `--project <slug>` is necessary.", ""),
)
RULES = ("capitals", "coordinator_only", "end_of_work", "entry_heading", "five_labels", "grid", "grouping",
         "log_summary", "newest_first", "no_credential", "old_entries", "on_off", "outcome_block", "script_results")


class DummiesContractTests(unittest.TestCase):
    def test_shipped_skill_holds_each_rule_of_the_user(self):
        self.assertEqual([], contract_findings(SKILL))
        self.assertEqual({"SKILL.md", "REPORT.md", "LOG.md", "page-template.md", "CREDITS.md"},
                         {path.name for path in SKILL.glob("*.md")})

    def test_each_broken_copy_gives_exactly_its_finding(self):
        self.assertEqual(set(RULES), {rule for rule, *_ in BROKEN})
        with tempfile.TemporaryDirectory() as temp:
            for number, (rule, name, shipped, broken) in enumerate(BROKEN):
                with self.subTest(rule=rule, text=shipped[:40]):
                    copy = Path(temp) / str(number)
                    copy.mkdir()
                    for file in FILES:
                        shutil.copy(SKILL / file, copy / file)
                    text = (copy / name).read_text(encoding="utf-8")
                    self.assertEqual(1, text.count(shipped), "the text of the shipped skill is there one time")
                    (copy / name).write_text(text.replace(shipped, broken), encoding="utf-8")
                    self.assertEqual([rule], contract_findings(copy))

    def test_example_report_and_outcome_block_obey_their_own_limits(self):
        rules, log = ((SKILL / name).read_text(encoding="utf-8") for name in ("REPORT.md", "LOG.md"))
        self.assertIn("Limits: 12 words and 78 characters for each line, 2 lines for each label, 75 words for the "
                      "report without the labels and the step numbers. `Done` has 4 rows or less, each with 1 line.", rules)
        self.assertIn("- A `Done` row has 2 lines or less.", log)
        self.assertIn("- Limits: 12 words and 78 characters for each line, 3 lines for each label above `Done`, 140 "
                      "words for the block without the labels and the step numbers.", log)
        report, block = block_below(rules, "## 3. The report"), block_below(log, "## The outcome block")
        # The first line: the result in 8 words, and the outcome in the words of a summary.
        self.assertLessEqual(len(report.split("\n")[0].split()) - 2, 8)
        self.assertEqual(12, page.SUMMARY_WORDS)
        self.assertLessEqual(len(block.split("\n")[0].split()) - 1, page.SUMMARY_WORDS)
        for text, row_lines, label_lines, rows, limit in ((report, 1, 2, (1, 2, 3, 4), 75), (block, 2, 3, (5,), 140)):
            with self.subTest(block=text.split()[0]):
                self.assertIn(grid_rows(text, row_lines, label_lines), rows)
                self.assertLessEqual(max(len(line.split()) - bool(line[:1].strip()) for line in text.split("\n")), 12)
                self.assertLessEqual(words(text), limit)
                # Plain text: no Markdown mark, no long line, no character outside ASCII, no space at a line end.
                self.assertFalse(re.search(r"[*`]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])", text))
                self.assertLessEqual(max(map(len, text.split("\n"))), 78)
                self.assertTrue(text.isascii())
                self.assertFalse(re.search(r"(?m)[ \t]$", text))
        # The count of the words: each word that is no label and no step number.
        self.assertEqual(len(report.split()) - 7 - 3, words(report))
        self.assertEqual(len(block.split()) - 6 - 5, words(block))

    def test_grid_rows_reads_the_two_columns_and_the_table(self):
        report = ("REPORT 12  The check passes\n\nImportant  THE RELEASE IS READY.\n\nOpen       None.\n"
                  "Next       I write the result.\n\nGoal       Check the release.\nDone       1 Run      just test")
        self.assertEqual(1, grid_rows(report, 1, 2))
        self.assertEqual(4, grid_rows(report + "".join(f"\n           {number} Read     a file" for number in (2, 3, 4)), 1, 2))
        self.assertEqual(18, words(report))
        self.assertEqual("THE RELEASE IS READY.", label_text(report, "Important"))
        self.assertEqual(LABELS, labels_of(report))
        # A second line of a row is for the outcome block only, and a row has its lines below its text.
        long = report + "\n                      1,833 tests passed"
        self.assertIsNone(grid_rows(long, 1, 2))
        self.assertEqual(1, grid_rows(long, 2, 3))
        self.assertIsNone(grid_rows(long + "\n                      in 40 seconds", 2, 3))
        for broken in (report.replace("Open       None.", "Open        None."),
                       report.replace("Done       1 Run      just", "Done       1 Run     just"),
                       report.replace("Done       1 Run      just", "Done       2 Run      just"),
                       report.replace("\n\nOpen", "\nOpen"), report.replace("\nNext", "\n\nNext"),
                       report.replace("\nDone       1 Run      just test", ""),
                       report.replace("REPORT 12  The", "The"), "  " + report,
                       report.replace("READY.", "READY.\n\n           IT HAS NO OPEN FAULT."),
                       report.replace("just test", "just test \u2192 pass"), report.replace("just test", "just test " * 7)):
            with self.subTest(broken=broken[:60]):
                self.assertIsNone(grid_rows(broken, 1, 2))

    def test_page_script_has_the_labels_of_the_two_forms(self):
        # An entry of the page has the first four labels: its `Done` is a table. The old form stays readable.
        self.assertEqual(tuple(LABELS[:4]), page.LABELS)
        self.assertEqual(tuple(OLD_LABELS), page.OLD_LABELS)
        for label in (*LABELS[:4], *OLD_LABELS):
            self.assertTrue(page.LABEL_LINE.match(f"**{label}:** text"), label)
        self.assertFalse(page.LABEL_LINE.match("**Done:** text"))

    def test_skill_text_is_small_and_names_only_files_that_exist(self):
        skill, rules = ((SKILL / name).read_text(encoding="utf-8") for name in ("SKILL.md", "REPORT.md"))
        # Each later request of a session reads the report file again: a size limit keeps that cost known.
        # The token section of the component README gives the cost for these sizes.
        self.assertLess(len(rules), 3800)
        self.assertLess(len(skill), 1500)
        for name in ("LOG.md", "scripts/state.py", "scripts/page.py", "page-template.md", "CREDITS.md",
                     "agents/openai.yaml"):
            self.assertTrue((SKILL / name).is_file(), name)
        self.assertIn("read `LOG.md` beside this file before your last message", rules)
        self.assertIn("give the log summary of `LOG.md` beside this file", skill)
        log = (SKILL / "LOG.md").read_text(encoding="utf-8")
        for command in ("page.py add", "page.py init", "page.py check", "page.py recent"):
            self.assertIn("python3 D/" + command, log)
        # Each exit code of the page script that an agent can meet has its row or its sentence.
        for code in ("0", "2", "3", "4", "5", "7", "8", "9"):
            self.assertRegex(log, r"(?m)^\| %s \| " % code)
        self.assertIn("Exit 6 means that the project has no `DUMMIES` page.", log)
        self.assertIn("Write a log file only when the user names its path", log)

    def test_readme_says_what_the_scripts_need_and_what_is_not_verified(self):
        readme = " ".join(README.read_text(encoding="utf-8").split())
        for sentence in (
                # The host tool, and the forms of it that the page script calls.
                "The `okknow` command is a host tool, a command-line path to OpenKnowledge that the kit does not ship:",
                "`dummies/scripts/page.py` needs three forms of it (`okknow --json read <page>`, `okknow write <page> - "
                "--summary <text>` with and without `--append`, and `okknow call edit -`), and without it the option "
                "`--file <path>` keeps the log in a local file that the user names.",
                "A fourth form, `okknow call exec`, only looks for the zone of another `DUMMIES` page",
                # The two facts about Pi that no session showed.
                "So neither harness puts its description into the context of a session. Not verified for Pi: this "
                "comes from the program text of Pi 1.1.0, and no Pi session showed it.",
                "Not verified: that Pi loads only the first context file of its list that exists. The rule comes from "
                "the document of Pi 1.1.0, and no Pi session showed it.",
                # The switch: what off does to a file of the user, and the state file.
                "The two marker lines of the block are complete lines: a line of the user that quotes a marker is "
                "text of the user.",
                "After `on --autostart` and then `off`, the instruction file has the same bytes as before, with each "
                "line end and with the end of the file as they were.",
                "`off` removes a file only when `on` created it.",
                "`off` always sets the state to off.",
                "it names the file that needs a repair by hand and ends with exit 4.",
                "A relative `XDG_CONFIG_HOME` is not used: the file is then in `~/.config`.",
                "A state file that is a link is refused with exit 3 and is not written.",
                "for one log summary: a short answer from the log page about where things stand."):
            with self.subTest(sentence=sentence[:50]):
                self.assertIn(sentence, readme)
        self.assertNotRegex(readme, r"(?i)status (?:answer|input)")
        # The forms of the README are the calls of the script.
        source = (SKILL / "scripts/page.py").read_text(encoding="utf-8")
        for call in ('["--json", "read", page]', '["write", page, "-", "--summary", summary]',
                     '["write", page, "-", "--append", "--summary", summary]', '["call", "edit", "-"]', '["call", "exec", '):
            self.assertIn(call, source)
        self.assertEqual(5, source.count("self._run(["))

    def test_token_section_of_the_readme_follows_from_its_own_numbers(self):
        readme = README.read_text(encoding="utf-8")
        section = readme[readme.index("## Token cost of `dummies`"):readme.index("## Rules for a cross-skill call")]
        number = lambda written: float(written.replace(" ", ""))  # noqa: E731
        token_count = lambda text: (len(text) + 2) // 4  # noqa: E731
        report_text, log_text = ((SKILL / name).read_text(encoding="utf-8") for name in ("REPORT.md", "LOG.md"))
        report_tokens = token_count("```\n" + block_below(report_text, "## 3. The report") + "\n```")
        block_tokens = token_count("```\n" + block_below(log_text, "## The outcome block") + "\n```")
        written = lambda value: (f"{value:,.0f}" if value == int(value) else f"{value:,.1f}").replace(",", " ")  # noqa: E731

        def value_of(calculation):
            """The value of a sum of products, for example `6 x 106 + 150`."""
            total = 0.0
            for term in calculation.split(" + "):
                product = 1.0
                for factor in term.split(" x "):
                    product *= number(factor)
                total += product
            return round(total, 1)

        # The file and example costs follow from the text, not from copied token counts.
        self.assertIn("Divide characters by 4, rounding to the nearest whole token (a half rounds up).", section)
        self.assertIn("Include both fence lines and no final newline in the report and outcome block counts.", section)
        for name, text in (("SKILL.md", (SKILL / "SKILL.md").read_text(encoding="utf-8")),
                           ("REPORT.md", report_text), ("LOG.md", log_text)):
            self.assertIn(f"`{name}`: {written(len(text))}" + (" characters" if name == "SKILL.md" else "")
                          + f" / 4 = {written(token_count(text))}", section)
        self.assertIn(f"`REPORT.md` ({written(token_count(report_text))} tokens)", section)
        report_chars = len("```\n" + block_below(report_text, "## 3. The report") + "\n```")
        block_chars = len("```\n" + block_below(log_text, "## The outcome block") + "\n```")
        self.assertIn(f"the fenced report: {written(report_chars)} / 4 = {written(report_tokens)}", section)
        self.assertIn(f"the fenced outcome block: {written(block_chars)} / 4 = {written(block_tokens)}", section)
        report_words = words(block_below(report_text, "## 3. The report"))
        self.assertIn(f"The example report has {report_words} words and {written(report_tokens)} tokens", section)
        self.assertIn(f"the outcome block has {written(block_tokens)} tokens.", section)
        # Each row of the parts: the calculation gives the count, and the counts give the sum.
        rows = re.findall(r"(?m)^\| .+ \| ([0-9][0-9 x]*) \| ([0-9][0-9 ]*) (input|output) \|$", section)
        self.assertEqual(["input"] * 5 + ["output"] * 4, [kind for _, _, kind in rows])
        self.assertEqual(f"{token_count(report_text)} x 83", rows[0][0])
        self.assertEqual(f"9 x {report_tokens} x 42", rows[3][0])
        self.assertEqual(f"9 x {report_tokens}", rows[5][0])
        self.assertEqual(f"1 x {block_tokens}", rows[6][0])
        totals = {"input": 0, "output": 0}
        for calculation, count, kind in rows:
            self.assertEqual(number(count), value_of(calculation), calculation)
            totals[kind] += number(count)
        self.assertIn(f"| Sum | | {written(totals['input'])} input and {written(totals['output'])} output |", section)
        # The parts of the end of the work give the first number of their row.
        end = re.search(r"(?m)^\| The end of the work, .+$", section).group(0)
        self.assertIn(f"`LOG.md` ({written(token_count(log_text))}), the outcome block ({written(block_tokens)})", end)
        self.assertIn(f"| {written(sum(number(part) for part in re.findall(r'[(]([0-9 ]+)[)]', end)))} x 3 |", end)
        # Each calculation in round brackets has its result in the section.
        calculations = re.findall(r"[(]([0-9][0-9 .]* [x+] [0-9 .x+]*[0-9])[)]", section)
        self.assertLessEqual(7, len(calculations))
        for calculation in calculations:
            self.assertIn(written(value_of(calculation)), section, calculation)
        # Each percentage is its fraction, to the last digit that the text gives.
        fractions = re.findall(r"([0-9][0-9 .]*) / ([0-9][0-9 ]*) = ([0-9.]+) %", section)
        self.assertLessEqual(7, len(fractions))
        for top, bottom, percent in fractions:
            self.assertAlmostEqual(float(percent), 100 * number(top) / number(bottom), delta=0.051, msg=f"{top} / {bottom}")
        # The measures use the sums of the table, and the two ends of each range use 6 and 12 reports.
        base_input, base_output = 9_380_000, 14_778
        self.assertIn(f"| {written(totals['input'] + totals['output'])} / {written(base_input + base_output)} = ", section)
        self.assertIn(f"| {written(totals['output'])} / {written(base_output)} = ", section)
        self.assertIn(f"({written(totals['input'])} x 0.1 + {written(totals['output'])} x 5) / "
                      f"({written(base_input)} x 0.1 + {written(base_output)} x 5)", section)
        for reports in (6, 12):
            more = (reports - 9) * report_tokens
            self.assertIn(f"({written(totals['input'] + more * 42)} x 0.1 + {written(totals['output'] + more)} x 5) / ",
                          section)
            self.assertIn(f"({reports} x {report_tokens} + {block_tokens} + 330 + 120) / {written(base_output)} = "
                          f"{written(totals['output'] + more)} / {written(base_output)}", section)
            self.assertIn(f"{written(totals['input'] + more * 42 + totals['output'] + more)} / "
                          f"{written(base_input + base_output)} = ", section)
        later_output = block_tokens + 330 + 120
        self.assertIn(f"adds {written(later_output)} output tokens ({block_tokens} + 330 + 120)", section)
        self.assertIn(f"{100 * later_output / base_output:.1f} % of {written(base_output)}", section)


if __name__ == "__main__":
    unittest.main()
