"""Build a `synthesis: minimal` brief from verified facts plus the previous brief.

Used when model synthesis is missing or fails. The result is labeled minimal in the
frontmatter and in an `unknown` record. It lists scripted facts (commits, issue
states) and carries forward earlier records unchanged. It never invents a new next
step: follow-up paths come only from the previous brief, with an `unknown` record
that says they are carried forward and unverified.
"""
from __future__ import annotations

import copy

from tracker.checkpoint import clip_words, one_line
from tracker.store import BRIEF_SCHEMA, add_fact_evidence, all_ids, apply_issue_facts, empty_model, unique_id

MINIMAL_PREFIX = "unk-min-"
DEFAULT_GATE = {
    "id": "gate-requester-approval", "kind": "approval",
    "text": "Pushing, merging, deploying and publishing need explicit requester approval.",
}


def _date(stamp: str | None) -> str:
    return (stamp or "unknown date")[:10]


def _pick_commits(commits: list, count: int = 3) -> list:
    """Prefer merge commits (merged pull requests), then the newest commits."""
    merges = [c for c in commits if c.get("merge")]
    others = [c for c in commits if not c.get("merge")]
    picked = (merges + others)[:count]
    order = {c["sha"]: n for n, c in enumerate(commits)}
    return sorted(picked, key=lambda c: order[c["sha"]])


def build_minimal(previous: dict | None, facts: dict, *, repo: str, repo_url: str, scope: str,
                  title: str, snapshot: str, reason: str) -> dict:
    """Return a normalized brief model labeled `synthesis: minimal`."""
    git = facts.get("git") or {}
    issues = facts.get("issues") or {}
    prev_meta = (previous or {}).get("meta") or {}
    meta = {
        "schema": BRIEF_SCHEMA,
        "repo": prev_meta.get("repo") or repo,
        "repo_url": prev_meta.get("repo_url") or repo_url,
        "ref": git.get("ref") or prev_meta.get("ref") or "unknown",
        "snapshot": snapshot,
        "evidence_checked": facts.get("collected") or snapshot,
        "scope": prev_meta.get("scope") or scope,
        "synthesis": "minimal",
        "stale_after_days": int(prev_meta.get("stale_after_days") or 7),
    }
    if prev_meta.get("snapshot"):
        meta["previous_snapshot"] = prev_meta["snapshot"]
    if previous:
        model = copy.deepcopy(previous)
        model["meta"] = meta
        model["title"] = previous.get("title") or title
    else:
        model = empty_model(meta, title)
    model["changes"] = []
    model["unknowns"] = [u for u in model.get("unknowns") or [] if not str(u.get("id", "")).startswith(MINIMAL_PREFIX)]
    used = all_ids(model)

    # Position: a scripted statement of where the branch is. No inferred milestone.
    commits = git.get("commits") or []
    head_short = (git.get("head") or "")[:7] or "unknown"
    count = git.get("commit_count", len(commits))
    branch = git.get("branch") or "HEAD"
    if previous:
        text = ("Scripted facts only: %s is at %s with %d new commits since the previous brief; "
                "priorities were not re-assessed." % (branch, head_short, count))
    else:
        text = ("Scripted facts only: %s is at %s; no previous brief exists and priorities were not assessed."
                % (branch, head_short))
    position = {"id": (model.get("position") or {}).get("id") or "pos-current",
                "text": clip_words(text, 40), "status": "verified"}
    if commits and commits[0]["sha"] == git.get("head"):
        position["evidence"] = ["ev-commit-" + commits[0]["short"]]
    model["position"] = position
    used.add(position["id"])

    # What changed: at most three verified commits since the previous brief.
    if previous or git.get("base"):
        for commit in _pick_commits(commits):
            model["changes"].append({
                "id": unique_id("chg-" + commit["short"], used),
                "title": clip_words(commit["subject"], 12),
                "summary": clip_words("Commit %s on %s: %s." % (commit["short"], branch, commit["subject"]), 30),
                "status": "verified",
                "evidence": ["ev-commit-" + commit["short"]],
            })

    if not model.get("gates"):
        model["gates"] = [dict(DEFAULT_GATE, id=unique_id(DEFAULT_GATE["id"], used))]

    issue_summary = apply_issue_facts(model, issues)

    unknowns = []
    why = clip_words(one_line(reason) or "no model output", 15)
    if previous:
        text = ("Model synthesis did not complete (%s). Records other than commits and issue states "
                "are carried forward from the %s brief." % (why, _date(prev_meta.get("snapshot"))))
    else:
        text = "Model synthesis did not complete (%s). This brief holds scripted facts only." % why
    unknowns.append({"id": MINIMAL_PREFIX + "synthesis", "kind": "missing", "severity": "normal",
                     "text": clip_words(text, 45)})
    paths = model.get("paths") or []
    if paths:
        recommended = next((p for p in paths if p.get("role") == "recommended"), None)
        if recommended:
            text = ("The recommended path '%s' is carried forward from the %s brief and is unverified."
                    % (clip_words(recommended.get("title", ""), 10), _date(prev_meta.get("snapshot"))))
        else:
            text = "Follow-up paths are carried forward from the %s brief and are unverified." % _date(
                prev_meta.get("snapshot"))
        unknowns.append({"id": MINIMAL_PREFIX + "carried-path", "kind": "stale", "severity": "normal",
                         "text": text})
    if issues.get("status") != "ok":
        detail = one_line(issues.get("error") or issues.get("status") or "not read", 80)
        unknowns.append({"id": MINIMAL_PREFIX + "issues", "kind": "inaccessible", "severity": "normal",
                         "text": clip_words("The issue tracker was not read (%s). Issue states come from the "
                                            "previous brief." % detail, 40)})
    if issue_summary["state_changed"]:
        numbers = ", ".join("#%d" % n for n in issue_summary["state_changed"][:8])
        unknowns.append({"id": MINIMAL_PREFIX + "state-changed", "kind": "conflict", "severity": "normal",
                         "text": clip_words("Tracker state changed for %s since the previous brief; progress "
                                            "fields were not re-checked." % numbers, 40)})
    if issue_summary["untracked_closed"]:
        numbers = ", ".join("#%d" % n for n in issue_summary["untracked_closed"][:8])
        unknowns.append({"id": MINIMAL_PREFIX + "untracked-closed", "kind": "missing", "severity": "normal",
                         "text": clip_words("Issues %s were closed but have no progress record in this brief."
                                            % numbers, 40)})
    for record in unknowns:
        record["id"] = unique_id(record["id"], used)
    model["unknowns"] = unknowns + model["unknowns"]
    add_fact_evidence(model, facts)
    model.setdefault("notes", {})
    return model
