"""Canonical brief storage, pending queue and incremental record updates.

Storage adapters share one interface:

    read()  -> (text | None, revision | None)
    write(text, expected_revision) -> new revision

`write` raises ConflictError when the stored revision is not `expected_revision`
(read-before-write with a content hash), and StoreUnavailable when the backend
cannot be reached. A missing document has revision None.

When the canonical store is unavailable, the PendingQueue keeps the brief locally.
`sync` applies it later only if the canonical revision still equals the base
revision. Otherwise it reports a conflict and keeps both. Newer owner edits are
never overwritten.

The incremental update helpers work on the normalized model from tracker.brief.
They replace only the sections a synthesis step changed and keep owner prose
notes untouched. This module has no network code.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

from tracker.checkpoint import (atomic_write, format_utc, home_relative, one_line, read_json,
                                sha256_text, utc_now, write_json)

BRIEF_SCHEMA = "tracker-brief/1"
RECORD_TYPES = ("position", "change", "active", "issue", "gate", "unknown", "path", "handoff", "evidence")
SECTION_KEY = {"position": "position", "change": "changes", "active": "active", "issue": "issues",
               "gate": "gates", "unknown": "unknowns", "path": "paths", "handoff": "handoffs",
               "evidence": "evidence"}
# The only field that takes a `key: |` block value (two-space indented lines).
BLOCK_FIELDS = {("handoff", "text")}
LIST_FIELDS = {"evidence", "blockers", "issues", "depends", "prerequisites", "read_first",
               "needs_approval", "acceptance", "validate"}
INT_FIELDS = {"priority"}
# Sections a synthesis replaces wholesale when it emits at least one record of that type.
REPLACE_SECTIONS = ("active", "unknown")
# Sections merged record by record. Removal needs an explicit `retire` id, so a
# synthesis cannot drop an approval gate or an owner record by leaving it out.
MERGE_SECTIONS = ("issue", "gate", "evidence")
RETIRE_SECTIONS = ("issues", "gates", "evidence", "unknowns", "paths", "active")
_ROLE_ORDER = {"recommended": 0, "alternative": 1, "backlog": 2}


class StoreError(RuntimeError):
    pass


class StoreUnavailable(StoreError):
    pass


class ConflictError(StoreError):
    def __init__(self, expected: str | None, actual: str | None):
        self.expected = expected
        self.actual = actual
        super().__init__("canonical brief changed since it was read (expected revision %s, found %s)"
                         % (_short_rev(expected), _short_rev(actual)))


def _short_rev(revision: str | None) -> str:
    if not revision:
        return "absent"
    return revision.split(":", 1)[-1][:12]


def content_revision(text: str | None) -> str | None:
    if text is None:
        return None
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- adapters

class LocalFileStore:
    """Canonical brief as a Markdown file, for example inside the repo's `.okf/` bundle."""

    kind = "local-file"

    def __init__(self, path, *, root=None):
        self.path = Path(path)
        self.root = Path(root) if root else None

    @property
    def location(self) -> str:
        if self.root:
            try:
                return str(self.path.resolve().relative_to(self.root.resolve()))
            except ValueError:
                pass
        return home_relative(self.path)

    def status(self) -> dict:
        return {"backend": self.kind, "location": self.location, "available": True,
                "exists": self.path.is_file(), "write_verified": True}

    def read(self) -> tuple:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None, None
        except (IsADirectoryError, PermissionError, UnicodeDecodeError) as exc:
            raise StoreUnavailable("cannot read %s: %s" % (self.location, exc.__class__.__name__)) from exc
        return text, content_revision(text)

    def write(self, text: str, expected_revision: str | None) -> str:
        _, current = self.read()
        if current != expected_revision:
            raise ConflictError(expected_revision, current)
        mode = 0o644
        try:
            mode = self.path.stat().st_mode & 0o777
        except FileNotFoundError:
            pass
        try:
            atomic_write(self.path, text, mode)
        except PermissionError as exc:
            raise StoreUnavailable("cannot write %s: permission denied" % self.location) from exc
        return content_revision(text)


def _mcp_servers(path: Path) -> set:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    names = set()

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "mcpServers" and isinstance(value, dict):
                    names.update(value.keys())
                else:
                    walk(value)
    walk(data)
    return names


class OpenKnowledgeStore:
    """Detects OpenKnowledge. The read and write path is NOT verified and is not used.

    The tracker does not guess the OpenKnowledge page API. Detection reports what is
    installed. Every read or write raises StoreUnavailable with the reason, so the
    refresh keeps a pending brief locally. No verified adapter exists.
    """

    kind = "openknowledge"

    def __init__(self, *, project: str | None = None, page: str | None = None, which=shutil.which,
                 env=None, mcp_config_paths=None):
        self.project = project
        self.page = page or "tracker-brief"
        self.which = which
        self.env = os.environ if env is None else env
        if mcp_config_paths is None:
            home = Path(os.path.expanduser("~"))
            mcp_config_paths = [home / ".claude.json", home / ".pi" / "agent" / "mcp.json"]
        self.mcp_config_paths = [Path(p) for p in mcp_config_paths]

    @property
    def location(self) -> str:
        return "openknowledge:%s/%s" % (self.project or "(project not set)", self.page)

    def detect(self) -> dict:
        cli = self.env.get("TRACKER_OK_CLI") or self.which("ok")
        mcp = any("open-knowledge" in _mcp_servers(p) or "openknowledge" in _mcp_servers(p)
                  for p in self.mcp_config_paths)
        if cli:
            reason = ("the `ok` CLI was found at %s, but the tracker adapter for its page API is not "
                      "verified; use the local-file store or the OpenKnowledge MCP from the agent"
                      % home_relative(cli))
        elif mcp:
            reason = ("an open-knowledge MCP server is configured, but MCP tools run in the agent, "
                      "not in this script; use the local-file store")
        else:
            reason = "OpenKnowledge is not installed: no `ok` CLI and no open-knowledge MCP server"
        return {"backend": self.kind, "location": self.location, "available": False,
                "cli": home_relative(cli) if cli else None, "mcp_configured": mcp,
                "write_verified": False, "reason": reason}

    def status(self) -> dict:
        return self.detect()

    def read(self) -> tuple:
        raise StoreUnavailable(self.detect()["reason"])

    def write(self, text: str, expected_revision: str | None) -> str:
        raise StoreUnavailable(self.detect()["reason"])


# ---------------------------------------------------------------- pending queue and last-good copy

class PendingQueue:
    """Local pending brief kept while the canonical store is unavailable or in conflict."""

    def __init__(self, state_dir):
        self.dir = Path(state_dir) / "pending"
        self.meta_path = self.dir / "pending.json"
        self.text_path = self.dir / "brief.md"

    def load(self) -> dict | None:
        return read_json(self.meta_path)

    def text(self) -> str | None:
        try:
            return self.text_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def archive(self, label: str, now=None) -> Path | None:
        """Move the pending brief aside. Nothing is deleted."""
        if not self.meta_path.exists() and not self.text_path.exists():
            return None
        stamp = (now or utc_now()).strftime("%Y%m%dT%H%M%SZ")
        target = self.dir / ("%s-%s" % (label, stamp))
        suffix = 1
        while target.exists():
            suffix += 1
            target = self.dir / ("%s-%s-%d" % (label, stamp, suffix))
        target.mkdir(parents=True)
        for path in (self.meta_path, self.text_path):
            if path.exists():
                os.replace(path, target / path.name)
        return target

    def enqueue(self, text: str, *, base_revision: str | None, location: str, reason: str,
                conflict: bool = False, actual_revision: str | None = None, run_id: str | None = None,
                now=None) -> dict:
        now = now or utc_now()
        current = self.load()
        if current and current.get("sha256") != sha256_text(text):
            self.archive("superseded", now)
        info = {
            "created": format_utc(now), "run_id": run_id, "location": location,
            "base_revision": base_revision, "conflict": bool(conflict),
            "actual_revision": actual_revision, "reason": one_line(reason, 300),
            "sha256": sha256_text(text),
        }
        atomic_write(self.text_path, text)
        write_json(self.meta_path, info)
        return info

    def sync(self, store, now=None) -> dict:
        """Apply the pending brief when the canonical revision still equals its base."""
        now = now or utc_now()
        info = self.load()
        text = self.text()
        if not info or text is None:
            return {"result": "empty"}
        try:
            current, revision = store.read()
        except StoreUnavailable as exc:
            return {"result": "unavailable", "reason": str(exc)}
        if current == text:
            self.archive("synced", now)
            return {"result": "applied", "revision": revision, "note": "canonical already holds this brief"}
        if revision != info.get("base_revision"):
            info.update(conflict=True, actual_revision=revision,
                        reason="canonical brief changed after the pending brief was prepared")
            write_json(self.meta_path, info)
            return {"result": "conflict", "expected": info.get("base_revision"), "actual": revision}
        try:
            new_revision = store.write(text, revision)
        except ConflictError as exc:
            info.update(conflict=True, actual_revision=exc.actual, reason=str(exc))
            write_json(self.meta_path, info)
            return {"result": "conflict", "expected": exc.expected, "actual": exc.actual}
        except StoreUnavailable as exc:
            return {"result": "unavailable", "reason": str(exc)}
        self.archive("synced", now)
        return {"result": "applied", "revision": new_revision}


def store_brief(store, queue: PendingQueue, text: str, *, base_revision: str | None,
                run_id: str | None = None, now=None) -> dict:
    """Write the brief if the canonical revision is unchanged; queue it otherwise."""
    now = now or utc_now()
    location = store.location
    try:
        current, revision = store.read()
    except StoreUnavailable as exc:
        queue.enqueue(text, base_revision=base_revision, location=location, reason=str(exc),
                      run_id=run_id, now=now)
        return {"result": "pending", "reason": str(exc)}
    if current == text:
        return {"result": "unchanged", "revision": revision}
    if revision != base_revision:
        err = ConflictError(base_revision, revision)
        queue.enqueue(text, base_revision=base_revision, location=location, reason=str(err),
                      conflict=True, actual_revision=revision, run_id=run_id, now=now)
        return {"result": "conflict", "expected": base_revision, "actual": revision, "reason": str(err)}
    try:
        new_revision = store.write(text, base_revision)
    except ConflictError as exc:
        queue.enqueue(text, base_revision=base_revision, location=location, reason=str(exc),
                      conflict=True, actual_revision=exc.actual, run_id=run_id, now=now)
        return {"result": "conflict", "expected": exc.expected, "actual": exc.actual, "reason": str(exc)}
    except StoreUnavailable as exc:
        queue.enqueue(text, base_revision=base_revision, location=location, reason=str(exc),
                      run_id=run_id, now=now)
        return {"result": "pending", "reason": str(exc)}
    pending = queue.load()
    if pending and not pending.get("conflict"):
        queue.archive("superseded", now)
    return {"result": "stored", "revision": new_revision}


class LastGood:
    """The most recent validated brief and its HTML, kept in the state directory."""

    def __init__(self, state_dir):
        base = Path(state_dir)
        self.md_path = base / "last-good.md"
        self.html_path = base / "last-good.html"
        self.meta_path = base / "last-good.json"

    def load(self) -> dict | None:
        return read_json(self.meta_path)

    def text(self) -> str | None:
        try:
            return self.md_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    def save_brief(self, text: str, meta: dict) -> dict:
        if self.md_path.exists() and self.md_path.read_text(encoding="utf-8") != text:
            shutil.copyfile(self.md_path, self.md_path.with_name("last-good.prev.md"))
        atomic_write(self.md_path, text)
        info = dict(meta, sha256=sha256_text(text), html=None, stored_revision=None)
        write_json(self.meta_path, info)
        return info

    def save_html(self, html: str, brief_text: str) -> bool:
        info = self.load()
        if not info or info.get("sha256") != sha256_text(brief_text):
            return False
        atomic_write(self.html_path, html)
        info["html"] = self.html_path.name
        write_json(self.meta_path, info)
        return True

    def mark_stored(self, brief_text: str, revision: str | None) -> None:
        info = self.load()
        if info and info.get("sha256") == sha256_text(brief_text):
            info["stored_revision"] = revision
            write_json(self.meta_path, info)


# ---------------------------------------------------------------- frontmatter and record fragments

def read_frontmatter(text: str | None) -> dict:
    """Read the `key: value` frontmatter block without the full parser."""
    meta: dict = {}
    if not text:
        return meta
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return meta
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            meta[key.strip()] = value
    return meta


class FragmentError(ValueError):
    def __init__(self, errors: list):
        self.errors = errors
        super().__init__("; ".join("line %s: %s" % (line, msg) for line, msg in errors[:8]))


_FENCE_OPEN = re.compile(r"^```([A-Za-z][A-Za-z0-9_-]*)\s*$")
_KEY_LINE = re.compile(r"^([a-z_][a-z0-9_]*):(?:[ \t](.*))?$")
_LIST_LINE = re.compile(r"^  - (.*)$")


def _strip_wrapper(lines: list) -> tuple[list, int]:
    """Remove one outer ```markdown fence that some models add around the whole output."""
    first = next((i for i, line in enumerate(lines) if line.strip()), None)
    last = next((i for i in range(len(lines) - 1, -1, -1) if lines[i].strip()), None)
    if first is None or last is None or first == last:
        return lines, 0
    match = _FENCE_OPEN.match(lines[first].strip())
    if match and match.group(1).lower() in ("markdown", "md", "text") and lines[last].strip() == "```":
        return lines[first + 1:last], first + 1
    return lines, 0


def parse_fragment(text: str, *, strict: bool = True) -> dict:
    """Parse fenced records from Markdown. Prose outside fences is ignored.

    Returns {"records": [(type, record, line)], "retire": [ids]}. A `retire` block
    (`ids:` list) names records to remove from the registers. Raises FragmentError.
    With strict=False, fenced blocks of other types (owner code samples) are skipped.
    A handoff `text: |` block value keeps its line breaks; other fields cannot take one.
    """
    lines, offset = _strip_wrapper(text.splitlines()) if strict else (text.splitlines(), 0)
    records: list = []
    retire: list = []
    errors: list = []
    i = 0
    while i < len(lines):
        line = lines[i]
        match = _FENCE_OPEN.match(line.rstrip())
        if not match:
            i += 1
            continue
        rtype = match.group(1)
        start = i + 1 + offset
        if rtype not in RECORD_TYPES and rtype != "retire":
            if strict:
                errors.append((start, "unknown record type %r" % rtype))
            i += 1
            while i < len(lines) and lines[i].rstrip() != "```":
                i += 1
            i += 1
            continue
        record: dict = {}
        list_key = None
        i += 1
        closed = False
        while i < len(lines):
            body = lines[i].rstrip("\r")
            lineno = i + 1 + offset
            if body.rstrip() == "```":
                closed = True
                i += 1
                break
            i += 1
            if not body.strip():
                continue
            item = _LIST_LINE.match(body)
            if item and list_key:
                value = one_line(item.group(1))
                if value:
                    record[list_key].append(value)
                continue
            kv = _KEY_LINE.match(body)
            if not kv:
                errors.append((lineno, "cannot read record line %r" % one_line(body, 60)))
                continue
            key, value = kv.group(1), kv.group(2)
            if value is not None and value.strip() == "|":
                list_key = None
                block = []
                while i < len(lines) and lines[i].rstrip() != "```":
                    row = lines[i].rstrip("\r")
                    if row.startswith("  "):
                        block.append(row[2:].rstrip())
                    elif not row.strip():
                        block.append("")
                    else:
                        errors.append((i + 1 + offset, "bad indentation inside a record: indent block lines by two spaces"))
                        break
                    i += 1
                if (rtype, key) not in BLOCK_FIELDS:
                    errors.append((lineno, "%s cannot take a '|' block value" % key))
                elif key in record:
                    errors.append((lineno, "duplicate key %r" % key))
                else:
                    record[key] = "\n".join(block).strip("\n")
                    if not record[key]:
                        errors.append((lineno, "%s has an empty value" % key))
                continue
            if key in record:
                errors.append((lineno, "duplicate key %r" % key))
                continue
            if value is None or not value.strip():
                record[key] = []
                list_key = key
                continue
            list_key = None
            value = one_line(value)
            if key in INT_FIELDS:
                try:
                    record[key] = int(value)
                except ValueError:
                    errors.append((lineno, "%s must be an integer" % key))
                continue
            record[key] = value
        if not closed:
            errors.append((start, "record block is not closed"))
            break
        for key in [k for k, v in record.items() if v == []]:
            del record[key]
            if key not in LIST_FIELDS:
                errors.append((start, "%s has an empty value" % key))
        if rtype == "retire":
            retire.extend(record.get("ids") or [])
        else:
            records.append((rtype, record, start))
    if errors:
        raise FragmentError(errors)
    return {"records": records, "retire": retire}


def format_record(rtype: str, record: dict) -> str:
    lines = ["```" + rtype]
    for key, value in record.items():
        if isinstance(value, list):
            if value:
                lines.append(key + ":")
                lines.extend("  - " + one_line(v) for v in value)
        elif (rtype, key) in BLOCK_FIELDS and value:
            lines.append(key + ": |")
            lines.extend(("  " + row) if row else "" for row in str(value).split("\n"))
        elif value is not None and value != "":
            lines.append("%s: %s" % (key, one_line(value)))
    lines.append("```")
    return "\n".join(lines)


# ---------------------------------------------------------------- incremental update

def empty_model(meta: dict, title: str) -> dict:
    return {"meta": dict(meta), "title": title, "position": None, "changes": [], "active": [],
            "issues": [], "gates": [], "unknowns": [], "paths": [], "handoffs": [], "evidence": [], "notes": {}}


def all_ids(model: dict) -> set:
    ids = set()
    if model.get("position"):
        ids.add(model["position"].get("id"))
    for key in ("changes", "active", "issues", "gates", "unknowns", "paths", "handoffs", "evidence"):
        ids.update(r.get("id") for r in model.get(key) or [])
    ids.discard(None)
    return ids


def unique_id(candidate: str, used: set) -> str:
    candidate = re.sub(r"[^a-z0-9-]+", "-", candidate.lower()).strip("-")[:60] or "rec"
    value, n = candidate, 2
    while value in used:
        value = "%s-%d" % (candidate, n)
        n += 1
    used.add(value)
    return value


def merge_update(base: dict, fragment: dict) -> dict:
    """Apply synthesis records to a base model and return a new model.

    - `position`: replaced when present.
    - `change`: always replaced. "What changed" is relative to the previous snapshot,
      so old changes never carry into a new snapshot.
    - `active`, `unknown`: the section is replaced when the output holds at least one
      record of that type; otherwise it is kept unchanged.
    - `path`: emitted recommended or alternative paths replace the old recommended and
      alternative paths. Backlog paths merge by id, so owner backlog stays.
    - `issue`, `gate`, `evidence`: merged by id (replace or add).
    - `retire` ids are removed. This is the only way to drop a gate or a backlog path.
    - `handoff` records in the fragment are ignored. The base handoff is kept here;
      the refresh then rebuilds it with `tracker.handoff.refresh` (owner handoffs stay).
    - `notes` (owner prose) and `meta` are kept from the base unchanged.
    """
    model = copy.deepcopy(base)
    grouped: dict = {t: [] for t in RECORD_TYPES}
    for rtype, record, line in fragment.get("records", []):
        grouped[rtype].append((record, line))
    if len(grouped["position"]) > 1:
        raise FragmentError([(grouped["position"][1][1], "more than one position record")])
    if grouped["position"]:
        model["position"] = copy.deepcopy(grouped["position"][0][0])
    model["changes"] = [copy.deepcopy(r) for r, _ in grouped["change"]]
    for rtype in REPLACE_SECTIONS:
        if grouped[rtype]:
            model[SECTION_KEY[rtype]] = [copy.deepcopy(r) for r, _ in grouped[rtype]]
    if grouped["path"]:
        emitted = [copy.deepcopy(r) for r, _ in grouped["path"]]
        leading = any(r.get("role") in ("recommended", "alternative") for r in emitted)
        pending = {r.get("id"): r for r in emitted}
        paths = []
        for old in model["paths"]:
            if old.get("id") in pending:
                paths.append(pending.pop(old["id"]))  # same id: replaced in place
            elif old.get("role") == "backlog" or not leading:
                paths.append(old)
        paths += [r for r in emitted if r.get("id") in pending]
        model["paths"] = sorted(paths, key=lambda p: _ROLE_ORDER.get(p.get("role"), 3))
    for rtype in MERGE_SECTIONS:
        key = SECTION_KEY[rtype]
        index = {r.get("id"): n for n, r in enumerate(model[key])}
        for record, _ in grouped[rtype]:
            if record.get("id") in index:
                model[key][index[record["id"]]] = copy.deepcopy(record)
            else:
                index[record.get("id")] = len(model[key])
                model[key].append(copy.deepcopy(record))
    retire = set(fragment.get("retire") or [])
    if retire:
        for key in RETIRE_SECTIONS:
            model[key] = [r for r in model[key] if r.get("id") not in retire]
    return model


_ISSUE_URL = re.compile(r"/issues/(\d+)/?$")
_ISSUE_ID = re.compile(r"^(?:issue|iss)-(\d+)$")


def issue_number(record: dict) -> int | None:
    match = _ISSUE_URL.search(record.get("url") or "")
    if match:
        return int(match.group(1))
    match = _ISSUE_ID.match(record.get("id") or "")
    return int(match.group(1)) if match else None


def apply_issue_facts(model: dict, issues: dict) -> dict:
    """Overlay exact tracker facts on the issue register.

    Title, state, URL and checked time come from the tracker. Progress stays as the
    brief states it. New open issues are added with an explicit "not assessed" note.
    Closed issues without a record are only reported, never given invented progress.
    """
    summary = {"applied": False, "state_changed": [], "added": [], "untracked_closed": []}
    if not issues or issues.get("status") != "ok":
        return summary
    summary["applied"] = True
    by_number = {}
    for record in model["issues"]:
        number = issue_number(record)
        if number is not None:
            by_number.setdefault(number, record)
    used = all_ids(model)
    for item in sorted(issues.get("items") or [], key=lambda r: r["number"]):
        record = by_number.get(item["number"])
        if record is not None:
            if record.get("state") != item["state"]:
                summary["state_changed"].append(item["number"])
            record["state"] = item["state"]
            if item.get("title"):
                record["title"] = item["title"]
            if item.get("url"):
                record["url"] = item["url"]
            record["checked"] = item["checked"]
        elif item["state"] == "open" and item.get("url"):
            record = {"id": unique_id("issue-%d" % item["number"], used), "title": item["title"] or "#%d" % item["number"],
                      "state": "open", "progress": "not-started", "url": item["url"], "checked": item["checked"],
                      "note": "Progress not assessed; added from the issue tracker."}
            model["issues"].append(record)
            by_number[item["number"]] = record
            summary["added"].append(item["number"])
        elif item["state"] == "closed":
            summary["untracked_closed"].append(item["number"])
    return summary


def fact_evidence(facts: dict) -> dict:
    """Evidence records for commits and issues in the facts packet, keyed by id."""
    records = {}
    git = facts.get("git") or {}
    for commit in git.get("commits") or []:
        rid = "ev-commit-" + commit["short"]
        record = {"id": rid, "label": one_line("Commit %s: %s" % (commit["short"], commit["subject"]), 100),
                  "kind": "commit", "ref": commit.get("url") or commit["short"], "confidence": "verified",
                  "revision": commit["short"], "checked": git.get("checked")}
        records[rid] = {k: v for k, v in record.items() if v}
    issues = facts.get("issues") or {}
    for item in issues.get("items") or []:
        if not item.get("url"):
            continue
        rid = "ev-issue-%d" % item["number"]
        record = {"id": rid, "label": one_line("Issue #%d: %s" % (item["number"], item["title"]), 100),
                  "kind": "issue", "ref": item["url"], "confidence": "verified", "checked": item["checked"]}
        records[rid] = record
    if issues.get("status") == "ok" and issues.get("list_url"):
        records["ev-issues"] = {"id": "ev-issues", "label": "Issue tracker", "kind": "url",
                                "ref": issues["list_url"], "confidence": "verified", "checked": issues["checked"]}
    return records


def cited_ids(model: dict) -> set:
    ids = set()
    records = ([model["position"]] if model.get("position") else []) + [
        r for key in ("changes", "active", "issues", "gates", "unknowns", "paths") for r in model.get(key) or []]
    for record in records:
        ids.update(record.get("evidence") or [])
        ids.update(record.get("read_first") or [])
    return ids


def add_fact_evidence(model: dict, facts: dict) -> list:
    """Resolve cited fact ids (`ev-commit-*`, `ev-issue-*`, `ev-issues`) from the facts packet.

    A fact record replaces a same-id record, so links stay exact. Returns the added ids.
    """
    known = fact_evidence(facts)
    index = {r.get("id"): n for n, r in enumerate(model["evidence"])}
    added = []
    for rid in sorted(cited_ids(model)):
        if rid not in known:
            continue
        if rid in index:
            model["evidence"][index[rid]] = dict(known[rid])
        else:
            index[rid] = len(model["evidence"])
            model["evidence"].append(dict(known[rid]))
            added.append(rid)
    return added
