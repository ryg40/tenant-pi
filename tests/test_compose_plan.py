"""Compose plan contract: the overlay, the env file lines and the command lines as data; no process, no key value.

A fake `docker`, `podman` and `git` record their arguments. No test starts a container or a build.
"""
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest

from scripts.compose_plan import APPROVAL, FILES, compose_plan, public_key
from scripts.model_routes import render
from scripts.profile_plan import prepare
from scripts.validate import Invalid, load, manifest, overlay

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "CANARY_SECRET"
KNOWN = manifest(load(ROOT / "config/manifest.json"))
URL = "https://gateway.example.invalid/v1"
KEY_VAR = "TENANTEXT_LITELLM_API_KEY"
MODEL = "codex-auto/astra"
CHOICE = {"provider": "litellm-codex", "model": MODEL, "thinking": "high", "route": "gateway"}
KEY_LINE = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE user@example\n"
# The form of a private key file, in parts: the secret scan of the kit refuses the whole marker in a file.
PRIVATE = "-----BEGIN OPENSSH " + "PRIVATE KEY-----\n" + CANARY + "\n-----END OPENSSH " + "PRIVATE KEY-----\n"
# A space, an apostrophe and a double quote: each path must reach a command as one argument.
ODD = "/srv/seat user/it's a \"dir\""
CLONE = "/srv/the \"clone\" of it's user"
CHANGING = {"build", "up", "down"}


def answers(**changes):
    values = {"account": "pi", "uid": 1000, "gid": 1000, "public_key_path": "/home/user/.ssh/id_ed25519.pub",
              "ssh_port": 2222, "projects_dir": None, "gateway_url": URL, "key_var": KEY_VAR, "components": [],
              "private_dir": "/home/user/.config/tenant-pi", "clone_dir": "/home/user/tenant-pi", "model": MODEL}
    return {**values, **changes}


def plan(**changes):
    return compose_plan(**answers(**changes), known=KNOWN)


class PlanTests(unittest.TestCase):
    def test_shape(self):
        result = plan()
        self.assertEqual({"runs", "answers", "overlay", "registry", "files", "seatEnv", "composeEnv", "authorizedKeys",
                          "commands", "warnings"}, set(result))
        self.assertIs(False, result["runs"])
        self.assertEqual({"account": "pi", "uid": 1000, "gid": 1000, "publicKey": "/home/user/.ssh/id_ed25519.pub",
                          "sshPort": 2222, "projectsDir": None, "gatewayUrl": URL, "keyVar": KEY_VAR, "components": [],
                          "componentsAdded": [], "privateDir": "/home/user/.config/tenant-pi",
                          "clone": "/home/user/tenant-pi", "provider": "litellm-codex", "model": MODEL,
                          "thinking": "high"}, result["answers"])
        self.assertEqual("registry.json", FILES[4])
        self.assertEqual({name: "/home/user/.config/tenant-pi/" + name for name in FILES}, result["files"])
        self.assertEqual({"source": "/home/user/.ssh/id_ed25519.pub",
                          "destination": "/home/user/.config/tenant-pi/authorized_keys"}, result["authorizedKeys"])
        self.assertEqual(["inspect_shows_key_value", "bind_0_0_0_0_opens_seat_to_network"], result["warnings"])
        self.assertEqual(result, plan())
        json.dumps(result)

    def test_overlay_names_the_seat_target_and_validates(self):
        for account in ("pi", "_seat-1", "agent"):
            with self.subTest(account=account):
                data = plan(account=account)["overlay"]
                self.assertEqual("/home/" + account + "/.pi/profiles/main", data["target"]["agentDir"])
                # The profile of the seat is never the directory that a bare `pi` opens.
                self.assertNotIn("/.pi/agent", data["target"]["agentDir"])
                overlay(data, KNOWN)
        data = plan()["overlay"]
        self.assertEqual(["core", "codex-accounts", "model-routing"], data["selection"]["enable"])
        self.assertEqual(sorted(set(KNOWN) - set(data["selection"]["enable"])), data["selection"]["disable"])
        self.assertEqual(({"codex-accounts": URL}, {"codex-accounts": "${" + KEY_VAR + "}"}, {"auth": "env"}),
                         (data["endpoints"], data["env"], data["modelRoutes"]["gateway"]))

    def test_interactive_role_is_the_one_cycle_choice_and_the_registry_names_it(self):
        result = plan()
        data = result["overlay"]
        self.assertEqual(({"interactive": CHOICE}, [CHOICE]), (data["roles"], data["modelRoutes"]["cycle"]))
        self.assertEqual({"litellm-codex": {MODEL: ["high"]}}, result["registry"])
        # The provider and the model are separate values: no value of the overlay holds the joined string.
        self.assertNotIn("litellm-codex/" + MODEL, json.dumps(data))
        for model, thinking in (("codex-auto/luna", "xhigh"), ("codex-auto/sol", "off"), (MODEL, "max")):
            with self.subTest(model=model, thinking=thinking):
                result = plan(model=model, thinking=thinking)
                choice = {**CHOICE, "model": model, "thinking": thinking}
                self.assertEqual((choice, [choice], {"litellm-codex": {model: [thinking]}}),
                                 (result["overlay"]["roles"]["interactive"], result["overlay"]["modelRoutes"]["cycle"],
                                  result["registry"]))
                self.assertEqual(("litellm-codex", model, thinking),
                                 tuple(result["answers"][key] for key in ("provider", "model", "thinking")))
                # The overlay validator, then the route rules with the registry of the plan.
                overlay(result["overlay"], KNOWN)
                settings = render(result["overlay"], result["registry"])["settings"]
                self.assertEqual({"defaultProvider": "litellm-codex", "defaultModel": model, "defaultThinkingLevel": thinking,
                                  "enabledModels": ["litellm-codex/" + model],
                                  "modelThinkingLevels": {"litellm-codex/" + model: thinking}}, settings)
        # The whole planner takes the overlay with the registry, and refuses it without one.
        result = plan()
        prepared = prepare(load(ROOT / "config/manifest.json"), result["overlay"], registry=result["registry"])
        self.assertEqual(MODEL, prepared["files"]["settings.json"]["content"]["defaultModel"])
        with self.assertRaises(Invalid) as caught:
            prepare(load(ROOT / "config/manifest.json"), result["overlay"])
        self.assertEqual("registry_required: registry", str(caught.exception))

    def test_another_provider_is_left_to_the_validator_and_the_registry(self):
        result = plan(provider="fake-native", model="team/slash-id")
        self.assertEqual({"fake-native": {"team/slash-id": ["high"]}}, result["registry"])
        self.assertEqual({**CHOICE, "provider": "fake-native", "model": "team/slash-id"},
                         result["overlay"]["roles"]["interactive"])
        overlay(result["overlay"], KNOWN)
        # The seat has the gateway route only: the route rules refuse the model of another provider.
        with self.assertRaises(Invalid) as caught:
            render(result["overlay"], result["registry"])
        self.assertEqual("unsupported_gateway_model: overlay.modelRoutes.choice", str(caught.exception))

    def test_components_bring_the_components_that_they_require(self):
        result = plan(components=["herdr-relay", "ops-footer"])
        enable = result["overlay"]["selection"]["enable"]
        for cid in ("herdr-relay", "herdr", "ops-footer", *KNOWN["ops-footer"]["requires"]):
            self.assertIn(cid, enable)
        self.assertIn("herdr", result["answers"]["componentsAdded"])
        self.assertEqual(["herdr-relay", "ops-footer"], result["answers"]["components"])
        overlay(result["overlay"], KNOWN)

    def test_the_key_name_is_the_same_in_the_three_places(self):
        result = plan()
        self.assertEqual("${" + KEY_VAR + "}", result["overlay"]["env"]["codex-accounts"])
        self.assertIn("SEAT_KEY_VAR=" + KEY_VAR, result["seatEnv"])
        # Single quotes and no value: Compose interpolates `$`, and the user pastes the value.
        self.assertIn(KEY_VAR + "=''", result["composeEnv"])
        self.assertIn("TENANTEXT_LITELLM_BASE_URL=" + URL, result["composeEnv"])
        other = plan(key_var="OTHER_GATEWAY_KEY")
        self.assertEqual(("${OTHER_GATEWAY_KEY}", True, True),
                         (other["overlay"]["env"]["codex-accounts"], "SEAT_KEY_VAR=OTHER_GATEWAY_KEY" in other["seatEnv"],
                          "OTHER_GATEWAY_KEY=''" in other["composeEnv"]))
        # The overlay validator knows one key name: the CLI refuses the other name with its rule.
        with self.assertRaises(Invalid) as caught:
            overlay(other["overlay"], KNOWN)
        self.assertEqual("undeclared_env: overlay.env", str(caught.exception))

    def test_seat_env_lines(self):
        result = plan(uid=501, gid=20, ssh_port=2200, projects_dir="/home/user/projects")
        self.assertEqual(["SEAT_PRIVATE_DIR=/home/user/.config/tenant-pi", "SEAT_USER=pi", "SEAT_UID=501", "SEAT_GID=20",
                          "SEAT_BIND=127.0.0.1", "SEAT_SSH_PORT=2200", "SEAT_USERNS=", "SEAT_KEY_VAR=" + KEY_VAR,
                          "SEAT_PROJECTS_DIR=/home/user/projects"],
                         [line for line in result["seatEnv"] if not line.startswith("#")])
        # The Podman line repeats the exact UID and GID of the answers.
        self.assertIn("# Empty for Docker. For Podman: SEAT_USERNS=keep-id:uid=501,gid=20", result["seatEnv"])
        self.assertFalse([line for line in plan()["seatEnv"] if line.startswith("SEAT_PROJECTS_DIR")])
        odd = plan(private_dir=ODD, projects_dir="/srv/my projects")["seatEnv"]
        self.assertIn('SEAT_PRIVATE_DIR="/srv/seat user/it\'s a \\"dir\\""', odd)
        self.assertIn("SEAT_PROJECTS_DIR='/srv/my projects'", odd)

    def test_warnings(self):
        self.assertEqual({"gid_20_is_dialout_in_image", "uid_below_1000"},
                         set(plan(uid=501, gid=20)["warnings"]) - set(plan()["warnings"]))
        self.assertIn("gid_below_1000", plan(gid=501)["warnings"])
        self.assertNotIn("uid_below_1000", plan(uid=1000, gid=20)["warnings"])

    def test_each_compose_command_has_the_commit_the_env_file_and_the_files(self):
        for projects in (None, ODD + "/projects"):
            result = plan(private_dir=ODD, clone_dir=CLONE, projects_dir=projects)
            commands = result["commands"]
            self.assertEqual([(runtime, step) for runtime in ("docker", "podman")
                              for step in ("build", "up", "ps", "logs", "down")] + [("ssh", "login")],
                             [(command["runtime"], command["step"]) for command in commands])
            files = ["-f", CLONE + "/deploy/compose/compose.yaml",
                     *(["-f", CLONE + "/deploy/compose/compose.projects.yaml"] if projects else [])]
            for command in commands[:-1]:
                with self.subTest(projects=projects, runtime=command["runtime"], step=command["step"]):
                    self.assertEqual([command["runtime"], "compose", "--env-file", ODD + "/seat.env", *files],
                                     command["argv"][:4 + len(files)])
                    self.assertEqual(["git", "-C", CLONE, "rev-parse", "--short", "HEAD"], command["kitCommit"])
                    self.assertTrue(command["display"].startswith('KIT_COMMIT="$(git -C '))
                    self.assertEqual(command["step"] in CHANGING, command["changes"])
                    self.assertEqual(APPROVAL if command["changes"] else None, command.get("approval"))
                    # No volume is removed, and no key file is given to Compose.
                    self.assertNotIn("-v", command["argv"])
                    self.assertNotIn("compose.env", command["display"])
            login = commands[-1]
            self.assertEqual((["ssh", "-p", "2222", "pi@127.0.0.1"], False), (login["argv"], login["changes"]))
            self.assertEqual(login["argv"], shlex.split(login["display"]))

    def test_refusals_do_not_echo_the_input(self):
        cases = (
            ({"account": "Pi" + CANARY}, "account: compose-plan.account"),
            ({"account": "-" + CANARY.lower()}, "account: compose-plan.account"),
            ({"account": "a" * 33}, "account: compose-plan.account"),
            ({"account": ""}, "account: compose-plan.account"),
            ({"account": None}, "account: compose-plan.account"),
            *(({"account": name}, "reserved_account: compose-plan.account")
              for name in ("root", "node", "sshd", "daemon", "www-data", "nobody", "bin", "sys", "games", "_apt")),
            ({"uid": 499}, "account_id: compose-plan.uid"),
            ({"uid": 0}, "account_id: compose-plan.uid"),
            ({"uid": 65534}, "account_id: compose-plan.uid"),
            ({"uid": "1000"}, "account_id: compose-plan.uid"),
            ({"uid": True}, "account_id: compose-plan.uid"),
            # GID 20 is the one accepted value below 500; UID 20 is not.
            ({"uid": 20}, "account_id: compose-plan.uid"),
            ({"gid": 21}, "account_id: compose-plan.gid"),
            ({"gid": 65534}, "account_id: compose-plan.gid"),
            ({"ssh_port": 1023}, "port: compose-plan.ssh_port"),
            ({"ssh_port": 65536}, "port: compose-plan.ssh_port"),
            ({"ssh_port": "2222"}, "port: compose-plan.ssh_port"),
            ({"public_key_path": "id_" + CANARY + ".pub"}, "absolute_path: compose-plan.public_key"),
            ({"public_key_path": "~/.ssh/" + CANARY}, "absolute_path: compose-plan.public_key"),
            ({"private_dir": "private/" + CANARY}, "absolute_path: compose-plan.private_dir"),
            ({"private_dir": "/home/user/private/"}, "absolute_path: compose-plan.private_dir"),
            ({"private_dir": "/home/$(" + CANARY + ")"}, "shell_or_template: compose-plan.private_dir"),
            ({"clone_dir": "clone"}, "absolute_path: compose-plan.clone"),
            ({"clone_dir": "/home/../" + CANARY}, "absolute_path: compose-plan.clone"),
            ({"projects_dir": "projects"}, "absolute_path: compose-plan.projects_dir"),
            ({"projects_dir": "/srv/`" + CANARY + "`"}, "shell_or_template: compose-plan.projects_dir"),
            # The private directory and the clone are different, and neither holds the other.
            ({"private_dir": "/home/user/tenant-pi"}, "under_kit: compose-plan.private_dir"),
            ({"private_dir": "/home/user/tenant-pi/.local"}, "under_kit: compose-plan.private_dir"),
            ({"private_dir": "/home/user"}, "under_kit: compose-plan.private_dir"),
            ({"gateway_url": "http://gateway.example.invalid/v1"}, "credential_free_https_url: compose-plan.gateway_url"),
            ({"gateway_url": "https://user:" + CANARY + "@gateway.example.invalid/v1"},
             "credential_free_https_url: compose-plan.gateway_url"),
            ({"gateway_url": "https://gateway.example.invalid:4000/v1"}, "credential_free_https_url: compose-plan.gateway_url"),
            ({"gateway_url": None}, "credential_free_https_url: compose-plan.gateway_url"),
            ({"gateway_url": "https://gateway.example.invalid/v1/"}, "gateway_api_prefix: compose-plan.gateway_url"),
            ({"gateway_url": "https://gateway.example.invalid"}, "gateway_api_prefix: compose-plan.gateway_url"),
            ({"key_var": "lower_" + CANARY}, "env_name: compose-plan.key_var"),
            ({"key_var": "KEY=" + CANARY}, "env_name: compose-plan.key_var"),
            ({"key_var": "TENANTEXT_LITELLM_BASE_URL"}, "env_name: compose-plan.key_var"),
            ({"key_var": "SEAT_USER"}, "env_name: compose-plan.key_var"),
            ({"key_var": ""}, "env_name: compose-plan.key_var"),
            ({"components": ["no-such-" + CANARY.lower()]}, "undeclared_component: compose-plan.components"),
            ({"components": ["herdr", "herdr"]}, "duplicate_component: compose-plan.components"),
            ({"components": "herdr"}, "component_list: compose-plan.components"),
            # The gateway provider has the three aliases only; the provider and the model are never one string.
            ({"model": "codex1/astra"}, "unsupported_gateway_model: compose-plan.model"),
            ({"model": "litellm-codex/codex-auto/astra"}, "unsupported_gateway_model: compose-plan.model"),
            ({"model": "gpt-" + CANARY}, "unsupported_gateway_model: compose-plan.model"),
            ({"model": "codex-auto/astra " + CANARY}, "model_id: compose-plan.model"),
            ({"model": ""}, "model_id: compose-plan.model"),
            ({"model": None}, "model_id: compose-plan.model"),
            ({"provider": "$(" + CANARY + ")"}, "model_id: compose-plan.provider"),
            ({"provider": None}, "model_id: compose-plan.provider"),
            ({"thinking": "ultra" + CANARY}, "thinking: compose-plan.thinking"),
            ({"thinking": None}, "thinking: compose-plan.thinking"),
        )
        for changes, expected in cases:
            with self.subTest(expected=expected, changes=changes):
                with self.assertRaises(Invalid) as caught:
                    plan(**changes)
                self.assertEqual(expected, str(caught.exception))

    def test_public_key_content(self):
        accepted = (KEY_LINE, "# a comment\n\n" + KEY_LINE + "\n# the end\n", "ssh-rsa AAAAB3NzaC1yc2E=\n",
                    "ecdsa-sha2-nistp256 AAAAE2VjZHNh host\n", "sk-ssh-ed25519@openssh.com AAAAGnNr key of the user\n")
        for content in accepted:
            with self.subTest(content=content):
                self.assertEqual(content.encode(), public_key(content.encode()))
        refused = (
            ("", "public_key_missing"), ("\n# only a comment\n", "public_key_missing"),
            (PRIVATE, "private_key"),
            (KEY_LINE + "-----BEGIN RSA " + "PRIVATE KEY-----\n", "private_key"),
            ("not a key " + CANARY + "\n", "public_key_line"), ("ssh-ed25519\n", "public_key_line"),
            ('command="' + CANARY + '" ' + KEY_LINE, "public_key_line"),
        )
        for content, rule in refused:
            with self.subTest(rule=rule, content=content):
                with self.assertRaises(Invalid) as caught:
                    public_key(content.encode())
                self.assertEqual(rule + ": compose-plan.public_key", str(caught.exception))
        # Two key lines: the rule is a distinct one, and the diagnostic holds the count and no content.
        for content, count in ((KEY_LINE + "# a comment\n\nssh-rsa AAAAB3NzaC1yc2E= " + CANARY + "\n", 2), (KEY_LINE * 3, 3)):
            with self.subTest(count=count):
                with self.assertRaises(Invalid) as caught:
                    public_key(content.encode())
                self.assertEqual(f"public_key_count: compose-plan.public_key has {count} key lines", str(caught.exception))
        with self.assertRaises(Invalid) as caught:
            public_key(b"\xff\xfe")
        self.assertEqual("input_encoding: compose-plan.public_key", str(caught.exception))


class CliTests(unittest.TestCase):
    """The action through the real CLI, with fake tools on `PATH` that record each call."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-compose-plan-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.calls = self.base / "calls"
        self.calls.mkdir()
        # A tool that records its exact arguments, one file for each call, one line for each argument.
        recorder = ('n=0\nfor f in \'' + str(self.calls) + '\'/*; do if [ -e "$f" ]; then n=$((n + 1)); fi; done\n'
                    'for a in "$0" "$@"; do printf \'%s\\0\' "$a"; done > \'' + str(self.calls) + '\'/"$n"\n')
        for name in ("docker", "podman", "ssh"):
            self.fake(name, recorder + 'printf \'%s\' "$KIT_COMMIT" > \'' + str(self.base) + "'/commit")
        self.fake("git", recorder + "echo abc1234")
        self.private = self.base / "private dir"
        self.private.mkdir(mode=0o700)
        self.key = self.base / "id key.pub"
        self.key.write_text(KEY_LINE)
        self.home = self.base / "home"
        self.home.mkdir()
        self.env = {"PATH": str(self.bin) + os.pathsep + os.path.dirname(sys.executable), "HOME": str(self.home),
                    "PYTHONDONTWRITEBYTECODE": "1", KEY_VAR: CANARY, "OTHER_GATEWAY_KEY": CANARY}

    def fake(self, name, body):
        command = self.bin / name
        command.write_text("#!/bin/sh\n" + body + "\n")
        command.chmod(0o700)

    def recorded(self):
        calls = []
        for name in sorted(os.listdir(self.calls), key=int):
            parts = (self.calls / name).read_bytes().decode().split("\0")[:-1]
            calls.append([Path(parts[0]).name, *parts[1:]])
            (self.calls / name).unlink()
        return calls

    def arguments(self, **changes):
        values = {"--uid": "501", "--gid": "20", "--public-key": str(self.key), "--gateway-url": URL,
                  "--private-dir": str(self.private), "--clone": str(self.base / "the clone"), "--model": MODEL,
                  **changes}
        return [word for pair in values.items() if pair[1] is not None for word in pair]

    def run_cli(self, *extra, **changes):
        return subprocess.run([sys.executable, str(CLI), "compose-plan", *self.arguments(**changes), *extra], env=self.env,
                              cwd=self.base, text=True, capture_output=True, check=False)

    def refused(self, expected, *extra, **changes):
        result = self.run_cli(*extra, **changes)
        self.assertEqual((2, ""), (result.returncode, result.stdout))
        self.assertEqual({"candidate_created": False, "error": expected}, json.loads(result.stderr))
        self.assertNotIn(CANARY, result.stderr)

    def test_prints_the_plan_and_writes_and_runs_nothing(self):
        result = self.run_cli("--enable", "herdr", "--projects-dir", str(self.base / "my projects"))
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        report = json.loads(result.stdout)
        expected = compose_plan("pi", 501, 20, str(self.key), 2222, str(self.base / "my projects"), URL, KEY_VAR, ["herdr"],
                                str(self.private), str(self.base / "the clone"), known=KNOWN, model=MODEL)
        self.assertEqual({**expected, "written": []}, report)
        # A canary in the environment under the key name: no output holds a key value.
        self.assertNotIn(CANARY, result.stdout)
        self.assertEqual([], self.recorded())
        self.assertEqual([], os.listdir(self.private))
        self.assertEqual([], os.listdir(self.home))

    def test_the_display_line_gives_each_path_as_one_argument(self):
        report = json.loads(self.run_cli("--projects-dir", str(self.base / "it's \"my\" projects")).stdout)
        clone, private = str(self.base / "the clone"), str(self.private)
        files = ["--env-file", private + "/seat.env", "-f", clone + "/deploy/compose/compose.yaml",
                 "-f", clone + "/deploy/compose/compose.projects.yaml"]
        for command in report["commands"][:-1]:
            with self.subTest(runtime=command["runtime"], step=command["step"]):
                result = subprocess.run(["/bin/sh", "-c", command["display"]], env=self.env, cwd=self.base, text=True,
                                        capture_output=True, check=False)
                self.assertEqual((0, ""), (result.returncode, result.stderr))
                self.assertEqual([["git", "-C", clone, "rev-parse", "--short", "HEAD"],
                                  [command["runtime"], "compose", *files, *command["argv"][8:]]], self.recorded())
                # The tool gets the commit that `git` printed.
                self.assertEqual("abc1234", (self.base / "commit").read_text())
        seat_env = [line for line in report["seatEnv"] if line.startswith("SEAT_PROJECTS_DIR=")]
        self.assertEqual(["SEAT_PROJECTS_DIR=\"" + str(self.base) + "/it's \\\"my\\\" projects\""], seat_env)

    def test_write_creates_the_five_files_with_mode_600_and_refuses_a_second_run(self):
        result = self.run_cli("--write", "--enable", "herdr", "--thinking", "xhigh")
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        report = json.loads(result.stdout)
        self.assertEqual([str(self.private / name) for name in FILES], report["written"])
        self.assertEqual(sorted(FILES), sorted(os.listdir(self.private)))
        for name in FILES:
            info = os.stat(self.private / name)
            self.assertEqual((True, 0o600), (stat.S_ISREG(info.st_mode), stat.S_IMODE(info.st_mode)), name)
        self.assertEqual(report["overlay"], json.loads((self.private / "overlay.json").read_text()))
        self.assertEqual(report["seatEnv"], (self.private / "seat.env").read_text().splitlines())
        self.assertEqual(report["composeEnv"], (self.private / "compose.env").read_text().splitlines())
        self.assertEqual(KEY_LINE, (self.private / "authorized_keys").read_text())
        self.assertEqual({"litellm-codex": {MODEL: ["xhigh"]}}, report["registry"])
        self.assertEqual(report["registry"], json.loads((self.private / "registry.json").read_text()))
        self.assertEqual({**CHOICE, "thinking": "xhigh"}, report["overlay"]["roles"]["interactive"])
        # The key line is empty, and no file and no output holds the value of the environment.
        self.assertIn(KEY_VAR + "=''", report["composeEnv"])
        for text in (result.stdout, *((self.private / name).read_text() for name in FILES)):
            self.assertNotIn(CANARY, text)
        self.assertEqual([], self.recorded())
        # The written overlay passes `validate` and `plan` of the same CLI with the written registry.
        printed = {}
        for action in ("validate", "plan"):
            checked = subprocess.run([sys.executable, str(CLI), action, "--overlay", str(self.private / "overlay.json"),
                                      "--registry", str(self.private / "registry.json")],
                                     env=self.env, cwd=self.base, text=True, capture_output=True, check=False)
            self.assertEqual((0, ""), (checked.returncode, checked.stderr), action)
            printed[action] = json.loads(checked.stdout)
        self.assertIs(True, printed["validate"]["valid"])
        # What `plan` prints for the role: its status and the gateway setup. Its launch line names no model;
        # the model is in `settings.json` of the profile, which `plan` lists.
        self.assertEqual("selected", printed["plan"]["routeStatus"]["interactive"])
        self.assertEqual([{"instruction": "TENANTEXT_LITELLM_BASE_URL=" + URL, "kind": "process_environment",
                           "name": "TENANTEXT_LITELLM_BASE_URL"},
                          {"kind": "gateway_auth", "method": "process_environment", "name": KEY_VAR,
                           "provider": "litellm-codex"}], printed["plan"]["routeSetup"])
        self.assertIn({"kind": "file", "mode": "0600", "path": "settings.json"}, printed["plan"]["files"])
        launch = printed["plan"]["commands"]["launchDisplayOnly"]
        self.assertTrue(launch.startswith("TENANTEXT_LITELLM_BASE_URL=" + URL + " "), launch)
        self.assertIn("PI_CODING_AGENT_DIR=/home/pi/.pi/profiles/main pi", launch)
        self.assertNotIn(MODEL, launch)
        # Without the registry file, the same overlay stops: the entrypoint passes the file when it exists.
        checked = subprocess.run([sys.executable, str(CLI), "validate", "--overlay", str(self.private / "overlay.json")],
                                 env=self.env, cwd=self.base, text=True, capture_output=True, check=False)
        self.assertEqual((2, "registry_required: registry"), (checked.returncode, json.loads(checked.stderr)["error"]))
        before = {name: (self.private / name).read_bytes() for name in FILES}
        self.refused("target_exists: compose-plan.overlay.json", "--write")
        self.assertEqual(before, {name: (self.private / name).read_bytes() for name in FILES})

    def test_write_refuses_when_one_file_exists_and_writes_none(self):
        for name in FILES:
            with self.subTest(name=name):
                (self.private / name).write_text("kept")
                self.refused("target_exists: compose-plan." + name, "--write")
                self.assertEqual([name], os.listdir(self.private))
                self.assertEqual("kept", (self.private / name).read_text())
                (self.private / name).unlink()
        # A link with a missing target is an entry too.
        (self.private / "seat.env").symlink_to(self.base / "absent")
        self.refused("target_exists: compose-plan.seat.env", "--write")
        self.assertFalse((self.base / "absent").exists())

    def test_write_refuses_a_bad_private_directory(self):
        self.refused("private_dir_missing: compose-plan.private_dir", "--write", **{"--private-dir": str(self.base / "absent")})
        (self.base / "link").symlink_to(self.private)
        self.refused("private_dir_unsafe: compose-plan.private_dir", "--write", **{"--private-dir": str(self.base / "link")})
        # Never a write into the directory that a bare `pi` opens, and never into the kit.
        live = self.home / ".pi/agent/seat"
        live.mkdir(parents=True)
        self.refused("under_pi_agent: compose-plan.private_dir", "--write", **{"--private-dir": str(live)})
        self.assertEqual([], os.listdir(live))
        self.refused("under_kit: compose-plan.private_dir", "--write", **{"--private-dir": str(ROOT / ".local/seat")})
        self.assertEqual([], os.listdir(self.private))

    def test_public_key_file(self):
        self.refused("input_missing: compose-plan.public_key", **{"--public-key": str(self.base / "absent.pub")})
        self.key.write_text("")
        self.refused("public_key_missing: compose-plan.public_key")
        self.key.write_text(PRIVATE)
        self.refused("private_key: compose-plan.public_key")
        self.refused("private_key: compose-plan.public_key", "--write")
        self.key.write_text(KEY_LINE + KEY_LINE)
        self.refused("public_key_count: compose-plan.public_key has 2 key lines", "--write")
        self.assertEqual([], os.listdir(self.private))
        (self.base / "key link").symlink_to(self.key)
        self.refused("input_not_regular: compose-plan.public_key", **{"--public-key": str(self.base / "key link")})

    def test_refusals_of_the_cli(self):
        self.refused("integer: compose-plan.uid", **{"--uid": "501x"})
        self.refused("integer: compose-plan.gid", **{"--gid": "-1"})
        self.refused("integer: compose-plan.ssh_port", **{"--ssh-port": "22 " + CANARY})
        self.refused("account_id: compose-plan.uid", **{"--uid": "0"})
        self.refused("port: compose-plan.ssh_port", **{"--ssh-port": "22"})
        self.refused("reserved_account: compose-plan.account", **{"--account": "root"})
        self.refused("credential_free_https_url: compose-plan.gateway_url", **{"--gateway-url": "http://" + CANARY + "/v1"})
        # The overlay rules of `validate` run on the plan: another key name, and a memory module without its choices.
        self.refused("undeclared_env: overlay.env", **{"--key-var": "OTHER_GATEWAY_KEY"})
        self.refused("memory_choices_required: overlay.memory", "--enable", "hermes")
        # The model: one of the three aliases under the gateway provider, and no model of another provider.
        self.refused("unsupported_gateway_model: compose-plan.model", **{"--model": "codex1/" + CANARY})
        self.refused("unsupported_gateway_model: compose-plan.model", **{"--model": "litellm-codex/" + MODEL})
        self.refused("thinking: compose-plan.thinking", "--thinking", "ultra")
        self.refused("unsupported_gateway_model: overlay.modelRoutes.choice", "--provider", "fake-native",
                     **{"--model": "team/slash-id"})
        missing = subprocess.run([sys.executable, str(CLI), "compose-plan", *self.arguments(**{"--model": None})],
                                 env=self.env, cwd=self.base, text=True, capture_output=True, check=False)
        self.assertEqual((2, ""), (missing.returncode, missing.stdout))
        self.assertIn("--model", missing.stderr)
        self.assertEqual([], os.listdir(self.private))


if __name__ == "__main__":
    unittest.main()
