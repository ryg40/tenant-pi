"""Names-only inventory contract: package sources, entry kinds, determinism, and unopened private files."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import tenant_pi
from scripts.profile_inventory import MAX_SOURCE, RESOURCE_DIRS, coordination_files, inventory
from scripts.validate import Invalid

CANARY = "CANARY_SECRET"
EMPTY = {name: [] for name in RESOURCE_DIRS}
# The coordination block of a profile that declares neither the Herdr skill nor the question extension.
NO_COORDINATION = {"herdrCli": "not_checked", "herdrSession": "not_run", "herdrSkill": "not_declared",
                   "questionExtension": "not_declared", "questionUi": "unverified"}
QUESTIONS = "npm:@juicesharp/rpiv-ask-user-question@2.11.0"
EVENTS = []
RECORDING = []
PROCESS_EVENTS = ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.system", "os.fork")


def _audit(event, args):
    # An audit hook cannot be removed; it records only while a test asks for it.
    if RECORDING and event in ("open", "os.scandir", "os.listdir", *PROCESS_EVENTS):
        EVENTS.append((event, args[0]))


sys.addaudithook(_audit)


def dump(report):
    return json.dumps(report, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


class PureInventoryTests(unittest.TestCase):
    def test_packages_show_sources_and_filter_names_only(self):
        settings = {"defaultModel": CANARY, "npmCommand": ["/" + CANARY], "deviceId": CANARY,
                    "packages": ["npm:@scope/name@1.2.3", "/home/example/repo",
                                 {"source": "git:https://h.invalid/r.git@" + "a" * 40,
                                  "skills": [CANARY], "extensions": ["+" + CANARY], "themes": []},
                                 "git:git@h.invalid:owner/repo", "ssh://git@h.invalid/owner/repo.git"]}
        report = inventory("/home/example/profile", settings, EMPTY, False)
        self.assertEqual([{"source": "npm:@scope/name@1.2.3"}, {"source": "/home/example/repo"},
                          {"source": "git:https://h.invalid/r.git@" + "a" * 40, "filters": ["extensions", "skills", "themes"]},
                          {"source": "git:git@h.invalid:owner/repo"}, {"source": "ssh://git@h.invalid/owner/repo.git"}],
                         report["packages"])
        self.assertEqual(["coordination", "dir", "extensions", "managed", "packages", "prompts", "skills", "summary"],
                         sorted(report))
        # A local package with another skill filter does not declare the Herdr skill.
        self.assertEqual(NO_COORDINATION, report["coordination"])
        self.assertEqual({"packages": 5, "extensions": 0, "skills": 0, "prompts": 0}, report["summary"])
        self.assertNotIn(CANARY, dump(report))

    def test_coordination_results_are_separate_and_a_declared_part_is_not_a_working_part(self):
        package = {"source": "/home/example/kit/packages/tenantext", "extensions": [], "skills": ["skills/herdr"]}
        settings = {"packages": [package, {"source": QUESTIONS, "extensions": ["index.ts"]}]}
        files = coordination_files("/home/example/profile", settings)
        self.assertEqual({"herdrSkill": "/home/example/kit/packages/tenantext/skills/herdr/SKILL.md",
                          "questionExtension": "/home/example/profile/npm/node_modules/@juicesharp/"
                                               "rpiv-ask-user-question/package.json"}, files)
        for present, skill, extension in (((False, False), "not_readable", "declared"), ((True, False), "readable", "declared"),
                                          ((False, True), "not_readable", "installed"), ((True, True), "readable", "installed")):
            with self.subTest(present=present):
                report = inventory("/home/example/profile", settings, EMPTY, True,
                                   dict(zip(("herdrSkill", "questionExtension"), present)))
                # No file of a profile proves the command, a session or the question dialog.
                self.assertEqual({"herdrSkill": skill, "questionExtension": extension, "herdrCli": "not_checked",
                                  "herdrSession": "not_run", "questionUi": "unverified"}, report["coordination"])
        # Without the facts of the caller, nothing counts as found.
        self.assertEqual(("not_readable", "declared"),
                         tuple(inventory("/p", settings, EMPTY, True)["coordination"][key]
                               for key in ("herdrSkill", "questionExtension")))
        # Each part alone, an unversioned source, and sources that declare neither part.
        self.assertEqual({"herdrSkill": None, "questionExtension": "/p/npm/node_modules/@juicesharp/rpiv-ask-user-question/package.json"},
                         coordination_files("/p", {"packages": ["npm:@juicesharp/rpiv-ask-user-question"]}))
        for other in ({}, {"packages": CANARY}, {"packages": ["npm:rpiv-ask-user-question@2.11.0", "/home/example/herdr",
                                                              {"source": "/home/x", "skills": "skills/herdr"},
                                                              {"source": "npm:pkg@1.0.0", "skills": ["skills/herdr"]},
                                                              {"source": "/home/x", "extensions": ["skills/herdr"]},
                                                              {"source": "/home/x;" + CANARY, "skills": ["skills/herdr"]}]}):
            self.assertEqual({"herdrSkill": None, "questionExtension": None}, coordination_files("/p", other))
        for bad in ({"herdrSkill": True}, {"herdrSkill": 1, "questionExtension": False}, [],
                    # A found file of a part that the settings do not declare is a caller error.
                    {"herdrSkill": True, "questionExtension": False}):
            with self.assertRaises(Invalid) as caught:
                inventory("/p", {}, EMPTY, True, bad)
            self.assertEqual("coordination_facts: inventory.coordination", str(caught.exception))
        self.assertNotIn(CANARY, dump(inventory("/p", settings, EMPTY, True)))

    def test_credential_positions_and_odd_shapes_are_not_echoed(self):
        settings = {"packages": ["git:https://user:" + CANARY + "@h.invalid/r.git", "https://" + CANARY + "@h.invalid/r.git",
                                 {"source": "https://h.invalid/r.git?token=" + CANARY, "skills": []},
                                 "ssh://git:" + CANARY + "@h.invalid/r.git", "npm:x\n" + CANARY, "",
                                 {"source": [CANARY]}, {"path": CANARY}, [CANARY], 7, None]}
        report = inventory("/p", settings, EMPTY, True)
        self.assertEqual([{"status": "unsupported_value"}] * 2 + [{"status": "unsupported_value", "filters": ["skills"]}]
                         + [{"status": "unsupported_value"}] * 3 + [{"status": "unsupported_shape"}] * 5, report["packages"])
        self.assertEqual(11, report["summary"]["packages"])
        self.assertNotIn(CANARY, dump(report))

    def test_each_allowed_source_form_is_shown(self):
        commit = "a" * 40
        for source in ("/home/example/owner repo/it's", "/opt/x_y.z-1",
                       "npm:name", "npm:name@1.2.3", "npm:@scope/name", "npm:@scope/name@1.2.3-rc.1",
                       "git:h.invalid/owner/repo", "git:h.invalid:owner/repo", "git:git@h.invalid:owner/repo.git",
                       "git:git@h.invalid/owner/repo", "git:https://h.invalid/owner/repo.git@" + commit,
                       "git:h.invalid/owner/repo@" + commit, "https://h.invalid/owner/repo.git",
                       "https://h.invalid:8443/owner/repo", "ssh://git@h.invalid/owner/repo.git",
                       "ssh://git@h.invalid:2222/owner/repo", "git:ssh://git@h.invalid/owner/repo",
                       "git:" + "h.invalid/" + "a" * (MAX_SOURCE - 14)):
            with self.subTest(source=source[:40]):
                self.assertEqual([{"source": source}], inventory("/p", {"packages": [source]}, EMPTY, False)["packages"])

    def test_each_credential_bearing_or_unknown_source_form_is_hidden(self):
        commit = "a" * 40
        for source in ("git:ghp_" + CANARY + "@github.invalid:owner/repo", "git:user:" + CANARY + "@h.invalid/o/r",
                       "user:" + CANARY + "@h.invalid:o/r", "//user:" + CANARY + "@h.invalid/r",
                       "git:h.invalid/o/r?token=" + CANARY, "npm:pkg?token=" + CANARY, "https://h.invalid/r.git#" + CANARY,
                       "https://h.invalid/r.git;" + CANARY, "https://h.invalid:" + CANARY + "/r.git",
                       "https://h.invalid/r.git@" + CANARY, "git:h.invalid/o/r@" + commit + "@" + CANARY,
                       "https://git@" + CANARY + "@h.invalid/r", "ssh://" + CANARY + "@h.invalid/r", "git:Git@h.invalid:o/r",
                       "npm:name@latest", "npm:name@^1.0.0", "npm:" + CANARY + "@1.0.0", "npm:@scope/name@1.0.0@" + CANARY,
                       "git:h.invalid/o/ " + CANARY, "git:h.invalid/o/\t" + CANARY, "https://h.invalid/r\x7f" + CANARY,
                       "https://h.invalid/r\x85" + CANARY, "/home/example/r\x9f" + CANARY, "/home/../" + CANARY,
                       "/home/example/r?" + CANARY, "/home/example/r#" + CANARY, "/home/example/$" + CANARY,
                       "relative/" + CANARY, "./" + CANARY, "~/" + CANARY, "file:///" + CANARY, "http://h.invalid/" + CANARY,
                       CANARY, "git:", "npm:", "https://", "git:h.invalid/" + "a" * (MAX_SOURCE - 13)):
            with self.subTest(source=source[:40]):
                report = inventory("/p", {"packages": [source, {"source": source, CANARY.lower(): 1}]}, EMPTY, False)
                self.assertEqual([{"status": "unsupported_value"}, {"status": "unsupported_value", "filters": [CANARY.lower()]}],
                                 report["packages"])
                self.assertNotIn(CANARY, dump(report))

    def test_entries_are_sorted_and_the_report_is_deterministic(self):
        listings = {"extensions": [("b.ts", "file"), ("a", "dir"), ("z.ts", "symlink")],
                    "skills": [("one", "dir")], "prompts": [("p.md", "file"), ("fifo", "other")]}
        report = inventory("/p", {}, listings, True)
        self.assertEqual([{"name": "a", "kind": "dir"}, {"name": "b.ts", "kind": "file"}, {"name": "z.ts", "kind": "symlink"}],
                         report["extensions"])
        self.assertEqual({"dir": "/p", "managed": True, "packages": [], "extensions": report["extensions"],
                          "skills": [{"name": "one", "kind": "dir"}],
                          "prompts": [{"name": "fifo", "kind": "other"}, {"name": "p.md", "kind": "file"}],
                          "coordination": NO_COORDINATION, "summary": {"packages": 0, "extensions": 3, "skills": 1, "prompts": 2}}, report)
        shuffled = {name: list(reversed(items)) for name, items in listings.items()}
        self.assertEqual(dump(report), dump(inventory("/p", {}, shuffled, True)))

    def test_static_diagnostics(self):
        for args, rule in (((None, EMPTY, False), "settings_missing: inventory.dir"),
                           (([CANARY], EMPTY, False), "object: inventory.dir.settings.json"),
                           (({"packages": CANARY}, EMPTY, False), "array: inventory.dir.settings.json.packages"),
                           (({}, EMPTY, CANARY), "boolean: inventory.managed"),
                           (({}, {"extensions": []}, False), "resource_directories: inventory.listings"),
                           (({}, {**EMPTY, "skills": CANARY}, False), "array: inventory.dir.skills"),
                           (({}, {**EMPTY, "skills": [(CANARY, "link")]}, False), "entry: inventory.dir.skills"),
                           (({}, {**EMPTY, "prompts": [("a", "file"), ("a", "dir")]}, False), "duplicate_entry: inventory.dir.prompts")):
            with self.subTest(rule=rule):
                with self.assertRaises(Invalid) as caught:
                    inventory("/p", *args)
                self.assertEqual(rule, str(caught.exception))


class ProfileDirectoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="tenant-pi-inventory-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.profile = self.base / "live profile"
        self.profile.mkdir(mode=0o700)
        (self.profile / "settings.json").write_text(json.dumps({"packages": ["npm:a@1.0.0"], "theme": CANARY}))
        self.outside = self.base / "outside"
        self.outside.mkdir()
        (self.outside / "target.ts").write_text(CANARY)

    def read(self, directory=None):
        return tenant_pi._profile(str(self.profile if directory is None else directory), "inventory.dir")

    def rule(self, directory=None):
        with self.assertRaises(Invalid) as caught:
            self.read(directory)
        return str(caught.exception)

    def test_unmanaged_profile_with_only_settings(self):
        self.assertEqual({"dir": str(self.profile), "managed": False, "packages": [{"source": "npm:a@1.0.0"}],
                          "extensions": [], "skills": [], "prompts": [], "coordination": NO_COORDINATION,
                          "summary": {"packages": 1, "extensions": 0, "skills": 0, "prompts": 0}}, self.read())

    def test_kinds_symlinks_and_private_files_stay_unopened(self):
        for name in RESOURCE_DIRS:
            (self.profile / name).mkdir()
        (self.profile / "extensions" / "plain.ts").write_text(CANARY)
        (self.profile / "extensions" / "linked.ts").symlink_to(self.outside / "target.ts")
        (self.profile / "extensions" / "dangling").symlink_to(self.base / ("absent-" + CANARY))
        (self.profile / "skills" / "one").mkdir()
        (self.profile / "skills" / "one" / "SKILL.md").write_text(CANARY)
        (self.profile / "skills" / "linked-dir").symlink_to(self.outside, target_is_directory=True)
        os.mkfifo(self.profile / "prompts" / "pipe")
        (self.profile / "prompts" / "p.md").write_text(CANARY)
        for private in ("auth.json", "mcp.json", "models.json", "memory.db"):
            (self.profile / private).write_text(CANARY)
        (self.profile / "sessions").mkdir()
        (self.profile / "sessions" / "s.jsonl").write_text(CANARY)
        (self.profile / ".tenant-pi").mkdir()
        (self.profile / ".tenant-pi" / "state.json").write_text(CANARY)
        (self.profile / ".tenant-pi" / "choices.json").write_text(CANARY)
        (self.profile / "keybindings.json").write_text(CANARY)
        settings_fds = []
        real_open = os.open

        def recording_open(path, *args, **kwargs):
            fd = real_open(path, *args, **kwargs)
            if path == "settings.json":
                settings_fds.append(fd)
            return fd

        del EVENTS[:]
        RECORDING.append(True)
        try:
            with patch.object(os, "open", recording_open):
                report = self.read()
                again = self.read()
        finally:
            del RECORDING[:]
        self.assertEqual(dump(report), dump(again))
        self.assertTrue(report["managed"])
        self.assertEqual([{"name": "dangling", "kind": "symlink"}, {"name": "linked.ts", "kind": "symlink"},
                          {"name": "plain.ts", "kind": "file"}], report["extensions"])
        self.assertEqual([{"name": "linked-dir", "kind": "symlink"}, {"name": "one", "kind": "dir"}], report["skills"])
        self.assertEqual([{"name": "p.md", "kind": "file"}, {"name": "pipe", "kind": "other"}], report["prompts"])
        self.assertNotIn(CANARY, dump(report))
        self.assertNotIn("outside", dump(report))
        self.assertNotIn("target.ts", dump(report))
        # Every open of one run: the ancestors, the profile, the settings file, the three
        # resource directories and the marker directory. Every listing uses a descriptor.
        # The only open by number is the loader that wraps the descriptor of the settings file.
        self.assertEqual(2, len(settings_fds))
        self.assertEqual(set(), {arg for event, arg in EVENTS if event == "open" and type(arg) is int} - set(settings_fds))
        self.assertEqual([], [event for event, _ in EVENTS if event in PROCESS_EVENTS])
        opened = [arg for event, arg in EVENTS if event == "open" and type(arg) is str]
        allowed = {"/", *self.profile.parts[1:], "settings.json", ".tenant-pi", *RESOURCE_DIRS}
        self.assertEqual(set(), set(opened) - allowed, opened)
        self.assertEqual(2, opened.count("settings.json"))
        listed = [arg for event, arg in EVENTS if event in ("os.scandir", "os.listdir")]
        self.assertEqual(2 * len(RESOURCE_DIRS), len(listed))
        self.assertTrue(all(type(arg) is int for arg in listed), listed)

    def test_path_boundaries(self):
        self.assertEqual("absolute_path: inventory.dir", self.rule("relative/profile"))
        self.assertEqual("absolute_path: inventory.dir", self.rule(str(self.profile) + "/../" + self.profile.name))
        self.assertEqual("settings_missing: inventory.dir", self.rule(self.base / "absent"))
        (self.base / "empty").mkdir()
        self.assertEqual("settings_missing: inventory.dir", self.rule(self.base / "empty"))
        (self.base / "linked").symlink_to(self.profile, target_is_directory=True)
        self.assertEqual("input_path_unsafe: inventory.dir.settings.json", self.rule(self.base / "linked"))
        nested = self.base / "linked" / "nested"
        (self.profile / "nested").mkdir()
        (self.profile / "nested" / "settings.json").write_text("{}")
        self.assertEqual("input_path_unsafe: inventory.dir.settings.json", self.rule(nested))
        self.assertEqual([], self.read(self.profile / "nested")["packages"])

    def test_unsafe_resource_and_marker_shapes(self):
        (self.profile / "skills").symlink_to(self.outside, target_is_directory=True)
        self.assertEqual("read_or_json: inventory.dir.skills", self.rule())
        (self.profile / "skills").unlink()
        (self.profile / "skills").write_text(CANARY)
        self.assertEqual("read_or_json: inventory.dir.skills", self.rule())
        (self.profile / "skills").unlink()
        (self.profile / ".tenant-pi").symlink_to(self.outside, target_is_directory=True)
        self.assertEqual("read_or_json: inventory.dir.state.json", self.rule())
        (self.profile / ".tenant-pi").unlink()
        (self.profile / ".tenant-pi").mkdir()
        self.assertFalse(self.read()["managed"])
        (self.profile / ".tenant-pi" / "state.json").symlink_to(self.outside / "target.ts")
        self.assertEqual("input_not_regular: inventory.dir.state.json", self.rule())
        (self.profile / ".tenant-pi" / "state.json").unlink()
        (self.profile / ".tenant-pi" / "state.json").mkdir()
        self.assertEqual("input_not_regular: inventory.dir.state.json", self.rule())
        (self.profile / "settings.json").write_text('{"packages": "' + CANARY + '"')
        self.assertEqual("invalid_json: inventory.dir.settings.json", self.rule())
        (self.profile / "settings.json").unlink()
        (self.profile / "settings.json").symlink_to(self.outside / "target.ts")
        self.assertEqual("input_not_regular: inventory.dir.settings.json", self.rule())

    def test_entry_bound(self):
        (self.profile / "prompts").mkdir()
        for index in range(3):
            (self.profile / "prompts" / f"{index}.md").write_text("")
        bound = tenant_pi.MAX_ENTRIES
        tenant_pi.MAX_ENTRIES = 2
        try:
            self.assertEqual("input_too_large: inventory.dir.prompts", self.rule())
            # Exactly the bound passes.
            tenant_pi.MAX_ENTRIES = 3
            self.assertEqual(3, self.read()["summary"]["prompts"])
        finally:
            tenant_pi.MAX_ENTRIES = bound
        self.assertEqual(3, self.read()["summary"]["prompts"])


if __name__ == "__main__":
    unittest.main()
