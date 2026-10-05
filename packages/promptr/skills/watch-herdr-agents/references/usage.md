# Herdr watcher usage

Python 3 standard library only, POSIX (fcntl). No model, worker launch, permission change, install, or remote tracker write. The sole active action is one user-authorized wake prompt to a pinned Coordinator.

## Configure existing panes

1. Read `herdr agent list` and `herdr tab list`. Tabs can contain multiple panes: explicitly choose which agents to observe. Do not match by tab labels, names or substrings. Different tabs/workspaces and agent types can share one watcher.
2. Copy `../assets/config.example.json` to a private absolute location. Replace EVERY example target and path. Capture `agent`, `pane_id`, `agent_session.kind/value`, and permitted `foreground_cwd` variants verbatim from live evidence. For example a worker legitimately moves from a worktree root into its `extension` directory; enumerate both. The Coordinator must not also be a worker.
3. Set a fresh unique `stateDir` (owner-only private directory). Record a report `notBefore` Unix timestamp at/before the actual task launch, not at watcher creation if the worker is already complete. It prevents accidental reuse of old reports; this timestamp is caller evidence, not a trust proof. Do not leave the example zero unchanged. Reports must be local UTF-8, at most 1 MiB, and contain all specified markers.
4. Default `mode: all` requires every worker; `any` wakes once after any worker qualifies. Any mode does not mean all other writers stopped. `stablePolls` counts consecutive eligible observations PER worker, so alternating idle workers cannot incorrectly satisfy it.
5. Prefer `completion: {kind: report, path, notBefore, markers}`. For agents with no report contract, an explicit `completion: {kind: status-after-working}` is supported: that worker must be observed working, then idle/done for consecutive polls. This is weaker and cannot detect an already-finished worker at watcher startup. Never silently downgrade report checks.
6. Supply your own trusted wakeMessage summarizing authorized next steps and pointing to local reports/status. Never copy untrusted worker report contents into the automatic prompt. Worker completion is not necessarily success: a final blocked/failed report wakes for inspection, not automatic shipping.

## Commands

Resolve scripts relative to the skill directory, not cwd:

```sh
python3 /absolute/skill/scripts/watch.py check /absolute/private/config.json
python3 /absolute/skill/scripts/watch.py start /absolute/private/config.json
```

`check` performs live identity/evidence assessment without saving or sending. `start` freezes config to stateDir/config.json and detaches `run`, returning launch PID. Confirm stateDir/status.json actually says monitoring; shell spawn alone is not a successful watcher. Read stateDir/watcher.log on early failure. The starting agent should then return control; the watcher will not submit while the Coordinator is working.

For a foreground observer or service manager use `run` instead of `start`. Each stateDir has an exclusive active lock and a durable pre-send attempt receipt. Do not start multiple stateDirs for the same worker group/Coordinator: there is no global deduplication. Inspect existing launch/status receipts first.

## Status and stop

- `monitoring`: waiting for evidence and stable idle; workers include eligibility/status.
- `identity-mismatch`: missing/replaced session, agent or unexpected cwd; exits without sending.
- `blocked`: a Herdr worker reports blocked; exits without approving prompts or sending.
- `monitoring-error`: transient CLI/parsing error; consecutive counts reset; retry until deadline.
- `wake-submitted`: Herdr accepted a single prompt call. Does not prove the Coordinator read it or completed work.
- `wake-uncertain-no-retry`: prompt timed out/failed; inspect Coordinator manually. Never replay automatically.
- `expired`: deadline elapsed with no wake.

Before stopping an observer, read launch.json and verify the PID command is exactly this watcher with this frozen config. Send SIGTERM only to that verified observer, never its worker panes. Preserve receipts; a prior wake-attempt.json prevents a subsequent automatic send. Recovery is a deliberate new watcher only after inspecting the previous send/Coordinator state.

The watcher re-reads identities immediately before sending but Herdr exposes no atomic compare-session-and-prompt operation. A tiny check/send race remains. No delivery guarantees or automatic recovery are claimed. Current script does not notify on expiry/blocked/mismatch; inspect status if it does not wake within the configured window. Machine/session shutdown can end the observer.

## Tests and publication

```sh
python3 /absolute/skill/scripts/test_watch.py
```

Tests use mock Herdr snapshots and subprocess calls; no real prompt/launch occurs. Publish only SKILL.md, scripts, references and synthetic example config/tests. Never include private live config, stateDir, reports, receipts or logs. A repo copy is distributable source; a global copy is separate installed skill state. Synchronize intentionally and compare files after updates.
