"""The installer script of the component agy in a scratch home; never the real ~/.gemini.

The tests check the files that a run keeps and the files that it must not create. They pin no message text.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "kit_agy.py"
SKILL = ROOT / "packages" / "artifacts" / "skills" / "artifacts"
HERDR = ROOT / "packages" / "tenantext" / "skills" / "herdr"
DUMMIES = ROOT / "packages" / "tenantext" / "skills" / "coordinator-skills" / "dummies"
OKKNOW = ROOT / "packages" / "okknow" / "skills" / "okknow"
SANDBOX_SKILLS = ("--skill", str(HERDR), "--skill", str(DUMMIES), "--skill", str(OKKNOW))


def load_kit():
    spec = importlib.util.spec_from_file_location("kit_agy_under_test", SCRIPT)
    kit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(kit)
    return kit


def tree(folder):
    """Each path below folder, with links listed and not followed."""
    return sorted(str(path.relative_to(folder)) for path in Path(folder).rglob("*"))


class KitAgy(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.home = Path(scratch.name) / "home"
        self.gemini = self.home / ".gemini"
        self.bin = Path(scratch.name) / "bin"
        self.bin.mkdir(parents=True)
        self.home.mkdir()

    def run_kit(self, *args, gemini=None, env=None):
        env = {"HOME": str(self.home), "PATH": str(self.bin), "LANG": "C.UTF-8", **(env or {})}
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args, "--gemini", str(gemini or self.gemini)],
                              env=env, capture_output=True, text=True, timeout=60, check=False)

    def write_json(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n")

    def read_json(self, path):
        return json.loads(path.read_text())

    def test_apply_then_remove_keeps_foreign_data(self):
        config = self.gemini / "config"
        cli = self.gemini / "antigravity-cli"
        plugin = self.home / ".claude/plugins/cache/openviking/openviking-memory/1.2.0"
        (plugin / "servers").mkdir(parents=True)
        (plugin / "servers/mcp-proxy.mjs").write_text("// fake proxy\n")
        fake_herdr = self.bin / "herdr"
        fake_herdr.write_text("#!/bin/sh\necho installed\n")
        fake_herdr.chmod(0o755)

        hooks = {"herdr": {"PreInvocation": [{"type": "command", "command": "sh herdr-agent-state.sh", "timeout": 5}]}}
        mcp = {"mcpServers": {"other": {"command": "other-server", "args": []}}}
        settings = {"trustedWorkspaces": ["/work/one"],
                    "permissions": {"allow": ["mcp(other/tool)", "command(git status)"]}}
        self.write_json(config / "hooks.json", hooks)
        self.write_json(config / "mcp_config.json", mcp)
        self.write_json(cli / "settings.json", settings)
        (cli / "settings.json").chmod(0o600)
        (cli / "user-data.bin").write_bytes(b"\x00user data\n")
        (config / "rules").mkdir()
        (config / "rules/mine.md").write_text("my rule\n")
        (config / "skills/mine").mkdir(parents=True)
        (config / "skills/mine/SKILL.md").write_text("my skill\n")
        outside = self.home / "elsewhere-skill"
        outside.mkdir()
        (outside / "SKILL.md").write_text("an outside skill\n")
        (config / "skills/elsewhere").symlink_to(outside)
        (self.gemini / "GEMINI.md").write_text("my instructions\n")
        user_files = {path: path.read_bytes() for path in (
            config / "rules/mine.md", config / "skills/mine/SKILL.md", cli / "user-data.bin", self.gemini / "GEMINI.md")}

        runtime = self.home / "run"
        done = self.run_kit("apply", "--skill", str(SKILL), *SANDBOX_SKILLS, "--artifacts",
                            env={"XDG_RUNTIME_DIR": str(runtime)})
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for name in ("style.md", "tenant-kit.md", "tenant-kit-artifacts.md"):
            self.assertTrue((config / "rules" / name).is_symlink(), name)
        self.assertEqual((config / "skills/artifacts").resolve(), SKILL)
        self.assertLessEqual({"herdr", "tenant-kit", "openviking"}, set(self.read_json(config / "hooks.json")))
        self.assertIn("openviking", self.read_json(config / "mcp_config.json")["mcpServers"])
        allow = self.read_json(cli / "settings.json")["permissions"]["allow"]
        # The documented groups (packages/agy/README.md): the OpenViking rules and the sandbox rules of the skills.
        kit = load_kit()
        scripts = lambda folder, names: {"command(python3 " + str(folder / name) + ")" for name in names}
        expected = ({"mcp(openviking/find)", "mcp(openviking/search)", "mcp(openviking/read)",
                     "read_file(" + str(self.home / ".config/herdr-skill") + ")",
                     "write_file(" + str(self.home / ".local/state/herdr-skill") + ")",
                     "write_file(" + str(runtime / "herdr-core") + ")",
                     "read_file(" + str(self.home / ".config/dummies-skill") + ")",
                     "command(okknow read)", "command(okknow ls)", "command(okknow search)"}
                    | scripts(config / "skills/herdr/scripts", kit.HERDR_SCRIPTS)
                    | scripts(HERDR / "scripts", kit.HERDR_SCRIPTS)
                    | scripts(config / "skills/dummies/scripts", ("page.py",))
                    | scripts(DUMMIES / "scripts", ("page.py",)))
        before = settings["permissions"]["allow"]
        self.assertEqual(allow[:len(before)], before)
        added = allow[len(before):]
        self.assertEqual(set(added), expected)
        self.assertEqual(len(added), len(set(added)))

        done = self.run_kit("remove", env={"XDG_RUNTIME_DIR": str(runtime)})
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.read_json(config / "hooks.json"), hooks)
        self.assertEqual(self.read_json(config / "mcp_config.json"), mcp)
        self.assertEqual(self.read_json(cli / "settings.json"), settings)
        self.assertEqual((cli / "settings.json").stat().st_mode & 0o777, 0o600)
        for path, content in user_files.items():
            self.assertEqual(path.read_bytes(), content, path)
        self.assertEqual(os.readlink(config / "skills/elsewhere"), str(outside))
        for link in ("rules/style.md", "rules/tenant-kit.md", "rules/tenant-kit-artifacts.md", "skills/artifacts"):
            self.assertFalse((config / link).is_symlink(), link)
        # The record is the kit's: remove leaves it with no rule.
        self.assertEqual(self.read_json(config / "tenant-kit-allow-rules.json")["rules"], [])

    def test_apply_without_agy_config_creates_nothing(self):
        self.gemini.mkdir()
        before = tree(self.home)
        done = self.run_kit("apply", "--skill", str(SKILL), "--artifacts")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(tree(self.home), before)

    def test_apply_without_plugin_writes_no_openviking_part(self):
        config = self.gemini / "config"
        config.mkdir(parents=True)
        done = self.run_kit("apply", "--skill", str(SKILL))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(set(self.read_json(config / "hooks.json")), {"tenant-kit"})
        self.assertFalse((config / "mcp_config.json").exists())
        # settings.json gets the status line of the kit and no allow rule.
        self.assertNotIn("permissions", self.read_json(self.gemini / "antigravity-cli/settings.json"))

    def test_foreign_entries_with_kit_names_survive(self):
        config = self.gemini / "config"
        plugin = self.home / ".claude/plugins/cache/openviking/openviking-memory/1.0.0"
        (plugin / "servers").mkdir(parents=True)
        (plugin / "servers/mcp-proxy.mjs").write_text("// fake proxy\n")
        (config / "rules").mkdir(parents=True)
        (config / "rules/style.md").write_text("my own style\n")
        second = self.home / "mylink"
        second.symlink_to(ROOT / "packages/agy/rules/tenant-kit.md")
        (config / "rules/tenant-kit.md").symlink_to(second)
        (config / "mcp_config.json").write_text('{"mcpServers":["keep-me"],"other":1}')
        files = (config / "rules/style.md", config / "mcp_config.json")
        before = {path: path.read_bytes() for path in files}

        done = self.run_kit("apply")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content, path)
        self.assertEqual(os.readlink(config / "rules/tenant-kit.md"), str(second))

        foreign = ('{"tenant-kit":{"PreToolUse":[{"matcher":"run_command",'
                   '"hooks":[{"type":"command","command":"my-own-hook"}]}]}}')
        (config / "hooks.json").write_text(foreign)
        done = self.run_kit("remove")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual((config / "hooks.json").read_text(), foreign)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content, path)
        self.assertEqual(os.readlink(config / "rules/tenant-kit.md"), str(second))

    def test_apply_writes_nothing_into_a_linked_or_invalid_hooks_file(self):
        target = self.home / "real-hooks.json"
        target.write_text('{"mine": 1}')
        linked = self.home / "linked"
        (linked / "config").mkdir(parents=True)
        (linked / "config/hooks.json").symlink_to(target)
        invalid = self.home / "invalid"
        (invalid / "config").mkdir(parents=True)
        (invalid / "config/hooks.json").write_text('{"mine": ')

        for gemini in (linked, invalid):
            done = self.run_kit("apply", gemini=gemini)
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(os.readlink(linked / "config/hooks.json"), str(target))
        self.assertEqual(target.read_text(), '{"mine": 1}')
        self.assertEqual((invalid / "config/hooks.json").read_text(), '{"mine": ')

    def test_apply_without_herdr_removes_the_herdr_rules_of_an_earlier_run(self):
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        mine = "command(python3 /opt/mine/scripts/panes.py)"
        self.write_json(settings, {"permissions": {"allow": [mine]}})
        done = self.run_kit("apply", *SANDBOX_SKILLS)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("command(python3 " + str(HERDR / "scripts/init.py") + ")",
                      self.read_json(settings)["permissions"]["allow"])

        done = self.run_kit("apply", "--skill", str(OKKNOW))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        allow = self.read_json(settings)["permissions"]["allow"]
        self.assertEqual(allow[0], mine)
        self.assertIn("command(okknow read)", allow)
        herdr_paths = (str(HERDR), str(self.gemini / "config/skills/herdr"), "herdr-skill", "dummies")
        self.assertFalse([rule for rule in allow[1:] if any(part in rule for part in herdr_paths)], allow)

    def test_a_path_with_a_space_or_a_bracket_gives_no_rule(self):
        (self.gemini / "config").mkdir(parents=True)
        spaced = self.home / "my config"
        bracket = self.home / "state(x)"
        refused = (spaced / "herdr-skill", spaced / "dummies-skill", bracket / "herdr-skill")
        env = {"XDG_CONFIG_HOME": str(spaced), "XDG_STATE_HOME": str(bracket)}
        done = self.run_kit("apply", *SANDBOX_SKILLS, env=env)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        allow = self.read_json(self.gemini / "antigravity-cli/settings.json")["permissions"]["allow"]
        self.assertFalse([rule for rule in allow if str(spaced) in rule or str(bracket) in rule], allow)
        self.assertIn("command(okknow search)", allow)
        # No XDG_RUNTIME_DIR: no mount rule for a runtime folder.
        self.assertFalse([rule for rule in allow if rule.startswith("write_file(")], allow)
        skipped = [line for line in done.stdout.splitlines() if line.startswith("skipped:")]
        for path in refused:
            self.assertTrue([line for line in skipped if str(path) in line], (path, done.stdout))

        quoted = self.home / "it's"
        done = self.run_kit("apply", *SANDBOX_SKILLS, env={"XDG_CONFIG_HOME": str(quoted)})
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        allow = self.read_json(self.gemini / "antigravity-cli/settings.json")["permissions"]["allow"]
        self.assertFalse([rule for rule in allow if str(quoted) in rule], allow)
        self.assertTrue([line for line in done.stdout.splitlines()
                         if line.startswith("skipped:") and str(quoted / "herdr-skill") in line], done.stdout)

    def test_a_skill_folder_of_the_user_gets_no_link_path_rule(self):
        config = self.gemini / "config"
        mine = config / "skills/herdr"
        (mine / "scripts").mkdir(parents=True)
        (mine / "scripts/panes.py").write_text("print('my own script')\n")
        before = {path: path.read_bytes() for path in mine.rglob("*") if path.is_file()}
        done = self.run_kit("apply", *SANDBOX_SKILLS)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertFalse(mine.is_symlink())
        self.assertEqual({path: path.read_bytes() for path in mine.rglob("*") if path.is_file()}, before)
        allow = self.read_json(self.gemini / "antigravity-cli/settings.json")["permissions"]["allow"]
        self.assertFalse([rule for rule in allow if rule.startswith("command(python3 " + str(mine) + "/")], allow)
        self.assertIn("command(python3 " + str(HERDR / "scripts/panes.py") + ")", allow)
        self.assertIn("command(python3 " + str(config / "skills/dummies/scripts/page.py") + ")", allow)

    def test_an_allow_entry_that_is_not_a_string_stays_in_place(self):
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        allow = ["command(git status)", {"rule": "mine"}, ["a", "list"], "mcp(other/tool)"]
        self.write_json(settings, {"permissions": {"allow": allow}})
        done = self.run_kit("apply", "--skill", str(OKKNOW))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.read_json(settings)["permissions"]["allow"][:len(allow)], allow)
        done = self.run_kit("remove")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.read_json(settings)["permissions"]["allow"], allow)

    def fake_plugin(self):
        plugin = self.home / ".claude/plugins/cache/openviking/openviking-memory/1.0.0"
        (plugin / "servers").mkdir(parents=True)
        (plugin / "servers/mcp-proxy.mjs").write_text("// fake proxy\n")

    def test_a_rule_of_the_user_equal_to_a_kit_rule_stays(self):
        (self.gemini / "config").mkdir(parents=True)
        self.fake_plugin()
        settings = self.gemini / "antigravity-cli/settings.json"
        mine = ["command(git status)", "command(okknow ls)", "mcp(openviking/read)"]
        self.write_json(settings, {"permissions": {"allow": mine}})
        for args in (("apply", "--skill", str(OKKNOW)), ("apply",), ("remove",)):
            done = self.run_kit(*args, env={"AGY_OV_PLUGIN_ROOT": ""})
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertEqual(self.read_json(settings)["permissions"]["allow"][:len(mine)], mine, args)
        self.assertEqual(self.read_json(settings)["permissions"]["allow"], mine)

    def test_remove_without_a_record_deletes_no_rule(self):
        # An install of an older kit: kit rules in permissions.allow and no record file.
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        older = ["mcp(openviking/find)", "mcp(openviking/search)", "mcp(openviking/read)", "command(okknow read)",
                 "command(python3 " + str(HERDR / "scripts/panes.py") + ")"]
        self.write_json(settings, {"permissions": {"allow": older}})
        done = self.run_kit("remove")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.read_json(settings)["permissions"]["allow"], older)

    def test_an_invalid_record_adds_no_rule(self):
        config = self.gemini / "config"
        config.mkdir(parents=True)
        self.fake_plugin()
        settings = self.gemini / "antigravity-cli/settings.json"
        record = config / "tenant-kit-allow-rules.json"
        self.write_json(settings, {"permissions": {"allow": ["command(git status)"]}})
        for text in ('{"version": 1, "rules": [', '{"version": true, "rules": []}'):
            record.write_text(text)
            before = record.read_bytes()
            done = self.run_kit("apply", *SANDBOX_SKILLS, env={"AGY_OV_PLUGIN_ROOT": ""})
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertEqual(record.read_bytes(), before)
            self.assertEqual(self.read_json(settings)["permissions"], {"allow": ["command(git status)"]})

    def statusline_of(self, settings):
        return self.read_json(settings).get("statusLine")

    def statusline_record(self):
        return self.read_json(self.gemini / "config/tenant-kit-statusline.json")

    def test_apply_sets_the_kit_statusline_and_remove_deletes_it(self):
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        self.write_json(settings, {"permissions": {"allow": ["command(git status)"]}, "other": 1})
        done = self.run_kit("apply", "--skill", str(OKKNOW))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        value = self.statusline_of(settings)
        # The documented value (packages/agy/README.md), field by field.
        script = ROOT / "packages/agy/scripts/statusline-ops-footer.mjs"
        self.assertEqual(set(value), {"type", "command", "enabled", "padding", "stack_with_default"})
        self.assertEqual(value["type"], "command")
        self.assertEqual(shlex.split(value["command"]), ["node", "--no-warnings", str(script)])
        self.assertIs(value["enabled"], True)
        self.assertEqual(value["padding"], 0)
        self.assertIs(value["stack_with_default"], False)
        self.assertIn("command(okknow read)", self.read_json(settings)["permissions"]["allow"])
        # The allow rules and the status line are one write: one backup.
        self.assertEqual(len(list(settings.parent.glob("settings.json.bak-*"))), 1)
        record = self.gemini / "config/tenant-kit-statusline.json"
        self.assertEqual(self.statusline_record(), {"version": 1, "statusLine": value})
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(record.parent.glob("tenant-kit-statusline.json.bak-*")))

        # The installed command runs: one plain or full footer, exit 0, in a scratch environment.
        scratch_env = {"HOME": str(self.home), "PATH": os.environ.get("PATH", ""), "PI_FOOTER_NO_REFRESH": "1",
                       "NO_COLOR": "1", "XDG_CACHE_HOME": str(self.home / "cache"), "PI_FOOTER_WIDTH": "100"}
        ran = subprocess.run(shlex.split(value["command"]), input=json.dumps({"cwd": str(self.home)}), env=scratch_env,
                             capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertTrue(ran.stdout.strip(), ran.stderr)

        done = self.run_kit("remove")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(self.read_json(settings), {"permissions": {"allow": ["command(git status)"]}, "other": 1})
        self.assertEqual(self.statusline_record(), {"version": 1, "statusLine": None})

    def test_apply_updates_a_recorded_statusline_of_a_moved_clone(self):
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        old = {"type": "command", "command": "node --no-warnings '/old/place/packages/agy/scripts/statusline-ops-footer.mjs'",
               "enabled": True, "padding": 0, "stack_with_default": False}
        self.write_json(settings, {"statusLine": old})
        self.write_json(self.gemini / "config/tenant-kit-statusline.json", {"version": 1, "statusLine": old})
        done = self.run_kit("apply")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        value = self.statusline_of(settings)
        self.assertEqual(shlex.split(value["command"])[2], str(ROOT / "packages/agy/scripts/statusline-ops-footer.mjs"))
        self.assertEqual(self.statusline_record()["statusLine"], value)

    def test_a_statusline_of_the_user_stays_on_apply_and_remove(self):
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        record = self.gemini / "config/tenant-kit-statusline.json"
        command = "node --no-warnings '" + str(ROOT / "packages/agy/scripts/statusline-ops-footer.mjs") + "'"
        kit_value = {"type": "command", "command": command, "enabled": True, "padding": 0, "stack_with_default": False}
        mine = [
            # No record: the same command is the user's.
            ({"type": "command", "command": "node /opt/mine/statusline.mjs"}, None),
            ({"type": "command", "command": "node '/second/clone/packages/agy/scripts/statusline-ops-footer.mjs'"},
             None),
            (dict(kit_value), None),
            # A record: the user turned the kit value off, or added a key.
            ({**kit_value, "enabled": False}, kit_value),
            ({**kit_value, "mine": 1}, kit_value),
            # false is not 0 in JSON, although False == 0 in Python.
            ({**kit_value, "padding": False}, kit_value),
            ("a string", kit_value),
        ]
        for value, recorded in mine:
            self.write_json(settings, {"statusLine": value, "permissions": {"allow": []}})
            if recorded is None:
                record.unlink(missing_ok=True)
            else:
                self.write_json(record, {"version": 1, "statusLine": recorded})
            done = self.run_kit("apply", "--skill", str(OKKNOW))
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertEqual(self.statusline_of(settings), value)
            self.assertTrue([line for line in done.stdout.splitlines()
                             if line.startswith("skipped:") and "statusLine" in line], done.stdout)
            # A statusLine of the user does not block the allow rules.
            self.assertIn("command(okknow ls)", self.read_json(settings)["permissions"]["allow"])
            done = self.run_kit("remove")
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertEqual(self.read_json(settings), {"statusLine": value, "permissions": {"allow": []}})

    def test_an_invalid_statusline_record_touches_no_statusline(self):
        (self.gemini / "config").mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        record = self.gemini / "config/tenant-kit-statusline.json"
        target = self.home / "elsewhere.json"
        target.write_text('{"version": 1, "statusLine": null}')
        command = "node --no-warnings '" + str(ROOT / "packages/agy/scripts/statusline-ops-footer.mjs") + "'"
        kit_value = {"type": "command", "command": command, "enabled": True, "padding": 0, "stack_with_default": False}
        version_true = json.dumps({"version": True, "statusLine": kit_value})
        for make in (lambda: record.write_text('{"version": 1, '), lambda: record.symlink_to(target),
                     lambda: record.write_text(version_true)):
            record.unlink(missing_ok=True)
            make()
            self.write_json(settings, {"permissions": {"allow": []}})
            done = self.run_kit("apply", "--skill", str(OKKNOW))
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
            self.assertNotIn("statusLine", self.read_json(settings))
            self.assertIn("command(okknow ls)", self.read_json(settings)["permissions"]["allow"])
        self.assertEqual(record.read_text(), version_true)
        self.assertEqual(target.read_text(), '{"version": 1, "statusLine": null}')

    def test_malformed_permissions_skip_the_whole_settings_file(self):
        config = self.gemini / "config"
        config.mkdir(parents=True)
        settings = self.gemini / "antigravity-cli/settings.json"
        allow_record = config / "tenant-kit-allow-rules.json"
        cases = [({"permissions": ["a list"]}, None), ({"permissions": {"allow": "a string"}}, None),
                 ({"permissions": {"allow": {}}}, '{"version": 1, "rules": [')]
        for data, record_text in cases:
            self.write_json(settings, data)
            if record_text is None:
                allow_record.unlink(missing_ok=True)
            else:
                allow_record.write_text(record_text)
            before = settings.read_bytes()
            # No wanted rule (no skill, no plugin), and then apply with rules and remove.
            for args in (("apply",), ("apply", "--skill", str(OKKNOW)), ("remove",)):
                done = self.run_kit(*args, env={"AGY_OV_PLUGIN_ROOT": ""})
                self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertEqual(settings.read_bytes(), before, (data, args))
                self.assertTrue([line for line in done.stdout.splitlines()
                                 if line.startswith("skipped:") and "permissions" in line], done.stdout)
            self.assertFalse((config / "tenant-kit-statusline.json").exists())
            self.assertFalse(list(settings.parent.glob("settings.json.bak-*")))

    def test_each_pane_script_of_the_herdr_skill_has_a_rule(self):
        # A command-line script: a name without a leading _ and a line `if __name__ == "__main__"`.
        kit = load_kit()
        scripts = {path.name for path in (HERDR / "scripts").glob("*.py") if not path.name.startswith("_")
                   and re.search(r'^if __name__ == "__main__"', path.read_text(), re.M)}
        self.assertEqual(scripts - set(kit.HERDR_SCRIPTS) - set(kit.HERDR_NOT_PANE), set())

    def test_two_backups_in_the_same_second_both_stay(self):
        kit = load_kit()
        hooks = self.gemini / "config/hooks.json"
        hooks.parent.mkdir(parents=True)
        original = b'{"mine":{"x":1}}'
        hooks.write_bytes(original)
        env = {"HOME": str(self.home), "PATH": str(self.bin), "AGY_OV_PLUGIN_ROOT": ""}
        with mock.patch.dict(os.environ, env), mock.patch.object(kit, "utc_stamp", return_value="20260101T000000Z"), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(kit.main(["apply", "--gemini", str(self.gemini)]), 0)
            self.assertEqual(kit.main(["remove", "--gemini", str(self.gemini)]), 0)
        backups = sorted(hooks.parent.glob("hooks.json.bak-*"))
        self.assertIn(original, [backup.read_bytes() for backup in backups])


if __name__ == "__main__":
    unittest.main()
