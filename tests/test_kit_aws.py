"""The AWS rows of install.sh with fake git, claude, uvx and pi commands in a throwaway home; no network.

The tests check the state that a run keeps, the effects that a yes or a flag allows, and the calls that a run must
not make. They do not pin the order of independent calls or the whole list of calls.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import kit_aws

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "install.sh"
MANIFEST = json.loads((ROOT / "config/manifest.json").read_text())
ROWS = kit_aws.components(MANIFEST)
URL, COMMIT = kit_aws.source(ROWS)
PLUGIN_COMMAND = ["uvx", "--from", "git+https://proxy.example.invalid/proxy@0123456", "mcp-proxy-for-aws",
                  "https://mcp.example.invalid/mcp", "--skip-auth"]

# A fake git: `clone` writes a small tree of the pinned repository, `checkout` moves HEAD (to FAKE_GIT_HEAD when it
# is set), `rev-parse` prints HEAD; other commands print nothing. Each call is a line of git-calls.jsonl.
FAKE_GIT = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with (Path(os.environ["HOME"]) / "git-calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
while args[:1] == ["-c"]:
    args = args[2:]
if args[:1] == ["--no-optional-locks"]:
    args = args[1:]
cwd = Path(args[1]) if args[:1] == ["-C"] else None
args = args[2:] if cwd else args
if args[0] == "clone":
    url, dest = args[-2], Path(args[-1])
    (dest / ".git").mkdir(parents=True)
    (dest / ".git/config").write_text('[remote "origin"]\n\turl = ' + url + "\n")
    (dest / ".git/HEAD").write_text("ref: refs/heads/main\n")
    for plugin in ("aws-core", "aws-agents", "aws-data-analytics", "aws-agents-for-devsecops", "aws-startup-advisor"):
        skill = dest / "plugins" / plugin / "skills" / ("demo-" + plugin)
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text("---\nname: demo-" + plugin + "\ndescription: A demo skill.\n---\n")
    (dest / "plugins/aws-core/skills/aws-emulator").mkdir()
    (dest / "plugins/aws-core/skills/aws-emulator/SKILL.md").write_text("---\nname: aws-emulator\ndescription: Demo.\n---\n")
    (dest / "plugins/aws-core/mcp.json").write_text(json.dumps({"mcpServers": {"aws-mcp": {
        "type": "stdio", "command": "uvx",
        "args": ["mcp-proxy-for-aws-cli==1.8.0", "https://mcp.example.invalid/mcp", "--skip-auth"]}}}))
    (dest / "plugins/aws-core/.mcp.json").write_text(json.dumps({"mcpServers": {"aws-mcp": {
        "command": "uvx", "args": ''' + repr(PLUGIN_COMMAND[1:]) + r'''}}}))
    (dest / ".claude-plugin").mkdir()
    (dest / ".claude-plugin/marketplace.json").write_text(json.dumps({"name": "agent-toolkit-for-aws"}))
elif args[0] == "checkout":
    (cwd / ".git/HEAD").write_text((os.environ.get("FAKE_GIT_HEAD") or args[-1]) + "\n")
elif args[0] == "rev-parse":
    print((cwd / ".git/HEAD").read_text().strip())
'''

# A fake claude: the marketplaces, the plugins and the user-scope servers live in the record files of Claude Code
# (~/.claude/plugins and ~/.claude.json), so the installer and the inventory read the same state. Each call is a
# line of claude-calls.jsonl.
FAKE_CLAUDE = r'''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
home = Path(os.environ["HOME"])
args = sys.argv[1:]
with (home / "claude-calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
folder = home / ".claude/plugins"
folder.mkdir(parents=True, exist_ok=True)
markets_file, plugins_file, config_file = folder / "known_marketplaces.json", folder / "installed_plugins.json", home / ".claude.json"
markets = json.loads(markets_file.read_text()) if markets_file.exists() else {}
plugins = json.loads(plugins_file.read_text()) if plugins_file.exists() else {"version": 2, "plugins": {}}
config = json.loads(config_file.read_text()) if config_file.exists() else {}
def head(plugin_id):
    path = Path(markets[plugin_id.split("@")[1]]["source"]["path"])
    return (path / ".git/HEAD").read_text().strip()
if args[:3] == ["plugin", "marketplace", "list"]:
    print(json.dumps([{"name": name, "source": "directory", "path": one["source"]["path"]} for name, one in markets.items()]))
elif args[:2] == ["plugin", "list"]:
    print(json.dumps([{"id": key, "version": "1.0.0", "scope": value[0].get("scope")} for key, value in plugins["plugins"].items()]))
elif args[:3] == ["plugin", "marketplace", "add"]:
    path = args[3]
    name = json.loads((Path(path) / ".claude-plugin/marketplace.json").read_text())["name"]
    markets[name] = {"source": {"source": "directory", "path": path}}
elif args[:3] == ["plugin", "marketplace", "remove"]:
    markets.pop(args[3], None)
elif args[:2] == ["plugin", "install"]:
    plugins["plugins"][args[2]] = [{"scope": "user", "gitCommitSha": head(args[2])}]
elif args[:2] == ["plugin", "update"]:
    plugins["plugins"][args[2]][0]["gitCommitSha"] = os.environ.get("FAKE_CLAUDE_SHA") or head(args[2])
elif args[:2] == ["plugin", "uninstall"] and os.environ.get("FAKE_CLAUDE_FAIL") == "uninstall":
    sys.exit(1)
elif args[:2] == ["plugin", "uninstall"]:
    plugins["plugins"].pop(args[2], None)
elif args[:2] == ["mcp", "add-json"]:
    servers = config.setdefault("mcpServers", {})
    if args[-2] in servers:
        sys.exit(1)
    servers[args[-2]] = json.loads(args[-1])
elif args[:2] == ["mcp", "remove"]:
    config.get("mcpServers", {}).pop(args[-1], None)
markets_file.write_text(json.dumps(markets))
plugins_file.write_text(json.dumps(plugins))
config_file.write_text(json.dumps(config))
'''

# A fake uvx: a probe of the credential sources of the pinned botocore 1.43.83 (create_credential_resolver). It writes
# one JSON line with its arguments, the names of its environment and the sources that would give credentials: a
# variable that holds or points to credentials, or a file of the chain that is a regular file. It writes no value.
FAKE_UVX = r'''#!/usr/bin/python3
import json, os, sys
env = os.environ
def regular(*paths):
    return any(os.path.isfile(os.path.expanduser(path)) for path in paths)
sources = {
    "env": "AWS_ACCESS_KEY_ID" in env,
    "assume-role-with-web-identity": "AWS_WEB_IDENTITY_TOKEN_FILE" in env,
    "shared-credentials-file": regular(env.get("AWS_SHARED_CREDENTIALS_FILE", "~/.aws/credentials")),
    "config-file": regular(env.get("AWS_CONFIG_FILE", "~/.aws/config")),
    "ec2-credentials-file": "AWS_CREDENTIAL_FILE" in env,
    "boto-config": regular(*([env["BOTO_CONFIG"]] if "BOTO_CONFIG" in env else ["/etc/boto.cfg", "~/.boto"])),
    "container-role": "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" in env or "AWS_CONTAINER_CREDENTIALS_FULL_URI" in env,
    "iam-role": env.get("AWS_EC2_METADATA_DISABLED", "").lower() != "true",
}
with open(env["FAKE_UVX_LOG"], "a") as log:
    log.write(json.dumps({"args": sys.argv[1:], "names": sorted(env),
                          "sources": sorted(name for name, found in sources.items() if found)}) + "\n")
'''

MUTATIONS = (("plugin", "install"), ("plugin", "uninstall"), ("plugin", "update"), ("plugin", "marketplace", "add"),
             ("plugin", "marketplace", "remove"), ("mcp", "add-json"), ("mcp", "remove"))


class AwsRowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="aws-rows-test-")
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "home"
        (self.home / ".claude").mkdir(parents=True)
        self.bin = Path(temp.name) / "bin"
        self.bin.mkdir()
        for name, text in (("git", FAKE_GIT), ("claude", FAKE_CLAUDE),
                           ("pi", "#!/bin/sh\necho \"$*\" >> \"$HOME/pi-calls\"\n"),
                           ("uvx", "#!/bin/sh\necho \"$*\" >> \"$HOME/uvx-calls\"\nexit 1\n")):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o700)
        self.profile = self.home / ".pi/profiles/demo"
        self.clone = kit_aws.clone_dir(self.home, URL)
        self.env = {"HOME": str(self.home), "PATH": str(self.bin) + ":/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1",
                    "INSTALL_SKIP_PACKAGES": "1", "INSTALL_TEST_TTY": str(self.home / "absent-tty")}

    def install(self, modules, *flags, mode="new", env=None):
        return subprocess.run(["sh", str(SCRIPT), "--" + mode, "demo", "--shell", "none", "--with", modules, "--yes", *flags],
                              env=self.env | (env or {}), stdin=subprocess.DEVNULL, text=True, capture_output=True,
                              timeout=60)

    def success(self, result):
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def calls(self, name):
        path = self.home / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def changes(self, since=0):
        """The claude calls from `since` that change Claude Code."""
        return [call for call in self.calls("claude-calls.jsonl")[since:]
                if any(tuple(call[:len(one)]) == one for one in MUTATIONS)]

    def read(self, name):
        return json.loads((self.profile / name).read_text())

    def write(self, name, data):
        (self.profile / name).write_text(json.dumps(data))

    def claude_file(self, name):
        path = self.home / name
        return json.loads(path.read_text()) if path.exists() else {}

    def plugins(self):
        return self.claude_file(".claude/plugins/installed_plugins.json").get("plugins", {})

    def kit_skill(self, cid):
        return kit_aws.expected_skills(self.clone, ROWS[cid])[0]

    def test_the_claude_code_plugins_need_their_own_yes(self):
        self.success(self.install("mcp,aws-core"))
        # --yes and no terminal: no claude command at all.
        self.assertEqual([], self.calls("claude-calls.jsonl"))
        self.success(self.install("mcp,aws-core", "--claude-aws", mode="upgrade"))
        self.assertEqual({"aws-core@agent-toolkit-for-aws"}, set(self.plugins()))
        # Claude Code gets the kit launcher as in Pi, and the server of the plugin stays off.
        kit_server = self.claude_file(".claude.json")["mcpServers"]["aws-mcp"]
        self.assertEqual(self.read("mcp-adapter.json")["mcpServers"]["aws-mcp"]["args"], kit_server["args"])
        self.assertEqual([{"serverCommand": PLUGIN_COMMAND}],
                         self.claude_file(".claude/settings.json")["deniedMcpServers"])
        # The installer starts no MCP server.
        self.assertFalse((self.home / "uvx-calls").exists())

    def test_an_aws_entry_of_the_user_stays_without_the_adopt_flag(self):
        self.profile.mkdir(parents=True)
        theirs = "/elsewhere/agent-toolkit-for-aws/plugins/aws-core/skills"
        own_server = {"url": "https://mcp.example.invalid/mcp", "lifecycle": "lazy"}
        self.write("settings.json", {"skills": [theirs]})
        self.write("mcp-adapter.json", {"mcpServers": {"aws-mcp": own_server}})
        markets = self.home / ".claude/plugins"
        markets.mkdir(parents=True)
        user_market = {"agent-toolkit-for-aws": {"source": {"source": "directory", "path": "/elsewhere/agent-toolkit-for-aws"}}}
        (markets / "known_marketplaces.json").write_text(json.dumps(user_market))
        self.success(self.install("mcp,aws-core", "--claude-aws", mode="upgrade"))
        self.assertEqual([theirs], self.read("settings.json")["skills"])
        self.assertEqual({"aws-mcp": own_server}, self.read("mcp-adapter.json")["mcpServers"])
        self.assertEqual(user_market, self.claude_file(".claude/plugins/known_marketplaces.json"))
        self.assertEqual([], self.changes())
        # The adopt flag moves each of them to the kit pin.
        self.success(self.install("mcp,aws-core", "--claude-aws", "--adopt-aws", mode="upgrade"))
        self.assertEqual([self.kit_skill("aws-core")], self.read("settings.json")["skills"])
        self.assertEqual(kit_aws.kit_entry(self.clone, False), self.read("mcp-adapter.json")["mcpServers"]["aws-mcp"])
        market = self.claude_file(".claude/plugins/known_marketplaces.json")["agent-toolkit-for-aws"]
        self.assertEqual(str(self.clone), market["source"]["path"])
        self.assertEqual({"aws-core@agent-toolkit-for-aws"}, set(self.plugins()))

    def test_an_edited_kit_entry_or_one_without_a_record_is_the_users(self):
        self.success(self.install("mcp,aws-core"))
        adapter = self.read("mcp-adapter.json")
        edited = {**adapter["mcpServers"]["aws-mcp"], "command": "own-proxy", "args": ["--own"]}
        adapter["mcpServers"]["aws-mcp"] = edited
        self.write("mcp-adapter.json", adapter)
        self.success(self.install("mcp", mode="upgrade"))
        # The edited entry keeps the kit description, but it differs from the record: it stays.
        self.assertEqual(edited, self.read("mcp-adapter.json")["mcpServers"]["aws-mcp"])
        self.assertEqual({}, self.read("kit-aws.json")["mcp"])
        # An entry with the kit description and no record is not replaced either.
        self.success(self.install("mcp,aws-core", mode="upgrade"))
        self.assertEqual(edited, self.read("mcp-adapter.json")["mcpServers"]["aws-mcp"])

    def test_a_user_plugin_in_the_kit_marketplace_stays(self):
        self.success(self.install("aws-core"))
        folder = self.home / ".claude/plugins"
        folder.mkdir(parents=True)
        (folder / "known_marketplaces.json").write_text(json.dumps(
            {"agent-toolkit-for-aws": {"source": {"source": "directory", "path": str(self.clone)}}}))
        user_plugin = [{"scope": "user", "gitCommitSha": "1" * 40}]
        (folder / "installed_plugins.json").write_text(json.dumps(
            {"version": 2, "plugins": {"aws-agents@agent-toolkit-for-aws": user_plugin}}))
        self.success(self.install("aws-core", "--claude-aws", mode="upgrade"))
        self.success(self.install("aws-core,aws-agents", "--claude-aws", mode="upgrade"))
        # The plugin of the user stays at its own commit: no uninstall and no update of it.
        self.assertEqual(user_plugin, self.plugins()["aws-agents@agent-toolkit-for-aws"])
        self.assertEqual([], [call for call in self.changes() if "aws-agents@agent-toolkit-for-aws" in call])
        self.assertEqual(COMMIT, self.plugins()["aws-core@agent-toolkit-for-aws"][0]["gitCommitSha"])
        # A plugin that stays off the pin after the update fails the run.
        records = folder / "installed_plugins.json"
        data = json.loads(records.read_text())
        data["plugins"]["aws-core@agent-toolkit-for-aws"][0]["gitCommitSha"] = "2" * 40
        records.write_text(json.dumps(data))
        result = self.install("aws-core", "--claude-aws", mode="upgrade", env={"FAKE_CLAUDE_SHA": "2" * 40})
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)

    def test_a_failed_uninstall_keeps_the_deny_entry(self):
        self.success(self.install("aws-core", "--claude-aws"))
        self.install("none", "--claude-aws", mode="upgrade", env={"FAKE_CLAUDE_FAIL": "uninstall"})
        # The plugin stays, so its own server stays off until the kit confirms the removal.
        self.assertIn({"serverCommand": PLUGIN_COMMAND},
                      self.claude_file(".claude/settings.json").get("deniedMcpServers", []))

    def test_turning_a_row_off_removes_only_what_the_kit_wrote(self):
        self.success(self.install("mcp,aws-core,aws-agents,aws-emulator", "--claude-aws"))
        settings = self.read("settings.json")
        settings["skills"].append("/elsewhere/own-skills")
        self.write("settings.json", settings)
        adapter = self.read("mcp-adapter.json")
        adapter["mcpServers"]["own"] = {"command": "own-server"}
        self.write("mcp-adapter.json", adapter)
        records = self.home / ".claude/plugins/installed_plugins.json"
        data = json.loads(records.read_text())
        data["plugins"]["aws-core@claude-plugins-official"] = [{"scope": "user"}]
        records.write_text(json.dumps(data))
        claude_settings = self.claude_file(".claude/settings.json")
        claude_settings["deniedMcpServers"].append({"serverName": "own"})
        (self.home / ".claude/settings.json").write_text(json.dumps(claude_settings))
        self.success(self.install("mcp", "--claude-aws", mode="upgrade"))
        self.assertEqual(["/elsewhere/own-skills"], self.read("settings.json")["skills"])
        self.assertEqual({"own": {"command": "own-server"}}, self.read("mcp-adapter.json")["mcpServers"])
        self.assertEqual({"aws-core@claude-plugins-official"}, set(self.plugins()))
        self.assertEqual([{"serverName": "own"}], self.claude_file(".claude/settings.json")["deniedMcpServers"])
        self.assertEqual({}, self.claude_file(".claude.json").get("mcpServers"))
        # The clone stays for the other profiles.
        self.assertTrue((self.clone / ".git").is_dir())

    def test_the_clone_refuses_a_commit_that_differs_from_the_pin(self):
        other = "0" * 40
        result = self.install("aws-core", env={"FAKE_GIT_HEAD": other})
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertFalse(self.clone.exists())
        self.assertFalse(self.profile.exists())
        # A clone of the kit at another commit, that a run cannot move to the pin, is refused too.
        self.success(self.install("aws-core"))
        (self.clone / ".git/HEAD").write_text(other + "\n")
        result = self.install("aws-core", mode="upgrade", env={"FAKE_GIT_HEAD": other})
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertEqual(other, kit_aws.head_of(self.clone))


class LauncherTests(unittest.TestCase):
    def test_the_proxy_starts_unsigned_unless_a_profile_is_named(self):
        temp = Path(tempfile.mkdtemp(prefix="aws-launcher-test-"))
        self.addCleanup(shutil.rmtree, temp, True)
        (temp / "uvx").write_text(FAKE_UVX)
        (temp / "uvx").chmod(0o700)
        log = temp / "uvx.jsonl"
        args = ["mcp-proxy-for-aws-cli==1.8.0", "https://mcp.example.invalid/mcp", "--skip-auth"]
        # Each source of the credential chain holds a placeholder: the files of the home and the variables.
        home = temp / "home"
        (home / ".aws").mkdir(parents=True)
        for name in (".aws/credentials", ".aws/config", ".boto", "boto.cfg", "ec2.cfg", "token"):
            (home / name).write_text("placeholder\n")
        ambient = {"PATH": str(temp) + ":/usr/bin:/bin", "HOME": str(home), "FAKE_UVX_LOG": str(log),
                   "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "placeholder", "AWS_SECRET_ACCESS_KEY": "placeholder",
                   "AWS_SESSION_TOKEN": "placeholder", "AWS_PROFILE": "demo", "AWS_ROLE_ARN": "placeholder",
                   "AWS_WEB_IDENTITY_TOKEN_FILE": str(home / "token"), "AWS_CREDENTIAL_FILE": str(home / "ec2.cfg"),
                   "BOTO_CONFIG": str(home / "boto.cfg"), "AWS_CONTAINER_CREDENTIALS_FULL_URI": "placeholder"}
        for extra in ({}, {"AWS_MCP_PROXY_PROFILES": "demo"}):
            done = subprocess.run(["python3", str(kit_aws.LAUNCHER), *args], env=ambient | extra, capture_output=True,
                                  text=True, timeout=30)
            self.assertEqual(0, done.returncode, done.stderr)
        unsigned, signed = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(args, unsigned["args"])
        # Without the opt-in, no source of the chain gives credentials.
        self.assertEqual([], unsigned["sources"])
        # The opt-in keeps the environment: the proxy signs with the named profile.
        self.assertEqual(sorted({*ambient, "AWS_MCP_PROXY_PROFILES"}), [name for name in signed["names"] if name in {
            *ambient, "AWS_MCP_PROXY_PROFILES"}])
        # A command that is not the pinned proxy does not start.
        started = log.read_text()
        done = subprocess.run(["python3", str(kit_aws.LAUNCHER), "other-tool"], env=ambient, capture_output=True,
                              text=True, timeout=30)
        self.assertEqual(2, done.returncode)
        self.assertEqual(started, log.read_text())


@unittest.skipUnless(shutil.which("git"), "needs git")
class CloneSafetyTests(unittest.TestCase):
    """ensure_clone with a real git on a local repository at the kit clone path; no network."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="aws-clone-test-")
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.home = self.temp / "home"
        self.url = "https://git.example.invalid/demo/toolkit.git"
        self.clone = kit_aws.clone_dir(self.home, self.url)
        self.marker = self.temp / "code-ran"
        self.clone.mkdir(parents=True)
        self.git("init", "--quiet", "--template=")
        (self.clone / ".gitignore").write_text("*.log\n__pycache__/\n")
        (self.clone / "plugins/demo/skills/one").mkdir(parents=True)
        (self.clone / "plugins/demo/skills/one/SKILL.md").write_text("---\nname: one\ndescription: Demo.\n---\n")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "first")
        self.first = self.git("rev-parse", "HEAD")
        (self.clone / "plugins/demo/skills/one/notes.md").write_text("second\n")
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "second")
        self.second = self.git("rev-parse", "HEAD")
        self.git("remote", "add", "origin", self.url)

    def git(self, *args):
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
               "GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_NAME": "test",
               "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        return subprocess.run(["git", "-c", "core.hooksPath=" + os.devnull, "-C", str(self.clone), *args], env=env,
                              check=True, capture_output=True, text=True).stdout.strip()

    def script(self, path):
        path.write_text("#!/bin/sh\necho ran >> " + str(self.marker) + "\n")
        path.chmod(0o700)
        return path

    def test_untracked_and_ignored_files_refuse_the_clone(self):
        extra = self.clone / "plugins/demo/skills/extra/SKILL.md"
        extra.parent.mkdir()
        extra.write_text("---\nname: extra\ndescription: Not of the pin.\n---\n")
        with self.assertRaises(kit_aws.Refusal):
            kit_aws.ensure_clone(self.home, self.url, self.second)
        self.assertTrue(extra.is_file())
        extra.unlink()
        extra.parent.rmdir()
        ignored = self.clone / "plugins/demo/skills/one/debug.log"
        ignored.write_text("ignored\n")
        with self.assertRaises(kit_aws.Refusal):
            kit_aws.ensure_clone(self.home, self.url, self.first)
        self.assertEqual(self.second, self.git("rev-parse", "HEAD"))
        ignored.unlink()
        # A Python bytecode cache is no reason to refuse.
        (self.clone / "plugins/demo/skills/one/__pycache__").mkdir()
        (self.clone / "plugins/demo/skills/one/__pycache__/x.pyc").write_bytes(b"cache")
        kit_aws.ensure_clone(self.home, self.url, self.second)

    def test_git_runs_no_hook_and_no_inherited_config(self):
        self.git("checkout", "--quiet", "--detach", self.first)
        hooks = self.temp / "hooks"
        hooks.mkdir()
        self.script(hooks / "post-checkout")
        (self.clone / ".git/hooks").mkdir(exist_ok=True)
        self.script(self.clone / ".git/hooks/post-checkout")
        monitor = self.script(self.temp / "fsmonitor")
        inherited = self.temp / "inherited.gitconfig"
        inherited.write_text("[core]\n\thooksPath = " + str(hooks) + "\n\tfsmonitor = " + str(monitor) + "\n")
        environment = {"GIT_CONFIG_GLOBAL": str(inherited), "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.hooksPath",
                       "GIT_CONFIG_VALUE_0": str(hooks)}
        with mock.patch.dict(os.environ, environment):
            kit_aws.ensure_clone(self.home, self.url, self.second)
        self.assertEqual(self.second, self.git("rev-parse", "HEAD"))
        self.assertFalse(self.marker.exists())
        # A local config key that can run code refuses the clone before any checkout.
        self.git("config", "core.fsmonitor", str(monitor))
        with self.assertRaises(kit_aws.Refusal):
            kit_aws.ensure_clone(self.home, self.url, self.first)
        self.assertEqual(self.second, self.git("rev-parse", "HEAD"))
        self.assertFalse(self.marker.exists())


if __name__ == "__main__":
    unittest.main()
