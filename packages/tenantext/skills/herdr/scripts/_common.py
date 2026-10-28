"""Shared helpers for the herdr skill scripts. Standard library only."""
import datetime
import glob
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import time


def herdr(*args, timeout=None):
    """Run the herdr CLI. Return (exit_code, parsed_json_or_None, raw_text)."""
    try:
        p = subprocess.run(["herdr", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        sys.exit("error: herdr CLI not found in PATH")
    except subprocess.TimeoutExpired:
        return 124, None, "herdr call exceeded the local timeout"
    raw = (p.stdout or "").strip() or (p.stderr or "").strip()
    data = None
    for chunk in (p.stdout, p.stderr):
        chunk = (chunk or "").strip()
        if chunk.startswith("{"):
            try:
                data = json.loads(chunk)
                break
            except json.JSONDecodeError:
                pass
    return p.returncode, data, raw


def require_herdr_env():
    if os.environ.get("HERDR_ENV") != "1":
        sys.exit("error: not inside a Herdr pane (HERDR_ENV is not 1). Stop; do not control Herdr from outside.")


def error_code(data):
    if isinstance(data, dict) and isinstance(data.get("error"), dict):
        return data["error"].get("code") or "error"
    return None


def agent_info(target):
    """Return the agent record for a pane id or agent name, or None."""
    code, data, raw = herdr("agent", "get", target)
    if code != 0 or error_code(data) or not data:
        return None
    return data.get("result", {}).get("agent")


def session_file(info):
    """Resolve the transcript file of a Pi or Claude Code agent. Return path or None."""
    sess = (info or {}).get("agent_session") or {}
    value = sess.get("value")
    if not value:
        return None
    if sess.get("kind") == "path":
        return value if os.path.isfile(value) else None
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{value}.jsonl"))
    return hits[0] if hits else None


# ---------------------------------------------------------------------------
# Pi session files on disk, for a Pi pane that Herdr gives no transcript path
# (Pi-Bolt runs without HERDR_SOCKET_PATH, so it reports no session).
# ---------------------------------------------------------------------------
PI_AGENTS = ("pi", "pi-bolt")
# The prompt text that must be in the user entry. Pi can keep stray editor characters before it.
# A prompt up to this length must end the user entry; a longer one must be in it.
PROMPT_MATCH_CHARS = 200
# A shorter prompt (such as "continue") is too common to identify a session.
PROMPT_MIN_CHARS = 20
# Slack for the clock of the file system and the timestamp of the entry.
CLOCK_SLACK = 2


def pi_session_dir_name(cwd):
    """The folder name that Pi and Pi-Bolt give the sessions of a working directory.

    The same rule as getDefaultSessionDirPath of Pi: drop one leading separator, then each / \\ : becomes -.
    """
    return "--" + re.sub(r"[/\\:]", "-", re.sub(r"^[/\\]", "", cwd)) + "--"


def pi_agent_dirs():
    """The agent directories where a Pi pane can write: the caller's, the default and the kit profiles."""
    home = pathlib.Path.home()
    dirs = [os.environ.get("PI_CODING_AGENT_DIR"), home / ".pi" / "agent"]
    dirs += sorted((home / ".pi" / "profiles").glob("*"))
    out = []
    for d in dirs:
        if not d:
            continue
        d = pathlib.Path(os.path.expanduser(str(d))).resolve()
        if d not in out and d.is_dir():
            out.append(d)
    return out


def _entry_epoch(entry):
    try:
        return datetime.datetime.fromisoformat(str(entry["timestamp"]).replace("Z", "+00:00")).timestamp()
    except (KeyError, ValueError, TypeError):
        return None


def _user_text(entry):
    msg = entry.get("message")
    if entry.get("type") != "message" or not isinstance(msg, dict) or msg.get("role") != "user":
        return None
    content = msg.get("content")
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content or [] if isinstance(p, dict) and p.get("type") == "text")


def _squash(text):
    return " ".join(text.split())


def _session_match(path, cwds, since, needle):
    """Return the line after the matching user entry, or None.

    The header must name one of `cwds`. A user entry written at or after `since` must end with the needle
    (a short prompt) or hold it (a long prompt).
    """
    found = None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(d, dict):
                    continue
                if n == 0:
                    if d.get("type") != "session" or os.path.realpath(str(d.get("cwd") or "")) not in cwds:
                        return None
                    continue
                text = _user_text(d)
                if text is not None and (needle in _squash(text) if len(needle) > PROMPT_MATCH_CHARS
                                         else _squash(text).endswith(needle)):
                    when = _entry_epoch(d)
                    if when is not None and when >= since - CLOCK_SLACK:
                        found = n + 1
    except OSError:
        return None
    return found


def find_pi_session(cwds, since, prompt, agent_dirs=None):
    """Return (path, start line) of the one Pi session file of a pane, or None when it is not certain.

    A candidate is a *.jsonl file in <agent dir>/sessions/<folder of the cwd>, modified at or after `since`
    (epoch seconds), whose header names the cwd. With a prompt, the file must also hold a user entry
    written at or after `since` that ends with the prompt (up to PROMPT_MATCH_CHARS characters) or holds
    the whole prompt (a longer prompt); the start line is the line after it.
    A prompt shorter than PROMPT_MIN_CHARS, no file or more than one file gives None.
    """
    real = {os.path.realpath(c) for c in cwds if c}
    if not real:
        return None
    needle = _squash(prompt)
    if len(needle) < PROMPT_MIN_CHARS:
        return None
    names = {pi_session_dir_name(c) for c in set(cwds) | real if c}
    seen, hits = set(), []
    for agent_dir in pi_agent_dirs() if agent_dirs is None else agent_dirs:
        for name in names:
            for path in pathlib.Path(agent_dir, "sessions", name).glob("*.jsonl"):
                try:
                    key = path.resolve()
                    if key in seen or path.stat().st_mtime < since - CLOCK_SLACK:
                        continue
                except OSError:
                    continue
                seen.add(key)
                line = _session_match(path, real, since, needle)
                if line is not None:
                    hits.append((str(path), line))
    return hits[0] if len(hits) == 1 else None


DISK_NOTE = "note: Herdr gave no transcript path; the reply below is from the Pi session file on disk: "


def _pane_cwds(info):
    return [c for c in (info.get("cwd"), info.get("foreground_cwd")) if c]


def _header(path):
    """The header of a Pi session file, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            d = json.loads(f.readline())
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("type") == "session" else None


def _header_cwd(path):
    """The realpath of the cwd in the header of a Pi session file, or None."""
    d = _header(path)
    return os.path.realpath(str(d["cwd"])) if d and d.get("cwd") else None


def _newer_session(path, started):
    """True when another session file of the same folder, in any agent directory, has a later header time.

    After /new, /resume or a restart of the agent in the pane, that file is the current session of the pane.
    A file of another pane in the same cwd that started later also counts: the caller then refuses.
    """
    folder = pathlib.Path(path).parent
    me = pathlib.Path(path).resolve()
    for d in {folder} | {pathlib.Path(a, "sessions", folder.name) for a in pi_agent_dirs()}:
        for other in d.glob("*.jsonl"):
            try:
                if other.resolve() == me:
                    continue
            except OSError:
                continue
            when = _entry_epoch(_header(other) or {})
            if when is not None and when > started:
                return True
    return False


def save_pi_session(info, path):
    """Keep the session file that a prompt matched in the pane record, for later runs without a prompt.

    Only a record that spawn.py (or the first use of the skill) wrote for this pane gets it: the skill makes
    no record for a pane that it did not start. spawn.py writes a whole new record, so a reused pane id loses it.
    """
    pane_id = (info or {}).get("pane_id")
    record = read_record(pane_id) if pane_id else None
    if not record or record.get("pane_id") != pane_id:
        return
    cwd = _header_cwd(path)
    if cwd is None:
        return
    record["pi_session"] = {"pane_id": pane_id, "path": os.path.realpath(path), "cwd": cwd,
                            "saved_at_epoch": time.time()}
    if read_record(pane_id) is None:
        return  # close.py removed the record meanwhile: do not bring it back
    write_record(pane_id, record)


def saved_pi_session(info):
    """The session file that an earlier prompt in this pane matched, or None when it is not certain.

    The record and the saved entry name this pane id, the agent name and the harness of the record and the
    pane are the same and Pi, the file exists, and its header cwd is the current cwd of the pane.
    The header time of the file is not earlier than the record (a pane id that a hand-started pane reuses),
    and no other file of the same session folder has a later header time (_newer_session).
    """
    info = info or {}
    pane_id = info.get("pane_id")
    if not pane_id or info.get("agent") not in PI_AGENTS:
        return None
    record = read_record(pane_id) or {}
    saved = record.get("pi_session")
    if (not isinstance(saved, dict) or record.get("pane_id") != pane_id or saved.get("pane_id") != pane_id
            or record.get("harness") not in PI_AGENTS or record.get("name") != info.get("name")):
        return None
    path = saved.get("path")
    if not isinstance(path, str) or not os.path.isfile(path):
        return None
    cwd = _header_cwd(path)
    if cwd is None or cwd != saved.get("cwd") or cwd not in {os.path.realpath(c) for c in _pane_cwds(info)}:
        return None
    started, created = _entry_epoch(_header(path) or {}), record.get("created_at_epoch")
    if (started is None or not isinstance(created, (int, float)) or started < created - CLOCK_SLACK
            or _newer_session(path, started)):
        return None
    return path


def pi_disk_session(info, prompt=None, since=None):
    """The session file on disk of a Pi pane that Herdr gives no transcript path: (path, start line) or None.

    The file must hold the prompt in a user entry written at or after `since` (the send time).
    Without a prompt (a wait-only run, last-reply.py) only the file that an earlier prompt in this pane
    matched counts (saved_pi_session), from line 0: a search would be uncertain, because another Pi session
    in the same cwd can be the only file.
    """
    if (info or {}).get("agent") not in PI_AGENTS:
        return None
    if prompt is None:
        path = saved_pi_session(info)
        return (path, 0) if path else None
    return find_pi_session(_pane_cwds(info), since, prompt)


def assistant_texts(path, start_line=0):
    """Return assistant text messages found after start_line (0-based line count)."""
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for n, line in enumerate(f):
                if n < start_line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = d.get("message")
                if not isinstance(msg, dict) or msg.get("role") != "assistant":
                    continue
                if d.get("isSidechain"):
                    continue
                content = msg.get("content")
                if isinstance(content, str):
                    text = content
                else:
                    text = "\n".join(
                        p.get("text", "") for p in content or []
                        if isinstance(p, dict) and p.get("type") == "text"
                    )
                if text.strip():
                    out.append(text.strip())
    except OSError:
        pass
    return out


def line_count(path):
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def screen_tail(target, lines=60):
    code, data, raw = herdr("agent", "read", target, "--source", "recent-unwrapped", "--lines", str(lines))
    if data and not error_code(data):
        r = data.get("result", {})
        text = (r.get("read") or r).get("text")
        if text:
            return text
    return raw


def clip(text, max_chars, head=0):
    if len(text) <= max_chars:
        return text
    if head == 0:
        return f"[... first {len(text) - max_chars} characters omitted ...]\n" + text[len(text) - max_chars:]
    tail = max_chars - head
    return text[:head] + f"\n[... {len(text) - max_chars} characters omitted ...]\n" + text[len(text) - tail:]


# ---------------------------------------------------------------------------
# The contract of the scripts (contract.json) and the roles (roles.json).
# ---------------------------------------------------------------------------
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def skill_json(name):
    """A JSON file of this skill, for example contract.json or roles.json."""
    with open(os.path.join(SKILL_DIR, name), encoding="utf-8") as f:
        return json.load(f)


CONTRACT = skill_json("contract.json")


def exit_codes(script):
    """The exit codes of `ask` or `spawn` by name, from contract.json."""
    return {name: entry["code"] for name, entry in CONTRACT[script]["exit"].items()}


# ---------------------------------------------------------------------------
# Layout and names. See LAYOUT.md.
# ---------------------------------------------------------------------------
ROLES = list(skill_json("roles.json")["roles"])
STATE_DIR = os.environ.get("HERDR_SKILL_STATE_DIR") or os.path.join(
    os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "herdr-skill")
NAME_MAX = 32


def api(method, params):
    """Call a socket API method that the CLI does not expose (for example tab.move)."""
    path = os.environ.get("HERDR_SOCKET_PATH")
    if not path:
        return None
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect(path)
        s.sendall((json.dumps({"id": "skill:" + method, "method": method, "params": params}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        s.close()
        return json.loads(buf.decode().splitlines()[0])
    except (OSError, ValueError, IndexError):
        return None


def record_path(pane_id):
    return os.path.join(STATE_DIR, "panes", pane_id.replace(":", "_").replace("/", "_") + ".json")


def read_record(pane_id):
    try:
        return json.load(open(record_path(pane_id)))
    except (OSError, json.JSONDecodeError):
        return None


def write_record(pane_id, data):
    """Write the whole record through a temporary file, so a reader never sees half a record."""
    path = record_path(pane_id)
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def remove_record(pane_id):
    try:
        os.remove(record_path(pane_id))
    except OSError:
        pass


def workspace_label(workspace_id):
    code, data, raw = herdr("workspace", "list")
    if data and not error_code(data):
        for w in data["result"]["workspaces"]:
            if w["workspace_id"] == workspace_id:
                return w.get("label") or workspace_id
    return workspace_id


def tabs(workspace_id):
    code, data, raw = herdr("tab", "list", "--workspace", workspace_id)
    if data and not error_code(data):
        return data["result"]["tabs"]
    return []


def panes(workspace_id):
    code, data, raw = herdr("pane", "list", "--workspace", workspace_id)
    if data and not error_code(data):
        return data["result"]["panes"]
    return []


def live_agents():
    code, data, raw = herdr("agent", "list")
    if data and not error_code(data):
        return data["result"]["agents"]
    return []


def project_slug(label):
    slug = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-") or "ws"
    if not slug[0].isalpha():
        slug = "w" + slug
    return slug


def make_name(label, role, agents):
    """<project>-<role>-<n>. n is one above the highest live number for this project and role."""
    # The project part has the same length for each role, so all names of a project align.
    room = NAME_MAX - max(len(r) for r in ROLES) - 4  # "-role-" and up to 2 digits
    project = project_slug(label)[:room].strip("-")
    stem = f"{project}-{role}-"
    used = [0]
    for a in agents:
        n = a.get("name") or ""
        if n.startswith(stem) and n[len(stem):].isdigit():
            used.append(int(n[len(stem):]))
    return f"{stem}{max(used) + 1}"


def pane_label(name, harness=None, model=None, thinking=None):
    """The first word is the agent name. The second word is for the human reader."""
    if not harness:
        return name
    if not model:
        return f"{name} {harness}:default/{thinking}" if thinking else f"{name} {harness}"
    short = model.split("/")[-1]
    return f"{name} {harness}:{short}/{thinking}" if thinking else f"{name} {harness}:{short}"


def place_role_tab(workspace_id, tab_id, role):
    """Keep role tabs at the front in the order of ROLES. The coordinator tab is tab 1."""
    rank = ROLES.index(role)
    index = 0
    for t in tabs(workspace_id):
        if t["tab_id"] == tab_id:
            continue
        if t.get("label") in ROLES and ROLES.index(t["label"]) < rank:
            index += 1
    current = [t["tab_id"] for t in tabs(workspace_id)]
    if tab_id in current and current.index(tab_id) == index:
        return True
    r = api("tab.move", {"tab_id": tab_id, "insert_index": index})
    return bool(r and not r.get("error"))


def ensure_layout(quiet=True):
    """First use of the skill in a workspace: the caller's tab becomes the coordinator tab.

    Returns a dict that describes the caller. Safe to call many times.
    """
    me = os.environ.get("HERDR_PANE_ID")
    ws = os.environ.get("HERDR_WORKSPACE_ID")
    if os.environ.get("HERDR_ENV") != "1" or not me or not ws:
        return {}
    code, data, raw = herdr("pane", "get", me)
    if not data or error_code(data):
        return {}
    pane = data["result"]["pane"]
    ws, tab_id, me = pane["workspace_id"], pane["tab_id"], pane["pane_id"]
    all_tabs = tabs(ws)
    my_tab = next((t for t in all_tabs if t["tab_id"] == tab_id), {})
    info = agent_info(me) or {}
    out = {"workspace_id": ws, "workspace": workspace_label(ws), "tab_id": tab_id,
           "tab": my_tab.get("label"), "pane_id": me, "name": info.get("name"), "claimed": False}
    record = read_record(me)
    if record:
        out["role"] = record.get("role")
        return out
    if my_tab.get("label") in ROLES:
        out["role"] = my_tab["label"]
    elif not any(t.get("label") == "coordinator" for t in all_tabs):
        herdr("tab", "rename", tab_id, "coordinator")
        place_role_tab(ws, tab_id, "coordinator")
        out.update(tab="coordinator", role="coordinator", claimed=True)
    else:
        return out
    if out.get("role") == "coordinator" and info and not info.get("name"):
        name = make_name(out["workspace"], "coordinator", live_agents())
        code, data, raw = herdr("agent", "rename", me, name)
        if code == 0 and not error_code(data):
            out["name"] = name
            herdr("pane", "rename", me, pane_label(name, info.get("agent")))
            write_record(me, {"pane_id": me, "name": name, "role": "coordinator", "harness": info.get("agent"),
                              "workspace_id": ws, "session": "primary", "self": True,
                              "created_at_epoch": time.time()})
    if out["claimed"] and not quiet:
        print(f"herdr: first use in workspace '{out['workspace']}'. Your tab is now 'coordinator' (tab 1). "
              f"Your name is {out.get('name')}.", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# Catalog of tools, skills and processes. See resources.json.
# ---------------------------------------------------------------------------
MACHINE_CATALOG = os.environ.get("HERDR_SKILL_RESOURCES") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "herdr-skill", "resources.json")


def machine_file_data(machine_file=None):
    """Return the content of the machine file, or {} when it is absent or not valid."""
    path = MACHINE_CATALOG if machine_file is None else machine_file
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_catalog(machine_file=None):
    """Return the resources of the catalog, with the machine file on top."""
    path = os.path.join(SKILL_DIR, "resources.json")
    with open(path, encoding="utf-8") as f:
        resources = dict(json.load(f).get("resources", {}))
    extra = machine_file_data(machine_file).get("resources") or {}
    for source, entries in ((path, resources),
                            (MACHINE_CATALOG if machine_file is None else machine_file, extra)):
        for rid, entry in entries.items():
            if "roles" in entry and (not isinstance(entry["roles"], list) or any(
                    not isinstance(role, str) or role not in ROLES for role in entry["roles"])):
                print(f"error: {source}: resources.{rid}.roles must be a list of known role names: "
                      + ", ".join(ROLES), file=sys.stderr)
                sys.exit(2)
    for rid, entry in extra.items():
        if entry.get("remove"):
            resources.pop(rid, None)
        else:
            resources[rid] = entry
    return resources


def load_launch(cfg, machine_file=None):
    """Return the launch files of roles.json, with the machine file on top. A value that is not set is left out."""
    launch = dict(cfg.get("launch") or {})
    launch.update(machine_file_data(machine_file).get("launch") or {})
    return {k: os.path.expanduser(v.replace("{skill}", SKILL_DIR))
            for k, v in launch.items() if k != "comment" and isinstance(v, str) and v.strip()}


def mcp_servers(resources, group="web"):
    """Return MCP server settings for entries with a URL, in catalog order."""
    servers = {}
    for _, rid, e in sorted((e.get("order", 100), rid, e) for rid, e in resources.items()
                            if e.get("group") == group and e.get("kind") == "mcp"):
        name = e.get("mcp_server") or rid
        url = next((loc["url"] for loc in e.get("locations") or [] if loc.get("url")), None)
        if url and re.fullmatch(r"[A-Za-z0-9_-]+", name):
            settings = {"url": url}
            if "headers_helper" in e:
                settings["headers_helper"] = os.path.expanduser(e["headers_helper"])
            servers.setdefault(name, settings)
    return servers


def location_state(loc):
    """Return (text, found). found is True, False or None when there is no check."""
    if "file" in loc:
        path = os.path.expanduser(loc["file"])
        return loc["file"], os.path.isfile(path)
    if "url" in loc:
        import urllib.error
        import urllib.request
        try:
            with urllib.request.urlopen(loc["url"], timeout=2):
                return loc["url"], True
        except urllib.error.HTTPError:
            return loc["url"], True  # the server answered
        except (OSError, ValueError):
            return loc["url"], False
    if "command" in loc:
        from shutil import which
        return loc["command"], which(loc["command"]) is not None
    return "", None


def resolve_resource(entry):
    """Find the first location that is present. Return (location text or None, found)."""
    locations = entry.get("locations") or []
    if not locations:
        return None, None
    for loc in locations:
        text, found = location_state(loc)
        if found:
            return text, True
    return None, False


def role_matches(entry, role):
    """Without a role filter, include even an entry with an empty roles list."""
    return role is None or "roles" not in entry or role in entry["roles"]


def catalog_lines(resources, group, role=None):
    """Return (lines for the role prompt, titles that are not on the machine)."""
    lines, absent = [], []
    chosen = sorted((e.get("order", 100), rid, e) for rid, e in resources.items()
                    if e.get("group") == group and role_matches(e, role))
    for _, rid, e in chosen:
        where, found = resolve_resource(e)
        if found is False:
            absent.append(e.get("title", rid))
            continue
        line = f"{len(lines) + 1}. **{e.get('title', rid)}** (`{rid}`). {e.get('use_when', '')} How: {e.get('load', '')}"
        if where and not where.startswith("http"):
            line += f" Location: `{where}`."
        lines.append(line)
    return lines, absent
