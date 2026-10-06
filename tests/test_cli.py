"""End-to-end, disposable-home CLI safety checks; no live client inputs."""
import copy
import errno
import hashlib
import json
import os
import shlex
import shutil
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import tenant_pi
from scripts.profile_plan import PROVIDER_KEY_NAMES
from scripts.profile_write import WriteError
from scripts.check_runtime import parse_range
from scripts.validate import SAMPLE_TARGET, load
from tests.test_model_routes import NATIVE, GATEWAY, REGISTRY

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
RUNTIME = load(ROOT / "config/manifest.json")["runtime"]
OUTSIDE = ".".join(map(str, parse_range(RUNTIME["piAcceptedRange"], "f")[1]))
_lower = parse_range(RUNTIME["piAcceptedRange"], "f")[0]
IN_RANGE = ".".join(map(str, (*_lower[:2], _lower[2] + 1)))


def ignored_paths(root):
    """The paths under `root` that Git ignores, relative to it; None when `root` is not the top of a checkout.

    An ignored directory is one entry. Git does not list what is inside it.
    """
    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, text=True, capture_output=True)
        if top.returncode != 0 or Path(top.stdout.strip()).resolve() != Path(root).resolve():
            return None
        result = subprocess.run(["git", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
                                cwd=root, text=True, capture_output=True)
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return {name.rstrip("/") for name in result.stdout.split("\0") if name}


def inventory(root):
    """Mode and content hash of each path under `root`.

    In a Git checkout, the paths that Git ignores (`.local/`, `node_modules/`) and `.git` are left out:
    another session can write there during a test. Without Git, the walk takes every path.
    """
    ignored = ignored_paths(root)
    if ignored is None:
        return {str(p.relative_to(root)): (os.lstat(p).st_mode,
                hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None)
                for p in root.rglob("*")}
    ignored.add(".git")
    found = {}
    for directory, directories, files in os.walk(root):
        relative = Path(directory).relative_to(root)
        # Do not go down into an ignored directory.
        directories[:] = [name for name in directories if (relative / name).as_posix() not in ignored]
        for name in (*directories, *files):
            if (relative / name).as_posix() not in ignored:
                p = Path(directory) / name
                found[str(p.relative_to(root))] = (os.lstat(p).st_mode,
                                                   hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None)
    return found


class InventoryTests(unittest.TestCase):
    def test_file_that_git_ignores_leaves_the_inventory_unchanged(self):
        if ignored_paths(ROOT) is None:
            self.skipTest("no Git checkout: the inventory takes every path")
        before = inventory(ROOT)
        local = ROOT / ".local"
        created = not local.exists()
        local.mkdir(exist_ok=True)
        self.addCleanup(lambda: created and not any(local.iterdir()) and local.rmdir())
        planted = Path(tempfile.mkdtemp(prefix="inventory-test-", dir=local))
        self.addCleanup(shutil.rmtree, planted)
        (planted / "log.txt").write_text("written by another session\n")
        self.assertTrue((planted / "log.txt").is_file())
        self.assertEqual(before, inventory(ROOT))
        self.assertFalse(any(name == ".git" or name.startswith((".git/", ".local")) for name in before))

    def test_inventory_of_a_temporary_checkout_and_of_a_plain_directory(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-inventory-") as temp:
            plain, checkout = Path(temp) / "plain", Path(temp) / "checkout"
            for root in (plain, checkout):
                (root / ".local/coordination").mkdir(parents=True)
                (root / ".gitignore").write_text(".local/\n*.pyc\n")
                (root / "kept.txt").write_text("a\n")
            # Without Git metadata, the walk takes every path.
            self.assertIsNone(ignored_paths(plain))
            self.assertEqual({".gitignore", "kept.txt", ".local", ".local/coordination"}, set(inventory(plain)))
            if subprocess.run(["git", "init", "-q", str(checkout)], capture_output=True).returncode != 0:
                self.skipTest("git is not available")
            before = inventory(checkout)
            self.assertEqual({".gitignore", "kept.txt"}, set(before))
            (checkout / ".local/coordination/log.txt").write_text("b\n")
            (checkout / "module.pyc").write_text("c\n")
            self.assertEqual(before, inventory(checkout))
            # A file that Git does not ignore, an empty directory and a changed file are still seen.
            (checkout / "new.txt").write_text("d\n")
            (checkout / "empty").mkdir()
            self.assertEqual({"new.txt", "empty"}, set(inventory(checkout)) - set(before))
            (checkout / "kept.txt").write_text("changed\n")
            self.assertNotEqual(before["kept.txt"], inventory(checkout)["kept.txt"])

    def test_inventory_without_a_git_binary_is_the_full_walk(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-inventory-") as temp:
            root = Path(temp)
            (root / ".local").mkdir()
            (root / ".gitignore").write_text(".local/\n")
            (root / ".local/log.txt").write_text("a\n")
            with patch.dict(os.environ, {"PATH": "/nonexistent"}):
                self.assertIsNone(ignored_paths(ROOT))
                self.assertEqual({".gitignore", ".local", ".local/log.txt"}, set(inventory(root)))


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-cli-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.home.mkdir(mode=0o700)
        self.old = self.home / ".pi/agent"
        self.old.mkdir(parents=True, mode=0o700)
        (self.old / "settings.json").write_text("OLD")
        self.parent = self.base / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.target = self.parent / "new profile"
        self.manifest = self.base / "manifest.json"
        self.manifest.write_bytes((ROOT / "config/manifest.json").read_bytes())
        self.overlay = self.base / "overlay.json"
        self.data = load(ROOT / "config/config.example.json")
        self.data["target"]["agentDir"] = str(self.target)
        self.save()
        self.sentinel = self.base / "outside"
        self.sentinel.write_text("KEEP")
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("pi", "npm", "node", "git", "sh", "curl"):
            command = self.bin / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base / "called") + "'\n")
            command.chmod(0o700)
        # This fixture blocks network and process creation inside the CLI process.
        # It loads before the CLI, so suppress bytecode in the hook itself.
        hook = self.base / "sitecustomize.py"
        hook.write_text("import sys\nsys.dont_write_bytecode = True\n"
                        "import socket, subprocess\n"
                        "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
                        "socket.socket.connect = blocked\nsubprocess.Popen = blocked\n")
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(self.bin),
                        PYTHONPATH=str(self.base))
        self.env["PYTHONDONTWRITEBYTECODE"] = "1"
        # A call of `tenant_pi.main` in the test process reads `HOME` too: the disposable one, never the real one.
        home = patch.dict(os.environ, {"HOME": str(self.home)})
        home.start()
        self.addCleanup(home.stop)

    def save(self):
        self.overlay.write_text(json.dumps(self.data), encoding="utf-8")

    def run_cli(self, action, *extra, overlay=None, manifest=None, env=None):
        return subprocess.run([sys.executable, str(CLI), action,
                               "--overlay", str(self.overlay if overlay is None else overlay),
                               "--manifest", str(self.manifest if manifest is None else manifest), *extra],
                              cwd=self.base, env=self.env if env is None else env,
                              text=True, capture_output=True, check=False)

    def check_unchanged(self, before_source, before_fixture):
        self.assertEqual(before_source, inventory(ROOT))
        self.assertEqual(before_fixture, inventory(self.base))
        self.assertFalse((self.base / "called").exists())

    def test_help_validate_plan_read_only_and_no_bytecode(self):
        direct_env = dict(self.env)
        direct_env.pop("PYTHONPATH")
        direct_env.pop("PYTHONDONTWRITEBYTECODE")
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        help_result = subprocess.run([sys.executable, str(CLI), "--help"], cwd=self.base,
                                     env=direct_env, text=True, capture_output=True)
        self.assertEqual(0, help_result.returncode)
        self.assertIn("generate", help_result.stdout)
        valid = self.run_cli("validate", env=direct_env)
        self.assertEqual(0, valid.returncode, valid.stderr)
        self.assertTrue(json.loads(valid.stdout)["valid"])
        self.assertNotIn("complete", valid.stdout)
        result = self.run_cli("plan", env=direct_env)
        self.assertEqual(0, result.returncode, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual([".", ".tenant-pi", ".tenant-pi/choices.json", "settings.json", ".tenant-pi/state.json"],
                         [f["path"] for f in plan["files"]])
        self.assertEqual("not_runnable_until_generation_succeeds", plan["commands"]["launchStatus"])
        self.assertEqual(["target_absence_unverified", "node_runtime_unverified", "core_runtime_unverified"],
                         [g["code"] for g in plan["readinessGaps"]])
        self.assertNotIn("complete", result.stdout)
        self.check_unchanged(before_source, before_fixture)

    def test_generate_private_modes_deterministic_and_omitted_components(self):
        self.data["selection"] = {"enable": ["core", "model-routing", "codex-accounts"], "disable": []}
        self.data["roles"] = {"interactive": {"provider": "example", "model": "org/model:v2", "thinking": "xhigh"},
                              "worker": {"provider": "example", "model": "org/worker", "thinking": "minimal"}}
        self.save()
        before_source = inventory(ROOT)
        old = os.umask(0)
        try:
            result = self.run_cli("generate", "--target", str(self.target))
        finally:
            os.umask(old)
        self.assertEqual(0, result.returncode, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual((True, True), (output["candidate_created"], output["complete"]))
        self.assertEqual("manual_review_required", output["commands"]["launchStatus"])
        settings = json.loads((self.target / "settings.json").read_text())
        choices = json.loads((self.target / ".tenant-pi/choices.json").read_text())
        self.assertEqual("org/model:v2", settings["defaultModel"])
        self.assertEqual([{"source": str(ROOT / "packages/tenantext"),
                           **load(self.manifest)["components"]["codex-accounts"]["resources"]}], settings["packages"])
        self.assertEqual(self.data["roles"], choices["overlay"]["roles"])
        self.assertEqual([], choices["pendingPackages"])
        self.assertEqual("complete", json.loads((self.target / ".tenant-pi/state.json").read_text())["status"])
        for name in ("settings.json", ".tenant-pi/choices.json", ".tenant-pi/state.json"):
            self.assertEqual(0o600, stat.S_IMODE((self.target / name).stat().st_mode))
        for name in (".", ".tenant-pi"):
            self.assertEqual(0o700, stat.S_IMODE((self.target / name).stat().st_mode))
        for name in ("settings.json", ".tenant-pi/choices.json"):
            content = settings if name == "settings.json" else choices
            self.assertEqual((json.dumps(content, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n").encode(),
                             (self.target / name).read_bytes())
        self.assertIn({"code": "credential_missing", "subject": "TENANTEXT_LITELLM_API_KEY"}, output["readinessGaps"])
        self.assertIn({"code": "role_activation_unavailable", "subject": "worker"}, output["readinessGaps"])
        self.assertEqual(before_source, inventory(ROOT))
        self.assertEqual("OLD", (self.old / "settings.json").read_text())
        self.assertEqual("KEEP", self.sentinel.read_text())
        self.assertFalse((self.base / "called").exists())

    def test_generate_records_time_and_kit_commit_without_a_process(self):
        from contextlib import redirect_stdout
        from datetime import datetime, timezone
        from io import StringIO
        fixed = datetime(2026, 10, 2, 8, 0, 0, tzinfo=timezone.utc)
        with patch.object(tenant_pi, "_kit_commit", return_value="b" * 40), redirect_stdout(StringIO()):
            code = tenant_pi.main(["generate", "--overlay", str(self.overlay), "--manifest", str(self.manifest),
                                   "--target", str(self.target)], clock=lambda: fixed)
        self.assertEqual(0, code)
        record = json.loads((self.target / ".tenant-pi/state.json").read_text())["provenance"]
        self.assertEqual(("2026-10-02T08:00:00Z", "b" * 40), (record["generatedAt"], record["kitCommit"]))
        # The real path: the sitecustomize fixture blocks every process, and the commit is the kit's own.
        other = self.parent / "other"
        self.data["target"]["agentDir"] = str(other)
        self.save()
        result = self.run_cli("generate", "--target", str(other))
        self.assertEqual(0, result.returncode, result.stderr)
        record = json.loads((other / ".tenant-pi/state.json").read_text())["provenance"]
        self.assertEqual(tenant_pi._kit_commit(), record["kitCommit"])
        self.assertRegex(record["generatedAt"], r"\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
        self.assertNotIn("generatedAt", result.stdout)
        self.assertFalse((self.base / "called").exists())

    def runtime_report(self, pi="match", node="match", name="runtime.json"):
        """A `check-runtime` report file for the kit manifest, with one installed version for each status."""
        runtime = load(self.manifest)["runtime"]
        installed = {"pi": {"match": runtime["piVersion"], "mismatch": OUTSIDE, "untested_in_range": IN_RANGE, "missing": None},
                     "node": {"match": "22.22.2", "mismatch": "24.1.0", "missing": None}}
        path = self.base / name
        path.write_text(json.dumps({
            "pi": {"installed": installed["pi"][pi], "required": runtime["piVersion"], "status": pi,
                   "tested": runtime["piVersion"], "acceptedRange": runtime["piAcceptedRange"]},
            "node": {"installed": installed["node"][node], "required": runtime["nodeRange"], "status": node},
            "python": {"installed": "3.14.7", "required": runtime["pythonRange"], "status": "match"}}))
        return path

    def test_runtime_report_changes_the_gaps_and_not_the_generated_files(self):
        core = load(self.manifest)["components"]["core"]["source"]["spec"]
        pin = load(self.manifest)["runtime"]["piVersion"]
        absent = {"code": "target_absence_unverified", "subject": str(self.target)}
        unverified = [{"code": "node_runtime_unverified", "subject": ">=22.22.0 <23"},
                      {"code": "core_runtime_unverified", "subject": core}]
        mismatch = {"code": "core_runtime_mismatch", "subject": core, "installed": OUTSIDE, "required": pin}
        before_source, before_fixture = inventory(ROOT), None
        # Node matches, Pi is another version.
        report = self.runtime_report(pi="mismatch")
        before_fixture = inventory(self.base)
        plan = self.run_cli("plan", "--runtime-report", str(report))
        self.assertEqual(0, plan.returncode, plan.stderr)
        preview = json.loads(plan.stdout)
        self.assertEqual(([absent, mismatch], False, False),
                         (preview["readinessGaps"], preview["runtimeReady"], preview["filesComplete"]))
        self.check_unchanged(before_source, before_fixture)
        result = self.run_cli("generate", "--target", str(self.target), "--runtime-report", str(report))
        self.assertEqual(0, result.returncode, result.stderr)
        output = json.loads(result.stdout)
        # The target that `generate` has just created is not an open gap; the Pi fact stays.
        self.assertEqual(([mismatch], False, True),
                         (output["readinessGaps"], output["runtimeReady"], output["filesComplete"]))
        with_report = {name: (self.target / name).read_bytes() for name in ("settings.json", ".tenant-pi/choices.json")}
        state = json.loads((self.target / ".tenant-pi/state.json").read_text())
        for text in (*map(bytes.decode, with_report.values()), json.dumps(state)):
            self.assertNotIn(OUTSIDE, text)
            self.assertNotIn("runtime_mismatch", text)
        # Without a report, the same target gets the same bytes and the two runtime gaps stay.
        shutil.rmtree(self.target)
        result = self.run_cli("generate", "--target", str(self.target))
        self.assertEqual(0, result.returncode, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual((unverified, False, True),
                         (output["readinessGaps"], output["runtimeReady"], output["filesComplete"]))
        self.assertEqual(with_report, {name: (self.target / name).read_bytes() for name in with_report})
        again = json.loads((self.target / ".tenant-pi/state.json").read_text())
        for record in (state, again):
            record["provenance"].pop("generatedAt")
        self.assertEqual(state, again)
        # A match for Node and Pi after a complete generation leaves no gap. `runtimeReady` stays false.
        shutil.rmtree(self.target)
        result = self.run_cli("generate", "--target", str(self.target), "--runtime-report", str(self.runtime_report()))
        self.assertEqual(0, result.returncode, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(([], False, True), (output["readinessGaps"], output["runtimeReady"], output["filesComplete"]))
        self.assertEqual(with_report, {name: (self.target / name).read_bytes() for name in with_report})
        plan = json.loads(self.run_cli("plan", "--runtime-report", str(self.base / "runtime.json")).stdout)
        self.assertEqual(([absent], False), (plan["readinessGaps"], plan["runtimeReady"]))
        # An absent Pi and another gap of the profile.
        other = self.parent / "other"
        self.data["target"]["agentDir"] = str(other)
        self.data["selection"]["disable"].remove("doctor")
        self.data["selection"]["enable"].append("doctor")
        self.save()
        result = self.run_cli("generate", "--target", str(other), "--runtime-report",
                              str(self.runtime_report(pi="missing", node="mismatch")))
        self.assertEqual(0, result.returncode, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual([{"code": "node_runtime_mismatch", "subject": ">=22.22.0 <23", "installed": "24.1.0",
                           "required": ">=22.22.0 <23"},
                          {"code": "core_runtime_missing", "subject": core, "installed": None, "required": pin}],
                         output["readinessGaps"][:2])
        self.assertIn({"code": "package_runtime_unverified", "subject": "doctor"}, output["readinessGaps"])
        self.assertFalse(output["runtimeReady"])
        # The fixture blocks every process of the CLI, and no fake command ran.
        self.assertFalse((self.base / "called").exists())
        self.assertEqual("OLD", (self.old / "settings.json").read_text())

    def test_accepted_untested_pi_gap_and_plain_install_line_in_plan_and_generate(self):
        runtime = load(self.manifest)["runtime"]
        core = load(self.manifest)["components"]["core"]["source"]["spec"]
        report = self.runtime_report(pi="untested_in_range")
        expected = {"code": "core_runtime_untested_in_range", "subject": core,
                    "installed": IN_RANGE, "required": runtime["piVersion"], "tested": runtime["piVersion"],
                    "acceptedRange": runtime["piAcceptedRange"],
                    "fact": "The installed Pi is accepted by the range rule. The kit tests ran on the tested version only."}
        for action, extra in (("plan", ()), ("generate", ("--target", str(self.target)))):
            with self.subTest(action=action):
                result = self.run_cli(action, *extra, "--runtime-report", str(report))
                self.assertEqual(0, result.returncode, result.stderr)
                output = json.loads(result.stdout)
                self.assertIn(expected, output["readinessGaps"])
                self.assertFalse(output["runtimeReady"])
                mark = output["commands"]["piInstall"]
                self.assertEqual("not_needed", mark["status"])
                self.assertIsNone(mark["change"])
                self.assertEqual("npm install --global -- " + core, mark["command"])
                self.assertNotIn(mark["command"], output["commands"]["setupDisplayOnly"])
        choices = json.loads((self.target / ".tenant-pi/choices.json").read_text())
        self.assertNotIn("untested_in_range", json.dumps(choices))
        self.assertFalse((self.base / "called").exists())

    def test_pi_install_line_is_marked_and_is_no_default_step_for_another_installed_pi(self):
        pin = load(self.manifest)["runtime"]["piVersion"]
        line = "npm install --global -- @earendil-works/pi-coding-agent@" + pin
        warning = "global_install_replaces_pi_for_all_profiles"

        def commands(action, *extra):
            result = self.run_cli(action, *extra)
            self.assertEqual(0, result.returncode, result.stderr)
            found = json.loads(result.stdout)["commands"]
            return found["setupDisplayOnly"], found["piInstall"]

        # No report: the line stays, with the mark that the installed version is not known.
        self.assertEqual(([line], {"command": line, "status": "installed_version_unknown", "installed": None,
                                   "required": pin, "change": None, "warning": warning}), commands("plan"))
        # A newer Pi is installed. The line is not in the default steps.
        newer = self.runtime_report(pi="mismatch")
        replaced = ([], {"command": line, "status": "replaces_installed", "installed": OUTSIDE, "required": pin,
                         "change": "downgrade", "warning": warning})
        self.assertEqual(replaced, commands("plan", "--runtime-report", str(newer)))
        self.assertEqual(replaced, commands("generate", "--target", str(self.target), "--runtime-report", str(newer)))
        self.assertEqual(([], {"command": line, "status": "not_needed", "installed": pin, "required": pin,
                               "change": None, "warning": warning}),
                         commands("plan", "--runtime-report", str(self.runtime_report())))
        self.assertEqual(([line], {"command": line, "status": "needed", "installed": None, "required": pin,
                                   "change": None, "warning": warning}),
                         commands("plan", "--runtime-report", str(self.runtime_report(pi="missing"))))
        # The mark is output only: the private record keeps the plain plan, and no command ran.
        self.assertNotIn("replaces_installed", (self.target / ".tenant-pi/choices.json").read_text())
        self.assertFalse((self.base / "called").exists())

    def test_bad_runtime_report_stops_before_any_write(self):
        good = json.loads(self.runtime_report().read_text())
        report = self.base / "report.json"
        link = self.base / "report-link.json"
        link.symlink_to(self.base / "runtime.json")
        stale = copy.deepcopy(good)
        stale["pi"]["required"] = "0.99.2"
        stale_range = copy.deepcopy(good)
        stale_range["pi"]["acceptedRange"] = ">=0.0.0 <99"
        wrong = copy.deepcopy(good)
        wrong["pi"]["installed"] = OUTSIDE
        leak = copy.deepcopy(good)
        leak["pi"]["installed"] = "CANARY_SECRET"
        cases = ((b'{"CANARY_SECRET":', "invalid_json: runtime_report.file"),
                 (b'{"pi":1,"pi":2}', "duplicate_key"),
                 (b" " * (tenant_pi.MAX_INPUT + 1), "input_too_large: runtime_report.file"),
                 (b"[]", "object: runtime_report"),
                 (b'{"pi":{}}', "required_fields: runtime_report"),
                 (json.dumps({**good, "CANARY_SECRET": 1}).encode(), "unknown_fields: runtime_report"),
                 (json.dumps(stale).encode(), "runtime_report_required: runtime_report.pi.required"),
                 (json.dumps(stale_range).encode(), "runtime_report_required: runtime_report.pi.acceptedRange"),
                 (json.dumps(wrong).encode(), "runtime_report_status: runtime_report.pi.status"),
                 (json.dumps(leak).encode(), "runtime_report_installed: runtime_report.pi.installed"))
        for action in ("plan", "generate"):
            extra = ("--target", str(self.target)) if action == "generate" else ()
            for payload, rule in cases:
                with self.subTest(action=action, rule=rule):
                    report.write_bytes(payload)
                    before = inventory(self.base)
                    result = self.run_cli(action, *extra, "--runtime-report", str(report))
                    self.assertEqual(2, result.returncode)
                    self.assertIn(rule, json.loads(result.stderr)["error"])
                    self.assertFalse(json.loads(result.stderr)["candidate_created"])
                    self.assertEqual("", result.stdout)
                    self.assertNotIn("CANARY_SECRET", result.stderr)
                    self.assertNotIn("Traceback", result.stderr)
                    self.check_unchanged(inventory(ROOT), before)
            for path, rule in ((link, "input_not_regular: runtime_report.file"),
                               (self.base / "absent.json", "input_missing: runtime_report.file"),
                               ("relative.json", "input_missing: runtime_report.file")):
                result = self.run_cli(action, *extra, "--runtime-report", str(path))
                self.assertEqual((2, {"candidate_created": False, "error": rule}),
                                 (result.returncode, json.loads(result.stderr)))
        self.assertFalse(self.target.exists())
        # An invalid overlay is reported before the report; `validate` does not take the option.
        report.write_bytes(b"[]")
        self.data["unknown"] = 1
        self.save()
        self.assertIn("unknown_fields: overlay", self.run_cli("plan", "--runtime-report", str(report)).stderr)
        refused = self.run_cli("validate", "--runtime-report", str(report))
        self.assertEqual(2, refused.returncode)
        self.assertIn("unrecognized arguments", refused.stderr)

    def test_route_registry_cli_end_to_end_and_blocked_login(self):
        registry = self.base / "registry.json"
        registry.write_text(json.dumps(REGISTRY))
        self.data["selection"] = {"enable": ["core", "model-routing", "codex-accounts"], "disable": []}
        self.data["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": {"auth": "env"}}
        self.data["endpoints"] = {"codex-accounts": "https://gateway.example.invalid/v1"}
        self.data["env"] = {"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"}
        self.data["roles"] = {"interactive": copy.deepcopy(NATIVE), "review": copy.deepcopy(GATEWAY)}
        self.save()
        self.assertIn("registry_required", self.run_cli("plan").stderr)
        self.assertIn("required_roles", self.run_cli("plan", "--require-role", "unknown", "--registry", str(registry)).stderr)
        plan = self.run_cli("plan", "--registry", str(registry), "--require-role", "worker")
        self.assertEqual(0, plan.returncode, plan.stderr)
        preview = json.loads(plan.stdout)
        self.assertFalse(preview["filesComplete"])
        self.assertFalse(preview["runtimeReady"])
        self.assertEqual("required_missing", preview["routeStatus"]["worker"])
        self.assertIn({"code": "credential_missing", "subject": "TENANTEXT_LITELLM_API_KEY"}, preview["readinessGaps"])
        self.assertEqual(["TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1", "env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=" + str(self.target), "pi", "--no-approve"], shlex.split(preview["commands"]["launchDisplayOnly"]))
        result = self.run_cli("generate", "--registry", str(registry), "--require-role", "worker", "--target", str(self.target))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(json.loads(result.stdout)["filesComplete"])
        self.assertEqual("team/slash-id", json.loads((self.target / "settings.json").read_text())["defaultModel"])
        self.assertEqual(["fake-native/team/slash-id"], json.loads((self.target / "settings.json").read_text())["enabledModels"])
        self.assertFalse((self.target / "models.json").exists())
        self.assertFalse((self.target / "auth.json").exists())
        self.assertEqual("OLD", (self.old / "settings.json").read_text())
        self.assertEqual("KEEP", self.sentinel.read_text())
        self.data["target"]["agentDir"] = str(self.parent / "blocked profile")
        self.data["modelRoutes"]["gateway"] = {"auth": "login"}
        self.data["env"] = {}
        self.save()
        blocked = self.run_cli("plan", "--registry", str(registry))
        self.assertEqual(0, blocked.returncode, blocked.stderr)
        self.assertIn({"code": "pi_login_blocked", "subject": "litellm-codex"}, json.loads(blocked.stdout)["readinessGaps"])
        self.assertEqual("pi_login_blocked", json.loads(blocked.stdout)["routeSetup"][-1]["method"])
        self.assertNotIn("/login litellm-codex", blocked.stdout)
        blocked_target = self.parent / "blocked profile"
        generated = self.run_cli("generate", "--registry", str(registry), "--target", str(blocked_target))
        self.assertEqual(2, generated.returncode)
        self.assertEqual({"candidate_created": False, "error": "pi_login_blocked: overlay.modelRoutes.gateway.auth"}, json.loads(generated.stderr))
        self.assertFalse(blocked_target.exists())
        self.assertEqual("KEEP", self.sentinel.read_text())

    def test_route_invalid_choices_registry_and_gateway_disabled(self):
        self.data["selection"] = {"enable": ["core", "model-routing"], "disable": []}
        self.data["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": None}
        self.save()
        registry = self.base / "registry.json"
        registry.write_text("{}")
        self.assertIn("unsupported_model_thinking", self.run_cli("plan", "--registry", str(registry)).stderr)
        registry.write_text(json.dumps(REGISTRY))
        self.data["modelRoutes"]["cycle"][0]["thinking"] = "CANARY_SECRET"
        self.save()
        invalid = self.run_cli("generate", "--registry", str(registry), "--target", str(self.target))
        self.assertIn("thinking", invalid.stderr)
        self.assertNotIn("CANARY_SECRET", invalid.stderr)
        self.assertFalse(self.target.exists())
        self.data["modelRoutes"]["cycle"] = [copy.deepcopy(GATEWAY)]
        self.save()
        self.assertIn("gateway_disabled", self.run_cli("plan", "--registry", str(registry)).stderr)

    def test_registry_parser_boundaries_and_redaction(self):
        self.data["selection"] = {"enable": ["core", "model-routing"], "disable": []}
        self.data["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": None}
        self.save()
        registry = self.base / "registry.json"
        link = self.base / "registry-link.json"
        link.symlink_to(registry)
        fifo = self.base / "registry-fifo.json"
        os.mkfifo(fifo)
        for payload, rule in ((b'{"fake-native":{},"fake-native":{}}', "duplicate_key"),
                              (b"[" * 1200 + b"0" + b"]" * 1200, "input_too_deep"),
                              # The kit's own nesting bound, the same on each Python version.
                              (b"[" * (tenant_pi.MAX_DEPTH + 1) + b"0" + b"]" * (tenant_pi.MAX_DEPTH + 1), "input_too_deep"),
                              (b"[" * tenant_pi.MAX_DEPTH + b"0" + b"]" * tenant_pi.MAX_DEPTH, "mock_registry"),
                              (b'{"x":' + b"9" * 5000 + b'}', "number: registry.file"),
                              (b" " * (tenant_pi.MAX_INPUT + 1), "input_too_large"),
                              (b'{"CANARY_SECRET":', "invalid_json")):
            registry.write_bytes(payload)
            before = inventory(self.base)
            result = self.run_cli("plan", "--registry", str(registry))
            self.assertEqual(2, result.returncode)
            self.assertIn(rule, result.stderr)
            self.assertNotIn("CANARY_SECRET", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.check_unchanged(inventory(ROOT), before)
        registry.write_text(json.dumps(REGISTRY))
        for path in (link, fifo):
            self.assertIn("input_not_regular", self.run_cli("plan", "--registry", str(path)).stderr)
        parent_link = self.base / "registry-linked-parent"
        parent_link.symlink_to(self.base, target_is_directory=True)
        self.assertIn("input_path_unsafe: registry.file",
                      self.run_cli("plan", "--registry", str(parent_link / "registry.json")).stderr)
        env = dict(self.env)
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONDONTWRITEBYTECODE", None)
        self.assertEqual(0, self.run_cli("plan", "--registry", str(registry), env=env).returncode)

    def test_bounded_parser_failures_do_not_change_files(self):
        for field in ("overlay", "manifest"):
            over = tenant_pi.MAX_DEPTH + 1
            for content, rule in (("[" * 1200 + "0" + "]" * 1200, "input_too_deep"),
                                  ("[" * over + "0" + "]" * over, "input_too_deep"),
                                  ("{\"a\":" * over + "0" + "}" * over, "input_too_deep"),
                                  ("{\"a\":" + "9" * 5000 + "}", "number")):
                with self.subTest(field=field, payload=content[:1], size=len(content)):
                    source = self.overlay if field == "overlay" else self.manifest
                    source.write_text(content)
                    before_source, before_fixture = inventory(ROOT), inventory(self.base)
                    result = self.run_cli("plan")
                    self.assertEqual(2, result.returncode)
                    self.assertEqual({"candidate_created": False, "error": rule + ": " + field + ".file"},
                                     json.loads(result.stderr))
                    self.assertEqual("", result.stdout)
                    self.assertNotIn("Traceback", result.stderr)
                    self.check_unchanged(before_source, before_fixture)
                    source.write_bytes((ROOT / ("config/config.example.json" if field == "overlay" else "config/manifest.json")).read_bytes())
                    if field == "overlay":
                        self.save()

    def test_invalid_json_and_private_values_never_logged(self):
        for content, rule in (('{"a":1,"a":2}', "duplicate_key"),
                              ('{"secret":"CANARY_SECRET"}', "unknown_fields"),
                              ('{"CANARY_SECRET": ', "invalid_json")):
            with self.subTest(rule=rule):
                self.overlay.write_text(content)
                result = self.run_cli("plan")
                self.assertEqual(2, result.returncode)
                self.assertIn(rule, result.stderr)
                self.assertNotIn("CANARY_SECRET", result.stderr + result.stdout)
                self.assertFalse(self.target.exists())
        self.data["unknown"] = "CANARY_SECRET"
        self.save()
        self.assertIn("unknown_fields", self.run_cli("generate", "--target", str(self.target)).stderr)

    def test_each_cause_of_an_unusable_input_has_its_own_rule(self):
        over = tenant_pi.MAX_DEPTH + 1
        # A missing comma before line 6, column 3: the shape of a fragment that was pasted into the file.
        broken = ('{\n  "schemaVersion": 1,\n  "target": {\n    "agentDir": "/home/CANARY_SECRET/profile"\n  }\n'
                  '  "selection": "CANARY_SECRET"\n}\n').encode()
        (self.base / "real").mkdir()
        (self.base / "real" / "overlay.json").write_bytes(self.overlay.read_bytes())
        (self.base / "linked").symlink_to(self.base / "real", target_is_directory=True)
        (self.base / "plain").write_text("CANARY_SECRET")
        cases = (("absent file", self.base / "absent.json", None, {"error": "input_missing: overlay.file"}),
                 ("absent directory", self.base / "absent" / "overlay.json", None, {"error": "input_missing: overlay.file"}),
                 ("linked directory", self.base / "linked" / "overlay.json", None, {"error": "input_path_unsafe: overlay.file"}),
                 ("file as directory", self.base / "plain" / "overlay.json", None, {"error": "input_path_unsafe: overlay.file"}),
                 ("not UTF-8", self.overlay, b'{"CANARY_SECRET": "\xff"}', {"error": "input_encoding: overlay.file"}),
                 ("invalid JSON", self.overlay, broken, {"error": "invalid_json: overlay.file", "line": 6, "column": 3}),
                 ("byte order mark", self.overlay, b"\xef\xbb\xbf{}", {"error": "invalid_json: overlay.file", "line": 1, "column": 1}),
                 ("too deep", self.overlay, b"[" * over + b"0" + b"]" * over, {"error": "input_too_deep: overlay.file"}),
                 ("too large", self.overlay, b" " * (tenant_pi.MAX_INPUT + 1), {"error": "input_too_large: overlay.file"}),
                 ("long integer", self.overlay, b'{"CANARY_SECRET":' + b"9" * 5000 + b"}", {"error": "number: overlay.file"}))
        for cause, path, content, expected in cases:
            if content is not None:
                path.write_bytes(content)
            before = inventory(self.base)
            for action in ("validate", "plan"):
                with self.subTest(cause=cause, action=action):
                    result = self.run_cli(action, overlay=path)
                    self.assertEqual((2, ""), (result.returncode, result.stdout))
                    self.assertEqual({"candidate_created": False, **expected}, json.loads(result.stderr))
                    # A diagnostic names a rule, a field and at most a place: no path, no value, no parser text.
                    for text in ("CANARY_SECRET", str(self.base), "Traceback", "Expecting"):
                        self.assertNotIn(text, result.stderr)
            self.assertEqual(before, inventory(self.base))
        # The exact line that the documents show.
        self.overlay.write_bytes(broken)
        self.assertEqual('{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}\n',
                         self.run_cli("validate").stderr)
        self.assertFalse(self.target.exists())
        self.assertFalse((self.base / "called").exists())

    def test_a_refused_read_is_static_and_is_not_an_unsafe_path(self):
        from contextlib import redirect_stdout, redirect_stderr
        from io import StringIO

        actual = os.open
        for raised, rule in ((PermissionError(errno.EACCES, "CANARY_SECRET"), "input_unreadable"),
                             (OSError(errno.EIO, "CANARY_SECRET"), "input_unreadable"),
                             # The final name became a link after the check of its kind.
                             (OSError(errno.ELOOP, "CANARY_SECRET"), "input_path_unsafe")):
            def refuse(path, *args, **kwargs):
                if path == self.overlay.name:
                    raise raised
                return actual(path, *args, **kwargs)

            with self.subTest(errno=raised.errno):
                out, err = StringIO(), StringIO()
                with patch.object(tenant_pi.os, "open", side_effect=refuse), redirect_stdout(out), redirect_stderr(err):
                    code = tenant_pi.main(["validate", "--overlay", str(self.overlay), "--manifest", str(self.manifest)])
                self.assertEqual((2, ""), (code, out.getvalue()))
                self.assertEqual({"candidate_created": False, "error": rule + ": overlay.file"}, json.loads(err.getvalue()))
                self.assertNotIn("CANARY_SECRET", err.getvalue())

    @unittest.skipIf(os.geteuid() == 0, "root reads a file of mode 000")
    def test_overlay_without_read_permission(self):
        self.overlay.chmod(0)
        self.addCleanup(self.overlay.chmod, 0o600)
        result = self.run_cli("validate")
        self.assertEqual((2, ""), (result.returncode, result.stdout))
        self.assertEqual({"candidate_created": False, "error": "input_unreadable: overlay.file"}, json.loads(result.stderr))

    def test_unsupported_inputs_blocked_modules_and_injection(self):
        cases = ((lambda d: d["inputs"].update(modelsFile="inputs/models.json"), "unsupported_models_file"),
                 (lambda d: d["selection"]["enable"].append("tracker-site"), "selection_conflict"),
                 (lambda d: d["roles"].update(review={"provider": "p", "model": "$(touch /tmp/INJECTED)", "thinking": "low"}), "shell_or_template"),
                 (lambda d: d["target"].update(agentDir="/tmp/../outside"), "absolute_path"))
        for change, rule in cases:
            with self.subTest(rule=rule):
                data = copy.deepcopy(self.data)
                change(data)
                self.overlay.write_text(json.dumps(data))
                result = self.run_cli("plan")
                self.assertEqual(2, result.returncode)
                self.assertIn(rule, result.stderr)
                self.assertFalse(self.target.exists())
        self.overlay.write_text(json.dumps(self.data))
        self.data["selection"]["disable"].remove("tracker-site")
        self.data["selection"]["enable"].append("tracker-site")
        self.save()
        result = self.run_cli("plan")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn({"code": "host_tool_required", "subject": "tracker-site"},
                      json.loads(result.stdout)["readinessGaps"])
        manifest = json.loads(self.manifest.read_text())
        manifest["components"]["tracker-site"].update(status="blocked", reason="Blocked for this test.")
        manifest["components"]["tracker-site"]["configOwnership"].update(status="blocked", claims=[])
        self.manifest.write_text(json.dumps(manifest))
        self.assertIn("blocked_component", self.run_cli("plan").stderr)

    def test_input_symlink_fifo_and_size_rejected_before_read(self):
        link = self.base / "link.json"
        link.symlink_to(self.overlay)
        fifo = self.base / "pipe.json"
        os.mkfifo(fifo)
        large = self.base / "large.json"
        large.write_bytes(b" " * (tenant_pi.MAX_INPUT + 1))
        for file in (link, fifo, large):
            with self.subTest(file=file):
                result = self.run_cli("plan", overlay=file)
                self.assertEqual(2, result.returncode)
                self.assertIn("input_", result.stderr)
        parent_link = self.base / "linked"
        parent_link.symlink_to(self.base, target_is_directory=True)
        self.assertEqual(2, self.run_cli("plan", overlay=parent_link / "overlay.json").returncode)
        self.assertFalse(self.target.exists())

    def test_target_mismatch_existing_and_unsafe_ancestors(self):
        wrong = self.parent / "wrong"
        result = self.run_cli("generate", "--target", str(wrong))
        self.assertIn("invalid_plan", result.stderr)
        self.assertFalse(wrong.exists())
        for kind in ("directory", "file", "link", "fifo"):
            with self.subTest(kind=kind):
                if kind == "directory":
                    self.target.mkdir()
                elif kind == "file":
                    self.target.write_text("KEEP")
                elif kind == "link":
                    self.target.symlink_to(self.sentinel)
                else:
                    os.mkfifo(self.target)
                result = self.run_cli("generate", "--target", str(self.target))
                self.assertEqual(2, result.returncode)
                self.assertIn("target_exists", result.stderr)
                self.assertFalse(json.loads(result.stderr)["candidate_created"])
                self.target.rmdir() if kind == "directory" else self.target.unlink()
        for ancestor in (self.base / "linked", self.base / "pipe", self.base / "absent"):
            if ancestor.name == "linked":
                ancestor.symlink_to(self.parent, target_is_directory=True)
            elif ancestor.name == "pipe":
                os.mkfifo(ancestor)
            data = copy.deepcopy(self.data)
            data["target"]["agentDir"] = str(ancestor / "new")
            self.overlay.write_text(json.dumps(data))
            result = self.run_cli("generate", "--target", data["target"]["agentDir"])
            self.assertIn("unsafe_path", result.stderr)
            self.assertFalse(json.loads(result.stderr)["candidate_created"])
        self.assertEqual("KEEP", self.sentinel.read_text())

    def run_target(self, action, target, cli=CLI, env=None):
        """Run one action of `cli` for an overlay whose `target.agentDir` is `target`."""
        data = copy.deepcopy(self.data)
        data["target"]["agentDir"] = str(target)
        self.overlay.write_text(json.dumps(data))
        extra = ("--target", str(target)) if action == "generate" else ()
        return subprocess.run([sys.executable, str(cli), action, "--overlay", str(self.overlay),
                               "--manifest", str(self.manifest), *extra],
                              cwd=self.base, env=self.env if env is None else env,
                              text=True, capture_output=True, check=False)

    def assert_under_kit(self, result):
        self.assertEqual(2, result.returncode)
        self.assertEqual({"candidate_created": False, "error": "under_kit: overlay.target.agentDir"},
                         json.loads(result.stderr))
        self.assertEqual("", result.stdout)

    def test_target_inside_kit_refused_before_any_write(self):
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        # `docs/inside-profile` has an existing parent: without the refusal, `generate` would write there.
        for target in (ROOT, ROOT / ".local/inside-profile", ROOT / "docs/inside/agent", ROOT / "docs/inside-profile"):
            for action in ("validate", "plan", "generate"):
                with self.subTest(target=str(target.relative_to(ROOT)), action=action):
                    self.assert_under_kit(self.run_target(action, target))
                    self.assertEqual(target == ROOT, target.exists())
        # An invalid overlay is still reported first.
        self.data["unknown"] = "x"
        result = self.run_target("plan", ROOT / "docs/inside/agent")
        self.assertIn("unknown_fields", result.stderr)
        self.assertNotIn("under_kit", result.stderr)
        del self.data["unknown"]
        self.save()
        self.check_unchanged(before_source, before_fixture)

    def test_sample_target_is_refused_with_its_own_rule(self):
        example = ROOT / "config/config.example.json"
        self.assertEqual(SAMPLE_TARGET, load(example)["target"]["agentDir"])
        self.overlay.write_bytes(example.read_bytes())
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        for action, extra in (("validate", ()), ("plan", ()), ("generate", ("--target", SAMPLE_TARGET))):
            with self.subTest(action=action):
                result = self.run_cli(action, *extra)
                self.assertEqual((2, ""), (result.returncode, result.stdout))
                self.assertEqual({"candidate_created": False, "error": "sample_target: overlay.target.agentDir"},
                                 json.loads(result.stderr))
        self.check_unchanged(before_source, before_fixture)
        # The rule is the one sample path, not the fake user: another path of the same form passes.
        for action in ("validate", "plan"):
            self.assertEqual(0, self.run_target(action, SAMPLE_TARGET + "-2").returncode)
        # An invalid overlay is still reported first.
        data = load(example)
        data["unknown"] = "x"
        self.overlay.write_text(json.dumps(data))
        result = self.run_cli("plan")
        self.assertIn("unknown_fields", result.stderr)
        self.assertNotIn("sample_target", result.stderr)
        # The structure validator alone accepts the tracked example: the refusal belongs to the CLI.
        direct = subprocess.run([sys.executable, str(ROOT / "scripts/validate.py"), "--overlay", str(example)],
                                cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual(0, direct.returncode, direct.stderr)

    def test_target_beside_kit_and_in_home_succeed(self):
        # A disposable copy of the kit: its sibling directory is writable and shares the kit's name prefix.
        kit = self.base / "kit"
        for part in ("scripts", "config", "packages"):
            shutil.copytree(ROOT / part, kit / part, ignore=shutil.ignore_patterns("__pycache__"))
        cli = kit / "scripts/tenant_pi.py"
        for target in (self.base / "kit-sibling", self.base / "sibling/agent", self.home / "new-agent"):
            target.parent.mkdir(mode=0o700, exist_ok=True)
            with self.subTest(target=target.name):
                for action in ("validate", "plan", "generate"):
                    result = self.run_target(action, target, cli)
                    self.assertEqual(0, result.returncode, result.stderr)
                self.assertTrue(json.loads(result.stdout)["filesComplete"])
                self.assertTrue((target / ".tenant-pi/choices.json").is_file())
        # The real kit's sibling passes the read-only actions.
        sibling = ROOT.parent / (ROOT.name + "-sibling")
        for action in ("validate", "plan"):
            self.assertEqual(0, self.run_target(action, sibling).returncode)
        self.assertFalse(sibling.exists())

    def test_symlink_into_kit_refused_and_no_path_printed(self):
        before_source = inventory(ROOT)
        linked_kit = self.base / "linked-kit"
        linked_kit.symlink_to(ROOT, target_is_directory=True)
        linked_docs = self.base / "linked-docs"
        linked_docs.symlink_to(ROOT / "docs", target_is_directory=True)
        for target in (linked_kit, linked_kit / "inside", linked_docs / "inside/agent"):
            for action in ("validate", "plan", "generate"):
                with self.subTest(target=target.name, action=action):
                    result = self.run_target(action, target)
                    self.assert_under_kit(result)
                    for text in (str(ROOT), str(self.base), "inside", "linked"):
                        self.assertNotIn(text, result.stderr)
        self.assertFalse((ROOT / "inside").exists())
        self.assertFalse((ROOT / "docs/inside").exists())
        # A link that resolves outside the kit still passes the read-only actions.
        linked_out = self.base / "linked-out"
        linked_out.symlink_to(self.parent, target_is_directory=True)
        for action in ("validate", "plan"):
            with self.subTest(target="linked-out", action=action):
                result = self.run_target(action, linked_out / "agent")
                self.assertEqual(0, result.returncode, result.stderr)
        self.assertFalse((self.parent / "agent").exists())
        self.assertEqual(before_source, inventory(ROOT))

    def assert_refused(self, result, error):
        """The exact object: the diagnostic holds the rule and the field, and no path."""
        self.assertEqual((2, ""), (result.returncode, result.stdout))
        self.assertEqual({"candidate_created": False, "error": error}, json.loads(result.stderr))

    def test_target_in_live_agent_directory_refused_before_any_write(self):
        linked = self.base / "linked-agent"
        linked.symlink_to(self.old, target_is_directory=True)
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        # `inside` has an existing parent that the caller owns: without the refusal, `generate` would write there.
        for target in (self.old, self.old / "inside", self.old / "profiles/main", linked, linked / "inside"):
            for action in ("validate", "plan", "generate"):
                with self.subTest(target=str(target.relative_to(self.base)), action=action):
                    self.assert_refused(self.run_target(action, target), "under_pi_agent: overlay.target.agentDir")
        self.assertEqual(["settings.json"], os.listdir(self.old))
        # An invalid overlay is still reported first.
        self.data["unknown"] = "x"
        result = self.run_target("plan", self.old / "inside")
        self.assertIn("unknown_fields", result.stderr)
        self.assertNotIn("under_pi_agent", result.stderr)
        del self.data["unknown"]
        self.save()
        self.check_unchanged(before_source, before_fixture)

    def test_linked_live_agent_directory_and_linked_home_are_refused(self):
        # `~/.pi/agent` is a link: the directory behind it is the live profile too.
        real = self.base / "real agent"
        real.mkdir(mode=0o700)
        home = self.base / "home2"
        (home / ".pi").mkdir(parents=True, mode=0o700)
        (home / ".pi/agent").symlink_to(real, target_is_directory=True)
        linked_home = self.base / "linked home"
        linked_home.symlink_to(self.home, target_is_directory=True)
        through_link, through_home = dict(self.env, HOME=str(home)), dict(self.env, HOME=str(linked_home))
        for target, env in ((real, through_link), (real / "inside", through_link),
                            (home / ".pi/agent/inside", through_link), (self.old / "inside", through_home)):
            for action in ("validate", "plan", "generate"):
                with self.subTest(target=str(target.relative_to(self.base)), action=action):
                    self.assert_refused(self.run_target(action, target, env=env),
                                        "under_pi_agent: overlay.target.agentDir")
        self.assertEqual([], os.listdir(real))
        self.assertEqual(["settings.json"], os.listdir(self.old))

    def test_target_beside_live_agent_directory_succeeds(self):
        pi = self.home / ".pi"
        pi.chmod(0o700)
        before = inventory(self.old)
        # `profiles/main` is the documented target. `agent-2` and `agentx` share the name prefix of the live directory.
        for target in (pi / "profiles/main", pi / "agent-2", pi / "agentx/inside"):
            target.parent.mkdir(mode=0o700, exist_ok=True)
            with self.subTest(target=str(target.relative_to(pi))):
                for action in ("validate", "plan", "generate"):
                    result = self.run_target(action, target)
                    self.assertEqual(0, result.returncode, result.stderr)
                self.assertTrue(json.loads(result.stdout)["filesComplete"])
                self.assertTrue((target / ".tenant-pi/choices.json").is_file())
        self.assertEqual(before, inventory(self.old))
        self.assertEqual("OLD", (self.old / "settings.json").read_text())

    def test_plan_warns_about_a_provider_key_variable_and_prints_no_value(self):
        # A controlled environment: no known provider key name of the real shell reaches the CLI.
        clean = {name: value for name, value in self.env.items() if name not in PROVIDER_KEY_NAMES}
        value = "synthetic-value-not-a-key"
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        result = self.run_cli("plan", env=clean)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("providerKeyWarning", json.loads(result.stdout)["commands"])
        result = self.run_cli("plan", env=dict(clean, OPENAI_API_KEY=value, XAI_API_KEY="", UNRELATED_API_KEY=value))
        self.assertEqual(0, result.returncode, result.stderr)
        warning = json.loads(result.stdout)["commands"]["providerKeyWarning"]
        self.assertEqual("provider_key_in_launching_environment", warning["code"])
        # A variable with an empty value is set too: the plan does not read the value.
        self.assertEqual(["OPENAI_API_KEY", "XAI_API_KEY"], warning["variables"])
        self.assertIn("--model '<provider>/<model>'", warning["remedy"])
        self.assertNotIn(value, result.stdout + result.stderr)
        # `generate` and `validate` do not test the names.
        result = self.run_cli("generate", "--target", str(self.target), env=dict(clean, OPENAI_API_KEY=value))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("providerKeyWarning", result.stdout)
        self.assertNotIn(value, result.stdout + result.stderr)
        self.assertNotIn("providerKeyWarning", self.run_cli("validate", env=dict(clean, OPENAI_API_KEY=value)).stdout)
        shutil.rmtree(self.target)
        self.check_unchanged(before_source, before_fixture)

    def test_target_rule_needs_home_and_reads_no_other_environment_value(self):
        named = self.base / "env agent"
        named.mkdir(mode=0o700)
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        env = {name: value for name, value in self.env.items() if name != "HOME"}
        for home, error in ((None, "home_required: target.home"), ("relative", "absolute_path: target.home"),
                            (str(self.home) + "/", "absolute_path: target.home")):
            for action, extra in (("validate", ()), ("plan", ()), ("generate", ("--target", str(self.target)))):
                with self.subTest(home=home, action=action):
                    self.assert_refused(self.run_cli(action, *extra, env=env if home is None else dict(env, HOME=home)),
                                        error)
        self.assertFalse(self.target.exists())
        # The two target rules that need no `HOME` come first.
        self.assert_refused(self.run_target("plan", ROOT / "docs/inside/agent", env=env),
                            "under_kit: overlay.target.agentDir")
        self.assert_refused(self.run_target("plan", SAMPLE_TARGET, env=env), "sample_target: overlay.target.agentDir")
        # Documented limit: the kit does not read `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR`.
        # A live directory that only such a variable names is not known to the rule.
        env = dict(self.env, PI_CODING_AGENT_DIR=str(named), PI_CODING_AGENT_SESSION_DIR=str(named))
        for action in ("validate", "plan"):
            with self.subTest(named="env agent", action=action):
                self.assertEqual(0, self.run_target(action, named / "inside", env=env).returncode)
        self.save()
        self.check_unchanged(before_source, before_fixture)

    def test_quoted_path_and_json_escaping(self):
        self.data["selection"] = {"enable": ["core", "model-routing"], "disable": []}
        self.data["roles"]["interactive"] = {"provider": "test", "model": "org/model:v2", "thinking": "low"}
        for name in ("it's a profile", 'a "quoted" directory'):
            with self.subTest(name=name):
                self.target = self.parent / name
                self.data["target"]["agentDir"] = str(self.target)
                self.save()
                plan = self.run_cli("plan")
                self.assertEqual(0, plan.returncode, plan.stderr)
                parsed = json.loads(plan.stdout)
                self.assertEqual(["env", "-u", "PI_CODING_AGENT_SESSION_DIR", "PI_CODING_AGENT_DIR=" + str(self.target), "pi", "--no-approve"],
                                 shlex.split(parsed["commands"]["launchDisplayOnly"]))
                generated = self.run_cli("generate", "--target", str(self.target))
                self.assertEqual(0, generated.returncode, generated.stderr)
                self.assertEqual([], json.loads(generated.stdout)["warnings"])
                choices = json.loads((self.target / ".tenant-pi/choices.json").read_text())
                self.assertEqual(str(self.target), choices["overlay"]["target"]["agentDir"])
                self.assertEqual(str(self.target), json.loads(generated.stdout)["targetAgentDir"])
                for directory in (self.target, self.target / ".tenant-pi"):
                    self.assertEqual(0o700, stat.S_IMODE(directory.stat().st_mode))
                for file in (self.target / "settings.json", self.target / ".tenant-pi/choices.json",
                             self.target / ".tenant-pi/state.json"):
                    self.assertEqual(0o600, stat.S_IMODE(file.stat().st_mode))
                self.assertEqual("KEEP", self.sentinel.read_text())
                self.assertFalse((self.base / "called").exists())

    def test_injected_writer_failures_present_incomplete_candidate(self):
        from contextlib import redirect_stdout, redirect_stderr
        from io import StringIO
        from scripts import profile_write

        actual_create = profile_write._create_file

        def stop_on_choices(fd, name, data):
            if name == "choices.json":
                raise OSError("CANARY_SECRET")
            return actual_create(fd, name, data)

        for patch_name, injected, created in (("os.mkdir", OSError("CANARY_SECRET"), False),
                                              ("_create_file", stop_on_choices, True),
                                              ("os.replace", OSError("CANARY_SECRET"), True)):
            with self.subTest(point=patch_name):
                out, err = StringIO(), StringIO()
                with patch("scripts.profile_write." + patch_name, side_effect=injected), \
                     redirect_stdout(out), redirect_stderr(err):
                    code = tenant_pi.main(["generate", "--overlay", str(self.overlay),
                                           "--manifest", str(self.manifest), "--target", str(self.target)])
                self.assertEqual(2, code)
                self.assertEqual("", out.getvalue())
                self.assertEqual(created, json.loads(err.getvalue())["candidate_created"])
                self.assertNotIn("CANARY_SECRET", err.getvalue())
                self.assertNotIn("launch", err.getvalue())
                self.assertEqual("KEEP", self.sentinel.read_text())
                if created:
                    self.assertEqual("incomplete", json.loads((self.target / ".tenant-pi/state.json").read_text())["status"])
                    # Test cleanup touches only this disposable fixture, never a real candidate.
                    import shutil
                    shutil.rmtree(self.target)
                else:
                    self.assertFalse(self.target.exists())

    def test_manifest_override_remains_strict(self):
        changed = load(self.manifest)
        changed["components"]["core"]["source"]["spec"] = "other@0.87.1"
        self.manifest.write_text(json.dumps(changed))
        result = self.run_cli("plan")
        self.assertEqual(2, result.returncode)
        self.assertIn("reviewed_source", result.stderr)
        self.assertFalse(self.target.exists())

    def test_prepublication_cleanup_error_keeps_cli_failure_incomplete(self):
        from contextlib import redirect_stdout, redirect_stderr
        from io import StringIO
        from scripts import profile_write

        actual_close = os.close
        attempted = [False]
        raised = [False]

        def replace(*args, **kwargs):
            attempted[0] = True
            raise OSError("PRIMARY_CANARY")

        def close(fd):
            actual_close(fd)
            if attempted[0] and not raised[0]:
                raised[0] = True
                raise OSError("CLEANUP_CANARY")

        out, err = StringIO(), StringIO()
        with patch.object(profile_write.os, "close", side_effect=close), \
             patch.object(profile_write.os, "replace", side_effect=replace), \
             redirect_stdout(out), redirect_stderr(err):
            code = tenant_pi.main(["generate", "--overlay", str(self.overlay),
                                   "--manifest", str(self.manifest), "--target", str(self.target)])
        self.assertTrue(raised[0])
        self.assertEqual(2, code)
        self.assertEqual("", out.getvalue())
        self.assertEqual({"candidate_created": True, "error": "write_failed: target"}, json.loads(err.getvalue()))
        self.assertNotIn("CANARY", err.getvalue())
        self.assertNotIn("Traceback", err.getvalue())
        self.assertEqual("incomplete", json.loads((self.target / ".tenant-pi/state.json").read_text())["status"])
        self.assertEqual("KEEP", self.sentinel.read_text())

    def test_postpublication_close_warning_preserves_cli_success(self):
        from contextlib import redirect_stdout, redirect_stderr
        from io import StringIO
        from scripts import profile_write

        actual_close = os.close
        actual_replace = os.replace
        published = [False]
        raised = [False]

        def replace(*args, **kwargs):
            actual_replace(*args, **kwargs)
            published[0] = True

        def close(fd):
            actual_close(fd)
            if published[0] and not raised[0]:
                raised[0] = True
                raise OSError("CANARY_SECRET")

        out, err = StringIO(), StringIO()
        with patch.object(profile_write.os, "close", side_effect=close), \
             patch.object(profile_write.os, "replace", side_effect=replace), \
             redirect_stdout(out), redirect_stderr(err):
            code = tenant_pi.main(["generate", "--overlay", str(self.overlay),
                                   "--manifest", str(self.manifest), "--target", str(self.target)])
        self.assertTrue(raised[0])
        self.assertEqual(0, code)
        self.assertEqual("", err.getvalue())
        output = json.loads(out.getvalue())
        self.assertTrue(output["complete"])
        self.assertTrue(output["candidate_created"])
        self.assertEqual(["cleanup_failed: target.descriptors"], output["warnings"])
        self.assertEqual("complete", json.loads((self.target / ".tenant-pi/state.json").read_text())["status"])
        self.assertNotIn("CANARY_SECRET", out.getvalue() + err.getvalue())
        self.assertEqual("KEEP", self.sentinel.read_text())

    def test_write_errors_never_show_launch_and_report_partial(self):
        for created in (False, True):
            with self.subTest(created=created):
                with patch.object(tenant_pi, "_load_input", side_effect=[load(self.manifest), self.data]), \
                     patch.object(tenant_pi, "_kit_commit", return_value="unknown"), \
                     patch.object(tenant_pi, "write", side_effect=WriteError("write_failed", "target", candidate_created=created)):
                    from contextlib import redirect_stdout, redirect_stderr
                    from io import StringIO
                    out, err = StringIO(), StringIO()
                    with redirect_stdout(out), redirect_stderr(err):
                        code = tenant_pi.main(["generate", "--overlay", str(self.overlay), "--target", str(self.target)])
                self.assertEqual(2, code)
                self.assertEqual("", out.getvalue())
                self.assertEqual(created, json.loads(err.getvalue())["candidate_created"])
                self.assertNotIn("launch", err.getvalue())

    def generate_pair(self):
        """Two disposable candidates: a core-only one and a routed Tenantext one."""
        left = self.parent / "old candidate"
        self.data["target"]["agentDir"] = str(left)
        self.save()
        self.assertEqual(0, self.run_cli("generate", "--target", str(left)).returncode)
        registry = self.base / "registry.json"
        registry.write_text(json.dumps(REGISTRY))
        self.data["target"]["agentDir"] = str(self.target)
        self.data["selection"] = {"enable": ["core", "model-routing", "codex-accounts"], "disable": []}
        self.data["modelRoutes"] = {"schemaVersion": 1, "cycle": [copy.deepcopy(NATIVE)], "gateway": {"auth": "env"}}
        self.data["endpoints"] = {"codex-accounts": "https://CANARY-ENDPOINT.invalid/v1"}
        self.data["env"] = {"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"}
        self.data["roles"] = {"interactive": copy.deepcopy(NATIVE)}
        self.save()
        self.assertEqual(0, self.run_cli("generate", "--registry", str(registry), "--target", str(self.target)).returncode)
        return left, self.target

    def run_compare(self, left, right):
        return subprocess.run([sys.executable, str(CLI), "compare", "--left", str(left), "--right", str(right)],
                              cwd=self.base, env=self.env, text=True, capture_output=True, check=False)

    def test_compare_opens_only_declared_files_and_redacts(self):
        left, right = self.generate_pair()
        # Private runtime state beside the declared files must stay unread.
        for side in (left, right):
            (side / "auth.json").write_text('{"token": "CANARY_AUTH"}')
            (side / "sessions").mkdir()
            (side / "sessions" / "s.jsonl").write_text("CANARY_SESSION")
            (side / "memory.db").write_text("CANARY_MEMORY")
            (side / ".tenant-pi" / "queue.json").write_text("CANARY_QUEUE")
        edited = json.loads((right / "settings.json").read_text())
        edited["defaultModel"] = "CANARY_MODEL"
        edited["npmCommand"] = ["/CANARY_PATH/npm"]
        (right / "settings.json").write_text(json.dumps(edited))
        log = self.base / "opened.log"
        hook = self.base / "sitecustomize.py"
        hook.write_text(hook.read_text() + "import os\n_log = os.open(" + repr(str(log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
                        "def _audit(event, args):\n    if event == 'open':\n        os.write(_log, (str(args[0]) + '\\n').encode('utf-8', 'replace'))\n"
                        "sys.addaudithook(_audit)\n")
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        result = self.run_compare(left, right)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", result.stderr)
        opened = log.read_text().splitlines()
        self.assertTrue({"settings.json", "choices.json", "state.json"} <= set(opened), opened)
        for private in ("auth.json", "sessions", "s.jsonl", "memory.db", "queue.json"):
            self.assertNotIn(private, opened)
        report = json.loads(result.stdout)
        self.assertNotIn("CANARY", result.stdout)
        self.assertEqual({"kind": "candidate", "state": "complete", "path": str(left),
                          "drift": {"status": "none", "fields": [], "metadata": "unchanged"}}, report["left"])
        self.assertEqual({"status": "owner_edits", "fields": ["/defaultModel", "/npmCommand"], "metadata": "unchanged"}, report["right"]["drift"])
        self.assertEqual([{"file": "settings.json", "field": "/npmCommand", "side": "right", "status": "unsupported_field"}], report["unsupported"])
        changes = {(c["file"], c["field"]): c for c in report["changes"]}
        self.assertNotIn("right", changes[(".tenant-pi/choices.json", "/overlay/endpoints/codex-accounts")])
        self.assertEqual({"value": "listed"}, changes[(".tenant-pi/choices.json", "/overlay/selection/enable/codex-accounts")]["right"])
        self.assertEqual("tree:packages/tenantext",
                         changes[(".tenant-pi/state.json", "/provenance/pins/codex-accounts")]["right"]["value"])
        self.assertEqual(json.dumps(report, sort_keys=True), json.dumps(json.loads(self.run_compare(left, right).stdout), sort_keys=True))
        log.unlink()
        self.assertEqual(before_source, inventory(ROOT))
        self.assertEqual(before_fixture, inventory(self.base))
        self.assertEqual("KEEP", self.sentinel.read_text())
        self.assertEqual("OLD", (self.old / "settings.json").read_text())
        self.assertFalse((self.base / "called").exists())

    def test_compare_input_boundaries_and_settings_only_profile(self):
        left, right = self.generate_pair()
        for args, rule in ((("relative", str(right)), "absolute_path: compare.left"),
                           ((str(left), str(left)), "same_directory: compare.right"),
                           ((str(left), str(self.base / "absent")), "settings_missing: right"),
                           ((str(left), str(self.parent / "linked")), "input_path_unsafe: compare.right.settings.json")):
            with self.subTest(rule=rule):
                if args[1].endswith("linked") and not (self.parent / "linked").exists():
                    (self.parent / "linked").symlink_to(right, target_is_directory=True)
                result = subprocess.run([sys.executable, str(CLI), "compare", "--left", args[0], "--right", args[1]],
                                        cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
                self.assertEqual(2, result.returncode)
                self.assertEqual({"candidate_created": False, "error": rule}, json.loads(result.stderr))
                self.assertEqual("", result.stdout)
        plain = self.parent / "plain profile"
        plain.mkdir(mode=0o700)
        (plain / "settings.json").write_text('{"defaultProjectTrust": "never", "theme": "CANARY_THEME"}')
        (plain / "auth.json").write_text("CANARY_AUTH")
        result = self.run_compare(plain, right)
        self.assertEqual(0, result.returncode, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual({"kind": "settings_only", "state": None, "drift": None, "path": str(plain)}, report["left"])
        self.assertNotIn("CANARY", result.stdout)
        self.assertEqual([{"file": "settings.json", "field": "/theme", "side": "left", "status": "unsupported_field"}], report["unsupported"])
        (plain / ".tenant-pi").write_text("not a directory")
        self.assertIn("input_path_unsafe: compare.left..tenant-pi/choices.json", self.run_compare(plain, right).stderr)
        (plain / ".tenant-pi").unlink()
        (plain / ".tenant-pi").mkdir(mode=0o700)
        (plain / ".tenant-pi" / "choices.json").write_text('{"overlay": "CANARY_BROKEN"')
        result = self.run_compare(plain, right)
        self.assertEqual({"candidate_created": False, "error": "invalid_json: compare.left..tenant-pi/choices.json",
                          "line": 1, "column": 28}, json.loads(result.stderr))
        (plain / ".tenant-pi" / "choices.json").write_text('{"overlay": {"schemaVersion": 2}, "manifest": {"schemaVersion": 1}}')
        (plain / ".tenant-pi" / "state.json").write_text('{"schemaVersion": 1, "status": "complete"}')
        result = self.run_compare(plain, right)
        self.assertEqual({"candidate_created": False, "error": "unsupported_schema_version: left.choices.overlay.schemaVersion"}, json.loads(result.stderr))
        self.assertNotIn("CANARY", result.stderr)
        self.assertEqual("KEEP", self.sentinel.read_text())
        self.assertFalse((self.base / "called").exists())

    def run_inventory(self, directory):
        return subprocess.run([sys.executable, str(CLI), "inventory", "--dir", str(directory)],
                              cwd=self.base, env=self.env, text=True, capture_output=True, check=False)

    def test_inventory_lists_names_only_and_opens_no_private_file(self):
        _, candidate = self.generate_pair()
        live = self.parent / "live profile"
        live.mkdir(mode=0o700)
        (live / "settings.json").write_text(json.dumps({
            "defaultModel": "CANARY_MODEL", "packages": ["npm:example-package@1.0.0",
                                                         {"source": "/home/example/owner-repo", "skills": ["CANARY_FILTER"]},
                                                         "git:https://user:CANARY_TOKEN@host.invalid/r.git"]}))
        for side in (live, candidate):
            for name in ("extensions", "skills", "prompts"):
                (side / name).mkdir()
            (side / "extensions" / "plain.ts").write_text("CANARY_EXTENSION")
            (side / "extensions" / "linked.ts").symlink_to(self.sentinel)
            (side / "skills" / "one").mkdir()
            (side / "skills" / "one" / "SKILL.md").write_text("CANARY_SKILL")
            (side / "prompts" / "p.md").write_text("CANARY_PROMPT")
            for private in ("auth.json", "mcp.json", "models.json", "memory.db", "keybindings.json"):
                (side / private).write_text("CANARY_PRIVATE")
            (side / "sessions").mkdir()
            (side / "sessions" / "s.jsonl").write_text("CANARY_SESSION")
        log = self.base / "opened.log"
        hook = self.base / "sitecustomize.py"
        hook.write_text(hook.read_text() + "import os\n_log = os.open(" + repr(str(log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
                        "def _audit(event, args):\n    if event in ('open', 'os.scandir', 'os.listdir', 'subprocess.Popen', 'os.exec', 'os.posix_spawn', 'os.system', 'os.fork'):\n"
                        "        os.write(_log, (event + ' ' + str(args[0]) + '\\n').encode('utf-8', 'replace'))\n"
                        "sys.addaudithook(_audit)\n")
        before_source, before_fixture = inventory(ROOT), inventory(self.base)
        entries = {"extensions": [{"kind": "symlink", "name": "linked.ts"}, {"kind": "file", "name": "plain.ts"}],
                   "skills": [{"kind": "dir", "name": "one"}], "prompts": [{"kind": "file", "name": "p.md"}]}
        for side, managed, count in ((live, False, 3), (candidate, True, 1)):
            with self.subTest(managed=managed):
                result = self.run_inventory(side)
                self.assertEqual(0, result.returncode, result.stderr)
                self.assertEqual("", result.stderr)
                self.assertEqual(result.stdout, self.run_inventory(side).stdout)
                self.assertNotIn("CANARY", result.stdout)
                self.assertNotIn("outside", result.stdout)
                report = json.loads(result.stdout)
                self.assertEqual({"dir": str(side), "managed": managed, "packages": report["packages"], **entries,
                                  "summary": {"packages": count, "extensions": 2, "skills": 1, "prompts": 1}}, report)
        self.assertEqual([{"source": "npm:example-package@1.0.0"}, {"source": "/home/example/owner-repo", "filters": ["skills"]},
                          {"status": "unsupported_value"}], json.loads(self.run_inventory(live).stdout)["packages"])
        package = json.loads(self.run_inventory(candidate).stdout)["packages"][0]
        self.assertEqual(["extensions", "prompts", "skills", "themes"], package["filters"])
        self.assertEqual(str(ROOT / "packages/tenantext"), package["source"])
        events = log.read_text().splitlines()
        opened = [line[5:] for line in events if line.startswith("open ")]
        # Allowlist. The action opens by a name relative to a directory descriptor: the path
        # components of the two directories, the settings file, the three resource directories
        # and the marker directory. An open by number wraps the settings descriptor, so it
        # follows the settings open. An open by absolute path is the interpreter (modules,
        # the fixture hook); none of them is inside a profile.
        allowed = {"/", "settings.json", ".tenant-pi", "extensions", "skills", "prompts", *live.parts[1:], *candidate.parts[1:]}
        for name in ("settings.json", ".tenant-pi", "extensions", "skills", "prompts"):
            self.assertEqual(6, opened.count(name), name)
        for index, line in enumerate(opened):
            if line.isdigit():
                self.assertEqual("settings.json", opened[index - 1], opened)
            elif line.startswith("/") and line != "/":
                self.assertFalse(line == str(self.parent) or line.startswith(str(self.parent) + "/"), line)
            else:
                self.assertIn(line, allowed)
        self.assertEqual([], [line for line in events if line.split(" ", 1)[0] not in ("open", "os.scandir", "os.listdir")])
        # Each of the six runs lists exactly its three resource directories, each through a
        # descriptor. The listings by path are the module imports of the interpreter.
        listed = [line.split(" ", 1)[1] for line in events if not line.startswith("open ")]
        self.assertEqual(6 * 3, len([item for item in listed if item.isdigit()]), listed)
        self.assertFalse([item for item in listed if item.startswith(str(self.parent))], listed)
        log.unlink()
        self.assertEqual(before_source, inventory(ROOT))
        self.assertEqual(before_fixture, inventory(self.base))
        self.assertEqual("KEEP", self.sentinel.read_text())
        self.assertFalse((self.base / "called").exists())

    def test_inventory_input_boundaries(self):
        _, candidate = self.generate_pair()
        (self.parent / "linked").symlink_to(candidate, target_is_directory=True)
        (self.parent / "empty").mkdir()
        for directory, rule in (("relative", "absolute_path: inventory.dir"),
                                (self.parent / "linked", "input_path_unsafe: inventory.dir.settings.json"),
                                (self.parent / "empty", "settings_missing: inventory.dir"),
                                (self.base / "absent", "settings_missing: inventory.dir")):
            with self.subTest(rule=rule):
                result = self.run_inventory(directory)
                self.assertEqual(2, result.returncode)
                self.assertEqual({"candidate_created": False, "error": rule}, json.loads(result.stderr))
                self.assertEqual("", result.stdout)
        result = self.run_inventory(candidate)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual({"extensions": 0, "packages": 1, "prompts": 0, "skills": 0}, json.loads(result.stdout)["summary"])
        self.assertIn("inventory", subprocess.run([sys.executable, str(CLI), "--help"], cwd=self.base, env=self.env,
                                                  text=True, capture_output=True).stdout)
        self.assertFalse((self.base / "called").exists())


if __name__ == "__main__":
    unittest.main()
