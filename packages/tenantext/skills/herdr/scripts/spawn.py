#!/usr/bin/env python3
"""Start one new agent in the tab of its role. Does not send a task.

Usage: spawn.py --harness pi|claude --role coordinator|researcher|scout|worker|reviewer
                [--model NAME] [--thinking LEVEL] [--cwd PATH] [--interactive]
                [--strict] [--unattended] [--start-timeout SECONDS] [--dry-run]
                [-- <extra native arguments>]

Inputs
  --harness      the agent program: pi or claude
  --role         sets the tab, the focus and the access (read or write); see roles.json
  --model        pi: provider/model, or a model name that `pi --list-models` finds one time
                 claude: a model ID or an alias of the claude CLI (opus, claude-opus-5-5)
                 absent: models.json supplies a default, else the harness chooses
  --thinking     off|minimal|low|medium|high|xhigh|max  (claude: low is the minimum)
                 absent: models.json supplies a level when no model is named, else the harness chooses
  --interactive  the user works in this session: no task session result format. coordinator implies it
  --strict       apply hard tool limits: read roles cannot edit files, and a role with web
                 access gets only the MCP servers of the catalog (see SPAWN.md). Without it,
                 the role prompt gives an order of preference with fallbacks and removes no tool
  --unattended   claude write roles only: allow all shell commands and edits in advance
  --dry-run      print the resolved values and the command; create nothing

Placement and names are fixed; see LAYOUT.md. The name is <project>-<role>-<n>.
Prints one JSON line. Exit codes: 0 ready | 2 bad input
  4 the agent stopped at a startup question | 1 start failed (the new pane is closed again)
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from _common import (STATE_DIR, agent_info, catalog_lines, ensure_layout, error_code, herdr,  # noqa: E402
                     live_agents, load_catalog, load_launch, make_name, mcp_servers, pane_label, panes, place_role_tab,
                     read_record, remove_record, require_herdr_env, tabs, write_record)

THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
CLAUDE_READ_TOOLS = ("Read Grep Glob Bash(rg:*) Bash(ls:*) Bash(cat:*) Bash(git log:*) "
                     "Bash(git diff:*) Bash(git show:*) Bash(git status:*) Bash(git grep:*)")
# Each agent can use this skill: read panes, prompt other agents, start agents.
CLAUDE_HERDR_TOOLS = (f"Skill Bash(python3 {HERE}/:*) Bash(herdr agent:*) "
                      "Bash(herdr pane neighbor:*) Bash(herdr pane get:*) Bash(herdr pane layout:*) "
                      "Bash(herdr tab list:*) Bash(herdr workspace list:*) Bash(herdr --skill) "
                      "Bash(jq:*) Bash(test:*) Bash(echo:*)")


def fail(msg, code=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def parse(argv):
    extra = []
    if "--" in argv:
        i = argv.index("--")
        argv, extra = argv[:i], argv[i + 1:]
    opts = {"harness": None, "role": None, "model": None, "thinking": None,
            "cwd": os.getcwd(), "start_timeout": "60",
            "interactive": False, "strict": False, "unattended": False, "dry_run": False}
    i = 0
    while i < len(argv):
        if not argv[i].startswith("--"):
            fail(f"unknown argument '{argv[i]}'. Run spawn.py with no arguments for the usage.")
        key = argv[i][2:].replace("-", "_")
        if key not in opts:
            fail(f"unknown option '{argv[i]}'")
        if isinstance(opts[key], bool):
            opts[key] = True
            i += 1
        else:
            if i + 1 >= len(argv):
                fail(f"{argv[i]} needs a value")
            opts[key] = argv[i + 1]
            i += 2
    return opts, extra


def local_models(cfg):
    path = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
                        "herdr-skill", "models.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, UnicodeError) as exc:
        fail(f"{path}: {exc}")

    def check_object(value, allowed, location):
        if not isinstance(value, dict):
            fail(f"{path}: {location} must be an object")
        unknown = value.keys() - allowed
        if unknown:
            fail(f"{path}: {location} has unknown keys: {', '.join(sorted(unknown))}")

    check_object(data, {"roles"}, "root")
    roles = data.get("roles", {})
    check_object(roles, set(cfg["roles"]), "roles")
    for role, harnesses in roles.items():
        check_object(harnesses, {"pi", "claude"}, f"roles.{role}")
        for harness, entry in harnesses.items():
            location = f"roles.{role}.{harness}"
            check_object(entry, {"model", "thinking"}, location)
            for key, value in entry.items():
                if not isinstance(value, str) or not value.strip() or any(c in value for c in "\r\n"):
                    fail(f"{path}: {location}.{key} must be a nonempty string without line breaks")
            if "thinking" in entry and entry["thinking"] not in THINKING:
                fail(f"{path}: {location}.thinking must be one of: {', '.join(THINKING)}")
    return roles


def model_message(r):
    if r["model"] is None:
        return "model: harness default"
    return f"model: {r['model']} (from {r['model_source']})"


def resolve(opts, cfg):
    roles = cfg["roles"]
    if opts["harness"] not in ("pi", "claude"):
        fail("--harness must be pi or claude")
    if opts["role"] not in roles:
        fail(f"--role must be one of: {', '.join(roles)}")
    role = roles[opts["role"]]
    harness = opts["harness"]
    defaults = {} if opts["model"] is not None else local_models(cfg).get(opts["role"], {}).get(harness, {})
    model = opts["model"] if opts["model"] is not None else defaults.get("model")
    source = "request" if opts["model"] is not None else "models.json" if model else "harness default"
    thinking = opts["thinking"] if opts["thinking"] is not None else defaults.get("thinking")
    if thinking is not None and thinking not in THINKING:
        fail(f"--thinking must be one of: {', '.join(THINKING)}")
    if harness == "claude" and thinking in ("off", "minimal"):
        thinking = "low"
    if model and harness == "pi":
        model = resolve_pi_model(model)
    primary = opts["interactive"] or role["session"] == "primary"
    return {"harness": harness, "role": opts["role"], "model": model, "model_source": source, "thinking": thinking,
            "strict": bool(opts.get("strict")),
            "session": "primary" if primary else "subagent", "access": role["access"],
            "web": role["web"], "focus": role["focus"]}


def resolve_pi_model(asked):
    """Accept provider/model, a model ID, or the last part of a model ID.

    The list of pi is the authority. No model name is stored in this skill.
    """
    key = asked.split("/")[-1]
    try:
        out = subprocess.run(["pi", "--list-models", key], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        fail("could not run `pi --list-models`", 1)
    rows = [l.split()[:2] for l in out.splitlines()[1:] if len(l.split()) >= 2]
    full = [f"{p}/{m}" for p, m in rows]
    low = asked.lower()
    hits = [f for f in full if f.lower() == low]
    if not hits:
        hits = [f"{p}/{m}" for p, m in rows if m.lower() == low or m.lower().split("/")[-1] == low]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        near = ", ".join(full[:8]) or "none"
        fail(f"pi lists no model '{asked}'. Near matches: {near}. Give provider/model.")
    fail(f"the model '{asked}' is ambiguous. Give one of: {', '.join(hits)}")


def render_methods(text, resources):
    """Replace {methods:<group>} in a role prompt with the entries of the catalog."""
    absent_all = []
    for group in re.findall(r"\{methods:([a-z]+)\}", text):
        lines, absent = catalog_lines(resources, group)
        absent_all += absent
        lines.append(f"{len(lines) + 1}. **Report.** When no entry works, give what you tried and what is still unknown.")
        text = text.replace("{methods:" + group + "}", "\n".join(lines))
    if absent_all:
        text = text.replace("{absent}", "Not found on this machine when you started: " + ", ".join(absent_all)
                            + ". Try one of them only if the task asks for it.")
    else:
        text = text.replace("{absent}\n\n", "").replace("{absent}", "")
    return text.replace("{resources_command}", f"python3 {HERE}/resources.py")


def system_prompt(r, cfg=None):
    text = open(os.path.join(SKILL, "roles", r["role"] + ".md"), encoding="utf-8").read().strip()
    text = render_methods(text, load_catalog())
    if r.get("strict"):
        text += ("\n\n## Strict launch\n\nThis session has hard tool limits. "
                 "Tools that the limits remove are not available. Report a blocker if the task needs one.")
    if r["session"] == "primary":
        if r["role"] != "coordinator":
            text += ("\n\nYou are a primary session. The user talks to you directly. "
                     "Do the work and answer in the normal way. Do not use a task session result format.")
    else:
        text += "\n\n" + open(os.path.join(SKILL, "roles", "contract.md"), encoding="utf-8").read().strip()
    return text


def native_args(r, cfg, unattended, name, write=True):
    """Build the harness arguments.

    Default: no tool is removed. The role prompt gives the order of preference.
    With strict: read roles lose the edit tools, and a role with web access gets only
    the MCP servers of the catalog. The catalog ships no MCP server; the machine file adds one.
    """
    paths = load_launch(cfg)
    sub = r["session"] == "subagent"
    strict = r.get("strict")
    if r["harness"] == "pi":
        a = []
        if r["model"]:
            provider, mid = r["model"].split("/", 1)
            a += ["--provider", provider, "--model", mid]
        if r["thinking"]:
            a += ["--thinking", r["thinking"]]
        if strict:
            a += ["--no-skills", "--skill", SKILL, "--no-prompt-templates"]
            if r["access"] == "read":
                a += ["--exclude-tools", "edit,write"]
            if r["web"] and paths.get("pi_mcp_config_strict"):
                a += ["--mcp-config", paths["pi_mcp_config_strict"]]
    else:
        a = []
        if r["model"]:
            a += ["--model", r["model"]]
        if r["thinking"]:
            a += ["--effort", r["thinking"]]
        # The auto mode decides on most commands itself, so the agent does not stop on each one.
        a += ["--permission-mode", "auto"]
        # Allowed tools add to the permission settings of the user. They remove nothing.
        allowed = [CLAUDE_HERDR_TOOLS] if sub else []
        if sub and r["access"] == "read":
            allowed.append(CLAUDE_READ_TOOLS)
        if strict and r["access"] == "read":
            a += ["--disallowedTools", "Edit Write NotebookEdit" + (" WebSearch WebFetch" if r["web"] else "")]
        if sub and r["access"] == "write" and unattended:
            allowed.append("Bash Read Write Edit Grep Glob")
        servers = mcp_servers(load_catalog()) if r["web"] else {}
        if servers or (strict and r["web"]):
            # The MCP servers and their tool names come from the catalog. With no mcp entry, strict gives no server.
            mcp_file = os.path.join(STATE_DIR, "mcp", f"{name}.json")
            if write:
                os.makedirs(os.path.dirname(mcp_file), mode=0o700, exist_ok=True)
                with open(mcp_file, "w", encoding="utf-8") as f:
                    mcp_servers_config = {}
                    for server, settings in servers.items():
                        entry = {"type": "http", "url": settings["url"]}
                        if "headers_helper" in settings:
                            entry["headersHelper"] = settings["headers_helper"]
                        mcp_servers_config[server] = entry
                    json.dump({"mcpServers": mcp_servers_config}, f)
            a += ["--mcp-config", mcp_file]
            if strict:
                a += ["--strict-mcp-config"]
            allowed += [f"mcp__{n}" for n in servers]
        if allowed:
            a += ["--allowedTools", " ".join(allowed)]
    # Herdr refuses arguments with line breaks, so the role prompt goes through a file.
    prompt_file = os.path.join(STATE_DIR, "prompts", f"{name}.md")
    if write:
        os.makedirs(os.path.dirname(prompt_file), mode=0o700, exist_ok=True)
        with open(prompt_file, "w", encoding="utf-8") as f:
            f.write(system_prompt(r, cfg) + "\n")
    a += ["--append-system-prompt" if r["harness"] == "pi" else "--append-system-prompt-file", prompt_file]
    return a


def split_direction(rect):
    # A terminal cell is about twice as high as it is wide.
    return "right" if rect["width"] > 2.2 * rect["height"] else "down"


def tab_rects(pane_id):
    code, data, raw = herdr("pane", "layout", "--pane", pane_id)
    try:
        return {p["pane_id"]: p["rect"] for p in data["result"]["layout"]["panes"]}
    except (TypeError, KeyError):
        return {}


def is_free_shell(pane):
    """A pane that spawn.py made, whose agent is gone, and that shows a shell prompt."""
    if pane.get("agent") or not read_record(pane["pane_id"]):
        return False
    code, data, raw = herdr("pane", "process-info", "--pane", pane["pane_id"])
    try:
        procs = data["result"]["process_info"]["foreground_processes"]
        return len(procs) == 1 and procs[0]["name"] in ("bash", "zsh", "fish", "sh")
    except (TypeError, KeyError):
        return False


def place(r, me, cwd):
    """Return (pane_id, how). Creates the tab or the split. See LAYOUT.md."""
    ws, role = me["workspace_id"], r["role"]
    role_tab = next((t for t in tabs(ws) if t.get("label") == role), None)

    if role_tab is None:
        code, data, raw = herdr("tab", "create", "--workspace", ws, "--cwd", cwd, "--label", role, "--no-focus")
        if code != 0 or not data or error_code(data):
            fail(f"could not create the tab '{role}': {raw[:300]}", 1)
        place_role_tab(ws, data["result"]["tab"]["tab_id"], role)
        return data["result"]["root_pane"]["pane_id"], f"new tab '{role}'"

    in_tab = [p for p in panes(ws) if p["tab_id"] == role_tab["tab_id"]]
    if role == "coordinator":
        # A handoff: the next coordinator goes below the active coordinator.
        if me["tab_id"] == role_tab["tab_id"]:
            target = me["pane_id"]
        else:
            named = [(a.get("name") or "", a["pane_id"]) for a in live_agents()
                     if a["pane_id"] in {p["pane_id"] for p in in_tab}]
            target = sorted(named)[-1][1] if named else in_tab[-1]["pane_id"]
        direction = "down"
    else:
        free = next((p for p in in_tab if is_free_shell(p)), None)
        if free:
            herdr("pane", "run", free["pane_id"], f"cd {json.dumps(cwd)} && clear")
            time.sleep(1)
            return free["pane_id"], f"free pane in tab '{role}'"
        rects = tab_rects(in_tab[0]["pane_id"])
        target = max(rects, key=lambda k: rects[k]["width"] * rects[k]["height"]) if rects else in_tab[-1]["pane_id"]
        direction = split_direction(rects[target]) if rects else "down"
    code, data, raw = herdr("pane", "split", "--pane", target, "--direction", direction, "--cwd", cwd, "--no-focus")
    if code != 0 or not data or error_code(data):
        fail(f"could not split pane {target}: {raw[:300]}", 1)
    return data["result"]["pane"]["pane_id"], f"split {direction} of {target} in tab '{role}'"


def main():
    if len(sys.argv) == 1:
        sys.exit(__doc__)
    opts, extra = parse(sys.argv[1:])
    with open(os.path.join(SKILL, "roles.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    r = resolve(opts, cfg)
    if not os.path.isdir(opts["cwd"]):
        fail(f"cwd is not a directory: {opts['cwd']}")
    cwd = os.path.realpath(opts["cwd"])
    if opts["unattended"] and not (r["harness"] == "claude" and r["access"] == "write"):
        fail("--unattended applies only to claude with a write role")

    require_herdr_env()
    me = ensure_layout(quiet=False) if not opts["dry_run"] else ensure_layout_readonly()
    if not me:
        fail("could not read your pane from Herdr", 1)
    name = make_name(me["workspace"], r["role"], live_agents())
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name):
        fail(f"could not build a valid name from the workspace label: {name}", 1)
    label = pane_label(name, r["harness"], r["model"], r["thinking"])
    args = native_args(r, cfg, opts["unattended"], name, write=not opts["dry_run"]) + extra
    shown = [x if len(x) < 100 else x[:60].replace("\n", " ") + f"... ({len(x)} chars)" for x in args]
    summary = dict(r, name=name, pane_label=label, tab=r["role"], cwd=cwd, workspace=me["workspace"])

    print(model_message(r), file=sys.stderr)
    if opts["dry_run"]:
        print(json.dumps(dict(summary, dry_run=True, command=[r["harness"]] + shown)))
        return

    pane, how = place(r, me, cwd)
    herdr("pane", "rename", pane, label)
    write_record(pane, dict(summary, pane_id=pane, owner_pane_id=me["pane_id"],
                            workspace_id=me["workspace_id"], created_at_epoch=time.time()))

    time.sleep(1)  # let the shell reach its prompt
    code, data, raw = herdr("agent", "start", name, "--kind", r["harness"], "--pane", pane,
                            "--timeout", str(int(opts["start_timeout"]) * 1000), "--", *args,
                            timeout=int(opts["start_timeout"]) + 30)
    err = error_code(data)
    if err == "agent_not_ready":
        print(json.dumps(dict(summary, pane_id=pane, placement=how, status="blocked")))
        print("The agent stopped at a startup question (for example folder trust). "
              f"Read it with `herdr agent read {pane} --source visible`, show it to the user, and wait for the decision.",
              file=sys.stderr)
        sys.exit(4)
    if code != 0 or err or not data:
        herdr("pane", "close", pane)
        remove_record(pane)
        fail(f"agent start failed and the new pane was closed: {raw[:400]}", 1)
    a = data["result"]["agent"]
    print(json.dumps(dict(summary, pane_id=pane, placement=how, status=a.get("agent_status"),
                          transcript=(a.get("agent_session") or {}).get("value"))))


def ensure_layout_readonly():
    """For --dry-run: describe the caller and change nothing."""
    from _common import workspace_label
    me = os.environ.get("HERDR_PANE_ID")
    code, data, raw = herdr("pane", "get", me or "")
    if not data or error_code(data):
        return {}
    p = data["result"]["pane"]
    return {"workspace_id": p["workspace_id"], "workspace": workspace_label(p["workspace_id"]),
            "tab_id": p["tab_id"], "pane_id": p["pane_id"]}


if __name__ == "__main__":
    main()
