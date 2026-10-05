"""Private-directory creation: the created tree, the modes, every refusal; disposable HOME only."""
import json
import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import private_init
from scripts.private_init import INPUTS, MAX_PATH, TEMPLATES, check_target, init, report, with_target
from scripts.profile_write import WriteError
from scripts.validate import SAMPLE_TARGET, Invalid

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
NAMES = {"overlay.json", "registry.json", "install-log.md", "accepted-drift.md", ".gitignore"}


def contents():
    return {name: (ROOT / source).read_bytes() for name, source in TEMPLATES.items()}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-private-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.agent = self.home / ".pi/agent"
        self.agent.mkdir(parents=True, mode=0o700)
        for name in ("auth.json", "models.json", "settings.json"):
            (self.agent / name).write_text("CANARY_PRIVATE")
        self.parent = self.base / "owned parent"
        self.parent.mkdir(mode=0o700)
        self.dir = self.parent / "private dir"
        self.sentinel = self.base / "outside"
        self.sentinel.write_text("KEEP")

    def tree(self, directory=None):
        directory = self.dir if directory is None else directory
        return {str(p.relative_to(directory)) for p in directory.rglob("*")}

    def check_tree(self, directory=None, overlay=None):
        """The exact tree. Each file equals its template; `overlay` gives other bytes for `overlay.json`."""
        directory = self.dir if directory is None else directory
        self.assertEqual(NAMES | {INPUTS}, self.tree(directory))
        self.assertEqual(0o700, stat.S_IMODE(os.lstat(directory).st_mode))
        self.assertEqual(0o700, stat.S_IMODE(os.lstat(directory / INPUTS).st_mode))
        self.assertTrue(stat.S_ISDIR(os.lstat(directory / INPUTS).st_mode))
        for name, source in TEMPLATES.items():
            info = os.lstat(directory / name)
            self.assertTrue(stat.S_ISREG(info.st_mode))
            self.assertEqual(0o600, stat.S_IMODE(info.st_mode))
            expected = overlay if overlay is not None and name == "overlay.json" else (ROOT / source).read_bytes()
            self.assertEqual(expected, (directory / name).read_bytes())


class InitTests(Fixture):
    def rejected(self, rule, field, *, directory=None, data=None, forbidden=(), created=False):
        directory = str(self.dir if directory is None else directory)
        with self.assertRaises((Invalid, WriteError)) as caught:
            init(directory, contents() if data is None else data, forbidden)
        self.assertEqual(f"{rule}: {field}", str(caught.exception))
        self.assertEqual(created, getattr(caught.exception, "candidate_created", False))
        self.assertEqual("KEEP", self.sentinel.read_text())
        # A diagnostic names a rule and a field, never a path or a value.
        self.assertNotIn(str(self.base), str(caught.exception))
        self.assertNotIn("CANARY", str(caught.exception))

    def test_templates_are_the_fixed_tracked_files(self):
        self.assertEqual(NAMES, set(TEMPLATES))
        self.assertEqual("config/config.example.json", TEMPLATES["overlay.json"])
        for name in NAMES - {"overlay.json"}:
            self.assertTrue(TEMPLATES[name].startswith("config/private/"))
        self.assertEqual(b"{}\n", (ROOT / TEMPLATES["registry.json"]).read_bytes())
        ignore = (ROOT / TEMPLATES[".gitignore"]).read_text().splitlines()
        for line in ("inputs/", ".env", ".env.*", "auth.json", "models.json", "mcp-adapter.json", "sessions/",
                     "*.key", "*.pem", "*.db", "*.sqlite", "*baseline*.json"):
            self.assertIn(line, ignore)
        # No negation and no rule that hides a file the directory must track.
        self.assertFalse([line for line in ignore if line.startswith("!")])
        for name in NAMES:
            self.assertNotIn(name, ignore)

    def test_target_form_and_overlay_bytes(self):
        template = (ROOT / TEMPLATES["overlay.json"]).read_bytes()
        parsed = json.loads(template)
        self.assertEqual(SAMPLE_TARGET, parsed["target"]["agentDir"])
        # The form of the tracked example: the sample target gives the template again, byte for byte.
        self.assertEqual(template, with_target(parsed, SAMPLE_TARGET))
        for target in ("/home/EXAMPLE_USER/.pi/profiles/main", "/srv/it's a \"quoted\" profile"):
            with self.subTest(target=target):
                check_target(target)
                data = with_target(parsed, target)
                self.assertEqual({**parsed, "target": {"agentDir": target}}, json.loads(data))
                self.assertEqual(list(parsed), list(json.loads(data)))
                # Exactly one line differs from the template.
                changed = [(old, new) for old, new in zip(template.split(b"\n"), data.split(b"\n"), strict=True) if old != new]
                self.assertEqual([(b'    "agentDir": ' + json.dumps(SAMPLE_TARGET).encode(),
                                   b'    "agentDir": ' + json.dumps(target).encode())], changed)
        # The parsed template stays unchanged.
        self.assertEqual(SAMPLE_TARGET, parsed["target"]["agentDir"])
        for target, rule in (("relative/profile", "absolute_path"), ("~/.pi/profiles/main", "absolute_path"),
                             ("/home/EXAMPLE_USER/../main", "absolute_path"), ("/home/EXAMPLE_USER/main/", "absolute_path"),
                             ("$HOME/.pi/profiles/main", "shell_or_template"), ("", "text"), (None, "text"),
                             ("/home/EXAMPLE_USER/\x00CANARY", "text"), ("/" + "a" * MAX_PATH, "path_too_long"),
                             (SAMPLE_TARGET, "sample_target")):
            with self.subTest(target=str(target)[:30]):
                with self.assertRaises(Invalid) as caught:
                    check_target(target)
                self.assertEqual(rule + ": init-private.target", str(caught.exception))
        check_target("/" + "a" * (MAX_PATH - 1))

    def test_created_tree_and_modes_under_umask_zero(self):
        old = os.umask(0)
        try:
            result = init(str(self.dir), contents())
        finally:
            self.assertEqual(0, os.umask(old))
        self.assertTrue(result.complete)
        self.assertEqual((), result.warnings)
        self.assertEqual(str(self.dir), result.directory)
        self.check_tree()
        self.assertEqual({}, json.loads((self.dir / "registry.json").read_text()))
        self.assertEqual([], list((self.dir / INPUTS).iterdir()))
        self.assertFalse((self.dir / ".git").exists())
        # A second run never adopts the directory and changes nothing in it.
        before = {name: os.lstat(self.dir / name).st_mtime_ns for name in NAMES}
        self.rejected("target_exists", "init-private.dir")
        self.assertEqual(before, {name: os.lstat(self.dir / name).st_mtime_ns for name in NAMES})

    def test_restrictive_umask_is_reported_not_repaired(self):
        old = os.umask(0o277)
        try:
            self.rejected("dir_privacy", "init-private.dir", created=True)
        finally:
            os.umask(old)

    def test_existing_directory_and_other_entries_are_refused(self):
        for kind in ("empty_dir", "file", "link", "dangling", "fifo"):
            with self.subTest(kind=kind):
                if kind == "empty_dir":
                    self.dir.mkdir()
                elif kind == "file":
                    self.dir.write_text("KEEP")
                elif kind in ("link", "dangling"):
                    self.dir.symlink_to(self.sentinel if kind == "link" else self.base / "missing")
                else:
                    os.mkfifo(self.dir)
                before = os.lstat(self.dir)
                self.rejected("target_exists", "init-private.dir")
                self.assertEqual((before.st_ino, before.st_mode), (os.lstat(self.dir).st_ino, os.lstat(self.dir).st_mode))
                self.dir.unlink() if kind != "empty_dir" else self.dir.rmdir()

    def test_parent_absent(self):
        self.rejected("parent_missing", "init-private.dir.parent", directory=self.base / "absent" / "private")
        self.assertFalse((self.base / "absent").exists())

    def test_parent_not_owned_by_the_caller(self):
        # The real owner stays; the caller identity changes. Root may own an ancestor, never the parent.
        uid = os.geteuid()
        rule, field = (("unsafe_parent_owner", "init-private.dir.parent") if uid == 0
                       else ("unsafe_owner", "init-private.dir.parents"))
        with patch.object(private_init.os, "geteuid", return_value=uid + 1):
            self.rejected(rule, field)
        self.assertFalse(os.path.lexists(self.dir))

    @unittest.skipUnless(os.geteuid() == 0, "needs root to give the parent to another user")
    def test_parent_owned_by_another_user(self):
        os.chown(self.parent, 65534, -1)
        self.rejected("unsafe_owner", "init-private.dir.parents")
        self.assertEqual([], list(self.parent.iterdir()))

    def test_unsafe_ancestors(self):
        link = self.base / "linked"
        link.symlink_to(self.parent, target_is_directory=True)
        pipe = self.base / "pipe"
        os.mkfifo(pipe)
        loose = self.base / "writable"
        loose.mkdir()
        loose.chmod(0o777)
        for directory, rule in ((link / "private", "unsafe_path"), (pipe / "private", "unsafe_path"),
                                (loose / "private", "unsafe_permissions")):
            with self.subTest(rule=rule, directory=directory):
                self.rejected(rule, "init-private.dir.parents", directory=directory)
                self.assertFalse(os.path.lexists(directory))
        self.assertEqual([], list(self.parent.iterdir()))

    def test_path_form(self):
        for directory, rule in (("relative/private", "absolute_path"), ("/a/../private", "absolute_path"),
                                ("/a//private", "absolute_path"), ("/a/private/", "absolute_path"),
                                ("/a/$HOME", "shell_or_template"), ("/a/pri\nvate", "text"), ("", "text"),
                                ("/" + "a" * MAX_PATH, "path_too_long")):
            with self.subTest(directory=directory[:20]):
                self.rejected(rule, "init-private.dir", directory=directory)

    def test_forbidden_roots_before_any_filesystem_access(self):
        roots = [("under_kit", str(self.parent)), ("under_pi_agent", str(self.agent))]
        with patch.object(private_init, "_ancestors", side_effect=AssertionError("filesystem access")):
            for directory, rule in ((self.parent, "under_kit"), (self.dir, "under_kit"),
                                    (self.dir / "deep" / "er", "under_kit"),
                                    (self.agent, "under_pi_agent"), (self.agent / "private", "under_pi_agent")):
                with self.subTest(directory=directory):
                    self.rejected(rule, "init-private.dir", directory=directory, forbidden=roots)
        self.assertFalse(os.path.lexists(self.dir))
        # A name that only starts with the text of a root is outside it.
        sibling = self.base / "owned parent2"
        sibling.mkdir(mode=0o700)
        self.assertTrue(init(str(sibling / "private"), contents(), roots).complete)

    def test_inputs_directory_privacy(self):
        original = os.mkdir

        def mkdir(name, mode=0o777, **kwargs):
            original(name, mode, **kwargs)
            if name == INPUTS:
                os.chmod(name, 0o750, dir_fd=kwargs["dir_fd"])

        with patch.object(private_init.os, "mkdir", side_effect=mkdir):
            self.rejected("dir_privacy", "init-private.dir.inputs", created=True)
        self.assertEqual({INPUTS}, self.tree())

    def test_contents_shape(self):
        for data in ([], {}, {**contents(), "extra": b""}, {**contents(), "overlay.json": "text"},
                     {name: data for name, data in contents().items() if name != ".gitignore"}):
            self.rejected("fields", "init-private.templates", data=data)
        self.assertFalse(os.path.lexists(self.dir))

    def test_write_failure_leaves_the_partial_directory_and_a_static_diagnostic(self):
        original = private_init._create_file

        def create(fd, name, data):
            if name == "install-log.md":
                raise OSError("CANARY_SECRET")
            original(fd, name, data)

        with patch.object(private_init, "_create_file", side_effect=create):
            self.rejected("write_failed", "init-private.dir", created=True)
        self.assertTrue(self.dir.is_dir())
        self.assertLess(self.tree(), NAMES | {INPUTS})
        with patch.object(private_init.os, "mkdir", side_effect=OSError("CANARY_SECRET")):
            self.rejected("target_unavailable", "init-private.dir", directory=self.parent / "second")
        self.assertFalse(os.path.lexists(self.parent / "second"))

    def test_replaced_directory_is_detected(self):
        original = os.fsync
        moved = self.parent / "moved"

        def fsync(fd):
            original(fd)
            if (self.dir / ".gitignore").exists() and not moved.exists():
                self.dir.rename(moved)
                self.dir.mkdir()

        with patch.object(private_init.os, "fsync", side_effect=fsync):
            self.rejected("target_changed", "init-private.dir", created=True)

    def test_close_failure_after_the_last_file_is_a_warning(self):
        original_close, original_create = os.close, private_init._create_file
        order, calls = [], []

        def create(fd, name, data):
            original_create(fd, name, data)
            order.append(name)

        def close(fd):
            original_close(fd)
            # Fails only after the module seam reports the last file; each file descriptor closes before that.
            if len([name for name in order if name != "close"]) == len(TEMPLATES):
                order.append("close")
                calls.append(fd)
                raise OSError("CANARY_SECRET")

        with patch.object(private_init, "_create_file", side_effect=create), \
             patch.object(private_init.os, "close", side_effect=close):
            result = init(str(self.dir), contents())
        self.assertTrue(result.complete)
        self.assertEqual(("cleanup_failed: init-private.descriptors",), result.warnings)
        # Call order: the five files in template order, then exactly the three directory descriptors.
        self.assertEqual([*TEMPLATES, "close", "close", "close"], order)
        self.assertEqual(3, len(set(calls)))
        self.check_tree()
        self.assertEqual(["cleanup_failed: init-private.descriptors"], report(result, "/kit")["warnings"])

    def test_close_failure_before_completion_keeps_the_primary_error(self):
        original = os.close
        raised = []

        def close(fd):
            original(fd)
            if os.path.lexists(self.dir):
                raised.append(fd)
                raise OSError("CLEANUP_CANARY")

        with patch.object(private_init, "_create_file", side_effect=OSError("PRIMARY_CANARY")), \
             patch.object(private_init.os, "close", side_effect=close):
            self.rejected("write_failed", "init-private.dir", created=True)
        self.assertEqual(3, len(raised))
        self.assertEqual({INPUTS}, self.tree())

    def test_report_is_deterministic_and_quotes_each_display_line(self):
        directory = "/home/EXAMPLE_USER/it's a \"dir\""
        result = private_init.InitResult(directory, True)
        data = report(result, "/opt/kit root")
        self.assertEqual(data, report(result, "/opt/kit root"))
        self.assertEqual({"directory", "complete", "warnings", "created", "commands"}, set(data))
        self.assertEqual([{"path": directory, "mode": "0700", "kind": "directory"},
                          {"path": directory + "/inputs", "mode": "0700", "kind": "directory"}]
                         + [{"path": directory + "/" + name, "mode": "0600", "kind": "file"} for name in sorted(NAMES)],
                         data["created"])
        commands = data["commands"]
        self.assertEqual({"editDisplayOnly", "validateDisplayOnly", "gitInitDisplayOnly"}, set(commands))
        self.assertEqual(["git", "init", directory], shlex.split(commands["gitInitDisplayOnly"]))
        self.assertEqual(["python3", "/opt/kit root/scripts/tenant_pi.py", "validate", "--overlay",
                          directory + "/overlay.json", "--local-dir", directory],
                         shlex.split(commands["validateDisplayOnly"]))
        self.assertEqual("${EDITOR:-vi} " + shlex.quote(directory + "/overlay.json"), commands["editDisplayOnly"])


class CliTests(Fixture):
    def setUp(self):
        super().setUp()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("git", "pi", "npm", "node", "sh", "vi", "curl"):
            command = self.bin / name
            command.write_text("#!/bin/sh\nprintf CALLED > '" + str(self.base / "called") + "'\n")
            command.chmod(0o700)
        self.log = self.base / "events.log"
        # Loads before the CLI: blocks the network, and records each process start and each opened path.
        (self.base / "sitecustomize.py").write_text(
            "import sys\nsys.dont_write_bytecode = True\nimport os, socket\n"
            "def blocked(*args, **kwargs): raise AssertionError('external operation')\n"
            "socket.socket.connect = blocked\n"
            "_log = os.open(" + repr(str(self.log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
            "_START = ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty', 'pty.spawn')\n"
            "def _audit(event, args):\n"
            "    if event in _START or event == 'open':\n"
            "        os.write(_log, (event + ' ' + str(args[0] if args else '') + '\\n').encode('utf-8', 'replace'))\n"
            "sys.addaudithook(_audit)\n")
        self.env = {"HOME": str(self.home), "PATH": str(self.bin), "PYTHONPATH": str(self.base),
                    "PYTHONDONTWRITEBYTECODE": "1", "EDITOR": "CANARY_EDITOR"}

    def run_cli(self, directory, *extra, env=None):
        return subprocess.run([sys.executable, str(CLI), "init-private", "--dir", str(directory), *extra],
                              cwd=self.base, env=self.env if env is None else env,
                              text=True, capture_output=True, check=False)

    def refused(self, directory, error, *extra, env=None, created=False, place=None):
        result = self.run_cli(directory, *extra, env=env)
        self.assertEqual(2, result.returncode, result.stderr)
        self.assertEqual("", result.stdout)
        self.assertEqual({"candidate_created": created, "error": error, **(place or {})}, json.loads(result.stderr))
        self.assertNotIn(str(self.base), result.stderr)
        self.assertNotIn("CANARY", result.stderr)
        self.assertEqual("KEEP", self.sentinel.read_text())
        self.assertFalse((self.base / "called").exists())
        return result

    def test_creates_the_tree_and_prints_the_next_commands(self):
        kit_before = sorted(str(p) for p in (ROOT / "config").rglob("*"))
        result = self.run_cli(self.dir)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual("", result.stderr)
        self.check_tree()
        data = json.loads(result.stdout)
        self.assertEqual(json.dumps(data, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n", result.stdout)
        self.assertEqual(report(private_init.InitResult(str(self.dir), True), str(ROOT)), data)
        self.assertEqual(sorted(str(p) for p in [self.dir, *self.dir.rglob("*")]),
                         sorted(item["path"] for item in data["created"]))
        for item in data["created"]:
            self.assertEqual(int(item["mode"], 8), stat.S_IMODE(os.lstat(item["path"]).st_mode))
        # No Git command and no other process; the live profile files stay unopened and unchanged.
        events = self.log.read_text().splitlines()
        self.assertEqual([], [line for line in events if not line.startswith("open ")])
        self.assertFalse((self.base / "called").exists())
        self.assertFalse((self.dir / ".git").exists())
        for name in ("auth.json", "models.json", "settings.json", "sessions"):
            self.assertEqual([], [line for line in events if line.endswith("/" + name)])
        self.assertEqual({"auth.json", "models.json", "settings.json"}, {p.name for p in self.agent.iterdir()})
        for text in (result.stdout, *((self.dir / name).read_text() for name in NAMES)):
            self.assertNotIn("CANARY", text)
        self.assertEqual(kit_before, sorted(str(p) for p in (ROOT / "config").rglob("*")))
        # Without `--target` the report has no target key, and the copy still has the sample target:
        # the printed validate line says so.
        self.assertEqual(["commands", "complete", "created", "directory", "warnings"], sorted(data))
        check = subprocess.run([sys.executable, *shlex.split(data["commands"]["validateDisplayOnly"])[1:]],
                               cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual((2, ""), (check.returncode, check.stdout))
        self.assertEqual({"candidate_created": False, "error": "sample_target: overlay.target.agentDir"}, json.loads(check.stderr))
        self.refused(self.dir, "target_exists: init-private.dir")
        self.check_tree()

    def test_target_option_gives_a_core_only_profile_without_an_edit(self):
        target = self.parent / "profiles" / "it's main"
        target.parent.mkdir(mode=0o700)
        result = self.run_cli(self.dir, "--target", str(target))
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        data = json.loads(result.stdout)
        self.assertEqual(json.dumps(data, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n", result.stdout)
        self.assertEqual(report(private_init.InitResult(str(self.dir), True), str(ROOT), str(target)), data)
        self.assertEqual(str(target), data["targetAgentDir"])
        # Only `target.agentDir` differs from the example; every other file is its template.
        template = json.loads((ROOT / TEMPLATES["overlay.json"]).read_bytes())
        self.check_tree(overlay=with_target(template, str(target)))
        self.assertEqual({**template, "target": {"agentDir": str(target)}}, json.loads((self.dir / "overlay.json").read_text()))
        self.assertFalse(os.path.lexists(target))
        # No editor: the printed validate line, then plan and generate, work on the file as it is.
        validate = shlex.split(data["commands"]["validateDisplayOnly"])[1:]
        check = subprocess.run([sys.executable, *validate], cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (check.returncode, check.stderr))
        self.assertTrue(json.loads(check.stdout)["valid"])
        options = validate[2:]
        plan = subprocess.run([sys.executable, validate[0], "plan", *options], cwd=self.base, env=self.env,
                              text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (plan.returncode, plan.stderr))
        self.assertEqual(str(target), json.loads(plan.stdout)["targetAgentDir"])
        self.assertFalse(os.path.lexists(target))
        generated = subprocess.run([sys.executable, validate[0], "generate", *options, "--target", str(target)],
                                   cwd=self.base, env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (generated.returncode, generated.stderr))
        output = json.loads(generated.stdout)
        self.assertEqual((True, True, str(target)), (output["complete"], output["filesComplete"], output["targetAgentDir"]))
        choices = json.loads((target / ".tenant-pi/choices.json").read_text())
        self.assertEqual((str(target), ["core"]), (choices["overlay"]["target"]["agentDir"], choices["overlay"]["selection"]["enable"]))
        self.assertTrue((target / "settings.json").is_file())
        # The four runs start no process, and the live profile files stay unopened and unchanged.
        events = self.log.read_text().splitlines()
        self.assertEqual([], [line for line in events if not line.startswith("open ")])
        self.assertEqual([], [line for line in events if str(self.agent) in line])
        for name in ("auth.json", "models.json", "sessions"):
            self.assertEqual([], [line for line in events if line.endswith(("/" + name, " " + name))])
        self.assertEqual({"auth.json", "models.json", "settings.json"}, {p.name for p in self.agent.iterdir()})
        self.assertFalse((self.base / "called").exists())
        self.assertEqual("KEEP", self.sentinel.read_text())

    def test_target_refusals_create_nothing(self):
        (self.base / "to agent").symlink_to(self.agent, target_is_directory=True)
        (self.base / "to kit").symlink_to(ROOT, target_is_directory=True)
        (self.base / "to parent").symlink_to(self.parent, target_is_directory=True)
        for target, error in (
                ("relative/profile", "absolute_path: init-private.target"),
                ("~/.pi/profiles/main", "absolute_path: init-private.target"),
                ("$HOME/.pi/profiles/main", "shell_or_template: init-private.target"),
                ("/" + "a" * MAX_PATH, "path_too_long: init-private.target"),
                (SAMPLE_TARGET, "sample_target: init-private.target"),
                # The live agent directory, as written and through a link.
                (self.agent, "under_pi_agent: init-private.target"),
                (self.agent / "profiles" / "main", "under_pi_agent: init-private.target"),
                (self.base / "to agent" / "main", "under_pi_agent: init-private.target"),
                (ROOT / ".local" / "tenant-pi-test-target-absent", "under_kit: init-private.target"),
                (self.base / "to kit" / "docs" / "tenant-pi-test-target-absent", "under_kit: init-private.target"),
                # The private directory and the target must stay outside of each other.
                (self.dir / "profile", "under_private_dir: init-private.target"),
                (self.base / "to parent" / self.dir.name / "profile", "under_private_dir: init-private.target"),
                (self.dir, "under_overlay_target: init-private.dir"),
                (self.parent, "under_overlay_target: init-private.dir")):
            with self.subTest(target=str(target)[-40:], error=error):
                self.refused(self.dir, error, "--target", str(target))
                self.assertFalse(os.path.lexists(self.dir))
        self.assertFalse(os.path.lexists(ROOT / ".local" / "tenant-pi-test-target-absent"))
        self.assertEqual({"auth.json", "models.json", "settings.json"}, {p.name for p in self.agent.iterdir()})
        # A bad directory is reported before a bad location of the target.
        self.refused(self.agent / "private", "under_pi_agent: init-private.dir", "--target", str(self.agent / "main"))
        # The target itself is never created or read: an existing target and an absent parent pass here.
        (self.parent / "exists").mkdir()
        self.assertEqual(0, self.run_cli(self.dir, "--target", str(self.parent / "exists")).returncode)
        self.assertEqual(0, self.run_cli(self.parent / "second", "--target", str(self.base / "absent" / "main")).returncode)
        self.assertEqual([], list((self.parent / "exists").iterdir()))
        self.assertFalse((self.base / "absent").exists())

    def test_refusals(self):
        (self.parent / "exists").mkdir()
        kit = ROOT / ".local" / "tenant-pi-test-private-absent"
        for directory, error in (
                ("relative", "absolute_path: init-private.dir"),
                (self.parent / "exists", "target_exists: init-private.dir"),
                (self.base / "absent" / "private", "parent_missing: init-private.dir.parent"),
                (kit, "under_kit: init-private.dir"),
                (ROOT / "config" / "private" / "new", "under_kit: init-private.dir"),
                (self.agent, "under_pi_agent: init-private.dir"),
                (self.agent / "private", "under_pi_agent: init-private.dir"),
                ("/home/EXAMPLE_USER/new-agent", "under_overlay_target: init-private.dir"),
                ("/home/EXAMPLE_USER/new-agent/private", "under_overlay_target: init-private.dir")):
            with self.subTest(directory=str(directory)):
                self.refused(directory, error)
        self.assertFalse(os.path.lexists(kit))
        self.assertFalse((self.base / "absent").exists())
        self.assertEqual([], list((self.parent / "exists").iterdir()))
        self.assertEqual({"auth.json", "models.json", "settings.json"}, {p.name for p in self.agent.iterdir()})

    def test_linked_pi_agent_and_linked_ancestor(self):
        real = self.base / "real agent"
        real.mkdir(mode=0o700)
        home = self.base / "home2"
        (home / ".pi").mkdir(parents=True)
        (home / ".pi/agent").symlink_to(real, target_is_directory=True)
        env = dict(self.env, HOME=str(home))
        self.refused(real / "private", "under_pi_agent: init-private.dir", env=env)
        self.refused(home / ".pi/agent" / "private", "under_pi_agent: init-private.dir", env=env)
        self.assertEqual([], list(real.iterdir()))
        # A link that reaches a forbidden place from another name fails at the ancestor walk.
        (self.base / "to agent").symlink_to(self.agent, target_is_directory=True)
        self.refused(self.base / "to agent" / "private", "unsafe_path: init-private.dir.parents")

    def test_named_overlay_targets(self):
        overlay = self.base / "overlay.json"
        target = self.parent / "profile"
        overlay.write_text(json.dumps({"target": {"agentDir": str(target)}, "CANARY_KEY": "CANARY_VALUE"}))
        for directory in (target, target / "private"):
            self.refused(directory, "under_overlay_target: init-private.dir", "--overlay", str(overlay))
        self.assertFalse(os.path.lexists(target))
        for text, error in (('{"target": {}}', "text: init-private.overlay"), ("[]", "text: init-private.overlay"),
                            ('{"target": {"agentDir": "relative"}}', "absolute_path: init-private.overlay")):
            overlay.write_text(text)
            self.refused(self.dir, error, "--overlay", str(overlay))
        # A syntax error gives its place and no file content.
        overlay.write_text('{\n  "CANARY_KEY": 1\n  "target": {}}')
        self.refused(self.dir, "invalid_json: init-private.overlay", "--overlay", str(overlay), place={"line": 3, "column": 3})
        overlay.write_bytes(b'{"target": "\xff"}')
        self.refused(self.dir, "input_encoding: init-private.overlay", "--overlay", str(overlay))
        self.refused(self.dir, "input_missing: init-private.overlay", "--overlay", str(self.base / "missing.json"))
        link = self.base / "link.json"
        link.symlink_to(overlay)
        self.refused(self.dir, "input_not_regular: init-private.overlay", "--overlay", str(link))
        self.assertFalse(os.path.lexists(self.dir))
        overlay.write_text(json.dumps({"target": {"agentDir": str(target)}}))
        self.assertEqual(0, self.run_cli(self.dir, "--overlay", str(overlay)).returncode)
        self.check_tree()

    def test_home(self):
        env = {name: value for name, value in self.env.items() if name != "HOME"}
        self.refused(self.dir, "home_required: init-private.home", env=env)
        self.refused(self.dir, "absolute_path: init-private.home", env=dict(env, HOME="relative"))
        self.refused(self.dir, "absolute_path: init-private.home", env=dict(env, HOME=str(self.home) + "/"))
        self.assertFalse(os.path.lexists(self.dir))

    def test_overlay_loader_rules(self):
        overlay = self.base / "overlay.json"
        target = json.dumps(str(self.parent / "profile"))
        (self.base / "sub").mkdir()
        for text, path, error in (
                ('{"target": {"agentDir": ' + target + '}}', str(self.base) + "/sub/../overlay.json",
                 "input_path: init-private.overlay"),
                ('{"target": {"agentDir": ' + target + '}}', str(self.base) + "/./overlay.json",
                 "input_path: init-private.overlay"),
                ('{"target": {"agentDir": ' + target + '}, "CANARY_N": NaN}', str(overlay),
                 "number: init-private.overlay"),
                ('{"target": {"agentDir": ' + target + '}, "CANARY_N": Infinity}', str(overlay),
                 "number: init-private.overlay"),
                ('{"target": {"agentDir": ' + target + '}, "target": {"agentDir": "/CANARY"}}', str(overlay),
                 "duplicate_key: JSON object")):
            with self.subTest(error=error, text=text[-30:]):
                overlay.write_text(text)
                self.refused(self.dir, error, "--overlay", path)
        self.assertFalse(os.path.lexists(self.dir))


    def test_help_names_the_action(self):
        result = subprocess.run([sys.executable, str(CLI), "--help"], cwd=self.base, env=self.env,
                                text=True, capture_output=True, check=False)
        self.assertIn("init-private", result.stdout)


class TemplateTests(Fixture):
    """A damaged kit template: the CLI in this process, with the kit root moved to a disposable copy."""

    def setUp(self):
        super().setUp()
        self.kit = self.base / "kit"
        (self.kit / "config/private").mkdir(parents=True)
        for source in TEMPLATES.values():
            (self.kit / source).write_bytes((ROOT / source).read_bytes())

    def run_main(self):
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO
        from scripts import tenant_pi
        out, err = StringIO(), StringIO()
        with patch.object(tenant_pi, "ROOT", self.kit), patch.dict(os.environ, {"HOME": str(self.home)}), \
             redirect_stdout(out), redirect_stderr(err):
            code = tenant_pi.main(["init-private", "--dir", str(self.dir)])
        return code, out.getvalue(), err.getvalue()

    def test_copy_of_the_kit_templates_works(self):
        code, out, err = self.run_main()
        self.assertEqual((0, ""), (code, err))
        self.check_tree()
        self.assertIn(shlex.quote(str(self.kit / "scripts/tenant_pi.py")), json.loads(out)["commands"]["validateDisplayOnly"])

    def test_bad_template_is_refused_before_any_write(self):
        def missing(path):
            path.unlink()

        def linked(path):
            path.unlink()
            path.symlink_to(self.sentinel)

        def fifo(path):
            path.unlink()
            os.mkfifo(path)

        def large(path):
            path.write_bytes(b" " * (1024 * 1024 + 1))

        def broken(path):
            path.write_text('{"CANARY_BROKEN": ')

        def no_target(path):
            path.write_text('{"CANARY_KEY": 1}')

        for name, damage, rule, place in (
                ("install-log.md", missing, "input_missing", {}), ("accepted-drift.md", linked, "input_not_regular", {}),
                (".gitignore", fifo, "input_not_regular", {}), ("registry.json", large, "input_too_large", {}),
                ("overlay.json", broken, "invalid_json", {"line": 1, "column": 19}), ("overlay.json", no_target, "text", {})):
            with self.subTest(name=name, rule=rule):
                path = self.kit / TEMPLATES[name]
                before = (ROOT / TEMPLATES[name]).read_bytes()
                damage(path)
                code, out, err = self.run_main()
                self.assertEqual((2, ""), (code, out))
                self.assertEqual({"candidate_created": False, "error": f"{rule}: init-private.template.{name}", **place},
                                 json.loads(err))
                self.assertNotIn("CANARY", err)
                self.assertNotIn(str(self.base), err)
                self.assertFalse(os.path.lexists(self.dir))
                if os.path.lexists(path):
                    path.unlink()
                path.write_bytes(before)
        self.assertEqual("KEEP", self.sentinel.read_text())


if __name__ == "__main__":
    unittest.main()
