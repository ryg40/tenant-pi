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
          6. run `herdr integration install antigravity-cli` when herdr is on PATH and --gemini is ~/.gemini
          7. warn when a shell start file holds the PATH line of the agy installer; change no shell file
  remove  delete the fixed names of the component while they are the kit's: the links in rules/ and skills/ that
          point into the kit, the hooks.json keys tenant-kit and openviking when each command points into the kit,
          mcpServers.openviking of the kit shape, and the three allow rules. Each other file and key stays.

Links: a free place gets a link; a broken link or a link into the kit is replaced; each other file, folder or link
stays byte-equal, with one line `skipped: ...`. A link is the kit's when its own target path (the first hop, not
the end of a chain of links) lies in the kit folder. The kit writes through no link below <gemini>.
JSON files: an absent or empty file counts as {}; a link, invalid JSON, or a container of the kit (mcpServers,
permissions, permissions.allow) of the wrong type is skipped with one line; each other key and the key order stay;
apply replaces a hooks.json key tenant-kit or openviking whose command is not in the kit and says so with one line
`replaced: ...`; the write goes through a temporary file and os.replace, keeps the file mode (a new file gets
0600) and writes the whole file again with an indent of two spaces; one backup <name>.bak-<UTC time> (with -2, -3,
... when that name exists; a backup never writes over a file) is made just before a write, and only when the
content changes.
The only file under <gemini>/antigravity-cli/ that the script opens is settings.json, only for the allow rules; it
never writes the key model. The kit never touches <gemini>/GEMINI.md and never reads the agy login.

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
PLUGIN_CACHE = Path(".claude", "plugins", "cache", "openviking", "openviking-memory")
PROXY = Path("servers", "mcp-proxy.mjs")
# The OpenViking hooks: (event, file, timeout in seconds).
OV_HOOKS = (("SessionStart", "openviking-session-start.mjs", 20),
            ("PreInvocation", "openviking-prompt-recall.mjs", 20),
            ("Stop", "openviking-capture.mjs", 30))
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


def utc_stamp():
    """The time part of a backup name: UTC, one second resolution."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class Run:
    def __init__(self, gemini, home, dry):
        self.gemini = gemini
        self.home = home
        self.dry = dry
        self.config = gemini / "config"
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
        """Apply change(data) to a JSON object file; write only when the content differs."""
        if path.is_symlink():
            self.say("skipped: " + str(path) + " is a link; the kit writes nothing through it")
            return
        try:
            text = path.read_text(encoding="utf-8") if path.exists() else ""
            data = json.loads(text) if text.strip() else {}
        except (OSError, ValueError, UnicodeDecodeError):
            self.say("skipped: " + str(path) + " is not valid JSON; the kit changes nothing in it")
            return
        if not isinstance(data, dict):
            self.say("skipped: " + str(path) + " is not a JSON object; the kit changes nothing in it")
            return
        try:
            new = change(json.loads(json.dumps(data)), path)
        except Skip as refusal:
            self.say("skipped: " + str(path) + " " + str(refusal) + "; the kit changes nothing in it")
            return
        if new == data:
            return
        exists = path.exists()
        self.say("write: " + str(path))
        if exists:
            self.say("backup: " + str(self.backup(path)))
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

    def allow_rules(self, add):
        folder = self.gemini / "antigravity-cli"
        if not add and not (folder / "settings.json").exists():
            return
        if not self.safe_dir(folder, create=add):
            return

        def change(data, path):
            permissions = data.get("permissions")
            if add:
                if "permissions" not in data:
                    permissions = data["permissions"] = {}
                elif not isinstance(permissions, dict):
                    raise Skip("has permissions that is not a JSON object")
                if "allow" not in permissions:
                    permissions["allow"] = []
                elif not isinstance(permissions["allow"], list):
                    raise Skip("has permissions.allow that is not a JSON list")
                allow = permissions["allow"]
                allow.extend(rule for rule in ALLOW if rule not in allow)
            elif isinstance(permissions, dict) and isinstance(permissions.get("allow"), list):
                permissions["allow"] = [rule for rule in permissions["allow"] if rule not in ALLOW]
            return data
        self.edit_json(folder / "settings.json", change)

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
        if self.safe_dir(self.config, create=False):
            self.hooks(plugin)
            self.mcp(plugin)
        self.allow_rules(add=bool(plugin))
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
        self.allow_rules(add=False)


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
