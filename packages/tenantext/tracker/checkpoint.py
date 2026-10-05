"""Bounded checkpoint packet, run lock and resumable stage state for a brief refresh.

The checkpoint is written before any background work. It holds only pointers and
short facts, so a fresh context can continue from it without the parent session.
This module has no network code and starts no processes.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

CHECKPOINT_SCHEMA = "tracker-checkpoint/1"
RUN_SCHEMA = "tracker-run/1"

# Hard size limit for checkpoint.json. The near-context-limit handoff depends on it:
# the packet stays under this many UTF-8 bytes regardless of session or repo size.
CHECKPOINT_MAX_BYTES = 8192

STAGES = ("collect", "synthesize", "validate", "render", "store", "publish")
STATUSES = ("pending", "running", "done", "failed", "queued", "skipped", "interrupted")
DEFAULT_MAX_RETRIES = 2
DEFAULT_STALE_LOCK_SECONDS = 3600

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


# ---------------------------------------------------------------- utilities

def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def format_utc(value: datetime) -> str:
    """Return the contract timestamp form YYYY-MM-DDTHH:MM:SSZ."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def sha256_text(*parts: str | bytes | None) -> str:
    digest = hashlib.sha256()
    for part in parts:
        if part is None:
            part = b"\x00none"
        if isinstance(part, str):
            part = part.encode("utf-8")
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.hexdigest()


def one_line(text, limit: int | None = None) -> str:
    """Collapse whitespace, drop control characters and clip to `limit` characters."""
    if text is None:
        return ""
    value = _CONTROL.sub(" ", str(text))
    value = " ".join(value.split())
    if limit is not None and len(value) > limit:
        value = value[: max(0, limit - 3)].rstrip() + "..."
    return value


def clip_words(text: str, limit: int) -> str:
    words = one_line(text).split()
    if len(words) <= limit:
        return " ".join(words)
    return " ".join(words[: limit - 1]) + " ..."


def redact(text, secrets) -> str:
    """Replace every known secret value in `text`. Used on all error and log text."""
    value = "" if text is None else str(text)
    for secret in secrets or ():
        if secret and len(secret) >= 4:
            value = value.replace(secret, "[redacted]")
    return value


def atomic_write(path: Path, data: str | bytes, mode: int = 0o644) -> None:
    """Write through a temporary file and rename, so readers never see half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def write_json(path: Path, data, mode: int = 0o644) -> None:
    atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n", mode)


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def home_relative(path) -> str:
    """Show a path with the home directory as `~`, so packets do not carry user names."""
    text = str(path)
    home = os.path.expanduser("~")
    if home and home != "/" and (text == home or text.startswith(home + os.sep)):
        return "~" + text[len(home):]
    return text


def new_run_id(now: datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]


# ---------------------------------------------------------------- checkpoint packet

_TEXT_LIMIT = 300
_ITEM_LIMIT = 200
_PATH_LIMIT = 160


def _clip_list(items, count: int, limit: int) -> list[str]:
    out = []
    for item in items or ():
        text = one_line(item, limit)
        if text and text not in out:
            out.append(text)
        if len(out) >= count:
            break
    return out


def build_checkpoint(*, run_id: str, created: str, repo: str, repo_url: str, ref: str,
                     store_location: str, issues_source: str | None = None,
                     handoffs=(), objective: str = "", changed_files=(), changed_count: int | None = None,
                     uncommitted_files=(), uncommitted_count: int | None = None,
                     blockers=(), boundaries=(), next_safe_action: str = "",
                     previous: dict | None = None, notes=()) -> dict:
    """Build the bounded checkpoint packet. The result always fits CHECKPOINT_MAX_BYTES."""
    changed_files = list(changed_files or ())
    uncommitted_files = list(uncommitted_files or ())
    previous = previous or {}
    packet = {
        "schema": CHECKPOINT_SCHEMA,
        "run": one_line(run_id, 64),
        "created": created,
        "repo": one_line(repo, _ITEM_LIMIT),
        "repo_url": one_line(repo_url, _ITEM_LIMIT),
        "ref": one_line(ref, 120),
        "sources": {
            "brief": one_line(store_location, _ITEM_LIMIT),
            "issues": one_line(issues_source, _ITEM_LIMIT) or None,
            "handoffs": _clip_list(handoffs, 3, _PATH_LIMIT),
        },
        "objective": one_line(objective, _TEXT_LIMIT),
        "changed_files": {
            "count": changed_count if changed_count is not None else len(changed_files),
            "files": _clip_list(changed_files, 25, _PATH_LIMIT),
        },
        "uncommitted_files": {
            "count": uncommitted_count if uncommitted_count is not None else len(uncommitted_files),
            "files": _clip_list(uncommitted_files, 15, _PATH_LIMIT),
        },
        "blockers": _clip_list(blockers, 5, _ITEM_LIMIT),
        "approval_boundaries": _clip_list(boundaries, 6, _ITEM_LIMIT),
        "next_safe_action": one_line(next_safe_action, _TEXT_LIMIT),
        "notes": _clip_list(notes, 3, _ITEM_LIMIT),
        "previous_brief": {
            key: one_line(previous.get(key), 120) or None
            for key in ("location", "source", "revision", "sha256", "snapshot", "ref", "synthesis")
        },
    }
    return fit_checkpoint(packet)


def encode_checkpoint(packet: dict) -> bytes:
    return (json.dumps(packet, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


def fit_checkpoint(packet: dict) -> dict:
    """Shrink lists, then text, until the packet fits CHECKPOINT_MAX_BYTES."""
    shrink_lists = [
        ("changed_files", "files"), ("uncommitted_files", "files"), ("sources", "handoffs"),
        (None, "notes"), (None, "blockers"), (None, "approval_boundaries"),
    ]
    for _ in range(64):
        if len(encode_checkpoint(packet)) <= CHECKPOINT_MAX_BYTES:
            return packet
        changed = False
        for parent, key in shrink_lists:
            holder = packet[parent] if parent else packet
            items = holder.get(key) or []
            if len(items) > 1:
                holder[key] = items[: len(items) // 2]
                changed = True
                break
        if changed:
            continue
        for key in ("objective", "next_safe_action"):
            if len(packet[key]) > 80:
                packet[key] = one_line(packet[key], len(packet[key]) // 2)
                changed = True
        if not changed:
            break
    if len(encode_checkpoint(packet)) > CHECKPOINT_MAX_BYTES:
        raise ValueError("checkpoint packet cannot fit %d bytes" % CHECKPOINT_MAX_BYTES)
    return packet


def save_checkpoint(state_dir: Path, packet: dict) -> Path:
    data = encode_checkpoint(fit_checkpoint(packet))
    path = Path(state_dir) / "checkpoint.json"
    atomic_write(path, data)
    return path


def load_checkpoint(state_dir: Path) -> dict | None:
    return read_json(Path(state_dir) / "checkpoint.json")


# ---------------------------------------------------------------- lock

class LockBusy(RuntimeError):
    def __init__(self, holder: dict):
        self.holder = holder
        super().__init__(
            "another refresh holds the lock (pid %s on %s, command %s, since %s)"
            % (holder.get("pid"), holder.get("host"), holder.get("command"), holder.get("started"))
        )


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (TypeError, ValueError, OverflowError):
        return False
    return True


class RunLock:
    """Exclusive lock file with stale-lock detection.

    A lock is stale when its process is gone on this host, or when it is older than
    `stale_seconds` and was taken on another host. A live local holder always wins.
    """

    def __init__(self, state_dir: Path, *, command: str = "refresh",
                 stale_seconds: int = DEFAULT_STALE_LOCK_SECONDS, pid_alive=None, clock=None,
                 host: str | None = None, pid: int | None = None):
        self.path = Path(state_dir) / "lock"
        self.command = command
        self.stale_seconds = stale_seconds
        self.pid_alive = pid_alive or _pid_alive
        self.clock = clock or utc_now
        self.host = host or os.uname().nodename
        self.pid = pid if pid is not None else os.getpid()
        self.token = uuid.uuid4().hex
        self.recovered: dict | None = None

    def _holder(self) -> dict | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            return {"corrupt": True}

    def _is_stale(self, holder: dict) -> bool:
        now = self.clock()
        if holder.get("corrupt"):
            try:
                age = now.timestamp() - self.path.stat().st_mtime
            except FileNotFoundError:
                return True
            return age > 60
        started = parse_utc(holder.get("started"))
        age = (now - started).total_seconds() if started else float("inf")
        if holder.get("host") == self.host:
            return not self.pid_alive(holder.get("pid"))
        return age > self.stale_seconds

    def acquire(self) -> "RunLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(2):
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                holder = self._holder()
                if holder is None:
                    continue
                if attempt == 0 and self._is_stale(holder):
                    stamp = self.clock().strftime("%Y%m%dT%H%M%SZ")
                    try:
                        os.replace(self.path, self.path.with_name("lock.stale-" + stamp))
                    except FileNotFoundError:
                        pass
                    self.recovered = holder
                    continue
                raise LockBusy(holder)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"pid": self.pid, "host": self.host, "command": self.command,
                           "started": format_utc(self.clock()), "token": self.token}, handle)
            return self
        raise LockBusy(self._holder() or {})

    def release(self) -> None:
        holder = self._holder()
        if holder and holder.get("token") == self.token:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
        return False


# ---------------------------------------------------------------- run state

class RetryLimit(RuntimeError):
    pass


def _empty_stage() -> dict:
    return {
        "status": "pending", "attempts": 0, "failures": 0, "error": None,
        "input_hash": None, "output_hash": None, "started": None, "finished": None,
        "runtime_seconds": None, "model_calls": None, "input_tokens": None, "output_tokens": None,
    }


class RunState:
    """Per-run stage state machine persisted in run.json.

    Stage order: collect -> synthesize -> validate -> render -> store -> publish.
    A stage that is done with the same input hash is a no-op on rerun.
    Failed attempts are bounded by max_retries (a stage may fail max_retries + 1 times).
    """

    def __init__(self, path: Path, data: dict):
        self.path = Path(path)
        self.data = data
        self._clock_start: dict[str, float] = {}

    @classmethod
    def create(cls, state_dir: Path, *, run_id: str, created: str, checkpoint_sha: str,
               base_source: str, max_retries: int = DEFAULT_MAX_RETRIES) -> "RunState":
        data = {
            "schema": RUN_SCHEMA,
            "run_id": run_id,
            "created": created,
            "checkpoint_sha256": checkpoint_sha,
            "mode": "incremental" if base_source not in (None, "none") else "initial",
            "base_source": base_source,
            "max_retries": int(max_retries),
            "complete": False,
            "completed": None,
            "stages": {name: _empty_stage() for name in STAGES},
        }
        state = cls(Path(state_dir) / "run.json", data)
        state.save()
        return state

    @classmethod
    def load(cls, state_dir: Path) -> "RunState | None":
        path = Path(state_dir) / "run.json"
        data = read_json(path)
        if data is None:
            return None
        for name in STAGES:
            data["stages"].setdefault(name, _empty_stage())
        return cls(path, data)

    def save(self) -> None:
        write_json(self.path, self.data)

    @property
    def run_id(self) -> str:
        return self.data["run_id"]

    @property
    def max_retries(self) -> int:
        return int(self.data.get("max_retries", DEFAULT_MAX_RETRIES))

    def stage(self, name: str) -> dict:
        if name not in STAGES:
            raise KeyError(name)
        return self.data["stages"][name]

    def is_current(self, name: str, input_hash: str | None) -> bool:
        st = self.stage(name)
        return st["status"] == "done" and input_hash is not None and st["input_hash"] == input_hash

    def begin(self, name: str, input_hash: str | None, now: str) -> bool:
        """Mark a stage running. Returns False when it is already done for this input."""
        st = self.stage(name)
        if self.is_current(name, input_hash):
            return False
        if st["failures"] > self.max_retries:
            raise RetryLimit(
                "%s failed %d times; the retry limit is %d. Start a new checkpoint to try again."
                % (name, st["failures"], self.max_retries)
            )
        st.update(status="running", attempts=st["attempts"] + 1, input_hash=input_hash,
                  started=now, finished=None, error=None)
        self._clock_start[name] = time.monotonic()
        self.data["complete"] = False
        self.data["completed"] = None
        self.save()
        return True

    def _elapsed(self, name: str):
        start = self._clock_start.pop(name, None)
        return None if start is None else round(time.monotonic() - start, 3)

    def _end(self, name: str, status: str, now: str, metrics: dict) -> None:
        st = self.stage(name)
        st["status"] = status
        st["finished"] = now
        elapsed = self._elapsed(name)
        if elapsed is not None:
            st["runtime_seconds"] = elapsed
        for key, value in metrics.items():
            st[key] = value
        self._update_complete(now)
        self.save()

    @staticmethod
    def _scripted(metrics: dict) -> dict:
        # Scripted stages call no model, so zero is a measured value, not a guess.
        for key in ("model_calls", "input_tokens", "output_tokens"):
            metrics.setdefault(key, 0)
        return metrics

    def finish(self, name: str, now: str, *, output_hash: str | None = None, **metrics) -> None:
        self._scripted(metrics)
        self.stage(name)["error"] = metrics.pop("error", None)
        self._end(name, "done", now, dict(metrics, output_hash=output_hash))

    def fail(self, name: str, error: str, now: str, **metrics) -> None:
        st = self.stage(name)
        st["failures"] += 1
        st["error"] = one_line(error, 500)
        self._end(name, "failed", now, self._scripted(metrics))

    def queue(self, name: str, error: str, now: str, **metrics) -> None:
        st = self.stage(name)
        st["failures"] += 1
        st["error"] = one_line(error, 500)
        self._end(name, "queued", now, self._scripted(metrics))

    def skip(self, name: str, reason: str, now: str) -> None:
        st = self.stage(name)
        st["error"] = None
        st["reason"] = one_line(reason, 200)
        self._end(name, "skipped", now, self._scripted({}))

    def mark_interrupted(self, now: str) -> list[str]:
        """Mark stages left `running` by a dead process. Returns their names."""
        names = []
        for name in STAGES:
            st = self.stage(name)
            if st["status"] == "running":
                st["status"] = "interrupted"
                st["failures"] += 1
                st["error"] = "interrupted: the previous process stopped during this stage"
                st["finished"] = now
                names.append(name)
        if names:
            self.save()
        return names

    def _update_complete(self, now: str) -> None:
        done = all(self.stage(n)["status"] in ("done", "skipped") for n in STAGES)
        self.data["complete"] = done
        self.data["completed"] = now if done else None

    def unfinished(self) -> list[tuple[str, dict]]:
        return [(n, self.stage(n)) for n in STAGES if self.stage(n)["status"] not in ("done", "skipped")]

    def totals(self) -> dict:
        runtime = 0.0
        totals = {"runtime_seconds": 0.0, "model_calls": 0, "input_tokens": 0, "output_tokens": 0}
        for name in STAGES:
            st = self.stage(name)
            runtime += st.get("runtime_seconds") or 0.0
            for key in ("model_calls", "input_tokens", "output_tokens"):
                if st["status"] not in ("done", "failed", "queued", "skipped"):
                    continue
                if st.get(key) is None or totals[key] is None:
                    totals[key] = None
                else:
                    totals[key] += st[key]
        totals["runtime_seconds"] = round(runtime, 3)
        return totals
