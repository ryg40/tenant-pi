"""The close code of herdr-idle-cleanup: the plan, the checks before each close and the resume data.

idle_cleanup.py imports this module for its subcommand `close`. It passes in the Herdr functions: a fresh read
of one workspace (read calls only) and the close call by workspace ID. Standard library only.
"""
import datetime

import _common  # the herdr scripts folder is on sys.path (idle_cleanup.py puts it there)
import harvest as hv

# The keep reasons, in the order of the checks. The first check that fails gives the reason.
KEEP_REASONS = ("active", "blocked", "unknown", "protected", "no handoff entry", "changed since the scan")
# The result of a workspace: planned close, done close, kept, failed (a fresh read or a close that failed).
RESULTS = ("close", "closed", "keep", "failed")
# The errors of one workspace that do not stop the run: a failed Herdr read, a lock timeout, a bad file.
RUN_ERRORS = (RuntimeError, OSError, ValueError)


def _iso(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).isoformat(timespec="seconds")


def _agent_panes(ws):
    return [p for p in ws.get("panes") or [] if p.get("agent")]


def handoff_records(ws, index):
    """(found, missing): found is a list of (pane, record id) for each agent pane that has the record of its
    current final reply in index.json; missing is the list of the other pane ids."""
    by_id = {r.get("id"): r for r in index["entries"]}
    found, missing = [], []
    for pane in _agent_panes(ws):
        reply, _ = hv.final_reply(pane)
        rid = hv.entry_id(pane.get("pane_id"), reply)
        r = by_id.get(rid)
        if r is None or r.get("pane") != pane.get("pane_id") or r.get("workspace") != ws.get("workspace_id"):
            missing.append(pane.get("pane_id"))
        else:
            found.append((pane, rid))
    return found, missing


def change_detail(old, fresh):
    """None when the fresh read of a workspace still matches its scan.json record and is `idle`; else the change."""
    if fresh is None:
        return "the workspace is gone"
    old_panes = {p.get("pane_id"): p for p in old.get("panes") or []}
    new_panes = {p.get("pane_id"): p for p in fresh.get("panes") or []}
    added, gone = sorted(set(new_panes) - set(old_panes)), sorted(set(old_panes) - set(new_panes))
    if added:
        return f"new pane(s): {', '.join(added)}"
    if gone:
        return f"missing pane(s): {', '.join(gone)}"
    for pid, p in new_panes.items():
        before = old_panes[pid]
        if p.get("agent") != before.get("agent"):
            return f"pane {pid} now runs {p.get('agent') or 'no agent'}"
        when, then = p.get("last_activity_epoch"), before.get("last_activity_epoch")
        if when is not None and (then is None or when > then):
            return f"pane {pid} has a newer activity time"
    if fresh.get("class") != "idle":
        return f"now {fresh.get('class')}: {fresh.get('reason')}"
    return None


def decide(ws, index, protected, scan_caller, fresh_read):
    """(result, reason, detail, plan) of one workspace. result is `close` or `keep`; plan holds the fresh
    record and the handoff records for a close."""
    wid, label, cls = ws.get("workspace_id"), ws.get("label"), ws.get("class")
    if cls != "idle":
        return "keep", cls if cls in KEEP_REASONS else "unknown", ws.get("reason"), None
    if wid == scan_caller:
        return "keep", "protected", "the caller's own workspace", None
    if wid in protected or (label and label in protected):
        return "keep", "protected", "named in the protected setting", None
    if not _agent_panes(ws):
        return "keep", "unknown", "no agent pane", None
    found, missing = handoff_records(ws, index)
    if missing:
        return "keep", "no handoff entry", f"no record of the final reply of {', '.join(missing)}", None
    fresh, fresh_caller = fresh_read(wid)
    if wid == fresh_caller or (fresh and fresh.get("class") == "protected"):
        return "keep", "protected", (fresh or {}).get("reason") or "the caller's own workspace", None
    detail = change_detail(ws, fresh)
    if detail:
        return "keep", "changed since the scan", detail, None
    no_file = [p.get("pane_id") for p in _agent_panes(fresh) if not p.get("transcript")]
    if no_file:
        return "keep", "unknown", f"no transcript or session file to resume {', '.join(no_file)}", None
    return "close", None, ws.get("reason"), {"fresh": fresh, "records": found}


def _resume(ws, fresh_pane, record):
    return {"workspace": ws.get("workspace_id"), "workspace_label": ws.get("label"),
            "pane": fresh_pane.get("pane_id"), "agent": fresh_pane.get("agent"), "name": fresh_pane.get("name"),
            "cwd": fresh_pane.get("cwd"), "session_file": fresh_pane.get("transcript") or record.get("source")}


def close_one(ws, plan, index_path, close_call, write_json, clock):
    """(result, detail): write the resume data under the lock, then close the workspace by its ID."""
    fresh_panes = {p.get("pane_id"): p for p in plan["fresh"]["panes"]}
    ids = [rid for _, rid in plan["records"]]
    with hv.IndexLock(index_path):
        index = hv.read_index(index_path)
        by_id = {r.get("id"): r for r in index["entries"]}
        if any(rid not in by_id for rid in ids):
            return "failed", "a handoff record left index.json before the close; nothing was closed"
        closed_at = _iso(clock())
        for pane, rid in plan["records"]:
            r = by_id[rid]
            r["resume"] = _resume(ws, fresh_panes[pane.get("pane_id")], r)
            r["closed_at"] = closed_at
            r.pop("close_error", None)
        write_json(index_path, index)
    try:
        code, data, raw = close_call(ws.get("workspace_id"))
        error = None if code == 0 and not _common.error_code(data) else (
            f"herdr workspace close exit {code}: {_common.error_code(data) or (raw or '')[:200]}")
    except Exception as e:  # noqa: BLE001  (a refused or broken call is a failed close)
        error = f"herdr workspace close raised {type(e).__name__}: {e}"
    if error is None:
        return "closed", ws.get("reason")
    try:
        with hv.IndexLock(index_path):
            index = hv.read_index(index_path)
            for r in index["entries"]:
                if r.get("id") in ids:
                    r["closed_at"] = None
                    r["close_error"] = {"at": _iso(clock()), "message": error}
            write_json(index_path, index)
    except RUN_ERRORS as e:
        error += f"; the close_error was not recorded in index.json: {type(e).__name__}: {e}"
    return "failed", error


def run(scan_data, index_path, fresh_read, close_call, write_json, clock, protected=(), do_close=False):
    """The plan of each workspace of scan_data, and with do_close the close of each `close` row.

    Return {"rows": [{workspace_id, label, result, reason, detail}], "counts": {...}}.
    """
    protected = set(scan_data.get("protected_setting") or []) | set(protected)
    scan_caller = (scan_data.get("caller") or {}).get("workspace_id")
    index = hv.read_index(index_path)
    rows = []
    for ws in scan_data.get("workspaces") or []:
        # An error of one workspace fails only its row: the run goes on, so each close stays in the report.
        try:
            result, reason, detail, plan = decide(ws, index, protected, scan_caller, fresh_read)
        except RUN_ERRORS as e:
            result, reason, plan = "failed", "read failed", None
            detail = f"the fresh read failed, nothing was closed: {type(e).__name__}: {e}"
        if result == "close" and do_close:
            try:
                result, detail = close_one(ws, plan, index_path, close_call, write_json, clock)
            except RUN_ERRORS as e:
                result, detail = "failed", f"nothing was closed: {type(e).__name__}: {e}"
            reason = "close failed" if result == "failed" else None
        rows.append({"workspace_id": ws.get("workspace_id"), "label": ws.get("label"), "result": result,
                     "reason": reason, "detail": detail})
    counts = {r: sum(1 for x in rows if x["result"] == r) for r in RESULTS}
    counts["keep_reasons"] = {k: n for k in KEEP_REASONS
                              if (n := sum(1 for x in rows if x["result"] == "keep" and x["reason"] == k))}
    return {"rows": rows, "counts": counts}


def format_result(result):
    lines = ["RESULT\tREASON\tWORKSPACE\tID\tDETAIL"]
    for r in result["rows"]:
        lines.append("\t".join([r["result"], r["reason"] or "-", r["label"] or "-", r["workspace_id"] or "-",
                                r["detail"] or "-"]))
    c = result["counts"]
    kept = ", ".join(f"{k} {n}" for k, n in c["keep_reasons"].items())
    lines += ["", f"close {c['close']}, closed {c['closed']}, failed {c['failed']}, keep {c['keep']}"
                  + (f" ({kept})" if kept else "")]
    return "\n".join(lines)
