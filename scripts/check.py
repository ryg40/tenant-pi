#!/usr/bin/env python3
"""Run the offline checks of the changed files; record clean runs of everything in Git metadata.

The changed files differ from the merge base of HEAD with origin/main, else main, or they are
untracked and not ignored. The check selects:
  - a changed root test module (tests/test*.py): that module;
  - a changed root Python file (scripts/*.py, tests/*.py): each root test module that imports it,
    directly or through another root file, or that names its path;
  - a changed file in a package folder: the suites of that package (npm test, npm run typecheck,
    the Python test folders of PACKAGE_PY) and each root test module that names the file or a folder of it;
  - any other changed file: all root test modules.
Each run also parses the tracked JSON files and Markdown frontmatter, scans the tree with
scripts/scan.sh and runs git diff --check. --all, or no merge base, selects everything.
Only --all with tier full on a clean tree, with nothing skipped, writes the stamp.
"""
import sys

if sys.version_info < (3, 11):
    # Before any other import: an older Python fails inside the checks with a syntax error.
    print("check: Python 3.11 or later is required, found %d.%d" % sys.version_info[:2], file=sys.stderr)
    sys.exit(1)

import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
import time

CHECK_SET_VERSION = 2
MAX_SHARD_TIMEOUT = 86_400
ROOT = Path(__file__).resolve().parents[1]
# The publish rules run when a snapshot is cut (scripts/publish_portable.py), not here.
CHECKS = (
    ("scan", ("sh", "scripts/scan.sh", "tree")),
    ("diff", ("git", "diff", "--check")),
)
# The Python test folders of the packages, run from the package folder. A package folder also runs
# `npm test` and `npm run typecheck` when its package.json has them. scripts/pi_update.py runs `--all`.
PACKAGE_PY = (
    ("packages/tenantext", ("-m", "unittest", "discover", "-s", "tracker/tests", "-t", ".")),
    ("packages/tenantext", ("-m", "unittest", "discover", "-s", "skills/herdr/tests")),
    ("packages/tenantext", ("-m", "unittest", "discover", "-s", "skills/herdr-relay/tests")),
)
NPM_SUITES = (("test", ("npm", "test")), ("typecheck", ("npm", "run", "typecheck")))
FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*:(?:[ \t]|$)")


def run(command, root, env=None, timeout=None):
    return subprocess.run(command, cwd=root, env=env, text=True, timeout=timeout,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def cgroup_jobs(root=Path("/sys/fs/cgroup"), membership=Path("/proc/self/cgroup")):
    """Read visible v2/v1 CPU quotas, including limits of parent cgroups."""
    mounts = (root, root / "cpu", root / "cpu,cpuacct")
    paths = {(mount, mount) for mount in mounts}
    try:
        for line in membership.read_text(encoding="utf-8").splitlines():
            _, controllers, group = line.split(":", 2)
            relative = Path(group.lstrip("/"))
            if ".." in relative.parts:
                continue
            if not controllers:
                paths.add((root, root / relative))
            elif "cpu" in controllers.split(","):
                paths.update((mount, mount / relative) for mount in mounts[1:])
    except (OSError, ValueError):
        pass
    limits = []
    for mount, directory in paths:
        while True:
            try:
                if mount == root:
                    quota, period = (directory / "cpu.max").read_text(encoding="utf-8").split()
                else:
                    quota = (directory / "cpu.cfs_quota_us").read_text(encoding="utf-8")
                    period = (directory / "cpu.cfs_period_us").read_text(encoding="utf-8")
                quota, period = int(quota), int(period)
                if quota > 0 and period > 0:
                    limits.append((quota + period - 1) // period)
            except (OSError, ValueError):
                pass
            if directory == mount:
                break
            directory = directory.parent
    return min(limits) if limits else None


def default_jobs():
    count = os.cpu_count() or 1
    try:
        count = min(count, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        pass
    limit = cgroup_jobs()
    return max(1, min(count, limit) if limit else count)


def git(root, *args):
    result = run(("git", *args), root)
    if result.returncode:
        raise OSError("Git metadata is unavailable")
    return result.stdout.strip()


def clean_tree(root):
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        return None
    return git(root, "rev-parse", "HEAD^{tree}")


def stamp_path(root, tree):
    result = run(("git", "rev-parse", "--path-format=absolute", "--git-common-dir"), root)
    # Older Git versions can echo an unknown option instead of rejecting it.
    if result.returncode or result.stdout.startswith("--path-format=absolute\n"):
        directory = Path(git(root, "rev-parse", "--git-common-dir"))
    else:
        directory = Path(result.stdout.strip())
    return (root / directory).resolve() / "check-stamps" / tree


def client():
    result = {"root": hasattr(os, "geteuid") and os.geteuid() == 0,
              "docker": shutil.which("docker") is not None}
    node = shutil.which("node")
    if node:
        try:
            version = subprocess.run((node, "--version"), capture_output=True,
                                     text=True, timeout=5, check=True)
            result["node"] = version.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            pass
    return result


def stamp_matches(root):
    tree = clean_tree(root)
    if not tree:
        return False
    try:
        stamp = json.loads(stamp_path(root, tree).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (isinstance(stamp, dict)
            and stamp.get("checkSetVersion") == CHECK_SET_VERSION
            and stamp.get("python") == platform.python_version()
            and stamp.get("client") == client()
            and type(stamp.get("tests")) is int and stamp["tests"] > 0
            and type(stamp.get("skipped")) is int
            and 0 <= stamp["skipped"] <= stamp["tests"]
            and isinstance(stamp.get("resultLines"), list)
            and stamp["resultLines"][-1:] == ["check: passed"]
            and isinstance(stamp.get("when"), str))


def changed_files(root):
    """(base, paths) of the files that differ from the merge base, or (None, None) without a base."""
    for ref in ("origin/main", "main"):
        base = run(("git", "merge-base", "HEAD", ref), root)
        if base.returncode == 0:
            break
    else:
        return None, None
    paths = set()
    for command in (("git", "diff", "--name-only", "--no-renames", "-z", base.stdout.strip()),
                    ("git", "ls-files", "--others", "--exclude-standard", "-z")):
        result = run(command, root)
        if result.returncode:
            raise OSError("Git metadata is unavailable")
        paths.update(filter(None, result.stdout.split("\0")))
    return base.stdout.strip(), sorted(paths)


def root_imports(text):
    """The root Python files that a module imports, as scripts/<name>.py or tests/<name>.py."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.update([node.module, *(node.module + "." + alias.name for alias in node.names)])
    found = set()
    for parts in (name.split(".") for name in names):
        if parts[0] not in ("scripts", "tests"):
            # A script with scripts/ on its module path imports another script by its bare name.
            found.add(f"scripts/{parts[0]}.py")
        elif len(parts) > 1:
            found.add(f"{parts[0]}/{parts[1]}.py")
    return found


def selection(root, changed, modules, packages):
    """The root test modules and the package folders that the changed paths select."""
    texts, graph = {}, {}
    for path in (*(root / "scripts").glob("*.py"), *(root / "tests").glob("*.py")):
        name = path.relative_to(root).as_posix()
        texts[name] = path.read_text(encoding="utf-8", errors="replace")
        graph[name] = root_imports(texts[name])

    def reach(name):
        seen, todo = {name}, [name]
        while todo:
            for item in graph.get(todo.pop(), ()):
                if item not in seen:
                    seen.add(item)
                    todo.append(item)
        return seen

    reached = {module: reach(f"tests/{module}.py") for module in modules}
    chosen, folders = set(), set()
    for path in changed:
        parts = path.split("/")
        folder = "/".join(parts[:2])
        if parts[0] == "packages" and folder in packages:
            folders.add(folder)
            named = [path, *("/".join(parts[:end]) for end in range(2, len(parts)))]
        elif len(parts) == 2 and parts[0] in ("scripts", "tests") and path.endswith(".py") and parts[1] != "__init__.py":
            chosen.update(module for module in modules if path in reached[module])
            named = [path]
        else:
            chosen.update(modules)
            continue
        chosen.update(module for module in modules if any(item in texts[f"tests/{module}.py"] for item in named))
    return sorted(chosen), sorted(folders)


def package_suites(root, folder):
    """(label, command) of each suite of a package folder, and the missing setup of its npm suites."""
    data = json.loads((root / folder / "package.json").read_text(encoding="utf-8"))
    npm = [(f"npm {' '.join(command[1:])}", command) for script, command in NPM_SUITES if script in data.get("scripts", {})]
    python = [(args[args.index("-s") + 1], (sys.executable, "-B", *args)) for name, args in PACKAGE_PY if name == folder]
    if not npm:
        return python, None
    installed = root / folder / "node_modules"
    missing = None
    if not (shutil.which("node") and shutil.which("npm")):
        missing = "Node not found"
    elif (data.get("dependencies") or data.get("devDependencies")) and not installed.is_dir():
        missing = "no node_modules"
    elif not all((installed / name).exists() for name in data.get("peerDependencies", {})
                 if name.startswith("@earendil-works/")):
        missing = "no Pi links"
    return ([] if missing else npm) + python, missing


def tracked(root, pattern):
    result = run(("git", "ls-files", "-z", "--", pattern), root)
    if result.returncode:
        raise OSError("Git metadata is unavailable")
    return [name for name in result.stdout.split("\0") if name and (root / name).is_file()]


def json_failures(root):
    failed = []
    for name in tracked(root, "*.json"):
        try:
            json.loads((root / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            failed.append(name)
    return failed


def frontmatter_failures(root):
    """Markdown files whose first-line `---` block does not close, holds a line that is no field, or repeats a key."""
    failed = []
    for name in tracked(root, "*.md"):
        try:
            lines = (root / name).read_text(encoding="utf-8").split("\n")
        except (OSError, ValueError):
            failed.append(name)
            continue
        if lines[0].rstrip() != "---":
            continue
        end = next((index for index in range(1, len(lines)) if lines[index].rstrip() == "---"), None)
        block = lines[1:end] if end else []
        keys = [line.split(":", 1)[0] for line in block if FIELD.match(line)]
        if end is None or len(keys) != len(set(keys)) or any(
                line.strip() and line[0] not in " \t#-" and not FIELD.match(line) for line in block):
            failed.append(name)
    return failed


def unit_summary(result):
    """Read unittest's stderr trailer, not output printed by individual tests."""
    counts = re.findall(r"^Ran (\d+) tests? in [^\n]+$", result.stderr, re.MULTILINE)
    outcomes = re.findall(r"^(OK(?: \([^\n]*\))?|FAILED(?: \([^\n]*\))?)$",
                          result.stderr, re.MULTILINE)
    if not counts or not outcomes:
        return 0, 0, False
    skipped = re.search(r"\bskipped=(\d+)\b", outcomes[-1])
    return (int(counts[-1]), int(skipped[1]) if skipped else 0,
            result.returncode == 0 and outcomes[-1].startswith("OK"))


def checks(root, tier, jobs, shard_timeout=900, everything=False):
    # macOS links /tmp and /var into /private. The kit refuses a linked parent, so the tests get the resolved form.
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", TENANT_PI_TIER=tier,
               TMPDIR=os.path.realpath(tempfile.gettempdir()))
    in_git = (root / ".git").exists()
    before = clean_tree(root) if in_git else None
    started = time.monotonic()
    modules = sorted(path.stem for path in (root / "tests").glob("test*.py"))
    packages = sorted(path.parent.relative_to(root).as_posix() for path in (root / "packages").glob("*/package.json"))
    base, changed = changed_files(root) if in_git and not everything else (None, None)
    if changed is not None:
        modules, packages = selection(root, changed, modules, packages)
        selected = (f"select: {len(changed)} changed files since {base[:7]}; {len(modules)} test modules; "
                    f"packages: {', '.join(packages) or 'none'}")
    else:
        reason = "--all" if everything else "no merge base with origin/main or main" if in_git else "not a Git work tree"
        selected = f"select: all ({reason})"
    print(selected, flush=True)
    # The parts after the unit tests, in the order of the result lines: (label, work). The work is a
    # command and its folder, a function that returns the failed files, or a fixed result.
    parts = []
    for folder in packages:
        found, missing = package_suites(root, folder)
        if missing:
            parts.append((f"{folder} npm", f"FAILED ({missing}; do the setup step in docs/packages.md)"))
        parts += [(f"{folder} {label}", (command, root / folder)) for label, command in found]
    if in_git:
        parts += [("json", json_failures), ("frontmatter", frontmatter_failures)]
    scanner = os.environ.get("BETTERLEAKS_BIN") or "betterleaks"
    for name, command in CHECKS:
        if not in_git:
            parts.append((name, "skipped (not a Git work tree)"))
        elif name == "scan" and not shutil.which(scanner):
            parts.append((name, "skipped (betterleaks not found; the pre-push hook still scans each push)"))
        else:
            parts.append((name, (command, root)))

    def shard(module):
        try:
            return run((sys.executable, "-m", "unittest", f"tests.{module}", "-q"),
                       root, env, timeout=shard_timeout)
        except subprocess.TimeoutExpired:
            return None

    def part(work):
        """The status word and the detail for standard error."""
        if isinstance(work, str):
            return work, ""
        if callable(work):
            failed = work(root)
            return "FAILED" if failed else "passed", "".join(name + "\n" for name in failed)
        try:
            result = run(*work, env, timeout=shard_timeout)
        except subprocess.TimeoutExpired:
            return "FAILED", f"timed out after {shard_timeout:g}s\n"
        return "passed" if result.returncode == 0 else "FAILED", result.stdout + result.stderr

    tests = skipped_tests = 0
    # Only a run of everything needs a test module; a selection can hold none.
    passed = bool(modules) or changed is not None
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        # The parts start first: a package suite is the longest one.
        pending = [pool.submit(part, work) for _, work in parts]
        for module, result in zip(modules, pool.map(shard, modules)):
            if result is None:
                passed = False
                print(f"unittest tests.{module}: FAILED (timed out after {shard_timeout:g}s)",
                      file=sys.stderr)
                continue
            count, skip, success = unit_summary(result)
            tests += count
            skipped_tests += skip
            passed = passed and success
            if not success:
                print(f"unittest tests.{module}: FAILED", file=sys.stderr)
                print(result.stdout + result.stderr, file=sys.stderr, end="")
        elapsed = time.monotonic() - started
        outcomes = [future.result() for future in pending]
    if modules or changed is None:
        lines = [selected, f"Ran {tests} tests in {elapsed:.3f}s",
                 (f"OK (skipped={skipped_tests})" if skipped_tests else "OK") if passed else "FAILED"]
    else:
        lines = [selected, "unittest: no module selected"]
    skipped = False
    for (label, _), (status, detail) in zip(parts, outcomes):
        lines.append(f"{label}: {status}")
        passed = passed and not status.startswith("FAILED")
        skipped = skipped or status.startswith("skipped")
        if status.startswith("FAILED"):
            print(detail, file=sys.stderr, end="")
    for line in lines[1:]:
        print(line, flush=True)
    lines.append(f"check: {'passed' if passed else 'FAILED'}")
    if passed and everything and tier == "full" and not skipped and before and clean_tree(root) == before:
        stamp = {"checkSetVersion": CHECK_SET_VERSION, "python": platform.python_version(),
                 "client": client(), "skipped": skipped_tests, "tests": tests,
                 "resultLines": lines, "when": datetime.now(timezone.utc).isoformat()}
        path = None
        try:
            path = stamp_path(root, before)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f"{before}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
            temporary.replace(path)
        except OSError as error:
            reason = path if path is not None else "Git metadata is unavailable"
            print(f"stamp: not written ({type(error).__name__}: {reason})")
    if not in_git:
        print("stamp: not written (not a Git work tree)", flush=True)
    print(lines[-1], flush=True)
    return 0 if passed else 1


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("jobs must be positive")
    return number


def positive_seconds(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0 or number > MAX_SHARD_TIMEOUT:
        raise argparse.ArgumentTypeError(
            f"shard timeout must be positive, finite and at most {MAX_SHARD_TIMEOUT} seconds")
    return number


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true",
                        help="run every root test module, every package suite and the checks of each run")
    parser.add_argument("--tier", choices=("full", "fast"), default="full")
    parser.add_argument("--jobs", type=positive, default=default_jobs())
    parser.add_argument("--shard-timeout", type=positive_seconds, default=900, metavar="SECONDS",
                        help=("timeout per unittest process (default: 900 seconds; "
                              f"maximum: {MAX_SHARD_TIMEOUT} seconds)"))
    parser.add_argument("--stamp-status", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.stamp_status:
            if not (root / ".git").exists():
                print("stamp: not available (not a Git work tree)")
                return 1
            matches = stamp_matches(root)
            print(f"stamp: {'matches' if matches else 'missing or stale'}")
            return 0 if matches else 1
        return checks(root, args.tier, args.jobs, args.shard_timeout, args.all)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"check: {type(error).__name__}", file=sys.stderr)
        print("check: FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
