#!/usr/bin/env python3
"""Convert a pi-mcp-adapter server file to a native Pi mcp.json with codemode exposure. Print names, never values.

Three forms:
  --from <adapter file> --to <new file>      write one new file; change nothing else
  --profile <profile> [--require <name>]...  back up the profile, write <profile>/mcp.json, switch the settings to
                                             native MCP and codemode (--dry-run: print the plan, write nothing)
  --restore <profile>/backups/mcp-native-<UTC time>
                                             put back each saved file and move each new file into the backup folder

Each enabled server gets `exposure: codemode`: scripts of the codemode tool can call its tools, and the prompt lists
none. Each tool of excludeTools gets `hidden` in toolExposure. A server that needs a field with no native equal (a
sign-in field, a tool limit such as approveTools or includeTools, requestHeadersCommand, socket, caFile) or a
transport that Pi does not support gets `enabled: false` and a reason. A required server that is not safe stops the
switch before a change: exit 2.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
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
# Fields with no native equal that the server needs to run as the adapter ran it: the server is not safe in codemode.
NOT_SAFE = {
    "auth": "the sign-in field auth has no native equal",
    "bearerToken": "the sign-in field bearerToken has no native equal",
    "bearerTokenEnv": "the sign-in field bearerTokenEnv has no native equal",
    "bearerTokenStore": "the sign-in field bearerTokenStore has no native equal",
    "clientMetadataUrl": "the sign-in field clientMetadataUrl has no native equal",
    "authorizationParams": "the sign-in field authorizationParams has no native equal",
    "clientUri": "the sign-in field clientUri has no native equal",
    "requestHeadersCommand": "requestHeadersCommand has no native equal",
    "socket": "socket has no native equal",
    "caFile": "caFile has no native equal",
    "approveTools": "the tool approval approveTools has no native equal",
    "includeTools": "the tool limit includeTools has no native equal",
}
# A value of a NOT_SAFE field that sets no limit and no sign-in: the field is only dropped.
NO_LIMIT = {"auth": (False,), "approveTools": (False, None, []), "includeTools": (None,)}
# A tool name or a * pattern that Pi takes as a toolExposure key. Another form (for example ? of the adapter) is not safe.
HIDDEN_KEY = re.compile(r"[A-Za-z0-9_.*-]+")
OAUTH_NOT_SAFE = ("grantType", "clientMetadataUrl", "authorizationParams", "clientUri")
OAUTH_KEPT = ("clientId", "clientSecret", "scope", "clientName", "callbackPort", "callbackUrl", "clientRegistration",
              "authServerMetadataUrl")
# Dropped behavior fields with a note on what Pi does instead. Other dropped fields get a plain line.
NOTES = {
    "lifecycle": "Pi connects to each enabled server at session start",
    "idleTimeout": "Pi keeps the connection for the session",
    "toolPrefix": "Pi names each tool mcp__<server>__<tool>",
    "directTools": "each server has codemode exposure, so no tool is direct or deferred",
    "exposure": "each server has codemode exposure",
    "toolExposure": "each server has codemode exposure, with no tool override",
}
LOOPBACK = ("localhost", "127.0.0.1", "[::1]", "::1")
# The files that a switch can change, saved before the first change and put back by --restore.
SAVED = ("mcp-adapter.json", "settings.json", "mcp.json", "mcp-onboarding.json", "kit-aws.json")
BACKUPS = "backups"
PREFIX = "mcp-native-"
RECORD = "backup.json"
RESTORED = "restored.json"
TOOL = "scripts/mcp_to_native.py"


class Refusal(Exception):
    """One line for standard error; exit 2. No file changed."""


def form_notes(value):
    """The notes for one env or header value. A !command means the same in both."""
    if not isinstance(value, str) or (value.startswith("!") and not value.startswith("!!")):
        return []
    return [note for _, note, found in FORMS if found(value)]


def oauth_part(name, oauth, native, lines):
    """Copy the oauth fields that Pi reads. Return the reason when a field has no native equal, else None."""
    if not isinstance(oauth, dict):
        lines.append(f"server {name}: dropped oauth: not an object")
        return None
    kept = {key: oauth[key] for key in OAUTH_KEPT if key in oauth}
    reason = None
    redirect = oauth.get("redirectUri")
    if redirect is not None:
        parts = urlsplit(redirect) if isinstance(redirect, str) else None
        if parts is not None and parts.scheme == "http" and (parts.hostname or "") in LOOPBACK:
            kept.setdefault("callbackUrl", redirect)
        else:
            reason = "oauth.redirectUri is not an http loopback address, and Pi takes only that"
    for key in oauth:
        if key in OAUTH_NOT_SAFE:
            reason = reason or f"the sign-in field oauth.{key} has no native equal"
        elif key not in OAUTH_KEPT and key != "redirectUri":
            lines.append(f"server {name}: dropped oauth.{key}")
    if kept:
        native["oauth"] = kept
    return reason


def hidden_tools(name, values):
    """(toolExposure with `hidden` for each tool of excludeTools, reason or None). An adapter value can be the original
    name or the name with the tool prefix of the server; Pi matches the original name, so both get `hidden`."""
    if not isinstance(values, list) or not all(isinstance(value, str) and HIDDEN_KEY.fullmatch(value) for value in values):
        return {}, "excludeTools has an entry that Pi cannot hide; Pi takes a tool name or a * pattern"
    short = re.sub(r"-?mcp$", "", name, flags=re.IGNORECASE) or "mcp"
    prefixes = dict.fromkeys([name + "_", short + "_", "mcp__" + name + "__"])
    hidden = {}
    for value in values:
        hidden[value] = "hidden"
        for prefix in prefixes:
            if value.startswith(prefix) and len(value) > len(prefix):
                hidden[value[len(prefix):]] = "hidden"
    return hidden, None


def convert_server(name, entry):
    """Return (native entry or None, report lines, reason when not safe). A report line holds no value."""
    if not isinstance(entry, dict):
        return None, [f"server {name}: skipped: not an object"], "not an object"
    if not isinstance(entry.get("command"), str) and not isinstance(entry.get("url"), str):
        return None, [f"server {name}: skipped: no command or url"], "no command or url"
    native = {key: entry[key] for key in COPIED if key in entry}
    lines = []
    reasons = []
    if entry.get("type") in NATIVE_TYPES:
        native["type"] = entry["type"]
    elif "type" in entry:
        reasons.append("Pi does not support this transport type")
    timeout = entry.get("requestTimeoutMs")
    if isinstance(timeout, float) and not math.isfinite(timeout):
        lines.append(f"server {name}: dropped requestTimeoutMs: not a finite number")
    elif isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout > 0:
        native["timeout"] = timeout // 1000 if timeout % 1000 == 0 else timeout / 1000
    used = {*COPIED, "requestTimeoutMs", "disabled", "enabled", "oauth", "type", "excludeTools", "inheritEnv"}
    for key in entry:
        if key in NOT_SAFE and not any(entry[key] == value and type(entry[key]) is type(value)
                                       for value in NO_LIMIT.get(key, ())):
            reasons.append(NOT_SAFE[key])
        elif key not in used:
            lines.append(f"server {name}: dropped {key}" + (": " + NOTES[key] if key in NOTES else ""))
    if "excludeTools" in entry:
        hidden, reason = hidden_tools(name, entry["excludeTools"])
        if reason:
            reasons.append(reason)
        elif hidden:
            native["toolExposure"] = hidden
            lines.append(f"server {name}: excludeTools: each excluded tool has hidden exposure")
    if entry.get("inheritEnv") is False:
        lines.append(f"server {name}: warning: dropped inheritEnv false; Pi has no field that keeps the environment of"
                     " Pi from a stdio server")
    elif "inheritEnv" in entry:
        lines.append(f"server {name}: dropped inheritEnv")
    if "oauth" in entry:
        reason = oauth_part(name, entry["oauth"], native, lines)
        if reason:
            reasons.append(reason)
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
    # Every server gets codemode exposure, so no tool reaches the prompt; a server that is not safe stays off.
    native["exposure"] = "codemode"
    reason = "; ".join(dict.fromkeys(reasons)) or None
    if reason:
        native["enabled"] = False
        lines.append(f"server {name}: not safe in codemode: {reason}; enabled: false")
    elif entry.get("disabled") is True or entry.get("enabled") is False:
        native["enabled"] = False
        lines.append(f"server {name}: disabled in the adapter file; enabled: false")
    return native, lines, reason


def convert(data):
    """Return (the native document, report lines, {name: reason} of each server that is not safe or skipped)."""
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    if not isinstance(servers, dict):
        raise ValueError("the source has no mcpServers object")
    native = {}
    lost = {}
    lines = [f"dropped top-level {key}" for key in data if key not in ("mcpServers", "settings")]
    settings = data.get("settings", {})
    if isinstance(settings, dict):
        lines += [f"dropped settings.{key}" for key in settings]
    else:
        lines.append("dropped top-level settings")
    for name, entry in servers.items():
        converted, notes, reason = convert_server(name, entry)
        lines += notes
        if reason:
            lost[name] = reason
        if converted is not None:
            native[name] = converted
    return {"mcpServers": native}, lines, lost


def read_source(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        raise Refusal(f"{Path(path).name} is not UTF-8 text") from None
    except json.JSONDecodeError as error:
        # The message of the error holds no text of the file. A file with comments stops here.
        raise Refusal(f"{Path(path).name} is not plain JSON: line {error.lineno}") from None
    except OSError as error:
        raise Refusal(f"cannot read {path}: {error.strerror}") from None


def render(document):
    # allow_nan=False: Pi rejects a whole file that holds Infinity or NaN.
    try:
        return json.dumps(document, indent=2, allow_nan=False) + "\n"
    except ValueError as error:
        raise Refusal(str(error)) from None


def write_new(path, data, mode=0o600):
    """Write a new file. O_EXCL also refuses a symlink, a dangling one too, and a file that appeared after a check."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
    os.chmod(path, mode)


def replace(path, data, mode):
    """Write a file atomically through a new temporary file beside it."""
    temporary = path.with_name("." + path.name + ".mcp-native-" + str(os.getpid()))
    write_new(temporary, data, mode)
    os.replace(temporary, path)


def adapter_spec():
    manifest = json.loads((ROOT / "config/manifest.json").read_text())
    return "npm:" + manifest["components"]["mcp"]["source"]["spec"].rsplit("@", 1)[0]


def is_adapter(entry, spec):
    source = entry.get("source") if isinstance(entry, dict) else entry
    return isinstance(source, str) and source.rsplit("@", 1)[0] == spec


def switch_settings(settings):
    """The settings of native MCP with codemode, as install.sh writes them: no adapter package, no -builtin:mcp and
    no -builtin:codemode, and codemode in defaultTools. Other keys keep their values and their order."""
    if not isinstance(settings, dict):
        raise Refusal("settings.json is not a JSON object")
    settings = json.loads(json.dumps(settings))
    packages = settings.get("packages", [])
    extensions = settings.get("extensions", [])
    tools = settings.get("defaultTools")
    if not isinstance(packages, list) or not isinstance(extensions, list):
        raise Refusal("settings packages and extensions must be lists")
    if tools is not None and not isinstance(tools, list):
        raise Refusal("settings defaultTools must be a list")
    spec = adapter_spec()
    if any(is_adapter(entry, spec) for entry in packages):
        settings["packages"] = [entry for entry in packages if not is_adapter(entry, spec)]
    if {"-builtin:mcp", "-builtin:codemode"} & {entry for entry in extensions if isinstance(entry, str)}:
        settings["extensions"] = [entry for entry in extensions if entry not in ("-builtin:mcp", "-builtin:codemode")]
    if tools is None:
        settings["defaultTools"] = ["+codemode"]
    elif not {"+codemode", "codemode"} & {tool for tool in tools if isinstance(tool, str)}:
        # A list of plain names replaces the defaults, and it takes no + entry.
        additive = tools and all(isinstance(tool, str) and tool[:1] in ("+", "-") for tool in tools)
        settings["defaultTools"] = tools + ["+codemode" if additive else "codemode"]
    return settings


def kit_servers(servers, aws):
    """The names of the entries that the kit wrote: the okknow entry, and the aws-mcp entry of kit-aws.json."""
    names = []
    okknow = servers.get("okknow")
    headers = okknow.get("headers") if isinstance(okknow, dict) else None
    if isinstance(headers, dict) and str(headers.get("Authorization", "")).endswith(" auth-header"):
        names.append("okknow")
    if aws:
        names.append("aws-mcp")
    return names


def aws_record(profile):
    """{file name: entry} of the aws-mcp entries that the kit wrote (kit-aws.json)."""
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT))
    from scripts import kit_aws
    try:
        return kit_aws.recorded_mcp(profile)
    except kit_aws.Refusal as error:
        raise Refusal(str(error)) from None


def last_switch(profile):
    """The record of the newest backup folder of this tool that no --restore undid, or None."""
    folder = Path(profile) / BACKUPS
    if not folder.is_dir() or folder.is_symlink():
        return None
    found = None
    for item in sorted(folder.glob(PREFIX + "*")):
        if item.is_symlink() or not item.is_dir() or (item / RESTORED).exists():
            continue
        try:
            record = json.loads((item / RECORD).read_text())
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("tool") == TOOL:
            if found is None or (str(record.get("created")), item.name) >= (str(found.get("created")), found["folder"]):
                found = {**record, "folder": item.name}
    return found


def written_here(profile):
    """True when mcp.json still holds the bytes that the last switch of this tool wrote (its SHA-256 in backup.json)."""
    native = Path(profile) / "mcp.json"
    record = last_switch(profile)
    written = record.get("written") if record else None
    return native.is_file() and isinstance(written, str) and sha256(native.read_bytes()) == written


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def plan_switch(profile, required):
    """Read and check everything of a switch. Return (mcp.json bytes, settings bytes or None, report lines, kit-aws
    record or None). Raise Refusal before a change."""
    profile = Path(profile)
    if profile.is_symlink() or not profile.is_dir():
        raise Refusal(f"{profile} is not a profile folder")
    for name in SAVED:
        if (profile / name).is_symlink():
            raise Refusal(f"refusing a symlink {name}")
    backups = profile / BACKUPS
    if backups.is_symlink() or backups.exists() and not backups.is_dir():
        raise Refusal(f"{backups} is not a folder")
    adapter = profile / "mcp-adapter.json"
    if not adapter.is_file():
        raise Refusal("the profile has no mcp-adapter.json")
    native = profile / "mcp.json"
    again = native.exists() and written_here(profile)
    if native.exists() and not again:
        raise Refusal("mcp.json exists and does not hold the bytes that the last switch of this tool wrote; move it"
                      " aside or keep the adapter profile")
    data = read_source(adapter)
    try:
        document, lines, lost = convert(data)
    except ValueError as error:
        raise Refusal(str(error)) from None
    servers = data["mcpServers"]
    recorded = aws_record(profile)
    aws = recorded.get("mcp-adapter.json") == servers.get("aws-mcp") and "aws-mcp" in servers
    if again and "aws-mcp" not in servers:
        # After the first switch the kit step took its aws-mcp entry out of mcp-adapter.json; mcp.json keeps it.
        current = read_source(native).get("mcpServers", {}).get("aws-mcp")
        if current is not None and recorded.get("mcp.json") == current:
            document["mcpServers"]["aws-mcp"] = current
            servers = {**servers, "aws-mcp": current}
            aws = True
    kit = kit_servers(servers, aws)
    for name in dict.fromkeys([*kit, *required]):
        if name not in servers:
            raise Refusal(f"required server {name} is not in mcp-adapter.json")
        if name in lost:
            raise Refusal(f"required server {name} would be lost: {lost[name]}; repair the entry or keep the adapter"
                          " profile")
    settings_path = profile / "settings.json"
    old = read_source(settings_path) if settings_path.exists() else {}
    new = switch_settings(old)
    settings = None if new == old and settings_path.exists() else render(new).encode()
    record = None
    if "aws-mcp" in kit:
        # The kit keeps its aws-mcp entry: the record names the converted entry in mcp.json.
        sys.path.insert(0, str(ROOT))
        from scripts import kit_aws
        record = kit_aws.read_record(profile / kit_aws.PROFILE_RECORD)
        owned = dict(record.get("mcp")) if isinstance(record.get("mcp"), dict) else {}
        owned["mcp.json"] = document["mcpServers"]["aws-mcp"]
        record["mcp"] = owned
    return render(document).encode(), settings, lines, record


def free_folder(profile, stamp):
    """The first backup folder name of this second that does not exist: <stamp>, then <stamp>-02, <stamp>-03 ..."""
    for number in range(1, 100):
        folder = profile / BACKUPS / (PREFIX + stamp + ("" if number == 1 else f"-{number:02d}"))
        if not os.path.lexists(folder):
            return folder
    raise Refusal(f"99 backup folders of {stamp} exist")


def switch(profile, required, dry_run=False):
    """Back up the profile, then write mcp.json, the kit-aws record and settings.json. Return the backup folder."""
    profile = Path(profile)
    native, settings, lines, record = plan_switch(profile, required)
    for line in lines:
        print(line)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    folder = free_folder(profile, stamp)
    if dry_run:
        print(f"plan: back up {', '.join(SAVED)} to {folder}, then write mcp.json"
              + (" and settings.json" if settings else ""))
        return folder
    # The backup comes first. A failure in it leaves the profile as it was; a partial folder stays for reading.
    if not (profile / BACKUPS).exists():
        (profile / BACKUPS).mkdir(mode=0o700)
        os.chmod(profile / BACKUPS, 0o700)
    # mkdir refuses a folder that a second run made after the name check.
    folder.mkdir(mode=0o700)
    os.chmod(folder, 0o700)
    files = {}
    for name in SAVED:
        path = profile / name
        if path.is_file():
            data = path.read_bytes()
            write_new(folder / name, data)
            files[name] = {"sha256": sha256(data), "mode": oct(path.stat().st_mode & 0o777)}
        else:
            files[name] = "absent"
    # written: the SHA-256 of the new mcp.json. A later switch takes an mcp.json only while it holds these bytes.
    write_new(folder / RECORD, (json.dumps({"tool": TOOL, "created": stamp, "files": files, "written": sha256(native)},
                                           indent=2) + "\n").encode())
    print(f"backup: {folder}")
    replace(profile / "mcp.json", native, 0o600)
    print(f"wrote {len(json.loads(native)['mcpServers'])} servers to {profile / 'mcp.json'}")
    if record is not None:
        path = profile / "kit-aws.json"
        replace(path, (json.dumps(record, indent=2) + "\n").encode(), 0o600)
    if settings is not None:
        path = profile / "settings.json"
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
        replace(path, settings, mode)
        print(f"settings: native MCP with codemode in {path}")
    print(f"restore: python3 {ROOT / 'scripts/mcp_to_native.py'} --restore {folder}")
    return folder


def restore(folder):
    """Put back each saved file with its bytes and mode; move each file that was absent into the backup folder."""
    folder = Path(folder)
    if folder.is_symlink() or not folder.is_dir() or folder.parent.name != BACKUPS or not folder.name.startswith(PREFIX):
        raise Refusal(f"{folder} is not a backup folder of this tool")
    profile = folder.parent.parent
    if (folder / RESTORED).exists():
        raise Refusal(f"{folder} was restored before")
    try:
        record = json.loads((folder / RECORD).read_text())
        files = record["files"]
        if record.get("tool") != TOOL or set(files) != set(SAVED):
            raise ValueError
    except (OSError, ValueError, KeyError, TypeError):
        raise Refusal(f"{folder / RECORD} is not a record of this tool") from None
    steps = []
    for name in SAVED:
        path = profile / name
        if path.is_symlink():
            raise Refusal(f"refusing a symlink {name}")
        if files[name] == "absent":
            aside = folder / ("after-" + name)
            if path.exists():
                if aside.exists() or aside.is_symlink():
                    raise Refusal(f"{aside} exists")
                steps.append((path, None, aside))
            continue
        saved = folder / name
        data = saved.read_bytes() if saved.is_file() and not saved.is_symlink() else None
        if data is None or sha256(data) != files[name].get("sha256"):
            raise Refusal(f"the saved {name} does not match {RECORD}")
        # A current copy that differs from the saved one (a later edit, or a write of the switch) is kept first.
        aside = folder / ("after-" + name)
        current = path.read_bytes() if path.is_file() else None
        keep = current is not None and current != data
        if keep and os.path.lexists(aside):
            raise Refusal(f"{aside} exists")
        steps.append((path, data, int(files[name]["mode"], 8), aside if keep else None))
    for path, data, *extra in steps:
        if data is None:
            # Moved, never deleted: the adapter does not import a file in the backup folder.
            os.replace(path, extra[0])
            os.chmod(extra[0], 0o600)
            print(f"moved aside: {path.name} to {extra[0]}")
        else:
            mode, aside = extra
            if aside is not None:
                write_new(aside, path.read_bytes())
                print(f"kept the current copy: {path.name} to {aside}")
            replace(path, data, mode)
            print(f"restored: {path}")
    write_new(folder / RESTORED, (json.dumps({"restored": time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}) + "\n").encode())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="source", type=Path)
    parser.add_argument("--to", dest="target", type=Path)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--require", action="append", default=[], metavar="NAME",
                        help="one more server that the switch must keep (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="with --profile: print the plan and write nothing")
    parser.add_argument("--restore", type=Path, metavar="FOLDER")
    options = parser.parse_args(argv)
    forms = [options.source is not None or options.target is not None, options.profile is not None,
             options.restore is not None]
    if forms.count(True) != 1 or forms[0] and (options.source is None or options.target is None):
        parser.error("use --from and --to, or --profile, or --restore")
    try:
        if options.profile is not None:
            switch(options.profile, options.require, options.dry_run)
        elif options.restore is not None:
            restore(options.restore)
        else:
            if os.path.lexists(options.target):
                raise Refusal(f"refusing an existing target: {options.target}")
            try:
                document, lines, _ = convert(read_source(options.source))
            except ValueError as error:
                raise Refusal(str(error)) from None
            try:
                write_new(options.target, render(document).encode())
            except OSError as error:
                raise Refusal(f"cannot write the target: {error.strerror}") from None
            for line in lines:
                print(line)
            print(f"wrote {len(document['mcpServers'])} servers to {options.target}")
    except Refusal as error:
        print(f"mcp_to_native: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"mcp_to_native: {error.strerror}: {error.filename}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
