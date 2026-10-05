"""Build the stored next-session prompt (the ``handoff`` record) for a restart brief.

The prompt is plain text that a person copies into a fresh coordinator session.
It covers only the recommended path. It stands alone: repository, working
directory, revision, snapshot time, objective, scope, next action, read-first
evidence, related issues, authority, approvals, gates, acceptance, validation
commands and expected output, then a closing statement that the path is a proposal.

The backend pipeline calls ``refresh`` and stores the record in the canonical
Markdown. Renderers and path packets only read the stored record.

Pure and deterministic: no clock, network, subprocess, environment or config.
Every fact in the text comes from the model.
"""

from __future__ import annotations

import copy

from .brief import HANDOFF_MAX_WORDS, ID_RE, is_safe_https, recommended_path, resolve_issue, words

CARRIED_FORWARD = (
    "Carried forward: this path comes from an earlier brief and was not re-checked. "
    "Confirm it against current sources before you act."
)
PROPOSAL = (
    "This path is a proposal. It gives no permission to deploy, publish, change issues "
    "or pass an approval gate. When a step needs approval, stop and ask the owner."
)
GATE_LABELS = (("approval", "Needs approval"), ("forbidden", "Forbidden"))

# Shortening steps for a long path: (max items per list, max words per value).
# The first step keeps everything. Commands and references are never clipped, only dropped.
_LEVELS = ((None, None), (6, 40), (4, 25), (3, 18), (2, 12), (1, 8), (1, 5))


def build(model, *, basis="current"):
    """Return the handoff record for the recommended path, or None when there is none.

    ``basis`` is ``current`` or ``carried-forward``. ``generated`` is the brief's snapshot.
    """
    if basis not in ("current", "carried-forward"):
        raise ValueError("basis must be 'current' or 'carried-forward'")
    path = recommended_path(model)
    if path is None:
        return None
    return {
        "id": _handoff_id(model, path.get("id", "")),
        "path": path.get("id"),
        "source": "generated",
        "generated": (model.get("meta") or {}).get("snapshot"),
        "basis": basis,
        "text": compose(model, path, basis=basis),
    }


def refresh(model, *, basis="current"):
    """Return a copy of ``model`` whose handoff matches its recommended path.

    An owner-written handoff (``source: owner``) that still names the recommended
    path is kept as it is. Any other handoff is replaced by ``build``. Without a
    recommended path the copy has no handoff.
    """
    out = copy.deepcopy(model)
    path = recommended_path(out)
    existing = [h for h in out.get("handoffs") or [] if isinstance(h, dict)]
    if path is None:
        out["handoffs"] = []
        return out
    owner = [h for h in existing if h.get("source") == "owner" and h.get("path") == path.get("id")]
    out["handoffs"] = [owner[0]] if owner else [build(out, basis=basis)]
    return out


def compose(model, path, *, basis="current"):
    """Compose the prompt text for ``path``. It fits the handoff word limit."""
    for items, clip in _LEVELS:
        text = "\n".join(_lines(model, path, basis, items, clip))
        if words(text) <= HANDOFF_MAX_WORDS:
            return text
    # Last resort for extreme input: keep the head and the closing statement.
    head = text[: -len(PROPOSAL)].split()
    keep = HANDOFF_MAX_WORDS - words(PROPOSAL) - 1
    return " ".join(head[:keep]) + " ...\n\n" + PROPOSAL


# ---------------------------------------------------------------- text parts


def _handoff_id(model, path_id):
    used = set()
    for key in ("changes", "active", "issues", "gates", "unknowns", "paths", "evidence"):
        used.update(r.get("id") for r in model.get(key) or [] if isinstance(r, dict))
    position = model.get("position")
    if isinstance(position, dict):
        used.add(position.get("id"))
    base = ("handoff-" + str(path_id))[:64].rstrip("-")
    if not ID_RE.fullmatch(base):
        base = "handoff"
    candidate, n = base, 2
    while candidate in used:
        suffix = f"-{n}"
        candidate = base[: 64 - len(suffix)].rstrip("-") + suffix
        n += 1
    return candidate


def _clip(value, clip):
    text = " ".join(str(value).split())
    if clip is None:
        return text
    parts = text.split()
    return text if len(parts) <= clip else " ".join(parts[:clip]) + " ..."


def _list(label, values, items, clip, *, clip_values=True):
    if not values:
        return []
    shown = values if items is None else values[:items]
    out = [label + ":"]
    out += ["- " + (_clip(v, clip) if clip_values else " ".join(str(v).split())) for v in shown]
    if len(shown) < len(values):
        out.append(f"- {len(values) - len(shown)} more in the restart brief")
    return out


def _issue_line(ref, issues, clip):
    issue = resolve_issue(ref, issues)
    if issue is None:
        return f"{ref} (no issue record in the brief)"
    rid = str(issue.get("id", ""))
    label = "#" + rid if rid.isdigit() else rid
    state = ", ".join(v for v in (issue.get("state"), issue.get("progress")) if v)
    return f"{label} {_clip(issue.get('title', ''), clip)} ({state}): {issue.get('url', '')}"


def _evidence_line(record, clip):
    label, kind, ref = _clip(record.get("label", ""), clip), record.get("kind", ""), record.get("ref", "")
    if is_safe_https(ref):
        return f"{label} ({kind}): {ref}"
    return f"{label} ({kind}, not a link): {ref}"


def _lines(model, path, basis, items, clip):
    meta = model.get("meta") or {}
    repo = path.get("repo") or meta.get("repo", "")
    out = []
    if basis == "carried-forward":
        out += [CARRIED_FORWARD, ""]
    out += [
        f"You coordinate the next work session in the repository {repo}.",
        "Start from this prompt. You have not seen the earlier session.",
        f"Source: restart brief \"{model.get('title', '')}\", recommended path {path.get('id', '')}.",
        "",
        f"Repository: {repo}",
    ]
    if repo == meta.get("repo") and meta.get("repo_url"):
        out.append(f"Repository URL: {meta['repo_url']}")
    elif meta.get("repo_url"):
        out.append(f"Brief repository: {meta.get('repo', '')} at {meta['repo_url']}")
    if path.get("cwd"):
        out.append(f"Working directory: {path['cwd']}")
    else:
        out.append(f"Working directory: a checkout of {repo} (the brief records no path)")
    if path.get("revision"):
        out.append(f"Revision: {path['revision']}")
    else:
        out.append(f"Revision: {meta.get('ref', '')} (the ref of the brief)")
    out += [
        "",
        f"Brief snapshot: {meta.get('snapshot', '')}",
        f"Evidence checked: {meta.get('evidence_checked', '')}",
        "Confirm that the sources below are still current before you act.",
        "Code, issues and gates can change after the snapshot.",
        "",
        f"Title: {_clip(path.get('title', ''), clip)}",
        f"Readiness: {path.get('readiness', '')}",
        f"Objective: {_clip(path.get('objective', ''), clip)}",
        f"Scope: {_clip(path.get('scope', ''), clip)}",
        f"Next action: {_clip(path.get('next_action', ''), clip)}",
    ]
    evidence = {e.get("id"): e for e in model.get("evidence", []) if isinstance(e, dict)}
    read_first = [_evidence_line(evidence[i], clip) for i in path.get("read_first", []) if i in evidence]
    issues = [i for i in model.get("issues", []) if isinstance(i, dict)]
    related = [_issue_line(ref, issues, clip) for ref in path.get("issues", [])]
    gates = [
        f"{label}: {g.get('text', '')}"
        for kind, label in GATE_LABELS
        for g in model.get("gates", [])
        if isinstance(g, dict) and g.get("kind") == kind
    ]
    groups = [
        _list("Read first", read_first, items, None, clip_values=False),
        _list("Related issues", related, items, None, clip_values=False),
        _list("Depends on", path.get("depends", []), items, clip)
        + _list("Prerequisites", path.get("prerequisites", []), items, clip),
        [f"Authority: {_clip(path.get('authority', ''), clip)}"]
        + _list("Needs separate owner approval", path.get("needs_approval", []), items, clip)
        + _list("Approval gates in force", gates, items, clip),
        _list("Acceptance criteria", path.get("acceptance", []), items, clip)
        + _list("Validation commands", path.get("validate", []), items, None, clip_values=False)
        + [f"Expected output: {_clip(path.get('output', ''), clip)}"],
    ]
    for group in groups:
        if group:
            out += [""] + group
    out += ["", PROPOSAL]
    return out
