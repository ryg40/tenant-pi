"""The harvest code of herdr-idle-cleanup: parse, rank, model passes, handoff format and the index lock.

idle_cleanup.py imports this module for its subcommand `harvest`. Standard library only.
"""
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

import _common  # the herdr scripts folder is on sys.path (idle_cleanup.py puts it there)

# ---------------------------------------------------------------------------
# Compact report syntax 2 (section 6 of coordinator-skills/dummies/REPORT.md)
# ---------------------------------------------------------------------------
HANDOFF_VERSION = 1
INDEX_VERSION = 1
REPORT_LINE = re.compile(r"^\*\*REPORT [1-9][0-9]*(?: \((?:[2-9]|[1-9][0-9]+) turns\))?\*\* \S(?:.*\S)?$")
OUTCOME_LINE = re.compile(r"^\*\*OUTCOME\*\* \S(?:.*\S)?$")
ITEM_LINE = re.compile(r"^- \*\*\[([1-9][0-9]*)\]\*\* (Done|Failed|Unverified|Running|Blocked|Proposal|Needs approval"
                       r"|Retired): (\S(?:.*\S)?)$")
WARNING_LINE = re.compile(r"^\*\*Warning:\*\* (\S(?:.*\S)?)$")
NEXT_LINE = re.compile(r"^\*\*Next:\*\*$")
ACTION_LINE = re.compile(r"^- \*\*\[([a-z]+)\]\*\* (Agent|Owner decides|Owner)(?:, ([^:]+))?: (\S(?:.*\S)?)$")
NONE_LINE = re.compile(r"^\*\*Next:\*\* None\. (\S(?:.*\S)?)$")
FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})")
EMPTY_LINE = re.compile(r"^ *$")

# Words that make an entry P1 wherever they appear in its report text. Case-insensitive, whole words.
# A false match only raises the priority, the safe direction.
SECURITY_WORDS = ("security", "vulnerability", "vulnerabilities", "CVE", "exploit", "secret", "secrets",
                  "credential", "credentials", "password", "private key", "leak", "leaked", "exposed")
_SECURITY_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in SECURITY_WORDS) + r")\b", re.IGNORECASE)
P1_ITEM_STATES = ("Blocked", "Failed")
P2_ITEM_STATES = ("Unverified", "Needs approval")
OWNER_ACTORS = ("Owner", "Owner decides")
# The lines and characters of a reply with no valid block that become its report text.
NO_REPORT_LINES, NO_REPORT_CHARS = 12, 1500
# Seconds for one model call, and for all model passes of one harvest together.
MODEL_TIMEOUT, MODEL_BUDGET_SECONDS = 300, 900
LOCK_WAIT_SECONDS = 30

# The markers that rank a reply with no valid block (report state `no report`). The rank reads the whole
# reply with the same rules as a valid block, from these loose forms: an item marker (`- **[2]**`, `2.`)
# before a state word, an `Owner` or `Owner decides` actor before a colon, a `Warning:` line.
_STATE_WORDS = ("Done", "Failed", "Unverified", "Running", "Blocked", "Proposal", "Needs approval", "Retired")
_LOOSE_ITEM = re.compile(r"^[\s>]*(?:[-*+]\s+)?(?:\*\*)?\[?[0-9]+\]?[.)]?(?:\*\*)?\s+(?:\*\*)?("
                         + "|".join(_STATE_WORDS) + r")(?:\*\*)?\s*:", re.IGNORECASE)
_LOOSE_OWNER = re.compile(r"(?<![A-Za-z])(Owner decides|Owner)(?:\*\*)?(?:,([^:\n]+))?:")
_LOOSE_WARNING = re.compile(r"^[\s>]*(?:\*\*)?Warning:", re.IGNORECASE)
_LINE_BREAK = re.compile(r"\r\n|\r|\n")


def split_lines(text):
    """The lines of a text. Only \\n, \\r\\n and \\r end a line; U+2028 and other Unicode breaks do not."""
    return _LINE_BREAK.split(text) if text else []


def _readable_lines(text):
    """The lines that a program reads: each line outside a code fence that does not start with `>`."""
    out, close = [], None
    for line in split_lines(text):
        if close:
            if close.match(line):
                close = None
            continue
        fence = FENCE_OPEN.match(line)
        if fence:
            close = re.compile(r"^ {0,3}" + re.escape(fence.group(1)[0]) + "{" + str(len(fence.group(1))) + r",} *$")
            continue
        if not line.startswith(">"):
            out.append(line)
    return out


def _next_label(label):
    """Bijective base-26: a..z, aa..az, ba..zz, aaa."""
    for i in range(len(label) - 1, -1, -1):
        if label[i] != "z":
            return label[:i] + chr(ord(label[i]) + 1) + "a" * (len(label) - i - 1)
    return "a" * (len(label) + 1)


def parse_report(text):
    """The Dummies report block of a reply as a dict. `status` is `report` or `no report` (with `detail`)."""
    lines = _readable_lines(text or "")
    heads = [i for i, line in enumerate(lines) if REPORT_LINE.match(line) or OUTCOME_LINE.match(line)]
    if not heads:
        return {"status": "no report", "detail": "missing: no REPORT or OUTCOME line"}
    if len(heads) > 1:
        return {"status": "no report", "detail": "ambiguous: two report lines"}
    head = lines[heads[0]]
    items, warnings, actions, none_reason, block = [], [], [], None, [head]
    label, stage = "a", 0  # 0 items, 1 warnings, 2 next actions, 3 after the none line

    def bad(detail):
        return {"status": "no report", "detail": "ambiguous: " + detail}

    for line in lines[heads[0] + 1:]:
        if EMPTY_LINE.match(line):
            if stage == 2 and not actions:
                return bad("next line with no action below it")
            if stage >= 2:
                break
            block.append("")
            continue
        if stage == 3:
            return bad("line after the none line")
        block.append(line)
        m = NONE_LINE.match(line)
        if m:
            if stage == 2:
                return bad("second next line")
            stage, none_reason = 3, m.group(1)
            continue
        m = ITEM_LINE.match(line)
        if m:
            if stage > 0:
                return bad("item out of order")
            if m.group(1) != str(len(items) + 1):
                return bad("item numbers must start at 1 and increase by 1")
            items.append({"number": int(m.group(1)), "state": m.group(2), "text": m.group(3)})
            continue
        m = WARNING_LINE.match(line)
        if m:
            if stage > 1:
                return bad("warning out of order")
            warnings.append(m.group(1))
            stage = 1
            continue
        if NEXT_LINE.match(line):
            if stage == 2:
                return bad("second next line")
            stage = 2
            continue
        m = ACTION_LINE.match(line) if stage == 2 else None
        if m:
            if m.group(1) != label:
                return bad("action labels must start at a and follow base-26 order")
            actions.append({"label": m.group(1), "actor": m.group(2), "condition": m.group(3), "text": m.group(4)})
            label = _next_label(label)
            continue
        return bad("line in the block matches no pattern")
    if not items:
        return bad("no report items")
    if stage < 2:
        return {"status": "no report", "detail": "missing: no Next line"}
    if stage == 2 and not actions:
        return bad("next line with no action below it")
    while block and block[-1] == "":
        block.pop()
    return {"status": "report", "kind": "OUTCOME" if OUTCOME_LINE.match(head) else "REPORT", "headline": head,
            "items": items, "warnings": warnings, "next": {"none": none_reason} if stage == 3 else {"actions": actions},
            "text": "\n".join(block)}


def no_report_text(reply):
    """The first lines of a reply with no valid block, clipped."""
    lines = split_lines((reply or "").strip())[:NO_REPORT_LINES]
    text = "\n".join(lines)
    return text if len(text) <= NO_REPORT_CHARS else text[:NO_REPORT_CHARS] + " [...]"


def _rules(items, actions, has_warning, text):
    """(priority, rule) by the rank rules, or None when no P1 or P2 rule applies.

    `items` and `actions` carry a `ref` (`item 2`, `action b`, or `line 7` of an unparsed reply).
    """
    for it in items:
        if it["state"] in P1_ITEM_STATES:
            return "P1", f"item state: {it['ref']} is {it['state']}"
    word = _SECURITY_RE.search(text or "")
    if word:
        return "P1", f"security word: the text names '{word.group(1)}'"
    for a in actions:
        if a["actor"] in OWNER_ACTORS and not a.get("condition"):
            return "P1", f"owner action: {a['ref']} is for {a['actor']} with no condition and waits on the owner now"
    for it in items:
        if it["state"] == "Running":
            return "P2", f"running item: {it['ref']} is Running, and the pane stopped while work was running"
    for it in items:
        if it["state"] in P2_ITEM_STATES:
            return "P2", f"item state: {it['ref']} is {it['state']}"
    for a in actions:
        if a["actor"] in OWNER_ACTORS:
            return "P2", f"owner action: {a['ref']} is for {a['actor']} after a condition"
    if has_warning:
        return "P2", "warning: the text has a Warning line"
    return None


def unparsed_markers(reply):
    """(items, actions, has_warning) from the loose markers of the whole reply text."""
    items, actions, has_warning = [], [], False
    canon = {w.lower(): w for w in _STATE_WORDS}
    for n, line in enumerate(split_lines(reply or ""), 1):
        m = _LOOSE_ITEM.match(line)
        if m:
            items.append({"ref": f"line {n}", "state": canon[m.group(1).lower()]})
        for m in _LOOSE_OWNER.finditer(line):
            actions.append({"ref": f"line {n}", "actor": m.group(1), "condition": (m.group(2) or "").strip() or None})
        if _LOOSE_WARNING.match(line):
            has_warning = True
    return items, actions, has_warning


def rank(entry, reply=None):
    """(priority, reason) of an entry. The reason names the rule that set the priority.

    A `no report` entry is ranked from the markers of the whole reply; its parsed fields stay empty.
    """
    if entry.get("report_state") == "no report":
        found = _rules(*unparsed_markers(reply), reply) if reply else None
        detail = entry.get("parse_detail") or "no block"
        if found:
            return found[0], f"{found[0]} rule {found[1]} (read from the reply text: the block was not valid, {detail})"
        return "P3", f"P3 rule rest: the block was not valid ({detail}), and the reply text has no rank marker"
    items = [{"ref": f"item {it['number']}", "state": it["state"]} for it in entry.get("items") or []]
    actions = [{"ref": f"action {a['label']}", "actor": a["actor"], "condition": a.get("condition")}
               for a in (entry.get("next") or {}).get("actions") or []]
    found = _rules(items, actions, bool(entry.get("warnings")), entry.get("report_text"))
    if found:
        return found[0], f"{found[0]} rule {found[1]}"
    return "P3", "P3 rule rest: no P1 or P2 rule applies"


def clean_remote(url):
    """The remote URL without a user name or password."""
    if not url:
        return url
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        # A malformed URL: keep the scheme and the text after the last `@` of the authority, or no origin.
        m = re.match(r"^([A-Za-z][A-Za-z0-9+.-]*://)([^/]*)(.*)$", url, re.DOTALL)
        return (m.group(1) + m.group(2).rsplit("@", 1)[-1] + m.group(3)) if m else None
    if parts.scheme and parts.netloc:
        if "@" in parts.netloc:
            host = parts.netloc.rsplit("@", 1)[1]
            return urllib.parse.urlunsplit(parts._replace(netloc=host))
        return url
    m = re.match(r"^[^/@:]+@([^/:]+:.*)$", url)  # the scp form user@host:path
    return m.group(1) if m else url


def repo_key(cwd, top):
    """{top, origin, name} of the checkout of a pane. Read-only Git calls."""
    def git(*args):
        try:
            p = subprocess.run(["git", *args], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None

    if not top and cwd and os.path.isdir(cwd):
        top = git("-C", cwd, "rev-parse", "--show-toplevel")
    origin = clean_remote(git("-C", top, "config", "--get", "remote.origin.url")) if top else None
    name = None
    if origin:
        name = re.sub(r"\.git$", "", origin.rstrip("/").replace(":", "/").rsplit("/", 1)[-1]) or None
    if not name and top:
        name = os.path.basename(top.rstrip("/"))
    return {"top": top, "origin": origin, "name": name}


def final_reply(pane):
    """(reply_or_None, source) of an agent pane of scan.json. The fallback of last-reply.py for Pi panes."""
    path = pane.get("transcript")
    kind = "pi-session-file" if pane.get("activity_source") == "pi-session-file" else "transcript"
    if not (path and os.path.isfile(path)) and pane.get("agent") in _common.PI_AGENTS:
        path = _common.saved_pi_session({"pane_id": pane.get("pane_id"), "agent": pane.get("agent"),
                                         "name": pane.get("name"), "cwd": pane.get("cwd")})
        kind = "pi-session-file"
    if not (path and os.path.isfile(path)):
        return None, {"kind": "none", "path": None}
    texts = _common.assistant_texts(path)
    return (texts[-1] if texts else None), {"kind": kind, "path": path}


def entry_id(pane_id, reply):
    return hashlib.sha256(f"{pane_id}\0{reply or ''}".encode("utf-8")).hexdigest()[:16]


def harvest_entries(scan_data):
    """One entry for each agent pane of each `idle` workspace of scan.json."""
    entries = []
    for ws in scan_data.get("workspaces") or []:
        if ws.get("class") != "idle":
            continue
        for pane in ws.get("panes") or []:
            if not pane.get("agent"):
                continue
            reply, source = final_reply(pane)
            parsed = parse_report(reply)
            e = {"id": entry_id(pane.get("pane_id"), reply), "workspace": ws.get("workspace_id"),
                 "workspace_label": ws.get("label"), "pane": pane.get("pane_id"), "agent": pane.get("agent"),
                 "name": pane.get("name"), "cwd": pane.get("cwd"), "source": source,
                 "repo": repo_key(pane.get("cwd"), pane.get("git_top")), "report_state": parsed["status"]}
            if parsed["status"] == "report":
                e.update({"kind": parsed["kind"], "headline": parsed["headline"], "items": parsed["items"],
                          "warnings": parsed["warnings"], "next": parsed["next"], "report_text": parsed["text"]})
            else:
                e.update({"parse_detail": parsed["detail"], "headline": None, "items": [], "warnings": [],
                          "next": None, "report_text": no_report_text(reply) if reply else "(no assistant reply found)"})
            e["priority"], e["reason"] = rank(e, reply)
            e["_reply"] = reply  # for the model summary only; harvest() removes it before any write
            entries.append(e)
    entries.sort(key=lambda e: (e["priority"], e["workspace_label"] or e["workspace"] or "", e["pane"] or ""))
    return entries


# ---------------------------------------------------------------------------
# Optional model passes. The command comes from the setting model_command; the code names no model.
# ---------------------------------------------------------------------------
def model_deadline():
    """The monotonic time at which the model passes of one harvest stop."""
    return time.monotonic() + MODEL_BUDGET_SECONDS


def run_model(command, text, deadline=None):
    """The standard output of the model command, or None after a warning on standard error."""
    timeout = MODEL_TIMEOUT
    if deadline is not None:
        timeout = min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            print("warning: the time budget of the model passes is spent; the deterministic result stays",
                  file=sys.stderr)
            return None
    try:
        p = subprocess.run(command, input=text, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        print(f"warning: model_command failed ({e.__class__.__name__}); the deterministic result stays",
              file=sys.stderr)
        return None
    out = (p.stdout or "").strip()
    if p.returncode != 0 or not out:
        print(f"warning: model_command exited {p.returncode} with {'no ' if not out else ''}output; "
              "the deterministic result stays", file=sys.stderr)
        return None
    return out


def summarize(entries, command, deadline=None):
    for e in entries:
        if e["report_state"] != "no report":
            continue
        reply = e.get("_reply")
        if not reply:
            continue
        prompt = ("Summarize this final reply of a coding agent in at most three short sentences: what is done "
                  "and what is left. Reply with the summary only.\n\n" + _common.clip(reply or "", 6000, head=1500))
        out = run_model(command, prompt, deadline)
        if out:
            e["summary"] = {"by": "model", "text": out[:800]}


def model_rank(entries, command, deadline=None):
    """Order the entries within each priority by the model answer; keep the order when it is not usable."""
    for prio in ("P1", "P2", "P3"):
        group = [e for e in entries if e["priority"] == prio]
        if len(group) < 2:
            continue
        prompt = ("Order these handoff entries by how urgently the owner should follow up, most urgent first. "
                  "Reply with the ids only, one per line.\n\n"
                  + "\n".join(f"{e['id']} | {e['reason']} | {e['headline'] or e['report_text'][:200]}" for e in group))
        out = run_model(command, prompt, deadline)
        if not out:
            continue
        ids = [m.group(0) for m in re.finditer(r"\b[0-9a-f]{16}\b", out)]
        if sorted(ids) != sorted(e["id"] for e in group):
            print(f"warning: the model order of {prio} is not usable (ids missing or repeated); "
                  "the deterministic order stays", file=sys.stderr)
            continue
        for n, i in enumerate(ids, 1):
            next(e for e in group if e["id"] == i)["model_rank"] = n
    entries.sort(key=lambda e: (e["priority"], e.get("model_rank", 0)))


# ---------------------------------------------------------------------------
# Handoff files and index.json
# ---------------------------------------------------------------------------
def _fence(text):
    longest = max((len(m.group(0)) for m in re.finditer(r"~{3,}", text)), default=0)
    return "~" * max(4, longest + 1)


def format_handoff(stamp, created, scan_data, entries):
    counts = {p: sum(1 for e in entries if e["priority"] == p) for p in ("P1", "P2", "P3")}
    lines = [f"# Herdr idle handoff {stamp}", "",
             f"Harvest {created} from the scan of {scan_data.get('scanned_at')}. Entries: {len(entries)} "
             f"(P1 {counts['P1']}, P2 {counts['P2']}, P3 {counts['P3']}).",
             "Each report is a snapshot. Check the current state before you act on an entry.", "",
             "## Priority index", ""]
    for e in entries:
        title = e["headline"] or f"no report ({e.get('parse_detail')})"
        lines.append(f"- **{e['priority']}** {e['workspace_label'] or e['workspace']} / {e['pane']} ({e['agent']}): "
                     f"{title}. {e['reason']}. Id `{e['id']}`.")
    if not entries:
        lines.append("No agent pane of an idle workspace.")
    by_ws = {}
    for e in entries:
        by_ws.setdefault(e["workspace"], []).append(e)
    for ws_entries in by_ws.values():
        first = ws_entries[0]
        lines += ["", f"## Workspace {first['workspace_label'] or first['workspace']} ({first['workspace']})"]
        for e in ws_entries:
            repo = e["repo"]
            lines += ["", f"### Pane {e['pane']}", "",
                      f"- Agent: {e['agent']}" + (f" ({e['name']})" if e.get("name") else ""),
                      f"- Cwd: {e['cwd'] or '-'}",
                      f"- Source: {e['source']['kind']} {e['source']['path'] or ''}".rstrip(),
                      f"- Repository: {repo['name'] or '-'} ({repo['origin'] or 'no origin'}, {repo['top'] or 'no checkout'})",
                      f"- Priority: {e['priority']}. {e['reason']}",
                      f"- Report state: {e['report_state']}. Id: `{e['id']}`", ""]
            if e.get("summary"):
                lines += [f"Model summary (not the agent's words): {e['summary']['text']}", ""]
            fence = _fence(e["report_text"])
            lines += [fence + "text", e["report_text"], fence]
    return "\n".join(lines) + "\n"


class IndexLock:
    """The lock of index.json: a kernel lock (`flock`, exclusive) on the file `index.json.lock`.

    The kernel frees the lock when the holder ends, so a lock is never stale. The lock file stays in place.
    """

    def __init__(self, index_path):
        self.path = index_path + ".lock"
        self.fd = None

    def __enter__(self):
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    os.close(fd)
                    raise RuntimeError(f"index.json is locked by another process for {LOCK_WAIT_SECONDS} s: {self.path}")
                time.sleep(0.05)
        self.fd = fd
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)
        self.fd = None
        return False


def read_index(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"version": INDEX_VERSION, "entries": []}
    except (OSError, ValueError) as e:
        raise RuntimeError(f"index.json is not readable: {path}: {e}")
    if not isinstance(data, dict) or data.get("version") != INDEX_VERSION or not isinstance(data.get("entries"), list):
        raise RuntimeError(f"index.json has an unknown form or version: {path}")
    return data
