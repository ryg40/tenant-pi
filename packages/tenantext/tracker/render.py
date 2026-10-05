"""Render a tracker-brief/1 model to one self-contained HTML page.

Same model and template give the same bytes. The renderer reads no clock,
opens no network connection and runs no command. All text is escaped.
Only credential-free https:// URLs become links.
The next-session prompt is the stored ``handoff`` record. The renderer shows it
and never composes prompt text.
"""

from __future__ import annotations

from datetime import timedelta
from html import escape
from pathlib import Path

from .brief import (
    BriefError,
    is_safe_https,
    parse_utc,
    stored_handoff,
    validate,
)

DEFAULT_TEMPLATE = Path(__file__).resolve().parent / "assets" / "template.html"

STATE_LABELS = {
    "completed": "Done",
    "active": "Active",
    "blocked": "Blocked",
    "parked": "Parked",
    "approval-gated": "Needs approval",
}
READINESS_LABELS = {
    "ready-offline": "Ready offline",
    "needs-decision": "Needs decision",
    "approval-gated": "Approval-gated",
    "blocked": "Blocked",
    "parked": "Parked",
    "optional": "Optional",
}
PROGRESS_LABELS = {
    "not-started": "Not started",
    "in-progress": "In progress",
    "implemented": "Implemented",
    "merged": "Merged",
    "deployed": "Deployed",
    "validated": "Validated",
    "parked": "Parked",
    "abandoned": "Abandoned",
}
STATUS_LABELS = {
    "verified": "Verified",
    "reported": "Reported",
    "estimate": "Estimate",
    "proposal": "Proposal",
}
EVIDENCE_KIND_LABELS = {
    "issue": "Issue",
    "pr": "Pull request",
    "commit": "Commit",
    "okf": "OpenKnowledge page",
    "test": "Test report",
    "file": "Repository file",
    "url": "Web page",
    "note": "Note",
}
GATE_LABELS = {"approval": "Needs approval", "forbidden": "Forbidden", "allowed": "Allowed"}
GATE_GROUPS = (("approval", "Needs approval"), ("forbidden", "Forbidden"), ("allowed", "Allowed"))
UNKNOWN_LABELS = {
    "stale": "Stale",
    "missing": "Missing",
    "conflict": "Conflict",
    "inaccessible": "Inaccessible",
}
ROLE_LABELS = {"recommended": "Recommended", "alternative": "Alternative", "backlog": "Backlog"}
PATH_FIELD_LABELS = (
    ("objective", "Objective"),
    ("scope", "Scope"),
    ("authority", "Authority"),
    ("needs_approval", "Needs separate approval"),
    ("depends", "Depends on"),
    ("prerequisites", "Prerequisites"),
    ("acceptance", "Acceptance"),
    ("validate", "Validation commands (text only, never run by this page)"),
    ("output", "Expected output"),
    ("next_action", "Next action"),
    ("repo", "Repository"),
    ("cwd", "Working directory"),
    ("revision", "Revision"),
)
AUTHORITY_NOTE = "A suggested path is a proposal. It does not give permission to run it."
BASIS_LABELS = {"current": "Checked at this snapshot", "carried-forward": "Carried forward, not re-checked"}
SOURCE_LABELS = {"generated": "Generated from the brief", "owner": "Written by the owner"}


def _e(value):
    return escape(str(value), quote=True)


def readiness_state(readiness):
    """Map a readiness value to one of the five visual states."""
    return {"approval-gated": "approval-gated", "blocked": "blocked", "parked": "parked"}.get(readiness, "active")


def issue_visual_state(issue):
    """Map an issue record to a visual state. Tracker state stays separate."""
    progress, state = issue.get("progress"), issue.get("state")
    if progress in ("parked", "abandoned"):
        return "parked"
    if progress in ("deployed", "validated"):
        return "completed"
    if state == "closed":
        return "completed" if progress in ("implemented", "merged") else "parked"
    if issue.get("blockers"):
        return "blocked"
    return "active"


def _when(iso, date_only=False):
    dt = parse_utc(iso)
    if dt is None:
        return _e(iso)
    shown = dt.strftime("%Y-%m-%d") if date_only else dt.strftime("%Y-%m-%d %H:%M UTC")
    return f'<time datetime="{_e(iso)}">{_e(shown)}</time>'


def _issue_label(record_id):
    return "#" + record_id if record_id.isdigit() else record_id


def _state_chip(state):
    return f'<span class="tb-state" data-state="{_e(state)}">{_e(STATE_LABELS[state])}</span>'


def _badge(attr, value, label):
    return f'<span class="tb-badge" data-{attr}="{_e(value)}">{_e(label)}</span>'


class _Page:
    def __init__(self, model):
        self.m = model
        self.meta = model["meta"]
        self.evidence = {e["id"]: e for e in model["evidence"]}
        self.snapshot = parse_utc(self.meta["snapshot"])
        self.days = self.meta.get("stale_after_days", 7)

    # ------------------------------------------------------------ evidence

    def evidence_item(self, record, with_id=False):
        kind = record["kind"]
        attrs = f' data-kind="{_e(kind)}" data-confidence="{_e(record["confidence"])}"'
        stale = self.evidence_is_stale(record)
        if stale:
            attrs += ' data-stale="true"'
        if with_id:
            attrs = f' id="rec-{_e(record["id"])}"' + attrs
        ref = record["ref"]
        if is_safe_https(ref):
            head = f'<a class="tb-ev-link" href="{_e(ref)}" rel="noreferrer">{_e(record["label"])}</a>'
        else:
            head = (
                f'<span class="tb-ev-label">{_e(record["label"])}</span> '
                f'<span class="tb-ev-ref">{_e(EVIDENCE_KIND_LABELS[kind])}: <code>{_e(ref)}</code> (not a link)</span>'
            )
        facts = [_e(EVIDENCE_KIND_LABELS[kind]), _e(STATUS_LABELS[record["confidence"]])]
        if "revision" in record:
            facts.append("revision <code>" + _e(record["revision"]) + "</code>")
        if "checked" in record:
            facts.append("checked " + _when(record["checked"]))
        if stale:
            facts.append(f"older than {self.days} days at snapshot time")
        out = f'<li class="tb-ev"{attrs}>{head} <span class="tb-ev-meta">{" · ".join(facts)}</span>'
        if "note" in record:
            out += f' <span class="tb-ev-note">{_e(record["note"])}</span>'
        return out + "</li>"

    def evidence_is_stale(self, record):
        checked = parse_utc(record.get("checked"))
        return bool(checked and self.snapshot and self.snapshot - checked > timedelta(days=self.days))

    def evidence_list(self, ids):
        items = [self.evidence_item(self.evidence[i]) for i in ids if i in self.evidence]
        if not items:
            return '<p class="tb-ev-none">No evidence recorded for this item.</p>'
        return '<ul class="tb-ev-list">' + "".join(items) + "</ul>"

    def evidence_details(self, ids, extra=""):
        return (
            '<details class="tb-evidence"><summary>Evidence and details</summary>'
            + self.evidence_list(ids) + extra + "</details>"
        )

    # ------------------------------------------------------------ header

    def header(self):
        meta = self.meta
        synthesis = meta["synthesis"]
        rows = [
            ("repo", "Repository", f'<a href="{_e(meta["repo_url"])}" rel="noreferrer">{_e(meta["repo"])}</a>'),
            ("ref", "Ref", f'<code>{_e(meta["ref"])}</code>'),
            ("snapshot", "Snapshot", _when(meta["snapshot"])),
            ("evidence-checked", "Evidence checked", _when(meta["evidence_checked"])),
            (
                "previous-snapshot", "Previous snapshot",
                _when(meta["previous_snapshot"]) if "previous_snapshot" in meta else "None recorded",
            ),
            (
                "synthesis", "Synthesis",
                _badge("synthesis", synthesis, "Model synthesis" if synthesis == "model" else "Minimal: scripted facts only"),
            ),
        ]
        dl = "".join(
            f'<div class="tb-meta-row" data-meta="{key}"><dt>{label}</dt><dd>{value}</dd></div>'
            for key, label, value in rows
        )
        out = [
            f'<header class="tb-header" data-synthesis="{_e(synthesis)}">',
            '<p class="tb-eyebrow">Restart brief</p>',
            f'<h1 class="tb-title">{_e(self.m["title"])}</h1>',
            f'<p class="tb-scope">{_e(meta["scope"])}</p>',
            f'<dl class="tb-meta">{dl}</dl>',
        ]
        out += self.notices()
        out.append(
            '<nav class="tb-nav" aria-label="Full records">'
            '<a href="#tb-register">Issue register</a><a href="#tb-packets">Path packets</a>'
            '<a href="#tb-evidence-all">All evidence</a></nav>'
        )
        out.append("</header>")
        return "".join(out)

    def notices(self):
        out = []
        if self.meta["synthesis"] == "minimal":
            out.append(
                '<p class="tb-notice" data-notice="minimal">Minimal brief: scripted facts only. '
                "No new next step was inferred. Check any suggested path against current sources.</p>"
            )
        if self.snapshot:
            until = (self.snapshot + timedelta(days=self.days)).strftime("%Y-%m-%d")
            out.append(
                '<p class="tb-notice" data-notice="freshness">Static snapshot. This page does not update itself. '
                f'Treat it as stale after <time datetime="{_e(until)}">{_e(until)}</time>.</p>'
            )
        checked = parse_utc(self.meta["evidence_checked"])
        if checked and self.snapshot and self.snapshot - checked > timedelta(days=self.days):
            gap = (self.snapshot - checked).days
            out.append(
                f'<p class="tb-notice" data-notice="stale-evidence">Evidence was last checked {gap} days '
                "before this snapshot. Some facts can be out of date.</p>"
            )
        old = [
            i for i in self.m["issues"]
            if parse_utc(i["checked"]) and self.snapshot
            and self.snapshot - parse_utc(i["checked"]) > timedelta(days=self.days)
        ]
        if old:
            out.append(
                f'<p class="tb-notice" data-notice="stale-issues">{len(old)} issue records were checked more than '
                f"{self.days} days before this snapshot.</p>"
            )
        return out

    # ------------------------------------------------------------ attention

    def attention(self):
        items = []
        for gate in self.m["gates"]:
            if gate["kind"] == "approval":
                items.append(
                    f'<li class="tb-gate" data-kind="approval" data-state="approval-gated">'
                    f'<span class="tb-label">{_e(GATE_LABELS["approval"])}</span> '
                    f'<span class="tb-text">{_e(gate["text"])}</span>'
                    + (self.evidence_details(gate["evidence"]) if gate.get("evidence") else "")
                    + "</li>"
                )
        for unknown in self.m["unknowns"]:
            if unknown["severity"] == "critical":
                items.append(
                    f'<li class="tb-unknown" data-kind="{_e(unknown["kind"])}" data-severity="critical">'
                    f'<span class="tb-label">{_e(UNKNOWN_LABELS[unknown["kind"]])}</span> '
                    f'<span class="tb-text">{_e(unknown["text"])}</span>'
                    + (self.evidence_details(unknown["evidence"]) if unknown.get("evidence") else "")
                    + "</li>"
                )
        body = (
            '<ul class="tb-attention-list">' + "".join(items) + "</ul>"
            if items else '<p class="tb-empty-card">No approval gates or critical unknowns recorded.</p>'
        )
        return (
            '<section class="tb-attention" id="tb-attention" aria-labelledby="tb-attention-h">'
            '<h2 id="tb-attention-h">Approval gates and critical unknowns</h2>' + body + "</section>"
        )

    # ------------------------------------------------------------ cards

    @staticmethod
    def card(key, heading, inner):
        return (
            f'<section class="tb-card" id="tb-card-{key}" data-card="{key}" aria-labelledby="tb-card-{key}-h">'
            f'<h2 id="tb-card-{key}-h">{heading}</h2>{inner}</section>'
        )

    def position_card(self):
        p = self.m["position"]
        facts = [_badge("status", p["status"], STATUS_LABELS[p["status"]])]
        if "milestone" in p:
            facts.append(f'<span class="tb-milestone">Milestone: {_e(p["milestone"])}</span>')
        inner = (
            f'<div class="tb-item" id="rec-{_e(p["id"])}" data-record="position" data-status="{_e(p["status"])}">'
            f'<p class="tb-lead">{_e(p["text"])}</p>'
            f'<p class="tb-facts">{" ".join(facts)}</p>'
            + self.evidence_details(p.get("evidence", []))
            + "</div>"
        )
        return self.card("position", "Where things stand", inner)

    def changes_card(self):
        meta = self.meta
        since = (
            f'<p class="tb-since">Since the snapshot of {_when(meta["previous_snapshot"])}.</p>'
            if "previous_snapshot" in meta else '<p class="tb-since">No previous snapshot recorded.</p>'
        )
        items = []
        for c in self.m["changes"]:
            items.append(
                f'<li class="tb-item" id="rec-{_e(c["id"])}" data-record="change" data-state="completed" data-status="{_e(c["status"])}">'
                f'<h3 class="tb-item-title">{_e(c["title"])}</h3>'
                f'<p class="tb-item-text">{_e(c["summary"])}</p>'
                f'<p class="tb-facts">{_state_chip("completed")} {_badge("status", c["status"], STATUS_LABELS[c["status"]])}</p>'
                + self.evidence_details(c["evidence"])
                + "</li>"
            )
        body = (
            '<ol class="tb-items">' + "".join(items) + "</ol>"
            if items else '<p class="tb-empty-card">No completed changes recorded.</p>'
        )
        return self.card("changes", "What changed", since + body)

    def active_card(self):
        items = []
        for a in sorted(self.m["active"], key=lambda r: r["priority"]):
            state = readiness_state(a["readiness"])
            facts = [_state_chip(state), _badge("readiness", a["readiness"], READINESS_LABELS[a["readiness"]])]
            if "owner" in a:
                facts.append(f'<span class="tb-owner">Owner: {_e(a["owner"])}</span>')
            blocker = (
                f'<p class="tb-blocker"><span class="tb-key">Blocker:</span> {_e(a["blocker"])}</p>'
                if "blocker" in a else ""
            )
            items.append(
                f'<li class="tb-item" id="rec-{_e(a["id"])}" data-record="active" data-state="{state}" '
                f'data-readiness="{_e(a["readiness"])}" data-priority="{a["priority"]}">'
                f'<h3 class="tb-item-title">{_e(a["title"])}</h3>'
                f'<p class="tb-item-text"><span class="tb-key">Next:</span> {_e(a["next"])}</p>'
                + blocker
                + f'<p class="tb-facts">{" ".join(facts)}</p>'
                + self.evidence_details(a.get("evidence", []))
                + "</li>"
            )
        body = (
            '<ol class="tb-items">' + "".join(items) + "</ol>"
            if items else '<p class="tb-empty-card">No active work recorded.</p>'
        )
        return self.card("active", "Still active", body)

    def path_issue_text(self, path):
        return ", ".join(_issue_label(ref) for ref in path.get("issues", []))

    def path_fields(self, path):
        rows = []
        for key, label in PATH_FIELD_LABELS:
            if key not in path:
                continue
            value = path[key]
            if isinstance(value, list):
                if key == "validate":
                    shown = "<ul>" + "".join(f"<li><code>{_e(v)}</code></li>" for v in value) + "</ul>"
                else:
                    shown = "<ul>" + "".join(f"<li>{_e(v)}</li>" for v in value) + "</ul>"
            elif key in ("cwd", "revision"):
                shown = f"<code>{_e(value)}</code>"
            else:
                shown = _e(value)
            rows.append(f'<div class="tb-field" data-field="{key}"><dt>{label}</dt><dd>{shown}</dd></div>')
        if path.get("issues"):
            rows.append(f'<div class="tb-field" data-field="issues"><dt>Related issues</dt><dd>{_e(self.path_issue_text(path))}</dd></div>')
        return '<dl class="tb-fields">' + "".join(rows) + "</dl>"

    def path_attrs(self, path):
        return (
            f'data-record="path" data-role="{_e(path["role"])}" data-readiness="{_e(path["readiness"])}" '
            f'data-state="{readiness_state(path["readiness"])}"'
        )

    def next_card(self):
        paths = self.m["paths"]
        rec = [p for p in paths if p["role"] == "recommended"]
        alts = [p for p in paths if p["role"] == "alternative"]
        out = []
        if self.meta["synthesis"] == "minimal":
            out.append(
                '<p class="tb-notice" data-notice="minimal-paths">Minimal brief: these paths come from '
                "earlier sources and were not re-checked.</p>"
            )
        if rec:
            p = rec[0]
            state = readiness_state(p["readiness"])
            approval = ""
            if p.get("needs_approval"):
                approval = (
                    '<div class="tb-needs-approval"><p class="tb-key">Needs separate approval:</p><ul>'
                    + "".join(f"<li>{_e(v)}</li>" for v in p["needs_approval"]) + "</ul></div>"
                )
            facts = [_state_chip(state), _badge("readiness", p["readiness"], READINESS_LABELS[p["readiness"]])]
            if p.get("issues"):
                facts.append(f'<span class="tb-issues-ref">Issues: {_e(self.path_issue_text(p))}</span>')
            out.append(
                f'<div class="tb-path" id="rec-{_e(p["id"])}" {self.path_attrs(p)}>'
                '<p class="tb-role">Recommended next session</p>'
                f'<h3 class="tb-item-title">{_e(p["title"])}</h3>'
                f'<p class="tb-item-text">{_e(p["objective"])}</p>'
                f'<p class="tb-next-action"><span class="tb-key">Next action:</span> {_e(p["next_action"])}</p>'
                + approval
                + f'<p class="tb-facts">{" ".join(facts)}</p>'
                + self.evidence_details(p.get("read_first", []), self.path_fields(p))
                + "</div>"
            )
            out.append(self.handoff_block())
        else:
            out.append('<p class="tb-empty-card">No recommended path recorded.</p>')
        if alts:
            rows = "".join(
                f'<li class="tb-path tb-alt" id="rec-{_e(p["id"])}" {self.path_attrs(p)}>'
                f'{_state_chip(readiness_state(p["readiness"]))} '
                f'<a class="tb-path-title" href="#packet-{_e(p["id"])}">{_e(p["title"])}</a> '
                f'{_badge("readiness", p["readiness"], READINESS_LABELS[p["readiness"]])}</li>'
                for p in alts
            )
            out.append('<h3 class="tb-alt-h">Alternatives</h3><ul class="tb-alternatives">' + rows + "</ul>")
        out.append(f'<p class="tb-authority">{AUTHORITY_NOTE}</p>')
        return self.card("next", "Next session", "".join(out))

    def handoff_block(self):
        """The stored next-session prompt: copy button, status and a closed <details>."""
        h = stored_handoff(self.m)
        if h is None:
            return ""
        basis, source = h["basis"], h["source"]
        return (
            f'<div class="tb-next-prompt" data-basis="{_e(basis)}" data-source="{_e(source)}">'
            '<p class="tb-handoff-meta"><span class="tb-key">Prompt for the next session</span> '
            f'{_badge("basis", basis, BASIS_LABELS[basis])} {_badge("source", source, SOURCE_LABELS[source])} '
            f'<span class="tb-handoff-generated">As of {_when(h["generated"])}</span></p>'
            '<p class="tb-copy-row"><button type="button" class="tb-copy" data-copy-target="tb-handoff-text">'
            "Copy prompt for the next session</button> "
            '<span class="tb-copy-status" id="tb-copy-status" role="status" aria-live="polite"></span></p>'
            '<details class="tb-handoff"><summary>Show the prompt</summary>'
            f'<pre class="tb-handoff-text" id="tb-handoff-text">{_e(h["text"])}</pre></details>'
            "</div>"
        )

    # ------------------------------------------------------------ full records

    def register(self):
        issues = self.m["issues"]
        open_count = sum(1 for i in issues if i["state"] == "open")
        closed_count = len(issues) - open_count
        summary = f"Issue register: {len(issues)} issues, {open_count} open, {closed_count} closed"
        workstreams = sorted({i["workstream"] for i in issues if "workstream" in i})
        options = '<option value="*">All workstreams</option>' + "".join(
            f'<option value="{_e(w)}">{_e(w)}</option>' for w in workstreams
        )
        if any("workstream" not in i for i in issues):
            options += '<option value="">No workstream</option>'
        tools = (
            '<div class="tb-tools">'
            '<input id="tb-search" type="search" aria-label="Search issues" placeholder="Search issues or notes">'
            '<select id="tb-filter-state" aria-label="Tracker state"><option value="*">All states</option>'
            '<option value="open">Open</option><option value="closed">Closed</option></select>'
            f'<select id="tb-filter-workstream" aria-label="Workstream">{options}</select>'
            '<button id="tb-reset" type="button">Reset</button></div>'
        )
        ordered = [i for i in issues if i["state"] == "open"] + [i for i in issues if i["state"] != "open"]
        rows = []
        for i in ordered:
            detail = ""
            if "note" in i:
                detail += f'<div class="tb-issue-note">{_e(i["note"])}</div>'
            if i.get("blockers"):
                detail += f'<div class="tb-issue-blockers">Blocked by: {_e("; ".join(i["blockers"]))}</div>'
            rows.append(
                f'<tr class="tb-issue" id="rec-{_e(i["id"])}" data-issue-state="{_e(i["state"])}" '
                f'data-progress="{_e(i["progress"])}" data-workstream="{_e(i.get("workstream", ""))}" '
                f'data-state="{issue_visual_state(i)}">'
                f'<td class="tb-issue-id"><a href="{_e(i["url"])}" rel="noreferrer">{_e(_issue_label(i["id"]))}</a></td>'
                f'<td class="tb-issue-work"><div class="tb-issue-title">{_e(i["title"])}</div>{detail}</td>'
                f'<td class="tb-issue-state">{_badge("issue-state", i["state"], i["state"].capitalize())}</td>'
                f'<td class="tb-issue-progress">{_badge("progress", i["progress"], PROGRESS_LABELS[i["progress"]])}</td>'
                f'<td class="tb-issue-checked">{_when(i["checked"], date_only=True)}</td></tr>'
            )
        table = (
            '<div class="tb-table-wrap"><table class="tb-issues"><thead><tr>'
            '<th scope="col">Issue</th><th scope="col">Work</th><th scope="col">State</th>'
            '<th scope="col">Progress</th><th scope="col">Checked</th></tr></thead><tbody>'
            + "".join(rows) + "</tbody></table></div>"
        )
        count = f'<p id="tb-count" class="tb-count" aria-live="polite">{len(issues)} of {len(issues)} issues shown</p>'
        empty_hidden = " hidden" if issues else ""
        empty = f'<p id="tb-empty" class="tb-empty"{empty_hidden}>No matching issues.</p>'
        note = '<p class="tb-register-note">Tracker state (open or closed) is separate from progress. A closed issue does not prove deployment.</p>'
        return (
            f'<details class="tb-section" id="tb-register" data-section="issues"><summary>{_e(summary)}</summary>'
            + note + tools + count + table + empty + "</details>"
        )

    def compact_evidence(self, record):
        ids = record.get("evidence", [])
        if not ids:
            return ""
        return '<ul class="tb-ev-list">' + "".join(self.evidence_item(self.evidence[i]) for i in ids if i in self.evidence) + "</ul>"

    def all_gates(self):
        gates = self.m["gates"]
        groups = []
        for kind, label in GATE_GROUPS:
            members = [g for g in gates if g["kind"] == kind]
            if not members:
                continue
            items = "".join(
                f'<li class="tb-gate" id="rec-{_e(g["id"])}" data-kind="{_e(kind)}"'
                + (' data-state="approval-gated"' if kind == "approval" else "")
                + f'><span class="tb-text">{_e(g["text"])}</span>{self.compact_evidence(g)}</li>'
                for g in members
            )
            groups.append(f'<h3 class="tb-group-h" data-kind="{kind}">{label}</h3><ul class="tb-list">{items}</ul>')
        return (
            f'<details class="tb-section" id="tb-gates" data-section="gates">'
            f"<summary>All approval boundaries ({len(gates)})</summary>" + "".join(groups) + "</details>"
        )

    def all_unknowns(self):
        unknowns = self.m["unknowns"]
        if unknowns:
            items = "".join(
                f'<li class="tb-unknown" id="rec-{_e(u["id"])}" data-kind="{_e(u["kind"])}" data-severity="{_e(u["severity"])}">'
                f'<span class="tb-label">{_e(UNKNOWN_LABELS[u["kind"]])}</span> '
                f'<span class="tb-severity">{_e(u["severity"])}</span> '
                f'<span class="tb-text">{_e(u["text"])}</span>{self.compact_evidence(u)}</li>'
                for u in unknowns
            )
            body = f'<ul class="tb-list">{items}</ul>'
        else:
            body = '<p class="tb-empty-card">No unknowns or conflicts recorded.</p>'
        return (
            f'<details class="tb-section" id="tb-unknowns" data-section="unknowns">'
            f"<summary>All unknowns and conflicts ({len(unknowns)})</summary>{body}</details>"
        )

    def backlog(self):
        paths = [p for p in self.m["paths"] if p["role"] == "backlog"]
        if paths:
            rows = "".join(
                f'<li class="tb-path" id="rec-{_e(p["id"])}" {self.path_attrs(p)}>'
                f'{_state_chip(readiness_state(p["readiness"]))} '
                f'<a class="tb-path-title" href="#packet-{_e(p["id"])}">{_e(p["title"])}</a> '
                f'{_badge("readiness", p["readiness"], READINESS_LABELS[p["readiness"]])}'
                + (f' <span class="tb-issues-ref">{_e(self.path_issue_text(p))}</span>' if p.get("issues") else "")
                + "</li>"
                for p in paths
            )
            body = f'<ul class="tb-list">{rows}</ul>'
        else:
            body = '<p class="tb-empty-card">No backlog paths recorded.</p>'
        return (
            f'<details class="tb-section" id="tb-backlog" data-section="backlog">'
            f"<summary>Backlog paths ({len(paths)})</summary>{body}</details>"
        )

    def packets(self):
        paths = self.m["paths"]
        items = []
        for p in paths:
            items.append(
                f'<article class="tb-packet" id="packet-{_e(p["id"])}" {self.path_attrs(p)}>'
                f'<p class="tb-role">{_e(ROLE_LABELS[p["role"]])} · <code>{_e(p["id"])}</code></p>'
                f'<h3 class="tb-item-title">{_e(p["title"])}</h3>'
                f'<p class="tb-facts">{_state_chip(readiness_state(p["readiness"]))} '
                f'{_badge("readiness", p["readiness"], READINESS_LABELS[p["readiness"]])}</p>'
                + self.path_fields(p)
                + '<p class="tb-key">Read first:</p>'
                + self.evidence_list(p.get("read_first", []))
                + "</article>"
            )
        body = "".join(items) if items else '<p class="tb-empty-card">No follow-up paths recorded.</p>'
        return (
            f'<details class="tb-section" id="tb-packets" data-section="packets">'
            f"<summary>Full path packets ({len(paths)})</summary>"
            f'<p class="tb-authority">{AUTHORITY_NOTE}</p>{body}</details>'
        )

    def all_evidence(self):
        records = self.m["evidence"]
        body = (
            '<ul class="tb-ev-list">' + "".join(self.evidence_item(e, with_id=True) for e in records) + "</ul>"
            if records else '<p class="tb-empty-card">No evidence records.</p>'
        )
        return (
            f'<details class="tb-section" id="tb-evidence-all" data-section="evidence">'
            f"<summary>All evidence ({len(records)})</summary>{body}</details>"
        )

    def more(self):
        return (
            '<section class="tb-more" id="tb-more" aria-labelledby="tb-more-h">'
            '<h2 id="tb-more-h">Full records</h2>'
            + self.register() + self.all_gates() + self.all_unknowns()
            + self.backlog() + self.packets() + self.all_evidence()
            + "</section>"
        )

    def footer(self):
        return (
            '<footer class="tb-footer">Rendered from tracker-brief/1 Markdown. '
            "Git, issues and the linked sources stay the source of truth.</footer>"
        )

    def body(self):
        return "".join([
            self.header(),
            self.attention(),
            '<div class="tb-cards">',
            self.position_card(),
            self.changes_card(),
            self.active_card(),
            self.next_card(),
            "</div>",
            self.more(),
            self.footer(),
        ])


def render_body(model):
    """Return only the body markup. The model must already be valid."""
    return _Page(model).body()


def render(model, template=None):
    """Validate the model and return the complete HTML page.

    ``template`` is a path to an HTML file with exactly one ``@@TITLE@@`` and one
    ``@@BODY@@`` marker. It defaults to ``tracker/assets/template.html``.
    Raises BriefError when the model has validation errors.
    """
    errors = [d for d in validate(model) if d.level == "error"]
    if errors:
        raise BriefError(errors)
    path = Path(template) if template is not None else DEFAULT_TEMPLATE
    text = path.read_text(encoding="utf-8")
    if text.count("@@TITLE@@") != 1 or text.count("@@BODY@@") != 1:
        raise ValueError(f"template {path} needs exactly one @@TITLE@@ and one @@BODY@@ marker")
    before, after = text.split("@@BODY@@")
    title = _e(model["title"])
    # Replace markers in the template parts only, so user text never acts as a marker.
    if "@@TITLE@@" in before:
        before = before.replace("@@TITLE@@", title)
    else:
        after = after.replace("@@TITLE@@", title)
    return before + render_body(model) + after
