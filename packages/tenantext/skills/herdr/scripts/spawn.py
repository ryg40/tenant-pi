#!/usr/bin/env python3
"""Start one new agent in the tab of its role. Does not send a task.

Usage: spawn.py --harness pi|claude|agy --role coordinator|researcher|scout|worker|reviewer
                [--model NAME] [--thinking LEVEL] [--cwd PATH] [--interactive]
                [--strict] [--unattended] [--start-timeout SECONDS] [--dry-run]
                [-- <extra native arguments>]

Inputs
  --harness      the agent program: pi, claude or agy (the Antigravity CLI; see SPAWN.md, "The agy harness")
  --role         sets the tab, the focus and the access (read or write); see roles.json
  --model        pi: provider/model, or a model name that `pi --list-models` finds one time
                 claude: a model ID or an alias of the claude CLI (opus, claude-opus-5-5)
                 agy: a slug of `agy models` (the first column)
                 absent: models.json must name one for the role and the harness,
                 else spawn.py starts no pane and exits with 2 (agy: it starts with its own default model)
  --thinking     off|minimal|low|medium|high|xhigh|max  (claude: low is the minimum;
                 agy: low|medium|high|xhigh|max, given as --effort)
                 absent: models.json supplies a level when no model is named, else the harness chooses
  --interactive  the user works in this session: no task session result format. coordinator implies it
  --strict       apply hard tool limits: read roles cannot edit files, and a role with web
                 access gets only the MCP servers of the catalog (see SPAWN.md). Without it,
                 the role prompt gives an order of preference with fallbacks and removes no tool,
                 except the desktop tools of the computer-use module for read roles (SPAWN.md)
  --unattended   claude write roles only: allow edits in advance.
                 The auto mode decides each shell command.
  --dry-run      print the resolved values and the command; create nothing

Placement and names are fixed; see LAYOUT.md. The name is <project>-<role>-<n>.
On the herdr-core backend (a pane of the Herdr app) the agent starts through `hc run`; see SPAWN.md.
agy has no flag for a role prompt: spawn.py writes the role prompt file, and when the pane is ready it sends one
first message through ask.py that tells the session to read the file. The pane counts as ready after that turn.
Prints one JSON line. Exit codes: 0 ready | 2 bad input
  4 the agent stopped at a startup question | 1 start failed (the new pane is closed again)
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import _common  # noqa: E402
from _common import (STATE_DIR, agent_info, api, catalog_lines, core_local, core_project, core_role, core_role_tab, ensure_layout, error_code, exit_codes, hc, herdr,  # noqa: E402
                     herdr_app_pane, live_agents, load_catalog, load_launch, make_name, mcp_servers, pane_label, panes, place_role_tab,
                     read_record, remove_record, require_backend, require_herdr_env, tabs, write_record)

EXIT = exit_codes("spawn")

THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
HARNESSES = ("pi", "claude", "agy")
# The values of `agy --effort` (agy --help of agy 1.5.15). A slug of `agy models` can end with one of them.
AGY_EFFORT = ["low", "medium", "high", "xhigh", "max"]
# A line of `agy models` is `slug<TAB>name`: the slug of a model is the first column.
AGY_SLUG = re.compile(r"([a-z0-9][a-z0-9._-]*)\t+\S")
# The print mode, the initial-prompt mode and the ACP server of agy: the skill never starts them.
# The names are flag names without dashes: agy reads its flags with the Go `flag` package, which takes
# `-print` and `--print` as the same flag. `acp` is a subcommand.
AGY_REFUSED_FLAGS = ("p", "print", "prompt", "i", "prompt-interactive")
AGY_REFUSED_COMMANDS = ("acp",)
# agy has no system-prompt flag, so its first message points to the role prompt file (SPAWN.md, "The agy harness").
AGY_FIRST_MESSAGE = ("Read the file {path}. It gives your role and the rules of this session, and for a task session "
                     "the result format. Follow it for each task in this session. Then reply in one line with the "
                     "name of your role.")
AGY_FIRST_SECONDS = 300  # the longest wait for the turn of the first message
# The line on stderr that names a started agy pane before the wait for its first turn. The last stdout line
# stays the one JSON result; a caller that stops spawn.py during the wait reads this line (contract.json).
AGY_STARTED_PREFIX = _common.CONTRACT["spawn"]["started_line_prefix"]
# The note of ask.py for a reply with no result block. The reply of the first message is one line by design.
ASK_NO_BLOCK_NOTE = _common.CONTRACT["ask"]["no_block_note"]
CLAUDE_READ_TOOLS = ("Read Grep Glob Bash(rg:*) Bash(ls:*) Bash(cat:*) Bash(git log:*) "
                     "Bash(git diff:*) Bash(git show:*) Bash(git status:*) Bash(git grep:*)")
# Each agent can use this skill: read panes, prompt other agents, start agents.
CLAUDE_HERDR_TOOLS = (f"Skill Bash(python3 {HERE}/:*) Bash(herdr agent:*) "
                      "Bash(herdr pane neighbor:*) Bash(herdr pane get:*) Bash(herdr pane layout:*) "
                      "Bash(herdr tab list:*) Bash(herdr workspace list:*) Bash(herdr --skill) "
                      "Bash(jq:*) Bash(test:*) Bash(echo:*)")
# The desktop tools of the computer-use modules: the Pi extensions (Linux computer_use_linux_*, macOS
# computer_use_*) and the server of the Claude Code plugin.
PI_DESKTOP_TOOLS = "computer_use_*"
CLAUDE_DESKTOP_TOOLS = "mcp__plugin_computer-use-linux_computer-use-linux"


def fail(msg, code=EXIT["invalid"]):
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


def models_path():
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "herdr-skill", "models.json")


def local_models(cfg):
    path = models_path()
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
        check_object(harnesses, set(HARNESSES), f"roles.{role}")
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


def resolve(opts, cfg, *, lookup_timeout=None):
    roles = cfg["roles"]
    if opts["harness"] not in HARNESSES:
        fail(f"--harness must be one of: {', '.join(HARNESSES)}")
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
        model = resolve_pi_model(model) if lookup_timeout is None else resolve_pi_model(model, timeout=lookup_timeout)
    effort = None
    if harness == "agy":
        model, effort = (resolve_agy(model, thinking, opts) if lookup_timeout is None
                         else resolve_agy(model, thinking, opts, timeout=lookup_timeout))
    primary = opts["interactive"] or role["session"] == "primary"
    out = {"harness": harness, "role": opts["role"], "model": model, "model_source": source, "thinking": thinking,
           "strict": bool(opts.get("strict")),
           "session": "primary" if primary else "subagent", "access": role["access"],
           "web": role["web"], "focus": role["focus"]}
    if harness == "agy":
        out["effort"] = effort  # the value of --effort, or None when the slug carries the effort
    return out


# The switch of the recall compressor of the OpenViking memory plugin. A task session has a task file and
# needs no compressed recall block, so it gets `off`; a primary session keeps the default of its harness.
RECALL_COMPRESS_VARIABLE = "OPENVIKING_RECALL_COMPRESS"


def session_env(r):
    """The environment of the session: the compressor switch for a task session, else {}."""
    return {} if r["session"] == "primary" else {RECALL_COMPRESS_VARIABLE: "off"}


def session_env_command(r):
    """The shell line for the new pane that exports the variables of a task session, or None for a primary one."""
    env = session_env(r)
    if not env:
        return None
    return "export " + " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())


def pi_executable():
    executable = load_launch({}).get("pi_executable", "pi")
    if executable != "pi" and (not os.path.isabs(executable)
                              or any(ord(c) < 32 or ord(c) == 127 for c in executable)
                              or not os.path.isfile(executable) or not os.access(executable, os.X_OK)):
        fail("launch.pi_executable must be an absolute executable file path")
    return executable


def is_pi_bolt(executable):
    """True when the first line of `<executable> --version` names Pi-Bolt."""
    try:
        out = subprocess.run([executable, "--version"], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "(Pi-Bolt " in (out.splitlines() or [""])[0]


def prepare_pi_launcher(pane, executable, project=False, harness="pi"):
    if executable == "pi" and not project:
        return
    # Right after a new pane opens, its shell can still be busy (for example two foreground processes while
    # .bashrc runs). Wait, about 20 seconds at most, until the pane is at one foreground process; a failed
    # call may also retry. One foreground process ends the wait at once, a POSIX shell or not.
    for attempt in range(40):
        if attempt:
            time.sleep(0.5)
        code, data, raw = herdr("pane", "process-info", "--pane", pane)
        try:
            processes = data["result"]["process_info"]["foreground_processes"]
            supported = len(processes) == 1 and processes[0]["name"] in ("bash", "zsh", "sh", "dash", "ksh")
        except (TypeError, KeyError):
            processes, supported = None, False
        if code == 0 and isinstance(processes, list) and len(processes) == 1:
            break
    if code != 0 or not supported:
        if project and executable in HARNESSES:
            print("credsync: pane shell cannot install the wrapper; starting unchanged; use a POSIX shell", file=sys.stderr)
            return
        raise RuntimeError("custom Pi launcher requires a new pane at a POSIX shell prompt")
    # Herdr keeps its Pi lifecycle detection; only this new shell gets the wrapper.
    target = shlex.quote(executable)
    if project:
        wrapper = os.path.join(HERE, "credsync-launch.sh")
        target = f'/bin/sh {shlex.quote(wrapper)} {target}'
    command = f'{harness}() {{ {target} "$@"; }}'
    if harness == "pi" and executable != "pi" and is_pi_bolt(executable):
        # Pi-Bolt reports the agent name pi-bolt, which Herdr 0.9.5 does not know. Without
        # HERDR_SOCKET_PATH it skips that report and Herdr detects the process as pi.
        command = f'pi() {{ (unset HERDR_SOCKET_PATH; exec {target} "$@"); }}'
    code, data, raw = herdr("pane", "run", pane, command)
    if code != 0 or error_code(data):
        if project and executable in HARNESSES:
            print("credsync: pane wrapper setup failed; starting unchanged; check the pane shell", file=sys.stderr)
            return
        raise RuntimeError("could not configure the custom Pi launcher in the new pane")


def resolve_pi_model(asked, timeout=60):
    """Accept provider/model, a model ID, or the last part of a model ID.

    The list of pi is the authority. No model name is stored in this skill.
    """
    key = asked.split("/")[-1]
    executable = pi_executable()
    try:
        out = subprocess.run([executable, "--list-models", key], capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        fail(f"could not run `{executable} --list-models`", EXIT["failed"])
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


def agy_refused(arg):
    """True for a native argument that starts a mode of agy that the skill never starts, in each spelling.

    Each argument counts, in each position: also after a second `--` or after a non-flag argument."""
    if arg in AGY_REFUSED_COMMANDS:
        return True
    return arg.startswith("-") and arg.lstrip("-").split("=", 1)[0] in AGY_REFUSED_FLAGS


def agy_executable():
    """The path of `agy` in PATH. Exit 2 when it is not there."""
    path = shutil.which("agy")
    if not path:
        fail("the harness agy needs the program `agy` (the Antigravity CLI) in PATH, and it is not there. "
             "Install it and sign in by hand. No pane was started.")
    return path


def resolve_agy(model, thinking, opts, timeout=60):
    """Return (model, effort) for the harness agy. Exit 2 for a value that agy does not take.

    The slug of a model can carry the effort, for example `-xhigh`. A thinking level that names another
    effort is refused; the same effort adds no --effort. A thinking level with no model or with a slug
    without an effort part becomes `--effort`. `agy models` is the authority for a slug.
    """
    executable = agy_executable()
    if opts.get("strict"):
        fail("--strict has no effect for agy: the skill sets no tool limit for it. Leave --strict out.")
    if thinking is not None and thinking not in AGY_EFFORT:
        fail(f"--thinking for agy must be one of: {', '.join(AGY_EFFORT)} (the values of agy --effort)")
    if model is None:
        return None, thinking
    try:
        p = subprocess.run([executable, "models"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        fail("could not run `agy models`. Leave --model out, or check agy by hand. No pane was started.")
    slugs = [m.group(1) for m in map(AGY_SLUG.match, (p.stdout or "").splitlines()) if m]
    if p.returncode != 0 or not slugs:
        lines = [l.strip() for l in ((p.stdout or "") + "\n" + (p.stderr or "")).splitlines() if l.strip()]
        why = next((l for l in lines if "rror" in l), lines[-1] if lines else "")
        fail(f"`agy models` listed no model (exit {p.returncode}: {why[:200]}). Sign in to agy by hand, "
             "or leave --model out for the default model of agy. No pane was started.")
    if model not in slugs:
        fail(f"agy lists no model '{model}'. Give a slug of `agy models`: {', '.join(slugs)}")
    suffix = model.rsplit("-", 1)[-1]
    if suffix in AGY_EFFORT:
        if thinking is not None and thinking != suffix:
            fail(f"the model {model} carries the effort {suffix}, and the thinking level is {thinking}. "
                 "Give the slug with the effort that you want, or leave the thinking level out.")
        return model, None
    return model, thinking


def render_methods(text, resources, role=None):
    """Render method lists and collect absent entries from lists and group pointers."""
    absent_all = []
    groups = re.findall(r"\{methods:([a-z]+)\}", text) + re.findall(r"--group ([a-z]+)\b", text)
    for group in dict.fromkeys(groups):
        lines, absent = catalog_lines(resources, group, role)
        absent_all += absent
        text = text.replace("{methods:" + group + "}", "\n".join(lines))
    if absent_all:
        text = text.replace("{absent}", "Not found on this machine when you started: " + ", ".join(absent_all)
                            + ". Try one of them only if the task asks for it.")
    else:
        text = text.replace("{absent}\n\n", "").replace("{absent}", "")
    return text.replace("{resources_command}", f"python3 {HERE}/resources.py")


def system_prompt(r, cfg=None):
    text = open(os.path.join(SKILL, "roles", r["role"] + ".md"), encoding="utf-8").read().strip()
    text = render_methods(text, load_catalog(), r["role"])
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

    Default: no tool is removed, except the desktop tools of the computer-use module for read
    roles. The role prompt gives the order of preference.
    With strict: read roles lose the edit tools, and a role with web access gets only
    the MCP servers of the catalog. The catalog ships no MCP server; the machine file adds one.
    """
    resources = load_catalog()
    paths = load_launch(cfg)
    sub = r["session"] == "subagent"
    strict = r.get("strict")
    if r["harness"] == "agy":
        # No permission flag and no prompt flag: the role prompt file goes in the first message (agy_first_message).
        write_prompt(r, cfg, name, write)
        a = ["--model", r["model"]] if r["model"] else []
        return a + (["--effort", r["effort"]] if r.get("effort") else [])
    if r["harness"] == "pi":
        a = []
        if r["model"]:
            provider, mid = r["model"].split("/", 1)
            a += ["--provider", provider, "--model", mid]
        if r["thinking"]:
            a += ["--thinking", r["thinking"]]
        excluded = [PI_DESKTOP_TOOLS] if r["access"] == "read" else []
        if strict:
            a += ["--no-skills", "--skill", SKILL, "--no-prompt-templates"]
            if r["access"] == "read":
                excluded = ["edit", "write", *excluded]
            if r["web"] and paths.get("pi_mcp_config_strict"):
                a += ["--mcp-config", paths["pi_mcp_config_strict"]]
        if excluded:
            a += ["--exclude-tools", ",".join(excluded)]
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
        disallowed = [CLAUDE_DESKTOP_TOOLS] if r["access"] == "read" else []
        if strict and r["access"] == "read":
            disallowed = ["Edit Write NotebookEdit" + (" WebSearch WebFetch" if r["web"] else ""), *disallowed]
        if disallowed:
            a += ["--disallowedTools", " ".join(disallowed)]
        if sub and r["access"] == "write" and unattended:
            allowed.append("Read Write Edit Grep Glob")
        servers = mcp_servers(resources) if r["web"] else {}
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
    prompt_file = write_prompt(r, cfg, name, write)
    a += ["--append-system-prompt" if r["harness"] == "pi" else "--append-system-prompt-file", prompt_file]
    return a


def prompt_path(name):
    return os.path.join(STATE_DIR, "prompts", f"{name}.md")


def write_prompt(r, cfg, name, write):
    """Write the role prompt file of the agent and return its path. Herdr refuses arguments with line breaks."""
    prompt_file = prompt_path(name)
    if write:
        os.makedirs(os.path.dirname(prompt_file), mode=0o700, exist_ok=True)
        with open(prompt_file, "w", encoding="utf-8") as f:
            f.write(system_prompt(r, cfg) + "\n")
    return prompt_file


def agy_first_message(name):
    return AGY_FIRST_MESSAGE.format(path=prompt_path(name))


def send_agy_role_prompt(pane, name, out):
    """Send the first message of an agy pane through ask.py and wait for its turn. Exit when it does not end well.

    `out` is the JSON object of the ready pane; spawn.py prints it with the result of this turn. Before the wait,
    one flushed stderr line names the pane, so that a caller that stops spawn.py can still close the pane.
    """
    print(AGY_STARTED_PREFIX + json.dumps({"pane_id": pane, "name": name}), file=sys.stderr, flush=True)
    timeout = AGY_FIRST_SECONDS
    try:
        p = subprocess.run([sys.executable, os.path.join(HERE, "ask.py"), pane, "--text", agy_first_message(name),
                            "--timeout", str(timeout)], capture_output=True, text=True, timeout=timeout + 120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        why = (f"ask.py did not end in {timeout + 120} seconds" if isinstance(exc, subprocess.TimeoutExpired)
               else f"ask.py could not start: {exc}")
        p = None
    if p is not None:
        reply = (p.stdout or "").split("--- reply ---", 1)[-1].strip()
        reply = "\n".join(line for line in reply.splitlines() if line.strip() != ASK_NO_BLOCK_NOTE).strip()
        if p.returncode == 0:
            print(json.dumps(dict(out, role_prompt=prompt_path(name), first_reply=reply[:300])))
            return
        if p.returncode == exit_codes("ask")["blocked"]:
            print(json.dumps(dict(out, status="blocked", role_prompt=prompt_path(name))))
            print("The agent stopped at a question on its first message (the role prompt file). Read its screen, "
                  "show the question to the user, and wait for the decision.", file=sys.stderr)
            sys.exit(EXIT["startup_question"])
        why = f"ask.py gave exit {p.returncode}"
    print(json.dumps(dict(out, status="role prompt not confirmed", role_prompt=prompt_path(name))))
    detail = (p.stderr or p.stdout or "")[-300:] if p is not None else ""
    print(f"{why} on the first message of {pane}, the role prompt file; the pane stays "
          f"open. Read its screen before you send a task. {detail}".rstrip(), file=sys.stderr)
    sys.exit(EXIT["failed"])


def require_model(r):
    """Exit 2 when pi or claude has no model. agy starts with its own default model."""
    if not r["model"] and r["harness"] != "agy":
        fail(f"no model for the role {r['role']} and the harness {r['harness']}. Name one with --model <name>, "
             f"or add roles.{r['role']}.{r['harness']}.model to {models_path()} (models.example.json shows the shape). "
             "No pane was started.")


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
            fail(f"could not create the tab '{role}': {raw[:300]}", EXIT["failed"])
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
        fail(f"could not split pane {target}: {raw[:300]}", EXIT["failed"])
    return data["result"]["pane"]["pane_id"], f"split {direction} of {target} in tab '{role}'"


def main():
    found = require_backend("spawn", core=True)
    app = None
    if found["backend"] == "core":
        app = herdr_app_pane(found)
        if not app:
            print(f"error: the herdr-core terminal {found['terminal']} is no pane of the Herdr app (no herdr.space or "
                  "herdr.tab label), so spawn.py has no space for the agent. Nothing was done.", file=sys.stderr)
            sys.exit(_common.CONTRACT["backend"]["refusal_exit"]["spawn"])
    if len(sys.argv) == 1:
        sys.exit(__doc__)
    opts, extra = parse(sys.argv[1:])
    with open(os.path.join(SKILL, "roles.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    r = resolve(opts, cfg)
    if r["harness"] == "agy":
        refused = [x for x in extra if agy_refused(x)]
        if refused:
            fail(f"spawn.py starts agy only as an interactive session; it refuses {', '.join(refused)} after --.")
    if not os.path.isdir(opts["cwd"]):
        fail(f"cwd is not a directory: {opts['cwd']}")
    cwd = os.path.realpath(opts["cwd"])
    if opts["unattended"] and not (r["harness"] == "claude" and r["access"] == "write"):
        fail("--unattended applies only to claude with a write role")

    if app:
        return spawn_in_app(app, r, cfg, opts, extra, cwd)
    require_herdr_env()
    me = ensure_layout(quiet=False) if not opts["dry_run"] else ensure_layout_readonly()
    if not me:
        fail("could not read your pane from Herdr", EXIT["failed"])
    name = make_name(me["workspace"], r["role"], live_agents())
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name):
        fail(f"could not build a valid name from the workspace label: {name}", EXIT["failed"])
    label = pane_label(name, r["harness"], r["model"], r["thinking"])
    # The check of the model follows the catalog check of native_args, so a bad catalog keeps its own error.
    executable, args, _ = build_command(r, cfg, name, cwd, unattended=opts["unattended"], extra=extra,
                                        write=bool(r["model"] or r["harness"] == "agy") and not opts["dry_run"])
    shown = [x if len(x) < 100 else x[:60].replace("\n", " ") + f"... ({len(x)} chars)" for x in args]
    summary = dict(r, name=name, pane_label=label, tab=r["role"], cwd=cwd, workspace=me["workspace"],
                   executable=executable, session_env=session_env(r))
    if r["harness"] == "agy":
        summary["first_message"] = agy_first_message(name)

    print(model_message(r), file=sys.stderr)
    if opts["dry_run"]:
        print(json.dumps(dict(summary, dry_run=True, command=[executable] + shown)))
        return

    pane, how = place(r, me, cwd)
    herdr("pane", "rename", pane, label)
    write_record(pane, dict(summary, pane_id=pane, owner_pane_id=me["pane_id"],
                            workspace_id=me["workspace_id"], created_at_epoch=time.time()))

    time.sleep(1)  # let the shell reach its prompt
    # The shell of the pane exports the variables of a task session, so the agent and the Pi-Bolt subshell of the
    # `pi` function inherit them; `herdr agent start` has no option for the environment.
    command = session_env_command(r)
    if command is not None:
        code, data, raw = herdr("pane", "run", pane, command)
        if code != 0 or error_code(data):
            herdr("pane", "close", pane)
            remove_record(pane)
            fail("could not set the session environment in the new pane", EXIT["failed"])
    project = os.path.isfile(os.path.join(cwd, ".credsync.json"))
    if r["harness"] == "pi" or project:
        try:
            prepare_pi_launcher(pane, executable, project=project, harness=r["harness"])
        except RuntimeError as exc:
            herdr("pane", "close", pane)
            remove_record(pane)
            fail(str(exc), EXIT["failed"])
    code, data, raw = herdr("agent", "start", name, "--kind", r["harness"], "--pane", pane,
                            "--timeout", str(int(opts["start_timeout"]) * 1000), "--", *args,
                            timeout=int(opts["start_timeout"]) + 30)
    err = error_code(data)
    if err == "agent_not_ready":
        recorded = set_agent_meta(pane, r)
        print(json.dumps(dict(summary, pane_id=pane, placement=how, status="blocked", meta_recorded=recorded)))
        print("The agent stopped at a startup question (for example folder trust). "
              f"Read it with `herdr agent read {pane} --source visible`, show it to the user, and wait for the decision.",
              file=sys.stderr)
        sys.exit(EXIT["startup_question"])
    if code != 0 or err or not data:
        herdr("pane", "close", pane)
        remove_record(pane)
        fail(f"agent start failed and the new pane was closed: {raw[:400]}", EXIT["failed"])
    a = data["result"]["agent"]
    recorded = set_agent_meta(pane, r)
    out = dict(summary, pane_id=pane, placement=how, status=a.get("agent_status"),
               transcript=(a.get("agent_session") or {}).get("value"), meta_recorded=recorded)
    if r["harness"] == "agy":
        return send_agy_role_prompt(pane, name, out)
    print(json.dumps(out))


# ---------------------------------------------------------------------------
# The Herdr app (herdr-app): its panes are herdr-core terminals, and `hc` is the API.
# ---------------------------------------------------------------------------
APP_READY = ("idle", "done")


def app_tab(me, role):
    """The herdr.tab label of the new terminal and the placement text (core_role_tab)."""
    tab = core_role_tab(me["labels"], role)
    return tab, "the tab of the caller" if role == "coordinator" else f"the tab of the role '{role}'"


def launch_argv(r, executable, args, cwd):
    """The env, launcher and harness arguments that start an agent in a shell."""
    setup = [f"{k}={v}" for k, v in session_env(r).items()]
    launcher = [executable]
    if cwd and os.path.isfile(os.path.join(cwd, ".credsync.json")):
        launcher = ["/bin/sh", os.path.join(HERE, "credsync-launch.sh"), executable]
    return ["env", *setup, *launcher, *args]


def build_command(r, cfg, name, cwd, *, unattended=False, extra=(), write=True):
    """Build (executable, args, argv) for a resolved agent launch.

    The check of the model follows the catalog check of native_args, so a bad catalog keeps its own error.
    `argv` is the `env ... <launcher> <args>` vector shared by spawn.py and role_set.py.
    """
    args = native_args(r, cfg, unattended, name, write=write) + list(extra)
    require_model(r)
    executable = pi_executable() if r["harness"] == "pi" else r["harness"]
    return executable, args, launch_argv(r, executable, args, cwd)


def app_command(r, executable, args, cwd):
    """The program of the new terminal.

    herdr-core gives a new terminal its own environment, not the environment of the caller. An interactive
    shell of the user loads the same PATH and variables as a pane that the user opens by hand; then `env`
    sets the variables of a task session and starts the agent.
    """
    shell = os.environ.get("SHELL") or "/bin/sh"
    return [shell, "-ic", 'exec "$@"', shell, *launch_argv(r, executable, args, cwd)]


def app_wait(address, seconds):
    """Wait for the first status of the agent. Return its state, "exited", or None after the timeout."""
    end = time.time() + seconds
    while True:
        code, data, raw = hc("get", address, "--json", timeout=20)
        data = data if isinstance(data, dict) else {}
        if data and data.get("state") != "live":
            return "exited"
        state = (data.get("status") or {}).get("state")
        if state in APP_READY or state == "blocked":
            return state
        if time.time() >= end:
            return state
        time.sleep(1)


def spawn_in_app(me, r, cfg, opts, extra, cwd):
    """Start the agent as a herdr-core terminal with the labels of the space and the tab."""
    code, data, raw = hc("ls", "--json", timeout=20)
    if code != 0 or not isinstance(data, dict):
        fail(f"could not list the herdr-core terminals: {raw[:300]}", EXIT["failed"])
    project = core_project(me)
    # Only the terminals of this machine: `hc ls` also lists other machines, whose names are not ours.
    local = [t for t in data.get("terminals") or [] if isinstance(t, dict) and core_local(t.get("address"))]
    handoff = r["role"] == "coordinator" and core_role(me) == "coordinator"
    if handoff:
        # A handoff: the first coordinator of a space has no terminal name (the core has no rename), so it
        # counts as number 1 and the new coordinator gets 2 or higher.
        local = local + [{"name": make_name(project, "coordinator", [])}]
    name = make_name(project, r["role"], local)
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name):
        fail(f"could not build a valid name from the place of the pane: {name}", EXIT["failed"])
    executable, args, _ = build_command(r, cfg, name, cwd, unattended=opts["unattended"], extra=extra,
                                        write=bool(r["model"] or r["harness"] == "agy") and not opts["dry_run"])
    tab, how = app_tab(me, r["role"])
    summary = dict(r, name=name, pane_label=pane_label(name, r["harness"], r["model"], r["thinking"]), tab=r["role"],
                   cwd=cwd, workspace=project, executable=executable, session_env=session_env(r), backend="herdr-core")
    if r["harness"] == "agy":
        summary["first_message"] = agy_first_message(name)
    command = app_command(r, executable, args, cwd)
    labels = {"herdr.space": me["labels"]["herdr.space"], "herdr.tab": tab, "herdr.seen": "0", "skill.role": r["role"]}
    if r["role"] != "coordinator":
        # The Herdr app names a NEW tab after this label and never renames a tab that exists (LAYOUT.md).
        labels["herdr.tab.name"] = r["role"]
    if handoff:
        # The Herdr app puts the pane of the new coordinator below the pane of its parent, the caller (LAYOUT.md).
        labels["herdr.split"] = "down"
    elif r["role"] != "coordinator":
        # The Herdr app splits the largest pane of the role tab, the same rule as `place` on Herdr 1 (LAYOUT.md).
        labels["herdr.split"] = "auto"
    run = ["run", "--json", "--bg", "--keep", "--outlive-parent", "--name", name, "--cwd", cwd]
    for key, value in labels.items():
        run += ["--label", f"{key}={value}"]

    print(model_message(r), file=sys.stderr)
    if opts["dry_run"]:
        shown = [x if len(x) < 100 else x[:60].replace("\n", " ") + f"... ({len(x)} chars)" for x in command]
        print(json.dumps(dict(summary, dry_run=True, command=["hc", *run, "--", *shown])))
        return
    code, data, raw = hc(*run, "--", *command, timeout=60)
    address = data.get("address") if isinstance(data, dict) else None
    if code != 0 or not address:
        fail(f"hc run started no terminal: {raw[:400]}", EXIT["failed"])
    write_record(address, dict(summary, pane_id=address, owner_pane_id=me["address"],
                               workspace_id=labels["herdr.space"], created_at_epoch=time.time()))
    state = app_wait(address, int(opts["start_timeout"]))
    if state == "exited":
        remove_record(address)
        fail(f"the agent ended at once; read its screen with `hc read {address}`", EXIT["failed"])
    out = dict(summary, pane_id=address, placement=how, status=state or "started")
    if state in APP_READY:
        if r["harness"] == "agy":
            return send_agy_role_prompt(address, name, out)
        print(json.dumps(out))
        return
    print(json.dumps(dict(out, status="blocked" if state == "blocked" else "no status yet")))
    print("The agent gave no ready status (for example a startup question such as folder trust). "
          f"Read it with `hc read {address}`, show a question to the user, and wait for the decision.", file=sys.stderr)
    sys.exit(EXIT["startup_question"])


def set_agent_meta(pane, r):
    """Record the resolved model and thinking on the Herdr agent record of the pane.

    Herdr builds without `pane.set_agent_meta` answer `invalid_request`; the spawn still counts.
    Returns True when Herdr recorded the values, else False (also when there is nothing to record).
    """
    params = {"pane_id": pane}
    for key in ("model", "thinking"):
        if r.get(key):
            params[key] = r[key]
    if len(params) == 1:
        return False
    reply = api("pane.set_agent_meta", params)
    if not isinstance(reply, dict) or "result" not in reply:
        code = error_code(reply) if isinstance(reply, dict) else "no reply"
        print(f"warning: Herdr did not record model and thinking for {pane} ({code})", file=sys.stderr)
        return False
    return True


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
