#!/usr/bin/env python3
"""Show the state of each kit resource in one Pi profile, and the plan of an install.sh run. Read-only.

Usage: kit_inventory.py --kit <root> --profile <dir> [--json | --plain] [--name <name>]
           [--with <modules>] [--shell bash|zsh|none] [--dummies] [--claude-plugin] [--runtime pi|pi-bolt|<path>]

The script reads config/manifest.json, config/catalog.json, the files of the profile and the
state files of the user. It writes no file of the profile or of the home directory. The version
probe of scripts/check_runtime.py runs `pi`, `node`, `python3` and `pi-bolt` once each with
`--version`; Pi gets an empty temporary agent directory that the probe makes and removes.
A refusal prints one line on standard error and exits 2. `--json` is the default output.
`--plain` prints a boxed table, with color only on a terminal and without `NO_COLOR`.

The JSON form, the contract of the installer TUI (scripts/kit_tui.py):

    {"profile": "<absolute profile directory>",
     "runtime": {"pi": R, "pi_bolt": R, "node": R, "python": R},
     "items": [{"name": "<catalog name>", "group": "<catalog group id>",
                "installed": true | false | "partial",
                "active": true | false | null,
                "version_installed": "<version>" | null,
                "version_pinned": "<version>" | null,
                "state_source": ["<absolute path>", ...],
                "plan": "install" | "upgrade" | "keep" | "remove" | "skip"}, ...]}

    R = {"installed": "<version>" | null, "required": "<pin or range>",
         "status": "match" | "untested_in_range" | "mismatch" | "missing" | "unparsed"}

- Each R is an object with exactly these three keys, for each of the four runtime keys.
- `items` has one entry for each item of config/catalog.json, in the order of the catalog. An item has
  exactly the eight keys above.
- `installed`: true when the item is registered and each of its parts is present where its reader finds it:
  the resource files that the manifest declares, as Pi discovers them or as the package of the entry offers
  them, and the command and Claude Code links of the item. A file that the filter of a package entry leaves
  out on purpose, for example a delta entry (`autoload: false`) that does not name it, is present: the item is
  installed and not active. "partial": some parts are present, for example a package entry without its files,
  a package folder with only package.json, or a link without the package entry. false: no part is present. A
  local package entry whose path does not exist counts as false; an npm entry without its files is "partial".
  A command link that points to another place (another clone) is present: install.sh keeps it.
- `active`: true when Pi loads at least one resource of the item for the selected runtime and each own
  switch of the item is on (a settings key, an environment override, a builtin switch, the off switches of
  the OpenViking and AgentCore extensions). Of two rows with the same real path, the one that Pi keeps
  decides. false when the item is present but off. DUMMIES is active only with its autostart block in the
  profile and the Pi switch on; the switch alone is false. null when the item is not installed and has no switch of
  its own, or when it has no on/off state (for example the shell block).
- `state_source` holds the files that the state comes from, when they exist, also a file that Pi loads from
  outside the package entry, for example a link in ~/.agents/skills. The record of another installer,
  for example ~/.config/tenant-pi/overlay.json, is outside this contract and is not read: Pi reads settings.json.
- `plan` is the result of an install.sh run with the selection. The run repairs and updates parts and leaves
  each own switch as it is. install: the item is absent and the run adds it. upgrade: the run changes an
  installed item (a new pin, a moved or missing package entry, a missing part, a stale generated file, a kit
  step). An item that is off can get upgrade: the run repairs it, and it stays off (`active: false`). One
  exception is install for an installed item that is off: the kit step of the run adds it once to a filter
  list of the profile that predates it, and the settings after the step load it for the selected runtime by the
  rules of `active`. A `!` pattern, a disabled link of the profile or the Pi-Bolt list can keep it off; then
  the plan stays upgrade. keep: the
  item is installed, active (or has no on/off state) and the run leaves it as it is. skip: the run leaves the
  item absent or off; an installed item whose switch is off and that the run does not change is skip, not keep.
  install for an installed item is valid only with `active: false` (the kit step above).
  remove: the run takes the item out: mcp, when mcp-codemode is selected; an AWS row (a component with a git
  source) that the kit installed and that the selection leaves out; claude-aws-plugins with --claude-aws and no
  AWS row. A removal takes out only the parts that the kit wrote (scripts/kit_aws.py).
- The TUI initializes each selection from `active` only: true is selected, false and null are not. It does not
  read `plan` for the selection, so an upgrade with `active: false` starts unselected.
- The selection: `--with` as in install.sh (a comma list, `all` or `none`), `--dummies`,
  `--claude-plugin`, `--claude-aws`, `--adopt-aws`, `--shell` and `--runtime`. Without `--with`, the selection is the optional modules
  that the profile has now. The core install (core, the Tenantext items, questions) is always in it.
  Without `--runtime`, the runtime is the choice of the launcher of the profile, else `pi`.
"""
import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import copy  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import platform  # noqa: E402
import posixpath  # noqa: E402
import re  # noqa: E402
import shlex  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
from urllib.parse import unquote  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import check_runtime, kit_aws  # noqa: E402
from scripts.validate import Invalid, load, manifest as checked_manifest, npm_parts  # noqa: E402

PLANS = ("install", "upgrade", "keep", "remove", "skip")
# The --with names of install.sh. questions is in the core install; its old --with name stays valid.
MODULES = ("wiki", "hermes", "mcp", "mcp-codemode", "computer-use", "computer-use-macos", "okknow", "artifacts",
           "walkr", "walkr-proxy", "questions", "aws-core", "aws-agents", "aws-data-analytics", "aws-agents-for-devsecops",
           "aws-startup-advisor", "aws-emulator")
# Catalog items that one --with name selects.
MODULE_ITEMS = {"artifacts": ("artifacts", "artifacts-prompt"), "walkr": ("walkr", "walkr-prompts")}
# Catalog items that are not manifest components.
EXTRA_ITEMS = ("mcp-codemode", "walkr-proxy", "claude-code-plugin", "claude-aws-plugins", "dummies", "shell-rc",
               "launcher")
# install.sh does not install these two; a run keeps them as they are.
MANUAL = ("openviking", "agentcore")
PLUGIN = "computer-use-linux@computer-use-linux"
# The kit steps of install.sh (KIT_STEPS there): an upgrade adds these items once to the filter lists of
# the Tenantext entry; kit-steps.json of the profile records each step that ran. A test compares this copy
# and add_kit_items with install.sh.
KIT_STEPS = {
    "herdr-idle-cleanup": {"skills": ["skills/herdr-idle-cleanup"], "extensions": ["extensions/handoffs/index.ts"],
                           "prompts": ["prompts/herdr-idle-cleanup.md"]},
}
# The Walkr commands that install.sh links into ~/.local/bin, with their files in packages/walkr/src.
WALKR_LINKS = (("walkr", "cli.js"), ("walkr-core", "walkr-core.js"), ("walkr-double", "walkr-double.js"),
               ("walkr-coinflip", "walkr-coinflip.js"), ("walkr-trainer", "walkr-trainer.js"),
               ("walkr-compare", "walkr-compare.js"))
# The roots of the Walkr setup (installSkills of packages/walkr/src/setup.js with global: true) and the
# packages that install.sh imports to check the dependencies of packages/walkr.
WALKR_ROOTS = (".claude", ".codex", ".agents")
WALKR_DEPENDENCIES = ("css-tree", "marked", "parse5")
# The placeholders that the Walkr setup replaces in a skill file, in its order: (placeholder, file in src).
WALKR_COMMANDS = (("{{LOCAL_DOUBLE_COMMAND}}", "walkr-double.js"), ("{{LOCAL_COINFLIP_COMMAND}}", "walkr-coinflip.js"),
                  ("{{LOCAL_TRAINER_COMMAND}}", "walkr-trainer.js"), ("{{LOCAL_COMPARE_COMMAND}}", "walkr-compare.js"))
# The instruction files that Pi loads from the profile, in the order of the DUMMIES state script.
PI_CONTEXT_FILES = ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
DUMMIES_BEGIN, DUMMIES_END = "<!-- dummies-autostart:begin -->", "<!-- dummies-autostart:end -->"
# Tenantext items with an on/off setting of their own: (file in the profile, key, value that means off,
# environment variable that overrides the key). The extensions read the files from their agent directory,
# which is the profile.
OWN_SWITCHES = {"context-meter": ("context-meter/settings.json", "enabled", False, None),
                "ops-footer": ("ops-footer/settings.json", "enabled", False, None),
                "next-prompt": ("next-prompt/settings.json", "enabled", False, None),
                "copilot-usage": ("copilot-usage/settings.json", "mode", "off", "TENANTEXT_COPILOT_USAGE"),
                "anthropic-usage": ("anthropic-usage/settings.json", "mode", "off", "TENANTEXT_ANTHROPIC_USAGE")}
MODES = ("auto", "on", "off")
NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
PI_TYPES = ("extensions", "skills", "prompts")
BUILTIN = "builtin:"
BUILTINS = ("mcp", "llama.cpp", "codemode", "tool-search")
NON_LOCAL = re.compile(r"(npm:|git:|github:|https?:|ssh:|builtin:)")
# The precedence of a resource row in the user scope, as resourcePrecedenceRank of Pi: lower wins.
RANK = {"local": 2, "auto": 3, "package": 4}
# The tools that Pi turns on when defaultTools does not change them (DEFAULT_TOOL_NAMES of Pi).
DEFAULT_TOOLS = ("read", "bash", "edit", "write")
# The bool words of the OpenViking settings (TRUE_WORDS and FALSE_WORDS of shared/config-schema.mjs).
OV_TRUE, OV_FALSE = ("1", "true", "yes", "on"), ("0", "false", "no", "off")
# The bound of the loop of ov_bool that unwraps nested one-item arrays; json.loads stops before 1000 levels.
OV_ARRAY_DEPTH = 10000
# The characters that String.prototype.trim of JavaScript removes (WhiteSpace and LineTerminator).
JS_SPACE = "".join(map(chr, (9, 10, 11, 12, 13, 32, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F,
                             0x205F, 0x3000, 0xFEFF)))
# The patterns of validateConfig and validateId of packages/agentcore-memory-core (src/index.mjs, src/ids.mjs).
AC_FIELDS = {"schemaVersion", "memoryId", "region", "profile", "actorId", "projects", "topK", "recallTimeoutMs",
             "writeTimeoutMs", "ledgerPath", "hostLabel"}
AC_MEMBERSHIP_FIELDS = {"projectId", "role", "remotes", "directories"}
AC_ROLES = ("member", "maintainer")
AC_REGION = re.compile(r"[a-z]{2}(?:-[a-z]+)+-[0-9]+")
AC_MEMORY_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,127}")
AC_LABEL = re.compile(r"[A-Za-z0-9._-]{1,64}")
AC_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
LAUNCHER_RUNTIME = "# tenant-pi runtime: "


class Refusal(Exception):
    """One line for standard error; the script exits 2."""


def read_json(path, strict=False):
    """The JSON value of a file, or None when it is absent. A strict read refuses a file that is not valid."""
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        if strict:
            raise Refusal(f"{path} is not readable JSON ({type(error).__name__})") from None
        return None


def read_text(path):
    """The text of a file without newline changes, or None."""
    try:
        return Path(path).read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def has_lines(path, *wanted):
    """True when the text file holds each wanted line. Only the marker lines are compared; no text is kept."""
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as stream:
            found = {line.rstrip("\r\n").rstrip(" \t") for line in stream} & set(wanted)
    except OSError:
        return False
    return found == set(wanted)


def managed_block(path, start, end):
    """The lines inside the one managed block of a startup file, or None. install.sh refuses a repeated marker."""
    inside, lines, blocks = False, [], []
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as stream:
            for line in stream:
                text = line.rstrip("\r\n")
                if text == start:
                    inside, lines = True, []
                    blocks.append(None)
                elif text == end and inside:
                    inside = False
                    blocks[-1] = lines
                elif inside:
                    lines.append(text)
    except OSError:
        return None
    return blocks[0] if len(blocks) == 1 and not inside else None


def version_of(package_dir):
    data = read_json(Path(package_dir) / "package.json")
    return data.get("version") if isinstance(data, dict) and isinstance(data.get("version"), str) else None


def resolves_to(link, target):
    return link.is_symlink() and link.exists() and link.resolve() == Path(target).resolve()


def strings(value):
    return [one for one in value if isinstance(one, str)] if isinstance(value, list) else None


def parts(count, total):
    return True if total and count == total else "partial" if count else False


# ---------------------------------------------------------------------------
# Pi resource discovery: a port of packages/tenantext/extensions/resources/inventory.ts (patterns, file
# discovery, package sources and inventoryFromParsed). docs/resources.md, "How Pi reads a list", has the rules.
# ---------------------------------------------------------------------------

def posix(path):
    return str(path).replace(os.sep, "/")


def glob_regex(glob):
    """A subset of minimatch: `*`, `**`, `?`, `[...]`, `{a,b}`. `*` and `?` do not match a leading dot."""
    out, braces, i = "", 0, 0
    while i < len(glob):
        c = glob[i]
        start = i == 0 or glob[i - 1] == "/"
        if c == "*":
            if glob[i + 1:i + 2] == "*" and start and (glob[i + 2:i + 3] == "/" or i + 2 == len(glob)):
                if glob[i + 2:i + 3] == "/":
                    out, i = out + r"(?:(?!\.)[^/]+/)*", i + 2
                else:
                    out, i = out + r"(?:(?!\.)[^/]+(?:/|$))*", i + 1
            else:
                while glob[i + 1:i + 2] == "*":
                    i += 1
                out += (r"(?!\.)" if start else "") + "[^/]*"
        elif c == "?":
            out += (r"(?!\.)" if start else "") + "[^/]"
        elif c == "[":
            end = glob.find("]", i + 2)
            if end < 0:
                out += r"\["
            else:
                body = glob[i + 1:end].replace("\\", "\\\\")
                out, i = out + "[" + ("^" + body[1:] if body.startswith("!") else body) + "]", end
        elif c == "{" and glob.find("}", i) > i:
            out, braces = out + "(?:", braces + 1
        elif c == "}" and braces:
            out, braces = out + ")", braces - 1
        elif c == "," and braces:
            out += "|"
        else:
            out += re.escape(c)
        i += 1
    try:
        return re.compile("^" + out + "$")
    except re.error:
        return re.compile(r"(?!)")


def targets(path, base):
    """The relative path, the name and the full path; a SKILL.md also matches through its directory."""
    if path.startswith(BUILTIN):
        return {"rel": path, "name": path, "full": path}
    full, base = posix(path), posix(base)
    found = {"rel": posixpath.relpath(full, base), "name": posixpath.basename(full), "full": full}
    if found["name"] == "SKILL.md":
        parent = posixpath.dirname(full)
        found.update(parent_rel=posixpath.relpath(parent, base), parent_name=posixpath.basename(parent),
                     parent_full=parent)
    return found


def matches_pattern(path, patterns, base):
    values = targets(path, base).values()
    return any(glob_regex(posix(pattern)).match(value) for pattern in patterns for value in values)


def matches_exact(path, patterns, base):
    found = targets(path, base)
    exact = {found["rel"], found["full"], found.get("parent_rel"), found.get("parent_full")} - {None}
    return any(posix(pattern[2:] if pattern.startswith(("./", ".\\")) else pattern) in exact for pattern in patterns)


def is_override(entry):
    return entry[:1] in ("!", "+", "-")


def is_pattern(entry):
    return is_override(entry) or "*" in entry or "?" in entry


def overrides_enable(path, entries, base):
    """A discovered file or a builtin: on unless `!glob` matches; `+path` wins over `!`; `-path` over both."""
    pick = lambda prefix: [entry[1:] for entry in entries if entry.startswith(prefix)]  # noqa: E731
    enabled = not matches_pattern(path, pick("!"), base)
    if matches_exact(path, pick("+"), base):
        enabled = True
    return enabled and not matches_exact(path, pick("-"), base)


def apply_patterns(paths, patterns, base):
    """Filter lists: plain entries include (none means all), then `!` excludes, `+` adds back, `-` removes."""
    pick = lambda prefix: [pattern[1:] for pattern in patterns if pattern.startswith(prefix)]  # noqa: E731
    includes = [pattern for pattern in patterns if not is_override(pattern)]
    result = [path for path in paths if matches_pattern(path, includes, base)] if includes else list(paths)
    excludes = pick("!")
    result = [path for path in result if not matches_pattern(path, excludes, base)]
    forced = pick("+")
    for path in paths:
        if path not in result and matches_exact(path, forced, base):
            result.append(path)
    removed = pick("-")
    return [path for path in result if not matches_exact(path, removed, base)]


def apply_delta(paths, patterns, base):
    """The last entry that matches wins. For a package entry with `autoload: false`."""
    result = {}
    for pattern in patterns:
        target = pattern[1:] if is_override(pattern) else pattern
        exact = pattern[:1] in ("+", "-")
        for path in paths:
            if matches_exact(path, [target], base) if exact else matches_pattern(path, [target], base):
                result[path] = pattern[:1] not in ("-", "!")
    return result


def listing(directory):
    """(name, full path, is a directory, is a file) of each entry, by name; a broken link is left out."""
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    out = []
    for name in names:
        full = os.path.join(directory, name)
        try:
            mode = os.stat(full).st_mode
        except OSError:
            continue
        out.append((name, full, stat.S_ISDIR(mode), stat.S_ISREG(mode)))
    return out


def visible(name):
    return not name.startswith(".") and name != "node_modules"


def pi_manifest(root):
    """The resource fields of the `pi` field of package.json: {type: entries}, or None without one (readPiManifest of Pi)."""
    data = read_json(os.path.join(root, "package.json"))
    found = data.get("pi") if isinstance(data, dict) else None
    if not isinstance(found, dict):
        return None
    fields = {kind: entries for kind in (*PI_TYPES, "themes")
              if isinstance(entries := found.get(kind), list) and all(isinstance(one, str) for one in entries)}
    return fields or None


def extension_entries(directory):
    declared = [path for path in (os.path.normpath(os.path.join(directory, entry))
                                  for entry in (pi_manifest(directory) or {}).get("extensions", [])) if os.path.exists(path)]
    if declared:
        return declared
    for name in ("index.ts", "index.js"):
        if os.path.exists(os.path.join(directory, name)):
            return [os.path.join(directory, name)]
    return None


def auto_extensions(directory):
    if not os.path.exists(directory):
        return []
    root = extension_entries(directory)
    if root:
        return root
    out = []
    for name, full, is_dir, is_file in listing(directory):
        if not visible(name):
            continue
        if is_file and name.endswith((".ts", ".js")):
            out.append(full)
        elif is_dir:
            out += extension_entries(full) or []
    return out


def skill_entries(directory, mode, root=None):
    """Mode `pi`: Markdown files directly in the root count. Mode `agents`: Markdown files below the root count."""
    root = directory if root is None else root
    entries = listing(directory)
    for name, full, _, is_file in entries:
        if name == "SKILL.md" and is_file:
            return [full]
    out = []
    for name, full, is_dir, is_file in entries:
        if not visible(name):
            continue
        if is_file and name.endswith(".md") and ((directory == root) if mode == "pi" else (directory != root)):
            out.append(full)
        elif is_dir:
            out += skill_entries(full, mode, root)
    return out


def markdown_files(directory, recursive):
    out = []
    for name, full, is_dir, is_file in listing(directory):
        if not visible(name):
            continue
        if is_file and name.endswith(".md"):
            out.append(full)
        elif is_dir and recursive:
            out += markdown_files(full, True)
    return out


def resource_files_in(directory, kind):
    if kind == "skills":
        return skill_entries(directory, "pi")
    if kind == "extensions":
        return auto_extensions(directory)
    return markdown_files(directory, True)


def files_from_paths(paths, kind):
    out = []
    for path in paths:
        try:
            mode = os.stat(path).st_mode
        except OSError:
            continue
        if stat.S_ISREG(mode):
            out.append(path)
        elif stat.S_ISDIR(mode):
            out += resource_files_in(path, kind)
    return out


def expand_glob(pattern, root):
    """The entries below `root` that a manifest glob matches. Hidden path segments do not match."""
    regex = glob_regex(posix(pattern[2:] if pattern.startswith("./") else pattern))
    out = []

    def walk(directory):
        for name, full, is_dir, _ in listing(directory):
            if not visible(name):
                continue
            if regex.match(posix(os.path.relpath(full, root))):
                out.append(full)
            if is_dir:
                walk(full)
    walk(root)
    return sorted(out)


def manifest_entry_files(root, entries, kind):
    """The files that the entries of one manifest field name, after the own patterns of the field."""
    sources = [entry for entry in entries if not is_override(entry)]
    found = files_from_paths([one for entry in sources for one in (
        expand_glob(entry, root) if re.search(r"[*?]", entry) else [os.path.normpath(os.path.join(root, entry))])], kind)
    own = [entry for entry in entries if is_override(entry)]
    return apply_patterns(found, own, root) if own else found


def convention_files(root, kind):
    directory = os.path.join(root, kind)
    return resource_files_in(directory, kind) if os.path.exists(directory) else []


def manifest_files(root, kind):
    """collectManifestFiles of Pi, for a filter of a package entry: a manifest field with entries, else the
    conventional directory. An empty field falls back to the directory."""
    entries = (pi_manifest(root) or {}).get(kind)
    return manifest_entry_files(root, entries, kind) if entries else convention_files(root, kind)


def default_files(root, kind):
    """collectDefaultResources of Pi, without a filter for the type: a manifest field, also an empty one, else the
    conventional directory. An empty field offers nothing."""
    entries = (pi_manifest(root) or {}).get(kind)
    return manifest_entry_files(root, entries, kind) if entries is not None else convention_files(root, kind)


def resolve_from(text, base, home):
    path = text.strip()
    if path.startswith("file://"):
        path = unquote(path[len("file://"):])
    if path == "~":
        path = str(home)
    elif path.startswith("~/"):
        path = os.path.join(str(home), path[2:])
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(str(base), path))


def source_of(entry):
    source = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
    return source if isinstance(source, str) else None


def package_place(source, base, home):
    """(root, identity) of a package source below the agent directory, as packageRoot of inventory.ts, or None."""
    trimmed = source.strip()
    if trimmed.startswith("npm:"):
        spec = trimmed[4:].strip()
        found = re.match(r"^(@?[^@]+(?:/[^@]+)?)(?:@(.+))?$", spec)
        name = found.group(1) if found else spec
        return os.path.join(str(base), "npm", "node_modules", name), "npm:" + name
    if not NON_LOCAL.match(trimmed):
        root = resolve_from(trimmed, base, home)
        return root, "local:" + root
    url = re.sub(r"^git:", "", trimmed).strip()
    if url.startswith("github:"):
        url = "github.com/" + url[len("github:"):]
    url = re.sub(r"#.*$", "", re.sub(r"^[^@/]+@", "", re.sub(r"^[a-z+]+://", "", url, flags=re.I)))
    found = re.match(r"^([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?(?:@[^/]*)?/?$", url)
    if not found:
        return None
    path = re.sub(r"\.git$", "", found.group(2))
    return os.path.join(str(base), "git", found.group(1), path), f"git:{found.group(1)}/{path}"


def identity_of(entry, base, home):
    source = source_of(entry)
    place = package_place(source, base, home) if source is not None else None
    return place[1] if place else None


def pi_bolt_packages(settings, base, home):
    """The package list of Pi-Bolt: piBolt.packages over the shared packages, in the order of its entries.

    A port of resolvePackageOverlay (src/core/package-source.ts) and of the one-time conversion of a legacy copy
    (withLegacyPiBoltPackagesConverted, src/core/settings-manager.ts) of Pi-Bolt. A `-source` entry removes that
    package for Pi-Bolt only. Pi-Bolt also moves its own Bun packages out of the shared list; the kit has none.
    """
    shared = settings.get("packages") if isinstance(settings.get("packages"), list) else []
    own_settings = settings.get("piBolt") if isinstance(settings.get("piBolt"), dict) else {}
    own = own_settings.get("packages") if isinstance(own_settings.get("packages"), list) else []
    identity = lambda entry: identity_of(entry, base, home)  # noqa: E731
    if own and own_settings.get("packagesOverlay") is not True and not any(
            isinstance(entry, str) and entry.startswith("-") for entry in own):
        # A list from Pi-Bolt before 0.9.1 is a full copy: a shared package that it lacks is off for Pi-Bolt.
        own_ids = {identity(entry) for entry in own}
        exclusions = {}
        for entry in shared:
            key = identity(entry)
            if key is not None and key not in own_ids and key not in exclusions:
                exclusions[key] = "-" + source_of(entry)

        def declaration(entry):
            filters = {key: value for key, value in (entry.items() if isinstance(entry, dict) else ()) if key != "source"}
            key = identity(entry)
            spec = key if key and key.startswith("local:") else str(source_of(entry)).strip()
            return json.dumps([spec, sorted(filters.items())], sort_keys=True)

        kept = []
        for entry in own:
            same = [one for one in shared if identity(one) is not None and identity(one) == identity(entry)]
            if not same or not all(declaration(one) == declaration(entry) for one in same):
                kept.append(entry)
        own = [*exclusions.values(), *kept]
    packages = list(shared)
    for entry in own:
        excluded = isinstance(entry, str) and entry.startswith("-")
        key = identity(entry[1:]) if excluded else identity(entry)
        index = next((number for number, one in enumerate(packages) if identity(one) == key), -1)
        packages = [one for one in packages if identity(one) != key]
        if not excluded:
            packages.insert(len(packages) if index == -1 else index, entry)
    return packages


class PiView:
    """The extensions, skills and prompts that Pi finds in the user scope of one profile, and their state.

    A port of inventoryFromParsed of packages/tenantext/extensions/resources/inventory.ts, steps 1 to 4.
    It differs in these points:
    - Only the user scope. A profile has no project directory, so `<cwd>/.pi` of a session is not read.
    - `packages` is the list of the selected runtime: with Pi-Bolt, the list of pi_bolt_packages. The
      /resources command shows the shared list only.
    - These rules follow dist/core/package-manager.js of Pi 1.5.2, where inventory.ts differs: a package
      directory without resources loads as one extension only for a local entry (resolveLocalExtensionSource),
      not for npm and git. Without a filter for a type, a manifest field that is an empty list offers nothing of
      that type (collectDefaultResources). With a filter for the type, an empty field falls back to the
      conventional directory (collectManifestFiles). Last, the rows get the precedence of Pi (toResolvedPaths):
      a settings entry, then a conventional directory, then a package. Of the rows with the same real path, Pi
      keeps only the first; a disabled link in extensions/ thus hides the enabled package file that it names.
      A comparison with the resolver of the installed Pi gave the same rows.
    """

    def __init__(self, profile, home, settings, packages):
        self.rows, seen, done = [], set(), set()

        def add(kind, path, enabled, source):
            # Pi keeps the first entry of each path (addResource).
            if (kind, path) in seen:
                return
            seen.add((kind, path))
            real = path
            if os.path.isdir(path):
                # A package directory that loads as one extension: Pi starts its index file.
                real = next((os.path.join(path, name) for name in ("index.ts", "index.js")
                             if os.path.exists(os.path.join(path, name))), path)
            real = os.path.realpath(real)
            self.rows.append({"kind": kind, "path": path, "posix": posix(path), "real": real, "real_posix": posix(real),
                              "key": os.path.realpath(path), "enabled": enabled, "source": source})

        # 1. Packages. Pi keeps the first entry of each package identity.
        for entry in packages:
            source = source_of(entry)
            place = package_place(source, profile, home) if source is not None else None
            if not place or place[1] in done:
                continue
            done.add(place[1])
            root = place[0]
            try:
                mode = os.stat(root).st_mode
            except OSError:
                continue
            if stat.S_ISREG(mode):
                add("extensions", root, True, "package")
                continue
            filters = entry if isinstance(entry, dict) else None
            manifest = pi_manifest(root)
            for kind in PI_TYPES:
                patterns = strings(filters.get(kind)) if filters is not None and isinstance(filters.get(kind), list) else None
                if filters is None:
                    # No filter object: a manifest that leaves out a type offers nothing of that type.
                    files = [] if manifest is not None and kind not in manifest else default_files(root, kind)
                    enabled = set(files)
                elif filters.get("autoload") is False:
                    # A delta entry: only the files that its patterns name, the last match wins.
                    for path, on in (apply_delta(manifest_files(root, kind), patterns, root) if patterns else {}).items():
                        add(kind, path, on, "package")
                    continue
                elif patterns is not None:
                    # A filter list: an empty list turns each file of the type off.
                    files = manifest_files(root, kind)
                    enabled = set(apply_patterns(files, patterns, root)) if patterns else set()
                else:
                    files = default_files(root, kind)
                    enabled = set(files)
                for path in files:
                    add(kind, path, path in enabled, "package")
            # A local directory with no filter, no manifest field and no resource directory loads as one extension.
            if (filters is None and manifest is None and not NON_LOCAL.match(source.strip())
                    and not any(os.path.exists(os.path.join(root, kind)) for kind in (*PI_TYPES, "themes"))):
                add("extensions", root, True, "package")
        # 2. The explicit entries of the resource arrays of settings.json.
        for kind in PI_TYPES:
            entries = strings(settings.get(kind)) or []
            files = files_from_paths([resolve_from(entry, profile, home) for entry in entries if not is_pattern(entry)], kind)
            enabled = set(apply_patterns(files, [entry for entry in entries if is_pattern(entry)], profile))
            for path in files:
                add(kind, path, path in enabled, "local")
        # 3. The conventional directories. ~/.agents/skills belongs to the user scope with its own base.
        for kind, paths, base in (
                ("extensions", auto_extensions(os.path.join(profile, "extensions")), profile),
                ("skills", skill_entries(os.path.join(profile, "skills"), "pi"), profile),
                ("skills", skill_entries(os.path.join(home, ".agents", "skills"), "agents"), os.path.join(home, ".agents")),
                ("prompts", markdown_files(os.path.join(profile, "prompts"), False), profile)):
            overrides = strings(settings.get(kind)) or []
            for path in paths:
                add(kind, path, overrides_enable(path, overrides, base), "auto")
        # The precedence of Pi, then one row for each real path of a type: the stable sort keeps the order of the
        # rows of one rank, as Array.prototype.sort does.
        ranked, keys = sorted(self.rows, key=lambda row: RANK[row["source"]]), set()
        self.rows = []
        for row in ranked:
            if (row["kind"], row["key"]) not in keys:
                keys.add((row["kind"], row["key"]))
                self.rows.append(row)
        # 4. The builtin extensions of Pi.
        extensions = strings(settings.get("extensions")) or []
        self.builtins = {name: overrides_enable(BUILTIN + name, extensions, profile) for name in BUILTINS}

    def find(self, kind, files=(), suffixes=()):
        """The rows of one type whose file is one of `files` (by real path) or ends with one of `suffixes`."""
        wanted = {os.path.realpath(path) for path in files}
        return [row for row in self.rows if row["kind"] == kind and (
            row["real"] in wanted or any(row["posix"].endswith(one) or row["real_posix"].endswith(one) for one in suffixes))]


def add_kit_items(entry, key, items):
    """The list that the kit step of install.sh (add_kit_items there) leaves, or None when the run keeps the entry."""
    current = entry.get(key)
    delta = entry.get("autoload") is False
    if current is None and delta:
        current = []
    if not isinstance(current, list):
        return None
    if not delta and not any(isinstance(one, str) and one[:1] not in ("!", "+", "-") for one in current):
        return None
    named = {one.lstrip("!+-") for one in current if isinstance(one, str)}
    added = [item for item in items if item not in named]
    # install.sh also writes `[]` for a missing key of a delta entry when it adds nothing.
    return current + added if added or key not in entry else None


def resource_files(component):
    """(kind, path in the package) of each Pi resource that the manifest declares; a skill gives its SKILL.md."""
    for kind in PI_TYPES:
        for item in component["resources"].get(kind, []):
            yield kind, (item if kind != "skills" or item.endswith("SKILL.md") else item.rstrip("/") + "/SKILL.md")


# ---------------------------------------------------------------------------
# State.
# ---------------------------------------------------------------------------

class Inventory:
    def __init__(self, kit, profile, home, name, env, adopt=False):
        self.kit, self.profile, self.home, self.name, self.env, self.adopt = kit, profile, home, name, env, adopt
        try:
            self.manifest = load(kit / "config/manifest.json")
            checked_manifest(self.manifest)
        except Invalid as error:
            raise Refusal(f"config/manifest.json: {error}") from None
        self.components = self.manifest["components"]
        catalog = read_json(kit / "config/catalog.json", strict=True)
        if not isinstance(catalog, dict) or not isinstance(catalog.get("items"), list):
            raise Refusal("config/catalog.json has no items list")
        self.catalog = catalog
        names = [item.get("name") for item in catalog["items"] if isinstance(item, dict)]
        unknown = [one for one in names if one not in self.components and one not in EXTRA_ITEMS]
        missing = [one for one in [*self.components, *EXTRA_ITEMS] if one not in names]
        if unknown or missing or len(names) != len(set(names)) or len(names) != len(catalog["items"]):
            raise Refusal("config/catalog.json does not match the manifest: "
                          + ", ".join([*("unknown " + one for one in unknown), *("missing " + one for one in missing)]
                                      or ["a repeated or malformed item"]))
        self.settings_path = profile / "settings.json"
        settings = read_json(self.settings_path, strict=True)
        if settings is not None and not isinstance(settings, dict):
            raise Refusal(f"{self.settings_path} is not a JSON object")
        self.settings = settings or {}
        packages = self.settings.get("packages", [])
        if not isinstance(packages, list):
            raise Refusal(f"{self.settings_path}: packages must be a list")
        self.shared = packages
        self.claude = home / ".claude"
        self.stepped = {}

    def resolve(self, pi_bolt):
        """Read the resources for the selected runtime. With Pi-Bolt, piBolt.packages changes the package list."""
        self.pi_bolt = pi_bolt
        self.packages = pi_bolt_packages(self.settings, self.profile, self.home) if pi_bolt else list(self.shared)
        # The entries that a runtime reads first, then the shared entries that Pi-Bolt leaves out.
        self.registered = self.packages + [entry for entry in self.shared if not any(entry is one for one in self.packages)]
        self.pi = PiView(str(self.profile), str(self.home), self.settings, self.packages)

    def after_steps(self, steps):
        """This inventory with the settings that the kit steps `steps` of a run leave, read for the same runtime.

        As the settings writer of install.sh: each shared Tenantext entry gets the source of this clone, and an
        object entry gets the items of each step in its filter lists. piBolt.packages stays as it is.
        """
        key = tuple(steps)
        if key not in self.stepped:
            settings = copy.deepcopy(self.settings)
            packages = settings.setdefault("packages", [])
            desired = str(self.kit / "packages/tenantext")
            for index, entry in enumerate(packages):
                source = source_of(entry)
                if source is None or not (source == desired or (self.profile / source).resolve() == Path(desired).resolve()
                                          or source.rstrip("/").endswith("/packages/tenantext")):
                    continue
                if not isinstance(entry, dict):
                    packages[index] = desired
                    continue
                entry["source"] = desired
                for step in steps:
                    for kind, items in KIT_STEPS[step].items():
                        after = add_kit_items(entry, kind, items)
                        if after is not None:
                            entry[kind] = after
            stepped = copy.copy(self)
            stepped.settings, stepped.shared, stepped.stepped = settings, packages, {}
            stepped.resolve(self.pi_bolt)
            self.stepped[key] = stepped
        return self.stepped[key]

    def excluded(self, entry):
        """True for a shared package entry that the Pi-Bolt list leaves out."""
        return not any(entry is one for one in self.packages)

    # --- package entries -------------------------------------------------------

    def tree_entry(self, rel):
        """(entry, root, here) of the first package entry of the kit package `rel`; here is False for another clone."""
        target = (self.kit / rel).resolve()
        tail = "/" + rel
        for entry in self.registered:
            source = source_of(entry)
            if source is None or NON_LOCAL.match(source.strip()):
                continue
            root = Path(resolve_from(source, self.profile, self.home))
            resolved = root.resolve()
            here = resolved == target or resolved.is_relative_to(target)
            if here or source.rstrip("/").endswith(tail) or tail + "/" in source:
                return entry, root, here
        return None, None, False

    def npm_entry(self, name):
        for entry in self.registered:
            source = source_of(entry)
            if source is not None and source.strip().startswith("npm:"):
                spec_name, version = npm_parts(source.strip()[4:].strip())
                if spec_name == name:
                    return entry, version
        return None, None

    # --- other state -----------------------------------------------------------

    def config_dir(self):
        base = self.env.get("XDG_CONFIG_HOME") or ""
        return Path(base) if os.path.isabs(base) else self.home / ".config"

    def claude_links(self, skills):
        """{state: [link paths]} of the Claude Code skill links of install.sh: linked, missing (the run links it), other."""
        found = {"linked": [], "missing": [], "other": []}
        if not self.claude.is_dir():
            return found
        for skill in skills:
            if not (skill / "SKILL.md").is_file():
                continue
            dest = self.claude / "skills" / skill.name
            if resolves_to(dest, skill):
                found["linked"].append(dest)
            elif not dest.exists() and not dest.is_symlink():
                found["missing"].append(dest)
            elif dest.is_symlink() and (not dest.is_dir() or dest.resolve().is_relative_to(self.kit.resolve())):
                found["missing"].append(dest)
            else:
                found["other"].append(dest)
        return found

    def launcher(self):
        """(path, marked, runtime path or None, text) of the launcher ~/.local/bin/<name>."""
        path = self.home / ".local/bin" / self.name
        try:
            text = path.read_text(encoding="utf-8") if path.is_file() else ""
        except (OSError, UnicodeDecodeError):
            text = ""
        lines = text.splitlines()
        marked = "# tenant-pi launcher: " + self.name in lines
        runtime = None
        if marked:
            try:
                runtime = check_runtime.launcher_runtime(path)
            except Invalid:
                runtime = None
        return path, marked, runtime, text

    def switch_on(self, cid, sources):
        """False when an own setting of the item turns it off. The environment variable wins, as in the extension.

        The extension reads the variable from the environment of Pi; this script reads its own environment, which a
        launcher started from the same shell passes on. A file that the extension rejects for another key gives its
        defaults in Pi (on); this script reads only the one key.
        """
        found = OWN_SWITCHES.get(cid)
        if found is None:
            return True
        rel, key, off, variable = found
        path = self.profile / rel
        data = read_json(path)
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(data, dict):
            sources.append(path)
        if variable and self.env.get(variable) in MODES:
            value = self.env.get(variable)
        return value != off


def state(installed, active=None, version_installed=None, version_pinned=None, sources=(), change=False, installs=True,
          turns_on=False):
    """The facts of one item. change: the run changes the installed item. installs: the run of a selected, absent
    item makes it present and on; false when the run leaves it absent (mcp-codemode, and the guide row walkr-proxy). turns_on: the kit step of
    the run adds the installed item that is off to a filter list of the profile, and the settings after the step load
    it for the selected runtime, so the item is on after the run."""
    return {"installed": installed, "active": active, "version_installed": version_installed,
            "version_pinned": version_pinned, "state_source": [str(path) for path in dict.fromkeys(sources)],
            "change": change, "installs": installs, "turns_on": turns_on}


def tree_part(inv, component):
    """The Pi part of a kit tree package: its entry, which resources Pi finds, and the state that follows."""
    rel = component["source"]["path"]
    entry, root, here = inv.tree_entry(rel)
    files = list(resource_files(component))
    rows = {}
    for kind, file in files:
        candidates = [inv.kit / rel / file] + ([root / file] if root is not None and root.is_dir() else [])
        rows[file] = inv.pi.find(kind, candidates, ["/" + rel + "/" + file])
    found = [row for one in rows.values() for row in one]
    sources = [inv.settings_path] if entry is not None or found else []
    # A file that Pi loads from outside the package entry, for example a link in ~/.agents/skills, decides too.
    sources += [Path(row["path"]) for row in found if row["enabled"] and row["source"] != "package"]
    if entry is None and found:
        # Only explicit entries of the resource arrays: here when each of them is in this clone.
        kit = os.path.realpath(inv.kit / rel)
        here = all(row["real"].startswith(kit + os.sep) for row in found)
    if entry is not None and inv.excluded(entry) and not found:
        # Pi-Bolt leaves the entry out: the files decide installed, and nothing loads.
        present = sum(1 for _, file in files if (root / file).exists()) if root.is_dir() else int(root.is_file())
        installed, active = (parts(present, len(files)), False) if present else (False, None)
    elif entry is None and not found:
        installed, active = False, None
    elif entry is not None and not root.exists() and not found:
        # A local package entry whose path does not exist: nothing of the package is installed.
        installed, active = False, None
    else:
        # A required file counts when Pi finds it, or when the package of the entry offers it and the filter of the
        # entry leaves it out, for example a delta entry (autoload false) that does not name it. A registration
        # whose package does not offer the file (no manifest field, no conventional directory) is partial.
        offered = set()
        if entry is not None and root.is_dir():
            for kind in {kind for kind, _ in files}:
                offered |= {os.path.realpath(path) for path in manifest_files(str(root), kind)}
        present = sum(1 for _, file in files if rows[file] or offered and os.path.realpath(root / file) in offered)
        installed = parts(present, len(files)) or "partial"
        active = any(row["enabled"] for row in found)
    folder = root if root is not None and root.is_dir() else root.parent if root is not None and root.is_file() else None
    version = version_of(folder) if folder is not None else version_of(inv.kit / rel) if found and here else None
    return {"installed": installed, "active": active, "version": version, "entry": entry, "root": root, "here": here,
            "sources": sources}


def tenantext_state(inv, cid, component):
    part = tree_part(inv, component)
    entry = part["entry"]
    pinned = version_of(inv.kit / "packages/tenantext")
    links = inv.claude_links([inv.kit / "packages/tenantext" / item for item in component["resources"]["skills"]])
    sources = part["sources"] + links["linked"]
    steps_path = inv.profile / "kit-steps.json"
    steps = read_json(steps_path)
    done = steps.get("added", []) if isinstance(steps, dict) and isinstance(steps.get("added"), list) else []
    step_pending = False
    declared = {(kind, one) for kind in PI_TYPES for one in component["resources"].get(kind, [])}
    for step, keys in KIT_STEPS.items():
        mine = {key: [item for item in items if (key, item) in declared] for key, items in keys.items()}
        if not any(mine.values()):
            continue
        if steps_path.is_file():
            sources.append(steps_path)
        if step not in done and isinstance(entry, dict):
            step_pending |= any(add_kit_items(entry, key, items) is not None for key, items in mine.items() if items)
    if part["installed"] is False:
        return state("partial" if links["linked"] else False, None, None, pinned, sources, change=True)
    on = inv.switch_on(cid, sources)
    if cid == "handoffs":
        path = inv.config_dir() / "herdr-idle-cleanup/settings.json"
        data = read_json(path)
        if isinstance(data, dict):
            sources.append(path)
            on = on and data.get("startup_assessment") != "off"
    active = part["active"] and on
    installed = "partial" if links["missing"] else part["installed"]
    # The run writes the package entry of this clone: a missing entry or another clone is a change.
    change = entry is None or not part["here"] or installed == "partial" or step_pending
    # The kit step adds a resource of the item to a filter list that predates it. The item is on after the run only
    # when the settings after the step load it for this runtime: a `!` pattern, a disabled link of higher precedence
    # or the Pi-Bolt list can keep it off. The own switches are files outside settings.json, so `on` stays.
    turns_on = bool(step_pending and not part["active"] and on
                    and tree_part(inv.after_steps([step for step in KIT_STEPS if step not in done]), component)["active"])
    return state(installed, active, part["version"], pinned, sources, change=change, turns_on=turns_on)


def npm_state(inv, cid, component):
    name, pinned = npm_parts(component["source"]["spec"])
    entry, spec_version = inv.npm_entry(name)
    folder = inv.profile / "npm/node_modules" / name
    have = version_of(folder)
    files = list(resource_files(component))
    rows = [inv.pi.find(kind, [folder / file]) for kind, file in files]
    found = [row for one in rows for row in one]
    sources = ([inv.settings_path] if entry is not None else []) + ([folder / "package.json"] if have else [])
    if cid == "mcp" and (inv.profile / "mcp-adapter.json").is_file():
        sources.append(inv.profile / "mcp-adapter.json")
    excluded = entry is not None and inv.excluded(entry)
    if entry is None:
        # Files without a package entry: Pi does not load them.
        installed, active = ("partial", False) if folder.is_dir() else (False, None)
    elif excluded:
        present = sum(1 for _, file in files if (folder / file).exists())
        installed, active = (parts(present, len(files)) if have else "partial"), False
    else:
        # As tree_part: a required file counts when Pi finds it, or when the package offers it and the filter of the
        # entry leaves it out, for example a delta entry (autoload false) that does not name it.
        offered = set()
        if folder.is_dir():
            for kind in {kind for kind, _ in files}:
                offered |= {os.path.realpath(path) for path in manifest_files(str(folder), kind)}
        present = sum(1 for (_, file), row in zip(files, rows) if row or os.path.realpath(folder / file) in offered)
        installed = True if have and present == len(files) else "partial"
        active = any(row["enabled"] for row in found)
    # The registered spec and the installed files are separate facts; the run sets both to the pin.
    change = installed is not True or have != pinned or spec_version != pinned or excluded
    return state(installed, active, have, pinned, sources, change=change)


def kit_package_state(inv, cid, component):
    """okknow, artifacts and artifacts-prompt: a package entry of the profile, a command link and Claude links."""
    rel = component["source"]["path"]
    part = tree_part(inv, component)
    pinned = version_of(inv.kit / rel)
    sources = list(part["sources"])
    moved = part["entry"] is None or not part["here"]
    if cid == "artifacts-prompt":
        installed = part["installed"]
        return state(installed, part["active"], part["version"], pinned, sources,
                     change=installed == "partial" or (installed is not False and moved))
    tool = {"okknow": ("okknow", "okknow/config.json"), "artifacts": ("artifacts", "tenant-artifacts/config.json")}[cid]
    link = inv.home / ".local/bin" / tool[0]
    link_ok = resolves_to(link, inv.kit / rel / f"skills/{tool[0]}/scripts/{tool[0]}")
    # As okknow_link_state and artifacts_link_state of install.sh: the run keeps a command of another place, for
    # example a link into another clone, so it counts as present and the run does not change it.
    kept = (link.exists() and not link_ok
            and not (link.is_symlink() and link.resolve().is_relative_to(inv.kit.resolve())))
    links = inv.claude_links([inv.kit / rel / item for item in component["resources"]["skills"]])
    sources += ([link] if link.exists() or link.is_symlink() else []) + links["linked"]
    config = inv.config_dir() / tool[1]
    if config.is_file():
        sources.append(config)
    if part["installed"] is True and (link_ok or kept) and not links["missing"]:
        installed = True
    elif part["installed"] is not False or link_ok or links["linked"]:
        installed = "partial"
    else:
        installed = False
    return state(installed, part["active"], part["version"], pinned, sources,
                 change=installed == "partial" or (installed is not False and moved))


def env_path(env, name, home):
    """The path of a file variable as the memory extensions read it (`~` is the home directory), or None."""
    text = (env.get(name) or "").strip()
    if not text:
        return None
    if text == "~" or text.startswith("~/"):
        text = os.path.join(str(home), text[2:])
    return Path(os.path.abspath(text))


def js_string(value):
    """String() of JavaScript for a JSON value that is not an array; ov_bool unwraps the arrays."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        # Only the integral numbers can give a word of OV_TRUE or OV_FALSE ("1", "0"); -0 is "0" in JavaScript.
        return str(int(value)) if isinstance(value, int) or value.is_integer() else repr(value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def js_text(value):
    """`text` of the AgentCore core: a string that is not empty after String.prototype.trim."""
    return isinstance(value, str) and value.strip(JS_SPACE) != ""


def ov_bool(value, current):
    """coerceKnobValue of OpenViking for a bool: a JSON bool or one of its words after String(), else the value
    stays.

    String([x]) of JavaScript is String(x) and String([null]) is "", so a loop (not a recursion) unwraps one-item
    arrays, at most OV_ARRAY_DEPTH levels; a JSON read gives fewer. Another array gives no word: String([]) is ""
    and the String() of two or more items holds ",".
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return current
    for _ in range(OV_ARRAY_DEPTH):
        if not (isinstance(value, list) and len(value) == 1):
            break
        value = "" if value[0] is None else value[0]
    if isinstance(value, list):
        return current
    word = js_string(value).strip(JS_SPACE).lower()
    return True if word in OV_TRUE else False if word in OV_FALSE else current


def openviking_on(inv, sources):
    """The switch `enabled` of OpenViking: false stops the extension before it registers anything.

    A port of the knob resolution of packages/openviking-pi/shared (loadCredentialFiles, loadPluginSettings,
    resolveKnobs): the `pi` section of ov.conf, then the scalars of the `plugin` section of ovcli.conf, then its
    `plugin.pi` section, then OPENVIKING_MEMORY_ENABLED. Only the key `enabled` is read; no other value of the
    files is kept. Not read: the workspace file .openviking/config.json and the registry, which the extension
    finds from the working directory of the session.
    """
    env = inv.env
    cli_env, ov_env = env_path(env, "OPENVIKING_CLI_CONFIG_FILE", inv.home), env_path(env, "OPENVIKING_CONFIG_FILE", inv.home)
    cli_path = cli_env or inv.home / ".openviking/ovcli.conf"
    ov_path = ov_env or inv.home / ".openviking/ov.conf"
    cli, ov = read_json(cli_path), read_json(ov_path)
    if ov_env is not None and cli_env is None and isinstance(ov, dict) and not isinstance(ov.get("server"), dict) and any(
            isinstance(ov.get(key), str) for key in ("url", "api_key", "account", "account_id", "user", "user_id",
                                                     "actor_peer_id")):
        # An older install named one ovcli.conf with OPENVIKING_CONFIG_FILE.
        cli, cli_path, ov = ov, ov_path, None
    value = True
    layers = []
    if isinstance(ov, dict) and isinstance(ov.get("pi"), dict):
        layers.append((ov_path, ov["pi"]))
    plugin = cli.get("plugin") if isinstance(cli, dict) and isinstance(cli.get("plugin"), dict) else {}
    shared = {key: one for key, one in plugin.items() if not isinstance(one, dict)}
    scoped = plugin.get("pi") if isinstance(plugin.get("pi"), dict) else {}
    layers.append((cli_path, {**shared, **scoped}))
    for path, data in layers:
        found = ov_bool(data.get("enabled"), None)
        if found is not None:
            value = found
            sources.append(path)
    raw = env.get("OPENVIKING_MEMORY_ENABLED")
    if raw:
        value = ov_bool(raw, value)
    return value


def js_integer(value):
    """Number.isInteger of JavaScript for a JSON value."""
    return isinstance(value, int) and not isinstance(value, bool) or isinstance(value, float) and value.is_integer()


def agentcore_id(value):
    return isinstance(value, str) and AC_ID.fullmatch(value) is not None


def agentcore_config_valid(raw):
    """True when validateConfig of packages/agentcore-memory-core accepts the JSON text `raw`.

    A port of parseConfig and validateConfig (src/index.mjs) with validateId (src/ids.mjs). The text, the values
    and the parser message are not kept or printed: the answer is one bool.
    """
    def reject(_):
        raise ValueError("constant")  # JSON.parse refuses NaN and Infinity.

    try:
        value = json.loads(raw, parse_constant=reject)
    except (ValueError, RecursionError):
        return False
    if not isinstance(value, dict) or not set(value) <= AC_FIELDS:
        return False
    config = {"topK": 10, "recallTimeoutMs": 3000, "writeTimeoutMs": 10000, **value}

    def deadline(one):
        return js_integer(one) and 1 <= one <= 600000

    def label(key, pattern):
        return key not in config or isinstance(config[key], str) and pattern.fullmatch(config[key]) is not None

    def texts(membership, key):
        one = membership.get(key)
        return key not in membership or isinstance(one, list) and all(js_text(item) for item in one)

    version, memory, region = config.get("schemaVersion"), config.get("memoryId"), config.get("region")
    if not (js_integer(version) and version == 1 and isinstance(memory, str) and AC_MEMORY_ID.fullmatch(memory)
            and isinstance(region, str) and AC_REGION.fullmatch(region) and label("profile", AC_LABEL)
            and isinstance(config.get("projects"), list)
            and js_integer(config["topK"]) and 1 <= config["topK"] <= 100
            and deadline(config["recallTimeoutMs"]) and deadline(config["writeTimeoutMs"])
            and ("ledgerPath" not in config or js_text(config["ledgerPath"])) and label("hostLabel", AC_LABEL)
            and agentcore_id(config.get("actorId"))):
        return False
    seen = set()
    for membership in config["projects"]:
        if not (isinstance(membership, dict) and set(membership) <= AC_MEMBERSHIP_FIELDS
                and isinstance(membership.get("role"), str) and membership["role"] in AC_ROLES
                and texts(membership, "remotes") and texts(membership, "directories")
                and agentcore_id(membership.get("projectId")) and membership["projectId"] not in seen):
            return False
        seen.add(membership["projectId"])
    return True


def agentcore_on(inv, sources):
    """loadConfig of packages/agentcore-memory-core: AGENTCORE_MEMORY_DISABLE=1, no config, or a config that the
    core rejects registers nothing (registerAgentCore of packages/agentcore-pi/runtime.mjs).

    The config comes from AGENTCORE_MEMORY_CONFIG, else the file AGENTCORE_MEMORY_CONFIG_FILE, else
    <XDG_CONFIG_HOME or ~/.config>/agentcore-memory/config.json. The chosen config is checked with
    agentcore_config_valid; a lower source does not replace a chosen config that is not valid.
    """
    env = inv.env
    if env.get("AGENTCORE_MEMORY_DISABLE") == "1":
        return False
    inline = env.get("AGENTCORE_MEMORY_CONFIG")
    if js_text(inline):
        return agentcore_config_valid(inline)
    named = env.get("AGENTCORE_MEMORY_CONFIG_FILE")
    named = named if js_text(named) else ""
    if named and not os.path.isabs(named):
        # The core reads a relative path from the working directory of the session; this script cannot read it.
        return True
    base = env.get("XDG_CONFIG_HOME") or ""
    path = Path(named) if named else (Path(base) if js_text(base) and os.path.isabs(base) else inv.home / ".config") \
        / "agentcore-memory/config.json"
    # A named file that cannot be read makes the core throw; a missing default file is no config.
    if not path.is_file():
        return False
    try:
        # readFileSync(path, "utf8") of Node: the bytes as UTF-8 with replacement, a byte order mark kept.
        raw = path.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return False
    sources.append(path)
    return agentcore_config_valid(raw)


def manual_state(inv, cid, component):
    """openviking and agentcore: a package entry that the user adds; a file entry loads as one extension.

    Active also needs the own switch of the extension: openviking_on and agentcore_on. The extension reads the
    environment of Pi; this script reads its own environment, which a launcher started from the same shell passes on.
    """
    rel = component["source"]["path"]
    part = tree_part(inv, component)
    pinned = version_of(inv.kit / rel)
    root = part["root"]
    sources = list(part["sources"])
    if part["installed"] is False or root is None:
        return state(part["installed"], part["active"], part["version"], pinned, sources)
    on = (openviking_on if cid == "openviking" else agentcore_on)(inv, sources)
    package = root.parent if root.is_file() else root
    deps = package / "node_modules" if cid == "openviking" else package.parent / "agentcore-memory-core/node_modules"
    installed = part["installed"] if deps.is_dir() else "partial"
    return state(installed, part["active"] and on, part["version"], pinned, sources)


def walkr_files(kit, home, names):
    """({name: text of the skill file}, {name: text of the prompt file}) that the Walkr setup writes now.

    The texts follow installSkills of packages/walkr/src/setup.js: the same placeholders in the same order.
    """
    repository = (kit / "packages/walkr").resolve()
    quote = lambda path: "'" + str(path).replace("'", "'\\''") + "'"  # noqa: E731 (posixQuote of setup.js)
    skills, prompts = {}, {}
    for name in names:
        text = read_text(repository / "skills" / name / "SKILL.md")
        if text is not None:
            for placeholder, file in WALKR_COMMANDS:
                text = text.replace(placeholder, "node " + quote(repository / "src" / file))
            skills[name] = text.replace("{{REPOSITORY}}", str(repository))
        template = read_text(repository / "prompts" / f"{name}.md")
        if template is not None:
            skill_file = os.path.join(os.path.abspath(str(home)), ".agents", "skills", name, "SKILL.md")
            prompts[name] = template.replace("{{SKILL_FILE}}", json.dumps(skill_file, ensure_ascii=False))
    return skills, prompts


def walkr_state(inv, cid, component):
    src = inv.kit / component["source"]["path"] / "src"
    names = [Path(item).name for item in inv.components["walkr"]["resources"]["skills"]]
    pinned = version_of(inv.kit / component["source"]["path"])
    skills, prompts = walkr_files(inv.kit, inv.home, names)
    if cid == "walkr":
        links = [inv.home / ".local/bin" / command for command, file in WALKR_LINKS if
                 resolves_to(inv.home / ".local/bin" / command, src / file)]
        present, stale, receipts = [], False, []
        for root in WALKR_ROOTS:
            receipt = read_json(inv.home / root / ".walkr-setup.json")
            files = receipt.get("files") if isinstance(receipt, dict) and receipt.get("version") == 1 else None
            if isinstance(files, dict):
                receipts.append(inv.home / root / ".walkr-setup.json")
            for name in names:
                path = inv.home / root / "skills" / name / "SKILL.md"
                text = read_text(path)
                if text is None:
                    continue
                present.append(path)
                # A file that the setup did not record, or a text for another clone, is stale.
                stale |= text != skills.get(name) or not isinstance(files, dict) or f"skills/{name}/SKILL.md" not in files
        deps = all((inv.kit / component["source"]["path"] / "node_modules" / one / "package.json").is_file()
                   for one in WALKR_DEPENDENCIES)
        installed = parts(len(links) + len(present), len(WALKR_LINKS) + len(names) * len(WALKR_ROOTS))
        if installed is True and not deps:
            installed = "partial"
        rows = [row for name in names for row in inv.pi.find("skills", [inv.home / ".agents/skills" / name / "SKILL.md"])]
        active = any(row["enabled"] for row in rows) if rows else (False if installed is not False else None)
        version = version_of(links[0].resolve().parent.parent) if links else None
        return state(installed, active, version, pinned, links + present + receipts,
                     change=installed == "partial" or stale)
    folder = inv.profile / "prompts"
    files = [folder / f"{name}.md" for name in names if (folder / f"{name}.md").is_file()]
    stale = any(read_text(path) != prompts.get(path.stem) for path in files)
    installed = parts(len(files), len(names))
    rows = [row for path in files for row in inv.pi.find("prompts", [path])]
    active = any(row["enabled"] for row in rows) if files else None
    record = inv.profile / ".walkr-setup.json"
    return state(installed, active, None, None, files + ([record] if record.is_file() else []),
                 change=installed == "partial" or stale)


def aws_state(inv, cid, component):
    """An AWS row: the skills entries of the kit clone in settings.json and, for aws-core, the kit entry aws-mcp.

    Installed: each skills entry of the row is present and Pi finds skills below it (with aws-core, the kit entry
    aws-mcp counts as a part when one MCP file of the profile holds it as kit-aws.json records it). A skills entry of the user for the same
    folders of another clone counts as present; the run keeps it unless --adopt-aws. `owned` is true when the
    kit wrote a part: a run that leaves the row out removes those parts.

    Links to the skill folders of the row in the hermes project stores of the profile (kit_aws.project_links) register
    the row too: it is installed and on, also with no skills entry. Pi loads those skills only in the linked projects.
    A row that the last run turned off (`chosen` of kit-aws.json, kit_aws.record_choice) is not registered by them.
    """
    url, commit = component["source"]["url"], component["source"]["commit"]
    clone = kit_aws.clone_dir(inv.home, url)
    head = kit_aws.head_of(clone)
    entries = strings(inv.settings.get("skills")) or []
    wanted = kit_aws.expected_skills(clone, component)
    present = [one for one in wanted if one in entries]
    theirs = kit_aws.user_skills(entries, clone, component)
    folders = [posix(one) for one in (present or theirs)]
    rows = [row for row in inv.pi.rows if row["kind"] == "skills" and any(
        row["posix"].startswith(folder.rstrip("/") + "/") for folder in folders)]
    linked = kit_aws.project_links(inv.profile, kit_aws.skill_folders(clone, component))
    try:
        # The kit leaves the links in place: after a run that turned the row off, they do not register it.
        if kit_aws.chosen_rows(inv.profile).get(cid) is False:
            linked = {}
    except kit_aws.Refusal:
        pass
    registered = bool(present or theirs or linked)
    sources = [inv.settings_path] if present or theirs else []
    sources += [inv.profile / "projects-memory" / project / "skills" for project in sorted(linked)]
    # A skills entry counts when Pi finds skills below it; the entries of the user count as all of them, and so do
    # the project links.
    found = len(wanted) if linked else (len(wanted) if theirs or present == wanted else len(present)) if rows else 0
    total = len(wanted)
    mcp_kit, mcp_change = False, False
    if cid == "aws-core":
        try:
            record = kit_aws.recorded_mcp(inv.profile)
        except kit_aws.Refusal:
            record = {}
        for target, path in kit_aws.mcp_files(inv.profile).items():
            data = read_json(path)
            entry = data.get("mcpServers", {}).get(kit_aws.SERVER) if isinstance(data, dict) and isinstance(
                data.get("mcpServers"), dict) else None
            if kit_aws.mcp_owned(record, path, entry):
                mcp_kit = True
                sources.append(path)
                try:
                    mcp_change |= entry != kit_aws.kit_entry(clone, target == "mcp-codemode")
                except kit_aws.Refusal:
                    mcp_change = True
        found, total = found + mcp_kit, total + mcp_kit
    if not registered and not mcp_kit:
        return {**state(False, None, None, commit[:7], sources), "owned": False}
    installed = parts(found, total) or "partial"
    active = bool(linked) or any(row["enabled"] for row in rows)
    version = head[:7] if (present or linked) and head else None
    change = (bool(present) and (head != commit or present != wanted)) or (bool(linked) and head != commit) or (
        mcp_change) or (bool(theirs) and inv.adopt)
    return {**state(installed, active, version, commit[:7], sources, change=change),
            "owned": bool(present) or mcp_kit}


def aws_claude_state(inv, modules):
    """The Claude Code parts of the AWS rows that the kit record names: the plugins of the kit marketplace (the
    folder of the kit clone) and the skill link of aws-emulator."""
    rows = kit_aws.components(inv.manifest)
    url, commit = kit_aws.source(rows)
    clone = kit_aws.clone_dir(inv.home, url)
    name = kit_aws.marketplace_name(clone)
    record_path = kit_aws.claude_record_path(inv.home)
    record = kit_aws.read_claude_record(inv.home)
    owned = record.get("plugins") if isinstance(record.get("plugins"), dict) else {}
    records = inv.claude / "plugins/installed_plugins.json"
    markets = inv.claude / "plugins/known_marketplaces.json"
    ours = kit_aws.known_marketplace(inv.home, name) == str(clone)
    shas = kit_aws.installed_shas(inv.home) if ours else {}
    ids = {cid: f"{kit_aws.plugin_of(one)}@{name}" for cid, one in rows.items() if kit_aws.plugin_of(one)}
    present = [plugin for plugin in ids.values() if plugin in shas and plugin in owned]
    link, target = kit_aws.emulator_link(inv.home, clone)
    linked = record.get("link") == {"path": str(link), "target": str(target)} and link.is_symlink() and (
        os.readlink(link) == str(target))
    claude_settings = read_json(inv.claude / "settings.json")
    enabled = claude_settings.get("enabledPlugins") if isinstance(claude_settings, dict) else None
    enabled = enabled if isinstance(enabled, dict) else {}
    sources = [markets] if ours else []
    sources += [records] if present else []
    sources += [record_path, link] if linked else []
    wanted = [ids[cid] for cid in modules if cid in ids]
    want_link = "aws-emulator" in modules and "aws-core" not in modules
    change = any(shas[plugin] != commit for plugin in present) or any(plugin not in present for plugin in wanted) or any(
        plugin not in wanted for plugin in present) or want_link != linked
    installed = True if present or linked else "partial" if ours else False
    version = next((str(shas[plugin])[:7] for plugin in present if shas[plugin]), None)
    active = any(enabled.get(plugin) is True for plugin in present) or linked if present or linked else None
    return state(installed, active, version, commit[:7], sources, change=change)


def resolve_tools(entries):
    """getDefaultTools of Pi 1.5.2: plain names replace the default tools, then `+name` adds and `-name` removes a
    tool, in the order of the list. No key gives the default tools; a value that is not a list gives none."""
    if entries is None:
        return list(DEFAULT_TOOLS)
    entries = [one for one in entries if isinstance(one, str)] if isinstance(entries, list) else []
    modifier = lambda one: one.startswith(("+", "-"))  # noqa: E731
    plain = [one for one in entries if not modifier(one)]
    tools = list(plain if plain or not entries else DEFAULT_TOOLS)
    for one in filter(modifier, entries):
        name = one[1:]
        if one.startswith("+") and name and name not in tools:
            tools.append(name)
        elif one.startswith("-") and name in tools:
            tools.remove(name)
    return tools


def codemode_of(tools, extensions, config, profile):
    """(installed, active) of the combined item for one defaultTools value, one extensions list and mcp.json.

    The order of Pi: the resolved defaultTools, then the automatic activation of the MCP extension (an enabled
    server with codemode exposure, unless autoEnableCodemode is false), then the builtin switches.
    """
    builtins = {name: overrides_enable(BUILTIN + name, extensions, profile) for name in ("mcp", "codemode")}
    servers = config.get("mcpServers") if isinstance(config, dict) and isinstance(config.get("mcpServers"), dict) else {}

    def codemode_server(entry):
        # An enabled server with `codemode` exposure; `codemode` is the default (dist/extensions/mcp/index.js).
        if not isinstance(entry, dict) or entry.get("enabled") is False:
            return False
        if not isinstance(entry.get("command"), str) and not isinstance(entry.get("url"), str):
            return False
        exposure = entry.get("exposure", "codemode")
        more = entry.get("toolExposure") if isinstance(entry.get("toolExposure"), dict) else {}
        return exposure == "codemode" or "codemode" in more.values()
    named = "codemode" in resolve_tools(tools)
    automatic = (builtins["mcp"] and isinstance(config, dict) and config.get("autoEnableCodemode") is not False
                 and any(codemode_server(entry) for entry in servers.values()))
    installed = named or automatic
    # The combined item needs both builtins: -builtin:mcp stops the MCP client, -builtin:codemode the tool.
    return installed, (builtins["mcp"] and builtins["codemode"]) if installed else None


def codemode_state(inv):
    """The MCP client of Pi with codemode: the codemode tool of defaultTools, or one that Pi turns on by itself.

    The plan compares the state now with the state after the mcp-codemode step of install.sh. That step adds
    `+codemode` (or `codemode` to a list of plain names) only when the list has no `+codemode` and no `codemode`
    entry, so a later `-codemode` stays, and the item stays off.
    """
    tools = inv.settings.get("defaultTools")
    extensions = strings(inv.settings.get("extensions")) or []
    native = inv.profile / "mcp.json"
    config = read_json(native)
    installed, active = codemode_of(tools, extensions, config, str(inv.profile))
    after_extensions = [entry for entry in extensions if entry not in ("-builtin:mcp", "-builtin:codemode")]
    after_tools = tools
    if tools is None:
        after_tools = ["+codemode"]
    elif isinstance(tools, list) and not {"+codemode", "codemode"} & {one for one in tools if isinstance(one, str)}:
        additive = tools and all(isinstance(one, str) and one[:1] in ("+", "-") for one in tools)
        after_tools = tools + ["+codemode" if additive else "codemode"]
    after = codemode_of(after_tools, after_extensions, config, str(inv.profile))
    adapter = inv.npm_entry(npm_parts(inv.components["mcp"]["source"]["spec"])[0])[0] is not None
    sources = ([inv.settings_path] if tools is not None or extensions else []) + ([native] if native.is_file() else [])
    return state(installed, active, sources=sources,
                 change=after_tools != tools or after_extensions != extensions or adapter, installs=after[1] is True)


def plugin_state(inv):
    record_path = inv.claude / "plugins/installed_plugins.json"
    records = read_json(record_path)
    entries = records.get("plugins", {}).get(PLUGIN) if isinstance(records, dict) and isinstance(records.get("plugins"), dict) else None
    entry = entries[0] if isinstance(entries, list) and entries and isinstance(entries[0], dict) else None
    settings_path = inv.claude / "settings.json"
    claude_settings = read_json(settings_path)
    enabled = claude_settings.get("enabledPlugins", {}).get(PLUGIN) if isinstance(claude_settings, dict) and isinstance(
        claude_settings.get("enabledPlugins"), dict) else None
    pinned = npm_parts(inv.components["computer-use"]["source"]["spec"])[1]
    version = entry.get("version") if entry and isinstance(entry.get("version"), str) else None
    sources = ([record_path] if entry else []) + ([settings_path] if isinstance(enabled, bool) else [])
    return state(entry is not None, enabled if isinstance(enabled, bool) else None, version, pinned, sources)


def dummies_state(inv):
    path = inv.config_dir() / "dummies-skill/state.json"
    data = None if path.is_symlink() else read_json(path)
    on = isinstance(data, dict) and data.get("pi") == "on"
    blocks = [inv.profile / name for name in PI_CONTEXT_FILES
              if has_lines(inv.profile / name, DUMMIES_BEGIN, DUMMIES_END)]
    sources = ([path] if isinstance(data, dict) else []) + blocks
    # The switch is shared by all profiles; without the autostart block of this profile no session reads it.
    return state(bool(blocks), bool(blocks) and on, sources=sources, change=not (blocks and on))


def startup_files(inv):
    zdotdir = inv.env.get("ZDOTDIR") or ""
    return {"bash": inv.home / ".bashrc", "zsh": (Path(zdotdir) if os.path.isabs(zdotdir) else inv.home) / ".zshrc"}


def shell_state(inv, shell):
    """The managed block of install.sh: the markers and the one alias line for the launcher of this profile."""
    start, end = f"# >>> tenant-pi {inv.name} >>>", f"# <<< tenant-pi {inv.name} <<<"
    expected = ["alias " + inv.name + "=" + shlex.quote(shlex.quote(str(inv.home / ".local/bin" / inv.name)))]
    files = startup_files(inv)
    blocks = {key: managed_block(path, start, end) for key, path in files.items()}
    present = {key: files[key] for key, inner in blocks.items() if inner is not None}
    return state(bool(present), None, sources=present.values(),
                 change=shell in files and blocks.get(shell) != expected)


def launcher_state(inv, runtime):
    """The launcher works when its file and its runtime are executable and it binds this profile.

    The run rewrites it when a line that install.sh writes for this profile and runtime is missing.
    """
    path, marked, recorded, text = inv.launcher()
    if not marked:
        return state(False)
    lines = set(text.splitlines())
    bound = "export PI_CODING_AGENT_DIR=" + shlex.quote(str(inv.profile)) in lines
    works = (os.access(path, os.X_OK) and bound and recorded is not None and os.path.isfile(recorded)
             and os.access(recorded, os.X_OK))
    expected = ["unset PI_CODING_AGENT_SESSION_DIR"]
    if runtime is not None:
        credsync = shlex.quote(str(inv.kit / "packages/tenantext/skills/herdr/scripts/credsync-launch.sh"))
        expected += ["export PATH=" + shlex.quote(str(runtime.parent)) + ':"$PATH"',
                     "  exec /bin/sh " + credsync + " " + shlex.quote(str(runtime)) + ' "$@"',
                     "exec " + shlex.quote(str(runtime)) + ' "$@"']
    return state(True, works, sources=[path], change=not works or any(line not in lines for line in expected))


# ---------------------------------------------------------------------------
# Runtime versions, the selection and the plan.
# ---------------------------------------------------------------------------

def runtime_path(choice, explicit):
    """The runtime file of the run, as install.sh finds it: `pi` and `pi-bolt` on PATH, else an absolute path.

    An explicit choice that does not work is a refusal with the words of install.sh. A choice from the launcher
    that does not work gives None: the runtime is missing.
    """
    if choice in ("pi", "pi-bolt"):
        found = shutil.which(choice)
        if not found:
            if explicit:
                raise Refusal(f"{choice} is not installed; install it separately")
            return None
        path = Path(os.path.abspath(found))
    elif os.path.isabs(choice):
        path = Path(choice)
    else:
        raise Refusal("runtime must be pi, pi-bolt or an absolute path")
    if not path.is_file() or not os.access(path, os.X_OK):
        if explicit:
            raise Refusal(f"runtime must be an executable file: {path}")
        return None
    # As install.sh: the Pi-Bolt installer links pi-bolt to a release file named pi, and the launcher starts that file.
    if (choice == "pi-bolt" or path.name == "pi-bolt") and path.resolve().name == "pi":
        path = path.resolve()
    return path


def run_time(inv, runtime):
    """R for Pi (the runtime of the run), Pi-Bolt, Node and Python, and True when the runtime is Pi-Bolt."""
    pins = inv.manifest["runtime"]
    try:
        if runtime is not None:
            report = check_runtime.check(pins, {"pi": str(runtime)})
        else:
            # No runtime file: Pi is missing for this run, also when another pi is on PATH.
            report = check_runtime.check(pins, None, which=lambda command: None if command == "pi" else shutil.which(command))
    except Invalid as error:
        raise Refusal(f"runtime probe: {error}") from None
    result = {"pi": report["pi"], "pi_bolt": {"installed": None, "required": pins.get("piBoltVersion"), "status": "missing"},
              "node": report["node"], "python": report["python"]}
    bolt = report["pi"].get("piBolt")
    selected = bolt is not None
    if bolt is None:
        path = shutil.which("pi-bolt")
        if path:
            try:
                found = check_runtime._probe_pi(os.path.abspath(path), os.environ, subprocess.run)
            except Invalid:
                found = "unparsed"
            if isinstance(found, str):
                result["pi_bolt"]["status"] = found
            elif found[1] is None:
                result["pi_bolt"]["status"] = "unparsed"
            else:
                bolt = {"installed": found[1]}
    if bolt is not None:
        result["pi_bolt"].update(installed=bolt["installed"],
                                 status="match" if bolt["installed"] == pins.get("piBoltVersion") else "mismatch")
    return {key: {field: value.get(field) for field in ("installed", "required", "status")}
            for key, value in result.items()}, selected


def modules_of(text, rows=None):
    """The module names of a --with value, as install.sh reads it. install.sh checks the platform itself."""
    desktop = "computer-use-macos" if platform.system() == "Darwin" else "computer-use"
    names = [one for one in text.split(",")]
    if names == ["all"]:
        return ["wiki", "hermes", "mcp", desktop, "okknow", "artifacts", "walkr"]
    if "all" in names:
        raise Refusal("all stands alone")
    if names == ["none"]:
        return []
    unknown = [one for one in names if one not in MODULES]
    if unknown:
        raise Refusal("unknown optional module: " + ", ".join(unknown))
    if "mcp" in names and "mcp-codemode" in names:
        raise Refusal("choose one of mcp and mcp-codemode")
    if rows:
        try:
            kit_aws.check(rows, [one for one in names if one in rows])
        except kit_aws.Refusal as error:
            raise Refusal(str(error)) from None
    return names


def plan_of(found, selected, removed):
    """What the run does to the item. The plan repairs and updates parts and leaves each own switch as it is, so an
    upgrade can have active false. The plan is not the selection: the TUI starts each selection from `active`."""
    installed, active = found["installed"], found["active"]
    if removed and installed is not False:
        return "remove"
    if selected and installed is False:
        return "install" if found["installs"] else "skip"
    if selected and found["turns_on"]:
        return "install"
    if selected and (found["change"] or installed == "partial"):
        return "upgrade"
    if installed is False or active is False:
        # Absent, or present with its switch off: the run leaves it that way.
        return "skip"
    return "keep"


def inventory(kit, profile, home, name, env, modules=None, shell=None, dummies=False, plugin=False, runtime=None,
              claude_aws=False, adopt=False):
    inv = Inventory(kit, profile, home, name, env, adopt)
    _, marked, _, text = inv.launcher()
    # The runtime: --runtime, else the choice that the launcher records (install.sh reads it for an upgrade), else pi.
    recorded = next((line[len(LAUNCHER_RUNTIME):] for line in text.splitlines() if line.startswith(LAUNCHER_RUNTIME)),
                    None) if marked else None
    run_path = runtime_path(runtime if runtime is not None else recorded or "pi", runtime is not None)
    times, pi_bolt = run_time(inv, run_path)
    inv.resolve(pi_bolt)
    states = {}
    for item in inv.catalog["items"]:
        cid = item["name"]
        component = inv.components.get(cid)
        if cid == "core":
            found = times["pi"]["status"] != "missing"
            states[cid] = state(found, True if found else None, times["pi"]["installed"], inv.manifest["runtime"]["piVersion"],
                                [run_path] if found and run_path else [])
        elif cid == "model-routing":
            found = times["pi"]["status"] != "missing"
            chosen = bool(inv.settings.get("defaultModel") or inv.settings.get("defaultProvider"))
            states[cid] = state(found, chosen if found else None, sources=[inv.settings_path] if chosen else [])
        elif component and component["source"] == {"kind": "tree", "path": "packages/tenantext"}:
            states[cid] = tenantext_state(inv, cid, component)
        elif component and component["source"]["kind"] == "npm":
            states[cid] = npm_state(inv, cid, component)
        elif component and component["source"]["kind"] == "git":
            states[cid] = aws_state(inv, cid, component)
        elif cid == "claude-aws-plugins":
            states[cid] = None
        elif cid in ("okknow", "artifacts", "artifacts-prompt"):
            states[cid] = kit_package_state(inv, cid, component)
        elif cid in MANUAL:
            states[cid] = manual_state(inv, cid, component)
        elif cid in ("walkr", "walkr-prompts"):
            states[cid] = walkr_state(inv, cid, component)
        elif cid == "mcp-codemode":
            states[cid] = codemode_state(inv)
        elif cid == "walkr-proxy":
            # A guide row: install.sh prints the hosted-mode guide and writes nothing, so the row is never installed.
            states[cid] = state(False, installs=False)
        elif cid == "claude-code-plugin":
            states[cid] = plugin_state(inv)
        elif cid == "dummies":
            states[cid] = dummies_state(inv)
        elif cid == "shell-rc":
            states[cid] = shell_state(inv, shell)
        elif cid == "launcher":
            states[cid] = launcher_state(inv, run_path)
        else:
            raise Refusal(f"no state rule for the catalog item {cid}")
    explicit = modules is not None
    if modules is None:
        # Without --with: an upgrade that keeps the optional modules of the profile.
        modules = [one for one in MODULES if one != "questions" and states[one]["installed"] is not False]
        if "mcp" in modules and "mcp-codemode" in modules:
            modules.remove("mcp-codemode")
    # The Claude Code AWS plugins follow the AWS rows of the run.
    states["claude-aws-plugins"] = aws_claude_state(inv, modules)
    # The aws-mcp entry that the run of these modules writes (the rule of kit_aws.mcp_plan) is a change of aws-core.
    core = inv.components.get("aws-core")
    if core and "aws-core" in modules and states["aws-core"]["installed"] is not False:
        try:
            steps = kit_aws.mcp_plan(inv.profile, kit_aws.clone_dir(inv.home, core["source"]["url"]), modules,
                                     inv.adopt, core["source"]["commit"])
        except (kit_aws.Refusal, OSError):
            steps = []
        states["aws-core"]["change"] |= any(action == "write" for _, action, _, _ in steps)
    selected = {"core", "model-routing", "questions"}
    selected |= {cid for cid, component in inv.components.items()
                 if component["source"] == {"kind": "tree", "path": "packages/tenantext"}}
    for module in modules:
        selected.update(MODULE_ITEMS.get(module, (module,)))
    if dummies:
        selected.add("dummies")
    if plugin and "computer-use" in modules and inv.claude.is_dir() and shutil.which("claude"):
        selected.add("claude-code-plugin")
    aws_rows = [cid for cid, one in inv.components.items() if one["source"]["kind"] == "git"]
    claude_aws = claude_aws and inv.claude.is_dir() and shutil.which("claude") is not None
    if claude_aws and any(one in modules for one in aws_rows):
        selected.add("claude-aws-plugins")
    if shell in ("bash", "zsh"):
        selected |= {"shell-rc", "launcher"}
    removed = {"mcp"} if "mcp-codemode" in modules else set()
    # An AWS row that the kit installed and that an explicit selection leaves out: the run removes its kit parts.
    removed |= {cid for cid in aws_rows if explicit and cid not in modules and states[cid].get("owned")}
    if claude_aws and not any(one in modules for one in aws_rows):
        removed.add("claude-aws-plugins")
    items = []
    for item in inv.catalog["items"]:
        cid = item["name"]
        found = states[cid]
        plan = plan_of(found, cid in selected and cid not in ("core", "model-routing"), cid in removed)
        items.append({"name": cid, "group": item["group"], "installed": found["installed"], "active": found["active"],
                      "version_installed": found["version_installed"], "version_pinned": found["version_pinned"],
                      "state_source": found["state_source"], "plan": plan})
    return {"profile": str(profile), "runtime": times, "items": items}, inv.catalog, inv.components


# ---------------------------------------------------------------------------
# The boxed table.
# ---------------------------------------------------------------------------

UNICODE = {"box": "╭╮╰╯│─├┤┌┐└┘", "yes": "●", "partial": "◐", "no": "○", "none": "–", "ellipsis": "…", "arrow": "→",
           "plan": {"install": "+", "upgrade": "↑", "keep": "=", "remove": "−", "skip": "·"},
           "status": {"match": "✓", "untested_in_range": "~", "mismatch": "✗", "missing": "–", "unparsed": "?"}}
ASCII = {"box": "++++|-++++++", "yes": "Y", "partial": "P", "no": "N", "none": "-", "ellipsis": "...", "arrow": ">",
         "plan": {"install": "+", "upgrade": "^", "keep": "=", "remove": "-", "skip": "."},
         "status": {"match": "ok", "untested_in_range": "~", "mismatch": "x", "missing": "-", "unparsed": "?"}}
COLORS = {"green": "32", "yellow": "33", "red": "31", "dim": "2", "bold": "1"}
TONE = {True: "green", "partial": "yellow", False: "dim", None: "dim",
        "install": "green", "upgrade": "yellow", "keep": "dim", "remove": "red", "skip": "dim",
        "match": "green", "untested_in_range": "yellow", "mismatch": "red", "missing": "dim", "unparsed": "yellow"}
# Fixed column widths of a section row; the About column takes the rest of the line.
COLUMNS = (("Inst", 4), ("Act", 3), ("Version", 13), ("Plan", 9))


class Table:
    """Boxed lines of a fixed width. Each glyph and character of the text is one column wide."""

    def __init__(self, width, color, glyphs):
        self.width, self.inner, self.color, self.g = width, width - 4, color, glyphs

    def paint(self, text, tone):
        return f"\x1b[{COLORS[tone]}m{text}\x1b[0m" if self.color and tone and text.strip() else text

    def cut(self, text, width):
        if len(text) <= width:
            return text.ljust(width)
        return (text[:max(0, width - len(self.g["ellipsis"]))] + self.g["ellipsis"])[:width]

    def top(self, title, rounded=True):
        b = self.g["box"]
        left, right = (b[0], b[1]) if rounded else (b[8], b[9])
        fill = b[5] * max(0, self.width - 5 - len(title))
        return self.paint(left + b[5], "dim") + " " + self.paint(title, "bold") + " " + self.paint(fill + right, "dim")

    def bottom(self, rounded=True):
        b = self.g["box"]
        left, right = (b[2], b[3]) if rounded else (b[10], b[11])
        return self.paint(left + b[5] * (self.width - 2) + right, "dim")

    def rule(self):
        b = self.g["box"]
        return self.paint(b[6] + b[5] * (self.width - 2) + b[7], "dim")

    def line(self, segments):
        """One boxed line from (text, tone) segments. A line that is too long loses its colors and is cut."""
        plain = "".join(text for text, _ in segments)
        if len(plain) > self.inner:
            plain = self.cut(plain, self.inner)
            segments = [(plain, segments[0][1])]
        bar = self.paint(self.g["box"][4], "dim")
        return f"{bar} " + "".join(self.paint(text, tone) for text, tone in segments) + " " * (self.inner - len(plain)) + f" {bar}"

    def cells(self, cells):
        """One boxed line from (text, width, tone) cells with one space between them; the last cell takes the rest."""
        segments, used = [], 0
        for index, (text, width, tone) in enumerate(cells):
            last = index == len(cells) - 1
            width = max(0, self.inner - used - (0 if last else 1)) if last else min(width, max(0, self.inner - used))
            segments.append((self.cut(text, width), tone))
            if not last:
                segments.append((" ", None))
            used += width + (0 if last else 1)
        return self.line(segments)


def short_path(path, home):
    text, base = str(path), str(home)
    return "~" + text[len(base):] if base not in ("", "/") and (text == base or text.startswith(base + "/")) else text


def mark(glyphs, value):
    return glyphs["yes"] if value is True else glyphs["partial"] if value == "partial" else glyphs["no"] if value is False \
        else glyphs["none"]


def version_cell(item, tree, arrow):
    """The version of a row: the installed version, `old→pin` on a difference, `→pin` for an install, else empty."""
    have, pin = item["version_installed"], item["version_pinned"]
    if have and pin and have != pin:
        return f"{have}{arrow}{pin}"
    if tree:
        # A tree package is this clone: its version is the version of the clone.
        return ""
    if have:
        return have
    return f"{arrow}{pin}" if pin and item["plan"] in ("install", "upgrade") else ""


def wrap(words, width):
    lines, line = [], ""
    for word in words:
        # A full line ends with a comma, so it holds one column less.
        if line and len(line) + 2 + len(word) > width - 1:
            lines.append(line + ",")
            line = word
        else:
            line = f"{line}, {word}" if line else word
    return lines + ([line] if line else [])


def render(data, catalog, components, home, width, color, glyphs):
    """The boxed table: a runtime box, one box for each catalog group, the plan box and a legend."""
    table, g = Table(width, color, glyphs), glyphs
    out = [table.top("tenant-pi inventory")]
    new = "" if Path(data["profile"]).is_dir() else "  (new profile)"
    out.append(table.line([("Profile  " + short_path(data["profile"], home) + new, None)]))
    segments = [("Runtime", None)]
    for key, label in (("pi", "pi"), ("node", "node"), ("python", "python"), ("pi_bolt", "pi-bolt")):
        found = data["runtime"][key]
        segments += [(f"  {label} {found['installed'] or ''}".rstrip() + " ", None),
                     (g["status"][found["status"]], TONE[found["status"]])]
    out += [table.line(segments), table.bottom()]
    name_width = max(len(item["name"]) for item in data["items"])
    header = [("Name", name_width, "bold"), *((title, size, "bold") for title, size in COLUMNS), ("About", 0, "bold")]
    # The About column shows what the item does: the start of its description.
    about = {item["name"]: item.get("description", "") for item in catalog["items"]}
    for group in catalog["groups"]:
        rows = [item for item in data["items"] if item["group"] == group["id"]]
        if not rows:
            continue
        out += [table.top(group["title"], rounded=False), table.cells(header), table.rule()]
        for item in rows:
            tree = (components.get(item["name"]) or {}).get("source", {}).get("kind") == "tree"
            plan = item["plan"]
            out.append(table.cells([
                (item["name"], name_width, None),
                ("  " + mark(g, item["installed"]), 4, TONE[item["installed"]]),
                (" " + mark(g, item["active"]), 3, TONE[item["active"]]),
                (version_cell(item, tree, g["arrow"]), 13, None),
                (f"{g['plan'][plan]} {plan}", 9, TONE[plan]),
                (about.get(item["name"], ""), 0, "dim"),
            ]))
        out.append(table.bottom(rounded=False))
    out.append(table.top("Plan"))
    for plan in PLANS:
        found = [item for item in data["items"] if item["plan"] == plan]
        if not found and plan not in ("install", "upgrade"):
            continue
        names = [item["name"] + (f" {item['version_installed']}{g['arrow']}{item['version_pinned']}"
                                 if plan == "upgrade" and item["version_installed"] and item["version_pinned"]
                                 and item["version_installed"] != item["version_pinned"] else "")
                 for item in found] if plan in ("install", "upgrade", "remove") else []
        label = f"{g['plan'][plan]} {plan}".ljust(10) + f"{len(found):>3}  "
        for index, text in enumerate(wrap(names, table.inner - len(label)) or [""]):
            out.append(table.line([(label if index == 0 else " " * len(label), TONE[plan]), (text, None)]))
    if data["runtime"]["pi"]["status"] == "missing":
        out.append(table.line([("Pi is not found. Install it at the pin first; see INSTALL.md.", "red")]))
    out.append(table.bottom())
    out.append(table.paint(f"{g['yes']} yes  {g['partial']} partial  {g['no']} no  {g['none']} not applicable", "dim"))
    out.append(table.paint("About: the start of each description. config/catalog.json has the full text and the "
                           "effects of on and off.", "dim"))
    return "\n".join(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--kit", default=str(ROOT), help="the kit clone (default: the clone of this script)")
    parser.add_argument("--profile", required=True, help="the absolute profile directory; it can be absent")
    parser.add_argument("--name", help="the profile name of the launcher and the alias (default: the directory name)")
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--json", action="store_true", help="print JSON (the default)")
    output.add_argument("--plain", action="store_true", help="print a boxed table")
    parser.add_argument("--with", dest="modules", help="the optional modules of the run, as install.sh --with")
    parser.add_argument("--shell", choices=("bash", "zsh", "none"), help="the shell choice of the run")
    parser.add_argument("--dummies", action="store_true", help="the run turns DUMMIES on")
    parser.add_argument("--claude-plugin", action="store_true", help="the run installs the Claude Code plugin")
    parser.add_argument("--claude-aws", action="store_true", help="the run installs the Claude Code AWS plugins")
    parser.add_argument("--adopt-aws", action="store_true", help="the run moves an AWS entry of the user to the kit pin")
    parser.add_argument("--runtime", help="the runtime of the run: pi, pi-bolt or an absolute path, as install.sh --runtime")
    args = parser.parse_args(argv)
    try:
        home = os.environ.get("HOME", "")
        if not os.path.isabs(home):
            raise Refusal("HOME must be set to an absolute path")
        if not os.path.isabs(args.profile):
            raise Refusal("--profile must be an absolute path")
        profile = Path(os.path.normpath(args.profile))
        name = args.name or profile.name
        if not NAME.fullmatch(name):
            raise Refusal("invalid name: use [a-z][a-z0-9-]{0,31}")
        try:
            rows = kit_aws.components(load(Path(args.kit).resolve() / "config/manifest.json"))
        except (Invalid, KeyError, TypeError, AttributeError) as error:
            raise Refusal(f"config/manifest.json: {error}") from None
        modules = modules_of(args.modules, rows) if args.modules is not None else None
        data, catalog, components = inventory(Path(args.kit).resolve(), profile, Path(home), name, dict(os.environ),
                                              modules, args.shell, args.dummies, args.claude_plugin, args.runtime,
                                              args.claude_aws, args.adopt_aws)
    except Refusal as error:
        print(f"kit_inventory: {error}", file=sys.stderr)
        return 2
    if not args.plain:
        print(json.dumps(data, indent=2))
        return 0
    tty = sys.stdout.isatty()
    columns = os.environ.get("COLUMNS", "")
    width = shutil.get_terminal_size((100, 24)).columns if tty else int(columns) if columns.isdigit() else 100
    unicode = (sys.stdout.encoding or "").lower().replace("-", "").startswith("utf")
    color = tty and not os.environ.get("NO_COLOR")
    print(render(data, catalog, components, Path(home), max(72, min(width, 120)), color, UNICODE if unicode else ASCII))
    return 0


if __name__ == "__main__":
    sys.exit(main())
