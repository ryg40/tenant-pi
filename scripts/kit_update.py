"""Pure parts of the read-only `update` action of `scripts/tenant_pi.py`.

The action tells a client what a new kit version needs: nothing, package lines, a new candidate, or a runtime
change. This module opens no file, starts no process and writes nothing. The CLI reads each input through
its bounded readers and gives the loaded values here.
"""
import re
import shlex

from scripts.check_runtime import TOOLS
from scripts.memory_modules import AGENTCORE_CORE

SAME, NEW, RUNTIME = "same_profile", "new_candidate", "runtime_action_needed"
# A clean clone at a release tag needs no test run. The GitHub workflow runs `check.py` on Linux and macOS for each
# pushed snapshot, and the maintainer creates the release entry of a tag only after both runs pass.
RELEASE_TAG = "portable/"
NO_TESTS = "none needed"
FAST_TESTS = "python3 scripts/check.py --tier fast"
# The kit's own record in a candidate. A change there alone changes nothing that Pi loads.
METADATA = ".tenant-pi/"
# Why a candidate needs a replacement. With more than one, the first of `REASONS` names it.
NOT_COMPARABLE, NO_DIGESTS, KIT_CHANGED = "not_comparable", "no_output_digests", "kit_changed"
REASONS = (NOT_COMPARABLE, NO_DIGESTS, KIT_CHANGED)
NO_DIGESTS_NOTE = "This candidate predates output digests; generate one new candidate; later updates compare exactly."
DRIFT_NOTE = "Pi or the user changed these files after generation; they stay as they are with same_profile."
DIGEST = re.compile(r"[0-9a-f]{64}\Z")
# The `-YYYYMMDD` part of a candidate name, with an optional `-<number>`; a suggested name replaces it.
DATED = re.compile(r"-[0-9]{8}(?:-[0-9]+)?\Z")
MAX_SUGGESTIONS = 100
# The `PATH` line of `docs/guides/macos.md` for a tool that is missing or outside its range.
PATH_HINTS = {
    "node": ("# node is not on PATH or not in the range. Homebrew node@24 is keg-only: run "
             "export PATH=\"/opt/homebrew/opt/node@24/bin:$PATH\" (docs/guides/macos.md), or load nvm and run nvm use 24."),
    "python": ("# python3 on PATH is not 3.11 or later. With Homebrew, run "
               "export PATH=\"/opt/homebrew/opt/python@3.12/libexec/bin:$PATH\" (docs/guides/macos.md)."),
}


def tests_line(tag, clean):
    """`none needed` for a clean clone at a release tag; else the line of the fast check tier."""
    return NO_TESTS if clean is True and type(tag) is str and tag.startswith(RELEASE_TAG) else FAST_TESTS


def recorded_digests(value, names):
    """The `outputDigests` record of a state file when each key is one of `names` and each value a digest, else None."""
    if type(value) is not dict or any(type(name) is not str or name not in names or type(digest) is not str
                                      or not DIGEST.fullmatch(digest) for name, digest in value.items()):
        return None
    return value


def kit_changes(expected, recorded):
    """The paths where the new plan differs from the record of the generation, without `.tenant-pi/`.

    Both map a relative path to a SHA-256. `differs`: other bytes; `added`: only the new plan writes the path;
    `extra`: only the generation wrote it.
    """
    changes = []
    for name in sorted(set(expected) | set(recorded)):
        if name.startswith(METADATA):
            continue
        if name not in recorded:
            changes.append({"path": name, "change": "added"})
        elif name not in expected:
            changes.append({"path": name, "change": "extra"})
        elif expected[name] != recorded[name]:
            changes.append({"path": name, "change": "differs"})
    return changes


def first_reason(reasons):
    """The reason of a `new_candidate` verdict from the reasons found, or None when none was found."""
    return next((reason for reason in REASONS if reason in reasons), None)


def tree_packages(components, enabled):
    """The in-tree package directories that a profile of the selection loads from the clone, sorted.

    The AgentCore extension imports the shared core, so the core stands for it, as in the setup lines of the plan.
    """
    paths = {components[cid]["source"]["path"] for cid in enabled
             if components[cid]["source"] is not None and components[cid]["source"]["kind"] == "tree"}
    if "agentcore" in enabled:
        paths.add(AGENTCORE_CORE)
    return sorted(paths)


def _packages(data):
    """The package entries of a parsed lock file without the root entry `""`, or None for another shape."""
    packages = data.get("packages") if type(data) is dict else None
    return {name: entry for name, entry in packages.items() if name != ""} if type(packages) is dict else None


def install_status(lock, installed):
    """`(status, reason)` of `npm ci` for one package: `needed`, `current` or `no_dependencies`.

    `lock` is the parsed `package-lock.json`. `installed` is the parsed `node_modules/.package-lock.json`, the
    hidden lock file that npm 7 and later write after an install, or None when it is absent. The hidden file
    holds the installed entries of the lock without its root entry. An optional entry can be absent: npm skips
    an optional package of another platform.
    """
    wanted = _packages(lock)
    if wanted is None:
        return "needed", "lock_unreadable"
    if not wanted:
        return "no_dependencies", None
    if installed is None:
        return "needed", "not_installed"
    present = _packages(installed)
    if present is None:
        return "needed", "install_unreadable"
    if set(present) - set(wanted) or any(
            present[name] != entry if name in present else not (type(entry) is dict and entry.get("optional") is True)
            for name, entry in wanted.items()):
        return "needed", "lock_changed"
    return "current", None


def install_line(directory):
    """The `npm ci` line of one package, in the form of the setup lines of the plan."""
    return "npm --prefix " + shlex.quote(directory) + " ci --ignore-scripts"


def new_target(current, today, taken):
    """`<parent>/<name>-<YYYYMMDD>` beside the current candidate, for the first free name.

    A date part of `name` is replaced. `-2`, `-3` and so on follow when `taken(path)` is true.
    """
    parent, _, name = current.rpartition("/")
    base = parent + "/" + DATED.sub("", name) + "-" + today
    for number in range(1, MAX_SUGGESTIONS + 1):
        path = base if number == 1 else base + "-" + str(number)
        if not taken(path):
            return path
    return None


def _quote(*parts):
    return " ".join(shlex.quote(part) for part in parts)


def _cli(kit, action, options):
    return "python3 " + shlex.quote(kit) + " " + action + (" " + _quote(*options) if options else "")


def runtime_lines(*, kit, report, pi_install, update_options):
    """The lines of a `runtime_action_needed` verdict: a hint for each tool, the Pi line, then `update` again."""
    lines = []
    for key, command, _ in TOOLS:
        if report[key]["status"] == "unparsed":
            lines.append("# " + command + " --version printed no version. Check the " + command + " command on PATH.")
        elif key in PATH_HINTS and report[key]["status"] in ("missing", "mismatch"):
            lines.append(PATH_HINTS[key])
    if pi_install["status"] in ("needed", "replaces_installed"):
        lines.append("# The next line installs Pi " + pi_install["required"] + " for every profile of this user. "
                     "Run it only after your own decision.")
        lines.append(pi_install["command"])
    lines.append("# Then run this action again:")
    lines.append(_cli(kit, "update", update_options))
    return lines


def same_profile_lines(*, launcher_path, package_lines, drift):
    """The lines of a `same_profile` verdict: the drift sentence, the package lines, then a restart of Pi."""
    start = "its launcher" if launcher_path is None else shlex.quote(launcher_path)
    named = ["# Drift in " + ", ".join(item["path"] for item in drift) + ": " + DRIFT_NOTE] if drift else []
    return [*named, *package_lines,
            "# Keep the current candidate. Exit each running Pi of it, then start it again with " + start + "."]


def new_candidate_lines(*, kit, overlay, private_dir, current, target, edited, plan_options, runtime_options,
                        setup, package_lines, home, vault, note=None):
    """The lines of a `new_candidate` verdict, in the order of the candidate loop of `POST_INSTALL.md`.

    `note` is one sentence on the reason, printed first.
    """
    name = target.rpartition("/")[2]
    runtime = private_dir + "/runtime.json"
    launcher = private_dir + "/launch-" + name + ".sh"
    live = home + "/.pi/agent"
    baselines = [(live, private_dir + "/live-baseline-" + name + ".json")]
    if vault is not None:
        baselines.append((vault, private_dir + "/wiki-vault-baseline-" + name + ".json"))
    lines = [] if note is None else ["# " + note]
    lines += ["# target.agentDir of " + shlex.quote(overlay) + " names " + shlex.quote(target) + " already."
              if edited else "# Edit " + shlex.quote(overlay) + ": set target.agentDir to " + shlex.quote(target) + ".",
              _cli(kit, "check-runtime", runtime_options) + " > " + shlex.quote(runtime),
              _cli(kit, "generate", [*plan_options, "--runtime-report", runtime, "--target", target, "--launcher", launcher])]
    lines += [_cli(kit, "baseline", ["--dir", directory, "--out", out]) for directory, out in baselines]
    lines += setup + [line for line in package_lines if line not in setup]
    lines += [shlex.quote(launcher),
              "# In Pi: run /login, select the model, then exit Pi. A new candidate has no login."]
    lines += [_cli(kit, "check-baseline", ["--dir", directory, "--baseline", out]) for directory, out in baselines]
    lines += [_cli(kit, "compare", ["--left", current, "--right", target]) + " > "
              + shlex.quote(private_dir + "/report-" + name + ".json"),
              "# Use " + shlex.quote(launcher) + " from now on. Add it to places.launchers of "
              + shlex.quote(private_dir + "/results-facts.json") + ".",
              _cli(kit, "results", ["--facts", private_dir + "/results-facts.json", "--overlay", overlay,
                                    "--target", current, "--target", target, "--out-dir", private_dir, "--replace"])]
    return lines


def _count(number, word):
    return str(number) + " " + word + ("" if number == 1 else "s")


def summary(verdict, *, current, tests, package_lines, changes, reason, drift, target, report):
    """The one short line that comes first in the result."""
    if verdict == RUNTIME:
        text = RUNTIME + ": " + "; ".join(
            key + " " + (entry["installed"] + " " if entry["installed"] else "") + entry["status"]
            for key, entry in report.items() if entry["status"] not in ("match", "untested_in_range"))
    elif verdict == NEW:
        named = ", ".join(item["path"] + " " + item["change"] for item in changes[:3])
        more = "" if len(changes) <= 3 else " and " + str(len(changes) - 3) + " more"
        text = NEW + ": " + (named + more if changes else reason) + "; generate " + (target or "a new candidate")
    else:
        text = SAME + ": keep " + current + "; " + (
            "run " + _count(len(package_lines), "package line") if package_lines else "no package line") + (
            "; drift in " + ", ".join(item["path"] for item in drift) if drift else "")
    return text + ("; run the fast checks first" if tests != NO_TESTS else "")
