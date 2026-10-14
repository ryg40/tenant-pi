"""Offline contract checks of the dummies skill text: each rule of the user must be in the text.

`contract_findings` reads the four text files of a skill directory and returns the name of each
rule that is absent. The shipped skill has no finding. A second test makes one broken copy for
each part of each rule in a temporary directory and expects exactly that finding.
The report and the outcome block use three bordered tables: summary, completed work and likely next steps.
`grid_rows` reads that grid from an example.
Two more tests read the sections of the component README about the skill: the facts that a
reader needs, and the arithmetic of the token estimate.
These checks do not prove that an agent obeys the text.
"""
import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "packages/tenantext/skills/coordinator-skills/dummies"
README = SKILL.parent / "README.md"
# Chat order differs from the stored page format, which remains backward compatible.
LABELS = ["Goal", "Open", "Next", "Important"]
PAGE_LABELS = ["Important", "Open", "Next", "Goal"]
TABLE_HEADINGS = ["What was done:", "What's next:"]
OLD_LABELS = ["Goal", "Executed", "Relevance", "Effects", "Next"]
FRAME = "┌┬┐├┼┤└┴┘─│"
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
    """Summary rows without borders; tolerate geometry faults for independent contract findings."""
    summary = text.split("\n\n")[1] if "\n\n" in text else ""
    found = []
    for line in summary.splitlines():
        cells = line.split("│")
        if len(cells) != 4:
            continue
        label, detail = (cell.strip() for cell in cells[1:-1])
        if label == "Field":
            continue
        if label:
            found.append((label, [detail]))
        elif found:
            found[-1][1].append(detail)
    return found


def labels_of(text):
    return [label for label, _ in items(text)]


def table_headings(text):
    return [group.partition("\n")[0] for group in text.split("\n\n")[2:]]


def label_text(text, label):
    return " ".join(line for name, lines in items(text) if name == label for line in lines)


def table_rows(text):
    """Read a closed box table with centered headers, padded cells and separated logical rows."""
    lines = text.splitlines()
    if len(lines) < 5 or not re.fullmatch(r"┌─+(?:┬─+)+┐", lines[0]):
        return None
    widths = [len(cell) for cell in lines[0][1:-1].split("┬")]
    if min(widths) < 3:
        return None

    def border(left, middle, right):
        return left + middle.join("─" * width for width in widths) + right

    separator, bottom = border("├", "┼", "┤"), border("└", "┴", "┘")
    if lines[2] != separator or lines[-1] != bottom:
        return None

    def cells(line, header=False):
        if not line.startswith("│") or not line.endswith("│"):
            return None
        raw = line[1:-1].split("│")
        if len(raw) != len(widths):
            return None
        for cell, width in zip(raw, widths):
            if len(cell) != width or not cell.startswith(" ") or not cell.endswith(" "):
                return None
            value = cell.strip()
            if header:
                if not value or abs(len(cell) - len(cell.lstrip()) - (len(cell) - len(cell.rstrip()))) > 1:
                    return None
            elif cell != " " + value.ljust(width - 2) + " ":
                return None
        return [cell.strip() for cell in raw]

    headers = cells(lines[1], header=True)
    if headers is None:
        return None
    rows, current = [], []
    for index, line in enumerate(lines[3:], 3):
        if line in (separator, bottom):
            if not current or (line == bottom and index != len(lines) - 1):
                return None
            rows.append(current)
            current = []
        else:
            row = cells(line)
            if row is None:
                return None
            current.append(row)
    return (headers, rows) if not current else None


def grid_rows(text, row_lines, label_lines):
    """Count completed actions when all three tables obey the shared geometry rules."""
    groups = text.split("\n\n")
    if len(groups) != 4 or "\n" in groups[0] or not groups[0].strip():
        return None
    tables = [groups[1], *(group.partition("\n")[2] for group in groups[2:])]
    summary, done, upcoming = (table_rows(table) for table in tables)
    if summary is None or done is None or upcoming is None:
        return None
    if (summary[0] != ["Field", "Detail"] or done[0] != ["#", "Action", "Resource and result"]
            or upcoming[0] != ["#", "Owner", "Next step"]):
        return None
    table_lines = [line for table in tables for line in table.splitlines()]
    if len({len(line) for line in table_lines}) != 1 or max(map(len, text.splitlines())) > 78:
        return None
    # Only the frame is Unicode; reject controls because character count must equal cell width.
    if any(not (" " <= char <= "~" or char == "\n" or char in FRAME) for char in text):
        return None
    for row in summary[1]:
        if len(row) > label_lines or not all(row[0]) or any(left or not right for left, right in row[1:]):
            return None
    for table in (done, upcoming):
        for number, row in enumerate(table[1], 1):
            first = row[0]
            if len(row) > row_lines or first[0] != str(number) or not first[1] or not first[2]:
                return None
            if table is done and not re.fullmatch(r"[A-Za-z]{1,9}", first[1]):
                return None
            if any(number or action or not detail for number, action, detail in row[1:]):
                return None
    return len(done[1])


def future_rows(text):
    groups = text.split("\n\n")
    parsed = table_rows(groups[3].partition("\n")[2]) if len(groups) == 4 else None
    return parsed[1] if parsed else None


def content_lines(text):
    """Content without labels, headers, borders or step numbers; step verbs still count."""
    title = re.sub(r"^(?:REPORT [0-9]+|OUTCOME) +", "", text.splitlines()[0])
    yield title
    for _, lines in items(text):
        yield from lines
    for group in text.split("\n\n")[2:]:
        for line in group.splitlines():
            cells = line.split("│")
            if len(cells) == 5 and cells[1].strip() != "#":
                yield " ".join(cell.strip() for cell in cells[2:-1]).strip()


def words(text):
    return sum(len(line.split()) for line in content_lines(text))


def contract_findings(directory):
    """The sorted names of the rules of the user that the text of a skill directory does not hold."""
    skill, rules, log, template = ((Path(directory) / name).read_text(encoding="utf-8") for name in FILES)
    report, block = block_below(rules, "## 3. The report"), block_below(log, "## The outcome block")
    sections = re.findall(r"(?m)^## (.+)$", rules)
    found = set()

    def need(rule, *conditions):
        if not all(conditions):
            found.add(rule)

    # Chat labels and section headings are distinct from the stable stored page labels.
    need("chat_labels",
         report.startswith("REPORT "),
         labels_of(report) == LABELS,
         labels_of(block) == LABELS,
         table_headings(report) == TABLE_HEADINGS,
         table_headings(block) == TABLE_HEADINGS,
         "Summary order: `Goal`, `Open`, `Next`, `Important`." in rules,
         "`Important`: the most important item for a human reader." in rules,
         "`Open`: what is not done or not proven, and who must act, or `None.`" in rules,
         "`Next`: the immediate next action, matching the first row of `What's next`." in rules,
         "`Goal`: what you tried to do or to learn." in rules,
         "`What was done`: one numbered row for each completed action." in rules,
         "Use past tense in `Action`, up to 9 letters, then the resource and its verified result." in rules,
         "Keep attempted work and failed checks explicit; never present planned work as completed." in rules,
         "Teach a junior developer: short full sentences in Simplified English" in rules,
         re.findall(r"(?m)^\*\*(\w+):\*\* <", log) == PAGE_LABELS,
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
    need("stored_mapping",
         "The stored label order remains `Important`, `Open`, `Next`, `Goal`." in log,
         "Map `What was done` to `#### Done`; summarize `What's next` in `**Next:**`." in log)
    # Both harnesses share the summary, completed actions and likely next steps.
    rows = grid_rows(block, 2, 3)
    need("grid",
         "In Claude Code and Pi, use three box-drawing tables in one fenced block with no language tag:" in rules,
         "Keep the headers, borders and row separators shown." in rules,
         "Center headers; left-align cell text with one space of padding." in rules,
         "Wrap inside cells; leave the label, number, action and owner empty on continuation lines." in rules,
         "All three tables have the same width: target 70 columns, maximum 78, or less to fit the pane." in rules,
         "Narrow the detail columns first." in rules,
         "Preserve full resource names; split a long path across lines without adding characters." in rules,
         "Narrow panes may use more lines, not more words." in rules,
         "One empty line separates the title and the tables. Keep `What was done:` above the second table and `What's next:` above the third." in rules,
         grid_rows(report, 2, 2) is not None,
         "Use the three box-drawing tables of `REPORT.md` in Claude Code and Pi" in log,
         "Follow the report's padding, continuation and width rules." in log,
         "Narrow panes may use more lines, not more words." in log,
         "Box-drawing borders belong only in the chat output; keep the Markdown labels and tables shown in the entry template." in log,
         rows is not None)
    need("future_steps",
         "`What's next`: 1 to 3 likely next steps in order, with an owner and any condition or approval needed." in rules,
         "These are proposals, not authorization." in rules,
         "When none remain, use one row: `1`, `None`, `No further steps.`" in rules,
         "`What's next` follows the report's owner, condition and no-further-steps rules." in log,
         "Keep likely future work separate from completed actions." in log,
         all(future_rows(text) is None or 1 <= len(future_rows(text)) <= 3 for text in (report, block)))
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


def example_geometry_mutations():
    for name, heading in (("REPORT.md", "## 3. The report"), ("LOG.md", "## The outcome block")):
        example = block_below((SKILL / name).read_text(encoding="utf-8"), heading)
        for old, new in (("┌", "+"), ("┼", "┬"), ("┘", "┐"),
                         ("│   Field   │", "│ Field     │"), ("│ Open      │", "│ Open     │"),
                         ("│ 1 │", "│ 2 │"), ("│ 2 │", "│   │"), ("│ 2 │", "│ 2│ "),
                         ("│ # │", "│ N │"), ("│   Action  │", "│   Steps   │"),
                         ("Resource and result", "Resource or result "),
                         ("│ Open      │ ", "│ Open      │  ")):
            assert old in example, (name, old)
            yield "grid", name, example, example.replace(old, new, 1)
        lines = example.splitlines()
        at = next(index for index, line in enumerate(lines) if line.startswith("├"))
        for changed in (lines[:at] + lines[at + 1:], lines[:-1], lines[:at] + [lines[at]] + lines[at:],
                        lines[:at + 3] + [lines[at]] + lines[at + 3:]):
            yield "grid", name, example, "\n".join(changed)
        resource = "config.yaml" if name == "LOG.md" else "with credsync"
        yield "grid", name, example, example.replace(resource, resource[:-1] + "\u754c")


def future_count_mutations():
    example = block_below((SKILL / "LOG.md").read_text(encoding="utf-8"), "## The outcome block")
    last_row = "\n".join(example.splitlines()[-3:-1])
    assert last_row.startswith("├") and "│ 3 │" in last_row
    extra = last_row.replace("│ 3 │", "│ 4 │")
    yield "future_steps", "LOG.md", example, example.replace(last_row, last_row + "\n" + extra)


def outcome_count_mutations():
    example = block_below((SKILL / "LOG.md").read_text(encoding="utf-8"), "## The outcome block")
    groups = example.split("\n\n")
    lines = groups[2].splitlines()
    last_row = "\n".join(lines[-4:-1])
    assert last_row.startswith("├") and "│ 5 │" in last_row
    yield "outcome_block", "LOG.md", example, "\n\n".join(
        [*groups[:2], "\n".join(lines[:-4] + lines[-1:]), groups[3]])
    extra = last_row.replace("│ 5 │", "│ 6 │")
    yield "outcome_block", "LOG.md", example, example.replace(last_row, last_row + "\n" + extra)


# One broken copy for each part of a rule: (rule, file, text of the shipped skill, text of the broken copy).
BROKEN = (
    ("chat_labels", "REPORT.md", "`Important`: the most important item for a human reader.", "`Important`: optional."),
    ("chat_labels", "REPORT.md", "and who must act, or `None.`", "when you like."),
    ("chat_labels", "REPORT.md", "`Next`: the immediate next action, matching the first row of `What's next`.", "`Next`: optional."),
    ("chat_labels", "REPORT.md", "`Goal`: what you tried to do or to learn.", "`Goal`: optional."),
    ("chat_labels", "REPORT.md", "`What was done`: one numbered row for each completed action.", "`Done`: what you did"),
    ("chat_labels", "REPORT.md", "Teach a junior developer: short full sentences", "Write short notes"),
    ("chat_labels", "LOG.md", "**Open:** <what is not done", "**Effects:** <what is not done"),
    ("chat_labels", "LOG.md", "**Goal:** <the goal of the session>\n", ""),
    ("chat_labels", "LOG.md", "| # | Step | Resource and result |", "| Step |"),
    ("chat_labels", "page-template.md", "the labels Important, Open, Next and Goal,", "five labels,"),
    ("capitals", "REPORT.md", "Exactly one item of the report is in CAPITAL LETTERS", "Mark one item of the report"),
    ("capitals", "REPORT.md", "is in CAPITAL LETTERS: the `Important` text.", "is in CAPITAL LETTERS."),
    ("capitals", "LOG.md", "One item of the block is in CAPITAL LETTERS", "Mark one item of the block"),
    ("capitals", "page-template.md", "is in CAPITAL LETTERS", "is in bold letters"),
    ("capitals", "page-template.md", "the Important text, the most important item", "the most important item"),
    ("capitals", "LOG.md", "<ONE ITEM IN CAPITAL LETTERS>", "<what the result means>"),
    ('chat_labels', 'REPORT.md', 'REPORT 2  Key stored', 'RESULT 2  Key stored'),
    ('chat_labels', 'REPORT.md', '│ Open      │', '│ Effects   │'),
    ('chat_labels', 'REPORT.md', '│ Goal      │', '│ Aim       │'),
    ('chat_labels', 'REPORT.md', '\nWhat was done:\n', '\nCompleted:\n'),
    ('chat_labels', 'LOG.md', '│ Next      │', '│ Then      │'),
    ('capitals', 'REPORT.md', 'THE SERVICE NOW HAS 8 SLOTS.', 'the service now has 8 slots.'),
    ('capitals', 'REPORT.md', 'CLIENTS WAIT UNTIL THE CACHE COPY ENDS.', 'clients wait until the cache copy ends.'),
    ('capitals', 'REPORT.md', 'Pi needs a new shell to read the key.', 'PI NEEDS A NEW SHELL TO READ THE KEY.'),
    ('capitals', 'LOG.md', 'THE PLAN IS READY; LIVE CHANGES STILL NEED APPROVAL.', 'the plan is ready; live changes still need approval.'),
    ('capitals', 'LOG.md', 'The owner must approve the plan.', 'THE OWNER MUST APPROVE THE PLAN.'),
    ('grid', 'REPORT.md', 'In Claude Code and Pi, use three box-drawing tables in one fenced block with no language tag:', ''),
    ('grid', 'REPORT.md', 'Keep the headers, borders and row separators shown.', ''),
    ('grid', 'REPORT.md', 'Center headers; left-align cell text with one space of padding.', ''),
    ('grid', 'REPORT.md', 'Wrap inside cells; leave the label, number, action and owner empty on continuation lines.', ''),
    ('grid', 'REPORT.md', 'All three tables have the same width: target 70 columns, maximum 78, or less to fit the pane.', ''),
    ('grid', 'REPORT.md', 'Narrow the detail columns first.', ''),
    ('grid', 'REPORT.md', 'Preserve full resource names; split a long path across lines without adding characters.', ''),
    ('grid', 'REPORT.md', 'Narrow panes may use more lines, not more words.', ''),
    ("grid", "REPORT.md", "One empty line separates the title and the tables. Keep `What was done:` above the second table and `What's next:` above the third.", ""),
    ('grid', 'LOG.md', 'Use the three box-drawing tables of `REPORT.md` in Claude Code and Pi', ''),
    ('grid', 'LOG.md', "Follow the report's padding, continuation and width rules.", ''),
    ('grid', 'LOG.md', 'Narrow panes may use more lines, not more words.', ''),
    ('grid', 'LOG.md', 'Box-drawing borders belong only in the chat output; keep the Markdown labels and tables shown in the entry template.', ''),
    ("chat_labels", "REPORT.md", "Summary order: `Goal`, `Open`, `Next`, `Important`.", ""),
    ("chat_labels", "REPORT.md", "Use past tense in `Action`, up to 9 letters, then the resource and its verified result.", ""),
    ("chat_labels", "REPORT.md", "Keep attempted work and failed checks explicit; never present planned work as completed.", ""),
    ("chat_labels", "LOG.md", "\nWhat's next:\n", "\nFuture:\n"),
    ("future_steps", "REPORT.md", "`What's next`: 1 to 3 likely next steps in order, with an owner and any condition or approval needed.", ""),
    ("future_steps", "REPORT.md", "These are proposals, not authorization.", ""),
    ("future_steps", "REPORT.md", "When none remain, use one row: `1`, `None`, `No further steps.`", ""),
    ("future_steps", "LOG.md", "`What's next` follows the report's owner, condition and no-further-steps rules.", ""),
    ("future_steps", "LOG.md", "Keep likely future work separate from completed actions.", ""),
    ("stored_mapping", "LOG.md", "The stored label order remains `Important`, `Open`, `Next`, `Goal`.", ""),
    ("stored_mapping", "LOG.md", "Map `What was done` to `#### Done`; summarize `What's next` in `**Next:**`.", ""),
    *future_count_mutations(),
    *outcome_count_mutations(),
    *example_geometry_mutations(),
    ("outcome_block", "REPORT.md", "ends its work with an outcome block, and", "and"),
    ("outcome_block", "REPORT.md", "Then end your last message with the outcome block of `LOG.md`; it replaces the "
     "report of that turn.", "Then end your last message with the last report."),
    ("outcome_block", "LOG.md", "end your last message with one outcome block. It replaces the report",
     "add one outcome block. It stands below the report"),
    ("outcome_block", "LOG.md", "Compress them to exactly five rows.", "List the steps."),
    ("outcome_block", "LOG.md", "OUTCOME  The plan is settled.", "RESULT   The plan is settled."),
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
RULES = ("capitals", "coordinator_only", "end_of_work", "entry_heading", "chat_labels", "grid", "grouping",
         "log_summary", "newest_first", "no_credential", "old_entries", "on_off", "outcome_block", "script_results",
         "future_steps", "stored_mapping")


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
        self.assertIn("Limits: 12 content words per line, 2 lines per label or row, 100 words excluding labels, "
                      "headers, borders and step numbers. `What was done` has 4 rows or less.", rules)
        self.assertIn("- An action row has 2 lines or less.", log)
        self.assertIn("- Limits: 12 content words per line, 3 lines per summary label, 180 words excluding "
                      "labels, headers, borders and step numbers.", log)
        report, block = block_below(rules, "## 3. The report"), block_below(log, "## The outcome block")
        self.assertLessEqual(len(report.split("\n")[0].split()) - 2, 8)
        self.assertEqual(12, page.SUMMARY_WORDS)
        self.assertLessEqual(len(block.split("\n")[0].split()) - 1, page.SUMMARY_WORDS)
        for text, label_lines, rows, limit in ((report, 2, (1, 2, 3, 4), 100), (block, 3, (5,), 180)):
            with self.subTest(block=text.splitlines()[0]):
                self.assertIn(grid_rows(text, 2, label_lines), rows)
                self.assertLessEqual(max(len(line.split()) for line in content_lines(text)), 12)
                self.assertLessEqual(words(text), limit)
                self.assertLessEqual(max(map(len, text.splitlines())), 70)
                self.assertFalse(re.search(r"(?m)[ \t]$", text))
                self.assertFalse(re.search(r"[*`]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])", text))

    def test_grid_rows_reads_borders_and_wrapped_cells(self):
        report = block_below((SKILL / "REPORT.md").read_text(), "## 3. The report")
        outcome = block_below((SKILL / "LOG.md").read_text(), "## The outcome block")
        self.assertEqual(3, grid_rows(report, 2, 2))
        self.assertEqual(5, grid_rows(outcome, 2, 3))
        self.assertIsNone(grid_rows(report, 2, 1))
        self.assertIsNone(grid_rows(outcome, 1, 3))
        self.assertEqual(LABELS, labels_of(report))
        self.assertEqual("THE SERVICE NOW HAS 8 SLOTS. CLIENTS WAIT UNTIL THE CACHE COPY ENDS.",
                         label_text(report, "Important"))
        self.assertEqual(71, words(report))
        self.assertEqual(105, words(outcome))
        # A continuation carries no repeated label, step or number.
        for old, new in (("│           │ CLIENTS", "│ Important │ CLIENTS"),
                         ("│   │           │ Two routes", "│ 1 │           │ Two routes"),
                         ("│   │           │ Two routes", "│   │ Read      │ Two routes")):
            source = report if "CLIENTS" in old else outcome
            self.assertIsNone(grid_rows(source.replace(old, new), 2, 3))

    def test_grid_accepts_narrow_tables_and_rejects_overflow(self):
        def fixture(width):
            def table(headers, widths, rows):
                def border(left, middle, right):
                    return left + middle.join("─" * (size + 2) for size in widths) + right

                def row(values, header=False):
                    return "│" + "│".join(" " + (value.center(size) if header else value.ljust(size)) + " "
                                          for value, size in zip(values, widths)) + "│"

                lines = [border("┌", "┬", "┐"), row(headers, True), border("├", "┼", "┤")]
                for index, values in enumerate(rows):
                    lines.append(row(values))
                    lines.append(border("└", "┴", "┘") if index == len(rows) - 1 else border("├", "┼", "┤"))
                return "\n".join(lines)

            summary = table(["Field", "Detail"], [9, width - 16],
                            [["Goal", "Check the change."], ["Open", "None."],
                             ["Next", "Read the result."], ["Important", "ALL CHECKS PASS."]])
            steps = table(["#", "Action", "Resource and result"], [1, 9, width - 20],
                          [["1", "Ran", "The offline tests"]])
            upcoming = table(["#", "Owner", "Next step"], [1, 7, width - 18],
                             [["1", "User", "Read the result."]])
            return ("REPORT 1  Checks pass\n\n" + summary + "\n\nWhat was done:\n" + steps
                    + "\n\nWhat's next:\n" + upcoming)

        for width in (48, 60, 70, 78):
            with self.subTest(width=width):
                self.assertEqual(1, grid_rows(fixture(width), 2, 2))
        self.assertIsNone(grid_rows(fixture(79), 2, 2))
        self.assertIsNone(grid_rows(fixture(70).replace("│ Open      │", "│\tOpen     │"), 2, 2))
        self.assertIsNone(grid_rows(fixture(70).replace("│ Open      │", "│ Open       │"), 2, 2))
        self.assertIsNone(grid_rows(fixture(70).replace("─", "─ ", 1), 2, 2))

    def test_future_table_is_required_numbered_and_separate(self):
        for name, heading in (("REPORT.md", "## 3. The report"), ("LOG.md", "## The outcome block")):
            example = block_below((SKILL / name).read_text(encoding="utf-8"), heading)
            groups = example.split("\n\n")
            with self.subTest(name=name):
                self.assertEqual(TABLE_HEADINGS, table_headings(example))
                self.assertEqual(LABELS, labels_of(example))
                self.assertIn(len(future_rows(example)), (1, 2, 3))
                self.assertIsNone(grid_rows("\n\n".join(groups[:3]), 2, 3))
                completed = table_rows(groups[2].partition("\n")[2])[1]
                self.assertTrue(all(row[0][1] == "Read" or row[0][1].endswith("ed") for row in completed))
                self.assertEqual([str(number) for number in range(1, len(future_rows(example)) + 1)],
                                 [row[0][0] for row in future_rows(example)])
                for old, new in (("│ 1 │", "│ 2 │"), ("│ Agent   │", "│         │"),
                                 ("│ Owner   │", "│         │"), ("Next step", "Next task"), ("┼", "┬")):
                    if old in groups[3]:
                        changed = "\n\n".join([*groups[:3], groups[3].replace(old, new, 1)])
                        self.assertIsNone(grid_rows(changed, 2, 3), (name, old))

    def test_no_future_steps_keeps_an_explicit_third_table(self):
        example = block_below((SKILL / "REPORT.md").read_text(encoding="utf-8"), "## 3. The report")
        groups = example.split("\n\n")
        lines = groups[3].splitlines()
        self.assertEqual("What's next:", lines[0])
        no_steps = "│ 1 │ None    │ " + "No further steps.".ljust(52) + " │"
        groups[3] = "\n".join([*lines[:4], no_steps, lines[-1]])
        changed = "\n\n".join(groups)
        self.assertEqual(3, grid_rows(changed, 2, 2))
        self.assertEqual([[["1", "None", "No further steps."]]], future_rows(changed))

    def test_summary_order_is_separate_from_storage_order(self):
        example = block_below((SKILL / "LOG.md").read_text(encoding="utf-8"), "## The outcome block")
        groups = example.split("\n\n")
        lines = groups[1].splitlines()
        # Swap Goal and Important without changing the grid or either cell's padding.
        lines[3], lines[9] = lines[9], lines[3]
        groups[1] = "\n".join(lines)
        changed = "\n\n".join(groups)
        self.assertEqual(5, grid_rows(changed, 2, 3))
        self.assertNotEqual(LABELS, labels_of(changed))
        self.assertEqual(tuple(PAGE_LABELS), page.LABELS)

    def test_both_harnesses_install_the_same_table_instructions(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            roots = [home / ".claude", home / ".pi/agent"]
            for root in roots:
                root.mkdir(parents=True)
            environment = {**os.environ, "COORDINATOR_SKILLS_HOME": str(home)}
            for _ in range(2):
                result = subprocess.run(["bash", str(SKILL.parent / "install.sh")],
                                        env=environment, capture_output=True, text=True, timeout=10)
                self.assertEqual(0, result.returncode, result.stderr)
                for root in roots:
                    installed = root / "skills/dummies"
                    self.assertTrue(installed.is_symlink())
                    self.assertEqual(SKILL.resolve(), installed.resolve())
                    for name in ("REPORT.md", "LOG.md"):
                        self.assertEqual((SKILL / name).read_bytes(), (installed / name).read_bytes())

    def test_readout_documentation_matches_the_chat_only_change(self):
        readme = README.read_text(encoding="utf-8")
        self.assertIn("Claude Code and Pi use the same bordered tables", readme)
        self.assertIn("`#`, `Action` and `Resource and result` columns", readme)
        self.assertIn("`Goal`, `Open`, `Next`, `Important`", readme)
        self.assertIn("`What's next`, has `#`, `Owner` and `Next step` columns", readme)
        self.assertIn("The OpenKnowledge log keeps its Markdown labels and tables.", readme)
        self.assertIn("Not verified: model compliance and live terminal rendering in either harness.", readme)

    def test_page_script_has_the_labels_of_the_two_forms(self):
        # Stored entries keep their original label order and Done table.
        self.assertEqual(tuple(PAGE_LABELS), page.LABELS)
        self.assertEqual(tuple(OLD_LABELS), page.OLD_LABELS)
        for label in (*PAGE_LABELS, *OLD_LABELS):
            self.assertTrue(page.LABEL_LINE.match(f"**{label}:** text"), label)
        self.assertFalse(page.LABEL_LINE.match("**Done:** text"))

    def test_skill_text_is_small_and_names_only_files_that_exist(self):
        skill, rules = ((SKILL / name).read_text(encoding="utf-8") for name in ("SKILL.md", "REPORT.md"))
        # Each later request of a session reads the report file again: a size limit keeps that cost known.
        # The token section of the component README gives the cost for these sizes.
        self.assertLess(len(rules), 6500)
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
