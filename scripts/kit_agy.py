#!/usr/bin/env python3
"""The kit component agy: rules, skills, hooks and the OpenViking parts of Antigravity CLI (agy) in ~/.gemini.

Usage:
  kit_agy.py plan   [--skill DIR]... [--artifacts] [--gemini DIR]
  kit_agy.py apply  [--skill DIR]... [--artifacts] [--gemini DIR]
  kit_agy.py remove [--gemini DIR]

--gemini is the agy user folder (default ~/.gemini). --skill names one skill folder of this kit (a folder with
SKILL.md); install.sh passes the kit skills of the chosen modules. --artifacts says that the module artifacts is
chosen. The kit is the repository that holds this script.

Actions:
  plan    print one line for each action of apply, with the same words; change nothing
  apply   1. stop with one line and exit 0 when <gemini>/config is not a folder (agy never ran); create nothing
          2. link the rules style.md and tenant-kit.md of packages/agy/rules into <gemini>/config/rules/, and
             tenant-kit-artifacts.md only with --artifacts (else remove that link while it points into the kit)
          3. link each --skill folder as <gemini>/config/skills/<name>; remove each link there that points into
             the kit and is not in the list
          4. set the hooks.json key tenant-kit: the kit command rules for run_command
          5. with the OpenViking Claude Code plugin only: the hooks.json key openviking, mcpServers.openviking in
             mcp_config.json and three read-only allow rules in antigravity-cli/settings.json. Without the plugin,
             remove the kit's own older ones and say so
          6. the sandbox rules in permissions.allow of antigravity-cli/settings.json, by the chosen skills (see
             Sandbox rules); remove each rule of the record that is not wanted now (see Allow rules). In the same
             edit, set the key statusLine to the ops-footer status line of the kit (see Status line)
          7. run `herdr integration install antigravity-cli` when herdr is on PATH and --gemini is ~/.gemini
          8. warn when a shell start file holds the PATH line of the agy installer; change no shell file
  remove  delete the fixed names of the component while they are the kit's: the links in rules/ and skills/ that
          point into the kit, the hooks.json keys tenant-kit and openviking when each command points into the kit,
          mcpServers.openviking of the kit shape, each allow rule of the record (see Allow rules) and the key
          statusLine while it equals the value of its record (see Status line); the allow-rules record then holds an
          empty list and the statusLine record null. Each other file, key and rule stays.

Sandbox rules: the agy terminal sandbox hides ~/.config, the host processes and the network. The kit writes these
rules into permissions.allow, one group per line of the plan:
  --skill herdr    read_file(<config home>/herdr-skill), write_file(<state home>/herdr-skill), write_file(<herdr-core
                   runtime folder>), and command(python3 <dir>/<script>) for each script of HERDR_SCRIPTS, with <dir>
                   the real folder of the skill in the kit and the link <gemini>/config/skills/herdr/scripts
  --skill dummies  read_file(<config home>/dummies-skill), and command(python3 <dir>/page.py) in the two kinds of path
  --skill okknow   command(okknow read), command(okknow ls), command(okknow search)
<config home> is XDG_CONFIG_HOME when it is absolute, else ~/.config; <state home> is XDG_STATE_HOME when it is
absolute, else ~/.local/state. The herdr-core runtime folder is <XDG_RUNTIME_DIR>/herdr-core when XDG_RUNTIME_DIR is
absolute; else the kit writes no such rule and says so.
The rules of a link path come only when that place is the kit's after the skills step: a link of the kit to the
skill folder of the kit (plan counts a free place and a kit link that apply sets). A skipped place gets no rule of a
link path and one line; the rules of the kit path stay.
A path is safe only when its text is absolute and holds only the characters A-Z a-z 0-9 . _ / + @ -; a rule with
another path is not written: one line `skipped: ...` for that path. With a home folder that is not absolute, the kit
writes no sandbox rule and says so. An entry of permissions.allow that is not a string stays in its place.

Allow rules: the record <gemini>/config/tenant-kit-allow-rules.json, {"version": 1, "rules": [...]}, holds each rule
(the three OpenViking rules and the sandbox rules) that the kit itself put into permissions.allow and that is still
there. For each wanted rule, apply keeps a rule that is in the list and in the record; leaves a rule that is in the
list and not in the record (the user's; the kit never adopts a rule); and adds and records a rule that is not in the
list. apply deletes each rule of the record that is not wanted now; remove deletes each rule of the record. A rule
that is not in the record is never deleted, also when its text equals a rule of the kit; one line names how many such
entries the kit leaves. A rule of the record that is no longer in the list leaves the record. With no record file
(an older kit, or rules written by hand) the kit owns no rule. settings.json is written first and the record after
it, so a stopped run can leave a rule of the kit as the user's, never a rule of the user in the record. When the
edit of settings.json is skipped, the record stays as it is. A record that is a link, invalid JSON or of another
shape gives one `skipped:` line; the kit then owns no rule and adds no rule. The record is written with a temporary
file and os.replace (a new file gets 0600) and gets no backup.

Status line: the statusLine value of the kit is {"type": "command", "command": "node --no-warnings <script>",
"enabled": true, "padding": 0, "stack_with_default": false}, with <script> packages/agy/scripts/statusline-ops-footer.mjs
of the kit. The record <gemini>/config/tenant-kit-statusline.json, {"version": 1, "statusLine": <object or null>},
holds the exact value that the kit wrote. A statusLine is the kit's only when it equals that value as JSON, types included
(false is not 0); a statusLine of the same command with a change of the user (for example "enabled": false or another
key) is the
user's. apply sets the key when it is absent or the kit's (so a move of the clone updates the path) and records the
new value; a statusLine of the user stays, with one line `skipped: ...`, and permissions.allow still gets its rules.
remove deletes the key only when it is the kit's, and sets the statusLine of the record to null. The record is
written after settings.json, the same way as the allow-rules record and with the same refusals: a record that is a
link, invalid JSON or of another shape gives one `skipped:` line, and the kit then sets and deletes no statusLine.
The edits of permissions.allow and statusLine are one write of settings.json, so a run makes at most one backup of
it.

Links: a free place gets a link; a broken link or a link into the kit is replaced; each other file, folder or link
stays byte-equal, with one line `skipped: ...`. A link is the kit's when its own target path (the first hop, not
the end of a chain of links) lies in the kit folder. The kit writes through no link below <gemini>.
JSON files: an absent or empty file counts as {}; a link, invalid JSON, or a container of the kit of the wrong type
is skipped with one line (mcpServers when the kit adds its entry; permissions and permissions.allow on each edit of
settings.json, also with no wanted rule, so that file then gets no statusLine change either); each other key and the
key order stay;
apply replaces a hooks.json key tenant-kit or openviking whose command is not in the kit and says so with one line
`replaced: ...`; the write goes through a temporary file and os.replace, keeps the file mode (a new file gets
0600) and writes the whole file again with an indent of two spaces; one backup <name>.bak-<UTC time> (with -2, -3,
... when that name exists; a backup never writes over a file) is made just before a write, and only when the
content changes.
The only existing file under <gemini>/antigravity-cli/ that the script reads or edits is settings.json, only for
permissions.allow and statusLine (it writes a backup and a temporary file beside it); it never writes the key model. The kit
never touches <gemini>/GEMINI.md and never reads the agy login.

Each `skipped:` line and each warning goes to standard output. Exit 0 when done or skipped, 2 for a usage error.
"""
import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import datetime  # noqa: E402
import functools  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import re  # noqa: E402
import shlex  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402

KIT = Path(__file__).resolve().parents[1]
PACKAGE = KIT / "packages" / "agy"
RULES = ("style.md", "tenant-kit.md")
ARTIFACTS_RULE = "tenant-kit-artifacts.md"
ALLOW = ("mcp(openviking/find)", "mcp(openviking/search)", "mcp(openviking/read)")
HERDR_SKILL = KIT / "packages" / "tenantext" / "skills" / "herdr"
DUMMIES_SKILL = KIT / "packages" / "tenantext" / "skills" / "coordinator-skills" / "dummies"
# The command-line scripts of the herdr skill that an agent pane runs. A rule command(<prefix>) of agy matches the
# words of the command literally, so each script needs its own rule; a folder rule would not match.
HERDR_SCRIPTS = ("init.py", "panes.py", "spawn.py", "ask.py", "last-reply.py", "close.py", "handoff.py",
                 "resources.py")
# The command-line scripts of the herdr skill that no agent pane runs: role_set.py is the Start helper of the Herdr
# app (herdr-role-set) and runs with no pane terminal. They get no rule.
HERDR_NOT_PANE = ("role_set.py",)
OKKNOW_RULES = ("command(okknow read)", "command(okknow ls)", "command(okknow search)")
SANDBOX_SKILLS = ("herdr", "dummies", "okknow")
PLUGIN_CACHE = Path(".claude", "plugins", "cache", "openviking", "openviking-memory")
PROXY = Path("servers", "mcp-proxy.mjs")
# The OpenViking hooks: (event, file, timeout in seconds).
OV_HOOKS = (("SessionStart", "openviking-session-start.mjs", 20),
            ("PreInvocation", "openviking-prompt-recall.mjs", 20),
            ("Stop", "openviking-capture.mjs", 30))
STATUSLINE_SCRIPT = PACKAGE / "scripts" / "statusline-ops-footer.mjs"
INSTALLER_MARK = "# Added by Antigravity CLI installer"
SHELL_FILES = (".bashrc", ".bash_profile", ".zshrc", ".zprofile")


class Usage(Exception):
    """A usage error: one line on standard error, exit 2."""


class Skip(Exception):
    """A JSON change that the kit refuses: one line `skipped: <path> <reason>`, and no write into that file."""


def in_kit(path):
    """True when the path text lies in this kit folder. No link is followed."""
    return Path(os.path.abspath(path)).is_relative_to(KIT)


def first_hop(link):
    """The target path of the link itself, as an absolute path; the end of a chain of links is not read."""
    return os.path.abspath(os.path.join(os.path.dirname(link), os.readlink(link)))


def is_kit_link(path):
    """True when path is a link whose own target lies in this kit (a broken link too)."""
    return path.is_symlink() and in_kit(first_hop(path))


def node_command(path):
    text = str(path)
    return "node " + ("'" + text + "'" if "'" not in text else shlex.quote(text))


def same_json(a, b):
    """JSON equality that also compares the types: in Python False == 0 and True == 1, in JSON they differ."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same_json(a[key], b[key]) for key in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b))
    return a == b


def is_version_1(data):
    """True for a record of version 1; the bool true is not the number 1."""
    return isinstance(data, dict) and type(data.get("version")) is int and data["version"] == 1


def statusline_value():
    """The statusLine value that apply writes: the ops-footer status line of the kit."""
    return {"type": "command", "command": node_command(STATUSLINE_SCRIPT).replace("node ", "node --no-warnings ", 1),
            "enabled": True, "padding": 0, "stack_with_default": False}


def hook_entry(path, timeout):
    return [{"type": "command", "command": node_command(path), "timeout": timeout}]


def kit_hooks_key():
    return {"PreToolUse": [{"matcher": "run_command",
                            "hooks": hook_entry(PACKAGE / "hooks" / "pre-tool-use.mjs", 10)}]}


def ov_hooks_key():
    return {event: hook_entry(PACKAGE / "hooks" / name, timeout) for event, name, timeout in OV_HOOKS}


def commands_of(value):
    """Each command string of a hooks.json key, or None when the key has another form."""
    found = []
    if not isinstance(value, dict):
        return None
    for entries in value.values():
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if not isinstance(entry, dict):
                return None
            # A matcher entry holds its handlers in "hooks"; an event entry is one handler itself.
            inner = entry["hooks"] if "hooks" in entry else [entry]
            if not isinstance(inner, list):
                return None
            for hook in inner:
                if not isinstance(hook, dict) or not isinstance(hook.get("command"), str):
                    return None
                found.append(hook["command"])
    return found


def is_kit_key(value):
    """True when each command of a hooks.json key runs a file of this kit."""
    commands = commands_of(value)
    if not commands:
        return False
    for command in commands:
        try:
            words = shlex.split(command)
        except ValueError:
            return False
        if len(words) != 2 or words[0] != "node" or not in_kit(words[1]):
            return False
    return True


def is_kit_mcp(value):
    """True when an mcpServers entry has the shape that apply writes."""
    return (isinstance(value, dict) and set(value) == {"command", "args"} and value["command"] == "node"
            and isinstance(value["args"], list) and len(value["args"]) == 1 and isinstance(value["args"][0], str)
            and value["args"][0].endswith("/" + PROXY.as_posix()))


def version_parts(name):
    """The number at the start of each part of a version name; a part without one counts as 0."""
    parts = []
    for part in re.split(r"[.-]", name):
        digits = re.match(r"[0-9]+", part)
        parts.append(int(digits.group()) if digits else 0)
    return parts


def compare_versions(a, b):
    """The version order of the plugin folders, the same as compareVersions in packages/agy/hooks/openviking-lib.mjs:
    compare the parts as numbers, pad the shorter list with zeros, and order equal versions by their name text."""
    pa, pb = version_parts(a), version_parts(b)
    width = max(len(pa), len(pb))
    pa, pb = pa + [0] * (width - len(pa)), pb + [0] * (width - len(pb))
    if pa != pb:
        return -1 if pa < pb else 1
    return (a > b) - (a < b)


def plugin_root(home):
    """The OpenViking Claude Code plugin folder with its MCP proxy, or None."""
    if os.environ.get("AGY_OV_PLUGIN_ROOT"):
        root = Path(os.environ["AGY_OV_PLUGIN_ROOT"])
    else:
        base = home / PLUGIN_CACHE
        try:
            versions = sorted((p.name for p in base.iterdir() if p.is_dir()),
                              key=functools.cmp_to_key(compare_versions))
        except OSError:
            return None
        if not versions:
            return None
        root = base / versions[-1]
    return root if (root / PROXY).is_file() else None


def base_dir(env, name, fallback):
    """The folder in the variable name when its value is absolute, else fallback. The scripts of the skills use the
    same rule (dummies_lib.config_dir); a relative value names a place below the current folder."""
    value = env.get(name) or ""
    return Path(value) if os.path.isabs(value) else fallback


SAFE_PATH = re.compile(r"[A-Za-z0-9._/+@-]+")


def unsafe(path):
    """True unless the path text is absolute and holds only the characters of SAFE_PATH: a space, a bracket, a quote,
    a glob character and a line break could end or change a rule or the command of the agent."""
    text = str(path)
    return not (os.path.isabs(text) and SAFE_PATH.fullmatch(text))


def sandbox_groups(home, gemini, env):
    """The sandbox rules of the kit: {skill: [(label, [(rule, path), ...]), ...]}, and the notes without a rule.

    Each rule comes with the path that it holds (None for a rule without a path)."""
    config_home = base_dir(env, "XDG_CONFIG_HOME", home / ".config")
    state_home = base_dir(env, "XDG_STATE_HOME", home / ".local" / "state")
    xdg_runtime = base_dir(env, "XDG_RUNTIME_DIR", None)
    runtime = xdg_runtime / "herdr-core" if xdg_runtime is not None else None
    link = gemini / "config" / "skills"

    def commands(folders, scripts):
        # The path of a rule is the derived folder: one bad folder gives one skipped line.
        return [("command(python3 " + str(folder / script) + ")", folder) for folder in folders for script in scripts]

    notes = []
    herdr = [("herdr mounts", [("read_file(" + str(config_home / "herdr-skill") + ")", config_home / "herdr-skill"),
                               ("write_file(" + str(state_home / "herdr-skill") + ")", state_home / "herdr-skill")])]
    if runtime is not None:
        herdr.append(("herdr-core runtime mount", [("write_file(" + str(runtime) + ")", runtime)]))
    else:
        notes.append("sandbox: no absolute XDG_RUNTIME_DIR; no mount rule for the herdr-core runtime folder, so hc "
                     "does not reach herdr-core inside the sandbox")
    herdr.append(("herdr scripts (command, outside the sandbox)",
                  commands((link / "herdr" / "scripts", HERDR_SKILL / "scripts"), HERDR_SCRIPTS)))
    dummies = [("dummies mount", [("read_file(" + str(config_home / "dummies-skill") + ")",
                                   config_home / "dummies-skill")]),
               ("dummies page.py (command, outside the sandbox)",
                commands((link / "dummies" / "scripts", DUMMIES_SKILL / "scripts"), ("page.py",)))]
    okknow = [("okknow read ls search (command, outside the sandbox)", [(rule, None) for rule in OKKNOW_RULES])]
    return {"herdr": herdr, "dummies": dummies, "okknow": okknow}, notes


RECORD = "tenant-kit-allow-rules.json"
STATUSLINE_RECORD = "tenant-kit-statusline.json"


def kit_rule_texts(groups):
    """Each allow rule text that the kit can write for the current paths: the three OpenViking rules and each
    sandbox rule of the three skills. The kit uses it only to count the entries of the user with such a text."""
    return set(ALLOW) | {rule for skill in groups.values() for _, rules in skill for rule, path in rules
                         if path is None or not unsafe(path)}


def link_place(gemini, name):
    """The link place of a kit skill: <gemini>/config/skills/<name>."""
    return gemini / "config" / "skills" / name


def kit_place(gemini, dest, src):
    """True when dest is the kit's link to the skill folder src after the skills step. The same decision for plan
    and apply: a link with the target src, or a place that link() sets (a free place, a kit link, a broken link);
    never a place below a link or a file on the way."""
    current = gemini
    for part in dest.parent.relative_to(gemini).parts:
        current = current / part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            return False
    if dest.is_symlink():
        # link() keeps its own link, and replaces a kit link and a broken link.
        return os.readlink(dest) == str(src) or is_kit_link(dest) or not dest.exists()
    return not dest.exists()


def utc_stamp():
    """The time part of a backup name: UTC, one second resolution."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class Run:
    def __init__(self, gemini, home, dry):
        self.gemini = gemini
        self.home = home
        self.dry = dry
        self.config = gemini / "config"
        self.record = self.config / RECORD
        self.statusline_record = self.config / STATUSLINE_RECORD
        self.stamp = utc_stamp()

    def say(self, line):
        print(line, flush=True)

    def safe_dir(self, path, create):
        """True when path is a real folder below <gemini> (no link on the way); create it when asked."""
        rel = path.relative_to(self.gemini)
        current = self.gemini
        for part in rel.parts:
            current = current / part
            if current.is_symlink():
                self.say("skipped: " + str(current) + " is a link; the kit writes nothing through it")
                return False
            if current.exists() and not current.is_dir():
                self.say("skipped: " + str(current) + " is not a folder")
                return False
        if not path.is_dir():
            if not create:
                return False
            self.say("mkdir: " + str(path))
            if not self.dry:
                path.mkdir(parents=True)
        return True

    # Links ------------------------------------------------------------------------------------------------------

    def link(self, src, dest):
        if dest.is_symlink() and os.readlink(dest) == str(src):
            return
        if dest.is_symlink() and dest.exists() and not is_kit_link(dest):
            self.say("skipped: " + str(dest) + " links to another place: " + os.readlink(dest))
            return
        if not dest.is_symlink() and dest.exists():
            self.say("skipped: " + str(dest) + " exists and is not a link")
            return
        self.say("link: " + str(dest) + " -> " + str(src))
        if self.dry:
            return
        tmp = dest.parent / (".kit-agy-" + dest.name + "." + str(os.getpid()))
        os.symlink(src, tmp)
        os.replace(tmp, dest)

    def unlink_kit(self, dest):
        if is_kit_link(dest):
            self.say("unlink: " + str(dest))
            if not self.dry:
                dest.unlink()

    def rules(self, artifacts):
        folder = self.config / "rules"
        if not self.safe_dir(folder, create=True):
            return
        for name in RULES + ((ARTIFACTS_RULE,) if artifacts else ()):
            self.link(PACKAGE / "rules" / name, folder / name)
        if not artifacts:
            self.unlink_kit(folder / ARTIFACTS_RULE)

    def skills(self, skills):
        folder = self.config / "skills"
        if not skills and not folder.is_dir():
            return
        if not self.safe_dir(folder, create=True):
            return
        names = {skill.name for skill in skills}
        for skill in skills:
            self.link(skill, folder / skill.name)
        for entry in sorted(folder.iterdir()) if folder.is_dir() else ():
            if entry.name not in names:
                self.unlink_kit(entry)

    # JSON files -------------------------------------------------------------------------------------------------

    def edit_json(self, path, change):
        """Apply change(data) to a JSON object file; write only when the content differs.

        True when the file has the change (or needs none), False when the file is skipped."""
        if path.is_symlink():
            self.say("skipped: " + str(path) + " is a link; the kit writes nothing through it")
            return False
        try:
            text = path.read_text(encoding="utf-8") if path.exists() else ""
            data = json.loads(text) if text.strip() else {}
        except (OSError, ValueError, UnicodeDecodeError):
            self.say("skipped: " + str(path) + " is not valid JSON; the kit changes nothing in it")
            return False
        if not isinstance(data, dict):
            self.say("skipped: " + str(path) + " is not a JSON object; the kit changes nothing in it")
            return False
        try:
            new = change(json.loads(json.dumps(data)), path)
        except Skip as refusal:
            self.say("skipped: " + str(path) + " " + str(refusal) + "; the kit changes nothing in it")
            return False
        if same_json(new, data):
            return True
        exists = path.exists()
        self.say("write: " + str(path))
        if exists:
            self.say("backup: " + str(self.backup(path)))
        self.write_json(path, new, exists)
        return True

    def write_json(self, path, new, exists):
        """Write the JSON value through a temporary file and os.replace; keep the mode, 0600 for a new file."""
        if self.dry:
            return
        mode = stat.S_IMODE(path.stat().st_mode) if exists else 0o600
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name + ".")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(new, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.chmod(tmp, mode)
        os.replace(tmp, path)

    def backup(self, path):
        """Copy path to the first free name <name>.bak-<stamp>, -2, -3, ...; never over an existing file.

        plan only names the backup and creates nothing."""
        base = path.name + ".bak-" + self.stamp
        number = 1
        while True:
            backup = path.with_name(base if number == 1 else base + "-" + str(number))
            number += 1
            if self.dry:
                if not (backup.exists() or backup.is_symlink()):
                    return backup
                continue
            try:
                fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue
            with os.fdopen(fd, "wb") as handle, open(path, "rb") as source:
                shutil.copyfileobj(source, handle)
            shutil.copystat(path, backup)
            return backup

    def hooks(self, plugin):
        def change(data, path):
            def put(key, value):
                if key in data and not is_kit_key(data[key]):
                    self.say("replaced: " + str(path) + " key " + key + " (its command is not in the kit)")
                data[key] = value
            put("tenant-kit", kit_hooks_key())
            if plugin:
                put("openviking", ov_hooks_key())
            elif "openviking" in data and is_kit_key(data["openviking"]):
                del data["openviking"]
            return data
        self.edit_json(self.config / "hooks.json", change)

    def mcp(self, plugin):
        def change(data, path):
            servers = data.get("mcpServers")
            if plugin:
                if "mcpServers" not in data:
                    servers = data["mcpServers"] = {}
                elif not isinstance(servers, dict):
                    raise Skip("has mcpServers that is not a JSON object")
                servers["openviking"] = {"command": "node", "args": [str(plugin / PROXY)]}
            elif isinstance(servers, dict) and is_kit_mcp(servers.get("openviking")):
                del servers["openviking"]
            return data
        self.edit_json(self.config / "mcp_config.json", change)

    def sandbox(self, skills):
        """The wanted sandbox rules (in order) and the full set that the kit owns; print one line per group."""
        groups, notes = sandbox_groups(self.home, self.gemini, os.environ)
        if not self.home.is_absolute():
            self.say("skipped: sandbox rules: the home folder " + repr(str(self.home)) + " is not absolute; the kit "
                     "writes no sandbox rule")
            return [], set(ALLOW)
        names = {skill.name for skill in skills}
        expected = {"herdr": HERDR_SKILL, "dummies": DUMMIES_SKILL}
        wanted = []
        for skill in SANDBOX_SKILLS:
            if skill not in names:
                continue
            place = link_place(self.gemini, skill)
            own_place = skill not in expected or (skill_src(skills, skill) == expected[skill]
                                                  and kit_place(self.gemini, place, expected[skill]))
            if not own_place:
                self.say("skipped: sandbox rules for the link path " + str(place / "scripts") + ": the place is not "
                         "the kit's link; the rules of the kit path stay")
            for label, rules in groups[skill]:
                if not own_place:
                    rules = [(rule, path) for rule, path in rules if path != place / "scripts"]
                bad = sorted({str(path) for rule, path in rules if path is not None and unsafe(path)})
                good = [rule for rule, path in rules if path is None or not unsafe(path)]
                for path in bad:
                    self.say("skipped: sandbox rule for " + repr(path) + ": the path holds a bracket or a space; "
                             "the kit writes no rule with it")
                if len(good) > 3:
                    folders = list(dict.fromkeys(str(path) for rule, path in rules if path is not None
                                                 and not unsafe(path)))
                    scripts = list(dict.fromkeys(rule.rsplit("/", 1)[-1].rstrip(")") for rule in good))
                    self.say("sandbox: " + label + ": command(python3 <dir>/<script>) for " + ", ".join(scripts)
                             + " in " + " and ".join(folders))
                elif good:
                    self.say("sandbox: " + label + ": " + ", ".join(good))
                wanted.extend(rule for rule in good if rule not in wanted)
            if skill == "herdr":
                for note in notes:
                    self.say(note)
        if any(rule.startswith("command(") for rule in wanted):
            self.say("warning: the command(...) rules let the named Herdr scripts, page.py and three read-only okknow "
                     "commands leave the agy terminal sandbox with no question; they apply to a new agy session")
        if not wanted:
            self.say("sandbox: no herdr, dummies or okknow skill; no sandbox rules")
        return wanted, kit_rule_texts(groups)

    def read_record(self):
        """The rules of the record and whether the file exists; None when the record is a link, invalid JSON or of
        another shape (the kit then owns no rule and adds none)."""
        path = self.record
        if not (path.exists() or path.is_symlink()):
            return [], False
        data = None
        if path.is_symlink():
            refusal = "is a link"
        else:
            refusal = "is not a record of version 1 with a list of rules"
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError):
                refusal = "is not valid JSON"
        if (is_version_1(data) and isinstance(data.get("rules"), list)
                and all(isinstance(rule, str) for rule in data["rules"])):
            return list(dict.fromkeys(data["rules"])), True
        self.say("skipped: " + str(path) + " " + refusal + "; the kit owns no allow rule, adds none and deletes none")
        return None

    def read_statusline_record(self):
        """The statusLine value of the record (None: the kit owns none) and whether the file exists; False when the
        record is a link, invalid JSON or of another shape (the kit then touches no statusLine)."""
        path = self.statusline_record
        if not (path.exists() or path.is_symlink()):
            return None, False
        data = None
        if path.is_symlink():
            refusal = "is a link"
        else:
            refusal = "is not a record of version 1 with a statusLine object or null"
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError):
                refusal = "is not valid JSON"
        if (is_version_1(data) and "statusLine" in data
                and (data["statusLine"] is None or isinstance(data["statusLine"], dict))):
            return data["statusLine"], True
        self.say("skipped: " + str(path) + " " + refusal + "; the kit sets and deletes no statusLine")
        return False

    def write_statusline_record(self, value, old, exists):
        """Write the statusLine record after settings.json; no write when it does not change, no new file for null."""
        if same_json(value, old) and (exists or value is None):
            return
        self.say("write: " + str(self.statusline_record))
        self.write_json(self.statusline_record, {"version": 1, "statusLine": value}, exists)

    def write_record(self, rules, old, exists):
        """Write the record after settings.json; no write when it does not change, no new file for no rule."""
        if rules == old and (exists or not rules):
            return
        self.say("write: " + str(self.record))
        self.write_json(self.record, {"version": 1, "rules": rules}, exists)

    def cli_settings(self, wanted, kit_texts, statusline):
        """One edit of antigravity-cli/settings.json: permissions.allow holds the wanted rules (in order) by the
        record (see Allow rules), and the statusLine key by statusline: "set" (apply) or "remove" (see Status line).
        An invalid record stops only its own part; a malformed settings.json stops the whole write."""
        found = self.read_record()
        record_ok = found is not None
        owned, exists = found if record_ok else ([], False)
        if not record_ok:
            wanted = []
        line_found = self.read_statusline_record()
        line_ok = line_found is not False
        recorded, line_exists = line_found if line_ok else (None, False)
        folder = self.gemini / "antigravity-cli"
        settings = folder / "settings.json"
        create = bool(wanted) or (statusline == "set" and line_ok)
        if not create and not (settings.exists() or settings.is_symlink()):
            # No file: no rule of the record and no statusLine of the record is in it.
            if record_ok:
                self.write_record([], owned, exists)
            if line_ok:
                self.write_statusline_record(None, recorded, line_exists)
            return
        if not self.safe_dir(folder, create=create):
            return
        result = {"record": [], "foreign": 0, "add": 0, "drop": 0, "statusLine": recorded}

        def change(data, path):
            # The containers of the kit are checked before any change, also with no wanted rule.
            permissions = data.get("permissions")
            if "permissions" in data and not isinstance(permissions, dict):
                raise Skip("has permissions that is not a JSON object")
            if isinstance(permissions, dict) and "allow" in permissions and not isinstance(permissions["allow"], list):
                raise Skip("has permissions.allow that is not a JSON list")
            if record_ok:
                self.allow_change(data, wanted, owned, kit_texts, result)
            if line_ok:
                self.statusline_change(data, path, statusline, recorded, result)
            return data
        if not self.edit_json(settings, change):
            return
        if result["add"] or result["drop"]:
            self.say("allow rules: add " + str(result["add"]) + " and record them, delete " + str(result["drop"])
                     + " of the record that are not wanted now")
        if result["foreign"]:
            self.say("allow rules: " + str(result["foreign"]) + " entries of permissions.allow equal a rule of the "
                     "kit and are not in the record " + str(self.record) + "; the kit leaves them (they are yours)")
        if record_ok:
            self.write_record(result["record"], owned, exists)
        if line_ok:
            self.write_statusline_record(result["statusLine"], recorded, line_exists)

    def allow_change(self, data, wanted, owned, kit_texts, result):
        """Change permissions.allow of the settings data in place; see Allow rules."""
        permissions = data.get("permissions")
        # cli_settings has checked the types of permissions and permissions.allow.
        if wanted:
            if "permissions" not in data:
                permissions = data["permissions"] = {}
            if "allow" not in permissions:
                permissions["allow"] = []
        elif not (isinstance(permissions, dict) and isinstance(permissions.get("allow"), list)):
            return
        # Only a string can be a rule of the kit; each other entry (an object, a list) stays in its place.
        allow = permissions["allow"]
        present = {rule for rule in allow if isinstance(rule, str)}
        drop = {rule for rule in owned if rule in present and rule not in wanted}
        add = [rule for rule in wanted if rule not in present]
        result["record"] = [rule for rule in owned if rule in present and rule in wanted] + add
        result["foreign"] = len({rule for rule in present if rule in kit_texts and rule not in owned})
        result["add"], result["drop"] = len(add), len(drop)
        permissions["allow"] = [rule for rule in allow if not (isinstance(rule, str) and rule in drop)] + add

    def statusline_change(self, data, path, statusline, recorded, result):
        """Set or remove the statusLine key of the kit in the settings data; see Status line. The key is the kit's
        only when it equals the value of the record; each other statusLine stays."""
        present = "statusLine" in data
        owned = present and recorded is not None and same_json(data["statusLine"], recorded)
        if statusline == "remove":
            if owned:
                self.say("statusline: remove the ops-footer status line of the kit")
                del data["statusLine"]
            elif present:
                self.say("skipped: " + str(path) + " key statusLine is not the one in the record " + str(
                    self.statusline_record) + "; the kit leaves it (yours)")
            result["statusLine"] = None
            return
        if present and not owned:
            self.say("skipped: " + str(path) + " key statusLine is not the one in the record " + str(
                self.statusline_record) + "; the kit leaves it (yours)")
            return
        value = statusline_value()
        if not (present and same_json(data["statusLine"], value)):
            self.say("statusline: " + value["command"])
            data["statusLine"] = value
        result["statusLine"] = value

    # Other actions ----------------------------------------------------------------------------------------------

    def herdr(self):
        if not shutil.which("herdr"):
            self.say("herdr: no herdr command on PATH; the Herdr integration for agy is not installed")
            return
        if self.gemini != self.home / ".gemini":
            self.say("herdr: --gemini is not ~/.gemini; run herdr integration install antigravity-cli yourself")
            return
        self.say("herdr: herdr integration install antigravity-cli")
        if self.dry:
            return
        try:
            done = subprocess.run(["herdr", "integration", "install", "antigravity-cli"], capture_output=True,
                                  text=True, timeout=60, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            self.say("warning: herdr integration install antigravity-cli failed: " + str(error))
            return
        lines = [line for line in (done.stdout + "\n" + done.stderr).splitlines() if line.strip()]
        last = lines[-1] if lines else ""
        if done.returncode:
            self.say("warning: herdr integration install antigravity-cli failed (exit " + str(done.returncode) + "): " + last)
        else:
            self.say("herdr: " + last)

    def shell_warnings(self):
        for name in SHELL_FILES:
            path = self.home / name
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            if any(line.strip() == INSTALLER_MARK for line in lines):
                self.say("warning: " + str(path) + " holds the PATH line of the agy installer ('" + INSTALLER_MARK
                         + "'); it can put plain pi and claude before the kit shims. The kit changes no shell file.")

    def apply(self, skills, artifacts):
        if not self.config.is_dir():
            self.say("agy: " + str(self.config) + " is absent. Run agy one time and sign in, then run the installer again.")
            return
        self.rules(artifacts)
        self.skills(skills)
        plugin = plugin_root(self.home)
        if not plugin:
            self.say("openviking: no OpenViking Claude Code plugin in " + str(self.home / PLUGIN_CACHE)
                     + "; no OpenViking hooks, MCP entry or allow rules")
        else:
            self.say("openviking: the hooks send the conversation of each agy session to your OpenViking server")
        config_ok = self.safe_dir(self.config, create=False)
        if config_ok:
            self.hooks(plugin)
            self.mcp(plugin)
        wanted, kit_texts = self.sandbox(skills)
        if config_ok:
            self.cli_settings((list(ALLOW) if plugin else []) + wanted, kit_texts, "set")
        self.herdr()
        self.shell_warnings()

    def remove(self):
        if not self.config.is_dir():
            self.say("agy: " + str(self.config) + " is absent; nothing to remove")
            return
        for sub in ("rules", "skills"):
            folder = self.config / sub
            if folder.is_dir() and self.safe_dir(folder, create=False):
                for entry in sorted(folder.iterdir()):
                    self.unlink_kit(entry)
        if not self.safe_dir(self.config, create=False):
            return

        def hooks(data, path):
            for key in ("tenant-kit", "openviking"):
                if key in data and is_kit_key(data[key]):
                    del data[key]
            return data

        def mcp(data, path):
            servers = data.get("mcpServers")
            if isinstance(servers, dict) and is_kit_mcp(servers.get("openviking")):
                del servers["openviking"]
            return data
        if (self.config / "hooks.json").exists() or (self.config / "hooks.json").is_symlink():
            self.edit_json(self.config / "hooks.json", hooks)
        if (self.config / "mcp_config.json").exists() or (self.config / "mcp_config.json").is_symlink():
            self.edit_json(self.config / "mcp_config.json", mcp)
        groups, _ = sandbox_groups(self.home, self.gemini, os.environ)
        self.cli_settings([], kit_rule_texts(groups), "remove")


def skill_src(skills, name):
    """The --skill folder with the name, or None."""
    return next((skill for skill in skills if skill.name == name), None)


def skill_folders(values):
    skills = []
    for value in values:
        path = Path(value).resolve()
        if not path.is_relative_to(KIT):
            raise Usage("--skill " + value + " is not a folder of the kit " + str(KIT))
        if not (path / "SKILL.md").is_file():
            raise Usage("--skill " + value + " has no SKILL.md")
        if any(skill.name == path.name for skill in skills):
            raise Usage("two --skill folders have the name " + path.name)
        skills.append(path)
    return skills


def main(argv=None):
    parser = argparse.ArgumentParser(prog="kit_agy.py", description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=("plan", "apply", "remove"))
    parser.add_argument("--skill", action="append", default=[], metavar="DIR")
    parser.add_argument("--artifacts", action="store_true")
    parser.add_argument("--gemini", metavar="DIR")
    args = parser.parse_args(argv)
    if args.action == "remove" and (args.skill or args.artifacts):
        parser.error("remove takes only --gemini")
    home = Path.home()
    gemini = Path(os.path.abspath(os.path.expanduser(args.gemini))) if args.gemini else home / ".gemini"
    try:
        skills = skill_folders(args.skill)
    except Usage as error:
        print("kit_agy.py: " + str(error), file=sys.stderr)
        return 2
    run = Run(gemini, home, dry=args.action == "plan")
    if args.action == "remove":
        run.remove()
    else:
        run.apply(skills, args.artifacts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
