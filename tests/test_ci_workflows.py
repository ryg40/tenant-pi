"""Offline workflow contracts. JSON-form YAML needs no third-party parser."""
import base64
from contextlib import redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ci_update as ci

WORKFLOWS = (".gitea/workflows/pi-update.yml", ".gitea/workflows/checks.yml", ".github/workflows/checks.yml")
CHECKS = ("python3 -m unittest discover -s tests -q", "python3 scripts/examples.py",
          "python3 scripts/validate.py --overlay config/config.example.json",
          "python3 scripts/publish_check.py", "python3 scripts/doc_check.py")


class Workflows(unittest.TestCase):
    def load(self, name):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                self.assertNotIn(key, result)
                result[key] = value
            return result
        # JSON is a strict subset of YAML 1.2. Refuse duplicate keys too.
        return json.loads((ROOT / name).read_text(), object_pairs_hook=unique)

    def test_yaml_and_repository_commands(self):
        for name in WORKFLOWS:
            workflow = self.load(name)
            self.assertIn("on", workflow)
            self.assertEqual(workflow["env"], {"PYTHONDONTWRITEBYTECODE": "1"})
            for job in workflow["jobs"].values():
                for dependency in job.get("needs", []):
                    self.assertIn(dependency, workflow["jobs"])
                for step in job["steps"]:
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"@[0-9a-f]{40}$")
                    if "run" not in step:
                        continue
                    command = step["run"]
                    if command not in CHECKS:
                        self.assertRegex(command, r"^python3 scripts/ci_update.py (detect|preflight|qualify|notes|request) --directory \.local/ci(?:/(detect|preflight|qualify|notes))?$")
                    if command.startswith("python3 -m unittest"):
                        self.assertTrue((ROOT / "tests").is_dir())
                    else:
                        self.assertTrue((ROOT / command.split()[1]).is_file())
                    self.assertNotIn("publish_portable", command)
                    self.assertNotIn("pi ", command)

    def test_offline_workflows_no_secrets(self):
        for name in WORKFLOWS[1:]:
            workflow = self.load(name)
            self.assertEqual(set(workflow["on"]), {"push", "pull_request"})
            self.assertEqual(workflow["permissions"], {"contents": "read"})
            text = json.dumps(workflow)
            self.assertNotIn("secrets.", text)
            self.assertNotIn("TOKEN", text)
            self.assertNotIn("npm", text)
            self.assertEqual([s["run"] for s in workflow["jobs"]["offline"]["steps"] if "run" in s], list(CHECKS))
            self.assertFalse(workflow["jobs"]["offline"]["steps"][0]["with"]["persist-credentials"])

    def test_update_gates_and_artifacts(self):
        workflow = self.load(WORKFLOWS[0])
        self.assertEqual(workflow["on"], {"schedule": [{"cron": "23 4 * * *"}], "workflow_dispatch": {}})
        jobs = workflow["jobs"]
        self.assertEqual(set(jobs), {"detect", "preflight", "qualify", "notes", "request"})
        self.assertIn("refs/heads/main", jobs["detect"]["if"])
        for name in ("qualify", "notes"):
            self.assertEqual(jobs[name]["needs"], ["detect", "preflight"])
            self.assertEqual(jobs[name]["if"], "${{ needs.detect.outputs.new == 'true' && needs.preflight.outputs.eligible == 'true' }}")
            artifact = jobs[name]["steps"][-1]
            self.assertEqual(artifact["if"], "${{ always() }}")
            self.assertIn("upload-artifact@", artifact["uses"])
        self.assertEqual(jobs["request"]["needs"], ["detect", "qualify", "notes"])
        self.assertIn("needs.qualify.result == 'success'", jobs["request"]["if"])
        self.assertIn("needs.notes.result == 'success'", jobs["request"]["if"])
        text = json.dumps(workflow)
        self.assertEqual(jobs["preflight"]["needs"], ["detect"])
        self.assertEqual(jobs["preflight"]["if"], "${{ needs.detect.outputs.new == 'true' }}")
        self.assertEqual(jobs["preflight"]["outputs"], {"eligible": "${{ steps.preflight.outputs.eligible }}"})
        self.assertEqual(text.count("secrets."), 2)
        for name in ("detect", "qualify", "notes"):
            self.assertNotIn("secrets.", json.dumps(jobs[name]))
        self.assertIn("secrets.PI_UPDATE_TOKEN", text)
        self.assertNotIn("pull_request_target", text)
        self.assertNotIn("concurrency", text)


class Adapter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        (self.root / "config").mkdir()
        self.manifest = {"runtime": {"piVersion": "1.0.3"}, "components": {"core": {"source": {"spec": ci.PACKAGE + "1.0.3"}}}}
        (self.root / "config/manifest.json").write_text(json.dumps(self.manifest, indent=2) + "\n")
        (self.root / "scripts/validate.py").write_text('REVIEWED_SOURCES = {\n    "core": {"kind": "npm", "spec": "' + ci.PACKAGE + '1.0.3"},\n}\n')
        self.directory = self.root / "reports"

    def stub(self, code, data):
        (self.root / "scripts/pi_update.py").write_text(
            "import json, os, sys\nfrom pathlib import Path\n"
            "assert 'PROVIDER_API_KEY' not in os.environ\n"
            "assert 'UPDATE_TOKEN' not in os.environ\n"
            "assert os.environ['PYTHONDONTWRITEBYTECODE'] == '1'\n"
            "assert Path(os.environ['HOME']).is_dir()\n"
            "assert not (Path(os.environ['HOME']) / '.pi').exists()\n"
            "args = sys.argv[1:]\n"
            "assert args[0] in ('detect', 'qualify', 'notes')\n"
            "assert '--strict-baseline' not in args\n"
            "if '--workdir' in args:\n"
            "    work = Path(args[args.index('--workdir') + 1])\n"
            "    assert not work.is_relative_to(Path(__file__).resolve().parents[1])\n"
            "    log = work / 'pi-update-stub/logs/step.log'\n"
            "    log.parent.mkdir(parents=True)\n"
            "    log.write_text('step output')\n"
            "if args[0] == 'qualify':\n"
            "    assert args[1:3] == ['--version', '1.0.4']\n"
            "    assert args[3] == '--workdir'\n"
            "if args[0] == 'notes':\n"
            "    assert args[1:5] == ['--from', '1.0.3', '--to', '1.0.4']\n"
            "    assert args[5] == '--workdir'\n"
            "print('stub log', file=sys.stderr)\n"
            "print(" + repr(json.dumps(data)) + ")\n"
            "sys.exit(" + str(code) + ")\n")

    def test_detect_empty_new_module_only_and_bad_exit(self):
        for code, latest, expected in ((0, "1.0.3", "false"), (10, "1.0.4", "true"), (10, "1.0.3", "false")):
            with self.subTest(code=code, latest=latest):
                self.stub(code, {"core": {"latest": latest}})
                out = self.root / "output"
                out.write_text("")
                with patch.dict(os.environ, {"GITHUB_OUTPUT": str(out), "PROVIDER_API_KEY": "test-only", "UPDATE_TOKEN": "test-only"}):
                    result = ci.detect(self.directory, root=self.root)
                self.assertEqual(result["new"], expected)
                self.assertIn("new=" + expected + "\n", out.read_text())
        self.stub(1, {})
        with self.assertRaisesRegex(ci.Invalid, "detect_failed"):
            ci.detect(self.directory, root=self.root)

    def test_bad_version_never_becomes_job_output(self):
        self.stub(10, {"core": {"latest": "1.0.4\nother=bad"}})
        with self.assertRaisesRegex(ci.Invalid, "update_version"):
            ci.detect(self.directory, root=self.root)

    def test_stages_success_failure_and_notes(self):
        for action, data in (("qualify", {"steps": []}), ("notes", {"breaking": True, "text": "Breaking Changes\nRead this."})):
            path = self.directory / action
            self.stub(0, data)
            self.assertTrue(ci.stage(action, path, "1.0.4", "1.0.3", root=self.root)["passed"])
            self.assertTrue((path / "receipt.json").is_file())
            self.assertEqual((path / "logs/pi-update-stub/step.log").read_text(), "step output")
            self.stub(1, {"steps": [{"name": "install", "exitCode": 1}]})
            failed = path
            with self.assertRaisesRegex(ci.Invalid, action + "_failed"):
                ci.stage(action, failed, "1.0.4", "1.0.3", root=self.root)
            self.assertFalse((failed / "receipt.json").exists())
            self.assertEqual((failed / (action + ".log")).read_text(), "stub log\n")

    def receipts(self, breaking=True):
        for action in ("qualify", "notes"):
            directory = self.directory / action
            directory.mkdir(parents=True)
            ci.write_json(directory / "receipt.json", {"action": action, "version": "1.0.4", "passed": True})
        ci.write_json(self.directory / "notes/notes.json", {"breaking": breaking, "text": "Read the changes."})

    def api(self, *, conflict=False, existing=False, changed=False):
        calls = []
        def call(method, path, body=None):
            calls.append((method, path, copy.deepcopy(body)))
            if path.startswith("/pulls?"):
                return [{"number": 7, "head": {"ref": "automation/pi-1.0.4"}}] if existing else []
            if method == "GET" and path.startswith("/branches/"):
                return {"commit": {"id": ("b" if changed else "a") * 40}}
            if method == "GET" and path.startswith("/contents/"):
                name = path.removeprefix("/contents/").split("?")[0]
                return {"sha": "c" * 40, "content": base64.b64encode((self.root / name).read_bytes()).decode()}
            if path == "/branches":
                if conflict:
                    raise ci.Invalid("api_conflict")
                return {}
            if path == "/contents":
                return {}
            if path == "/pulls":
                return {"number": 8}
            raise AssertionError(path)
        return call, calls

    def request(self, api):
        return ci.request(self.directory, "1.0.4", "1.0.3", "main", "a" * 40, api, root=self.root)

    def test_request_updates_both_pins_and_anchor_and_marks_breaking(self):
        self.receipts()
        api, calls = self.api()
        self.assertEqual(self.request(api), {"status": "created", "number": 8})
        files = next(body["files"] for method, path, body in calls if method == "POST" and path == "/contents")
        manifest = json.loads(base64.b64decode(files[0]["content"]))
        self.assertEqual(manifest["runtime"]["piVersion"], "1.0.4")
        self.assertEqual(manifest["components"]["core"]["source"]["spec"], ci.PACKAGE + "1.0.4")
        self.assertIn(ci.PACKAGE + "1.0.4", base64.b64decode(files[1]["content"]).decode())
        pull = calls[-1][2]
        self.assertEqual(pull["title"], "BREAKING: Update Pi to 1.0.4")
        self.assertIn("Read the changes.", pull["body"])
        self.assertEqual(ci.read_json(self.root / "config/manifest.json"), self.manifest)

    def test_ordered_note_entries_and_nonbreaking_title(self):
        self.receipts(breaking=False)
        ci.write_json(self.directory / "notes/notes.json", {"breaking": False, "entries": [
            {"version": "1.0.4", "text": "### Fixed\nA correction."}]})
        api, calls = self.api()
        self.request(api)
        self.assertEqual(calls[-1][2]["title"], "Update Pi to 1.0.4")
        self.assertIn("## 1.0.4\n\n### Fixed\nA correction.", calls[-1][2]["body"])

    def test_prerelease_notes_and_invalid_labels(self):
        self.stub(0, {"breaking": False, "entries": [{"version": "1.0.4-rc.1", "text": "Preview fixes."}]})
        self.assertTrue(ci.stage("notes", self.directory, "1.0.4", "1.0.3", root=self.root)["passed"])
        for label in ("1.0.4-rc.1", "1.0.4-1", "1.0.4"):
            self.assertIn(label, ci.notes_text({"breaking": False, "entries": [{"version": label, "text": "Changes"}]}))
        for label in ("1.0.4-rc.1\n", "1.0.4+build", "1.0", "1.0.4-" + "a" * 80):
            with self.assertRaisesRegex(ci.Invalid, "update_version"):
                ci.notes_text({"breaking": False, "entries": [{"version": label, "text": "Changes"}]})

    def test_preflight_get_only_for_available_open_and_claimed(self):
        for state in ("available", "existing", "branch_claimed_review_required"):
            with self.subTest(state=state):
                calls = []
                def api(method, path):
                    calls.append((method, path))
                    if path.startswith("/pulls?"):
                        return [{"number": 7, "head": {"ref": "automation/pi-1.0.4"}}] if state == "existing" else []
                    self.assertEqual(path, "/branches/automation%2Fpi-1.0.4")
                    if state == "available":
                        raise ci.Invalid("api_not_found")
                    return {"name": "automation/pi-1.0.4"}
                out = self.root / "outputs"
                out.write_text("")
                stdout = io.StringIO()
                with patch.dict(os.environ, {"GITHUB_OUTPUT": str(out), "UPDATE_VERSION": "1.0.4"}), \
                        patch.object(ci, "Api", return_value=api), redirect_stdout(stdout):
                    code = ci.main(["preflight", "--directory", str(self.directory)])
                result = json.loads(stdout.getvalue())
                self.assertEqual(code, 1 if state == "branch_claimed_review_required" else 0)
                self.assertEqual(result["status"], state)
                self.assertEqual(result["eligible"], "true" if state == "available" else "false")
                self.assertEqual(out.read_text(), "eligible=" + result["eligible"] + "\n")
                self.assertEqual(ci.read_json(self.directory / "preflight.json"), result)
                self.assertTrue(all(method == "GET" for method, _ in calls))

    def test_preflight_api_errors_do_not_enable_qualification(self):
        def api(method, path):
            if path.startswith("/pulls?"):
                return []
            raise ci.Invalid("api_failed")
        out = self.root / "outputs"
        out.write_text("")
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(out)}):
            with self.assertRaisesRegex(ci.Invalid, "api_failed"):
                ci.preflight(self.directory, "1.0.4", api)
        self.assertEqual(out.read_text(), "")

    def test_existing_request_is_noop(self):
        self.receipts()
        api, calls = self.api(existing=True)
        self.assertEqual(self.request(api)["status"], "existing")
        self.assertTrue(all(method == "GET" for method, _, _ in calls))

    def test_branch_claim_blocks_concurrent_or_interrupted_request(self):
        self.receipts()
        api, calls = self.api(conflict=True)
        with self.assertRaisesRegex(ci.Invalid, "branch_claimed_review_required"):
            self.request(api)
        self.assertFalse(any(method == "POST" and path in ("/pulls", "/contents") for method, path, _ in calls))

    def test_missing_qualification_or_stale_source_never_writes(self):
        api, calls = self.api()
        with self.assertRaises(FileNotFoundError):
            self.request(api)
        self.assertEqual(calls, [])
        self.receipts()
        api, calls = self.api(changed=True)
        with self.assertRaisesRegex(ci.Invalid, "source_changed"):
            self.request(api)
        self.assertTrue(all(method == "GET" for method, _, _ in calls))

    def test_api_distinguishes_missing_branch_from_permission_failure(self):
        api = ci.Api("https://git.example.invalid", "example-owner/example-repo", "test-only")
        for status, expected in ((404, "api_not_found"), (403, "api_failed"), (500, "api_failed")):
            error = ci.urllib.error.HTTPError("https://git.example.invalid", status, "ignored", {}, None)
            with patch.object(api.opener, "open", side_effect=error):
                with self.assertRaisesRegex(ci.Invalid, expected):
                    api("GET", "/branches/automation%2Fpi-1.0.4")

    def test_api_validation_and_redirect(self):
        for url in ("http://git.example.invalid", "https://user:pass@git.example.invalid", "https://git.example.invalid?x=y"):
            with self.assertRaisesRegex(ci.Invalid, "api_url"):
                ci.Api(url, "example-owner/example-repo", "test-only")
        with self.assertRaisesRegex(ci.Invalid, "api_token_missing"):
            ci.Api("https://git.example.invalid", "example-owner/example-repo", "")
        with self.assertRaisesRegex(ci.Invalid, "api_redirect"):
            ci.NoRedirect().redirect_request(None, None, 302, None, None, "https://example.invalid")


if __name__ == "__main__":
    unittest.main()
