"""The installer script of the component agy in a scratch home; never the real ~/.gemini.

The tests check the files that a run keeps and the files that it must not create. They pin no message text.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "kit_agy.py"
SKILL = ROOT / "packages" / "artifacts" / "skills" / "artifacts"


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

    def run_kit(self, *args, gemini=None):
        env = {"HOME": str(self.home), "PATH": str(self.bin), "LANG": "C.UTF-8"}
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
        settings = {"trustedWorkspaces": ["/work/one"], "permissions": {"allow": ["mcp(other/tool)"]}}
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

        done = self.run_kit("apply", "--skill", str(SKILL), "--artifacts")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for name in ("style.md", "tenant-kit.md", "tenant-kit-artifacts.md"):
            self.assertTrue((config / "rules" / name).is_symlink(), name)
        self.assertEqual((config / "skills/artifacts").resolve(), SKILL)
        self.assertLessEqual({"herdr", "tenant-kit", "openviking"}, set(self.read_json(config / "hooks.json")))
        self.assertIn("openviking", self.read_json(config / "mcp_config.json")["mcpServers"])
        allow = self.read_json(cli / "settings.json")["permissions"]["allow"]
        for rule in ("mcp(other/tool)", "mcp(openviking/find)", "mcp(openviking/search)", "mcp(openviking/read)"):
            self.assertIn(rule, allow)

        done = self.run_kit("remove")
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
        self.assertFalse((self.gemini / "antigravity-cli/settings.json").exists())

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

    def test_two_backups_in_the_same_second_both_stay(self):
        spec = importlib.util.spec_from_file_location("kit_agy_under_test", SCRIPT)
        kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kit)
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
