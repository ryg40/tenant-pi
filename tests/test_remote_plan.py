"""Remote plan contract: SSH command lines as data, exact argument boundaries, no SSH option, no process.

A fake `ssh` stands for the remote login shell. No test opens a network connection.
"""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

from scripts.remote_plan import APPROVAL, remote_plan
from scripts.validate import Invalid

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
CANARY = "CANARY_SECRET"
TARGET, USER = "deploy@build-host.example.invalid", "deploy"
# A space, an apostrophe and a double quote: each must reach the remote command as one argument.
HOME = "/home/deploy user/it's a \"home\""
CHANGING = {"init-private", "generate"}


class PlanTests(unittest.TestCase):
    def test_shape_and_stage_order(self):
        plan = remote_plan(TARGET, USER, HOME)
        self.assertEqual({"runs", "sshTarget", "remoteUser", "remoteHome", "paths", "hostKeyChecking", "stages"}, set(plan))
        self.assertEqual((False, TARGET, USER, HOME, "unchanged"),
                         (plan["runs"], plan["sshTarget"], plan["remoteUser"], plan["remoteHome"], plan["hostKeyChecking"]))
        self.assertEqual({"clone": HOME + "/tenant-pi", "privateDir": HOME + "/.config/tenant-pi",
                          "profile": HOME + "/.pi/profiles/main", "herdrConfig": HOME + "/.config/herdr"}, plan["paths"])
        self.assertEqual(["identity", "home-owner", "tools", "herdr", "check-runtime", "check-herdr", "herdr-skill-files",
                          "init-private", "plan", "generate", "inventory"], [stage["stage"] for stage in plan["stages"]])
        for stage in plan["stages"]:
            with self.subTest(stage=stage["stage"]):
                self.assertEqual(stage["stage"] in CHANGING, stage["changes"])
                self.assertEqual(APPROVAL if stage["changes"] else None, stage.get("approval"))
                # The display line is the same argument list for a local POSIX shell.
                self.assertEqual(stage["argv"], shlex.split(stage["display"]))
        self.assertEqual(plan, remote_plan(TARGET, USER, HOME))

    def test_each_line_is_ssh_target_and_one_command_without_an_option(self):
        for target in (TARGET, "build-alias"):
            for stage in remote_plan(target, USER, HOME)["stages"]:
                with self.subTest(target=target, stage=stage["stage"]):
                    argv = stage["argv"]
                    self.assertEqual((4, "ssh", "--", target), (len(argv), *argv[:3]))
                    text = json.dumps(stage)
                    for forbidden in ("StrictHostKeyChecking", "UserKnownHostsFile", "ProxyCommand", "sudo",
                                      "password", "IdentityFile", "sshpass"):
                        self.assertNotIn(forbidden, text)
                    # The remote command holds no SSH option word either.
                    self.assertFalse([word for word in shlex.split(argv[3]) if word in ("-o", "-F", "-i", "-J")])

    def test_no_stage_installs_or_changes_herdr(self):
        text = json.dumps(remote_plan(TARGET, USER, HOME))
        for forbidden in ("herdr update", "herdr channel", "herdr server", "herdr session", "install.sh", "npm install",
                          "curl", "wget", "useradd"):
            self.assertNotIn(forbidden, text)

    def test_static_diagnostics_do_not_echo_the_input(self):
        cases = (
            (("-oProxyCommand=" + CANARY, USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("-F/tmp/" + CANARY, USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("host -o StrictHostKeyChecking=no", USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("host;" + CANARY, USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("deploy:" + CANARY + "@host", USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("host:2222", USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("", USER, HOME), "ssh_target: remote-plan.ssh_target"),
            ((None, USER, HOME), "ssh_target: remote-plan.ssh_target"),
            (("host\n" + CANARY, USER, HOME), "ssh_target: remote-plan.ssh_target"),
            # Each ordinary step runs as the account that owns the install.
            (("root@host", USER, HOME), "ssh_user_mismatch: remote-plan.ssh_target"),
            ((TARGET, "Deploy " + CANARY, HOME), "remote_user: remote-plan.remote_user"),
            ((TARGET, "-" + CANARY.lower(), HOME), "remote_user: remote-plan.remote_user"),
            ((TARGET, "", HOME), "remote_user: remote-plan.remote_user"),
            ((TARGET, USER, "home/" + CANARY), "absolute_path: remote-plan.remote_home"),
            ((TARGET, USER, "~/" + CANARY), "absolute_path: remote-plan.remote_home"),
            ((TARGET, USER, "/home/../" + CANARY), "absolute_path: remote-plan.remote_home"),
            ((TARGET, USER, "/home/deploy/"), "absolute_path: remote-plan.remote_home"),
            ((TARGET, USER, "/home/$(" + CANARY + ")"), "shell_or_template: remote-plan.remote_home"),
            ((TARGET, USER, "/home/`" + CANARY + "`"), "shell_or_template: remote-plan.remote_home"),
            ((TARGET, USER, "/home/a;" + CANARY), "absolute_path: remote-plan.remote_home"),
        )
        for arguments, expected in cases:
            with self.subTest(expected=expected, arguments=arguments):
                with self.assertRaises(Invalid) as caught:
                    remote_plan(*arguments)
                self.assertEqual(expected, str(caught.exception))


class FakeSshTests(unittest.TestCase):
    """Each line runs through a fake `ssh` that gives its command to `sh -c`, as a remote login shell does."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-remote-plan-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.log = self.base / "ssh.log"
        self.calls = self.base / "calls"
        self.calls.mkdir()
        # The fake refuses every option: a line with `-o` or without `--` fails here.
        self.fake("ssh", 'if [ "$#" -ne 3 ] || [ "$1" != "--" ]; then echo "bad ssh call" >&2; exit 97; fi\n'
                         'case "$2" in -*) exit 98;; esac\n'
                         'printf \'%s\\n\' "$2" >> \'' + str(self.log) + "'\n"
                         'exec /bin/sh -c "$3"')
        # A remote tool that records its exact arguments, one file for each call, one line for each argument.
        recorder = ('n=0\nfor f in \'' + str(self.calls) + '\'/*; do if [ -e "$f" ]; then n=$((n + 1)); fi; done\n'
                    'for a in "$0" "$@"; do printf \'%s\\0\' "$a"; done > \'' + str(self.calls) + '\'/"$n"')
        for name in ("stat", "python3", "node", "npm", "git", "herdr"):
            self.fake(name, recorder)
        self.fake("id", "echo " + USER)
        self.fake("uname", "echo Linux")
        self.env = {"PATH": str(self.bin), "HOME": HOME, "EXAMPLE_API_KEY": CANARY}

    def fake(self, name, body):
        command = self.bin / name
        command.write_text("#!/bin/sh\n" + body + "\n")
        command.chmod(0o700)

    def run_stage(self, stage, **env):
        return subprocess.run(stage["argv"], env={**self.env, **env}, cwd=self.base, text=True, capture_output=True,
                              check=False)

    def recorded(self):
        calls = []
        for name in sorted(os.listdir(self.calls), key=int):
            parts = (self.calls / name).read_bytes().decode().split("\0")[:-1]
            calls.append([Path(parts[0]).name, *parts[1:]])
            (self.calls / name).unlink()
        return calls

    def test_each_argument_reaches_the_remote_command_unchanged(self):
        plan = remote_plan(TARGET, USER, HOME)
        clone, private, profile = (plan["paths"][key] for key in ("clone", "privateDir", "profile"))
        cli = ["python3", clone + "/scripts/tenant_pi.py"]
        expected = {
            "home-owner": [["stat", "-c", "%U", "--", HOME]],
            "tools": [["node", "--version"], ["npm", "--version"], ["python3", "--version"], ["git", "--version"]],
            "herdr": [["herdr", "--version"]],
            "check-runtime": [[*cli, "check-runtime"]],
            "check-herdr": [[*cli, "check-herdr"]],
            "init-private": [[*cli, "init-private", "--dir", private, "--target", profile]],
            "plan": [[*cli, "plan", "--overlay", private + "/overlay.json"]],
            "generate": [[*cli, "generate", "--overlay", private + "/overlay.json", "--target", profile]],
            "inventory": [[*cli, "inventory", "--dir", profile]],
        }
        for stage in plan["stages"]:
            if stage["stage"] not in expected:
                continue
            with self.subTest(stage=stage["stage"]):
                result = self.run_stage(stage)
                self.assertEqual((0, ""), (result.returncode, result.stderr))
                self.assertEqual(expected[stage["stage"]], self.recorded())
        self.assertEqual({TARGET}, set(self.log.read_text().splitlines()))

    def test_the_display_line_gives_the_same_arguments_through_a_local_shell(self):
        stage = next(stage for stage in remote_plan(TARGET, USER, HOME)["stages"] if stage["stage"] == "home-owner")
        result = subprocess.run(["/bin/sh", "-c", stage["display"]], env=self.env, cwd=self.base, text=True,
                                capture_output=True, check=False)
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual([["stat", "-c", "%U", "--", HOME]], self.recorded())

    def test_identity_passes_only_for_the_named_account_home_and_system(self):
        identity = remote_plan(TARGET, USER, HOME)["stages"][0]
        self.assertEqual("identity", identity["stage"])
        self.assertEqual(0, self.run_stage(identity).returncode)
        self.assertNotEqual(0, self.run_stage(identity, HOME="/home/other").returncode)
        self.fake("id", "echo other")
        self.assertNotEqual(0, self.run_stage(identity).returncode)
        self.fake("id", "echo " + USER)
        self.fake("uname", "echo Darwin")
        self.assertNotEqual(0, self.run_stage(identity).returncode)

    def test_skill_file_stage_reads_the_path_with_spaces(self):
        stage = next(stage for stage in remote_plan(TARGET, USER, str(self.base / "remote home"))["stages"]
                     if stage["stage"] == "herdr-skill-files")
        self.assertNotEqual(0, self.run_stage(stage).returncode)
        skill = self.base / "remote home/tenant-pi/packages/tenantext/skills/herdr"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("x")
        self.assertEqual(0, self.run_stage(stage).returncode)

    def test_cli_prints_the_plan_and_starts_no_process(self):
        marker = self.base / "ssh-ran"
        self.fake("ssh", ": > '" + str(marker) + "'")
        env = {**self.env, "PATH": str(self.bin) + os.pathsep + os.path.dirname(sys.executable), "PYTHONDONTWRITEBYTECODE": "1",
               "SSH_AUTH_SOCK": "/tmp/" + CANARY, "HOME": str(self.base)}
        result = subprocess.run([sys.executable, str(CLI), "remote-plan", "--ssh-target", TARGET, "--remote-user", USER,
                                 "--remote-home", HOME], env=env, cwd=self.base, text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        self.assertEqual(remote_plan(TARGET, USER, HOME), json.loads(result.stdout))
        self.assertNotIn(CANARY, result.stdout)
        self.assertFalse(marker.exists())
        self.assertEqual([], self.recorded())
        self.assertEqual(sorted(["bin", "calls"]), sorted(os.listdir(self.base)))
        bad = subprocess.run([sys.executable, str(CLI), "remote-plan", "--ssh-target=-oProxyCommand=" + CANARY,
                              "--remote-user", USER, "--remote-home", HOME], env=env, cwd=self.base, text=True,
                             capture_output=True, check=False)
        self.assertEqual((2, ""), (bad.returncode, bad.stdout))
        self.assertEqual({"candidate_created": False, "error": "ssh_target: remote-plan.ssh_target"}, json.loads(bad.stderr))
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
