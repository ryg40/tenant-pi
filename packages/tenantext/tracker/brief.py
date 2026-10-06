"""Parse, validate and dump tracker-brief/1 documents.

The parser reads the Markdown subset and reports syntax errors.
The validator checks meaning: keys, enums, ids, links, counts and word budgets.
Standard library only. No network, no subprocess, no clock.
The optional ``now`` argument of ``validate`` is the only time input.
The ``handoff`` record holds the stored next-session prompt; ``tracker.handoff`` builds it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

SCHEMA = "tracker-brief/1"
DEFAULT_STALE_AFTER_DAYS = 7
BUDGET_WARN = 400
BUDGET_ERROR = 550

TEXT, LIST, INT, BLOCK = "text", "list", "int", "block"
R, O = True, False

META_FIELDS = (
    ("schema", R),
    ("repo", R),
    ("repo_url", R),
    ("ref", R),
    ("snapshot", R),
    ("evidence_checked", R),
    ("previous_snapshot", O),
    ("scope", R),
    ("synthesis", R),
    ("stale_after_days", O),
)
META_KEYS = tuple(k for k, _ in META_FIELDS)

# (heading, record type, model key), in the required order.
SECTIONS = (
    ("Where things stand", "position", "position"),
    ("What changed", "change", "changes"),
    ("Still active", "active", "active"),
    ("Issues and work items", "issue", "issues"),
    ("Approval boundaries", "gate", "gates"),
    ("Unknowns and conflicts", "unknown", "unknowns"),
    ("Follow-up paths", "path", "paths"),
    ("Evidence", "evidence", "evidence"),
)
HEADINGS = tuple(h for h, _, _ in SECTIONS)

# Every record type as (section heading, record type, model key), in dump order.
# `## Follow-up paths` holds `path` records and at most one `handoff` record.
RECORDS = (
    ("Where things stand", "position", "position"),
    ("What changed", "change", "changes"),
    ("Still active", "active", "active"),
    ("Issues and work items", "issue", "issues"),
    ("Approval boundaries", "gate", "gates"),
    ("Unknowns and conflicts", "unknown", "unknowns"),
    ("Follow-up paths", "path", "paths"),
    ("Follow-up paths", "handoff", "handoffs"),
    ("Evidence", "evidence", "evidence"),
)
SECTION_TYPES = {h: {t: k for hh, t, k in RECORDS if hh == h} for h in HEADINGS}

FIELDS = {
    "position": (
        ("id", R, TEXT), ("text", R, TEXT), ("milestone", O, TEXT),
        ("status", R, TEXT), ("evidence", O, LIST),
    ),
    "change": (
        ("id", R, TEXT), ("title", R, TEXT), ("summary", R, TEXT),
        ("status", R, TEXT), ("evidence", R, LIST),
    ),
    "active": (
        ("id", R, TEXT), ("title", R, TEXT), ("readiness", R, TEXT), ("next", R, TEXT),
        ("requester", O, TEXT), ("blocker", O, TEXT), ("priority", R, INT), ("evidence", O, LIST),
    ),
    "issue": (
        ("id", R, TEXT), ("title", R, TEXT), ("state", R, TEXT), ("progress", R, TEXT),
        ("url", R, TEXT), ("checked", R, TEXT), ("workstream", O, TEXT),
        ("blockers", O, LIST), ("note", O, TEXT),
    ),
    "gate": (
        ("id", R, TEXT), ("kind", R, TEXT), ("text", R, TEXT), ("evidence", O, LIST),
    ),
    "unknown": (
        ("id", R, TEXT), ("kind", R, TEXT), ("severity", R, TEXT), ("text", R, TEXT),
        ("evidence", O, LIST),
    ),
    "path": (
        ("id", R, TEXT), ("title", R, TEXT), ("role", R, TEXT), ("readiness", R, TEXT),
        ("issues", O, LIST), ("repo", R, TEXT), ("cwd", O, TEXT), ("revision", O, TEXT),
        ("objective", R, TEXT), ("depends", O, LIST), ("prerequisites", O, LIST),
        ("read_first", O, LIST), ("scope", R, TEXT), ("authority", R, TEXT),
        ("needs_approval", O, LIST), ("acceptance", R, LIST), ("validate", O, LIST),
        ("output", R, TEXT), ("next_action", R, TEXT),
    ),
    "handoff": (
        ("id", R, TEXT), ("path", R, TEXT), ("source", R, TEXT), ("generated", R, TEXT),
        ("basis", R, TEXT), ("text", R, BLOCK),
    ),
    "evidence": (
        ("id", R, TEXT), ("label", R, TEXT), ("kind", R, TEXT), ("ref", R, TEXT),
        ("confidence", R, TEXT), ("revision", O, TEXT), ("checked", O, TEXT), ("note", O, TEXT),
    ),
}

STATUS = ("verified", "reported", "estimate", "proposal")
READINESS = ("ready-offline", "needs-decision", "approval-gated", "blocked", "parked", "optional")
ISSUE_STATES = ("open", "closed")
PROGRESS = (
    "not-started", "in-progress", "implemented", "merged",
    "deployed", "validated", "parked", "abandoned",
)
GATE_KINDS = ("allowed", "forbidden", "approval")
UNKNOWN_KINDS = ("stale", "missing", "conflict", "inaccessible")
SEVERITIES = ("critical", "normal")
ROLES = ("recommended", "alternative", "backlog")
EVIDENCE_KINDS = ("issue", "pr", "commit", "okf", "test", "file", "url", "note")
SYNTHESIS = ("model", "minimal")
HANDOFF_SOURCES = ("generated", "requester")
HANDOFF_BASES = ("current", "carried-forward")
HANDOFF_MAX_WORDS = 450

ENUMS = {
    ("position", "status"): STATUS,
    ("change", "status"): STATUS,
    ("active", "readiness"): READINESS,
    ("issue", "state"): ISSUE_STATES,
    ("issue", "progress"): PROGRESS,
    ("gate", "kind"): GATE_KINDS,
    ("unknown", "kind"): UNKNOWN_KINDS,
    ("unknown", "severity"): SEVERITIES,
    ("path", "role"): ROLES,
    ("path", "readiness"): READINESS,
    ("evidence", "kind"): EVIDENCE_KINDS,
    ("evidence", "confidence"): STATUS,
    ("handoff", "source"): HANDOFF_SOURCES,
    ("handoff", "basis"): HANDOFF_BASES,
}
DATE_FIELDS = {("issue", "checked"), ("evidence", "checked"), ("handoff", "generated")}
WORD_LIMITS = {
    ("position", "text"): 40, ("change", "summary"): 40, ("active", "next"): 30,
    ("handoff", "text"): HANDOFF_MAX_WORDS,
}
EVIDENCE_LISTS = {
    ("position", "evidence"), ("change", "evidence"), ("active", "evidence"),
    ("gate", "evidence"), ("unknown", "evidence"), ("path", "read_first"),
}
BLOCKED_SCHEMES = ("http", "javascript", "data", "vbscript", "file", "ftp", "blob", "ws", "wss")

ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
KEY_RE = re.compile(r"([a-z][a-z0-9_]*):(.*)")
ITEM_RE = re.compile(r"  - (.*)")
ISSUE_REF_RE = re.compile(r"#[0-9]+")
REPO_RE = re.compile(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+")
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
SCHEME_RE = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*):")
UNSAFE_URL_CHARS = re.compile(r"[\s<>\"'`\\\x00-\x1f\x7f]")
CONTROL_RE = re.compile(r"[\x00-\x08\x0a-\x1f\x7f]")


@dataclass(frozen=True)
class Diagnostic:
    """One parser or validator finding. ``line`` is 1-based or None."""

    level: str
    code: str
    message: str
    line: int | None = None

    def __str__(self) -> str:
        where = f"line {self.line}: " if self.line else ""
        return f"{where}{self.level} [{self.code}] {self.message}"


class BriefError(ValueError):
    """Raised when a document cannot be parsed or a model cannot be rendered."""

    def __init__(self, diagnostics):
        self.diagnostics = list(diagnostics)
        super().__init__("\n".join(str(d) for d in self.diagnostics) or "invalid brief")


class _Located(dict):
    """A dict that remembers source line numbers. Equality ignores the lines."""

    def __init__(self, *args, line=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.line = line
        self.key_lines = {}
        self.item_lines = {}


def _line(obj, key=None, index=None):
    if key is not None:
        items = getattr(obj, "item_lines", {}).get(key)
        if index is not None and items and index < len(items):
            return items[index]
        found = getattr(obj, "key_lines", {}).get(key)
        if found:
            return found
    return getattr(obj, "line", None)


def _error(code, message, line=None):
    return Diagnostic("error", code, message, line)


def _warning(code, message, line=None):
    return Diagnostic("warning", code, message, line)


def _sorted(diags):
    return sorted(diags, key=lambda d: (d.line is None, d.line or 0))


def field_spec(record_type):
    """Return {field: (required, kind)} for a record type."""
    return {name: (req, kind) for name, req, kind in FIELDS[record_type]}


def parse_utc(value):
    """Parse ``YYYY-MM-DDTHH:MM:SSZ``. Return an aware datetime or None."""
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def is_safe_https(url):
    """True for a lowercase, credential-free https:// URL with a host."""
    if not isinstance(url, str) or not url.startswith("https://") or UNSAFE_URL_CHARS.search(url):
        return False
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError on a bad port
    except ValueError:
        return False
    return (
        parts.scheme == "https"
        and bool(parts.hostname)
        and parts.username is None
        and parts.password is None
        and "@" not in parts.netloc
    )


def ref_problem(ref):
    """Explain why an evidence ref is unsafe, or return None when it is safe."""
    if not isinstance(ref, str):
        return "the ref must be text"
    if ref.startswith("//"):
        return "protocol-relative URLs are not allowed"
    match = SCHEME_RE.match(ref)
    if match:
        scheme = match.group(1).lower()
        if scheme == "https":
            if not is_safe_https(ref):
                return "an https ref must be lowercase https://, have a host, and carry no credentials or spaces"
        elif scheme in BLOCKED_SCHEMES:
            return f"{scheme}: refs are not allowed; use a credential-free https:// URL or a plain reference"
    return None


def recommended_path(model):
    """Return the first path record with ``role: recommended``, or None."""
    return next(
        (p for p in model.get("paths", []) if isinstance(p, dict) and p.get("role") == "recommended"),
        None,
    )


def stored_handoff(model):
    """Return the stored handoff record for the recommended path, or None.

    Readers (the renderer, path packets, ``python3 -m tracker handoff``) use this.
    They show the stored text and never compose prompt text.
    """
    path = recommended_path(model)
    if path is None:
        return None
    return next(
        (h for h in model.get("handoffs", []) if isinstance(h, dict) and h.get("path") == path.get("id")),
        None,
    )


def resolve_issue(ref, issues):
    """Find the issue record for a path ``issues`` item (an issue id or ``#<number>``)."""
    by_id = {i.get("id"): i for i in issues if isinstance(i, dict)}
    if ref in by_id:
        return by_id[ref]
    match = re.fullmatch(r"#([0-9]+)", ref) if isinstance(ref, str) else None
    if match:
        number = match.group(1)
        if number in by_id:
            return by_id[number]
        for issue in by_id.values():
            url = issue.get("url", "")
            if isinstance(url, str) and "/issues/" in url and url.rstrip("/").rsplit("/", 1)[-1] == number:
                return issue
    return None


def words(text):
    """Count words the way the budget does: whitespace-separated tokens."""
    return len(text.split()) if isinstance(text, str) else 0


def default_brief_strings(model):
    """Return the strings that the default (first-screen) budget counts."""
    out = []
    position = model.get("position") or {}
    out += [position.get("text", ""), position.get("milestone", "")]
    for rec in model.get("changes", []):
        out += [rec.get("title", ""), rec.get("summary", "")]
    for rec in model.get("active", []):
        out += [rec.get("title", ""), rec.get("next", ""), rec.get("requester", ""), rec.get("blocker", "")]
    for rec in model.get("gates", []):
        if rec.get("kind") == "approval":
            out.append(rec.get("text", ""))
    for rec in model.get("unknowns", []):
        if rec.get("severity") == "critical":
            out.append(rec.get("text", ""))
    for rec in model.get("paths", []):
        if rec.get("role") == "recommended":
            out += [rec.get("title", ""), rec.get("objective", ""), rec.get("next_action", "")]
        elif rec.get("role") == "alternative":
            out.append(rec.get("title", ""))
    return [s for s in out if isinstance(s, str) and s]


def default_brief_word_count(model):
    """Word count of the default brief, as the budget defines it."""
    return sum(words(s) for s in default_brief_strings(model))


# ---------------------------------------------------------------- parsing


def parse(text):
    """Parse a tracker-brief/1 document into the normalized model.

    Raises BriefError with line-numbered diagnostics on syntax errors.
    Semantic checks (required keys, enums, ids, links, budgets) live in validate().
    """
    if not isinstance(text, str):
        raise BriefError([_error("frontmatter", "the document must be text")])
    lines = text.replace("\r\n", "\n").split("\n")
    diags = []

    if not lines or lines[0] != "---":
        raise BriefError([_error("frontmatter", "the document must start with a '---' line", 1)])
    close = next((i for i in range(1, len(lines)) if lines[i] == "---"), None)
    if close is None:
        raise BriefError([_error("frontmatter", "the frontmatter has no closing '---' line", 1)])

    meta = _Located(line=1)
    for i in range(1, close):
        line, lineno = lines[i], i + 1
        if not line.strip():
            continue
        match = KEY_RE.fullmatch(line)
        if not match:
            diags.append(_error("frontmatter", "expected 'key: value' in the frontmatter", lineno))
            continue
        key, value = match.group(1), match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key in meta:
            diags.append(_error("key-duplicate", f"frontmatter key '{key}' appears twice", lineno))
            continue
        if not value:
            diags.append(_error("value-empty", f"frontmatter key '{key}' has no value; omit empty optional keys", lineno))
            continue
        meta[key] = value
        meta.key_lines[key] = lineno

    if meta.get("schema") != SCHEMA:
        found = meta.get("schema")
        message = (
            f"unsupported schema '{found}'; this parser reads '{SCHEMA}' only"
            if found else f"the frontmatter needs 'schema: {SCHEMA}'"
        )
        raise BriefError(_sorted(diags + [_error("schema-unsupported", message, _line(meta, "schema"))]))

    if "stale_after_days" in meta:
        raw = meta["stale_after_days"]
        if re.fullmatch(r"[0-9]+", raw):
            meta["stale_after_days"] = int(raw)
        else:
            diags.append(_error("value-int", "stale_after_days must be a whole number of days", _line(meta, "stale_after_days")))
            meta["stale_after_days"] = DEFAULT_STALE_AFTER_DAYS
    else:
        meta["stale_after_days"] = DEFAULT_STALE_AFTER_DAYS

    title = None
    title_line = None
    section = None  # index into SECTIONS, or None
    in_unknown_section = False
    last_index = -1
    seen = {}
    records = {key: [] for _, _, key in RECORDS}
    notes = {}
    para = []
    para_start = None
    outside_reported = set()

    def flush():
        nonlocal para, para_start
        if para:
            if section is None:
                if not in_unknown_section:
                    diags.append(_error(
                        "outside-section",
                        "text must sit inside a '## ' section; move this note into a section",
                        para_start,
                    ))
            else:
                notes.setdefault(SECTIONS[section][0], []).append("\n".join(para))
        para, para_start = [], None

    i = close + 1
    n = len(lines)
    while i < n:
        line, lineno = lines[i], i + 1
        if line.startswith("```"):
            flush()
            info = line[3:].strip()
            end = i + 1
            while end < n and not lines[end].startswith("```") and not lines[end].startswith("## "):
                end += 1
            closed = end < n and lines[end].rstrip() == "```"
            if not closed:
                diags.append(_error("fence-unclosed", "this record has no closing ``` line", lineno))
            record = _parse_record(lines, i + 1, end, lineno, info, diags)
            if section is None:
                if not in_unknown_section:
                    diags.append(_error("outside-section", "records must sit inside a '## ' section", lineno))
            else:
                heading = SECTIONS[section][0]
                types = SECTION_TYPES[heading]
                names = " or ".join(f"'{t}'" for t in types)
                if not info:
                    diags.append(_error("record-type", f"the fence needs a record type; section '{heading}' holds {names} records", lineno))
                elif info not in types:
                    diags.append(_error("record-type", f"section '{heading}' holds {names} records, not '{info}'", lineno))
                else:
                    records[types[info]].append(record)
            i = end + 1 if closed else end
            continue
        if line.startswith("## "):
            flush()
            heading = line[3:].strip()
            if title is None:
                diags.append(_error("title", "the '# Title' line must come before the first section", lineno))
                title = ""
            if heading not in HEADINGS:
                diags.append(_error("heading-unknown", f"unknown section heading '## {heading}'", lineno))
                section, in_unknown_section = None, True
            elif heading in seen:
                diags.append(_error("heading-duplicate", f"section '## {heading}' already started on line {seen[heading]}", lineno))
                section, in_unknown_section = HEADINGS.index(heading), False
            else:
                index = HEADINGS.index(heading)
                if index < last_index:
                    diags.append(_error(
                        "heading-order",
                        f"section '## {heading}' must come before '## {HEADINGS[last_index]}'",
                        lineno,
                    ))
                seen[heading] = lineno
                last_index = max(last_index, index)
                section, in_unknown_section = index, False
            i += 1
            continue
        if line.startswith("# "):
            flush()
            if title is not None:
                diags.append(_error("title", "the document has more than one '# ' title", lineno))
            else:
                title = line[2:].strip()
                title_line = lineno
                if not title:
                    diags.append(_error("title", "the title is empty", lineno))
            i += 1
            continue
        if not line.strip():
            flush()
            i += 1
            continue
        if para_start is None:
            para_start = lineno
        para.append(line)
        i += 1
    flush()

    if title is None:
        diags.append(_error("title", "the document needs a '# Title' line after the frontmatter", close + 1))
    for heading in HEADINGS:
        if heading not in seen:
            diags.append(_error("heading-missing", f"section '## {heading}' is missing", None))
    positions = records["position"]
    if "Where things stand" in seen and len(positions) != 1:
        where = positions[1].line if len(positions) > 1 else seen["Where things stand"]
        diags.append(_error("count", f"'## Where things stand' needs exactly 1 position record, found {len(positions)}", where))

    if diags:
        raise BriefError(_sorted(diags))

    model = _Located(line=1)
    model["meta"] = meta
    model["title"] = title
    model["position"] = positions[0]
    for _, rtype, key in RECORDS:
        if rtype != "position":
            model[key] = records[key]
    model["notes"] = notes
    model.key_lines["title"] = title_line
    for heading, _, key in RECORDS:
        model.key_lines[key] = seen.get(heading)
    return model


def _read_block(lines, i, end, diags):
    """Read the lines of a ``key: |`` block value. Return (value, next index).

    Block lines carry a two-space indent that the value does not keep. Blank lines
    inside are kept. Leading and trailing blank lines and trailing spaces are dropped.
    A non-empty line without the indent is an error: the block runs to the closing fence.
    """
    body = []
    while i < end:
        line = lines[i]
        if line.startswith("  "):
            body.append(line[2:].rstrip())
        elif not line.strip():
            body.append("")
        else:
            diags.append(_error(
                "block-indent",
                "bad indentation inside a record: indent every line of a '|' block value by two spaces; "
                "the block runs to the closing fence, so put the block field last",
                i + 1,
            ))
            return None, end
        i += 1
    while body and not body[-1]:
        body.pop()
    while body and not body[0]:
        body.pop(0)
    return "\n".join(body), i


def _parse_record(lines, start, end, fence_line, rtype, diags):
    record = _Located(line=fence_line)
    spec = field_spec(rtype) if rtype in FIELDS else {}
    list_key = None
    i = start
    while i < end:
        line, lineno = lines[i], i + 1
        i += 1
        if not line.strip():
            continue
        item = ITEM_RE.fullmatch(line)
        if item:
            if list_key is None:
                diags.append(_error("record-syntax", "a list item must follow a 'key:' line", lineno))
                continue
            value = item.group(1).strip()
            if not value:
                diags.append(_error("value-empty", f"list '{list_key}' has an empty item", lineno))
                continue
            record[list_key].append(value)
            record.item_lines.setdefault(list_key, []).append(lineno)
            continue
        match = KEY_RE.fullmatch(line)
        if not match:
            diags.append(_error("record-syntax", "expected 'key: value', 'key:' or '  - item'", lineno))
            list_key = None
            continue
        key, value = match.group(1), match.group(2).strip()
        block = None
        if value == "|":
            block, i = _read_block(lines, i, end, diags)
        if key in record:
            diags.append(_error("key-duplicate", f"key '{key}' appears twice in this record", lineno))
            list_key = None
            continue
        record.key_lines[key] = lineno
        if value == "|":
            list_key = None
            if rtype in FIELDS and spec.get(key, (None, None))[1] != BLOCK:
                diags.append(_error(
                    "block-field",
                    f"'{key}' cannot take a '|' block value; only 'text' in a handoff record can. Write '{key}: value' on one line",
                    lineno,
                ))
            elif block is not None and not block:
                diags.append(_error("value-empty", f"the block value of '{key}' is empty", lineno))
            elif block:
                record[key] = block
            continue
        if value:
            record[key] = value
            list_key = None
        else:
            record[key] = []
            list_key = key
    for key in list(record):
        if record[key] == []:
            diags.append(_error("value-empty", f"key '{key}' has no value; omit empty optional fields", record.key_lines[key]))
            del record[key]
        elif spec.get(key, (None, None))[1] == INT and isinstance(record[key], str):
            if re.fullmatch(r"[0-9]+", record[key]):
                record[key] = int(record[key])
            else:
                diags.append(_error("value-int", f"'{key}' must be a whole number", record.key_lines[key]))
    return record


# ---------------------------------------------------------------- validation


def validate(model, *, now=None):
    """Check a model for meaning. Return a list of Diagnostic (errors and warnings).

    ``now`` is an optional UTC ISO string (``YYYY-MM-DDTHH:MM:SSZ``). Only then does
    the validator report snapshot age. Rendering never reads the clock.
    """
    now_dt = None
    if now is not None:
        now_dt = parse_utc(now)
        if now_dt is None:
            raise ValueError("now must look like 2030-01-23T06:00:00Z")
    return _sorted(_Validator(model, now_dt).run())


class _Validator:
    def __init__(self, model, now):
        self.model = model
        self.now = now
        self.diags = []
        self.ids = {}

    def err(self, code, message, line=None):
        self.diags.append(_error(code, message, line))

    def warn(self, code, message, line=None):
        self.diags.append(_warning(code, message, line))

    def run(self):
        m = self.model
        if not isinstance(m, dict):
            self.err("model-shape", "the model must be a dict")
            return self.diags
        for key in ("meta", "title", "position") + tuple(k for _, t, k in RECORDS if t != "position"):
            if key not in m:
                self.err("model-shape", f"the model has no '{key}'")
        if self.diags:
            return self.diags
        if not isinstance(m["meta"], dict) or not isinstance(m["position"], dict):
            self.err("model-shape", "'meta' and 'position' must be dicts")
            return self.diags
        for _, rtype, key in RECORDS:
            if rtype != "position" and not isinstance(m[key], list):
                self.err("model-shape", f"'{key}' must be a list")
        if self.diags:
            return self.diags

        self.check_meta(m["meta"])
        self.check_text(m["title"], "title", _line(m, "title"))
        for heading, rtype, key in RECORDS:
            records = [m[key]] if rtype == "position" else m[key]
            for record in records:
                self.check_record(rtype, record)
        self.check_references()
        self.check_counts()
        self.check_handoffs()
        self.check_budget()
        self.check_notes(m.get("notes", {}))
        self.check_consistency()
        if self.now is not None:
            self.check_age()
        return self.diags

    def check_text(self, value, name, line):
        if not isinstance(value, str):
            self.err("value-type", f"'{name}' must be text", line)
            return False
        if not value.strip():
            self.err("value-empty", f"'{name}' is empty; omit empty optional fields", line)
            return False
        if value != value.strip() or CONTROL_RE.search(value):
            self.err("value-format", f"'{name}' must be one line without leading or trailing spaces", line)
            return False
        return True

    def check_block(self, value, name, line):
        """A block value: text with line breaks, no blank edges, no trailing spaces."""
        if not isinstance(value, str):
            self.err("value-type", f"'{name}' must be text", line)
            return False
        if not value.strip():
            self.err("value-empty", f"'{name}' is empty", line)
            return False
        rows = value.split("\n")
        if value != value.strip() or any(r != r.rstrip() for r in rows) or CONTROL_RE.search(value.replace("\n", "")):
            self.err(
                "value-format",
                f"'{name}' must not start or end with spaces or blank lines, and no line may end with spaces or hold a control character",
                line,
            )
            return False
        return True

    def check_meta(self, meta):
        for key, required in META_FIELDS:
            if required and key not in meta:
                self.err("key-missing", f"the frontmatter needs '{key}'", _line(meta))
        for key in meta:
            if key not in META_KEYS:
                self.err("key-unknown", f"unknown frontmatter key '{key}'", _line(meta, key))
        for key, value in meta.items():
            if key == "stale_after_days" or key not in META_KEYS:
                continue
            self.check_text(value, key, _line(meta, key))
        if meta.get("schema") not in (None, SCHEMA):
            self.err("schema-unsupported", f"unsupported schema '{meta.get('schema')}'", _line(meta, "schema"))
        if isinstance(meta.get("repo"), str) and not REPO_RE.fullmatch(meta["repo"]):
            self.err("value-format", "'repo' must look like owner/name", _line(meta, "repo"))
        if isinstance(meta.get("repo_url"), str) and not is_safe_https(meta["repo_url"]):
            self.err("url-unsafe", "'repo_url' must be a credential-free https:// URL", _line(meta, "repo_url"))
        for key in ("snapshot", "evidence_checked", "previous_snapshot"):
            if isinstance(meta.get(key), str) and parse_utc(meta[key]) is None:
                self.err("date-format", f"'{key}' must be UTC like 2030-01-23T06:00:00Z", _line(meta, key))
        if isinstance(meta.get("synthesis"), str) and meta["synthesis"] not in SYNTHESIS:
            self.err("enum", f"'synthesis' must be one of: {', '.join(SYNTHESIS)}", _line(meta, "synthesis"))
        days = meta.get("stale_after_days", DEFAULT_STALE_AFTER_DAYS)
        if isinstance(days, bool) or not isinstance(days, int) or days < 1:
            self.err("value-int", "'stale_after_days' must be a whole number of at least 1", _line(meta, "stale_after_days"))
        snap = parse_utc(meta.get("snapshot"))
        prev = parse_utc(meta.get("previous_snapshot"))
        checked = parse_utc(meta.get("evidence_checked"))
        if snap and prev and prev >= snap:
            self.warn("time-order", "'previous_snapshot' is not earlier than 'snapshot'", _line(meta, "previous_snapshot"))
        if snap and checked and checked > snap:
            self.warn("time-order", "'evidence_checked' is later than 'snapshot'; refresh the snapshot time", _line(meta, "evidence_checked"))

    def check_record(self, rtype, record):
        where = f"{rtype} record"
        if not isinstance(record, dict):
            self.err("model-shape", f"a {where} must be a dict")
            return
        spec = field_spec(rtype)
        rid = record.get("id")
        if isinstance(rid, str):
            where = f"{rtype} '{rid}'"
        for key, (required, _) in spec.items():
            if required and key not in record:
                self.err("key-missing", f"{where} needs '{key}'", _line(record))
        for key, value in record.items():
            line = _line(record, key)
            if key not in spec:
                hint = " (renamed to 'requester')" if key == "owner" else ""
                self.err("key-unknown", f"{where} has unknown key '{key}'{hint}", line)
                continue
            kind = spec[key][1]
            if kind == LIST:
                if not isinstance(value, list):
                    self.err("value-type", f"'{key}' in {where} must be a list of '  - item' lines", line)
                    continue
                if not value:
                    self.err("value-empty", f"'{key}' in {where} is an empty list; omit it", line)
                for index, item in enumerate(value):
                    self.check_text(item, key, _line(record, key, index))
            elif kind == INT:
                if isinstance(value, bool) or not isinstance(value, int):
                    self.err("value-int", f"'{key}' in {where} must be a whole number", line)
            elif kind == BLOCK:
                if isinstance(value, list):
                    self.err("value-type", f"'{key}' in {where} must be text, not a list", line)
                    continue
                if not self.check_block(value, key, line):
                    continue
                limit = WORD_LIMITS.get((rtype, key))
                if limit and words(value) > limit:
                    self.err("words", f"'{key}' in {where} has {words(value)} words; the limit is {limit}", line)
            else:
                if isinstance(value, list):
                    self.err("value-type", f"'{key}' in {where} must be a single value, not a list", line)
                    continue
                if not self.check_text(value, key, line):
                    continue
                allowed = ENUMS.get((rtype, key))
                if allowed and value not in allowed:
                    self.err("enum", f"'{key}' in {where} must be one of: {', '.join(allowed)}; found '{value}'", line)
                if (rtype, key) in DATE_FIELDS and parse_utc(value) is None:
                    self.err("date-format", f"'{key}' in {where} must be UTC like 2030-01-23T06:00:00Z", line)
                limit = WORD_LIMITS.get((rtype, key))
                if limit and words(value) > limit:
                    self.err("words", f"'{key}' in {where} has {words(value)} words; the limit is {limit}", line)
        if isinstance(rid, str):
            if not ID_RE.fullmatch(rid):
                self.err("id-format", f"id '{rid}' must match [a-z0-9][a-z0-9-]{{0,63}}", _line(record, "id"))
            elif rid in self.ids:
                self.err("id-duplicate", f"id '{rid}' is already used by a {self.ids[rid]} record", _line(record, "id"))
            else:
                self.ids[rid] = rtype
        if rtype == "issue" and isinstance(record.get("url"), str) and not is_safe_https(record["url"]):
            self.err("url-unsafe", f"'url' in {where} must be a credential-free https:// URL", _line(record, "url"))
        if rtype == "evidence" and isinstance(record.get("ref"), str):
            problem = ref_problem(record["ref"])
            if problem:
                self.err("url-unsafe", f"'ref' in {where}: {problem}", _line(record, "ref"))
        if rtype == "active" and isinstance(record.get("priority"), int) and not isinstance(record["priority"], bool):
            if not 1 <= record["priority"] <= 3:
                self.err("priority", f"'priority' in {where} must be 1, 2 or 3", _line(record, "priority"))

    def check_references(self):
        m = self.model
        evidence_ids = {e.get("id") for e in m["evidence"] if isinstance(e, dict)}
        issue_ids = {e.get("id") for e in m["issues"] if isinstance(e, dict)}
        for _, rtype, key in RECORDS:
            records = [m[key]] if rtype == "position" else m[key]
            for record in records:
                if not isinstance(record, dict):
                    continue
                for field in ("evidence", "read_first"):
                    if (rtype, field) not in EVIDENCE_LISTS or not isinstance(record.get(field), list):
                        continue
                    for index, ref in enumerate(record[field]):
                        if ref not in evidence_ids:
                            self.err(
                                "evidence-unresolved",
                                f"'{field}' in {rtype} '{record.get('id')}' names '{ref}', but no evidence record has that id",
                                _line(record, field, index),
                            )
                if rtype == "path" and isinstance(record.get("issues"), list):
                    for index, ref in enumerate(record["issues"]):
                        if ref not in issue_ids and not (isinstance(ref, str) and ISSUE_REF_RE.fullmatch(ref)):
                            self.err(
                                "issue-unresolved",
                                f"'issues' in path '{record.get('id')}' names '{ref}'; use an issue record id or '#<number>'",
                                _line(record, "issues", index),
                            )

    def check_counts(self):
        m = self.model
        for key, limit in (("changes", 3), ("active", 3)):
            if len(m[key]) > limit:
                self.err("count", f"'{key}' holds {len(m[key])} records; the limit is {limit}", _line(m[key][limit]))
        if not m["gates"]:
            self.err("count", "'## Approval boundaries' needs at least 1 gate record", _line(m, "gates"))
        for role, limit in (("recommended", 1), ("alternative", 2)):
            found = [p for p in m["paths"] if isinstance(p, dict) and p.get("role") == role]
            if len(found) > limit:
                self.err("count", f"{len(found)} paths have role '{role}'; the limit is {limit}", _line(found[limit]))
        priorities = {}
        for record in m["active"]:
            if not isinstance(record, dict):
                continue
            value = record.get("priority")
            if isinstance(value, int) and not isinstance(value, bool):
                if value in priorities:
                    self.err("priority", f"priority {value} is used twice in '## Still active'", _line(record, "priority"))
                priorities[value] = record

    def check_handoffs(self):
        """One handoff for the recommended path; none without a recommended path."""
        m = self.model
        handoffs = [h for h in m["handoffs"] if isinstance(h, dict)]
        recommended = [p.get("id") for p in m["paths"] if isinstance(p, dict) and p.get("role") == "recommended"]
        if not recommended:
            for h in handoffs:
                self.err(
                    "handoff",
                    f"handoff '{h.get('id')}' has no recommended path to belong to; remove it or recommend a path",
                    _line(h),
                )
            return
        if not handoffs:
            self.err(
                "handoff",
                f"the recommended path '{recommended[0]}' needs one handoff record with the next-session prompt",
                _line(m, "paths"),
            )
            return
        if len(handoffs) > 1:
            self.err("handoff", f"'## Follow-up paths' holds {len(handoffs)} handoff records; keep exactly 1", _line(handoffs[1]))
        for h in handoffs:
            target = h.get("path")
            if isinstance(target, str) and target not in recommended:
                self.err(
                    "handoff",
                    f"handoff '{h.get('id')}' names path '{target}', but the recommended path is '{recommended[0]}'",
                    _line(h, "path"),
                )

    def check_budget(self):
        total = default_brief_word_count(self.model)
        line = _line(self.model, "position")
        if total > BUDGET_ERROR:
            self.err("budget", f"the default brief has {total} words; the limit is {BUDGET_ERROR}", line)
        elif total > BUDGET_WARN:
            self.warn("budget", f"the default brief has {total} words; aim for {BUDGET_WARN} or fewer", line)

    def check_notes(self, notes):
        if not isinstance(notes, dict):
            self.err("notes", "'notes' must map a section heading to a list of prose blocks")
            return
        for heading, blocks in notes.items():
            if heading not in HEADINGS:
                self.err("notes", f"notes name unknown section '{heading}'")
                continue
            if not isinstance(blocks, list) or not blocks:
                self.err("notes", f"notes for '{heading}' must be a non-empty list")
                continue
            for block in blocks:
                if not isinstance(block, str) or not block:
                    self.err("notes", f"a note in '{heading}' must be non-empty text")
                    continue
                for line in block.split("\n"):
                    if not line.strip() or line.startswith(("```", "# ", "## ")):
                        self.err("notes", f"a note in '{heading}' has a blank, heading or fence line; it would not survive a round trip")
                        break

    def check_consistency(self):
        for record in self.model["issues"]:
            if isinstance(record, dict) and record.get("state") == "closed" and record.get("progress") in ("not-started", "in-progress"):
                self.warn(
                    "issue-state",
                    f"issue '{record.get('id')}' is closed but its progress is '{record.get('progress')}'; record the conflict in '## Unknowns and conflicts'",
                    _line(record, "progress"),
                )

    def check_age(self):
        meta = self.model["meta"]
        days = meta.get("stale_after_days", DEFAULT_STALE_AFTER_DAYS)
        if not isinstance(days, int):
            return
        for key, code in (("snapshot", "stale"), ("evidence_checked", "stale-evidence")):
            when = parse_utc(meta.get(key))
            if when is None:
                continue
            age = self.now - when
            if age.total_seconds() < 0:
                self.warn("time-order", f"'{key}' is later than --now", _line(meta, key))
            elif age.days > days:
                self.warn(code, f"'{key}' is {age.days} days old; the brief is stale after {days} days", _line(meta, key))


# ---------------------------------------------------------------- dumping


def _meta_value(value):
    text = str(value)
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return '"' + text + '"'
    return text


def dump(model):
    """Serialize a model to canonical tracker-brief/1 Markdown.

    Field order follows the schema. Requester notes follow the records of their section.
    A handoff ``text`` is written as a ``text: |`` block with a two-space indent.
    For a valid model, parse(dump(model)) == model.
    """
    out = ["---"]
    meta = model["meta"]
    keys = [k for k in META_KEYS if k in meta] + [k for k in meta if k not in META_KEYS]
    for key in keys:
        if key == "stale_after_days" and meta[key] == DEFAULT_STALE_AFTER_DAYS:
            continue
        out.append(f"{key}: {_meta_value(meta[key])}")
    out += ["---", "", f"# {model['title']}", ""]
    notes = model.get("notes") or {}
    for heading in HEADINGS:
        out += [f"## {heading}", ""]
        for _, rtype, key in (r for r in RECORDS if r[0] == heading):
            records = [model[key]] if rtype == "position" else model.get(key, [])
            spec = field_spec(rtype)
            order = [name for name, _, _ in FIELDS[rtype]]
            for record in records:
                out.append("```" + rtype)
                fields = [k for k in order if k in record] + [k for k in record if k not in order]
                for field in fields:
                    value = record[field]
                    if isinstance(value, list):
                        out.append(f"{field}:")
                        out += [f"  - {item}" for item in value]
                    elif spec.get(field, (None, None))[1] == BLOCK:
                        out.append(f"{field}: |")
                        out += [f"  {row}" if row else "" for row in str(value).split("\n")]
                    else:
                        out.append(f"{field}: {value}")
                out += ["```", ""]
        for block in notes.get(heading, []):
            out += [block, ""]
    return "\n".join(out).rstrip("\n") + "\n"
