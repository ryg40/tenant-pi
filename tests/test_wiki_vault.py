"""Wiki vault probe contract: `lstat` only, the three results, and no open, listing or write below a vault."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts import tenant_pi, wiki_vault

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts/tenant_pi.py"
ABSENT = {"kind": "absent", "exists": False, "config": False, "doubled": False,
          "embeddings": {"exists": False, "size": None}, "ownedByUser": None}


def tree(root):
    return {str(p.relative_to(root)): (os.lstat(p).st_mode, os.lstat(p).st_mtime_ns) for p in root.rglob("*")}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tenant-pi-wiki-vault-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home dir"
        self.home.mkdir()
        self.other = self.base / "wiki home"
        self.other.mkdir()

    def make(self, root, *, config=True, store=b"0123456789"):
        vault = root / ".llm-wiki"
        (vault / "meta").mkdir(parents=True)
        if config:
            (vault / "config.json").write_text("{}")
        if store is not None:
            (vault / "meta/embeddings.json").write_bytes(store)
        return vault

    def facts(self, root, **changes):
        return {"root": str(root), "vault": str(root / ".llm-wiki"), **ABSENT, **changes}


class ModuleTests(Fixture):
    def test_no_vault(self):
        self.assertEqual(("vault_exists", "no_vault", "second_vault"), wiki_vault.RESULTS)
        self.assertEqual({"home": self.facts(self.home), "wikiHome": None, "personalVault": "home", "result": "no_vault"},
                         wiki_vault.report(str(self.home)))
        self.assertEqual({"home": self.facts(self.home), "wikiHome": self.facts(self.other), "personalVault": "wikiHome",
                          "result": "no_vault"}, wiki_vault.report(str(self.home), str(self.other)))
        self.assertEqual("/.llm-wiki", wiki_vault.path("/"))
        self.assertEqual("/a/.llm-wiki", wiki_vault.path("/a/"))

    def test_vault_of_the_home_directory(self):
        self.make(self.home)
        found = self.facts(self.home, kind="directory", exists=True, config=True, ownedByUser=True,
                           embeddings={"exists": True, "size": 10})
        self.assertEqual({"home": found, "wikiHome": None, "personalVault": "home", "result": "vault_exists"},
                         wiki_vault.report(str(self.home)))
        with patch.object(wiki_vault.os, "geteuid", return_value=os.geteuid() + 1):
            self.assertIs(False, wiki_vault.vault(str(self.home))["ownedByUser"])

    def test_parts_of_a_vault(self):
        vault = self.make(self.home, config=False, store=None)
        self.assertEqual(self.facts(self.home, kind="directory", exists=True, ownedByUser=True), wiki_vault.vault(str(self.home)))
        # The doubled layout: only an inner `config.json` counts, as in the extension.
        (vault / ".llm-wiki").mkdir()
        self.assertFalse(wiki_vault.vault(str(self.home))["doubled"])
        (vault / ".llm-wiki/config.json").write_text("{}")
        self.assertTrue(wiki_vault.vault(str(self.home))["doubled"])
        self.assertFalse(wiki_vault.vault(str(self.home))["config"])
        # A store that is not a regular file has no size.
        (vault / "meta/embeddings.json").symlink_to(vault / "absent")
        self.assertEqual({"exists": True, "size": None}, wiki_vault.vault(str(self.home))["embeddings"])

    def test_kinds(self):
        self.assertEqual(("absent", "directory", "symlink", "other", "unreadable"), wiki_vault.KINDS)
        real = self.make(self.other)
        (self.home / ".llm-wiki").symlink_to(real, target_is_directory=True)
        # A vault that is a link counts as present; the facts below it come through the link.
        self.assertEqual(self.facts(self.home, kind="symlink", exists=True, config=True, ownedByUser=True,
                                    embeddings={"exists": True, "size": 10}), wiki_vault.vault(str(self.home)))
        plain = self.base / "plain"
        plain.mkdir()
        (plain / ".llm-wiki").write_text("a file")
        self.assertEqual(self.facts(plain, kind="other"), wiki_vault.vault(str(plain)))
        self.assertEqual(self.facts(plain / ".llm-wiki"), wiki_vault.vault(str(plain / ".llm-wiki")))
        with patch.object(wiki_vault.os, "lstat", side_effect=PermissionError("CANARY")):
            self.assertEqual(self.facts(self.home, kind="unreadable"), wiki_vault.vault(str(self.home)))

    def test_wiki_home_wins_and_a_second_vault_is_a_result(self):
        self.make(self.home)
        report = wiki_vault.report(str(self.home), str(self.other))
        self.assertEqual(("wikiHome", "second_vault"), (report["personalVault"], report["result"]))
        self.assertTrue(report["home"]["exists"])
        self.assertFalse(report["wikiHome"]["exists"])
        self.make(self.other, store=None)
        report = wiki_vault.report(str(self.home), str(self.other))
        self.assertEqual(("wikiHome", "vault_exists"), (report["personalVault"], report["result"]))
        # The same root in both places is one vault.
        report = wiki_vault.report(str(self.home), str(self.home))
        self.assertEqual("vault_exists", report["result"])
        self.assertEqual(report["home"], report["wikiHome"])


class CliTests(Fixture):
    def run_cli(self, *, wiki_home=None, home=True):
        out, err = io.StringIO(), io.StringIO()
        env = {name: value for name, value in os.environ.items() if name not in ("HOME", "WIKI_HOME")}
        if home:
            env["HOME"] = str(self.home) if home is True else home
        if wiki_home is not None:
            env["WIKI_HOME"] = wiki_home
        with patch.dict(os.environ, env, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = tenant_pi.main(["check-wiki-vault"])
        return code, out.getvalue(), err.getvalue()

    def test_reports_from_the_environment_and_changes_nothing(self):
        self.make(self.home)
        before = tree(self.base)
        code, out, err = self.run_cli()
        self.assertEqual((0, ""), (code, err))
        self.assertEqual(wiki_vault.report(str(self.home)), json.loads(out))
        self.assertEqual("vault_exists", json.loads(out)["result"])
        # An empty `WIKI_HOME` is no `WIKI_HOME`: the extension tests the value for truth.
        self.assertEqual(out, self.run_cli(wiki_home="")[1])
        code, out, err = self.run_cli(wiki_home=str(self.other))
        self.assertEqual((0, ""), (code, err))
        self.assertEqual(wiki_vault.report(str(self.home), str(self.other)), json.loads(out))
        self.assertEqual("second_vault", json.loads(out)["result"])
        # Trailing separators of `WIKI_HOME` do not change the root, as in the extension and in the write rules.
        for value in (str(self.other) + "/", str(self.other) + "//"):
            self.assertEqual((0, out, ""), self.run_cli(wiki_home=value))
        self.assertEqual(before, tree(self.base))

    def test_bad_environment_is_a_static_diagnostic(self):
        for kwargs, error in (({"home": False}, "home_required: check-wiki-vault.home"),
                              ({"home": "relative"}, "absolute_path: check-wiki-vault.home"),
                              ({"wiki_home": "relative/CANARY"}, "absolute_path: check-wiki-vault.wiki_home"),
                              ({"wiki_home": "/a/../CANARY"}, "absolute_path: check-wiki-vault.wiki_home")):
            with self.subTest(error=error):
                code, out, err = self.run_cli(**kwargs)
                self.assertEqual((2, ""), (code, out))
                self.assertEqual({"candidate_created": False, "error": error}, json.loads(err))
                self.assertNotIn("CANARY", err)

    def test_process_opens_and_lists_nothing_below_a_vault(self):
        for root in (self.home, self.other):
            vault = self.make(root)
            (vault / ".llm-wiki").mkdir()
            (vault / ".llm-wiki/config.json").write_text("{}")
        log = self.base / "events.log"
        # The hook loads before the CLI. It records each open and each listing, and it fails one below a root.
        (self.base / "sitecustomize.py").write_text(
            "import os, sys\nsys.dont_write_bytecode = True\n"
            "_log = os.open(" + repr(str(log)) + ", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)\n"
            "_roots = " + repr((str(self.home), str(self.other))) + "\n"
            "def audit(event, args):\n"
            "    if event in ('open', 'os.scandir', 'os.listdir'):\n"
            "        os.write(_log, (event + ' ' + str(args[0]) + '\\n').encode('utf-8', 'replace'))\n"
            "        if isinstance(args[0], str) and args[0].startswith(_roots):\n"
            "            raise AssertionError('vault entry opened or listed')\n"
            "sys.addaudithook(audit)\n")
        env = {"HOME": str(self.home), "WIKI_HOME": str(self.other), "PATH": "/nonexistent", "PYTHONPATH": str(self.base),
               "PYTHONDONTWRITEBYTECODE": "1"}
        before = tree(self.base / self.home.name), tree(self.other)
        result = subprocess.run([sys.executable, str(CLI), "check-wiki-vault"], cwd=self.base, env=env,
                                text=True, capture_output=True, check=False)
        self.assertEqual((0, ""), (result.returncode, result.stderr))
        report = json.loads(result.stdout)
        self.assertEqual(("wikiHome", "vault_exists"), (report["personalVault"], report["result"]))
        for key in ("home", "wikiHome"):
            self.assertEqual((True, True, {"exists": True, "size": 10}),
                             (report[key]["config"], report[key]["doubled"], report[key]["embeddings"]))
        self.assertEqual(before, (tree(self.home), tree(self.other)))
        events = log.read_text().splitlines()
        # The hook was live: it saw the open of the CLI file itself.
        self.assertIn("open " + str(CLI), events)
        self.assertEqual([], [line for line in events if ".llm-wiki" in line or "embeddings" in line])


if __name__ == "__main__":
    unittest.main()
