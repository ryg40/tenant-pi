"""Shared helpers for the herdr skill scripts. Standard library only."""
import glob
import json
import os
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


def clip(text, max_chars):
    if len(text) <= max_chars:
        return text
    return f"[... first {len(text) - max_chars} characters omitted ...]\n" + text[-max_chars:]


# ---------------------------------------------------------------------------
# Layout and names. See LAYOUT.md.
# ---------------------------------------------------------------------------
ROLES = ["coordinator", "researcher", "scout", "worker", "reviewer"]
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
    os.makedirs(os.path.dirname(record_path(pane_id)), mode=0o700, exist_ok=True)
    with open(record_path(pane_id), "w") as f:
        json.dump(data, f)


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
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
    with open(os.path.join(SKILL_DIR, "resources.json"), encoding="utf-8") as f:
        resources = dict(json.load(f).get("resources", {}))
    extra = machine_file_data(machine_file).get("resources") or {}
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


def catalog_lines(resources, group):
    """Return (lines for the prompt, titles that are not on the machine)."""
    lines, absent = [], []
    chosen = sorted((e.get("order", 100), rid, e) for rid, e in resources.items() if e.get("group") == group)
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
