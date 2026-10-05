"""Extract agent-readable follow-up path packets from a tracker-brief/1 model.

A packet is a proposal. Extraction never runs commands, launches agents,
changes issues or deploys anything. Validation commands stay as text.
The recommended path's packet carries the stored next-session prompt
(the ``handoff`` record). Extraction reads it; it never composes prompt text.
"""

from __future__ import annotations

from .brief import resolve_issue, stored_handoff

PACKET_SCHEMA = "tracker-path-packet/1"
EXECUTION_NOTE = (
    "proposal-only: this packet does not authorize execution. "
    "Follow current owner authority and the gates before any action."
)


def _plain(value):
    """Copy nested dicts and lists into plain Python containers."""
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


def extract(model):
    """Return one packet per follow-up path, in document order.

    Each packet holds every field of the path record, plus:
    ``packet`` (schema id), ``brief`` (source identity and freshness),
    ``read_first_records`` (resolved evidence records), ``unresolved_read_first``,
    ``issue_records`` (resolved issue records), ``unresolved_issues`` (kept as text),
    ``gates`` (all gate records with their evidence records) and ``execution``.
    The recommended path's packet also holds ``handoff``: the stored handoff record
    with the next-session prompt. Other packets have no ``handoff`` key.
    """
    meta = model.get("meta", {})
    evidence = {e.get("id"): e for e in model.get("evidence", []) if isinstance(e, dict)}
    issues = [i for i in model.get("issues", []) if isinstance(i, dict)]
    handoff = stored_handoff(model)
    brief = {
        "title": model.get("title"),
        "repo": meta.get("repo"),
        "repo_url": meta.get("repo_url"),
        "ref": meta.get("ref"),
        "snapshot": meta.get("snapshot"),
        "evidence_checked": meta.get("evidence_checked"),
        "synthesis": meta.get("synthesis"),
    }
    gates = []
    for gate in model.get("gates", []):
        entry = _plain(gate)
        entry["evidence_records"] = [_plain(evidence[i]) for i in gate.get("evidence", []) if i in evidence]
        gates.append(entry)

    packets = []
    for path in model.get("paths", []):
        packet = {"packet": PACKET_SCHEMA}
        packet.update(_plain(path))
        read_first = path.get("read_first", [])
        packet["read_first_records"] = [_plain(evidence[i]) for i in read_first if i in evidence]
        packet["unresolved_read_first"] = [i for i in read_first if i not in evidence]
        resolved, unresolved, seen = [], [], set()
        for ref in path.get("issues", []):
            issue = resolve_issue(ref, issues)
            if issue is None:
                unresolved.append(ref)
            elif issue.get("id") not in seen:
                seen.add(issue.get("id"))
                resolved.append(_plain(issue))
        packet["issue_records"] = resolved
        packet["unresolved_issues"] = unresolved
        packet["brief"] = dict(brief)
        packet["gates"] = _plain(gates)
        packet["execution"] = EXECUTION_NOTE
        if handoff is not None and path.get("role") == "recommended" and handoff.get("path") == path.get("id"):
            packet["handoff"] = _plain(handoff)
        packets.append(packet)
    return packets


def format_text(packets):
    """Format packets as plain text for a human or an agent.

    The recommended packet ends with its stored next-session prompt, verbatim,
    between begin and end marker lines.
    """
    out = []
    labels = (
        ("objective", "Objective"), ("scope", "Scope"), ("authority", "Authority"),
        ("needs_approval", "Needs separate approval"), ("depends", "Depends on"),
        ("prerequisites", "Prerequisites"), ("acceptance", "Acceptance"),
        ("validate", "Validation commands (text only)"), ("output", "Expected output"),
        ("next_action", "Next action"),
    )
    for p in packets:
        out.append(f"PATH {p['id']} [{p['role']}, {p['readiness']}]")
        out.append(f"Title: {p['title']}")
        where = [f"repo {p['repo']}"]
        if "cwd" in p:
            where.append(f"cwd {p['cwd']}")
        if "revision" in p:
            where.append(f"revision {p['revision']}")
        out.append("Where: " + ", ".join(where))
        if p.get("issues"):
            out.append("Issues: " + ", ".join(p["issues"]))
        for key, label in labels:
            if key not in p:
                continue
            value = p[key]
            if isinstance(value, list):
                out.append(f"{label}:")
                out += [f"  - {v}" for v in value]
            else:
                out.append(f"{label}: {value}")
        if p["read_first_records"]:
            out.append("Read first:")
            out += [f"  - {e['label']} ({e['kind']}, {e['confidence']}): {e['ref']}" for e in p["read_first_records"]]
        for ref in p["unresolved_read_first"]:
            out.append(f"  - unresolved evidence id: {ref}")
        out.append(f"Snapshot: {p['brief']['snapshot']} ({p['brief']['synthesis']} synthesis)")
        out.append("Execution: " + p["execution"])
        if "handoff" in p:
            h = p["handoff"]
            out.append(f"Next-session prompt (source {h.get('source')}, basis {h.get('basis')}, generated {h.get('generated')}):")
            out.append("----- begin prompt -----")
            out += str(h.get("text", "")).split("\n")
            out.append("----- end prompt -----")
        out.append("")
    return "\n".join(out).rstrip("\n") + ("\n" if out else "")
