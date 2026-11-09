"""Read Claude Code and Pi session traces from an OpenViking server for collect_sessions.py.

Kit addition to the upstream skill. OpenViking keeps each captured session as
messages under viking://user/<user>/sessions/<id>/: the committed archives in
history/archive_<n>/messages.jsonl and the uncommitted tail in messages.jsonl.
The Claude Code plugin writes sessions as cc-<id> (child sessions as
cc-<id>__subagent-<agent>), the Pi package as pi-<id>. Each message carries the
peer ID of its repository, which the collector maps from --repo.

The server and the credential come from the shared connection chain of the
OpenViking clients: the OPENVIKING_* environment variables, ovcli.conf and the
server section of ov.conf. The credential stays in this process: it goes only
into the Authorization header of GET requests to that server. Nothing is
written to the server. Stdlib only.

Failure rule: OpenVikingUnavailable (no configured server, a connection error,
a timeout, HTTP 5xx, a health reply with healthy false) lets --source auto read
the local files instead. Every other OpenVikingError (a refused credential,
another HTTP status, a body that is not JSON, an application error, a missing
identity, a configuration value that cannot go into a header) ends the run.
collect() turns each other exception into one OpenVikingError that holds only
the exception type: the message of a request error can hold a header value.
"""

import hashlib
import http.client
import io
import json
import os
import re
import socket
import ssl
import subprocess
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from collect_sessions import (
    CLAUDE_CODE_EDIT_TOOLS,
    CODE_EDIT_HINTS,
    GENERIC_EDIT_TOOLS,
    MAX_MSG_CHARS,
    MAX_TOOL_CHARS,
    TranscriptBuffer,
    detect_skill_candidates,
    looks_injected,
    truncate,
)

HARNESS_PREFIXES = {"claude": "cc-", "pi": "pi-"}
ORIGINATORS = {"claude": "claude-code", "pi": "pi"}
CHILD_MARK = "__subagent-"
HEALTH_TIMEOUT = 5
READ_TIMEOUT = 30
PAGE_SIZE = 1000
WORKERS = 8

# The variables that name part of the connection (shared/credentials.mjs of the clients).
CREDENTIAL_ENV_VARS = (
    "OPENVIKING_URL", "OPENVIKING_BASE_URL", "OPENVIKING_MCP_URL", "OPENVIKING_BEARER_TOKEN",
    "OPENVIKING_API_KEY", "OPENVIKING_ACCOUNT", "OPENVIKING_USER", "OPENVIKING_PEER_ID",
)
CREDENTIAL_FIELDS = ("url", "api_key", "account", "account_id", "user", "user_id", "actor_peer_id", "peer_id")
# Identity layers that only one harness client reads: the ovcli.conf plugin keys and
# the ov.conf harness sections of the Claude Code plugin and the Pi package.
HARNESS_PLUGIN_KEYS = ("claude_code", "claude-code", "pi")
HARNESS_SECTIONS = ("claude_code", "pi")


class OpenVikingError(Exception):
    """OpenViking cannot serve the sessions; the run fails. The message is one line and holds no credential."""


class OpenVikingUnavailable(OpenVikingError):
    """No server is configured, or the server does not answer; --source auto reads the local files."""


class _Stopped(Exception):
    """Another worker failed first; this one ends before its next request."""


def _text(value):
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _scalar(value):
    return "" if value is None or isinstance(value, (dict, list)) else str(value).strip()


def _load_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _looks_like_ovcli(data):
    return bool(data) and not isinstance(data.get("server"), dict) and any(
        isinstance(data.get(key), str) for key in CREDENTIAL_FIELDS if key != "peer_id"
    )


def _credential_mode(env):
    raw = (_text(env.get("OPENVIKING_CREDENTIAL_SOURCE")) or _text(env.get("OPENVIKING_CREDENTIALS_SOURCE"))).lower()
    if raw in ("env", "environment"):
        return "env"
    return "cli" if raw in ("cli", "ovcli", "file", "config") else "auto"


def _unread_identity(cli, ov, account, user):
    """The harness-only layers that name an account or a user that the collector did not resolve."""
    wanted = [knob for knob, value in (("accountId", account), ("userId", user)) if not value]
    plugin = cli.get("plugin") if isinstance(cli.get("plugin"), dict) else {}
    layers = [("ovcli.conf plugin", {key: value for key, value in plugin.items() if not isinstance(value, dict)})]
    layers += [(f"ovcli.conf plugin.{name}", plugin.get(name)) for name in HARNESS_PLUGIN_KEYS]
    layers += [(f"ov.conf {name}", ov.get(name)) for name in HARNESS_SECTIONS]
    return [label for label, section in layers
            if isinstance(section, dict) and any(_scalar(section.get(knob)) for knob in wanted)]


def load_connection(env=None):
    """The server and the credential of the OpenViking clients, or None when no server is configured.

    Mirrors resolveConnection of the clients without the harness sections:
    OPENVIKING_CREDENTIAL_SOURCE picks env (no file is read), cli or auto; in
    auto an ovcli.conf that names a url, key, identity or peer pins the chain
    when no OPENVIKING_* credential variable is set.
    """
    env = os.environ if env is None else env
    mode = _credential_mode(env)
    cli = ov = None
    if mode != "env":
        cli_named = _text(env.get("OPENVIKING_CLI_CONFIG_FILE"))
        ov_named = _text(env.get("OPENVIKING_CONFIG_FILE"))
        home = Path.home() / ".openviking"
        cli = _load_json(Path(cli_named).expanduser() if cli_named else home / "ovcli.conf")
        ov = _load_json(Path(ov_named).expanduser() if ov_named else home / "ov.conf")
        if ov_named and not cli_named and _looks_like_ovcli(ov):
            cli, ov = ov, None
    has_cli = cli is not None
    cli, ov = cli or {}, ov or {}
    server = ov.get("server") if isinstance(ov.get("server"), dict) else {}

    env_has_credentials = any(_text(env.get(name)) for name in CREDENTIAL_ENV_VARS)
    pinned = mode == "cli" or (mode == "auto" and not env_has_credentials and has_cli
                               and any(isinstance(cli.get(key), str) for key in CREDENTIAL_FIELDS))
    use_env = not pinned

    def first(*values):
        return next((value for value in values if value), "")

    key = first(
        use_env and (_text(env.get("OPENVIKING_BEARER_TOKEN")) or _text(env.get("OPENVIKING_API_KEY"))),
        _text(cli.get("api_key")),
        not pinned and _text(server.get("root_api_key")),
    )
    account = first(use_env and _text(env.get("OPENVIKING_ACCOUNT")),
                    _text(cli.get("account")) or _text(cli.get("account_id")))
    user = first(use_env and _text(env.get("OPENVIKING_USER")),
                 _text(cli.get("user")) or _text(cli.get("user_id")))
    auth_mode = first(_text(env.get("OPENVIKING_AUTH_MODE")).lower(), _text(server.get("auth_mode")).lower())
    if auth_mode not in ("trusted", "api_key"):
        auth_mode = "trusted" if (account or user) else "api_key"

    url = first(use_env and (_text(env.get("OPENVIKING_URL")) or _text(env.get("OPENVIKING_BASE_URL"))),
                _text(cli.get("url")) or _text(server.get("url")))
    if not url and server:
        host = (_text(server.get("host")) or "127.0.0.1").replace("0.0.0.0", "127.0.0.1")
        try:
            port = int(server.get("port", 1933))
        except (TypeError, ValueError):
            port = 1933
        url = f"http://{host}:{port}"
    if not url:
        return None
    return {
        "base_url": url.rstrip("/"),
        "api_key": key,
        "account": account if auth_mode == "trusted" else "",
        "user": user if auth_mode == "trusted" else "",
        "unread_identity": _unread_identity(cli, ov, account, user),
    }


def check_identity(connection, health):
    """Refuse a run that would read another namespace than the one that the clients write to."""
    mode = health.get("auth_mode")
    if mode == "api_key":
        return  # the key decides the user; the server ignores the identity headers
    if mode == "trusted" and not (connection["account"] and connection["user"]):
        raise OpenVikingError("the OpenViking server runs in trusted mode and needs an account and a user, "
                              "and the configuration does not name both")
    if connection["unread_identity"]:
        raise OpenVikingError(
            "the OpenViking configuration names an account or a user only in "
            + ", ".join(connection["unread_identity"])
            + ", which the collector does not read: set OPENVIKING_ACCOUNT and OPENVIKING_USER,"
              " or account and user in ovcli.conf")


def _time_left(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError("the request passed its deadline")
    return left


class _DeadlineReader(io.RawIOBase):
    """The read side of one request socket: each read waits only for the time that is left."""

    def __init__(self, sock, deadline):
        super().__init__()
        self._sock, self._deadline = sock, deadline

    def readable(self):
        return True

    def readinto(self, buffer):
        self._sock.settimeout(_time_left(self._deadline))
        return self._sock.recv_into(buffer)


class _DeadlineSocket:
    """The socket of one request. The status line, the headers and the body end by one deadline,
    also when the server sends its bytes slowly; http.client reads them through makefile().

    close() leaves the socket open: http.client closes the connection before it
    reads the body of a reply that ends the connection. _fetch closes the socket.
    """

    def __init__(self, sock, deadline):
        self._sock, self._deadline = sock, deadline

    def makefile(self, *args, **kwargs):
        return io.BufferedReader(_DeadlineReader(self._sock, self._deadline))

    def sendall(self, data):
        self._sock.settimeout(_time_left(self._deadline))
        self._sock.sendall(data)

    def close(self):
        pass

    def __getattr__(self, name):
        return getattr(self._sock, name)


def _header_value(label, value):
    """value, when an HTTP header can carry it: Latin-1 and no control character."""
    if any(ord(c) < 0x20 or 0x7f <= ord(c) < 0xa0 or ord(c) > 0xff for c in value):
        raise OpenVikingError(f"the OpenViking {label} holds a character that an HTTP header cannot carry")
    return value


def _reason(error):
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "timed out"
    if isinstance(error, OSError) and error.strerror:
        return error.strerror.lower()
    return type(error).__name__


class Client:
    """GET requests to one OpenViking server, each one bounded by an elapsed-time deadline.

    http.client follows no redirect and uses no proxy, so the credential goes to
    this server only. One TLS context serves all requests.
    """

    def __init__(self, connection):
        parts = urllib.parse.urlsplit(connection["base_url"])
        try:
            port = parts.port
        except ValueError:
            port = -1
        if parts.scheme not in ("http", "https") or not parts.hostname or port == -1:
            raise OpenVikingError("the OpenViking server address is not an http or https URL")
        self._https = parts.scheme == "https"
        self._host, self._port, self._prefix = parts.hostname, port, parts.path.rstrip("/")
        self._context = ssl.create_default_context() if self._https else None
        self._headers = {"Accept": "application/json", "User-Agent": "skill-doctor"}
        if connection["api_key"]:
            self._headers["Authorization"] = "Bearer " + _header_value("API key", connection["api_key"])
        if connection["account"]:
            self._headers["X-OpenViking-Account"] = _header_value("account", connection["account"])
        if connection["user"]:
            self._headers["X-OpenViking-User"] = _header_value("user", connection["user"])
        self.stopped = threading.Event()
        self.lock = threading.Lock()

    def _fetch(self, target, timeout):
        """(status, body) of one GET; the connect, the request and the whole read end by the deadline.

        Only a 2xx reply has its body read: the status alone decides each other
        reply, also when its body is slow or incomplete.
        """
        deadline = time.monotonic() + timeout
        if self._https:
            connection = http.client.HTTPSConnection(self._host, self._port, timeout=timeout, context=self._context)
        else:
            connection = http.client.HTTPConnection(self._host, self._port, timeout=timeout)
        sock = None
        try:
            connection.connect()
            sock = connection.sock
            connection.sock = _DeadlineSocket(sock, deadline)
            connection.request("GET", target, headers=self._headers)
            response = connection.getresponse()
            return response.status, response.read() if 200 <= response.status < 300 else b""
        finally:
            connection.close()
            if sock is not None:
                sock.close()

    def get(self, path, params=None, timeout=READ_TIMEOUT, missing_ok=False):
        if self.stopped.is_set():
            raise _Stopped()
        target = self._prefix + path + ("?" + urllib.parse.urlencode(params) if params else "")
        try:
            status, raw = self._fetch(target, timeout)
        except ssl.SSLCertVerificationError:
            raise OpenVikingError("the certificate of the OpenViking server failed the TLS check") from None
        except (OSError, http.client.HTTPException) as error:
            raise OpenVikingUnavailable(f"the OpenViking server did not answer ({_reason(error)})") from None
        if status == 404 and missing_ok:
            return None
        if status >= 500:
            raise OpenVikingUnavailable(f"the OpenViking server answered HTTP {status}")
        if status in (401, 403):
            raise OpenVikingError(f"the OpenViking server refused the credential (HTTP {status})")
        if not 200 <= status < 300:
            raise OpenVikingError(f"the OpenViking server answered HTTP {status}")
        try:
            body = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            raise OpenVikingError("the OpenViking server sent no JSON") from None
        if not isinstance(body, dict) or body.get("status") == "error":
            code = body.get("error", {}).get("code") if isinstance(body, dict) and isinstance(
                body.get("error"), dict) else None
            if missing_ok and code == "NOT_FOUND":
                return None
            raise OpenVikingError("the OpenViking server answered with an error")
        return body

    def health(self):
        """The health reply. The health check as a whole (the name lookup, the connect, the
        request and the reply) ends by HEALTH_TIMEOUT, or the server does not answer.

        socket.getaddrinfo takes no timeout: the request runs in a daemon thread, and
        the run does not wait for it after the deadline. A name lookup that stalls in
        a later request ends only by the timeout of the system resolver.
        """
        outcome = []

        def request():
            try:
                outcome.append((self.get("/health", timeout=HEALTH_TIMEOUT), None))
            except Exception as error:
                outcome.append((None, error))

        worker = threading.Thread(target=request, daemon=True)
        worker.start()
        worker.join(HEALTH_TIMEOUT)
        if not outcome:
            raise OpenVikingUnavailable("the OpenViking server did not answer (timed out)")
        body, error = outcome[0]
        if error is not None:
            raise error
        # A server that reports itself unhealthy counts as one that does not answer, as HTTP 5xx does.
        if body.get("healthy") is False:
            raise OpenVikingUnavailable("the OpenViking server reports that it is not healthy")
        return body

    def sessions_since(self, cutoff):
        """(session_id, uri, modified_at) of each session modified at or after cutoff, newest first."""
        listed = self.get("/api/v1/sessions").get("result")
        if not isinstance(listed, list):
            raise OpenVikingError("the OpenViking server sent no session list")
        entries = [(item.get("session_id"), item.get("uri"), item.get("mod_time"), item.get("is_dir", True))
                   for item in listed if isinstance(item, dict)]
        # The list endpoint has no paging and stops at a server limit; page on through the
        # session root, newest first, while the oldest entry is still inside the window.
        root = next((uri.rsplit("/", 1)[0] for _, uri, _, _ in entries if isinstance(uri, str) and "/" in uri), None)
        while root and entries and _in_window(entries[-1][2], cutoff):
            page = self.get("/api/v1/fs/ls", {
                "uri": root, "output": "original", "sort_by": "mtime", "sort_order": "desc",
                "offset": len(entries), "node_limit": PAGE_SIZE,
            })
            items = [item for item in page.get("result") or [] if isinstance(item, dict)]
            entries += [(item.get("name"), f"{root}/{item.get('name')}", item.get("modTime"), item.get("isDir"))
                        for item in items]
            if not items or not page.get("has_more"):
                break
        found, seen = [], set()
        for session_id, uri, modified, is_dir in entries:
            when = _parse_time(modified)
            if not session_id or not is_dir or session_id in seen or when is None or when < cutoff:
                continue
            seen.add(session_id)
            found.append((session_id, uri, when))
        return found

    def read_messages(self, uri, limit=None):
        params = {"uri": uri, "raw": "true"}
        if limit:
            params["limit"] = limit
        body = self.get("/api/v1/content/read", params, missing_ok=True)
        text = body.get("result") if body else None
        messages = []
        for line in text.splitlines() if isinstance(text, str) else ():
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict):
                messages.append(message)
        return messages

    def archives(self, session_uri):
        """The archive names of one session, in the order of their numbers."""
        names, offset = [], 0
        while True:
            body = self.get("/api/v1/fs/ls", {
                "uri": f"{session_uri}/history", "output": "original", "sort_by": "name",
                "offset": offset, "node_limit": PAGE_SIZE,
            }, missing_ok=True)
            items = [item for item in (body or {}).get("result") or [] if isinstance(item, dict)]
            names += [item.get("name") for item in items]
            offset += len(items)
            if not items or not body.get("has_more"):
                break
        numbered = {}
        for name in names:
            match = re.fullmatch(r"archive_(\d+)", name) if isinstance(name, str) else None
            if match:
                numbered[int(match.group(1))] = name
        return [numbered[number] for number in sorted(numbered)]

    def first_message(self, session_uri):
        messages = self.read_messages(f"{session_uri}/messages.jsonl", limit=1)
        if not messages:
            for archive in self.archives(session_uri)[:1]:
                messages = self.read_messages(f"{session_uri}/history/{archive}/messages.jsonl", limit=1)
        return messages[0] if messages else None

    def session_messages(self, session_uri):
        """Each message of one session once, oldest first: the archives in number order, then the live file."""
        archived = {name: self.read_messages(f"{session_uri}/history/{name}/messages.jsonl")
                    for name in self.archives(session_uri)}
        live = self.read_messages(f"{session_uri}/messages.jsonl")
        # A commit during the read moves live messages into a new archive: read each new archive once.
        for name in self.archives(session_uri):
            if name not in archived:
                archived[name] = self.read_messages(f"{session_uri}/history/{name}/messages.jsonl")
        ordered = sorted(archived, key=lambda name: int(name.rsplit("_", 1)[1]))
        return merge_messages([archived[name] for name in ordered] + [live])


def _record_size(message):
    return len(json.dumps(message.get("parts"), ensure_ascii=False, default=str))


def merge_messages(batches):
    """One record per message ID, at its first place, with the fullest copy.

    Turn-budget retention keeps a copy of the retained messages in the archive
    and in the live file, and a commit during the read can show one message twice.
    """
    merged, places = [], {}
    for batch in batches:
        for message in batch:
            key = message.get("id")
            if not isinstance(key, (str, int)) or key == "":
                merged.append(message)
            elif key not in places:
                places[key] = len(merged)
                merged.append(message)
            elif _record_size(message) > _record_size(merged[places[key]]):
                merged[places[key]] = message
    return merged


def _parallel(client, function, items):
    """function(item) for each item, in order, in WORKERS threads.

    The first error stops the other workers before their next request; it is
    raised when the requests in progress have ended, each by its deadline.
    """
    first_error = []

    def run(item):
        if client.stopped.is_set():
            raise _Stopped()
        try:
            return function(item)
        except _Stopped:
            raise
        except Exception as error:
            with client.lock:
                if not first_error:
                    first_error.append(error)
            client.stopped.set()
            raise

    pool = ThreadPoolExecutor(max_workers=WORKERS)
    results = []
    try:
        for future in [pool.submit(run, item) for item in items]:
            try:
                results.append(future.result())
            except Exception:
                break
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    if first_error:
        raise first_error[0]
    return results


def _parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def _in_window(value, cutoff):
    when = _parse_time(value)
    return when is not None and when >= cutoff


def legacy_sanitize(value):
    """The path form of a peer ID: each byte that is not a letter or a digit becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(value or ""))


def sanitize_peer_id(value):
    """The readable form of a peer ID, as the OpenViking clients derive it from a git remote."""
    raw = str(value or "").strip()
    cleaned = re.sub(r"[^a-zA-Z0-9_.@-]+", "-", raw)
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    cleaned = re.sub(r"^[-.]+|[-.]+$", "", cleaned)
    if not cleaned:
        return ""
    at = cleaned.find("@")
    if at != -1:
        cleaned = cleaned[:at + 1] + cleaned[at + 1:].replace("@", "-")
    if cleaned.startswith("ext-"):
        cleaned = f"x-{cleaned}"
    if cleaned == "__self":
        cleaned = "self"
    if cleaned in (".", ".."):
        return ""
    if len(cleaned) > 100:
        digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
        cleaned = f"{re.sub(r'[-.]+$', '', cleaned[:87])}-{digest}"
    return cleaned


def normalize_git_remote(url):
    """A remote URL as host/path, lowercased, without user info and without .git; '' for a local path."""
    raw = str(url or "").strip()
    if not raw or re.match(r"^[A-Za-z]:[\\/]", raw):
        return ""
    scp = re.match(r"^(?:[^@/\\]+@)?([^:/\\]+):(?!/)(.+)$", raw)
    if scp and not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", raw):
        host, path = scp.group(1), scp.group(2)
    else:
        try:
            parsed = urllib.parse.urlsplit(raw)
            host = parsed.hostname or ""
        except ValueError:
            return ""
        if parsed.scheme == "file" or not host:
            return ""
        path = parsed.path
    host = host.lower().strip("[]")
    path = re.sub(r"\.git$", "", path.strip("/"), flags=re.IGNORECASE).lower()
    return f"{host}/{path}" if host and path else ""


def _git(repo, *args):
    try:
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=10)
    except (subprocess.TimeoutExpired, OSError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def repo_peer_ids(repo):
    """The peer IDs that sessions of one repository carry: from the origin remote, the root and the path."""
    peers = {legacy_sanitize(repo)}
    root = _git(repo, "rev-parse", "--show-toplevel")
    if root:
        peers.add(legacy_sanitize(Path(root).resolve()))
    remote = sanitize_peer_id(normalize_git_remote(_git(repo, "config", "--get", "remote.origin.url")))
    if remote:
        peers.add(remote)
    return peers


def parse_messages(messages, harness):
    """Normalize the messages of one OpenViking session to the shared (stats, entries, skills) shape.

    A session with tool calls and no tool output at all (the Pi package captures
    no tool results by default) has tool_output_available False and
    error_outputs None: its error count is unknown, not 0.
    """
    stats = {"user_turns": 0, "assistant_turns": 0, "tool_calls": 0, "repeated_tool_calls": 0, "error_outputs": 0}
    entries = TranscriptBuffer()
    seen_calls = {}
    used_tool_names = set()
    skills_used = set()
    has_code_edit_hint = False
    has_tool_output = False
    first_ts = last_ts = None
    previous_role = None

    for message in messages:
        if message.get("message_kind") == "checkpoint":
            continue  # a retention summary, not a turn
        ts = message.get("created_at")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        role = message.get("role")
        # The Claude Code plugin sends one message per transcript record, so one model
        # turn arrives as a run of assistant messages; Pi sends one message per turn.
        if role == "assistant" and (harness != "claude" or previous_role != "assistant"):
            stats["assistant_turns"] += 1
        previous_role = role
        has_user_text = False
        for part in message.get("parts") or []:
            if not isinstance(part, dict):
                continue
            kind = part.get("type")
            if kind == "text":
                text = part.get("text")
                if not isinstance(text, str) or not text.strip() or looks_injected(text):
                    continue
                if role == "user":
                    has_user_text = True
                    entries.append(("user", truncate(text, MAX_MSG_CHARS)))
                elif role == "assistant":
                    entries.append(("assistant", truncate(text, MAX_MSG_CHARS)))
            elif kind == "tool":
                name = str(part.get("tool_name") or "unknown")
                if role == "assistant":
                    stats["tool_calls"] += 1
                    args = part.get("tool_input") or {}
                    args_text = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
                    key = hashlib.sha1((name + args_text).encode()).hexdigest()
                    seen_calls[key] = seen_calls.get(key, 0) + 1
                    if seen_calls[key] > 1:
                        stats["repeated_tool_calls"] += 1
                    used_tool_names.add(name)
                    skills_used.update(detect_skill_candidates(args_text))
                    if isinstance(part.get("skill_uri"), str) and part["skill_uri"]:
                        skills_used.update(detect_skill_candidates(part["skill_uri"].rstrip("/") + "/"))
                    has_code_edit_hint = has_code_edit_hint or any(hint in args_text for hint in CODE_EDIT_HINTS)
                    if name == "Skill" and isinstance(args, dict) and args.get("skill"):
                        skills_used.add(args["skill"])
                    entries.append((f"tool:{name}", truncate(args_text, MAX_TOOL_CHARS)))
                has_tool_output = has_tool_output or "tool_output" in part
                output = part.get("tool_output")
                output = output if isinstance(output, str) else ""
                failed = part.get("tool_status") == "error"
                if output or (failed and role != "assistant"):
                    low = output[:2000].lower()
                    if failed or "error" in low or "failed" in low or "traceback" in low:
                        stats["error_outputs"] += 1
                    entries.append(("output", truncate(output, MAX_TOOL_CHARS)))
        if role == "user" and has_user_text:
            stats["user_turns"] += 1

    edit_tools = CLAUDE_CODE_EDIT_TOOLS if harness == "claude" else GENERIC_EDIT_TOOLS
    stats["first_ts"] = first_ts
    stats["last_ts"] = last_ts
    stats["has_code_edits"] = bool(used_tool_names & edit_tools) or has_code_edit_hint
    stats["tool_output_available"] = has_tool_output or not stats["tool_calls"]
    if not stats["tool_output_available"]:
        stats["error_outputs"] = None
    return stats, entries.finish(), sorted(skills_used)


def requested_harnesses(harness):
    if harness in ("auto", "all"):
        return ["claude", "pi"]
    return [harness] if harness in HARNESS_PREFIXES else []


def _split_session_id(session_id, harnesses):
    """(harness, local ID, is child) of an OpenViking session ID, or None for another client."""
    for harness in harnesses:
        prefix = HARNESS_PREFIXES[harness]
        if session_id.startswith(prefix) and len(session_id) > len(prefix):
            local = session_id[len(prefix):]
            child = CHILD_MARK in local
            # The local Claude Code parser names a child session <session>-<agent>.
            return harness, local.replace(CHILD_MARK, "-", 1), child
    return None


def read_sessions(client, harnesses, args, repos, cutoff):
    """(sessions, sessions in scope, sessions in window, sources) in the shape of the local collector."""
    candidates = []
    counts = {harness: 0 for harness in harnesses}
    for session_id, uri, modified in client.sessions_since(cutoff):
        split = _split_session_id(session_id, harnesses)
        if split is None or (split[2] and not args.include_subagents):
            continue
        counts[split[0]] += 1
        candidates.append((session_id, uri, modified) + split)

    peers = {peer: repo for repo in repos for peer in sorted(repo_peer_ids(repo))}

    def scope(candidate):
        """The repository of the session, None when it is out of scope, '' for all conversations."""
        if args.all_conversations:
            return ""
        message = client.first_message(candidate[1])
        return peers.get(message.get("peer_id")) if message else None

    def load(item):
        candidate, repo = item
        session_id, uri, modified, harness, local_id, child = candidate
        messages = client.session_messages(uri)
        stats, entries, skills_used = parse_messages(messages, harness)
        peer = next((m.get("peer_id") for m in messages if m.get("peer_id")), None)
        meta = {
            "id": local_id,
            "cwd": str(repo) if repo else None,
            "started_at": stats["first_ts"],
            "originator": ORIGINATORS[harness],
            "thread_source": "subagent" if child else None,
            "openviking_session": session_id,
            "peer_id": peer,
        }
        return {
            "harness": harness,
            "meta": meta,
            "stats": stats,
            "skills_used": skills_used,
            "file": uri,
            "modified_at": modified.isoformat(),
            "_entries": entries,
        }

    scopes = _parallel(client, scope, candidates)
    in_scope = [(candidate, repo) for candidate, repo in zip(candidates, scopes) if repo is not None]
    loaded = _parallel(client, load, in_scope)
    sessions = [s for s in loaded if s["stats"]["assistant_turns"] >= 1 and s["stats"]["tool_calls"] >= 1]
    sources = {harness: {"source": "openviking", "records_in_window": counts[harness]} for harness in harnesses}
    return sessions, len(in_scope), len(candidates), sources


def collect(args, repos, cutoff, env=None):
    """The sessions of the harnesses that OpenViking holds (Claude Code, Pi), when it can serve them.

    Returns (result, note). `result` is the tuple of read_sessions, or None when
    the local files are the source of every harness; `note` is then the one line
    to print for a fallback, or None. The local-only harnesses always come from
    the local files, except with --source openviking.

    Raises OpenVikingError when the run must fail: with --source openviking for
    every failure, with --source auto for each failure that is not
    OpenVikingUnavailable.
    """
    if args.source == "local":
        return None, None
    harnesses = requested_harnesses(args.harness)
    if not harnesses:
        if args.source == "openviking":
            raise OpenVikingError(f"OpenViking holds no {args.harness} sessions")
        return None, None  # a local-only harness: its local files are the source
    try:
        connection = load_connection(env)
        if connection is None:
            raise OpenVikingUnavailable("no OpenViking server is configured")
        client = Client(connection)
        check_identity(connection, client.health())
        return read_sessions(client, harnesses, args, repos, cutoff), None
    except OpenVikingUnavailable as error:
        if args.source == "openviking":
            raise
        return None, f"note: session source: local files ({error})"
    except OpenVikingError:
        raise
    except Exception as error:
        # The message of a request error can hold a header value: give only the type.
        raise OpenVikingError(f"the OpenViking source failed ({type(error).__name__})") from None
