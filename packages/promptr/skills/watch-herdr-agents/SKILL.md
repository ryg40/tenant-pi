---
name: watch-herdr-agents
description: Monitor any combination of existing Herdr agent panes and wake an exact Coordinator once after verified completion; no extra agent launch.
---

# Watch Herdr Agents

Use when visible Herdr Pi, Claude, Codex or other agent sessions lack native completion delivery and the user wants the current Coordinator to resume automatically. Observes existing sessions only; does not launch workers or replace pi-subagents native notifications.

Repo copy is distributable source; the installed global skill under `~/.pi/agent/` is separate runtime state. Synchronize intentionally and compare files after updates.

## Procedure

1. Read `references/usage.md` and inspect `herdr agent list`, `herdr tab list`, and relevant CLI help. Resolve tab selections to explicit panes; labels alone are not identity. Capture exact agent_session kind/value, agent type and permitted foreground cwd(s) for every worker and the Coordinator.
2. Create a private JSON config from `assets/config.example.json`. Use 1–32 workers across any tabs/workspaces, mode all (default) or any. Require fresh final-report markers by default; status-only completion must be an explicit weaker choice and requires observed working first. Set deadline, polling interval and stable observation count. Wake text is trusted Coordinator-authored instruction, never raw worker content; include only actually authorized follow-up actions.
3. Run `python3 scripts/watch.py check /absolute/config.json` to validate identity/evidence without sending. Run `python3 scripts/test_watch.py` after script changes.
4. Start using `python3 scripts/watch.py start /absolute/config.json`. This detaches a non-agent observer and returns PID/state paths. Read its status file to confirm monitoring. Use a unique private stateDir for each watcher; duplicate starts lock out and a prior wake-attempt receipt prevents replay.
5. Return control so the Coordinator becomes idle. The watcher waits for qualifying workers and an idle/done exact Coordinator, revalidates identities immediately before one `herdr agent prompt`, records the attempt before sending, and exits. Delivery success is submission only, not proof of subsequent review or task success.
6. On wake, independently retrieve final handoffs, inspect source/worktree state and verify all writers have stopped before reconciliation. In any mode, incomplete workers still own their files. On identity changes, blocked agents, deadline or uncertain submission, inspect status and ask/recover explicitly; do not silently rebind, retry sends, switch protocols, or infer shipping permission.

## Pitfalls

- Idle alone is not completion: trust/permission prompts and just-launched sessions may appear idle. Use final report markers, freshness and consecutive idle observations; blocked status stops the watcher rather than triggering automatic approval.
- Python 3, fcntl and the Herdr CLI are required (Linux/macOS). Detached observers survive the parent shell but not machine/session shutdown. This is bounded best-effort monitoring, not durable delivery infrastructure.
- Each config pins session identity, agent and cwd. Renamed tabs are harmless; replaced sessions, missing panes and moved cwd fail closed. Allowed cwd variants must be explicit (e.g. worktree and worktree/extension).
- `mode:any` wakes once on the first qualified worker(s), not repeatedly. Never treat that as permission to reconcile files owned by still-active workers.
- No automatic retry after a wake attempt, including timeout/uncertain delivery. A new watcher needs fresh explicit config/stateDir and manual inspection first. Different state directories are not globally deduplicated; inspect active receipts before starting.
- Keep private reports, paths and wake messages out of Git. Existing worker permissions remain unchanged; observer launches no agents and modifies no product source or tracker.

## Verification

1. Config check reports exact worker and Coordinator identities; tests pass using synthetic fixtures without live prompt sends.
2. `start` returns a PID and status file showing monitoring or an explicit failure, not merely a successful shell spawn.
3. Completion requires configured evidence and stable idle observations. Receipt `wake-attempt.json` is written before sending and prevents automatic replay; final status distinguishes submitted, uncertain/failed, blocked, expired and identity mismatch.
