"""Refresh a repository's restart brief in resumable, idempotent stages.

    python3 -m tracker.refresh [--repo-path DIR] [--state-dir DIR] [--config FILE] COMMAND

Stages: collect -> synthesize -> validate -> render -> store -> publish.

Commands:
  status      Show the brief location, snapshot, synthesis kind, unfinished stages and
              the last publication link. No network access, no model call.
  checkpoint  Persist the bounded checkpoint packet and start a new run.
  collect     Collect exact Git and issue facts.
  prepare     Write the synthesis input packet for a model step in a fresh context.
  apply       Apply the model output (--synthesis FILE). Invalid output gives a minimal brief.
  minimal     Build a minimal brief from verified facts and the previous brief.
  validate    Validate the candidate brief and keep it as the last-good brief.
  render      Render the candidate brief to HTML.
  store       Write the brief to the canonical store, or queue it locally.
  publish     Publish the HTML (opt-in; needs publication configuration).
  sync        Apply a queued brief to the canonical store when it is safe.
  run         Resume all stages in order. Stops before synthesis when no output exists.

This tool never calls a model. The skill tells the agent how to run the model step.
Every candidate brief gets its next-session prompt (the `handoff` record) from
tracker.handoff before validation. The model step never writes one.
"""
from __future__ import annotations

import argparse
import dataclasses
import importlib
import json
import os
import sys
from pathlib import Path

from tracker import collect as collect_mod
from tracker import handoff as handoff_mod
from tracker.checkpoint import (CHECKPOINT_MAX_BYTES, STAGES, LockBusy, RetryLimit, RunLock, RunState,
                                atomic_write, build_checkpoint, encode_checkpoint, format_utc, home_relative,
                                load_checkpoint, new_run_id, one_line, parse_utc, read_json, redact,
                                save_checkpoint, sha256_text, utc_now, write_json)
from tracker.minimal import build_minimal
from tracker.publish import DEFAULT_FILE_NAME, Publisher, PublishError
from tracker.store import (BRIEF_SCHEMA, FragmentError, LastGood, LocalFileStore, OpenKnowledgeStore,
                           PendingQueue, StoreUnavailable, add_fact_evidence, apply_issue_facts, empty_model,
                           format_record, merge_update, parse_fragment, read_frontmatter, store_brief)

DEFAULT_STATE_ROOT = "~/.pi/agent/tracker-state"
DEFAULT_RECEIPT_DIR = "~/.pi/agent/tracker-publications"
SYNTHESIS_PACKET_MAX_BYTES = 32768
PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "synthesize.md"

EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_WAITING, EXIT_BUSY = 0, 1, 2, 3, 4


class ConfigError(ValueError):
    pass


class SynthesisError(ValueError):
    pass


# ---------------------------------------------------------------- configuration

@dataclasses.dataclass
class Config:
    repo_path: Path
    repo: str
    repo_url: str
    slug: str
    state_dir: Path
    title: str
    scope: str
    store: dict
    issues_api: str | None
    issues_token_env: str
    issues_token_file: str | None
    max_commits: int
    max_issue_pages: int
    issue_page_size: int
    max_retries: int
    stale_lock_seconds: int
    publish: dict
    config_file: str | None


def _read_config_file(path) -> dict:
    try:
        data = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ConfigError("config file not found: %s" % home_relative(path)) from exc
    except ValueError as exc:
        raise ConfigError("config file is not valid JSON: %s" % home_relative(path)) from exc
    if not isinstance(data, dict):
        raise ConfigError("config file must hold a JSON object")
    return data


def load_config(*, repo_path=None, state_dir=None, config_file=None, env=None, git=None) -> Config:
    """Resolve configuration: flags, then environment, then the config file, then defaults.

    The default config file is `<state dir>/config.json`. The repository identity comes
    from the `origin` remote unless the config names it.
    """
    env = os.environ if env is None else env
    repo_path = Path(repo_path or env.get("TRACKER_REPO_PATH") or os.getcwd()).expanduser()
    git = git or collect_mod.git_runner(repo_path)
    try:
        root = collect_mod.repo_root(git)
    except collect_mod.CollectError as exc:
        raise ConfigError("not a Git repository: %s" % home_relative(repo_path)) from exc
    config_file = config_file or env.get("TRACKER_CONFIG")
    data = _read_config_file(config_file) if config_file else {}
    identity = collect_mod.origin_identity(git) or {}
    repo = data.get("repo") or identity.get("repo") or root.name
    repo_url = data.get("repo_url") or identity.get("repo_url") or ""
    slug = collect_mod.repo_slug(repo)
    state = Path(state_dir or env.get("TRACKER_STATE_DIR") or data.get("state_dir")
                 or Path(DEFAULT_STATE_ROOT) / slug).expanduser()
    if not config_file and (state / "config.json").is_file():
        config_file = str(state / "config.json")
        data = _read_config_file(config_file)
        repo = data.get("repo") or repo
        repo_url = data.get("repo_url") or repo_url
    if repo_url and not collect_mod.safe_https_url(repo_url):
        raise ConfigError("repo_url must be a credential-free HTTPS URL")
    issues = data.get("issues") or {}
    issues_api = env.get("TRACKER_ISSUES_API") or issues.get("api")
    if issues_api and not collect_mod.safe_https_url(issues_api):
        raise ConfigError("the issue API must be a credential-free HTTPS URL")
    store = dict(data.get("store") or {})
    store.setdefault("backend", "local")
    if env.get("TRACKER_STORE_PATH"):
        store["path"] = env["TRACKER_STORE_PATH"]
    if store["backend"] == "local" and not store.get("path"):
        store["path"] = ".okf/tracker-brief.md" if (root / ".okf").is_dir() else "tracker-brief.md"
    publish = dict(data.get("publish") or {})
    for key, var in (("endpoint", "TRACKER_PUBLISH_ENDPOINT"), ("credential_file", "TRACKER_PUBLISH_CREDENTIAL_FILE"),
                     ("receipt_dir", "TRACKER_RECEIPT_DIR")):
        if env.get(var):
            publish[key] = env[var]
    publish.setdefault("receipt_dir", DEFAULT_RECEIPT_DIR)
    name = repo.split("/")[-1]
    return Config(
        repo_path=root, repo=repo, repo_url=repo_url, slug=slug, state_dir=state,
        title=data.get("title") or "%s restart brief" % name,
        scope=data.get("scope") or "Repository %s: code, issues and follow-up work." % repo,
        store=store, issues_api=issues_api,
        issues_token_env=issues.get("token_env") or "GITEA_TOKEN",
        issues_token_file=env.get("TRACKER_ISSUES_TOKEN_FILE") or issues.get("token_file"),
        max_commits=int((data.get("git") or {}).get("max_commits") or collect_mod.DEFAULT_MAX_COMMITS),
        max_issue_pages=int(issues.get("max_pages") or collect_mod.DEFAULT_MAX_PAGES),
        issue_page_size=int(issues.get("page_size") or collect_mod.DEFAULT_PAGE_SIZE),
        max_retries=int(data.get("max_retries", 2)),
        stale_lock_seconds=int(data.get("stale_lock_seconds", 3600)),
        publish=publish, config_file=config_file,
    )


def _optional_module(name: str):
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


# ---------------------------------------------------------------- synthesis packet

def _issue_line(record: dict) -> str:
    return "- %s | %s | %s | %s" % (record.get("id"), record.get("state"), record.get("progress"),
                                    one_line(record.get("title"), 90))


def build_synthesis_packet(*, prompt: str, checkpoint: dict, base_text: str | None, facts: dict,
                           handoffs: list, output_path: str, run_id: str, prepared: str,
                           limit: int = SYNTHESIS_PACKET_MAX_BYTES) -> str:
    """Assemble the bounded input for the model step. The result fits `limit` bytes."""
    levels = [(30, 40, 2000, 30, 20), (20, 25, 1200, 20, 12), (12, 15, 600, 12, 8),
              (6, 8, 300, 6, 4), (3, 4, 150, 3, 2)]
    text = ""
    for commits, issues, note_chars, evidence, files in levels:
        text = _packet(prompt, checkpoint, base_text, facts, handoffs, output_path, run_id, prepared,
                       commits, issues, note_chars, evidence, files)
        if len(text.encode("utf-8")) <= limit:
            return text
    data = text.encode("utf-8")[: limit - 64]
    return data.decode("utf-8", "ignore") + "\n\n[packet truncated to %d bytes]\n" % limit


def _packet(prompt, checkpoint, base_text, facts, handoffs, output_path, run_id, prepared,
            n_commits, n_issues, note_chars, n_evidence, n_files) -> str:
    out = ["# Tracker synthesis input", "",
           "- packet: tracker-synthesis-input/1", "- run: %s" % run_id,
           "- repo: %s" % checkpoint.get("repo"), "- prepared: %s" % prepared,
           "- output file: %s" % output_path, "",
           "Write the output file, then stop. The caller applies it with "
           "`python3 -m tracker.refresh apply --synthesis <output file>`.", "",
           prompt.strip(), "", "## Checkpoint", "", "```json",
           encode_checkpoint(checkpoint).decode("utf-8").strip(), "```", "", "## Previous brief", ""]
    if not base_text:
        out += ["No previous brief exists. Write a complete first brief: one position, at least one "
                "approval gate, and the other sections that the facts support.", ""]
    else:
        meta = read_frontmatter(base_text)
        out += ["- %s: %s" % (k, one_line(v, 120)) for k, v in meta.items()] + [""]
        try:
            records = parse_fragment(base_text, strict=False)["records"]
        except FragmentError as exc:
            records = []
            out += ["The previous brief has record errors: %s" % one_line(str(exc), 200), ""]
        by_type: dict = {}
        for rtype, record, _ in records:
            by_type.setdefault(rtype, []).append(record)
        out += ["### Default-view records", ""]
        cited = set()
        for rtype in ("position", "change", "active", "gate", "unknown"):
            for record in by_type.get(rtype, [])[:10]:
                out += [format_record(rtype, record), ""]
                cited.update(record.get("evidence") or [])
        backlog = []
        for record in by_type.get("path", []):
            if record.get("role") in ("recommended", "alternative"):
                out += [format_record("path", record), ""]
                cited.update(record.get("read_first") or [])
                cited.update(record.get("evidence") or [])
            else:
                backlog.append(record)
        if backlog:
            out += ["Backlog paths (kept unless you retire them):"]
            out += ["- %s: %s" % (p.get("id"), one_line(p.get("title"), 90)) for p in backlog[:10]]
            out += [""]
        evidence = [r for r in by_type.get("evidence", []) if r.get("id") in cited][:n_evidence]
        if evidence:
            out += ["### Evidence cited above", ""]
            out += [format_record("evidence", r) + "\n" for r in evidence]
        issues = by_type.get("issue", [])
        if issues:
            fact_numbers = {i["number"] for i in (facts.get("issues") or {}).get("items") or []}
            ranked = sorted(issues, key=lambda r: (r.get("state") != "open",
                                                   not any(str(r.get("url", "")).endswith("/%d" % n)
                                                           for n in fact_numbers)))
            out += ["### Issue register (compact: id | state | progress | title)", ""]
            out += [_issue_line(r) for r in ranked[:n_issues]]
            if len(issues) > n_issues:
                out.append("- ... %d more issue records not shown; they stay unchanged." % (len(issues) - n_issues))
            out.append("")
    git = facts.get("git") or {}
    out += ["## Facts", "", "Collected %s. Scripts gathered these facts; they are exact." % facts.get("collected"), "",
            "### Git", "",
            "- ref: %s (base %s from %s)" % (git.get("ref"), (git.get("base") or "none")[:7], git.get("base_source")),
            "- commits since base: %s (shown: %d)" % (git.get("commit_count"), min(n_commits, len(git.get("commits") or [])))]
    changed = git.get("changed_files") or {}
    out.append("- changed files: %s (+%s/-%s)" % (changed.get("count"), changed.get("insertions"), changed.get("deletions")))
    out += ["  - %s %s" % (f["status"], one_line(f["path"], 120)) for f in (changed.get("files") or [])[:n_files]]
    unc = git.get("uncommitted") or {}
    out.append("- uncommitted files: %s" % unc.get("count"))
    out += ["- branch %s at %s (%s)%s" % (b["name"], b["commit"], b["date"][:10],
                                          (" " + b["track"]) if b.get("track") else "")
            for b in (git.get("branches") or [])[:8]]
    out += ["- worktree %s on %s" % (one_line(w.get("path"), 100), w.get("branch") or "detached")
            for w in (git.get("worktrees") or [])[:8]]
    out += ["", "#### Commits (newest first; cite as the id shown)", ""]
    out += ["- ev-commit-%s | %s | %s%s" % (c["short"], c["date"][:10], "merge: " if c.get("merge") else "",
                                           one_line(c["subject"], 120))
            for c in (git.get("commits") or [])[:n_commits]]
    issues = facts.get("issues") or {}
    items = issues.get("items") or []
    out += ["", "### Issues", "",
            "- status: %s%s" % (issues.get("status"), (" (%s)" % issues.get("error")) if issues.get("error") else ""),
            "- checked: %s; updated since: %s; items: %d (shown: %d)%s" % (
                issues.get("checked"), issues.get("since") or "all", len(items), min(n_issues, len(items)),
                "; list truncated at the page limit" if issues.get("truncated") else ""), ""]
    out += ["- ev-issue-%d | #%d | %s | updated %s | %s" % (i["number"], i["number"], i["state"],
                                                           (i.get("updated") or "")[:10], one_line(i["title"], 100))
            for i in items[:n_issues]]
    out += ["", "## Handoff notes", ""]
    if not handoffs:
        out += ["None.", ""]
    for name, body in handoffs[:3]:
        out += ["### %s" % one_line(name, 80), "", body[:note_chars].strip() +
                ("\n[note truncated]" if len(body) > note_chars else ""), ""]
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------- orchestration

class Refresh:
    def __init__(self, config: Config, *, git=None, http_get=None, http=None, clock=None, pid_alive=None,
                 env=None, store=None, out=None, brief_module=None, render_module=None):
        self.config = config
        self.git = git or collect_mod.git_runner(config.repo_path)
        self.http_get = http_get
        self.http = http
        self.clock = clock or utc_now
        self.pid_alive = pid_alive
        self.env = os.environ if env is None else env
        self.out = out or (lambda text: print(text))
        self._store = store
        self._brief = brief_module
        self._render = render_module
        self.secrets: list = []
        self.state = config.state_dir
        self.queue = PendingQueue(self.state)
        self.last_good = LastGood(self.state)

    # -- helpers
    def now(self) -> str:
        return format_utc(self.clock())

    def path(self, name: str) -> Path:
        return self.state / name

    @property
    def store(self):
        if self._store is None:
            backend = self.config.store.get("backend")
            if backend == "openknowledge":
                self._store = OpenKnowledgeStore(project=self.config.store.get("project"),
                                                 page=self.config.store.get("page"), env=self.env)
            else:
                path = Path(self.config.store["path"]).expanduser()
                if not path.is_absolute():
                    path = self.config.repo_path / path
                self._store = LocalFileStore(path, root=self.config.repo_path)
        return self._store

    def brief(self):
        if self._brief is None:
            self._brief = _optional_module("tracker.brief")
        if self._brief is None:
            raise SynthesisError("tracker.brief is not available; the parser and validator are required")
        return self._brief

    def renderer(self):
        if self._render is None:
            self._render = _optional_module("tracker.render")
        if self._render is None:
            raise SynthesisError("tracker.render is not available")
        return self._render

    def log(self, event: str, **detail) -> None:
        entry = {"time": self.now(), "event": event}
        entry.update(detail)
        line = redact(json.dumps(entry, ensure_ascii=False), self.secrets)
        self.state.mkdir(parents=True, exist_ok=True)
        with open(self.path("log.jsonl"), "a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    def say(self, text: str) -> None:
        self.out(redact(text, self.secrets))

    def lock(self, command: str) -> RunLock:
        return RunLock(self.state, command=command, stale_seconds=self.config.stale_lock_seconds,
                       pid_alive=self.pid_alive, clock=self.clock)

    def _locked(self, command: str, func, *args, **kwargs) -> int:
        try:
            lock = self.lock(command).acquire()
        except LockBusy as exc:
            self.say("Refused: %s. Wait for it, or remove %s if that process is gone."
                     % (exc, home_relative(self.path("lock"))))
            return EXIT_BUSY
        try:
            run = RunState.load(self.state)
            if run:
                names = run.mark_interrupted(self.now())
                if names:
                    self.log("interrupted", run=run.run_id, stages=names,
                             stale_lock=bool(lock.recovered))
                    self.say("Recovered an interrupted run: %s will resume." % ", ".join(names))
            return func(*args, **kwargs)
        finally:
            lock.release()

    def _run(self) -> RunState | None:
        run = RunState.load(self.state)
        if run is None:
            self.say("No refresh run exists. Start one with: python3 -m tracker.refresh checkpoint")
        return run

    def _token(self) -> str | None:
        token = None
        if self.config.issues_token_file:
            try:
                token = Path(self.config.issues_token_file).expanduser().read_text(encoding="utf-8").strip()
            except OSError:
                token = None
        token = token or self.env.get(self.config.issues_token_env) or None
        if token:
            self.secrets.append(token)
        return token

    def _read(self, name: str) -> str | None:
        try:
            return self.path(name).read_text(encoding="utf-8")
        except FileNotFoundError:
            return None

    # -- checkpoint
    def _read_base(self) -> dict:
        try:
            text, revision = self.store.read()
            return {"text": text, "revision": revision, "source": "canonical" if text is not None else "none",
                    "reason": None}
        except StoreUnavailable as exc:
            reason = str(exc)
        pending = self.queue.load()
        if pending and self.queue.text() is not None:
            return {"text": self.queue.text(), "revision": pending.get("base_revision"), "source": "pending",
                    "reason": reason}
        info = self.last_good.load()
        if info and self.last_good.text() is not None:
            return {"text": self.last_good.text(), "revision": info.get("stored_revision"),
                    "source": "last-good", "reason": reason}
        return {"text": None, "revision": None, "source": "none", "reason": reason}

    def checkpoint(self, *, objective=None, blockers=(), boundaries=(), next_action=None,
                   handoffs=(), notes=()) -> int:
        now = self.clock()
        base = self._read_base()
        if base["reason"]:
            self.say("Canonical store unavailable (%s). Building on the %s brief." % (base["reason"], base["source"]))
        pending = self.queue.load()
        if pending and base["source"] == "canonical":
            self.say("Note: a queued brief waits in %s. Run `sync` to apply it, or this run supersedes it."
                     % home_relative(self.queue.dir))
        text = base["text"]
        if text is None:
            try:
                self.path("base.md").unlink()
            except FileNotFoundError:
                pass
        else:
            atomic_write(self.path("base.md"), text)
        write_json(self.path("base.json"), {"revision": base["revision"], "source": base["source"],
                                            "location": self.store.location, "sha256": sha256_text(text) if text else None,
                                            "store_reason": base["reason"]})
        meta = read_frontmatter(text)
        try:
            records = parse_fragment(text or "", strict=False)["records"]
        except FragmentError:
            records = []
        by_type: dict = {}
        for rtype, record, _ in records:
            by_type.setdefault(rtype, []).append(record)
        position = (by_type.get("position") or [{}])[0]
        recommended = next((p for p in by_type.get("path", []) if p.get("role") == "recommended"), {})
        prev_blockers = [a.get("blocker") for a in by_type.get("active", []) if a.get("blocker")]
        prev_blockers += [u.get("text") for u in by_type.get("unknown", []) if u.get("severity") == "critical"]
        gates = sorted(by_type.get("gate", []), key=lambda g: {"forbidden": 0, "approval": 1}.get(g.get("kind"), 2))
        head = collect_mod.head_ref(self.git)
        span = collect_mod.resolve_base(self.git, meta.get("ref"), meta.get("snapshot"))
        changed = collect_mod.changed_files(self.git, span["base"], 25)
        uncommitted = collect_mod.uncommitted_files(self.git, 15)
        run_id = new_run_id(now)
        packet = build_checkpoint(
            run_id=run_id, created=format_utc(now), repo=self.config.repo, repo_url=self.config.repo_url,
            ref=head["ref"], store_location=self.store.location,
            issues_source=(collect_mod.safe_https_url(self.config.repo_url) + "/issues") if collect_mod.safe_https_url(self.config.repo_url) else None,
            handoffs=[home_relative(Path(h).expanduser().resolve()) for h in handoffs],
            objective=objective or position.get("text") or "",
            changed_files=[f["path"] for f in changed["files"]], changed_count=changed["count"],
            uncommitted_files=uncommitted["files"], uncommitted_count=uncommitted["count"],
            blockers=list(blockers) + prev_blockers,
            boundaries=list(boundaries) + ["%s: %s" % (g.get("kind"), g.get("text")) for g in gates],
            next_safe_action=next_action or recommended.get("next_action") or "",
            previous={"location": self.store.location, "source": base["source"], "revision": base["revision"],
                      "sha256": sha256_text(text) if text else None, "snapshot": meta.get("snapshot"),
                      "ref": meta.get("ref"), "synthesis": meta.get("synthesis")},
            notes=notes,
        )
        path = save_checkpoint(self.state, packet)
        previous_run = read_json(self.path("run.json"))
        if previous_run:
            write_json(self.path("runs") / ("%s.json" % previous_run.get("run_id", "unknown")), previous_run)
        run = RunState.create(self.state, run_id=run_id, created=format_utc(now),
                              checkpoint_sha=sha256_text(path.read_bytes()), base_source=base["source"],
                              max_retries=self.config.max_retries)
        size = path.stat().st_size
        self.log("checkpoint", run=run_id, bytes=size, base_source=base["source"])
        self.say("Checkpoint saved: %s (%d bytes, limit %d). Run %s started (%s)."
                 % (home_relative(path), size, CHECKPOINT_MAX_BYTES, run_id, run.data["mode"]))
        return EXIT_OK

    # -- collect
    def collect(self) -> int:
        run = self._run()
        if not run:
            return EXIT_FAILED
        checkpoint = load_checkpoint(self.state) or {}
        try:
            if not run.begin("collect", run.data["checkpoint_sha256"], self.now()):
                self.say("collect: already done for this checkpoint.")
                return EXIT_OK
        except RetryLimit as exc:
            self.say(str(exc))
            return EXIT_FAILED
        previous = checkpoint.get("previous_brief") or {}
        try:
            facts = collect_mod.collect_facts(
                git=self.git, repo=self.config.repo, repo_url=self.config.repo_url,
                previous_ref=previous.get("ref"), previous_snapshot=previous.get("snapshot"),
                issues_api=self.config.issues_api, token=self._token(), http_get=self.http_get,
                max_commits=self.config.max_commits, max_pages=self.config.max_issue_pages,
                page_size=self.config.issue_page_size, now=self.clock())
        except collect_mod.CollectError as exc:
            run.fail("collect", redact(str(exc), self.secrets), self.now())
            self.log("collect-failed", run=run.run_id, error=str(exc))
            self.say("collect failed: %s" % exc)
            return EXIT_FAILED
        text = json.dumps(facts, indent=1, ensure_ascii=False) + "\n"
        atomic_write(self.path("facts.json"), text)
        run.finish("collect", self.now(), output_hash=sha256_text(text),
                   issues_status=facts["issues"]["status"])
        self.log("collect", run=run.run_id, commits=facts["git"]["commit_count"],
                 issues=len(facts["issues"]["items"]), issues_status=facts["issues"]["status"])
        issue_note = facts["issues"]["status"]
        if facts["issues"].get("error"):
            issue_note += " (%s)" % facts["issues"]["error"]
        since = ("since the %s" % facts["git"]["base_source"]) if facts["git"]["base"] else "(no previous brief)"
        self.say("Collected %d commits %s and %d issues (issues: %s)."
                 % (facts["git"]["commit_count"], since, len(facts["issues"]["items"]), issue_note))
        return EXIT_OK

    def _facts(self) -> dict | None:
        text = self._read("facts.json")
        return json.loads(text) if text else None

    # -- synthesis
    def prepare(self) -> int:
        run = self._run()
        facts = self._facts()
        if not run or facts is None or run.stage("collect")["status"] != "done":
            self.say("Collect facts first: python3 -m tracker.refresh collect")
            return EXIT_FAILED
        checkpoint = load_checkpoint(self.state) or {}
        handoffs = []
        for ref in (checkpoint.get("sources") or {}).get("handoffs") or []:
            try:
                handoffs.append((ref, Path(ref).expanduser().read_text(encoding="utf-8", errors="replace")))
            except OSError:
                handoffs.append((ref, "(handoff note could not be read)"))
        output = self.path("synthesis-output.md")
        packet = build_synthesis_packet(
            prompt=PROMPT_PATH.read_text(encoding="utf-8"), checkpoint=checkpoint,
            base_text=self._read("base.md"), facts=facts, handoffs=handoffs,
            output_path=home_relative(output), run_id=run.run_id, prepared=self.now())
        path = self.path("synthesis-input.md")
        atomic_write(path, packet)
        run.data["synthesis_packet"] = {"path": home_relative(path), "bytes": len(packet.encode("utf-8")),
                                        "sha256": sha256_text(packet), "output": home_relative(output)}
        run.save()
        self.log("prepare", run=run.run_id, bytes=len(packet.encode("utf-8")))
        self.say("Synthesis input: %s (%d bytes, limit %d).\nRun the model step in a fresh context with only "
                 "this file. It writes %s.\nThen: python3 -m tracker.refresh apply --synthesis %s\n"
                 "Without a model step: python3 -m tracker.refresh minimal"
                 % (home_relative(path), len(packet.encode("utf-8")), SYNTHESIS_PACKET_MAX_BYTES,
                    home_relative(output), home_relative(output)))
        return EXIT_OK

    def _base_model(self, brief) -> dict | None:
        text = self._read("base.md")
        if text is None:
            return None
        try:
            return brief.parse(text)
        except brief.BriefError as exc:
            raise SynthesisError("the previous brief does not parse; fix it before a refresh: %s"
                                 % one_line(exc, 200)) from None

    def _finish_model(self, model: dict, base: dict | None, facts: dict, synthesis: str) -> dict:
        meta = model["meta"]
        prev = (base or {}).get("meta") or {}
        meta.update(schema=BRIEF_SCHEMA, repo=prev.get("repo") or self.config.repo,
                    repo_url=prev.get("repo_url") or self.config.repo_url,
                    ref=(facts.get("git") or {}).get("ref") or prev.get("ref") or "unknown",
                    snapshot=self.now(), evidence_checked=facts.get("collected") or self.now(),
                    scope=prev.get("scope") or self.config.scope, synthesis=synthesis)
        meta["stale_after_days"] = int(meta.get("stale_after_days") or 7)
        if prev.get("snapshot"):
            meta["previous_snapshot"] = prev["snapshot"]
        else:
            meta.pop("previous_snapshot", None)
        model["title"] = model.get("title") or self.config.title
        apply_issue_facts(model, facts.get("issues") or {})
        add_fact_evidence(model, facts)
        return model

    def _check(self, brief, text: str) -> list:
        try:
            model = brief.parse(text)
        except brief.BriefError as exc:
            return ["parse: %s" % one_line(exc, 300)]
        return ["%s %s%s" % (d.code, d.message, (" (line %s)" % d.line) if d.line else "")
                for d in brief.validate(model) if d.level == "error"]

    def _minimal_text(self, reason: str) -> str:
        brief = self.brief()
        facts = self._facts() or {}
        base = self._base_model(brief)
        model = build_minimal(base, facts, repo=self.config.repo, repo_url=self.config.repo_url,
                              scope=self.config.scope, title=self.config.title, snapshot=self.now(), reason=reason)
        # A minimal brief carries its paths forward, so its prompt says so.
        model = handoff_mod.refresh(model, basis="carried-forward")
        text = brief.dump(model)
        errors = self._check(brief, text)
        if errors:
            raise SynthesisError("minimal brief failed validation: %s" % "; ".join(errors[:3]))
        return text

    def apply(self, synthesis_path, *, model_calls=None, input_tokens=None, output_tokens=None,
              model_runtime=None, fallback: bool = True) -> int:
        run = self._run()
        facts = self._facts()
        if not run or facts is None:
            self.say("Collect facts first: python3 -m tracker.refresh collect")
            return EXIT_FAILED
        if not run.data.get("synthesis_packet"):
            if self.prepare():
                return EXIT_FAILED
            run = RunState.load(self.state)
        try:
            output = Path(synthesis_path).expanduser().read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            output = None
        packet_sha = run.data["synthesis_packet"]["sha256"]
        input_hash = sha256_text("model", packet_sha, output)
        metrics = {"model_calls": model_calls, "input_tokens": input_tokens, "output_tokens": output_tokens,
                   "model_runtime_seconds": model_runtime}
        ignored = 0
        try:
            if not run.begin("synthesize", input_hash, self.now()):
                self.say("synthesize: this output is already applied.")
                return EXIT_OK
        except RetryLimit as exc:
            self.say(str(exc))
            return EXIT_FAILED
        try:
            brief = self.brief()
            if output is None:
                raise SynthesisError("model output file is missing or unreadable: %s" % home_relative(synthesis_path))
            fragment = parse_fragment(output)
            # The tool writes the next-session prompt; a handoff from the model is discarded.
            kept = [r for r in fragment["records"] if r[0] != "handoff"]
            ignored = len(fragment["records"]) - len(kept)
            fragment["records"] = kept
            if not fragment["records"]:
                raise SynthesisError("model output holds no records")
            base = self._base_model(brief)
            model = merge_update(base or empty_model({}, self.config.title), fragment)
            self._finish_model(model, base, facts, "model")
            model = handoff_mod.refresh(model, basis="current")
            text = brief.dump(model)
            errors = self._check(brief, text)
            if errors:
                raise SynthesisError("model output failed validation: %s" % "; ".join(errors[:3]))
        except (SynthesisError, FragmentError) as exc:
            reason = one_line(exc, 300)
            if not fallback or "does not parse" in reason or "not available" in reason:
                run.fail("synthesize", reason, self.now(), **metrics)
                self.log("synthesize-failed", run=run.run_id, error=reason)
                self.say("synthesize failed: %s" % reason)
                return EXIT_FAILED
            try:
                text = self._minimal_text(reason)
            except (SynthesisError, FragmentError) as exc2:
                run.fail("synthesize", "%s; minimal fallback failed: %s" % (reason, exc2), self.now(), **metrics)
                self.say("synthesize failed: %s; minimal fallback failed: %s" % (reason, exc2))
                return EXIT_FAILED
            atomic_write(self.path("candidate.md"), text)
            run.finish("synthesize", self.now(), output_hash=sha256_text(text), kind="minimal",
                       error="model output rejected: " + reason, **metrics)
            self.log("synthesize-minimal", run=run.run_id, reason=reason)
            self.say("Model output rejected (%s). Wrote a minimal brief from verified facts instead." % reason)
            return EXIT_OK
        atomic_write(self.path("synthesis-output.md"), output)
        atomic_write(self.path("candidate.md"), text)
        run.finish("synthesize", self.now(), output_hash=sha256_text(text), kind="model", **metrics)
        self.log("synthesize", run=run.run_id, kind="model", handoffs_ignored=ignored)
        if ignored:
            self.say("Ignored %d handoff record(s) in the model output. The tool writes the next-session prompt."
                     % ignored)
        self.say("Applied the model output. Candidate brief: %s" % home_relative(self.path("candidate.md")))
        return EXIT_OK

    def minimal(self, reason: str | None = None) -> int:
        run = self._run()
        facts = self._facts()
        if not run or facts is None:
            self.say("Collect facts first: python3 -m tracker.refresh collect")
            return EXIT_FAILED
        reason = reason or "no model step was run"
        input_hash = sha256_text("minimal", sha256_text(json.dumps(facts, sort_keys=True)),
                                 self._read("base.md"), reason)
        try:
            if not run.begin("synthesize", input_hash, self.now()):
                self.say("synthesize: the minimal brief is already built.")
                return EXIT_OK
        except RetryLimit as exc:
            self.say(str(exc))
            return EXIT_FAILED
        try:
            text = self._minimal_text(reason)
        except (SynthesisError, FragmentError) as exc:
            run.fail("synthesize", one_line(exc, 300), self.now(), model_calls=0)
            self.say("minimal brief failed: %s" % exc)
            return EXIT_FAILED
        atomic_write(self.path("candidate.md"), text)
        run.finish("synthesize", self.now(), output_hash=sha256_text(text), kind="minimal",
                   error="minimal brief: " + one_line(reason, 200))
        self.log("synthesize-minimal", run=run.run_id, reason=reason)
        self.say("Wrote a minimal brief from verified facts: %s" % home_relative(self.path("candidate.md")))
        return EXIT_OK

    # -- validate, render, store, publish
    def _candidate(self, run: RunState, stage: str) -> str | None:
        text = self._read("candidate.md")
        if text is None or run.stage("synthesize")["status"] != "done":
            self.say("%s: no candidate brief yet. Run apply or minimal first." % stage)
            return None
        return text

    def validate(self) -> int:
        run = self._run()
        text = run and self._candidate(run, "validate")
        if not text:
            return EXIT_FAILED
        try:
            if not run.begin("validate", sha256_text(text), self.now()):
                return EXIT_OK
            brief = self.brief()
        except (RetryLimit, SynthesisError) as exc:
            if run.stage("validate")["status"] == "running":
                run.fail("validate", str(exc), self.now())
            self.say(str(exc))
            return EXIT_FAILED
        try:
            model = brief.parse(text)
            diags = brief.validate(model)
        except brief.BriefError as exc:
            run.fail("validate", "parse: %s" % one_line(exc, 300), self.now())
            self.say("validate failed: %s" % exc)
            return EXIT_FAILED
        errors = ["%s %s" % (d.code, d.message) for d in diags if d.level == "error"]
        warnings = ["%s %s" % (d.code, d.message) for d in diags if d.level != "error"]
        if errors:
            run.fail("validate", "; ".join(errors[:5]), self.now())
            self.say("validate failed: %s" % "; ".join(errors[:5]))
            return EXIT_FAILED
        meta = model["meta"]
        self.last_good.save_brief(text, {"run_id": run.run_id, "validated": self.now(),
                                         "snapshot": meta.get("snapshot"), "synthesis": meta.get("synthesis"),
                                         "ref": meta.get("ref"), "warnings": warnings[:10]})
        run.finish("validate", self.now(), output_hash=sha256_text(text), warnings=warnings[:10])
        self.log("validate", run=run.run_id, warnings=len(warnings))
        self.say("Validated (%d warnings). Last-good brief: %s" % (len(warnings), home_relative(self.last_good.md_path)))
        return EXIT_OK

    def _stage_ready(self, run: RunState, stage: str, needs: str, text: str) -> bool:
        st = run.stage(needs)
        if st["status"] != "done" or st.get("output_hash") != sha256_text(text):
            self.say("%s: run %s first." % (stage, needs))
            return False
        return True

    def render(self) -> int:
        run = self._run()
        text = run and self._candidate(run, "render")
        if not text or not self._stage_ready(run, "render", "validate", text):
            return EXIT_FAILED
        try:
            if not run.begin("render", sha256_text(text), self.now()):
                return EXIT_OK
            html = self.renderer().render(self.brief().parse(text))
        except RetryLimit as exc:
            self.say(str(exc))
            return EXIT_FAILED
        except Exception as exc:  # renderer errors must leave the last-good files intact
            run.fail("render", one_line(exc, 300), self.now())
            self.say("render failed: %s" % one_line(exc, 300))
            return EXIT_FAILED
        atomic_write(self.path("candidate.html"), html)
        self.last_good.save_html(html, text)
        run.finish("render", self.now(), output_hash=sha256_text(html))
        self.log("render", run=run.run_id, bytes=len(html.encode("utf-8")))
        self.say("Rendered: %s" % home_relative(self.path("candidate.html")))
        return EXIT_OK

    def store_stage(self) -> int:
        run = self._run()
        text = run and self._candidate(run, "store")
        if not text or not self._stage_ready(run, "store", "validate", text):
            return EXIT_FAILED
        base = read_json(self.path("base.json")) or {}
        try:
            if not run.begin("store", sha256_text(text, base.get("revision")), self.now()):
                self.say("store: already done for this brief.")
                return EXIT_OK
        except RetryLimit as exc:
            self.say(str(exc))
            return EXIT_FAILED
        result = store_brief(self.store, self.queue, text, base_revision=base.get("revision"),
                             run_id=run.run_id, now=self.clock())
        self.log("store", run=run.run_id, result=result["result"])
        if result["result"] in ("stored", "unchanged"):
            self.last_good.mark_stored(text, result["revision"])
            run.finish("store", self.now(), output_hash=result["revision"], result=result["result"])
            self.say("Stored the brief in %s (%s)." % (self.store.location, result["result"]))
            return EXIT_OK
        if result["result"] == "pending":
            run.queue("store", "canonical store unavailable: %s; brief kept in the pending queue" % result["reason"],
                      self.now())
            self.say("Canonical store unavailable (%s). The brief waits in %s; run `sync` later."
                     % (result["reason"], home_relative(self.queue.dir)))
            return EXIT_OK
        run.fail("store", "conflict: %s; the owner's version is untouched and this brief is kept in the pending "
                          "queue. Start a new checkpoint to rebuild on the owner's version." % result["reason"],
                 self.now(), conflict=True)
        self.say("Conflict: %s. Nothing was overwritten. This brief is kept in %s. Run `checkpoint` and refresh "
                 "again to build on the newer version." % (result["reason"], home_relative(self.queue.dir)))
        return EXIT_FAILED

    def publish(self, *, replace: bool = False) -> int:
        run = self._run()
        if not run:
            return EXIT_FAILED
        cfg = self.config.publish
        if not cfg.get("endpoint") or not cfg.get("credential_file"):
            self.say("Publication is not configured. Set publish.endpoint and publish.credential_file in %s."
                     % home_relative(self.state / "config.json"))
            return EXIT_USAGE
        html = self._read("candidate.html")
        if html is None or run.stage("render")["status"] != "done" or \
                run.stage("render").get("output_hash") != sha256_text(html):
            self.say("publish: render the brief first.")
            return EXIT_FAILED
        if replace:
            run.stage("publish")["input_hash"] = None
        try:
            if not run.begin("publish", sha256_text(html), self.now()):
                record = read_json(self.path("publication.json")) or {}
                self.say("publish: already published: %s" % record.get("share_url"))
                return EXIT_OK
        except RetryLimit as exc:
            self.say(str(exc))
            return EXIT_FAILED
        try:
            publisher = Publisher(endpoint=cfg["endpoint"], credential_file=cfg["credential_file"],
                                  receipt_dir=cfg.get("receipt_dir") or DEFAULT_RECEIPT_DIR,
                                  repo_slug=self.config.slug, state_dir=self.state,
                                  title=cfg.get("title") or self.config.title, repo_root=self.config.repo_path,
                                  file_name=cfg.get("file_name") or DEFAULT_FILE_NAME, http=self.http,
                                  clock=self.clock)
            result = publisher.publish(html, replace=replace)
        except PublishError as exc:
            message = redact(str(exc), self.secrets)
            write_json(self.path("publish-queue.json"), {
                "queued": self.now(), "run_id": run.run_id, "error": message,
                "html": home_relative(self.path("candidate.html")), "html_sha256": sha256_text(html),
                "retry": "python3 -m tracker.refresh publish"})
            run.queue("publish", "publication failed: %s; retry queued, local brief kept" % message, self.now())
            self.log("publish-queued", run=run.run_id, error=message)
            self.say("Publication failed (%s). The local brief stays at %s. Retry: python3 -m tracker.refresh publish"
                     % (message, home_relative(self.path("candidate.html"))))
            return EXIT_FAILED
        try:
            self.path("publish-queue.json").unlink()
        except FileNotFoundError:
            pass
        run.finish("publish", self.now(), output_hash=result["content_sha256"], share_url=result["share_url"],
                   expires=result["expires"], verified=result["verified"], method=result["method"])
        self.log("publish", run=run.run_id, method=result["method"], verified=result["verified"])
        self.say("Published (%s): %s\nExpires: %s. Anyone who can reach the artifact service and has the link can read it."
                 % (result["method"], result["share_url"], result["expires"] or "unknown"))
        return EXIT_OK

    def sync(self, *, publish: bool = False) -> int:
        pending_text = self.queue.text()
        result = self.queue.sync(self.store, self.clock())
        self.log("sync", result=result["result"])
        run = RunState.load(self.state)
        if result["result"] == "applied":
            if pending_text is not None:
                self.last_good.mark_stored(pending_text, result["revision"])
            if run and run.stage("store")["status"] in ("queued", "interrupted"):
                run.finish("store", self.now(), output_hash=result["revision"], result="synced")
            self.say("Synced the queued brief to %s." % self.store.location)
        elif result["result"] == "empty":
            self.say("Nothing to sync.")
        elif result["result"] == "unavailable":
            self.say("Canonical store still unavailable: %s" % result["reason"])
            return EXIT_FAILED
        else:
            self.say("Conflict: the canonical brief changed after the queued brief was prepared. Both are kept: "
                     "the owner's version in %s and the queued one in %s. Run `checkpoint` to rebuild on the "
                     "owner's version." % (self.store.location, home_relative(self.queue.dir)))
            return EXIT_FAILED
        if publish and run and run.stage("publish")["status"] in ("queued", "interrupted"):
            return self.publish()
        return EXIT_OK

    # -- status
    def status_data(self) -> dict:
        """Everything `status` shows. Local files only: no network, no model call."""
        store_status = self.store.status()
        canonical = None
        if isinstance(self.store, LocalFileStore):
            try:
                text, revision = self.store.read()
            except StoreUnavailable:
                text, revision = None, None
            if text is not None:
                meta = read_frontmatter(text)
                canonical = {"snapshot": meta.get("snapshot"), "synthesis": meta.get("synthesis"),
                             "ref": meta.get("ref"), "stale_after_days": meta.get("stale_after_days"),
                             "revision": revision}
        run = RunState.load(self.state)
        run_data = None
        if run:
            run_data = {"run_id": run.run_id, "mode": run.data.get("mode"), "complete": run.data.get("complete"),
                        "stages": {n: {k: run.stage(n).get(k) for k in ("status", "attempts", "error", "kind",
                                                                         "reason", "runtime_seconds", "model_calls",
                                                                         "input_tokens", "output_tokens")}
                                   for n in STAGES},
                        "totals": run.totals()}
        lg = self.last_good.load()
        return {
            "repo": self.config.repo, "state_dir": home_relative(self.state), "store": store_status,
            "canonical": canonical,
            "last_good": dict(lg, path=home_relative(self.last_good.md_path),
                              html_path=home_relative(self.last_good.html_path) if lg.get("html") else None)
            if lg else None,
            "pending": self.queue.load(), "run": run_data,
            "publication": read_json(self.path("publication.json")),
            "publish_queue": read_json(self.path("publish-queue.json")),
            "lock": read_json(self.path("lock")) if self.path("lock").exists() else None,
            "checked": self.now(),
        }

    def status(self, *, as_json: bool = False) -> int:
        data = self.status_data()
        if as_json:
            self.say(json.dumps(data, indent=2))
            return EXIT_OK
        lines = ["Tracker brief: %s" % data["repo"]]
        store = data["store"]
        where = "%s (%s)" % (store["location"], store["backend"])
        if not store.get("available"):
            where += " - unavailable: %s" % store.get("reason")
        lines.append("  Canonical: " + where)
        brief = data["canonical"] or data["last_good"]
        if brief:
            snap = brief.get("snapshot")
            label = "canonical" if data["canonical"] else "last-good copy"
            age = ""
            when = parse_utc(snap)
            if when:
                days = (self.clock() - when).total_seconds() / 86400
                limit = int((brief.get("stale_after_days") or 7))
                age = " (%.0f days old%s)" % (days, ", STALE" if days > limit else "")
            lines.append("  Snapshot: %s%s, synthesis %s, ref %s [%s]"
                         % (snap, age, brief.get("synthesis"), brief.get("ref"), label))
        else:
            lines.append("  Snapshot: no brief yet")
        if data["last_good"]:
            lg = data["last_good"]
            lines.append("  Last good: %s%s" % (lg["path"], (" and " + lg["html_path"]) if lg.get("html_path") else ""))
        if data["pending"]:
            p = data["pending"]
            lines.append("  Pending: brief queued %s (%s)%s -> %s"
                         % (p.get("created"), p.get("reason"), " CONFLICT" if p.get("conflict") else "",
                            "run `checkpoint` and refresh again" if p.get("conflict") else "run `sync`"))
        run = data["run"]
        if run:
            parts = []
            for name, st in run["stages"].items():
                text = "%s %s" % (name, st["status"])
                if st.get("kind"):
                    text += " (%s)" % st["kind"]
                parts.append(text)
            lines.append("  Run %s (%s): %s" % (run["run_id"], run["mode"], ", ".join(parts)))
            for name, st in run["stages"].items():
                if st.get("error"):
                    lines.append("    %s: %s" % (name, st["error"]))
            totals = run["totals"]
            lines.append("  Cost: %.1f s local, model calls %s, tokens in %s / out %s"
                         % (totals["runtime_seconds"], _n(totals["model_calls"]), _n(totals["input_tokens"]),
                            _n(totals["output_tokens"])))
        else:
            lines.append("  Run: none")
        pub = data["publication"]
        if pub and pub.get("share_url"):
            lines.append("  Publication: %s (expires %s, %s)"
                         % (pub["share_url"], pub.get("expires") or "unknown",
                            "verified" if pub.get("verified") else "NOT verified"))
        if data["publish_queue"]:
            lines.append("  Publication retry queued: %s" % data["publish_queue"].get("error"))
        if data["lock"]:
            lines.append("  Lock: held by pid %s since %s" % (data["lock"].get("pid"), data["lock"].get("started")))
        lines.append("  Next: " + self._next_step(data))
        self.say("\n".join(lines))
        return EXIT_OK

    @staticmethod
    def _next_step(data: dict) -> str:
        run = data["run"]
        if data["pending"] and data["pending"].get("conflict"):
            return "python3 -m tracker.refresh checkpoint (rebuild on the owner's newer version)"
        if data["pending"]:
            return "python3 -m tracker.refresh sync"
        if not run or run["complete"]:
            return "python3 -m tracker.refresh run (starts a new checkpoint)"
        for name, st in run["stages"].items():
            if st["status"] in ("done", "skipped"):
                continue
            if name == "synthesize":
                return ("run the model step on synthesis-input.md, then `apply --synthesis FILE`; "
                        "or `minimal`")
            if name == "publish":
                return "python3 -m tracker.refresh publish (only when the owner asks)"
            return "python3 -m tracker.refresh run"
        return "nothing"

    # -- run
    def run_all(self, *, synthesis=None, use_minimal: bool = False, publish: bool = False,
                checkpoint_args: dict | None = None, metrics: dict | None = None) -> int:
        pending = self.queue.load()
        if pending and not pending.get("conflict"):
            result = self.queue.sync(self.store, self.clock())
            self.log("sync", result=result["result"])
            if result["result"] == "applied":
                self.say("Synced a queued brief to %s first." % self.store.location)
        run = RunState.load(self.state)
        if run is None or run.data.get("complete"):
            code = self.checkpoint(**(checkpoint_args or {}))
            if code:
                return code
            run = RunState.load(self.state)
        else:
            self.say("Resuming run %s." % run.run_id)
        if run.stage("collect")["status"] != "done":
            if self.collect():
                return EXIT_FAILED
            run = RunState.load(self.state)
        if run.stage("synthesize")["status"] != "done" or synthesis:
            if synthesis:
                code = self.apply(synthesis, **(metrics or {}))
            elif use_minimal:
                code = self.minimal()
            else:
                self.prepare()
                self.say("Waiting for the model step. Run it in a fresh context, then rerun with --synthesis FILE "
                         "(or --minimal).")
                return EXIT_WAITING
            if code:
                return code
        for step in (self.validate, self.render, self.store_stage):
            if step():
                return EXIT_FAILED
        run = RunState.load(self.state)
        if publish:
            if self.publish():
                return EXIT_FAILED
        elif run.stage("publish")["status"] == "pending":
            run.skip("publish", "publication not requested", self.now())
        self.say("Run complete. Brief: %s" % self.store.location)
        return EXIT_OK


def _n(value) -> str:
    return "unknown" if value is None else str(value)


# ---------------------------------------------------------------- CLI

def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m tracker.refresh", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo-path", help="repository to summarize (default: current directory)")
    parser.add_argument("--state-dir", help="state directory (default: ~/.pi/agent/tracker-state/<repo-slug>)")
    parser.add_argument("--config", help="JSON config file (default: <state dir>/config.json)")
    sub = parser.add_subparsers(dest="command", required=True)

    def checkpoint_flags(p):
        p.add_argument("--objective", help="current objective, one sentence")
        p.add_argument("--blocker", action="append", default=[], help="a known blocker (repeatable)")
        p.add_argument("--boundary", action="append", default=[], help="an approval boundary (repeatable)")
        p.add_argument("--next", dest="next_action", help="next safe action")
        p.add_argument("--handoff", action="append", default=[], help="short handoff note file (max 3)")
        p.add_argument("--note", action="append", default=[], help="short note (repeatable)")

    def metric_flags(p):
        p.add_argument("--model-calls", type=int, help="model calls the synthesis step made, when known")
        p.add_argument("--input-tokens", type=int, help="input tokens reported by the model step")
        p.add_argument("--output-tokens", type=int, help="output tokens reported by the model step")
        p.add_argument("--model-runtime", type=float, help="model step runtime in seconds")

    status = sub.add_parser("status", help="show brief location, freshness and unfinished work")
    status.add_argument("--json", action="store_true")
    checkpoint_flags(sub.add_parser("checkpoint", help="persist the bounded checkpoint; start a run"))
    sub.add_parser("collect", help="collect Git and issue facts")
    sub.add_parser("prepare", help="write the synthesis input packet")
    apply = sub.add_parser("apply", help="apply model output")
    apply.add_argument("--synthesis", required=True, help="model output file")
    apply.add_argument("--no-fallback", action="store_true", help="fail instead of writing a minimal brief")
    metric_flags(apply)
    minimal = sub.add_parser("minimal", help="build a minimal brief without a model")
    minimal.add_argument("--reason", help="why no model output is used")
    sub.add_parser("validate", help="validate the candidate brief")
    sub.add_parser("render", help="render the candidate brief to HTML")
    sub.add_parser("store", help="write the brief to the canonical store or the pending queue")
    publish = sub.add_parser("publish", help="publish the HTML (opt-in)")
    publish.add_argument("--replace", action="store_true", help="create a new link when the old one is gone")
    sync = sub.add_parser("sync", help="apply a queued brief to the canonical store")
    sync.add_argument("--publish", action="store_true", help="also retry a queued publication")
    run = sub.add_parser("run", help="resume all stages in order")
    group = run.add_mutually_exclusive_group()
    group.add_argument("--synthesis", help="model output file")
    group.add_argument("--minimal", action="store_true", help="use a minimal brief (no model step)")
    run.add_argument("--publish", action="store_true", help="also publish (opt-in)")
    checkpoint_flags(run)
    metric_flags(run)
    return parser


def main(argv=None, **deps) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_config(repo_path=args.repo_path, state_dir=args.state_dir, config_file=args.config,
                             env=deps.get("env"), git=deps.get("git"))
    except ConfigError as exc:
        print("Configuration error: %s" % exc, file=sys.stderr)
        return EXIT_USAGE
    refresh = Refresh(config, **deps)
    cmd = args.command
    if cmd == "status":
        return refresh.status(as_json=args.json)
    cp_args = {}
    if cmd in ("checkpoint", "run"):
        cp_args = {"objective": args.objective, "blockers": args.blocker, "boundaries": args.boundary,
                   "next_action": args.next_action, "handoffs": args.handoff[:3], "notes": args.note}
    metrics = {}
    if cmd in ("apply", "run"):
        metrics = {"model_calls": args.model_calls, "input_tokens": args.input_tokens,
                   "output_tokens": args.output_tokens, "model_runtime": args.model_runtime}
    actions = {
        "checkpoint": lambda: refresh.checkpoint(**cp_args),
        "collect": refresh.collect,
        "prepare": refresh.prepare,
        "apply": lambda: refresh.apply(args.synthesis, fallback=not args.no_fallback, **metrics),
        "minimal": lambda: refresh.minimal(args.reason),
        "validate": refresh.validate,
        "render": refresh.render,
        "store": refresh.store_stage,
        "publish": lambda: refresh.publish(replace=args.replace),
        "sync": lambda: refresh.sync(publish=args.publish),
        "run": lambda: refresh.run_all(synthesis=args.synthesis, use_minimal=args.minimal, publish=args.publish,
                                       checkpoint_args=cp_args, metrics=metrics),
    }
    try:
        return refresh._locked(cmd, actions[cmd])
    except collect_mod.CollectError as exc:
        print("Git error: %s" % redact(str(exc), refresh.secrets), file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
