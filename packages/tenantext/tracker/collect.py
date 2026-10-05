"""Collect exact Git and issue facts for a tracker brief.

Scripts gather the facts; no model is involved. The output is a bounded JSON facts
packet with source URLs and `checked` timestamps.

Network code lives only here and in tracker.publish. Git runs through an injected
runner and issue HTTP through an injected getter, so tests stay offline.
The issue API base and the token source are configuration, never constants.
The token only travels in a request header. It never enters the facts packet.
"""
from __future__ import annotations

import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from tracker.checkpoint import format_utc, home_relative, one_line, parse_utc, redact, utc_now

FACTS_SCHEMA = "tracker-facts/1"
DEFAULT_MAX_COMMITS = 30
DEFAULT_MAX_FILES = 40
DEFAULT_MAX_BRANCHES = 12
DEFAULT_MAX_WORKTREES = 12
DEFAULT_PAGE_SIZE = 50
DEFAULT_MAX_PAGES = 4
_SEP = "\x1f"


class CollectError(RuntimeError):
    pass


GitRunner = Callable[[list], str]
HttpGet = Callable[[str, dict], tuple]


# ---------------------------------------------------------------- repository identity

def safe_https_url(url: str | None) -> str | None:
    """Return the URL when it is credential-free HTTPS, else None."""
    if not url:
        return None
    parts = urllib.parse.urlsplit(url.strip())
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return None
    return urllib.parse.urlunsplit(parts)


def remote_identity(url: str) -> dict | None:
    """Turn a Git remote URL into {repo, repo_url, host}. Credentials are dropped."""
    url = (url or "").strip()
    if not url:
        return None
    match = re.match(r"^(?:ssh://)?[^@/\s]+@([^:/\s]+)(?::\d+)?[:/](.+?)(?:\.git)?/?$", url)
    if match and not url.startswith(("https://", "http://")):
        host, path = match.group(1), match.group(2)
    else:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("https", "http") or not parts.hostname:
            return None
        host = parts.hostname + (":%d" % parts.port if parts.port else "")
        path = parts.path.strip("/")
        if path.endswith(".git"):
            path = path[:-4]
    segments = [s for s in path.strip("/").split("/") if s]
    if len(segments) < 2:
        return None
    repo = "/".join(segments[-2:])
    return {"repo": repo, "repo_url": "https://%s/%s" % (host, "/".join(segments)), "host": host}


def repo_slug(repo: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (repo or "repo").lower()).strip("-")
    return slug[:64] or "repo"


def parse_ref(ref: str | None) -> tuple[str | None, str | None]:
    """Split `branch@commit` into its parts."""
    if not ref:
        return None, None
    if "@" in ref:
        branch, _, commit = ref.rpartition("@")
        return branch or None, commit or None
    if re.fullmatch(r"[0-9a-f]{7,40}", ref):
        return None, ref
    return ref, None


# ---------------------------------------------------------------- git

def git_runner(repo_path) -> GitRunner:
    """Return a runner for `git -C repo_path ...`. Local process only, no network."""
    repo_path = str(repo_path)

    def run(args: list) -> str:
        try:
            proc = subprocess.run(["git", "-C", repo_path, *args], capture_output=True,
                                  text=True, timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise CollectError("git %s could not run: %s" % (args[0], exc)) from exc
        if proc.returncode != 0:
            raise CollectError("git %s failed: %s" % (args[0], one_line(proc.stderr, 200)))
        return proc.stdout

    return run


def _try(git: GitRunner, args: list) -> str | None:
    try:
        return git(args)
    except CollectError:
        return None


def repo_root(git: GitRunner) -> Path:
    return Path(git(["rev-parse", "--show-toplevel"]).strip())


def origin_identity(git: GitRunner) -> dict | None:
    url = _try(git, ["remote", "get-url", "origin"])
    return remote_identity(url.strip()) if url else None


def head_ref(git: GitRunner) -> dict:
    head = git(["rev-parse", "HEAD"]).strip()
    short = git(["rev-parse", "--short=7", "HEAD"]).strip()
    branch = (_try(git, ["rev-parse", "--abbrev-ref", "HEAD"]) or "HEAD").strip()
    return {"head": head, "short": short, "branch": branch, "ref": "%s@%s" % (branch, short)}


def resolve_base(git: GitRunner, previous_ref: str | None, previous_snapshot: str | None) -> dict:
    """Find the commit the previous brief described.

    Prefer the commit in the previous `ref`. Fall back to the last commit before the
    previous `snapshot` time. Return base None when neither is known.
    """
    _, commit = parse_ref(previous_ref)
    if commit:
        full = _try(git, ["rev-parse", "--verify", "--quiet", commit + "^{commit}"])
        if full and full.strip():
            return {"base": full.strip(), "base_source": "previous ref"}
    when = parse_utc(previous_snapshot)
    if when:
        found = _try(git, ["rev-list", "-1", "--before=" + format_utc(when), "HEAD"])
        if found and found.strip():
            return {"base": found.strip(), "base_source": "previous snapshot time"}
        return {"base": None, "base_source": "previous snapshot time (no older commit)"}
    return {"base": None, "base_source": "none"}


def changed_files(git: GitRunner, base: str | None, limit: int = DEFAULT_MAX_FILES) -> dict:
    if not base:
        return {"count": 0, "files": [], "insertions": None, "deletions": None, "truncated": False}
    rows = [line for line in git(["diff", "--name-status", "--no-renames", base, "HEAD"]).splitlines() if line.strip()]
    files = []
    for line in rows[:limit]:
        status, _, path = line.partition("\t")
        files.append({"status": status.strip(), "path": path.strip()})
    stat = git(["diff", "--shortstat", base, "HEAD"])
    ins = re.search(r"(\d+) insertion", stat)
    dels = re.search(r"(\d+) deletion", stat)
    return {"count": len(rows), "files": files, "insertions": int(ins.group(1)) if ins else 0,
            "deletions": int(dels.group(1)) if dels else 0, "truncated": len(rows) > limit}


def uncommitted_files(git: GitRunner, limit: int = 15) -> dict:
    out = _try(git, ["status", "--porcelain=v1", "--untracked-files=normal"]) or ""
    rows = [line for line in out.splitlines() if line.strip()]
    return {"count": len(rows), "files": [line[3:].strip() for line in rows[:limit]],
            "truncated": len(rows) > limit}


def collect_git(git: GitRunner, *, repo_url: str | None, previous_ref: str | None = None,
                previous_snapshot: str | None = None, max_commits: int = DEFAULT_MAX_COMMITS,
                max_files: int = DEFAULT_MAX_FILES, max_branches: int = DEFAULT_MAX_BRANCHES,
                max_worktrees: int = DEFAULT_MAX_WORKTREES, now=None) -> dict:
    now = now or utc_now()
    head = head_ref(git)
    base = resolve_base(git, previous_ref, previous_snapshot)
    span = [base["base"] + "..HEAD"] if base["base"] else ["HEAD"]
    count = int(git(["rev-list", "--count", *span]).strip() or 0)
    fmt = _SEP.join(["%H", "%h", "%cI", "%P", "%s"])
    log = git(["log", "--format=" + fmt, "-n", str(max_commits), *span])
    url_base = safe_https_url(repo_url)
    commits = []
    for line in log.splitlines():
        parts = line.split(_SEP)
        if len(parts) != 5:
            continue
        full, short, date, parents, subject = parts
        commits.append({
            "sha": full, "short": full[:7], "date": format_utc(parse_utc(date) or now),
            "subject": one_line(subject, 200), "merge": len(parents.split()) > 1,
            "url": (url_base + "/commit/" + full) if url_base else None,
        })
    branches = []
    fmt_b = _SEP.join(["%(refname:short)", "%(objectname:short=7)", "%(committerdate:iso-strict)",
                       "%(upstream:short)", "%(upstream:track)"])
    for line in (_try(git, ["for-each-ref", "--sort=-committerdate", "--format=" + fmt_b,
                            "--count=%d" % max_branches, "refs/heads"]) or "").splitlines():
        parts = line.split(_SEP)
        if len(parts) == 5:
            name, short, date, upstream, track = parts
            branches.append({"name": name, "commit": short,
                             "date": format_utc(parse_utc(date) or now),
                             "upstream": upstream or None, "track": track or None})
    worktrees = []
    current: dict = {}
    for line in (_try(git, ["worktree", "list", "--porcelain"]) or "").splitlines() + [""]:
        if not line.strip():
            if current:
                worktrees.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current["path"] = home_relative(value)
        elif key == "branch":
            current["branch"] = value.replace("refs/heads/", "")
        elif key == "HEAD":
            current["commit"] = value[:7]
        elif key in ("detached", "locked", "prunable"):
            current[key] = True
    return {
        "checked": format_utc(now),
        "source": url_base,
        "branch": head["branch"], "head": head["head"], "ref": head["ref"],
        "base": base["base"], "base_source": base["base_source"],
        "commit_count": count, "commits": commits, "commits_truncated": count > len(commits),
        "changed_files": changed_files(git, base["base"], max_files),
        "uncommitted": uncommitted_files(git),
        "branches": branches,
        "worktrees": worktrees[:max_worktrees],
    }


# ---------------------------------------------------------------- issues (Gitea API)

def default_http_get(url: str, headers: dict, timeout: int = 20) -> tuple:
    """GET a URL. Returns (status, lower-case headers, body bytes)."""
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in (exc.headers or {}).items()}, exc.read() or b""
    except (urllib.error.URLError, OSError) as exc:
        raise CollectError("issue API not reachable: %s" % getattr(exc, "reason", exc)) from exc


def _issue_record(item: dict, repo_url: str | None, checked: str) -> dict:
    number = int(item.get("number"))
    url = safe_https_url(item.get("html_url"))
    if not url and safe_https_url(repo_url):
        url = safe_https_url(repo_url) + "/issues/%d" % number
    labels = [one_line(lbl.get("name"), 40) for lbl in (item.get("labels") or []) if isinstance(lbl, dict)]
    milestone = item.get("milestone") or {}
    return {
        "number": number,
        "title": one_line(item.get("title"), 200),
        "state": "closed" if item.get("state") == "closed" else "open",
        "url": url,
        "updated": format_utc(parse_utc(item.get("updated_at")) or parse_utc(checked)),
        "closed": format_utc(parse_utc(item["closed_at"])) if parse_utc(item.get("closed_at")) else None,
        "labels": labels[:5],
        "milestone": one_line(milestone.get("title"), 80) or None if isinstance(milestone, dict) else None,
        "comments": item.get("comments"),
        "checked": checked,
    }


def collect_issues(api_base: str | None, repo: str, *, token: str | None = None,
                   since: str | None = None, repo_url: str | None = None, http_get: HttpGet | None = None,
                   page_size: int = DEFAULT_PAGE_SIZE, max_pages: int = DEFAULT_MAX_PAGES, now=None) -> dict:
    """Read open issues plus issues updated since `since` from a Gitea-style API.

    Pull requests are excluded. Page count is bounded by `max_pages` per query.
    """
    now = now or utc_now()
    checked = format_utc(now)
    base = safe_https_url(api_base)
    result = {"status": "ok", "api": base, "checked": checked, "since": since, "items": [],
              "pages_read": 0, "truncated": False, "error": None,
              "list_url": (safe_https_url(repo_url) + "/issues") if safe_https_url(repo_url) else None}
    if not api_base:
        result.update(status="not-configured", error="issue API is not configured")
        return result
    if not base:
        result.update(status="error", error="issue API must be credential-free HTTPS")
        return result
    http_get = http_get or default_http_get
    owner, _, name = repo.partition("/")
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "token " + token
    queries = [{"state": "open"}]
    queries.append({"state": "closed", "since": since} if since else {"state": "closed"})
    found: dict[int, dict] = {}
    try:
        for query in queries:
            for page in range(1, max_pages + 1):
                params = dict(query, type="issues", limit=str(page_size), page=str(page))
                params = {k: v for k, v in params.items() if v}
                url = "%s/repos/%s/%s/issues?%s" % (base.rstrip("/"), urllib.parse.quote(owner),
                                                    urllib.parse.quote(name), urllib.parse.urlencode(params))
                status, _headers, body = http_get(url, headers)
                result["pages_read"] += 1
                if status != 200:
                    raise CollectError("issue API returned HTTP %s" % status)
                items = json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
                if not isinstance(items, list):
                    raise CollectError("issue API returned an unexpected body")
                for item in items:
                    if not isinstance(item, dict) or item.get("pull_request"):
                        continue
                    record = _issue_record(item, repo_url, checked)
                    found[record["number"]] = record
                if len(items) < page_size:
                    break
                if page == max_pages:
                    result["truncated"] = True
    except (CollectError, ValueError, TypeError, KeyError) as exc:
        result.update(status="error", error=redact(one_line(str(exc), 300), [token]))
    items = sorted(found.values(), key=lambda r: (r["updated"], r["number"]), reverse=True)
    result["items"] = items
    result["open_count"] = sum(1 for r in items if r["state"] == "open")
    return result


# ---------------------------------------------------------------- facts packet

def collect_facts(*, git: GitRunner, repo: str, repo_url: str | None, previous_ref: str | None,
                  previous_snapshot: str | None, issues_api: str | None, token: str | None = None,
                  http_get: HttpGet | None = None, max_commits: int = DEFAULT_MAX_COMMITS,
                  max_pages: int = DEFAULT_MAX_PAGES, page_size: int = DEFAULT_PAGE_SIZE, now=None) -> dict:
    now = now or utc_now()
    facts = {
        "schema": FACTS_SCHEMA,
        "collected": format_utc(now),
        "repo": repo,
        "repo_url": safe_https_url(repo_url),
        "previous": {"ref": previous_ref, "snapshot": previous_snapshot},
        "git": collect_git(git, repo_url=repo_url, previous_ref=previous_ref,
                           previous_snapshot=previous_snapshot, max_commits=max_commits, now=now),
        "issues": collect_issues(issues_api, repo, token=token, since=previous_snapshot, repo_url=repo_url,
                                 http_get=http_get, page_size=page_size, max_pages=max_pages, now=now),
    }
    text = json.dumps(facts)
    if token and token in text:  # defence in depth: the token must never reach the packet
        raise CollectError("facts packet contained credential text; nothing was written")
    return facts
