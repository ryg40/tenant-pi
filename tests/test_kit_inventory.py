"""The resource catalog matches the manifest and the architecture model; the inventory reads a profile and writes nothing."""
import ast
import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

from scripts import kit_inventory

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/kit_inventory.py"
MANIFEST = json.loads((ROOT / "config/manifest.json").read_text())
CATALOG = json.loads((ROOT / "config/catalog.json").read_text())
FIELDS = {"name", "group", "title", "description", "when_on", "when_off", "default", "needs", "docs"}
NEEDS = {"linux", "macos", "consent", "credentials", "node24", "root"}
# The catalog items that are not manifest components, from the specification of the catalog.
EXTRAS = {"mcp-codemode", "claude-code-plugin", "claude-aws-plugins", "dummies", "shell-rc", "launcher"}
ITEM_KEYS = {"name", "group", "installed", "active", "version_installed", "version_pinned", "state_source", "plan"}
RUNTIME_KEYS = {"installed", "required", "status"}


def pin(cid):
    return MANIFEST["components"][cid]["source"]["spec"].rsplit("@", 1)


def tree(base):
    """Mode, link target or bytes of each path below base."""
    return {str(path): (stat.S_IMODE(path.lstat().st_mode),
                        os.readlink(path) if path.is_symlink() else path.read_bytes() if path.is_file() else None)
            for path in Path(base).rglob("*")}


class CatalogTests(unittest.TestCase):
    def test_catalog_is_one_to_one_with_the_manifest_and_the_model_catalog(self):
        names = [item["name"] for item in CATALOG["items"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(MANIFEST["components"]) | EXTRAS, set(names))
        self.assertFalse(EXTRAS & set(MANIFEST["components"]))
        self.assertEqual(EXTRAS, set(kit_inventory.EXTRA_ITEMS))
        model = json.loads((ROOT / "docs/architecture/model.json").read_text())
        view = next(view for view in model["views"] if view["id"] == "components")
        groups = {group["id"] for group in CATALOG["groups"]}
        self.assertLessEqual({group["id"].removeprefix("g-c-") for group in view["groups"]}, groups)
        nodes = {node["component"]: node["group"].removeprefix("g-c-") for node in view["nodes"]}
        self.assertEqual(set(MANIFEST["components"]), set(nodes))
        for item in CATALOG["items"]:
            with self.subTest(item=item["name"]):
                self.assertEqual(FIELDS, set(item))
                self.assertIn(item["group"], groups)
                if item["name"] in nodes:
                    self.assertEqual(nodes[item["name"]], item["group"])
                self.assertIn(item["default"], ("on", "off", "ask"))
                self.assertLessEqual(set(item["needs"]), NEEDS)
                self.assertTrue((ROOT / item["docs"].split("#")[0]).is_file())
                for key in ("title", "description", "when_on", "when_off"):
                    self.assertTrue(item[key].strip())


class InventoryTests(unittest.TestCase):
    """One throwaway home. Each counterexample of a review has a profile of its own and a named subcase."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="inventory-test-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.home = self.base / "home"
        self.bin = self.base / "bin"
        self.bin.mkdir(parents=True)
        runtime = MANIFEST["runtime"]
        for name, output in (("pi", runtime["piVersion"]),
                             ("pi-bolt", f"{runtime['piVersion']} (Pi-Bolt {runtime['piBoltVersion']}, linux-x64, JIT off)")):
            (self.bin / name).write_text(f"#!/bin/sh\necho '{output}'\n")
            (self.bin / name).chmod(0o700)
        self.env = {"HOME": str(self.home), "PATH": str(self.bin), "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONIOENCODING": "utf-8"}

    def profile(self, name, settings):
        path = self.home / ".pi/profiles" / name
        path.mkdir(parents=True)
        (path / "settings.json").write_text(json.dumps(settings))
        return path

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data))

    def npm(self, profile, cid, present=True):
        """The package folder of a module at its pin; its package.json declares the extension, as the real one does."""
        name, version = pin(cid)
        folder = profile / "npm/node_modules" / name
        files = MANIFEST["components"][cid]["resources"]["extensions"]
        for file in files if present else []:
            self.write(folder / file, "")
        self.write(folder / "package.json", {"name": name, "version": version,
                                             "pi": {"extensions": ["./" + file for file in files]}})
        return name

    def inventory(self, profile, *args, **env):
        done = subprocess.run([sys.executable, str(SCRIPT), "--kit", str(ROOT), "--profile", str(profile), *args],
                              env={**self.env, **env}, text=True, capture_output=True, timeout=60)
        self.assertEqual(0, done.returncode, done.stderr)
        return done.stdout

    def states(self, profile, *args, **env):
        items = json.loads(self.inventory(profile, "--json", *args, **env))["items"]
        return {item["name"]: (item["installed"], item["active"], item["plan"]) for item in items}

    def assertStates(self, expected, found):
        self.assertEqual(expected, {name: found[name] for name in expected})

    def test_inventory_reads_installed_active_and_partial_state_and_writes_nothing(self):
        tenantext = ROOT / "packages/tenantext"
        base_extension = tenantext / "extensions/tenantext/index.ts"
        # demo: the launcher, the alias block, links, DUMMIES, npm entries and the Pi-Bolt list.
        demo = self.profile("demo", {
            "packages": ["npm:" + "@".join(pin("wiki")), f"npm:{pin('mcp')[0]}@5.3.0",
                         "npm:" + "@".join(pin("hermes")), "/missing/kit/packages/artifacts"],
            # The codemode tool of defaultTools without the MCP client of Pi.
            "extensions": ["-builtin:mcp"], "defaultTools": ["+codemode"],
            # Pi-Bolt only: no wiki.
            "piBolt": {"packages": ["-npm:" + pin("wiki")[0]]}})
        self.npm(demo, "wiki")
        # The registered spec is old and the files are new.
        self.npm(demo, "mcp")
        self.write(demo / "AGENTS.md", f"{kit_inventory.DUMMIES_BEGIN}\nx\n{kit_inventory.DUMMIES_END}\n")
        self.write(self.home / ".config/dummies-skill/state.json", {"pi": "off"})
        local_bin = self.home / ".local/bin"
        local_bin.mkdir(parents=True)
        (local_bin / "okknow").symlink_to(ROOT / "packages/okknow/skills/okknow/scripts/okknow")
        # The Walkr commands and the shared skills, but not the Claude Code and Codex skills of the setup.
        for command, file in kit_inventory.WALKR_LINKS:
            (local_bin / command).symlink_to(ROOT / "packages/walkr/src" / file)
            self.write(self.home / ".agents/skills" / command / "SKILL.md", "placeholder\n")
        # A launcher that binds another profile and is not executable, and an alias block for an old launcher.
        self.write(local_bin / "demo", "#!/bin/sh\n# tenant-pi launcher: demo\n# tenant-pi runtime: pi\n"
                                       f"export PI_CODING_AGENT_DIR=/other/profile\nexec {self.bin / 'pi'} \"$@\"\n")
        (local_bin / "demo").chmod(0o600)
        self.write(self.home / ".bashrc", "# >>> tenant-pi demo >>>\nalias demo=/old/launcher\n# <<< tenant-pi demo <<<\n")
        # Own switches: off in the settings files of the items, by the environment, or by the filter list.
        switches = self.profile("switches", {"packages": [{
            "source": str(tenantext), "skills": ["!skills/herdr-relay"], "prompts": [],
            "extensions": ["extensions/tenantext/index.ts", "extensions/anthropic-usage/index.ts",
                           "extensions/copilot-usage/index.ts", "extensions/ops-footer/index.ts"]}]})
        self.write(switches / "anthropic-usage/settings.json", {"mode": "off"})
        self.write(switches / "ops-footer/settings.json", {"enabled": False})
        # A package folder with only package.json.
        npm_only = self.profile("npm-only", {"packages": ["npm:" + "@".join(pin("questions"))]})
        self.npm(npm_only, "questions", present=False)
        # A directory entry: Pi finds no extension in it.
        directory = self.profile("directory", {"packages": [str(ROOT / "packages/openviking-pi")]})
        # A package entry whose path does not exist, an explicit Tenantext extension, and an explicit footer whose
        # own switch is off: the run adds the package entry and leaves the switch off.
        explicit = self.profile("explicit", {"packages": ["/missing/kit/packages/tenantext"], "extensions": [
            str(base_extension), str(tenantext / "extensions/ops-footer/index.ts")]})
        self.write(explicit / "ops-footer/settings.json", {"enabled": False})
        # Codemode: `-codemode` after `+codemode` removes it; the other order keeps it; a native server turns it on.
        tools_off = self.profile("tools-off", {"defaultTools": ["+codemode", "-codemode"]})
        tools_on = self.profile("tools-on", {"defaultTools": ["-codemode", "+codemode"]})
        native = self.profile("native", {"defaultTools": ["-codemode"]})
        self.write(native / "mcp.json", {"mcpServers": {"demo": {"command": "demo-server"}}})
        # A disabled conventional link to the base extension hides the enabled package file that it names.
        alias_off = self.profile("alias-off", {"packages": [str(tenantext)], "extensions": ["!extensions/*"]})
        alias_on = self.profile("alias-on", {"packages": [str(tenantext)]})
        for one in (alias_off, alias_on):
            (one / "extensions").mkdir()
            (one / "extensions/base.ts").symlink_to(base_extension)
        # The two manual memory modules as file entries, with their switches in the environment and in files.
        memory = self.profile("memory", {"packages": [str(ROOT / "packages/openviking-pi/index.ts"),
                                                      str(ROOT / "packages/agentcore-pi/index.ts")]})
        # A config that validateConfig of the AgentCore core accepts, and three that it rejects.
        agentcore_config = self.base / "config/agentcore.json"
        self.write(agentcore_config, {"schemaVersion": 1, "memoryId": "demoMemory", "region": "us-east-1",
                                      "actorId": "demo-actor", "projects": [{"projectId": "demo", "role": "member"}]})
        agentcore_empty, agentcore_malformed = self.base / "config/empty.json", self.base / "config/malformed.json"
        self.write(agentcore_empty, {})
        self.write(agentcore_malformed, "{")
        openviking_off = self.base / "config/ovcli.conf"
        self.write(openviking_off, {"plugin": {"pi": {"enabled": False}}})
        # String(["false"]) of JavaScript is "false": the OpenViking reader turns the extension off.
        openviking_array = self.base / "config/ovcli-array.conf"
        self.write(openviking_array, {"plugin": {"enabled": ["false"]}})
        # 600 nested one-item arrays: String() is still "false", and the reader must not recurse.
        openviking_deep = self.base / "config/ovcli-deep.conf"
        self.write(openviking_deep, '{"plugin": {"enabled": ' + "[" * 600 + '"false"' + "]" * 600 + "}}")
        # A delta entry that names only the base extension: the other files are complete and not loaded.
        delta = self.profile("delta", {"packages": [{"source": str(tenantext), "autoload": False,
                                                     "extensions": ["extensions/tenantext/index.ts"]}]})
        # A complete npm package at its pin with a delta entry that names nothing: Pi loads no file of it.
        npm_delta = self.profile("npm-delta", {"packages": [{"source": "npm:" + "@".join(pin("wiki")), "autoload": False}]})
        self.npm(npm_delta, "wiki")
        before = tree(self.base)

        with self.subTest("schema"):
            data = json.loads(self.inventory(demo, "--json"))
            self.assertEqual({"profile", "runtime", "items"}, set(data))
            self.assertEqual({"pi", "pi_bolt", "node", "python"}, set(data["runtime"]))
            for value in data["runtime"].values():
                self.assertEqual(RUNTIME_KEYS, set(value))
            names = [item["name"] for item in data["items"]]
            self.assertEqual(len(names), len(set(names)))
            self.assertEqual({item["name"] for item in CATALOG["items"]}, set(names))
            for item in data["items"]:
                self.assertEqual(ITEM_KEYS, set(item))
        with self.subTest("own switch off"):
            self.assertStates({
                "tenantext": (True, True, "keep"), "herdr": (True, True, "keep"),
                # Not in the plain extension list of the entry, or off in its own settings or by the environment.
                "context-meter": (True, False, "skip"), "anthropic-usage": (True, False, "skip"),
                "copilot-usage": (True, False, "skip"), "ops-footer": (True, False, "skip"),
                "herdr-relay": (True, False, "skip")}, self.states(switches, TENANTEXT_COPILOT_USAGE="off"))
            self.assertEqual((True, True, "keep"), self.states(switches)["copilot-usage"])
        with self.subTest("package.json only"):
            self.assertEqual(("partial", False, "upgrade"), self.states(npm_only)["questions"])
        with self.subTest("stale npm spec and missing package folder"):
            found = self.states(demo)
            self.assertStates({"mcp": (True, True, "upgrade"), "hermes": ("partial", False, "upgrade"),
                               "wiki": (True, True, "keep")}, found)
            mcp = next(item for item in json.loads(self.inventory(demo))["items"] if item["name"] == "mcp")
            self.assertEqual((pin("mcp")[1], pin("mcp")[1]), (mcp["version_installed"], mcp["version_pinned"]))
        with self.subTest("OpenViking dir source"):
            self.assertEqual(("partial", False, "skip"), self.states(directory)["openviking"])
        with self.subTest("explicit top-level extension"):
            self.assertStates({"tenantext": (True, True, "upgrade"), "context-meter": (False, None, "install"),
                               # A repair of an item that is off: upgrade, and active stays false.
                               "ops-footer": (True, False, "upgrade")}, self.states(explicit))
        with self.subTest("Pi-Bolt overlay"):
            # Pi-Bolt reads piBolt.packages; its install of the module takes the removal out.
            self.assertEqual((True, False, "upgrade"), self.states(demo, "--runtime", str(self.bin / "pi-bolt"))["wiki"])
        with self.subTest("codemode ordered modifiers"):
            self.assertEqual((False, None, "skip"), self.states(tools_off)["mcp-codemode"])
            # The step of install.sh keeps a list that names +codemode, so the run leaves the item absent.
            self.assertEqual((False, None, "skip"), self.states(tools_off, "--with", "mcp-codemode")["mcp-codemode"])
            self.assertEqual((True, True, "keep"), self.states(tools_on)["mcp-codemode"])
            self.assertEqual((True, True, "upgrade"), self.states(native)["mcp-codemode"])
            self.assertEqual((True, False, "skip"), self.states(demo)["mcp-codemode"])
        with self.subTest("disabled symlink precedence"):
            self.assertEqual((True, False, "skip"), self.states(alias_off)["tenantext"])
            self.assertEqual((True, True, "keep"), self.states(alias_on)["tenantext"])
        with self.subTest("memory env switches"):
            # installed depends on node_modules of the clone; active and plan do not.
            pick = lambda found: {name: found[name][1:] for name in ("openviking", "agentcore")}  # noqa: E731
            on = {"openviking": (True, "keep"), "agentcore": (True, "keep")}
            self.assertEqual(on, pick(self.states(memory, AGENTCORE_MEMORY_CONFIG_FILE=str(agentcore_config))))
            # No AgentCore config: the extension registers nothing.
            self.assertEqual((False, "skip"), pick(self.states(memory))["agentcore"])
            self.assertEqual({"openviking": (False, "skip"), "agentcore": (False, "skip")}, pick(self.states(
                memory, OPENVIKING_MEMORY_ENABLED="false", AGENTCORE_MEMORY_DISABLE="1",
                AGENTCORE_MEMORY_CONFIG_FILE=str(agentcore_config))))
            self.assertEqual((False, "skip"), pick(self.states(memory, OPENVIKING_CLI_CONFIG_FILE=str(openviking_off)))[
                "openviking"])
            self.assertEqual((True, "keep"), pick(self.states(memory, OPENVIKING_CLI_CONFIG_FILE=str(openviking_off),
                                                              OPENVIKING_MEMORY_ENABLED="true"))["openviking"])
        with self.subTest("AgentCore config that the core rejects"):
            # An empty object, malformed JSON, and an inline config that hides a valid file: nothing registers.
            for env in ({"AGENTCORE_MEMORY_CONFIG_FILE": str(agentcore_empty)},
                        {"AGENTCORE_MEMORY_CONFIG_FILE": str(agentcore_malformed)},
                        {"AGENTCORE_MEMORY_CONFIG": "{", "AGENTCORE_MEMORY_CONFIG_FILE": str(agentcore_config)}):
                self.assertEqual((False, "skip"), pick(self.states(memory, **env))["agentcore"], sorted(env))
        with self.subTest("OpenViking array switch"):
            for conf in (openviking_array, openviking_deep):
                self.assertEqual((False, "skip"), pick(self.states(memory, OPENVIKING_CLI_CONFIG_FILE=str(conf)))[
                    "openviking"], conf.name)
        with self.subTest("autoload false"):
            self.assertStates({"tenantext": (True, True, "keep"), "context-meter": (True, False, "skip")},
                              self.states(delta))
            self.assertEqual((True, False, "skip"), self.states(npm_delta)["wiki"])
        with self.subTest("links, launcher, shell and DUMMIES"):
            self.assertStates({
                "core": (True, True, "keep"),
                # A package entry whose path does not exist, and a command link without the package entry.
                "artifacts-prompt": (False, None, "skip"), "okknow": ("partial", None, "upgrade"),
                "dummies": (True, False, "skip"), "walkr": ("partial", True, "upgrade"),
                "walkr-prompts": (False, None, "install"), "shell-rc": (True, None, "keep"),
                "launcher": (True, False, "skip")}, self.states(demo))
        with self.subTest("plan of a selection"):
            chosen = self.states(demo, "--with", "mcp-codemode", "--shell", "bash", "--dummies")
            self.assertEqual({"mcp": "remove", "mcp-codemode": "upgrade", "hermes": "skip", "wiki": "keep",
                              "dummies": "upgrade", "launcher": "upgrade", "shell-rc": "upgrade"},
                             {name: chosen[name][2] for name in ("mcp", "mcp-codemode", "hermes", "wiki", "dummies",
                                                                 "launcher", "shell-rc")})
        with self.subTest("plain table"):
            self.assertNotIn("\x1b[", self.inventory(demo, "--plain"))
        self.assertEqual(before, tree(self.base))

    def test_a_kit_step_turns_an_item_on_and_a_command_link_of_another_clone_stays(self):
        # A plain filter list that predates the kit step of herdr-idle-cleanup: no handoffs extension, no skills.
        old = {"source": str(ROOT / "packages/tenantext"), "extensions": ["extensions/tenantext/index.ts"],
               "skills": [], "prompts": []}
        fresh = self.profile("fresh", {"packages": [old, str(ROOT / "packages/okknow")]})
        stepped = self.profile("stepped", {"packages": [old]})
        self.write(stepped / "kit-steps.json", {"version": 1, "added": ["herdr-idle-cleanup"]})
        with self.subTest("kit step"):
            # The step adds the extension to the plain list, so the run turns it on; [] stays, so the skill stays off.
            self.assertStates({"handoffs": (True, False, "install"), "herdr-idle-cleanup": (True, False, "skip")},
                              self.states(fresh))
            # After the step, a removal by the user stays.
            self.assertEqual((True, False, "skip"), self.states(stepped)["handoffs"])
        with self.subTest("command link of another clone"):
            other = self.base / "other/okknow"
            self.write(other, "#!/bin/sh\n")
            (self.home / ".local/bin").mkdir(parents=True)
            (self.home / ".local/bin/okknow").symlink_to(other)
            # install.sh keeps the link, so a run with the package entry of this kit changes nothing.
            self.assertEqual((True, True, "keep"), self.states(fresh)["okknow"])

    def test_a_kit_step_plans_no_install_when_the_profile_keeps_the_item_off_after_it(self):
        # Three profiles where the step adds handoffs and Pi still leaves it off: a negative glob, a disabled link
        # and a Pi-Bolt package list.
        old = {"source": str(ROOT / "packages/tenantext"), "extensions": ["extensions/tenantext/index.ts"],
               "skills": [], "prompts": []}
        glob = self.profile("glob", {"packages": [old | {"extensions": old["extensions"] + ["!extensions/handoffs/**"]}]})
        link = self.profile("link", {"packages": [old], "extensions": ["-extensions/handoffs.ts"]})
        (link / "extensions").mkdir()
        (link / "extensions/handoffs.ts").symlink_to(ROOT / "packages/tenantext/extensions/handoffs/index.ts")
        bolt = self.profile("bolt", {"packages": [old], "piBolt": {"packagesOverlay": True, "packages": [dict(old)]}})
        for name, profile, args in (("negative glob", glob, ()), ("disabled link", link, ()),
                                    ("Pi-Bolt list", bolt, ("--runtime", str(self.bin / "pi-bolt")))):
            with self.subTest(name):
                self.assertNotEqual("install", self.states(profile, *args)["handoffs"][2])


class InstallerParityTests(unittest.TestCase):
    def test_kit_steps_and_add_kit_items_match_install_sh(self):
        # The inventory predicts the kit steps of install.sh with a copy of KIT_STEPS and add_kit_items.
        text = (ROOT / "install.sh").read_text()
        start = text.index("<<'PY'\n") + len("<<'PY'\n")
        helper = ast.parse(text[start:text.index("\nPY\n", start)])
        nodes = [node for node in helper.body
                 if isinstance(node, ast.Assign) and [getattr(one, "id", None) for one in node.targets] == ["KIT_STEPS"]
                 or isinstance(node, ast.FunctionDef) and node.name == "add_kit_items"]
        self.assertEqual(2, len(nodes))
        installer = {}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "install.sh", "exec"), installer)
        self.assertEqual(installer["KIT_STEPS"], kit_inventory.KIT_STEPS)
        cases = [entry for step in kit_inventory.KIT_STEPS.values() for entry in step.items()] + [("skills", [])]
        for autoload in (None, False, True):
            for current in (None, [], ["!x"], ["+skills/a"], ["-skills/a"], ["skills/z"], ["skills/a", "!y"], "text", [1]):
                for key, items in cases + [("skills", ["skills/a", "skills/b"])]:
                    entry = {"source": "s"} | ({} if current is None else {key: copy.deepcopy(current)}) | (
                        {} if autoload is None else {"autoload": autoload})
                    after = copy.deepcopy(entry)
                    installer["add_kit_items"](after, key, list(items))
                    with self.subTest(entry=entry, items=items):
                        self.assertEqual(after.get(key) if after != entry else None,
                                         kit_inventory.add_kit_items(copy.deepcopy(entry), key, list(items)))


if __name__ == "__main__":
    unittest.main()
