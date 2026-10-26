#!/usr/bin/env python3
"""Keep the human session log of a project: the page DUMMIES.

Each read and each write of the knowledge base goes through the `okknow`
command. This script reads no credential, and it opens no data directory and
no port of the knowledge base. With `--file <path>` the log is one local file
that the user named, and `okknow` is not used.

Usage: page.py heading [options] [--summary TEXT] [--zone ZONE]
       page.py init    [options] [--zone ZONE] [--title TEXT]
       page.py add     [options] --summary TEXT [--body-file FILE] [--again] [--zone ZONE]
       page.py recent  [options] [--entries N] [--lines N]
       page.py check   [options]

    heading  print the entry heading and the record line of this session; no write
    init     create the page from the template when it does not exist, and add one
             pointer line to the `handoffs` page of the project when that page exists
    add      add one entry directly below the entries heading. The body comes from
             standard input or from --body-file. The script makes the heading, reads
             the page back and proves that each older entry is unchanged
    recent   print the summary input: the newest entry, and the label lines of each
             older one that say what is important, what is open and what is next
    check    check the page against the contract

Options: --project SLUG    the page is projects/SLUG/DUMMIES. Default: the name of the
                           directory of the repository. Outside a Git repository the
                           option is necessary
         --page NAME       another page name
         --file PATH       a local file in place of the knowledge base
         --harness pi|claude, --agent TEXT, --model TEXT, --session ID, --session-file PATH
                           the session data, when the script cannot read it. `add`
                           needs a session identifier
A zone is a label and a fixed UTC offset, for example "UTC (UTC+00:00)".
The variable DUMMIES_NOW (an ISO time) replaces the clock. It is for tests only:
when it is set, each heading has that time and not the time of the write.

With the log off (`state.py log off`), `add` writes nothing, runs no okknow
command, prints `log: off, no entry` and exits 0.

Exit codes: 0 done; 1 a fault of the script; 2 wrong arguments or a refused
input; 3 the okknow command failed; 4 the okknow command is not on the path;
5 the session has an entry already; 6 the page is absent; 7 a new page needs a
zone from the user; 8 the page does not follow the contract; 9 the write is not
proven.
Python 3.11 standard library only.
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys

# A run of the script leaves no cache directory in the skill directory.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dummies_lib import HARNESSES, Stop, detect_harness, herdr_agent, home, log_state, short, write_text  # noqa: E402

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(SKILL_DIR, "page-template.md")
ENTRIES_HEADING = "## Session entries"
PLACEHOLDER = "No entry yet."
LABELS = ("Important", "Open", "Next", "Goal")
# The labels of an entry in the old form. `check` and `recent` read such an entry; `add` writes the new form only.
OLD_LABELS = ("Goal", "Executed", "Relevance", "Effects", "Next")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
AGENTS = {"claude": "Claude Code", "pi": "Pi"}
SUMMARY_WORDS = 12
ZONE = re.compile(r"(?P<label>[A-Za-z][A-Za-z0-9_/+-]{0,31}) \(UTC(?P<sign>[+-])(?P<hours>[0-9]{2}):(?P<minutes>[0-9]{2})\)")
HEADING = re.compile(
    r"### (?P<month>%s) (?P<day>[0-9]{1,2}), (?P<year>[0-9]{4}), (?P<hour>[0-9]{1,2}):(?P<minute>[0-9]{2}) "
    r"(?P<half>AM|PM) (?P<zone>\S+) \| Agent: (?P<agent>[^|]+?) \| Model: (?P<model>[^|]+?) \| (?P<summary>\S.*)"
    % "|".join(MONTHS))
RECORD = re.compile(r"Recorded: (?P<time>\S+) \| Session: (?P<session>\S+)")
LABEL_LINE = re.compile(r"\*\*(%s):\*\*[ \t]+\S" % "|".join(dict.fromkeys(LABELS + OLD_LABELS)))

# --- the first guard against a credential ----------------------------------------
# The guard finds forms, not meanings. It is a first guard only: the agent writes no credential.
# The parts keep a pattern of this file out of a scan for the same pattern.
_PASSWORD_WORDS = frozenset(("pass" + "word", "passwd", "passphrase"))
_KEY_WORDS = frozenset(("secret", "tok" + "en", "bear" + "er", "apikey"))
# A name, then `:` or `=`, then the first word of the value. The name can be in quotes, and after `export`.
_ASSIGNMENT = re.compile(
    r"(?:(?<![A-Za-z0-9_])(?P<export>export)[ \t]+)?"
    r"(?<![A-Za-z0-9])(?P<quote>[\"']?)(?P<name>[A-Za-z][A-Za-z0-9_-]*)(?P=quote)[ \t]*[:=][ \t\"'`*]*"
    r"(?P<value>[^\s\"'`]+)")
_NAME_PARTS = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")
_COMMIT = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z", re.IGNORECASE)
_VARIABLE_NAME = re.compile(r"[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\Z")
_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,8}\Z")
_BLOB = re.compile(r"(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9+/=_-]{20,}\Z")
# The characters of a key or of a token. A value with a bracket is program text, not a key.
_KEY_TEXT = re.compile(r"[A-Za-z0-9_.~/+=:@%-]+\Z")


def name_words(name):
    """The words of a name in small letters: `DB_NAME`, `db-name` and `dbName` give `db` and `name`."""
    return [word.lower() for word in re.split(r"[_-]+", _NAME_PARTS.sub("_", name)) if word]


def plain_value(value):
    """True for a value that names a thing: a reference, a variable, a URL or a path. It is no secret text."""
    if value[:1] in "$<{[(%*" or _VARIABLE_NAME.match(value) or "://" in value:
        return True
    # Base64 text can hold `/`. It has capital letters and no file extension, and it can hold `+` and `=`.
    return "/" in value and not {"+", "="} & set(value) and (value == value.lower() or bool(_EXTENSION.search(value)))


def named_value(line):
    """True when a name of the line has a value that looks like a credential.

    The value is the first word after `:` or `=`. It counts only with a letter and a digit, and not when it
    names a thing (`plain_value`). The name decides the smallest length.
    """
    for match in _ASSIGNMENT.finditer(line):
        parts = [word for word in name_words(match["name"]) if not word.isdigit()]
        if parts == ["key"] and re.search(r"(?i)(?<![A-Za-z0-9])api[ \t]+\Z", line[:match.start("name")]):
            parts = ["api", "key"]  # The two words `API key` in a sentence are one name.
        words = set(parts)
        value = match["value"].rstrip(".,;:!?)]}>|")
        if plain_value(value) or not (re.search("[A-Za-z]", value) and re.search("[0-9]", value)):
            continue
        if _PASSWORD_WORDS & words:
            found = len(value) >= 4
        elif _KEY_WORDS & words or (len(parts) > 1 and parts[-1] == "key"):
            # `key` alone is a normal word. As the last word of a longer name it names a credential.
            # A name of two words or more, a name in quotes and an export line are settings, not sentences.
            # After one plain word, 40 or 64 hex characters are a commit identifier.
            setting = len(parts) > 1 or match["quote"] or match["export"]
            found = bool(_KEY_TEXT.match(value)) and (
                len(value) >= 8 if setting else len(value) >= 16 and not _COMMIT.match(value))
        else:
            # An export of another name: only a long text with capital letters, small letters and digits.
            found = bool(match["export"]) and bool(_BLOB.match(value))
        if found:
            return True
    return False


CREDENTIALS = (
    ("private key", re.compile("-----BEGIN [A-Z ]*" + "PRIVATE " + "KEY-----").search),
    ("named value", named_value),
    ("URL with a password", re.compile(r"://[^/\s:@]+:(?![<$*{\[%])[^/\s@]{4,}@").search),
    ("JSON Web Token", re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}").search),
    ("authorization header",
     re.compile(r"(?i)authorization:\s*(?:basic|bear" + r"er)\s+[A-Za-z0-9._~+/=-]{8,}").search),
    ("token form", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}"
                              r"|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|hvs\.[A-Za-z0-9_-]{20,})").search),
)


# --- the two stores -------------------------------------------------------------

class Okknow:
    """The knowledge base, through the `okknow` command only."""

    name = "okknow"

    def __init__(self):
        if not shutil.which("okknow"):
            raise Stop(4, "no knowledge base: the okknow command is not on the path. Tell the user. "
                          "Write no log file, unless the user names a path for --file.")

    def _run(self, arguments, text=None):
        try:
            done = subprocess.run(["okknow", *arguments], input=text, capture_output=True, encoding="utf-8",
                                  errors="replace", timeout=180)
        except (OSError, subprocess.SubprocessError) as error:
            raise Stop(3, f"okknow {arguments[0]} did not run: {type(error).__name__}") from None
        return done

    def _fail(self, done, what):
        lines = (done.stderr or done.stdout or "").strip().splitlines()
        raise Stop(3, f"okknow {what} failed with exit {done.returncode}: {lines[-1][:300] if lines else 'no message'}")

    def read(self, page):
        done = self._run(["--json", "read", page])
        if done.returncode == 1 and "not found" in done.stderr:
            return None
        if done.returncode != 0:
            self._fail(done, "read")
        try:
            return json.loads(done.stdout)["content"]
        except (ValueError, KeyError, TypeError):
            raise Stop(3, "okknow read gave no JSON object with a content field") from None

    def create(self, page, text, summary):
        done = self._run(["write", page, "-", "--summary", summary], text)
        if done.returncode != 0:
            self._fail(done, "write")

    def append(self, page, text, summary):
        done = self._run(["write", page, "-", "--append", "--summary", summary], text)
        if done.returncode != 0:
            self._fail(done, "write --append")

    def edit(self, page, find, replace, occurrence, summary):
        document = {"path": page, "find": find, "replace": replace}
        if occurrence:
            document["occurrence"] = occurrence
        done = self._run(["call", "edit", "-"], json.dumps({"document": document, "summary": summary}))
        if done.returncode != 0:
            self._fail(done, "call edit")

    def zones(self, page):
        """(page name, zone text) for each other DUMMIES page of the knowledge base, with one read-only call."""
        done = self._run(["call", "exec", json.dumps({"command": "find . -name DUMMIES.md"})])
        if done.returncode != 0:
            return []
        try:
            result = json.loads(done.stdout)
        except ValueError:
            return []
        content = result.get("structuredContent") if isinstance(result, dict) else None
        found = []
        for item in (content or {}).get("enrichedPaths") or []:
            if isinstance(item, dict) and isinstance(item.get("path"), str) and item["path"].endswith("DUMMIES.md"):
                zone = (item.get("frontmatter") or {}).get("timezone")
                found.append((page_name(item["path"]), zone if isinstance(zone, str) else None))
        if not found:
            text = (content or {}).get("text") or ""
            found = [(page_name(line.strip()), None) for line in text.splitlines()
                     if re.fullmatch(r"(?:\./)?(?:[^\s/]+/)*DUMMIES\.md", line.strip())]
        pages = []
        for name, zone in found:
            if name == page:
                continue
            if zone is None:
                other = self.read(name)
                zone = frontmatter(other)[0].get("timezone") if other else None
            pages.append((name, zone))
        return pages


class LocalFile:
    """One local file that the user named."""

    name = "file"

    def __init__(self, path):
        self.path = os.path.abspath(os.path.expanduser(path))

    def read(self, page):
        try:
            with open(self.path, encoding="utf-8") as handle:
                return handle.read()
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError) as error:
            raise Stop(3, f"the file is not readable: {short(self.path)}: {type(error).__name__}") from None

    def _write(self, text):
        try:
            write_text(self.path, text)
        except OSError as error:
            raise Stop(3, f"the file is not writable: {short(self.path)}: {type(error).__name__}") from None

    def create(self, page, text, summary):
        if os.path.exists(self.path):
            raise Stop(3, f"the file exists: {short(self.path)}")
        self._write(text)

    def append(self, page, text, summary):
        raise Stop(3, "a local file has no second page")

    def edit(self, page, find, replace, occurrence, summary):
        text = self.read(page)
        changed = replace_in_body(text or "", find, replace, occurrence)
        if changed is None:
            raise Stop(3, "the text to replace is not in the file")
        self._write(changed)

    def zones(self, page):
        return []


def page_name(path):
    return re.sub(r"\.mdx?$", "", path.removeprefix("./"))


def replace_in_body(text, find, replace, occurrence=None):
    """The text with one match of `find` in the body replaced, or None. `occurrence` 1 is the first match."""
    start = frontmatter(text)[1]
    position = start - 1
    for _ in range(occurrence or 1):
        position = text.find(find, position + 1)
        if position < 0:
            return None
    return text[:position] + replace + text[position + len(find):]


# --- the page ---------------------------------------------------------------------

def frontmatter(text):
    """(fields, offset of the body). Only the `key: value` lines of the first block are read."""
    lines = (text or "").split("\n")
    if lines[0].strip() != "---":
        return {}, 0
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            fields = {}
            for line in lines[1:index]:
                match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)", line)
                if match:
                    value = match.group(2).strip()
                    if len(value) > 1 and value[0] == value[-1] and value[0] in "'\"":
                        value = value[1:-1]
                    fields[match.group(1)] = value
            return fields, sum(len(line) + 1 for line in lines[:index + 1])
    return {}, 0


class Entry:
    def __init__(self, text, start):
        self.text, self.start = text, start
        self.heading = text.split("\n", 1)[0].rstrip()
        self.match = HEADING.fullmatch(self.heading)
        record = next((RECORD.fullmatch(line.strip()) for line in text.split("\n")[1:6] if RECORD.fullmatch(line.strip())),
                      None)
        self.session = record.group("session") if record else None

    def moment(self):
        """The time of the heading as a number for a comparison, or None."""
        if not self.match:
            return None
        hour = int(self.match["hour"]) % 12 + (12 if self.match["half"] == "PM" else 0)
        try:
            return datetime.datetime(int(self.match["year"]), MONTHS.index(self.match["month"]) + 1,
                                     int(self.match["day"]), hour, int(self.match["minute"]))
        except ValueError:
            return None

    def labels(self):
        """The label lines of the new form or of the old form, in the order of the entry."""
        return [line.strip() for line in self.text.split("\n") if LABEL_LINE.match(line.strip())]


class Page:
    """A page text, split at its entries heading. The entries are the `###` blocks below it."""

    def __init__(self, text):
        self.text = text
        self.fields, self.body_start = frontmatter(text)
        lines = text.split("\n")
        offsets, total = [], 0
        for line in lines:
            offsets.append(total)
            total += len(line) + 1
        fenced, marks = False, []
        for index, line in enumerate(lines):
            if offsets[index] < self.body_start:
                continue
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
            elif not fenced and line.rstrip() == ENTRIES_HEADING:
                marks.append(index)
        self.headings = len(marks)
        self.heading_start = offsets[marks[0]] if marks else None
        self.head, self.preamble, self.footer, self.entries = text, "", "", []
        if self.headings != 1:
            return
        first = marks[0] + 1
        starts, stop, fenced = [], len(lines), False
        for index in range(first, len(lines)):
            line = lines[index]
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
            elif not fenced and line.startswith("### "):
                starts.append(index)
            elif not fenced and line.startswith(("# ", "## ")):
                stop = index
                break
        end_of = lambda index: offsets[index] if index < len(lines) else len(text)  # noqa: E731
        self.head = text[:end_of(first)]
        self.preamble = text[end_of(first):end_of(starts[0] if starts else stop)]
        self.footer = text[end_of(stop):]
        for number, index in enumerate(starts):
            last = starts[number + 1] if number + 1 < len(starts) else stop
            self.entries.append(Entry("\n".join(lines[index:last]).rstrip(), offsets[index]))


def parse_zone(value):
    """(label, tzinfo, text of the frontmatter field) of a zone text, or None."""
    value = (value or "").strip()
    if value.upper() == "UTC":
        value = "UTC (UTC+00:00)"
    match = ZONE.fullmatch(value)
    if not match or int(match["hours"]) > 14 or int(match["minutes"]) > 59:
        return None
    delta = datetime.timedelta(hours=int(match["hours"]), minutes=int(match["minutes"]))
    return match["label"], datetime.timezone(delta if match["sign"] == "+" else -delta), value


def now():
    """The time of the clock. `DUMMIES_NOW` replaces the clock in a test."""
    fixed = os.environ.get("DUMMIES_NOW")
    moment = datetime.datetime.fromisoformat(fixed) if fixed else datetime.datetime.now(datetime.timezone.utc)
    return moment if moment.tzinfo else moment.replace(tzinfo=datetime.timezone.utc)


def heading_text(moment, label, agent, model, summary):
    return (f"### {MONTHS[moment.month - 1]} {moment.day}, {moment.year}, {moment.hour % 12 or 12}:{moment.minute:02d} "
            f"{'AM' if moment.hour < 12 else 'PM'} {label} | Agent: {agent} | Model: {model} | {summary}")


def clean(value):
    """One line with no field separator."""
    return re.sub(r"\s+", " ", str(value).replace("|", "/")).strip()


def credential(text):
    """(line number, kind) of the first line that looks like a credential, or None."""
    for number, line in enumerate(text.split("\n"), 1):
        for kind, found in CREDENTIALS:
            if found(line):
                return number, kind
    return None


def capitals(text):
    """True when the text has one item in capital letters: three words or more with no small letter."""
    run = strong = 0
    for word in text.split():
        letters = [letter for letter in word if letter.isalpha()]
        if any(letter.islower() for letter in letters):
            run = strong = 0
            continue
        run += 1
        strong += len(letters) >= 2
        if run >= 3 and strong >= 2:
            return True
    return False


def label_part(text):
    """The lines of an entry text from its first label to its last label."""
    lines = text.split("\n")
    marks = [index for index, line in enumerate(lines) if LABEL_LINE.match(line.strip())]
    if not marks:
        return ""
    end = next((index for index in range(marks[-1] + 1, len(lines))
                if not lines[index].strip() or lines[index].startswith("#")), len(lines))
    return "\n".join(lines[marks[0]:end])


def findings(page):
    """The contract findings of a page: a list of (rule, detail)."""
    found = []
    zone = parse_zone(page.fields.get("timezone"))
    if not page.body_start:
        found.append(("frontmatter", "the page has no frontmatter block with `type`, `title`, `description`, "
                                     "`order` and `timezone`"))
    else:
        for key in ("type", "title", "description"):
            if not page.fields.get(key):
                found.append((key, f"the frontmatter has no `{key}`"))
        if page.fields.get("order") != "newest-first":
            found.append(("order_field", "the frontmatter field `order` is not `newest-first`"))
        if not zone:
            found.append(("timezone", "the frontmatter field `timezone` is not a label and a fixed offset, "
                                      "for example `UTC (UTC+00:00)`"))
    if not re.search(r"(?m)^## Update contract\b", page.text[page.body_start:]):
        found.append(("contract_section", "the page has no `## Update contract` section"))
    if page.headings != 1:
        found.append(("entries_heading", f"the page has {page.headings} lines `{ENTRIES_HEADING}`, not one"))
        return found
    before = None
    for number, entry in enumerate(page.entries, 1):
        where = f"entry {number}"
        if not entry.match:
            found.append(("heading_form", f"{where}: the heading is not `### <Mon D, YYYY, H:MM AM|PM> <zone> | "
                                          "Agent: <agent> | Model: <model> | <summary>`"))
        else:
            if zone and entry.match["zone"] != zone[0]:
                found.append(("heading_zone", f"{where}: the zone of the heading is not the zone of the page"))
            moment = entry.moment()
            if moment is None:
                found.append(("heading_form", f"{where}: the date of the heading is not a date"))
            elif before is not None and moment > before:
                found.append(("newest_first", f"{where}: the entry is newer than the entry above it"))
            before = moment if moment is not None else before
        names = [LABEL_LINE.match(line).group(1) for line in entry.labels()]
        if names not in (list(LABELS), list(OLD_LABELS)):
            found.append(("labels", f"{where}: the labels are not Important, Open, Next, Goal in this order, and not "
                                    "Goal, Executed, Relevance, Effects, Next of the old form"))
        elif not capitals(label_part(entry.text)):
            found.append(("capitals", f"{where}: no item of the labels is in capital letters"))
        hit = credential(entry.text)
        if hit:
            found.append(("credential", f"{where}: line {hit[0]} of the entry looks like a credential ({hit[1]})"))
    return found


# --- the session ------------------------------------------------------------------

def session_models(path):
    """The models of the assistant messages of a session file, in the order of their first use."""
    models = []
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                message = item.get("message") if isinstance(item, dict) else None
                if not isinstance(message, dict) or message.get("role") != "assistant" or item.get("isSidechain"):
                    continue
                model = message.get("model")
                if isinstance(model, str) and model.strip() and not model.startswith("<") and clean(model) not in models:
                    models.append(clean(model))
    except OSError:
        return []
    return models


def session_id_of(path):
    """The session identifier of a session file: the `id` of its first line, or the file name."""
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            first = json.loads(handle.readline())
        for key in ("id", "sessionId"):
            if isinstance(first, dict) and isinstance(first.get(key), str) and first[key].strip():
                return first[key].strip()
    except (OSError, ValueError):
        pass
    return os.path.splitext(os.path.basename(path))[0]


def session_facts(args, env=None):
    """The agent, the model and the session of this session: from the session data, then from the arguments."""
    env = os.environ if env is None else env
    record = herdr_agent(env)
    harness = detect_harness(args.harness, env, record)
    session, session_file = args.session, args.session_file
    if harness == "pi":
        session = session or env.get("PI_SESSION_ID")
        session_file = session_file or env.get("PI_SESSION_FILE")
    elif harness == "claude":
        session = session or env.get("CLAUDE_CODE_SESSION_ID")
    held = (record or {}).get("agent_session") or {}
    if record and record.get("agent") == harness and isinstance(held.get("value"), str):
        if held.get("kind") == "path":
            session_file = session_file or held["value"]
        else:
            session = session or held["value"]
    if harness == "claude" and not session_file and session:
        base = env.get("CLAUDE_CONFIG_DIR") or os.path.join(home(), ".claude")
        hits = glob.glob(os.path.join(glob.escape(base), "projects", "*", glob.escape(session) + ".jsonl"))
        session_file = hits[0] if len(hits) == 1 else None
    if session_file and not os.path.isfile(session_file):
        session_file = None
    if session_file and not session:
        session = session_id_of(session_file)
    models = session_models(session_file) if session_file else []
    source = "session file"
    if not models and harness == "pi" and env.get("PI_MODEL"):
        models, source = [clean(env["PI_MODEL"])], "PI_MODEL"
    if not models and args.model:
        models, source = [clean(args.model)], "argument"
    if not models:
        models, source = ["unknown"], "not known"
    agent = clean(args.agent) if args.agent else AGENTS.get(harness)
    if not agent:
        raise Stop(2, "the agent is not known: add --harness pi, --harness claude or --agent <name>")
    return {"harness": harness or "agent", "agent": agent, "model": ", ".join(models), "source": source,
            "session": clean(session).replace(" ", "-") if session else "unknown"}


def project_slug(cwd=None):
    """The name of the directory of the repository, of the main checkout for a worktree, as a slug.

    None when the directory is not in a Git repository: the name of such a directory is no project.
    """
    name = os.path.basename(os.path.abspath(cwd or os.getcwd()))
    try:
        done = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=cwd, capture_output=True, text=True, timeout=10)
        if done.returncode != 0:
            return None
        common = os.path.abspath(os.path.join(cwd or os.getcwd(), done.stdout.strip()))
        if os.path.basename(common) == ".git":
            name = os.path.basename(os.path.dirname(common))
        else:
            top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=cwd, capture_output=True, text=True, timeout=10)
            name = os.path.basename(top.stdout.strip()) or name
    except (OSError, subprocess.SubprocessError):
        return None
    return re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-") or "project"


def target(args):
    """(store, page name, project slug) of the arguments."""
    project = args.project or project_slug()
    if project is None:
        raise Stop(2, "the project is not known: the current directory is not in a Git repository, or the git "
                      "command is absent. Add --project <slug>.")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise Stop(2, "the project is a slug: small letters, digits, `_` and `-`. Its first character is a letter "
                      "or a digit.")
    page = page_name(args.page.strip().strip("/")) if args.page else f"projects/{project}/DUMMIES"
    # A name that starts with `-` is an option for the okknow command, not a page.
    if not page or page.startswith("-") or ".." in page.split("/") or re.search(r"\s", page):
        raise Stop(2, "the page name is not valid: it has no `-` at its start, no `..` part and no white space")
    if args.file:
        return LocalFile(args.file), short(os.path.abspath(os.path.expanduser(args.file))), project
    return Okknow(), page, project


def write_summary(facts, project, intent):
    """The summary of a write: the agent, the model, the project and the intent, in 80 characters."""
    return f"{facts['harness']}/{facts['model'].split(', ')[0]} {project}: {intent}"[:80]


# --- the commands -----------------------------------------------------------------

def load_page(store, name):
    text = store.read(name)
    if text is None:
        raise Stop(6, f"the page is absent: {name}. Run init.")
    return Page(text)


def page_zone(page, name):
    zone = parse_zone(page.fields.get("timezone"))
    if not zone:
        raise Stop(8, f"{name} has no valid `timezone` field in its frontmatter. Run check.")
    return zone


def entry_heading(facts, zone, summary):
    moment = now().astimezone(zone[1])
    return (heading_text(moment, zone[0], facts["agent"], facts["model"], summary),
            f"Recorded: {moment.isoformat(timespec='seconds')} | Session: {facts['session']}")


def new_page(store, name, project, args, facts):
    """Create the page from the template. Return the lines for the result."""
    if args.zone:
        zone, source = parse_zone(args.zone), "the argument"
        if not zone:
            raise Stop(2, 'the zone is not a label and a fixed offset, for example "UTC (UTC+00:00)"')
    else:
        zone, source = None, None
        for other, text in store.zones(name):
            if parse_zone(text):
                zone, source = parse_zone(text), other
                break
        if not zone:
            raise Stop(7, f"a new page needs a zone, and no other DUMMIES page gives one. Ask the user one time for the "
                          f"zone of {name}. Then run init --zone \"<label> (UTC+HH:MM)\". With no answer, run init --zone UTC.")
    handoffs = handoffs_text = None
    if store.name == "okknow" and "/" in name:
        handoffs = name.rsplit("/", 1)[0] + "/handoffs"
        handoffs_text = store.read(handoffs)
        if handoffs_text is None:
            handoffs = None
    title = clean(args.title) if getattr(args, "title", None) else f"{project} human session log"
    try:
        with open(TEMPLATE, encoding="utf-8") as handle:
            template = handle.read()
    except OSError:
        raise Stop(2, "the page template of the skill is absent: page-template.md") from None
    text = (template.replace("{title}", title).replace("{slug}", project).replace("{zone}", zone[2])
            .replace("{context}", "Earlier project context is in [handoffs](./handoffs.md).\n" if handoffs else ""))
    store.create(name, text, write_summary(facts, project, "create the human session log"))
    created = store.read(name)
    problems = findings(Page(created)) if created is not None else [("absent", "the page is absent after the write")]
    if problems:
        raise Stop(9, f"{name} is written, but it does not follow the contract: " + "; ".join(rule for rule, _ in problems))
    note = "none"
    if handoffs:
        note = "the pointer is there already"
        if "DUMMIES" not in handoffs_text:
            stamp = now().astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
            line_end = "" if not handoffs_text or handoffs_text.endswith("\n") else "\n"
            store.append(handoffs, f"{line_end}- {stamp}: The human session log of this project is "
                                   "[DUMMIES](./DUMMIES.md). Read its newest entry first. The dummies skill adds one "
                                   "entry at the end of the work of a session.\n",
                         write_summary(facts, project, "point at the human session log"))
            note = "pointer added" if "DUMMIES" in (store.read(handoffs) or "") else "the pointer is not there after the write"
    return f"created: {name} | zone: {zone[2]} (from {source}) | handoffs: {note}"


def command_heading(args):
    store, name, _ = target(args)
    facts = session_facts(args)
    text = store.read(name)
    if text is None and not args.zone:
        raise Stop(6, f"the page is absent: {name}. Run init, or add --zone.")
    zone = page_zone(Page(text), name) if text is not None else parse_zone(args.zone)
    if not zone:
        raise Stop(2, 'the zone is not a label and a fixed offset, for example "UTC (UTC+00:00)"')
    heading, record = entry_heading(facts, zone, clean(args.summary) if args.summary else "<summary>")
    print(heading)
    print(record)
    print(f"model source: {facts['source']}")


def command_init(args):
    store, name, project = target(args)
    text = store.read(name)
    if text is not None:
        zone = parse_zone(Page(text).fields.get("timezone"))
        print(f"exists: {name} | zone: {zone[2] if zone else 'not valid'} | nothing written")
        return
    print(new_page(store, name, project, args, session_facts(args)))


def read_body(args):
    try:
        if args.body_file and args.body_file != "-":
            with open(args.body_file, encoding="utf-8") as handle:
                return handle.read()
        return sys.stdin.buffer.read().decode("utf-8")
    except (OSError, UnicodeError) as error:
        raise Stop(2, f"the body is not readable: {type(error).__name__}") from None


def checked_body(body):
    """The body of an entry with no outer blank line, or a stop with the rule that it breaks."""
    lines = [line.rstrip() for line in body.replace("\r\n", "\n").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    body = "\n".join(lines)
    if not body:
        raise Stop(2, "the body is empty. Give it on standard input or with --body-file.")
    fenced = False
    for line in lines:
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced and re.match(r"#{1,3} ", line):
            raise Stop(2, "a heading in the body has four `#` or more. A `###` line starts a new entry.")
    if fenced:
        raise Stop(2, "a fenced block of the body has no end line")
    names = [LABEL_LINE.match(line.strip()).group(1) for line in lines if LABEL_LINE.match(line.strip())]
    if names != list(LABELS):
        raise Stop(2, "the body starts with four lines in this order and form: **Important:** text, **Open:** text, "
                      "**Next:** text, **Goal:** text")
    if not capitals(label_part(body)):
        raise Stop(2, "write the most important item of the four labels in CAPITAL LETTERS: three words or more")
    spaced = []
    for line in lines:
        # A page shows each label as its own paragraph only with an empty line before it.
        if LABEL_LINE.match(line.strip()) and spaced and spaced[-1]:
            spaced.append("")
        spaced.append(line)
    return "\n".join(spaced)


def place(page, entry):
    """(text to find, replacement, occurrence or None) for one edit that puts the entry below the entries heading."""
    if page.entries:
        find, at, replace = page.entries[0].heading, page.entries[0].start, entry + "\n\n" + page.entries[0].heading
    elif page.preamble.strip() == PLACEHOLDER:
        find, at, replace = PLACEHOLDER, len(page.head) + page.preamble.index(PLACEHOLDER), entry
    else:
        find, at, replace = ENTRIES_HEADING, page.heading_start, ENTRIES_HEADING + "\n\n" + entry
    if find in page.text[:page.body_start]:
        raise Stop(8, "the line to edit is also in the frontmatter of the page")
    body = page.text[page.body_start:]
    return find, replace, (body.count(find, 0, at - page.body_start) + 1 if body.count(find) > 1 else None)


def prove(before, after, heading):
    """(count of older entries that are unchanged, count of new entries of other writers, problems)."""
    problems = []
    if after.headings != 1:
        return 0, 0, [f"the page has {after.headings} entries headings"]
    if after.head != before.head or after.footer != before.footer:
        problems.append("the text outside the entries changed")
    new = [entry.text for entry in after.entries]
    headings = [entry.heading for entry in after.entries]
    if headings.count(heading) != 1:
        problems.append(f"the new entry is on the page {headings.count(heading)} times")
    kept, position, first_old = 0, 0, None
    for entry in before.entries:
        try:
            position = new.index(entry.text, position)
        except ValueError:
            problems.append("an older entry changed (" + entry.heading[4:].split(" | ")[0] + ")")
            continue
        first_old = position if first_old is None else first_old
        position += 1
        kept += 1
    if heading in headings and first_old is not None and headings.index(heading) > first_old:
        problems.append("the new entry is not above the older entries")
    return kept, max(0, len(new) - kept - headings.count(heading)), problems


def command_add(args):
    # The switch of the user comes first: with the log off, add needs no knowledge base and no session data.
    if log_state() == "off":
        print("log: off, no entry")
        return
    store, name, project = target(args)
    summary = clean(args.summary or "")
    if not summary or len(summary.split()) > SUMMARY_WORDS:
        raise Stop(2, f"--summary is the result of the session in 1 to {SUMMARY_WORDS} words")
    written = read_body(args)
    for part, text in (("summary", summary), ("body", written.replace("\r\n", "\n").lstrip("\n"))):
        hit = credential(text)
        if hit:
            raise Stop(2, f"refused: line {hit[0]} of the {part} looks like a credential ({hit[1]}). "
                          "No credential in a page.")
    body = checked_body(written)
    facts = session_facts(args)
    if facts["session"] == "unknown":
        raise Stop(2, "the session is not known: add --session <id>. Give the identifier that the harness has for "
                      "this session. When the harness has none, make one new unique text and give it in each add "
                      "of this session.")
    text = store.read(name)
    if text is None:
        print(new_page(store, name, project, args, facts))
        text = store.read(name)
    before = Page(text)
    if before.headings != 1:
        raise Stop(8, f"{name} has {before.headings} lines `{ENTRIES_HEADING}`, not one. Run check.")
    zone = page_zone(before, name)
    if not args.again:
        same = [entry for entry in before.entries if entry.session == facts["session"]]
        if same:
            raise Stop(5, f"this session has an entry already ({same[0].heading[4:].split(' | ')[0]}). Earlier entries "
                          "stay as they are. For a correction or for later work of the same session, add a new entry "
                          "with --again.")
    heading, record = entry_heading(facts, zone, summary)
    if any(entry.heading == heading for entry in before.entries):
        raise Stop(5, "an entry with this heading is on the page already. Change the summary.")
    entry = f"{heading}\n\n{record}\n\n{body}"
    find, replace, occurrence = place(before, entry)
    store.edit(name, find, replace, occurrence, write_summary(facts, project, "add DUMMIES entry"))
    written = store.read(name)
    if written is None:
        raise Stop(9, f"{name} is absent after the write")
    kept, others, problems = prove(before, Page(written), heading)
    if problems:
        raise Stop(9, f"the write to {name} is not proven: " + "; ".join(problems) + ". Read the page and its history.")
    note = f" | new entries of other writers: {others}" if others else ""
    print(f"added: {name} | {heading[4:].split(' | ')[0]} | Agent: {facts['agent']} | Model: {facts['model']} "
          f"({facts['source']}) | older entries unchanged: {kept}{note}")


def command_recent(args):
    store, name, _ = target(args)
    page = load_page(store, name)
    print(f"page: {name} | zone: {page.fields.get('timezone', 'not set')} | entries: {len(page.entries)}")
    print("The page gives the last checked state, not a live status. Check a fact that can change before you act on it.")
    for number, entry in enumerate(page.entries[:max(1, args.entries)]):
        print()
        lines = entry.text.split("\n")
        if number == 0:
            print("\n".join(lines[:args.lines]))
            if len(lines) > args.lines:
                print(f"[more lines of this entry on the page: {len(lines) - args.lines}]")
        else:
            print(lines[0])
            # The new form gives three lines. The old form has no `Open` label: it gives two lines.
            print("\n".join(line for line in entry.labels()
                            if line.startswith(("**Important:**", "**Open:**", "**Relevance:**", "**Next:**"))))
    if not page.entries:
        print("\nThe page has no entry.")
    elif len(page.entries) > args.entries:
        print(f"\n[older entries on the page: {len(page.entries) - args.entries}]")


def command_check(args):
    store, name, _ = target(args)
    page = load_page(store, name)
    found = findings(page)
    for rule, detail in found:
        print(f"finding: {rule}: {detail}")
    if found:
        raise Stop(8, f"check: {len(found)} findings in {name}")
    print(f"check: valid | {name} | entries: {len(page.entries)} | zone: {page.fields['timezone']}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="page.py", description="Keep the human session log of a project.",
        epilog="The variable DUMMIES_NOW (an ISO time) replaces the clock. It is for tests only.")
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--project")
    shared.add_argument("--page")
    shared.add_argument("--file")
    shared.add_argument("--harness", choices=HARNESSES)
    shared.add_argument("--agent")
    shared.add_argument("--model")
    shared.add_argument("--session")
    shared.add_argument("--session-file")
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("heading", parents=[shared])
    one.add_argument("--summary")
    one.add_argument("--zone")
    one = commands.add_parser("init", parents=[shared])
    one.add_argument("--zone")
    one.add_argument("--title")
    one = commands.add_parser("add", parents=[shared])
    one.add_argument("--summary", required=True)
    one.add_argument("--body-file")
    one.add_argument("--again", action="store_true")
    one.add_argument("--zone")
    one = commands.add_parser("recent", parents=[shared])
    one.add_argument("--entries", type=int, default=3)
    one.add_argument("--lines", type=int, default=60)
    commands.add_parser("check", parents=[shared])
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        {"heading": command_heading, "init": command_init, "add": command_add, "recent": command_recent,
         "check": command_check}[args.command](args)
    except Stop as stop:
        print(f"page.py: {stop}", file=sys.stderr)
        return stop.code
    except Exception as error:  # A fault of the script: one line and a fixed code, no trace.
        print(f"page.py: fault of the script: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
