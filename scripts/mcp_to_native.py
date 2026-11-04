#!/usr/bin/env python3
"""Convert a pi-mcp-adapter server file to a native Pi mcp.json. Print names, never values."""
import argparse
import json
import math
import os
from pathlib import Path
import re
import sys

COPIED = ("command", "args", "env", "url", "headers", "cwd", "description")
NATIVE_TYPES = ("stdio", "http", "streamable-http")
# The fields where the adapter expands variables and Pi does not.
ADAPTER_ONLY = re.compile(r"\$\{\w+(?::-[^}]*)?\}|\$env:\w+|\{env:\w+\}")
# A value form of env and headers that Pi reads in another way than the adapter.
FORMS = (
    ("!!", "a leading !! runs a shell command in Pi", lambda text: text.startswith("!!")),
    ("default", "${NAME:-text} stays plain text in Pi", lambda text: re.search(r"\$\{\w+:-", text)),
    ("env", "$env:NAME and {env:NAME} do not expand the same way in Pi; write ${NAME}",
     lambda text: re.search(r"\$env:\w+|\{env:\w+\}", text)),
    ("dollar", "Pi expands $NAME and reads $$ and $! as escapes",
     lambda text: re.search(r"\$(?:[A-Za-z_$!])", text.replace("$env:", ""))),
)


def form_notes(value):
    """The notes for one env or header value. A !command means the same in both."""
    if not isinstance(value, str) or (value.startswith("!") and not value.startswith("!!")):
        return []
    return [note for _, note, found in FORMS if found(value)]


def convert_server(name, entry):
    """Return (native entry or None, report lines). A report line holds no value."""
    if not isinstance(entry, dict):
        return None, [f"server {name}: skipped: not an object"]
    if not isinstance(entry.get("command"), str) and not isinstance(entry.get("url"), str):
        return None, [f"server {name}: skipped: no command or url"]
    native = {key: entry[key] for key in COPIED if key in entry}
    lines = []
    if entry.get("type") in NATIVE_TYPES:
        native["type"] = entry["type"]
    timeout = entry.get("requestTimeoutMs")
    if isinstance(timeout, float) and not math.isfinite(timeout):
        lines.append(f"server {name}: dropped requestTimeoutMs: not a finite number")
    elif isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout > 0:
        native["timeout"] = timeout // 1000 if timeout % 1000 == 0 else timeout / 1000
    direct = entry.get("directTools")
    if direct is True:
        native["exposure"] = "direct"
    elif direct == "search":
        native["exposure"] = "deferred"
    elif isinstance(direct, list) and all(isinstance(tool, str) for tool in direct):
        native["toolExposure"] = {tool: "direct" for tool in direct}
    used = {*COPIED, "requestTimeoutMs"}
    used |= {"type"} if "type" in native else set()
    used |= {"directTools"} if "exposure" in native or "toolExposure" in native else set()
    lines += [f"server {name}: dropped {key}" for key in entry if key not in used]
    for field in ("env", "headers"):
        values = entry.get(field)
        for key, value in (values.items() if isinstance(values, dict) else ()):
            lines += [f"server {name}: {field} {key}: {note}" for note in form_notes(value)]
    for field in ("command", "url", "cwd"):
        if isinstance(entry.get(field), str) and ADAPTER_ONLY.search(entry[field]):
            lines.append(f"server {name}: {field}: Pi does not expand a variable here")
    args = entry.get("args")
    if isinstance(args, list) and any(isinstance(arg, str) and ADAPTER_ONLY.search(arg) for arg in args):
        lines.append(f"server {name}: args: Pi does not expand a variable here")
    return native, lines


def convert(data):
    """Return (the native document, report lines)."""
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    if not isinstance(servers, dict):
        raise ValueError("the source has no mcpServers object")
    native = {}
    lines = [f"dropped top-level {key}" for key in data if key not in ("mcpServers", "settings")]
    settings = data.get("settings", {})
    if isinstance(settings, dict):
        lines += [f"dropped settings.{key}" for key in settings]
    else:
        lines.append("dropped top-level settings")
    for name, entry in servers.items():
        converted, notes = convert_server(name, entry)
        lines += notes
        if converted is not None:
            native[name] = converted
    return {"mcpServers": native}, lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="source", required=True, type=Path)
    parser.add_argument("--to", dest="target", required=True, type=Path)
    options = parser.parse_args(argv)
    if os.path.lexists(options.target):
        print(f"mcp_to_native: refusing an existing target: {options.target}", file=sys.stderr)
        return 2
    try:
        data = json.loads(options.source.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        print("mcp_to_native: the source is not UTF-8 text", file=sys.stderr)
        return 2
    except json.JSONDecodeError as error:
        # The message of the error holds no text of the file. A file with comments stops here.
        print(f"mcp_to_native: the source is not plain JSON: line {error.lineno}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"mcp_to_native: cannot read the source: {error.strerror}", file=sys.stderr)
        return 2
    try:
        document, lines = convert(data)
        # allow_nan=False: Pi rejects a whole file that holds Infinity or NaN.
        text = json.dumps(document, indent=2, allow_nan=False) + "\n"
    except ValueError as error:
        print(f"mcp_to_native: {error}", file=sys.stderr)
        return 2
    try:
        # O_EXCL also refuses a symlink, a dangling one too, and a target that appeared after the check.
        descriptor = os.open(options.target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        print(f"mcp_to_native: cannot write the target: {error.strerror}", file=sys.stderr)
        return 2
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)
    for line in lines:
        print(line)
    print(f"wrote {len(document['mcpServers'])} servers to {options.target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
