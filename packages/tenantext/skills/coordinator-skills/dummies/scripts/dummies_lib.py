"""Shared helpers of the dummies skill scripts. Python 3.11 standard library only."""
import json
import os
import shutil
import subprocess
import tempfile

HARNESSES = ("claude", "pi")


class Stop(Exception):
    """An error with its exit code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def home():
    return os.path.expanduser("~")


def short(path):
    """A path with `~` for the home directory, for a message."""
    base = home()
    return "~" + path[len(base):] if base and (path == base or path.startswith(base + os.sep)) else path


def state_path(env=None):
    """The state file of the user: `dummies-skill/state.json` in `XDG_CONFIG_HOME`, or in `~/.config`."""
    env = os.environ if env is None else env
    base = env.get("XDG_CONFIG_HOME") or ""
    # A relative value is not valid: it names a place below the current directory.
    if not os.path.isabs(base):
        base = os.path.join(home(), ".config")
    return os.path.join(base, "dummies-skill", "state.json")


def log_state(env=None):
    """`on` or `off`: the shared page log switch of `state.py log`. No file, a link or a file that is not valid
    keeps the default, on."""
    path = state_path(env)
    try:
        if os.path.islink(path):
            return "on"
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return "on"
    return "off" if isinstance(data, dict) and data.get("log") == "off" else "on"


def write_text(path, text, follow=True):
    """Write a file through a temporary file in the same directory, with each line end as the text has it.

    A link stays a link: its target is written. With `follow` false the path itself is replaced.
    """
    path = os.path.realpath(path) if follow else path
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".dummies-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as out:
            out.write(text)
        if os.path.exists(path):
            shutil.copymode(path, temporary)
        else:
            mask = os.umask(0)
            os.umask(mask)
            os.chmod(temporary, 0o666 & ~mask)
        os.replace(temporary, path)
    except OSError:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def herdr_agent(env=None):
    """The Herdr record of the agent in this pane, or None outside Herdr."""
    env = os.environ if env is None else env
    pane = env.get("HERDR_PANE_ID")
    if env.get("HERDR_ENV") != "1" or not pane or not shutil.which("herdr"):
        return None
    try:
        done = subprocess.run(["herdr", "agent", "get", pane], capture_output=True, text=True, timeout=10)
        agent = json.loads(done.stdout)["result"]["agent"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None
    return agent if isinstance(agent, dict) else None


def detect_harness(named=None, env=None, agent=None):
    """`claude` or `pi`: the argument, then the marker of the harness, then the Herdr record. Else None."""
    env = os.environ if env is None else env
    if named:
        return named
    marker = (env.get("AI_AGENT") or "").lower()
    if marker == "pi":
        return "pi"
    if marker.startswith("claude"):
        return "claude"
    in_pi, in_claude = env.get("PI_CODING_AGENT") == "true", env.get("CLAUDECODE") == "1"
    if in_pi != in_claude:
        return "pi" if in_pi else "claude"
    if (agent or {}).get("agent") in HARNESSES:
        return agent["agent"]
    return None
