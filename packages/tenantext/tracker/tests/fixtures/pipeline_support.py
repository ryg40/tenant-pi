"""Offline fakes for the content pipeline tests: Git repos, an issue API and an artifact service.

Load with `load_support()` from a test module. Nothing here opens a network socket.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent
REPO = "owner/demo"
REPO_URL = "https://git.example.com/owner/demo"
REMOTE = "https://git.example.com/owner/demo.git"
API = "https://git.example.com/api/v1"
ARTIFACTS = "https://artifacts.example.com"
EPOCH = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)
GIT_ENV = {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"}


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Clock:
    """A settable UTC clock."""

    def __init__(self, start: datetime = EPOCH):
        self.value = start

    def __call__(self) -> datetime:
        return self.value

    def advance(self, **delta) -> datetime:
        self.value = self.value + timedelta(**delta)
        return self.value


# ---------------------------------------------------------------- git

def git(repo: Path, *args: str) -> str:
    env = dict(os.environ, **GIT_ENV)
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True,
                          env=env).stdout


def _fast_import(repo: Path, stream: str) -> None:
    env = dict(os.environ, **GIT_ENV)
    subprocess.run(["git", "-C", str(repo), "fast-import", "--quiet"], input=stream.encode("utf-8"),
                   check=True, capture_output=True, env=env)


def _data(text: str) -> str:
    return "data %d\n%s" % (len(text.encode("utf-8")), text)


def make_repo(path: Path, commits: int = 5, *, start: datetime = EPOCH, merge_every: int = 0,
              prefix: str = "Change") -> Path:
    """Create a repo with `commits` main-line commits, one per hour from `start`."""
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "remote", "add", "origin", REMOTE)
    add_commits(path, commits, start=start, merge_every=merge_every, prefix=prefix, first=True)
    return path


def add_commits(path: Path, commits: int, *, start: datetime, merge_every: int = 0, prefix: str = "Change",
                first: bool = False) -> None:
    lines = []
    mark = 0
    parent = None if first else "refs/heads/main^0"
    for i in range(commits):
        when = int((start + timedelta(hours=i)).timestamp())
        who = "Dev <dev@example.com> %d +0000" % when
        if merge_every and i % merge_every == merge_every - 1 and parent is not None:
            mark += 1
            side = ":%d" % mark
            lines += ["commit refs/heads/topic-%d" % i, "mark %s" % side, "author " + who, "committer " + who,
                      _data("%s topic %d" % (prefix, i)), "from %s" % parent,
                      "M 100644 inline topic-%d.txt" % i, _data("topic %d" % i), ""]
            mark += 1
            lines += ["commit refs/heads/main", "mark :%d" % mark, "author " + who, "committer " + who,
                      _data("Merge pull request 'Topic %d' (#%d) from topic-%d into main" % (i, 100 + i, i)),
                      "from %s" % parent, "merge %s" % side, ""]
        else:
            mark += 1
            lines += ["commit refs/heads/main", "mark :%d" % mark, "author " + who, "committer " + who,
                      _data("%s %d" % (prefix, i))]
            if parent:
                lines.append("from %s" % parent)
            lines += ["M 100644 inline file-%d.txt" % (i % 7), _data("%s %d" % (prefix, i)), ""]
        parent = ":%d" % mark
    _fast_import(path, "\n".join(lines) + "\n")
    git(path, "reset", "-q", "--hard", "main")


def head_short(path: Path) -> str:
    return git(path, "rev-parse", "--short=7", "HEAD").strip()


# ---------------------------------------------------------------- issue API

def issue(number: int, *, state: str = "open", updated: datetime = EPOCH, title: str | None = None,
          pr: bool = False) -> dict:
    return {
        "number": number, "title": title or ("Issue %d" % number), "state": state,
        "html_url": "%s/%s/%d" % (REPO_URL, "pulls" if pr else "issues", number),
        "updated_at": iso(updated), "closed_at": iso(updated) if state == "closed" else None,
        "labels": [{"name": "demo"}], "milestone": None, "comments": 0,
        "pull_request": {"merged": False} if pr else None,
    }


class FakeIssueAPI:
    """Gitea-style issue list with pagination. It returns pull requests too, like `type=all`."""

    def __init__(self, items: list, *, fail_status: int | None = None, raise_error: Exception | None = None):
        self.items = items
        self.calls: list = []
        self.fail_status = fail_status
        self.raise_error = raise_error

    def __call__(self, url: str, headers: dict) -> tuple:
        self.calls.append((url, dict(headers)))
        if self.raise_error:
            raise self.raise_error
        if self.fail_status:
            return self.fail_status, {}, b'{"message":"boom"}'
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        state = query["state"][0]
        page, limit = int(query["page"][0]), int(query["limit"][0])
        since = query.get("since", [None])[0]
        rows = [i for i in self.items if i["state"] == state and (not since or i["updated_at"] >= since)]
        rows.sort(key=lambda i: (i["updated_at"], i["number"]), reverse=True)
        chunk = rows[(page - 1) * limit: page * limit]
        return 200, {"x-total-count": str(len(rows))}, json.dumps(chunk).encode("utf-8")


# ---------------------------------------------------------------- artifact service

class FakeArtifactService:
    """Artifact API v1 fake: idempotent POST, PUT with edit token, GET share link."""

    def __init__(self, token: str, *, edit_prefix: str = "EDIT", edit_header: str = "X-Edit-Token"):
        self.token = token
        self.edit_header = edit_header
        self.edit_prefix = edit_prefix
        self.artifacts: dict = {}
        self.keys: dict = {}
        self.requests: list = []
        self.plan: list = []  # per-request overrides: int status, "network", "lose-response", "corrupt"

    def _auth(self, headers: dict) -> bool:
        return headers.get("Authorization") == "Bearer " + self.token

    def __call__(self, method: str, url: str, headers: dict, body: bytes | None) -> tuple:
        self.requests.append({"method": method, "url": url, "headers": dict(headers)})
        action = self.plan.pop(0) if self.plan else None
        if action == "network":
            raise OSError("connection reset by peer")
        if isinstance(action, int):
            return action, {}, json.dumps({"code": "injected"}).encode()
        path = urllib.parse.urlsplit(url).path
        if method == "GET" and path.startswith("/a/"):
            slug = path[3:]
            art = self.artifacts.get(slug)
            if not art:
                return 404, {}, b""
            content = art["content"] + ("<!-- changed -->" if action == "corrupt" else "")
            return 200, {"content-type": "text/html"}, content.encode("utf-8")
        if not self._auth(headers):
            return 401, {}, b'{"code":"unauthorized"}'
        payload = json.loads(body.decode("utf-8")) if body else {}
        if method == "POST" and path == "/v1/artifacts":
            key = headers.get("Idempotency-Key")
            digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            if key in self.keys:
                slug, old = self.keys[key]
                if old != digest:
                    return 409, {}, b'{"code":"idempotency_conflict"}'
                result = self._item(slug, with_token=True)
            else:
                slug = hashlib.sha256(key.encode()).hexdigest()[:32]
                self.keys[key] = (slug, digest)
                self.artifacts[slug] = {"content": payload["content"], "title": payload.get("title"),
                                        "edit": "%s-%s" % (self.edit_prefix, slug[:8]), "version": 1}
                result = self._item(slug, with_token=True)
            if action == "lose-response":
                raise OSError("response lost after commit")
            return 201, {}, json.dumps(result).encode("utf-8")
        if method == "PUT" and path.startswith("/v1/artifacts/"):
            slug = path.rsplit("/", 1)[-1]
            art = self.artifacts.get(slug)
            if not art:
                return 404, {}, b'{"code":"artifact_not_found"}'
            if headers.get(self.edit_header) != art["edit"]:
                return 403, {}, b'{"code":"invalid_edit_token"}'
            art["content"] = payload["content"]
            art["version"] += 1
            return 200, {}, json.dumps(self._item(slug)).encode("utf-8")
        return 404, {}, b'{"code":"not_found"}'

    def _item(self, slug: str, with_token: bool = False) -> dict:
        art = self.artifacts[slug]
        item = {"artifact": {"version": 1, "slug": slug, "title": art["title"], "expiresAt": "2026-10-23T06:00:00.000Z",
                             "updatedAt": "2026-09-23T06:00:00.000Z"},
                "shareUrl": "%s/a/%s" % (ARTIFACTS, slug)}
        if with_token:
            item["editToken"] = art["edit"]
        return item


# ---------------------------------------------------------------- briefs and config

def previous_brief(base: str, snapshot: str) -> str:
    """Previous brief fixture at commit `base` (short hash) and time `snapshot`."""
    text = (FIXTURES / "pipeline-previous-brief.md").read_text(encoding="utf-8")
    return text.replace("@BASE@", base).replace("@SNAPSHOT@", snapshot)


def synthesis(name: str, head: str = "") -> str:
    return (FIXTURES / name).read_text(encoding="utf-8").replace("@HEAD@", head)


def write_config(state_dir: Path, **overrides) -> Path:
    data = {"repo": REPO, "repo_url": REPO_URL, "issues": {"api": API}, "store": {"path": "docs/tracker-brief.md"}}
    data.update(overrides)
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "config.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def all_text(*roots: Path) -> str:
    """Concatenate every file under the roots (skipping .git), for secret scans."""
    chunks = []
    for root in roots:
        for path in sorted(Path(root).rglob("*")):
            if path.is_file() and ".git" not in path.parts:
                chunks.append(path.read_bytes().decode("utf-8", "replace"))
    return "\n".join(chunks)
