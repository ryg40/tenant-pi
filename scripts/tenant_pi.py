#!/usr/bin/env python3
"""Offline, new-profile-only tenant-pi CLI (Python 3.11+)."""
import sys

# Direct script invocation imports project modules; never leave bytecode in the kit.
sys.dont_write_bytecode = True

import argparse
import errno
import json
import os
from pathlib import Path
import stat

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.candidate_compare import FILES, compare
from scripts import baseline
from scripts.carry import carry, report_entries
from scripts.candidate_list import child, report as list_report, safe_name, select
from scripts import kit_commit
from scripts.profile_inventory import RESOURCE_DIRS, inventory
from scripts.check_runtime import TOOLS, check, matches
from scripts import launcher
from scripts.private_init import TARGET, TEMPLATES, check_location, check_target, init, inside, report as init_report, with_target
from scripts.profile_plan import (PROVIDER_KEY_NAMES, prepare, provider_key_warning, readiness, runtime_report,
                                   setup_commands)
from scripts.profile_write import WriteError, utc_now, write
from scripts.validate import OWNER_RESOURCES, SAMPLE_TARGET, Invalid, absolute, manifest, parse, place, fail

MAX_INPUT = 1024 * 1024
# Nesting bound of one JSON input. The parser limit differs between Python versions, so the kit sets its own.
MAX_DEPTH = 64
# Entry bound of one listed resource directory.
MAX_ENTRIES = 4096
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def _depth_bounded(value, field):
    """Stop when `value` nests objects and arrays deeper than MAX_DEPTH; no recursion."""
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if not isinstance(item, (dict, list)):
            continue
        if depth > MAX_DEPTH:
            fail("input_too_deep", field)
        pending.extend((child, depth + 1) for child in (item.values() if isinstance(item, dict) else item))
    return value


def _parse(data, field):
    """Parse the bytes of one bounded input with the kit's duplicate-key, number and depth rules."""
    return _depth_bounded(parse(data, field), field)


def _load_input(path, field, *, optional=False, raw=False, limit=None):
    """Read one explicit regular JSON input, without following its final symlink.

    With `optional`, a missing path component returns None; every other failure is an error.
    With `raw`, return the bounded bytes unparsed. `limit` lowers the byte bound.
    Each cause of a read failure has its own rule: absent, a link or a non-directory in the
    path, and every other refusal of the system.
    """
    limit = MAX_INPUT if limit is None else limit
    if "\x00" in path:
        fail("input_path", field)
    fd = None
    parent_fd = None
    try:
        parts = Path(path).parts
        if not parts or any(part in (".", "..") for part in path.split("/")):
            fail("input_path", field)
        parent_fd = os.open("/" if Path(path).is_absolute() else ".",
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        for part in parts[:-1]:
            if part == "/":
                continue
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = child
        expected = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(expected.st_mode):
            fail("input_not_regular", field)
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=parent_fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or
                (info.st_dev, info.st_ino) != (expected.st_dev, expected.st_ino)):
            fail("input_not_regular", field)
        if info.st_size > limit:
            fail("input_too_large", field)
        with os.fdopen(fd, "rb") as stream:
            fd = None
            data = stream.read(limit + 1)
        if len(data) > limit:
            fail("input_too_large", field)
        return data if raw else _parse(data, field)
    except FileNotFoundError:
        if optional:
            return None
        fail("input_missing", field)
    except OSError as exc:
        # A directory of the path that is a link gives ENOTDIR; a final name that became a link gives ELOOP.
        fail("input_path_unsafe" if exc.errno in (errno.ENOTDIR, errno.ELOOP) else "input_unreadable", field)
    finally:
        if fd is not None:
            os.close(fd)
        if parent_fd is not None:
            os.close(parent_fd)


def _mcp_slot(overlay_data):
    """The fixed `inputs.mcpFile` slot name, or None; the overlay validator owns its allowlist."""
    inputs = overlay_data.get("inputs") if type(overlay_data) is dict else None
    slot = inputs.get("mcpFile") if type(inputs) is dict else None
    return slot if type(slot) is str and slot == "inputs/mcp-adapter.json" else None


def _inventory(plan):
    return ([{"path": ".", "mode": "0700", "kind": "directory"},
             {"path": ".tenant-pi", "mode": "0700", "kind": "directory"}]
            + [{"path": name, "mode": plan["files"][name]["mode"], "kind": "file"}
               for name in sorted(plan["files"])]
            + [{"path": ".tenant-pi/state.json", "mode": "0600", "kind": "file"}])


def _preview(plan, *, generated, launcher_path=None, report=None, key_warning=None):
    owner_resources = plan["files"][".tenant-pi/choices.json"]["content"]["overlay"].get("ownerResources", {})
    # The measured facts change this report only; the plan and the generated files stay the same.
    facts = readiness(plan, report=report, generated=generated)
    setup = setup_commands(plan, report)
    return {
        "targetAgentDir": plan["targetAgentDir"],
        "files": _inventory(plan),
        "readinessGaps": facts["readinessGaps"],
        "filesComplete": generated,
        "runtimeReady": facts["runtimeReady"],
        "routeStatus": plan["files"][".tenant-pi/choices.json"]["content"]["roleStatus"],
        "routeSetup": plan["files"][".tenant-pi/choices.json"]["content"]["routes"]["setup"] if plan["files"][".tenant-pi/choices.json"]["content"]["routes"] else [],
        "memory": plan["files"][".tenant-pi/choices.json"]["content"]["memory"],
        "workflow": plan["files"][".tenant-pi/choices.json"]["content"]["workflow"],
        "ownerPackages": plan["files"][".tenant-pi/choices.json"]["content"]["overlay"].get("ownerPackages", []),
        "unmanaged": plan["files"][".tenant-pi/choices.json"]["content"]["overlay"].get("unmanaged", []),
        "ownerResources": {kind: owner_resources.get(kind, []) for kind in OWNER_RESOURCES},
        "commands": {
            "setupDisplayOnly": setup["setup"],
            "piInstall": setup["piInstall"],
            "launchDisplayOnly": plan["commands"]["launch"],
            "launchStatus": "manual_review_required" if generated else "not_runnable_until_generation_succeeds",
            **({"launcherDisplayOnly": launcher_path} if launcher_path is not None else {}),
            **({"providerKeyWarning": key_warning} if key_warning is not None else {}),
        },
    }


def _candidate(directory, field):
    """Open only the three declared kit files of one explicitly named directory."""
    absolute(directory, field)
    return {name: _load_input(directory + "/" + name, field + "." + name, optional=True) for name in FILES}


def _open_dir(path):
    """Open one absolute directory through real ancestor directories; the caller closes it."""
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    return fd


def _kind(entry):
    if entry.is_symlink():
        return "symlink"
    if entry.is_dir(follow_symlinks=False):
        return "dir"
    return "file" if entry.is_file(follow_symlinks=False) else "other"


def _listing(path, field):
    """Names and kinds of the direct entries of one directory; no entry is opened or followed."""
    fd = None
    try:
        fd = _open_dir(path)
        entries = []
        with os.scandir(fd) as found:
            for entry in found:
                if len(entries) == MAX_ENTRIES:
                    fail("input_too_large", field)
                entries.append((entry.name, _kind(entry)))
        return entries
    except FileNotFoundError:
        return []
    except OSError:
        fail("read_or_json", field)
    finally:
        if fd is not None:
            os.close(fd)


def _managed(directory, field):
    """Whether the state marker exists as a regular file; the marker is never opened."""
    fd = None
    try:
        fd = _open_dir(directory + "/.tenant-pi")
        if not stat.S_ISREG(os.stat("state.json", dir_fd=fd, follow_symlinks=False).st_mode):
            fail("input_not_regular", field)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        fail("read_or_json", field)
    finally:
        if fd is not None:
            os.close(fd)


def _profile(directory, field):
    """Read the settings of one explicitly named directory and list its three resource directories."""
    absolute(directory, field)
    settings = _load_input(directory + "/settings.json", field + ".settings.json", optional=True)
    if settings is None:
        fail("settings_missing", field)
    return inventory(directory, settings,
                     {name: _listing(directory + "/" + name, field + "." + name) for name in RESOURCE_DIRS},
                     _managed(directory, field + ".state.json"))


def _git_file(path, limit=kit_commit.MAX_METADATA):
    """Bytes of one Git metadata file through the bounded loader, or None on any failure."""
    try:
        return _load_input(path, "kit_commit", optional=True, raw=True, limit=limit)
    except Invalid:
        return None


def _git_path(base, value):
    """An absolute, lexically normalized metadata path; the loader then refuses every symlink."""
    path = os.path.normpath(value if value.startswith("/") else base + "/" + value)
    return path if path.startswith("/") and not path.startswith("//") else None


def _kit_commit(root=None):
    """The commit of the kit clone, read from its Git metadata files without a process.

    The same value as `git rev-parse HEAD` for a plain clone or a worktree, else `unknown`.
    A `.git` file (`gitdir: <path>`) and a worktree `commondir` file are followed once each.
    """
    root = str(ROOT if root is None else root)
    gitdir = root + "/.git"
    if (data := _git_file(gitdir)) is not None:
        # A file `.git`: a worktree or a separate Git directory. A directory fails the loader.
        target = kit_commit.pointer(data, "gitdir: ")
        if target is None or (gitdir := _git_path(root, target)) is None:
            return kit_commit.UNKNOWN
    common = gitdir
    if (data := _git_file(gitdir + "/commondir")) is not None:
        target = kit_commit.pointer(data)
        if target is None or (common := _git_path(gitdir, target)) is None:
            return kit_commit.UNKNOWN
    found = kit_commit.head(_git_file(gitdir + "/HEAD"))
    if found is None:
        return kit_commit.UNKNOWN
    kind, value = found
    if kind == "commit":
        return value
    try:
        data = _load_input(common + "/" + value, "kit_commit", optional=True, raw=True, limit=kit_commit.MAX_METADATA)
    except Invalid:
        return kit_commit.UNKNOWN
    if data is not None:
        # A present loose ref wins. When it does not parse, Git fails too: never fall back to a stale packed value.
        return kit_commit.loose(data) or kit_commit.UNKNOWN
    return kit_commit.packed(_git_file(common + "/packed-refs", MAX_INPUT), value) or kit_commit.UNKNOWN


def _parent_entries(parent):
    """Names and kinds of the direct entries of the parent; a close failure is a diagnostic."""
    fd = None
    diagnostics = []
    try:
        fd = _open_dir(parent)
        entries = []
        with os.scandir(fd) as found:
            for entry in found:
                if len(entries) == MAX_ENTRIES:
                    fail("input_too_large", "list.parent")
                entries.append((entry.name, _kind(entry)))
    except FileNotFoundError:
        fail("parent_missing", "list.parent")
    except OSError:
        fail("read_or_json", "list.parent")
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                diagnostics.append("cleanup_failed: list.parent")
    return entries, diagnostics


def _list(parent):
    """The candidate list of one explicit parent: only `<child>/.tenant-pi/state.json` is read."""
    absolute(parent, "list.parent")
    entries, diagnostics = _parent_entries(parent)
    children, omitted, other = select(entries)
    rows = []
    for name, kind in children:
        if kind != "dir" or not safe_name(name):
            # A symlinked child is never entered; an unsafe name is neither echoed nor entered.
            rows.append(child(name, kind))
            continue
        try:
            state = _load_input(parent + "/" + name + "/.tenant-pi/state.json", "list.child.state.json", optional=True)
        except Invalid as exc:
            rows.append(child(name, kind, error=str(exc).split(":", 1)[0]))
            continue
        rows.append(child(name, kind, state=state))
    return list_report(parent, rows, omitted, other, diagnostics)


def _dir_state(directory, field):
    """The `baseline.scan` state of one explicitly named directory, or None when it is absent.

    Every path component is opened as a real directory. No file is opened and no link is followed.
    """
    try:
        fd = _open_dir(directory)
    except FileNotFoundError:
        return None
    except NotADirectoryError:
        # The directory or a directory above it is a symbolic link or is not a directory.
        fail("not_directory", field)
    except OSError:
        fail("unreadable", field)
    try:
        return baseline.scan(fd)
    except OSError:
        fail("unreadable", field)
    finally:
        os.close(fd)


def _baseline(args, clock):
    """Record the baseline of one explicitly named directory; the one write is the absent `--out` file."""
    home = _home("baseline.home")
    absolute(args.dir, baseline.DIR_FIELD)
    baseline.check_location(args.out, _roots((("under_kit", str(ROOT)), ("under_pi_agent", home + "/.pi/agent"),
                                              ("under_dir", args.dir))))
    # An existing baseline or a bad parent stops before the directory is listed.
    baseline.preflight(args.out)
    value = baseline.record(args.dir, baseline.stamp(clock), _dir_state(args.dir, baseline.DIR_FIELD))
    data = baseline.encode(value)
    if len(data) > MAX_INPUT:
        # `check-baseline` reads the file through the bounded loader.
        fail("input_too_large", baseline.DIR_FIELD)
    return baseline.report(value, baseline.write(args.out, data))


def _check_baseline(args):
    """Compare one explicitly named directory with its baseline file. Writes nothing."""
    absolute(args.dir, "check-baseline.dir")
    absolute(args.baseline, baseline.SAVED_FIELD)
    saved = _load_input(args.baseline, baseline.SAVED_FIELD, optional=True)
    if saved is None:
        # Without a baseline the directory is not listed.
        return baseline.compare(None, args.dir, None)
    # The baseline must name `--dir` before the directory is listed.
    baseline.saved_record(saved, args.dir)
    return baseline.compare(saved, args.dir, _dir_state(args.dir, "check-baseline.dir"))


def _overlay_target(data, field):
    """The `target.agentDir` of one parsed overlay; no other overlay value is read."""
    target = data.get("target") if type(data) is dict else None
    value = target.get("agentDir") if type(target) is dict else None
    absolute(value, field)
    return value


def _home(field):
    """`HOME` as an absolute path; the only environment value that a location rule reads."""
    home = os.environ.get("HOME")
    if home is None:
        fail("home_required", field)
    absolute(home, field)
    return home


def _roots(pairs):
    """Each forbidden root as written and as resolved: a root that is a link must not hide its real place."""
    return [(rule, root) for rule, path in pairs for root in dict.fromkeys((path, os.path.realpath(path)))]


def _outside(target, pairs, field):
    """Refuse a profile target that is a forbidden root of `pairs` or under one, before any write.

    Each root counts as in `_roots`. The target counts as written and with its links
    resolved (this reads link targets only, no file content), so a linked name cannot reach a root.
    """
    for rule, root in _roots(pairs):
        if any(inside(form, root) for form in dict.fromkeys((target, os.path.realpath(target)))):
            fail(rule, field)


def _outside_kit(target, field):
    """Refuse a profile target that is the kit root or under it, before any write."""
    _outside(target, (("under_kit", str(ROOT)),), field)


def _outside_pi_agent(target, field):
    """Refuse a profile target that is `~/.pi/agent` or under it, before any write.

    `~/.pi/agent` is the directory that a bare `pi` opens. `HOME` names it: the kit reads no
    `PI_CODING_AGENT_DIR`, so a live directory that only this variable names is not refused.
    """
    _outside(target, (("under_pi_agent", _home("target.home") + "/.pi/agent"),), field)


def _launcher_location(path, plan, targets):
    """Static launcher refusals for `plan` and `generate`, before any filesystem access."""
    home = _home("launcher.home")
    launcher.check_location(path, _roots((("under_kit", str(ROOT)), ("under_pi_agent", home + "/.pi/agent"),
                                          *(("under_target", target) for target in dict.fromkeys(targets)))))
    launcher.text(plan["commands"]["launch"])


def _init_private(args):
    """Create the private directory from the tracked templates; refuse the documented locations."""
    home = _home("init-private.home")
    contents = {name: _load_input(str(ROOT / source), "init-private.template." + name, raw=True)
                for name, source in TEMPLATES.items()}
    template = _parse(contents["overlay.json"], "init-private.template.overlay.json")
    targets = [_overlay_target(template, "init-private.template.overlay.json")]
    targets += [_overlay_target(_load_input(path, "init-private.overlay"), "init-private.overlay") for path in args.overlay]
    if args.target is not None:
        # The form first: the location rules resolve the links of the path.
        check_target(args.target)
        targets.append(args.target)
    forbidden = _roots((("under_kit", str(ROOT)), ("under_pi_agent", home + "/.pi/agent"),
                        *(("under_overlay_target", target) for target in targets)))
    if args.target is not None:
        # The directory rules first, then the rules of the new target; both before any write.
        check_location(args.dir, forbidden)
        _outside(args.target, (("under_private_dir", args.dir), ("under_kit", str(ROOT)),
                               ("under_pi_agent", home + "/.pi/agent")), TARGET)
        contents["overlay.json"] = with_target(template, args.target)
    return init_report(init(args.dir, contents, forbidden), str(ROOT), args.target)


def main(argv=None, *, clock=utc_now):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    cmp = subs.add_parser("compare", help="redacted field comparison of two explicit profile directories")
    cmp.add_argument("--left", required=True, help="absolute path of the previous candidate or profile")
    cmp.add_argument("--right", required=True, help="absolute path of the new candidate")
    car = subs.add_parser("carry", help="print overlay patches that adopt owner-owned changes of a compare report")
    car.add_argument("--report", required=True, help="explicit JSON output of a previous compare run")
    car.add_argument("--overlay", required=True, help="explicit local JSON choices file that the patches target")
    car.add_argument("--right", required=True, help="absolute path of the report's right side")
    car.add_argument("--manifest", default=str(ROOT / "config/manifest.json"),
                     help="reviewed kit manifest (override remains strictly validated)")
    inv = subs.add_parser("inventory", help="names-only resource list of one explicit profile directory")
    inv.add_argument("--dir", required=True, help="absolute path of the profile or candidate directory")
    lst = subs.add_parser("list", help="read-only state list of the candidate directories under one explicit parent")
    lst.add_argument("--parent", required=True, help="absolute path of the directory that holds the candidates")
    base = subs.add_parser("baseline", help="record names, sizes and modification times of one explicit directory")
    base.add_argument("--dir", required=True, help="absolute path of the directory to record; it can be absent")
    base.add_argument("--out", required=True, help="absolute path of the absent baseline file; its parent exists")
    chk = subs.add_parser("check-baseline", help="compare one explicit directory with its baseline file")
    chk.add_argument("--dir", required=True, help="absolute path of the directory that the baseline names")
    chk.add_argument("--baseline", required=True, help="absolute path of the baseline file of a previous baseline run")
    rt = subs.add_parser("check-runtime", help="compare the installed Pi, Node and Python with manifest.runtime")
    for key, command, _ in TOOLS:
        rt.add_argument("--" + key, help=f"absolute path of the {command} executable (default: {command} on PATH)")
    rt.add_argument("--manifest", default=str(ROOT / "config/manifest.json"),
                    help="reviewed kit manifest (override remains strictly validated)")
    priv = subs.add_parser("init-private", help="create a new private directory for the overlay and its records")
    priv.add_argument("--dir", required=True, help="absolute path of the absent private directory; its parent exists")
    priv.add_argument("--overlay", action="append", default=[],
                      help="overlay whose target the directory must stay outside of; repeat for more overlays")
    priv.add_argument("--target", help="absolute path of the new profile directory; the new overlay gets it as target.agentDir")
    for action in ("validate", "plan", "generate"):
        cmd = subs.add_parser(action, help=f"{action} a private local overlay")
        cmd.add_argument("--overlay", required=True, help="explicit local JSON choices file")
        cmd.add_argument("--manifest", default=str(ROOT / "config/manifest.json"),
                         help="reviewed kit manifest (override remains strictly validated)")
        cmd.add_argument("--registry", help="explicit offline capability JSON map; not Pi models.json")
        cmd.add_argument("--require-role", action="append", default=[],
                         help="require an explicit reviewed role; repeat for more roles")
        cmd.add_argument("--local-dir", default=str(ROOT / ".local"),
                         help="absolute directory that holds the fixed overlay.inputs slots (default: the kit's .local)")
        if action == "generate":
            cmd.add_argument("--target", required=True, help="explicit absent agent directory; must match overlay")
        if action != "validate":
            cmd.add_argument("--launcher", help="absolute path of an absent launcher file; " +
                             ("written after a complete generation" if action == "generate" else "display only"))
            cmd.add_argument("--runtime-report", help="explicit JSON output of a previous check-runtime run; "
                             "the readiness gaps then show the measured runtime versions")
    args = parser.parse_args(argv)
    code = 0
    try:
        if args.action == "compare":
            if args.left == args.right:
                fail("same_directory", "compare.right")
            report = compare(_candidate(args.left, "compare.left"), _candidate(args.right, "compare.right"))
            print(json.dumps({"left": {"path": args.left, **report["left"]}, "right": {"path": args.right, **report["right"]},
                              **{k: v for k, v in report.items() if k not in ("left", "right")}},
                             sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0
        if args.action == "carry":
            # Prints only: no file is written and no patch is applied.
            absolute(args.right, "carry.right")
            report = _load_input(args.report, "carry.report")
            # The report must name `--right` before any file of `--right` is opened.
            report_entries(report, args.right)
            overlay_data = _load_input(args.overlay, "carry.overlay")
            manifest_data = _load_input(args.manifest, "manifest.file")
            output = carry(report, overlay_data, manifest_data, _candidate(args.right, "carry.right"), args.right)
            print(json.dumps(output, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0
        if args.action == "inventory":
            print(json.dumps(_profile(args.dir, "inventory.dir"), sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0
        if args.action == "list":
            print(json.dumps(_list(args.parent), sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0
        if args.action == "baseline":
            # Lists the directory and reads the status of each entry; opens no file of it.
            print(json.dumps(_baseline(args, clock), sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0
        if args.action == "check-baseline":
            report = _check_baseline(args)
            print(json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0 if report["result"] == "unchanged" else 1
        if args.action == "check-runtime":
            paths = {key: getattr(args, key) for key, _, _ in TOOLS if getattr(args, key) is not None}
            for key, path in paths.items():
                absolute(path, "check-runtime." + key)
            manifest_data = _load_input(args.manifest, "manifest.file")
            manifest(manifest_data)
            # The only action that starts a process: three fixed `--version` commands, no shell.
            report = check(manifest_data["runtime"], paths)
            print(json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0 if matches(report) else 1
        if args.action == "init-private":
            # Never runs Git: the `git init` line is display text for the user.
            print(json.dumps(_init_private(args), sort_keys=True, ensure_ascii=True, separators=(",", ":")))
            return 0
        manifest_data = _load_input(args.manifest, "manifest.file")
        overlay_data = _load_input(args.overlay, "overlay.file")
        # Never consult os.environ for a credential value. `plan` tests the names of `PROVIDER_KEY_NAMES`
        # for presence only, for its warning.
        registry_data = _load_input(args.registry, "registry.file") if args.registry else None
        mcp_data = None
        if (slot := _mcp_slot(overlay_data)) is not None:
            absolute(args.local_dir, "local_dir")
            mcp_data = _load_input(args.local_dir + "/" + slot, "mcp.file")
        # `plan` and `generate` start no process: the caller gives the report of `check-runtime` as a file.
        report = getattr(args, "runtime_report", None)
        if report is not None:
            report = _load_input(report, "runtime_report.file")
        plan = prepare(manifest_data, overlay_data, registry=registry_data, required_roles=args.require_role,
                       mcp_definitions=mcp_data)
        if report is not None:
            runtime_report(report, manifest_data["runtime"])
        # A profile inside the kit clone would enter its publish set; the overlay itself is valid here.
        _outside_kit(plan["targetAgentDir"], "overlay.target.agentDir")
        # The unedited copy of the example names a fake user; no profile can be generated there.
        if plan["targetAgentDir"] == SAMPLE_TARGET:
            fail("sample_target", "overlay.target.agentDir")
        launcher_path = getattr(args, "launcher", None)
        if launcher_path is not None:
            _launcher_location(launcher_path, plan, (plan["targetAgentDir"], args.target)
                               if args.action == "generate" else (plan["targetAgentDir"],))
        # No profile is generated into the live profile. The rule runs after the rules that need no `HOME`
        # and after the launcher rules, which name their own `HOME` field.
        _outside_pi_agent(plan["targetAgentDir"], "overlay.target.agentDir")
        if args.action == "validate":
            output = {"valid": True, "scope": "offline structural and supported-input checks only"}
        elif args.action == "plan":
            # A membership test: the value of a variable is never read.
            set_names = [name for name in PROVIDER_KEY_NAMES if name in os.environ]
            output = _preview(plan, generated=False, launcher_path=launcher_path, report=report,
                              key_warning=provider_key_warning(set_names))
        else:
            if any(gap["code"] == "pi_login_blocked" for gap in plan["readinessGaps"]):
                fail("pi_login_blocked", "overlay.modelRoutes.gateway.auth")
            if launcher_path is not None:
                # An existing launcher or a bad parent stops before the target is created.
                launcher.preflight(launcher_path)
            result = write(plan, args.target, clock=clock, kit_commit=_kit_commit())
            if not result.complete:
                raise WriteError("incomplete_result", "target", candidate_created=True)
            output = {"candidate_created": True, "complete": True, "warnings": list(result.warnings),
                      **_preview(plan, generated=True, launcher_path=launcher_path, report=report)}
            if launcher_path is not None:
                # The profile is complete here; a launcher failure is reported, never raised over the report.
                try:
                    output["launcher"] = launcher.report(launcher.write(launcher_path, plan["commands"]["launch"]))
                except (Invalid, WriteError) as exc:
                    output["launcher"] = launcher.failure(launcher_path, exc)
                    code = 1
    except Invalid as exc:
        print(json.dumps({"error": str(exc), "candidate_created": False, **place(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    except WriteError as exc:
        print(json.dumps({"error": str(exc), "candidate_created": exc.candidate_created}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(output, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
