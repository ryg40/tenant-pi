#!/usr/bin/env python3
"""Detect, qualify and read Pi updates without changing an installed profile."""
import sys

sys.dont_write_bytecode = True

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.tenant_pi import _dir_state, _load_input
from scripts.validate import Invalid, absolute, fail, manifest, npm_parts

PACKAGE = "@earendil-works/pi-coding-agent"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?\Z")
PI_KEYS = ("PATH", "HOME", "TMPDIR", "LANG", "PI_CODING_AGENT_DIR",
           "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY")
OFFLINE = (
    ("unit-tests", ["-m", "unittest", "discover", "-s", "tests", "-q"]),
    ("examples", ["scripts/examples.py"]),
    ("validate", ["scripts/validate.py", "--overlay", "config/config.example.json"]),
    ("publish-check", ["scripts/publish_check.py"]),
    ("doc-check", ["scripts/doc_check.py"]),
)


def version(value):
    if not isinstance(value, str) or len(value) > 80 or not VERSION.fullmatch(value):
        fail("exact_version", "pi-update.version")
    return value


def registry_latest(name):
    """Public npm metadata only; do not inherit proxy credentials or npm configuration."""
    try:
        url = "https://registry.npmjs.org/" + quote(name, safe="") + "/latest"
        with build_opener(ProxyHandler({})).open(url, timeout=30) as response:
            data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            fail("registry_response", "pi-update.registry")
        return version(json.loads(data)["version"])
    except (OSError, ValueError, KeyError, TypeError):
        fail("registry_unavailable", "pi-update.registry")


def detect(*, latest=registry_latest):
    data = _load_input(str(ROOT / "config/manifest.json"), "manifest.file")
    manifest(data)
    rows = []
    for name in ["core", *sorted(set(data["components"]) - {"core"})]:
        source = data["components"][name]["source"]
        if not source or source["kind"] != "npm":
            continue
        package, pinned = npm_parts(source["spec"])
        newest = version(latest(package))
        rows.append({"component": name, "package": package, "spec": source["spec"],
                     "pinned": pinned, "latest": newest,
                     "different": pinned != newest if pinned else None})
    # An unpinned module has no old version to compare, so it cannot trigger exit 10.
    return {"action": "detect", "core": rows[0], "modules": rows[1:],
            "new": any(row["different"] is True for row in rows)}


def workspace(value):
    """Create a private run directory; refuse links and protected directory overlaps."""
    absolute(value, "pi-update.workdir")
    path = Path(value)
    home = os.environ.get("HOME")
    if not home or not Path(home).is_absolute():
        fail("home_required", "pi-update.home")
    live = Path(home) / ".pi/agent"
    for parent in (path, *path.parents):
        if parent.is_symlink():
            fail("unsafe_path", "pi-update.workdir")
    for protected in (ROOT, live.resolve()):
        if path.is_relative_to(protected) or protected.is_relative_to(path):
            fail("protected_path", "pi-update.workdir")
    if not path.parent.is_dir():
        fail("parent_missing", "pi-update.workdir")
    path.mkdir(mode=0o700, exist_ok=True)
    if not path.is_dir() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o022:
        fail("unsafe_permissions", "pi-update.workdir")
    run = Path(tempfile.mkdtemp(prefix="pi-update-", dir=path))
    for name in ("home", "tmp", "logs", "prefix", "cwd", "agent"):
        (run / name).mkdir(mode=0o700)
    return run, live


def environment(run):
    """An allow list, not a copy of the caller's environment."""
    directories = []
    for tool in ("node", "npm"):
        found = shutil.which(tool)
        if found:
            directories.append(str(Path(found).absolute().parent))
    return {"PATH": os.pathsep.join(dict.fromkeys([*directories, "/usr/bin", "/bin"])),
            "HOME": str(run / "home"), "TMPDIR": str(run / "tmp"), "LANG": "C.UTF-8",
            "PI_CODING_AGENT_DIR": str(run / "agent"),
            "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}


def execute(command, *, cwd, env, log, timeout=600):
    """Keep output in a log and stop the process group on a timeout (Linux/POSIX)."""
    with log.open("wb") as output:
        try:
            with subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                  stdout=output, stderr=subprocess.STDOUT,
                                  start_new_session=True) as process:
                try:
                    return process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    output.write(b"\nstep_timeout\n")
                    return 124
        except OSError:
            output.write(b"process_unavailable\n")
            return 127


class Steps:
    def __init__(self, run, env, *, runner=execute):
        self.run, self.env, self.runner = run, env, runner
        self.rows = []

    def command(self, name, command, *, cwd=None, env=None, timeout=600):
        log = self.run / "logs" / (name + ".log")
        code = self.runner(command, cwd=cwd or self.run / "cwd", env=env or self.env,
                           log=log, timeout=timeout)
        self.rows.append({"name": name, "exitCode": code, "log": str(log)})
        return code == 0

    def record(self, name, value, code=0):
        log = self.run / "logs" / (name + ".log")
        log.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
        self.rows.append({"name": name, "exitCode": code, "log": str(log)})
        return code == 0

    def skip(self, name):
        return self.record(name, {"error": "prerequisite_failed"}, 125)


def npm_command(run, *args):
    # Different empty files avoid npm's double-config-file refusal.
    for name in ("npm-user", "npm-global"):
        (run / name).touch(mode=0o600, exist_ok=True)
    return ["npm", "--userconfig=" + str(run / "npm-user"),
            "--globalconfig=" + str(run / "npm-global"), "--cache=" + str(run / "npm-cache"),
            "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", *args]


def install(steps, requested):
    return steps.command("install", npm_command(steps.run, "install", "--ignore-scripts",
                         "--prefix", str(steps.run / "prefix"), "--", PACKAGE + "@" + requested))


def pi_wrapper(run, env):
    """check-runtime supplies a new empty agent directory; env -i strips even Python flags."""
    pi = run / "prefix/node_modules/.bin/pi"
    wrapper = run / "pi-isolated"
    fields = [shlex.quote(key + "=" + value) for key, value in env.items() if key != "PI_CODING_AGENT_DIR"]
    wrapper.write_text('#!/bin/sh\nexec /usr/bin/env -i ' + " ".join(fields) +
                       ' PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" ' + shlex.quote(str(pi)) + ' "$@"\n')
    wrapper.chmod(0o700)
    return wrapper


def link_packages(run, package):
    """Replace only copied dependencies with the packages used by the candidate Pi."""
    modules = run / "prefix/node_modules"
    target = package / "node_modules/@earendil-works"
    target.mkdir(parents=True, exist_ok=True)
    versions = {}
    for name in ("pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"):
        source = modules / "@earendil-works/pi-coding-agent/node_modules/@earendil-works" / name
        if not source.is_dir():
            source = modules / "@earendil-works" / name
        if not source.is_dir():
            fail("dependency_missing", "pi-update.links")
        destination = target / name
        if destination.is_symlink():
            destination.unlink()
        elif destination.exists():
            shutil.rmtree(destination)
        destination.symlink_to(source, target_is_directory=True)
        versions[name] = json.loads((source / "package.json").read_text())["version"]
    return versions


def pin_contents(manifest_text, validator_text, requested):
    """Return the same two pin edits used by the update request adapter."""
    version(requested)
    data = json.loads(manifest_text)
    previous = version(data["runtime"]["piVersion"])
    if data["components"]["core"]["source"]["spec"] != PACKAGE + "@" + previous:
        fail("source_pin", "pi-update.candidate")
    old = '"core": {"kind": "npm", "spec": "' + PACKAGE + "@" + previous + '"}'
    if validator_text.count(old) != 1:
        fail("source_anchor", "pi-update.candidate")
    data["runtime"]["piVersion"] = requested
    data["components"]["core"]["source"]["spec"] = PACKAGE + "@" + requested
    return {"config/manifest.json": json.dumps(data, indent=2) + "\n",
            "scripts/validate.py": validator_text.replace(old, old.replace(PACKAGE + "@" + previous,
                                                                          PACKAGE + "@" + requested))}


class CandidateCopyError(Exception):
    def __init__(self, error, code):
        super().__init__(error)
        self.code = code


def candidate_copy(run, requested, env):
    """Copy tracked working-tree bytes, never Git metadata or installed dependencies."""
    excluded = {".git", ".local", "node_modules", "__pycache__"}
    if (ROOT / ".git").exists():
        try:
            result = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, env=env,
                                    stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        except OSError:
            raise CandidateCopyError("git_unavailable", 127) from None
        except subprocess.TimeoutExpired:
            raise CandidateCopyError("git_timeout", 124) from None
        except subprocess.SubprocessError:
            raise CandidateCopyError("git_failed", 1) from None
        if result.returncode:
            raise CandidateCopyError("git_failed", result.returncode)
        names = [Path(name) for name in os.fsdecode(result.stdout).split("\0") if name]
    else:
        # Without a Git index, copy every file outside the excluded directories.
        names = []
        for directory, dirs, files in os.walk(ROOT):
            dirs[:] = [name for name in dirs if name not in excluded]
            names.extend((Path(directory) / name).relative_to(ROOT) for name in files)
    candidate = run / "kit"
    candidate.mkdir()
    for name in names:
        if excluded.intersection(name.parts):
            continue
        source = ROOT / name
        if name.is_absolute() or ".." in name.parts or any(part.is_symlink() for part in (source, *source.parents)):
            fail("unsafe_source", "pi-update.candidate")
        destination = candidate / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    contents = pin_contents((candidate / "config/manifest.json").read_text(encoding="utf-8"),
                            (candidate / "scripts/validate.py").read_text(encoding="utf-8"), requested)
    for name, content in contents.items():
        (candidate / name).write_text(content, encoding="utf-8")
    return candidate


def isolation_result(before, after):
    left = {row["name"]: row for row in (before or {}).get("entries", [])}
    right = {row["name"]: row for row in (after or {}).get("entries", [])}
    return {"isolation": "unchanged" if before == after else "changed_unattributed",
            "changedEntries": sorted(name for name in left.keys() | right.keys() if left.get(name) != right.get(name))}


@contextmanager
def endpoint():
    """A fixed chat-completion response; no body, key or prompt is logged."""
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.path != "/v1/chat/completions" or not 0 < length <= 1024 * 1024:
                    raise ValueError
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                self.send_error(400)
                return
            if not isinstance(body, dict) or body.get("model") != "sum-model" or body.get("stream") is not True:
                self.send_error(400)
                return
            calls.append(True)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in (({"role": "assistant", "content": "43"}, None), ({}, "stop")):
                chunk = {"id": "local-test", "object": "chat.completion.chunk", "created": 1,
                         "model": "sum-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def print_check(steps, env, generated):
    if not generated:
        steps.skip("print-mode")
        steps.skip("print-response")
        return
    run = steps.run
    with endpoint() as (port, calls):
        models = {"providers": {"local-test": {"baseUrl": f"http://127.0.0.1:{port}/v1",
                   "api": "openai-completions", "apiKey": "none", "models": [{"id": "sum-model"}]}}}
        (run / "profile/models.json").write_text(json.dumps(models) + "\n")
        pi_env = {**env, "PI_CODING_AGENT_DIR": str(run / "profile")}
        command = ["/usr/bin/env", "-i", *(key + "=" + pi_env[key] for key in PI_KEYS),
                   str(run / "prefix/node_modules/.bin/pi"), "--no-approve", "--no-extensions",
                   "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
                   "--provider", "local-test", "--model", "sum-model", "-p",
                   "What is 17 plus 26? Reply with the number only."]
        passed = steps.command("print-mode", command, env=pi_env, timeout=90)
        reply = (run / "logs/print-mode.log").read_bytes()
        steps.record("print-response", {"requests": len(calls), "exactReply": reply == b"43\n"},
                     0 if passed and len(calls) == 1 and reply == b"43\n" else 1)


def qualify(requested, workdir, *, strict_baseline=False, runner=execute):
    version(requested)
    run, live = workspace(workdir)
    env = environment(run)
    steps = Steps(run, {**env, "PYTHONDONTWRITEBYTECODE": "1"}, runner=runner)
    before = _dir_state(str(live), "pi-update.baseline")
    steps.record("baseline-before", before)
    isolation = {"isolation": "unavailable", "changedEntries": []}
    try:
        candidate = candidate_copy(run, requested, steps.env)
        steps.record("candidate-copy", {"version": requested, "path": str(candidate)})
        installed = install(steps, requested)
        if installed:
            wrapper = pi_wrapper(run, env)
            steps.command("check-runtime", [sys.executable, "-B", str(candidate / "scripts/tenant_pi.py"),
                          "check-runtime", "--pi", str(wrapper)], cwd=candidate, timeout=90)
        else:
            steps.skip("check-runtime")
        for name, args in OFFLINE:
            steps.command(name, [sys.executable, "-B", *args], cwd=candidate)
        for name in ("tenantext", "promptr"):
            package = run / "packages" / name
            shutil.copytree(candidate / "packages" / name, package,
                            ignore=shutil.ignore_patterns("node_modules", "dist", ".git", ".local", "__pycache__"))
            ready = steps.command(name + "-install", npm_command(run, "ci", "--ignore-scripts"), cwd=package)
            linked = False
            if ready and installed:
                try:
                    steps.record(name + "-links", link_packages(run, package))
                    linked = True
                except (OSError, ValueError, KeyError, Invalid):
                    steps.record(name + "-links", {"error": "dependency_link_failed"}, 1)
            else:
                steps.skip(name + "-links")
            for task in (("build", "test") if name == "promptr" else ("typecheck", "test")):
                if linked:
                    steps.command(name + "-" + task, npm_command(run, "run", task), cwd=package)
                else:
                    steps.skip(name + "-" + task)
        data = _load_input(str(candidate / "config/config.example.json"), "overlay.file")
        data["target"]["agentDir"] = str(run / "profile")
        data["selection"]["enable"] = ["core"]
        (run / "overlay.json").write_text(json.dumps(data) + "\n")
        generated = steps.command("generate", [sys.executable, "-B", str(candidate / "scripts/tenant_pi.py"),
                                  "generate", "--overlay", str(run / "overlay.json"),
                                  "--target", str(run / "profile")], cwd=candidate)
        print_check(steps, env, generated and installed)
    except CandidateCopyError as exc:
        steps.record("candidate-copy", {"error": str(exc)}, exc.code)
    except (OSError, ValueError, Invalid, subprocess.SubprocessError):
        steps.record("qualification", {"error": "qualification_failed"}, 1)
    finally:
        try:
            after = _dir_state(str(live), "pi-update.baseline")
            steps.record("baseline-after", after)
            isolation = isolation_result(before, after)
            steps.record("baseline-compare", {**isolation, "present": before is not None},
                         1 if strict_baseline and before != after else 0)
        except (OSError, Invalid):
            steps.record("baseline-compare", {"error": "baseline_unreadable"}, 1)
    return {"action": "qualify", "version": requested, "workdir": str(run), "steps": steps.rows,
            "passed": all(row["exitCode"] == 0 for row in steps.rows),
            "strictBaseline": strict_baseline, **isolation}


def changelog_entries(text, start, end):
    """Select (start, end] in upstream release order; refuse missing or reversed bounds."""
    headings = list(re.finditer(r"^## \[([^\]]+)\][^\n]*$", text, re.M))
    labels = [match.group(1) for match in headings]
    if start not in labels or end not in labels or labels.index(end) > labels.index(start):
        fail("notes_range", "pi-update.notes")
    breaking, other = [], []
    for index in range(labels.index(end), labels.index(start)):
        body = text[headings[index].end():headings[index + 1].start()].strip()
        sections = re.split(r"(?=^### )", body, flags=re.M)
        for section in sections:
            if not section.strip():
                continue
            row = {"version": labels[index], "text": section.strip()}
            if re.match(r"### Breaking Changes\s*(?:\n|$)", section, flags=re.I):
                breaking.append(row)
            else:
                other.append(row)
    return {"breaking": bool(breaking), "entries": breaking + other}


def notes(start, end, workdir, *, runner=execute):
    version(start)
    version(end)
    run, _ = workspace(workdir)
    steps = Steps(run, environment(run), runner=runner)
    if not install(steps, end):
        return {"action": "notes", "from": start, "to": end, "workdir": str(run),
                "passed": False, "steps": steps.rows, "error": "install_failed"}
    path = run / "prefix/node_modules" / PACKAGE / "CHANGELOG.md"
    if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        fail("notes_missing", "pi-update.notes")
    result = changelog_entries(path.read_text(encoding="utf-8"), start, end)
    return {"action": "notes", "from": start, "to": end, "workdir": str(run),
            "passed": True, "steps": steps.rows, **result}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        fail("arguments", "pi-update.cli")


def main(argv=None, *, latest=registry_latest):
    parser = Parser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("detect")
    qual = actions.add_parser("qualify")
    qual.add_argument("--version", required=True)
    qual.add_argument("--workdir", required=True)
    qual.add_argument("--strict-baseline", action="store_true")
    read = actions.add_parser("notes")
    read.add_argument("--from", dest="start", required=True)
    read.add_argument("--to", dest="end", required=True)
    read.add_argument("--workdir", required=True)
    try:
        args = parser.parse_args(argv)
        if args.action == "detect":
            report = detect(latest=latest)
            code = 10 if report["new"] else 0
        elif args.action == "qualify":
            report = qualify(args.version, args.workdir, strict_baseline=args.strict_baseline)
            code = 0 if report["passed"] else 1
        else:
            report = notes(args.start, args.end, args.workdir)
            code = 0 if report["passed"] else 1
    except Invalid as exc:
        report, code = {"error": str(exc)}, 2
    except (OSError, ValueError):
        report, code = {"error": "operation_failed: pi-update"}, 2
    print(json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
