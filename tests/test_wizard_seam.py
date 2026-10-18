"""The adapter seam of the wizard: the contract, the example adapter of another kit, the unchanged tenant-pi plan."""
import argparse
import copy
import io
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import models_input, tenant_pi, wizard, wizard_adapter as seam
from scripts.check_runtime import check
from scripts.validate import Invalid
from scripts.wizard_adapter_tenant_pi import ADAPTER as TENANT_PI
from scripts.wizard_state import State, digest
from scripts.wizard_terminal import Terminal

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
EXAMPLE = ROOT / "tests/fixtures/wizard_adapter_example.py"
PLAN = ROOT / "tests/fixtures/wizard_plan_tenant_pi.json"
MANIFEST = json.loads((ROOT / "config/manifest.json").read_text())
CARDS = [{"name": "fixture-card-a", "vramGiB": 24}, {"name": "fixture-card-b", "vramGiB": 16}]
# The kit root in the plan fixture. The fixture text is the same in each checkout path.
KIT_ROOT = "/KIT_ROOT"


def read(path, field, raw=False):
    return Path(path).read_bytes()


def example():
    return seam.load_adapter(str(EXAMPLE), read)


def fake_runtime():
    def fake(argv, **kwargs):
        version = {"pi": "1.3.1", "node": "v24.1.0", "python3": "Python 3.11.2"}[Path(argv[0]).name]
        return subprocess.CompletedProcess(argv, 0, version.encode(), b"")
    return check(MANIFEST["runtime"], run=fake, which=lambda name: "/fixture/" + name, environ={})


def placed(value):
    """`value` with the kit root of this checkout as KIT_ROOT in each string."""
    if type(value) is str:
        return value.replace(str(ROOT), KIT_ROOT)
    if type(value) is list:
        return [placed(item) for item in value]
    if type(value) is dict:
        return {placed(key): placed(item) for key, item in value.items()}
    return value


def tenant_pi_plan_text():
    """The encoded tenant-pi plan of a fixed state through the adapter, with the kit root as /KIT_ROOT.

    The clone is /KIT_ROOT before the plan. The other kit-root strings become /KIT_ROOT before the digest,
    so the text and its digest are the same in each checkout path. The fixture holds the same plan as the
    wizard before the seam. After a reviewed change of the manifest or of the plan, write this text to the
    fixture and review the difference (docs/guides/pin-move-release.md, "Regenerate the wizard plan fixture").
    """
    identity = {"destination": "local", "account": "fixture", "home": "/home/fixture",
                "target": "/home/fixture/new profile", "clone": KIT_ROOT, "sshTarget": None}
    evidence = {"schemaVersion": 1, "identity": identity, "runtime": fake_runtime(),
                "components": {key: "compatible" if key == "core" else "unknown" for key in MANIFEST["components"]},
                "targetAbsent": True}
    state = State(MANIFEST, identity, scan=evidence)
    state.private_dir = "/home/fixture/private choices"
    for cid in ("ops-footer", "model-routing"):
        state.toggle(cid)
    state.overlay["roles"]["interactive"] = {"provider": "fixture", "model": "served", "thinking": "off"}
    state.models = models_input.merge(None, "fixture", "http://127.0.0.1:8080/v1", "served", "FIXTURE_KEY", {"contextWindow": 8192})
    state.overlay["inputs"]["modelsFile"] = models_input.SLOT
    state.answers = {"launcher": "/home/fixture/launch", "provider": "fixture", "model": "served", "modelListing": "no", "inference": "no"}
    plan = wizard._plan(TENANT_PI, state)
    if plan != state.review(state.private_dir):
        raise AssertionError("adapter plan differs from the state plan")
    plan = placed({key: value for key, value in plan.items() if key != "digest"})
    plan["digest"] = digest(plan)
    return json.dumps(plan, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


class Script(Terminal):
    """A fake terminal: answers come from text lines; the SAVE prompt gets the shown digest."""

    def __init__(self, lines):
        super().__init__(io.StringIO(lines), io.StringIO())

    def ask(self, label, default=""):
        if label.startswith("Type SAVE "):
            return "SAVE " + label.split()[2]
        return super().ask(label, default)


class SeamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wizard seam ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.target = self.home / "new profile"
        self.private = self.home / "private choices"
        self.account = pwd.getpwuid(os.geteuid()).pw_name
        self.identity = {"destination": "local", "account": self.account, "home": str(self.home),
                         "target": str(self.target), "clone": str(ROOT), "sshTarget": None}
        self.env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
        self.base = ["wizard", "--account", self.account, "--home", str(self.home),
                     "--target", str(self.target), "--private-dir", str(self.private)]

    def cli(self, args, data=""):
        return subprocess.run([sys.executable, str(CLI), *args], input=data, text=True, capture_output=True,
                              env=self.env, timeout=30)

    def adapter_file(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("from scripts.wizard_adapter import Adapter\n" + body)
        return str(path)

    def text_adapter(self, name, shown, label, result):
        """A one-row adapter whose shown text, ask label and results text come from the test."""
        return self.adapter_file(name, "\n".join((
            "from scripts import wizard_adapter as seam",
            "class A(Adapter):",
            "    id = 'text-kit'",
            "    def catalog(self, context):",
            "        return [{'id': 'core', 'title': 'Core', 'group': 'core', 'locked': True, 'requires': [],",
            "                 'details': [], 'blocked': None, 'defaultSelected': True}]",
            "    def scan(self, identity, context):",
            "        return seam.scan_fields(identity, {'core': 'missing'})",
            "    def questions(self, state, ask, show):",
            "        show(" + repr(shown) + ")",
            "        ask('note', " + repr(label) + ", 'plain')",
            "    def plan(self, state, scan):",
            "        return {'schemaVersion': 1, 'overlayAfter': {}, 'answers': state.answers}",
            "    def results(self, plan, state, directory, kit):",
            "        return " + repr(result),
            "ADAPTER = A()", "")))

    def run_wizard(self, adapter, terminal):
        parser = argparse.ArgumentParser()
        wizard.arguments(parser.add_subparsers(dest="action"), ROOT)
        args = parser.parse_args([*self.base, "--adapter", adapter])
        with patch.dict(os.environ, {"HOME": str(self.home)}):
            os.environ.pop("WIKI_HOME", None)
            return wizard.run(args, tenant_pi, terminal)

    def test_example_catalog_passes_validation(self):
        adapter = example()
        self.assertEqual(seam.SEAM_VERSION, adapter.seam_version)
        rows = seam.validate_catalog(adapter.catalog(None))
        self.assertEqual(2, sum(row["group"] == "core" and row["locked"] for row in rows))
        self.assertEqual(3, sum(row["group"] == "optional" for row in rows))
        self.assertEqual(["cloud-sync"], [row["id"] for row in rows if row["blocked"]])
        self.assertIn(["metrics"], [row["requires"] for row in rows if row["group"] == "optional"])

    def test_catalog_refusals(self):
        rows = example().catalog(None)
        cases = (("duplicate_id", lambda r: r[1].update(id="runtime")),
                 ("undeclared_dependency", lambda r: r[3].update(requires=["absent"])),
                 ("core_locked", lambda r: r[0].update(locked=False)),
                 ("core_locked", lambda r: r[2].update(locked=True)),
                 ("core_requires_optional", lambda r: r[1].update(requires=["metrics"])),
                 ("dependency_cycle", lambda r: r[2].update(requires=["dashboard"])),
                 ("blocked_row", lambda r: r[4].update(defaultSelected=True)),
                 ("catalog_group", lambda r: r[2].update(group="extra")),
                 ("unknown_fields", lambda r: r[2].update(command="run")),
                 ("text", lambda r: r[2]["details"].append("bell\x07")),
                 ("component_id", lambda r: r[2].update(id="Bad ID")),
                 ("core_required", lambda r: [row.update(group="optional", locked=False) for row in r]))
        for rule, change in cases:
            bad = copy.deepcopy(rows)
            change(bad)
            with self.assertRaisesRegex(Invalid, "^" + rule + ":"):
                seam.validate_catalog(bad)
        tenant = State(MANIFEST, self.identity)
        self.assertEqual(list(MANIFEST["components"]), [row["id"] for row in seam.validate_catalog(TENANT_PI._rows(tenant))])

    def test_seam_state_selection(self):
        state = seam.SeamState(example().catalog(None), self.identity)
        self.assertEqual(["runtime", "profile"], state.selected)
        self.assertEqual("Core is required and locked.", state.toggle("profile"))
        self.assertEqual("Dependencies added: metrics", state.toggle("dashboard"))
        self.assertEqual(["runtime", "profile", "metrics", "dashboard"], state.selected)
        self.assertIn("Required by", state.toggle("metrics"))
        with self.assertRaisesRegex(Invalid, "blocked_component"):
            state.toggle("cloud-sync")
        rows = state.rows()
        self.assertEqual(["runtime", "profile"], [row["id"] for row in rows[:2]])
        self.assertEqual("Optional features / Observability", rows[2]["group"])
        self.assertIn("Blocked: No reviewed source.", rows[4]["details"])
        self.assertEqual("blocked", rows[4]["action"])
        self.assertTrue(state.approve({"digest": "a"}, "SAVE a"))
        state.toggle("dashboard")
        self.assertIsNone(state.approval)

    def test_question_types_and_validators(self):
        answers = {}
        def ask(key, label, default="", validate=None):
            value = replies.pop(0) or default
            if validate is not None:
                validate(value)
            answers[key] = value
            return value
        replies = ["", "yes", "y"]
        self.assertEqual("q4", seam.choice(ask, "quant", "Quant", ("q4", "q8")))
        self.assertTrue(seam.consent(ask, "measure", "Permit?"))
        self.assertFalse(seam.consent(ask, "measure", "Permit?"))
        replies = ["q5"]
        with self.assertRaisesRegex(Invalid, "choice: wizard.quant"):
            seam.choice(ask, "quant", "Quant", ("q4", "q8"))
        accepted = ((seam.absolute_path(), "/home/fixture/models"), (seam.url(), "https://example.invalid/v1"),
                    (seam.env_name(), "MODEL_KEY"), (seam.integer(4, 256), "256"),
                    (seam.optional(seam.env_name()), ""))
        for check_value, value in accepted:
            check_value(value)
        seam.absolute_path()("/home/fixture/it's \"quoted\" models")
        refused = ((seam.absolute_path(), "models", "absolute_path"),
                   (seam.url(), "https://user:pass@example.invalid/v1", "url"),
                   (seam.url(), "ftp://example.invalid/v1", "url"),
                   (seam.absolute_path(), "/home/fixture/../models", "absolute_path"),
                   (seam.absolute_path(), "/home/fixture/$HOME", "shell_or_template"),
                   (seam.absolute_path(), "/home/fixture/a;b", "absolute_path"),
                   (seam.url(), "https://example.invalid/v1?page=1", "credential_free_url"),
                   (seam.env_name(), "model_key", "env_name"), (seam.integer(4, 256), "257", "integer_range"),
                   (seam.integer(4, 256), "4.5", "integer_range"))
        for check_value, value, rule in refused:
            with self.assertRaisesRegex(Invalid, "^" + rule + ":"):
                check_value(value)

    def test_probe_is_bounded_and_has_no_credentials(self):
        code = "import os; print(os.environ['HOME']); print('OPENAI_API_KEY' in os.environ)"
        with patch.dict(os.environ, {"OPENAI_API_KEY": "SECRET_CANARY"}):
            result = seam.probe([sys.executable, "-c", code])
        home, leaked = result.stdout.decode().split()
        self.assertTrue(home.startswith(tempfile.gettempdir()))
        self.assertEqual("False", leaked)
        self.assertFalse(Path(home).exists())
        self.assertIsNone(seam.probe(["absent-fixture-command"]))
        self.assertIsNone(seam.probe([sys.executable, "-c", "print('x' * 2000)"]))

    def test_check_scan(self):
        state = seam.SeamState(example().catalog(None), self.identity)
        ids = [row["id"] for row in state.rows()]
        good = {"schemaVersion": 1, "identity": self.identity, "runtime": {},
                "components": {cid: "missing" for cid in ids}, "targetAbsent": True, "extra": {"cards": CARDS}}
        self.assertEqual(good, seam.check_scan(good, self.identity, ids))
        cases = (("object", {"extra": []}), ("component_set", {"components": {"runtime": "missing"}}),
                 ("scan_status", {"components": {cid: "maybe" for cid in ids}}),
                 ("json_only", {"extra": {"ram": float("nan")}}),
                 ("secret_like", {"extra": {"note": "token=" + "A" * 24}}),
                 ("identity_mismatch", {"identity": {**self.identity, "account": "other"}}),
                 ("unknown_fields", {"cards": CARDS}))
        for rule, change in cases:
            with self.assertRaisesRegex(Invalid, "^" + rule + ":"):
                seam.check_scan({**good, **change}, self.identity, ids)

    def test_example_end_to_end_with_fake_terminal(self):
        parser = argparse.ArgumentParser()
        wizard.arguments(parser.add_subparsers(dest="action"), ROOT)
        args = parser.parse_args([*self.base, "--adapter", str(EXAMPLE)])
        # Toggle the blocked row, then the dashboard (it adds metrics), then continue. /back and a context
        # out of range each return to the checklist; the earlier answers stay as defaults.
        lines = "scan\n5\n4\nc\n" + "q6\n\n\n/back\nc\n" + "\n\n\n300\nc\n" + "\n\n\n64\n\nMODEL_KEY\nyes\n"
        terminal = Script(lines)
        with patch.dict(os.environ, {"HOME": str(self.home)}):
            os.environ.pop("WIKI_HOME", None)
            result = wizard.run(args, tenant_pi, terminal)
        shown = terminal.output.getvalue()
        self.assertEqual("saved_handoff", result["status"], shown[-2000:])
        self.assertIn("Choice unavailable", shown)
        self.assertIn("Dependencies added: metrics", shown)
        self.assertIn("integer_range: wizard.contextK", shown)
        self.assertIn("Adapter: example-kit, seam version 1.", shown)
        handoff = json.loads((self.private / "handoff.json").read_text())
        self.assertEqual(("example-kit", 1), (handoff["adapter"], handoff["seamVersion"]))
        plan = {key: value for key, value in handoff.items() if key not in ("adapter", "seamVersion", "digest")}
        self.assertEqual(digest(plan), handoff["digest"])
        self.assertEqual(result["digest"], handoff["digest"])
        self.assertEqual(["runtime", "profile", "metrics", "dashboard"], handoff["selection"])
        self.assertEqual(["metrics"], handoff["dependenciesAdded"])
        self.assertEqual(CARDS, handoff["evidence"]["extra"]["cards"])
        profile = handoff["overlayAfter"]["profile"]
        self.assertEqual(("q6", 64, "Fleet", "MODEL_KEY", True),
                         (profile["quant"], profile["contextK"], profile["dashboard"], profile["keyVar"], profile["measured"]))
        self.assertEqual([], handoff["blocked"])
        self.assertEqual(handoff["overlayAfter"], json.loads((self.private / "overlay.json").read_text()))
        self.assertIn("`example-kit`", (self.private / "INSTALLER_KIT_RESULTS.md").read_text())
        for path in (self.private, *self.private.rglob("*")):
            self.assertEqual(0o700 if path.is_dir() else 0o600, stat.S_IMODE(path.stat().st_mode))
        self.assertFalse(self.target.exists())

    def test_example_cli_numbered_fallback(self):
        process = subprocess.Popen([sys.executable, str(CLI), *self.base, "--adapter", str(EXAMPLE)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=self.env, text=True, bufsize=1)
        try:
            process.stdin.write("scan\n4\nc\n" + "\n" * 7)
            process.stdin.flush()
            while True:
                line = process.stderr.readline()
                self.assertTrue(line)
                if line.startswith("Type SAVE "):
                    token = re.search(r"SAVE ([a-f0-9]{64})", line).group(1)
                    break
            process.stdin.write("SAVE " + token + "\n")
            process.stdin.flush()
            out, err = process.communicate(timeout=20)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                pipe.close()
        self.assertEqual(0, process.returncode, err[-2000:])
        self.assertEqual("saved_handoff", json.loads(out)["status"])
        handoff = json.loads((self.private / "handoff.json").read_text())
        self.assertEqual(("example-kit", 1, token), (handoff["adapter"], handoff["seamVersion"], handoff["digest"]))
        self.assertEqual("Fleet", handoff["answers"]["dashboardName"])

    def test_example_refusal_below_minimum(self):
        adapter = example()
        state = seam.SeamState(adapter.catalog(None), self.identity)
        state.answers = {"quant": "q8", "modelDir": "/home/fixture/models", "contextK": "128", "serverUrl": "http://127.0.0.1:8080/v1",
                         "keyVar": "", "measure": "no"}
        with patch.object(adapter, "cards", return_value=[{"name": "small", "vramGiB": 8}]):
            state.scan = adapter.scan(self.identity, None)
        plan = adapter.plan(state, state.scan)
        self.assertIn("vram_below_minimum", plan["blocked"])
        self.assertEqual("The cards hold 8 GiB. This profile needs at least 50 GiB. Choose a smaller quant or a smaller context.",
                         plan["refusal"])

    def test_example_data_only_and_evidence(self):
        state = seam.SeamState(example().catalog(None), self.identity)
        evidence = {"schemaVersion": 1, "identity": self.identity, "runtime": {},
                    "components": {row["id"]: "present" for row in state.rows()}, "targetAbsent": True, "extra": {"cards": CARDS}}
        file = self.root / "evidence.json"
        file.write_text(json.dumps(evidence))
        result = self.cli([*self.base, "--adapter", str(EXAMPLE), "--evidence", str(file), "--format", "json"])
        self.assertEqual(0, result.returncode, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(evidence, data["scan"])
        self.assertEqual(["runtime", "profile", "metrics", "dashboard", "cloud-sync"], [row["id"] for row in data["components"]])
        self.assertEqual("reuse", data["components"][0]["action"])
        self.assertFalse(self.private.exists())

    def test_wrong_seam_version_and_bad_adapters_are_refused(self):
        path = self.adapter_file("future.py", "class Future(Adapter):\n    id = 'future-kit'\n    seam_version = 2\nADAPTER = Future()\n")
        result = self.cli([*self.base, "--adapter", path])
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertIn("seam_version_unsupported: wizard.adapter.seam_version (this wizard supports 1)", result.stderr)
        self.assertFalse(self.private.exists())
        interface = r"adapter_interface: wizard\.adapter\.ADAPTER \(the file defines ADAPTER, an instance of an Adapter subclass\)\Z"
        cases = (("plain.py", "ADAPTER = object()\n", interface),
                 ("missing.py", "VALUE = 1\n", interface),
                 ("named.py", "class A(Adapter):\n    id = 'tenant-pi'\nADAPTER = A()\n", "adapter_id:"),
                 ("text.py", "class A(Adapter):\n    id = 'text-kit'\n    seam_version = '1'\nADAPTER = A()\n", "seam_version_unsupported:"),
                 ("compose.py", "class A(Adapter):\n    id = 'seat-kit'\n    destinations = ('compose',)\nADAPTER = A()\n", "adapter_destinations:"),
                 ("broken.py", "class A(Adapter:\n", "adapter_load:"))
        for name, body, rule in cases:
            with self.assertRaisesRegex(Invalid, "^" + rule):
                seam.load_adapter(self.adapter_file(name, body), read)
        for spec, rule in (("strata", r"unknown_adapter: wizard\.adapter \(an adapter ID is one of: tenant-pi\)\Z"),
                           ("fixtures/adapter.py", r"adapter_path_relative: wizard\.adapter \(the path of an adapter file is absolute\)\Z"),
                           ("adapter.py", "adapter_path_relative:"),
                           (str(self.root / "adapter.txt"), r"adapter_file: wizard\.adapter \(an adapter file ends in \.py\)\Z")):
            with self.assertRaisesRegex(Invalid, "^" + rule):
                seam.load_adapter(spec, read)

    def test_adapter_in_live_profile_or_vault_is_refused_before_it_runs(self):
        marker = self.root / "ran"
        body = "open(" + repr(str(marker)) + ", 'w').close()\nclass A(Adapter):\n    id = 'live-kit'\nADAPTER = A()\n"
        for place, rule in ((".pi/agent", "under_pi_agent"), (".llm-wiki", "under_wiki_vault")):
            path = self.adapter_file("home/" + place + "/adapter.py", body)
            result = self.cli([*self.base, "--adapter", path])
            self.assertEqual(2, result.returncode, result.stderr)
            self.assertIn(rule + ": wizard.adapter", result.stderr)
            self.assertFalse(marker.exists())
            self.assertFalse(self.private.exists())

    def test_adapter_text_reaches_the_terminal_without_controls(self):
        shown = "ESC \x1b[31mred\x1b[0m bell\x07 osc \x1b]0;title\x07 end\nsecond line"
        adapter = self.text_adapter("controls.py", shown, "label \x1b[2J here\x9b", "# Results\n\nNo check ran.\n")
        terminal = Script("scan\nc\n\n")
        result = self.run_wizard(adapter, terminal)
        output = terminal.output.getvalue()
        self.assertEqual("saved_handoff", result["status"], output[-2000:])
        self.assertIn("ESC red bell? osc  end\nsecond line\n", output)
        self.assertIn("label  here? [plain]", output)
        self.assertFalse({"\x1b", "\x07", "\x9b"} & set(output))
        self.assertEqual("# Results\n\nNo check ran.\n", (self.private / "INSTALLER_KIT_RESULTS.md").read_text())
        # The terminal prints a default, so a default with a control is refused like an answer.
        state = seam.SeamState(example().catalog(None), self.identity)
        with self.assertRaisesRegex(Invalid, "^control_character: wizard.default"):
            wizard._asker(state, Script("\n"))("key", "Label", "a\x1b[2J")

    def test_adapter_results_with_a_secret_or_a_control_are_refused(self):
        for name, result, rule in (("secret.py", "Results: token=" + "A" * 30 + "\n", "secret_like: wizard.results"),
                                   ("control.py", "Results \x1b[2J\n", "control_character: wizard.results"),
                                   ("tab.py", "Results\twith a tab\n", "control_character: wizard.results"),
                                   ("bytes.py", b"Results\n", "adapter_results: wizard.results")):
            terminal = Script("scan\nc\n\n")
            result = self.run_wizard(self.text_adapter(name, "Text kit.", "Note", result), terminal)
            output = terminal.output.getvalue()
            # The refusal shows, the approval clears, and the run goes back to the checklist; nothing is saved.
            self.assertEqual("cancelled", result["status"], output[-2000:])
            self.assertIn(rule, output)
            self.assertNotIn("A" * 30, output)
            self.assertFalse(self.private.exists())

    def test_adapter_file_changed_before_save_is_refused(self):
        path = self.root / "kit" / "adapter.py"
        path.parent.mkdir()
        path.write_bytes(EXAMPLE.read_bytes())

        saves = []

        class Changing(Script):
            def ask(inner, label, default=""):
                if label.startswith("Type SAVE "):
                    saves.append(label)
                    with open(path, "a") as handle:
                        handle.write("# changed after load\n")
                return super().ask(label, default)

        terminal = Changing("scan\nc\n" + "\n" * 6)
        with self.assertRaisesRegex(Invalid, "^input_changed: wizard.approval"):
            self.run_wizard(str(path), terminal)
        self.assertEqual(1, len(saves))
        self.assertFalse(self.private.exists())

    def test_tenant_pi_options_and_destinations_stay_with_tenant_pi(self):
        for extra, rule in ((["--overlay", str(self.root / "overlay.json")], "adapter_option: wizard.overlay"),
                            (["--manifest", str(ROOT / "config/manifest.json")], "adapter_option: wizard.manifest"),
                            (["--destination", "compose"], "adapter_destination: wizard.destination")):
            result = self.cli([*self.base, "--adapter", str(EXAMPLE), *extra])
            self.assertEqual(2, result.returncode, result.stderr)
            self.assertIn(rule, result.stderr)

    def test_tenant_pi_overlay_option_loads(self):
        # The wizard before the seam stopped with a TypeError at this option.
        state = State(MANIFEST, self.identity)
        state.toggle("ops-footer")
        saved = self.root / "saved"
        saved.mkdir()
        (saved / "overlay.json").write_text(json.dumps(state.configured()))
        result = self.cli([*self.base, "--overlay", str(saved / "overlay.json"), "--format", "json"])
        self.assertEqual(0, result.returncode, result.stderr)
        marked = [row["id"] for row in json.loads(result.stdout)["components"] if row["marked"]]
        self.assertEqual(["context-meter", "core", "ops-footer"], sorted(marked))

    def test_tenant_pi_plan_is_unchanged(self):
        self.assertEqual(PLAN.read_text(), tenant_pi_plan_text())

    def test_tenant_pi_handoff_names_the_adapter(self):
        evidence = {"schemaVersion": 1, "identity": self.identity, "runtime": fake_runtime(),
                    "components": {key: "compatible" if key == "core" else "unknown" for key in MANIFEST["components"]}, "targetAbsent": True}
        file = self.root / "evidence.json"
        file.write_text(json.dumps(evidence))
        state = State(MANIFEST, self.identity, scan=evidence)
        state.answers = {"launcher": "", "modelListing": "no", "inference": "no"}
        plan = state.review(str(self.private))
        result = self.cli([*self.base, "--evidence", str(file)], "evidence\nc\n\nno\nno\nSAVE " + plan["digest"] + "\n")
        self.assertEqual(0, result.returncode, result.stderr[-1000:])
        handoff = json.loads((self.private / "handoff.json").read_text())
        self.assertEqual(("tenant-pi", 1), (handoff.pop("adapter"), handoff.pop("seamVersion")))
        self.assertEqual(plan, handoff)


if __name__ == "__main__":
    unittest.main()
