#!/usr/bin/env python3
"""Run the offline checks and record clean full runs in local Git metadata."""
import argparse
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
import sys
import time

CHECK_SET_VERSION = 1
MAX_SHARD_TIMEOUT = 86_400
ROOT = Path(__file__).resolve().parents[1]
CHECKS = (
    ("publish", (sys.executable, "scripts/publish_check.py")),
    ("public", (sys.executable, "scripts/publish_check.py", "--public")),
    ("diff", ("git", "diff", "--check")),
)


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


def checks(root, tier, jobs, shard_timeout=900):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", TENANT_PI_TIER=tier)
    in_git = (root / ".git").exists()
    before = clean_tree(root) if in_git else None
    started = time.monotonic()
    modules = sorted(path.stem for path in (root / "tests").glob("test*.py"))

    def shard(module):
        try:
            return run((sys.executable, "-m", "unittest", f"tests.{module}", "-q"),
                       root, env, timeout=shard_timeout)
        except subprocess.TimeoutExpired:
            return None

    tests = skipped = 0
    passed = bool(modules)
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        for module, result in zip(modules, pool.map(shard, modules)):
            if result is None:
                passed = False
                print(f"unittest tests.{module}: FAILED (timed out after {shard_timeout:g}s)",
                      file=sys.stderr)
                continue
            count, skip, success = unit_summary(result)
            tests += count
            skipped += skip
            passed = passed and success
            if not success:
                print(f"unittest tests.{module}: FAILED", file=sys.stderr)
                print(result.stdout + result.stderr, file=sys.stderr, end="")
    lines = [f"Ran {tests} tests in {time.monotonic() - started:.3f}s",
             (f"OK (skipped={skipped})" if skipped else "OK") if passed else "FAILED"]
    for line in lines:
        print(line, flush=True)
    for name, command in CHECKS:
        if name == "diff" and not in_git:
            print("diff: skipped (not a Git work tree)", flush=True)
            continue
        result = run(command, root, env)
        success = result.returncode == 0
        passed = passed and success
        line = f"{name}: {'passed' if success else 'FAILED'}"
        lines.append(line)
        print(line, flush=True)
        if not success:
            print(result.stdout + result.stderr, file=sys.stderr, end="")
    lines.append(f"check: {'passed' if passed else 'FAILED'}")
    if passed and tier == "full" and before and clean_tree(root) == before:
        stamp = {"checkSetVersion": CHECK_SET_VERSION, "python": platform.python_version(),
                 "client": client(), "skipped": skipped, "tests": tests,
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
    parser = argparse.ArgumentParser(description=__doc__)
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
        return checks(root, args.tier, args.jobs, args.shard_timeout)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"check: {type(error).__name__}", file=sys.stderr)
        print("check: FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
