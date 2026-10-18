"""One in-process table for protected roots, environment variants and symbolic links."""
from contextlib import ExitStack
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import profile_write, tenant_pi, wizard
from scripts.profile_write import check_location
from scripts.validate import Invalid


class RefusalRulesTests(unittest.TestCase):
    def test_commands_build_documented_refusal_roots(self):
        """Assert the root lists at the location checks, before any filesystem write."""
        class StopBeforeWrite(Exception):
            pass

        with tempfile.TemporaryDirectory(prefix="tenant-pi-wiring-") as temp:
            base = Path(temp).resolve()
            home, kit, wiki, chosen, target, output = (
                str(base / name) for name in ("home", "kit", "wiki", "chosen", "target", "output"))
            overlay = {"target": {"agentDir": target}, "memory": {"wiki": {"wikiHome": chosen}}}
            plan = {"targetAgentDir": target, "readinessGaps": [], "commands": {"launch": "pi"}}
            common = {("under_kit", kit), ("under_pi_agent", home + "/.pi/agent"),
                      ("under_wiki_vault", home + "/.llm-wiki"), ("under_wiki_vault", wiki + "/.llm-wiki")}
            overlay_vault = {("under_wiki_vault", chosen + "/.llm-wiki")}
            # docs/private-directory.md#refusal-rules: results uses under_target, not under_pi_agent.
            expected = {
                "launcher": common | overlay_vault | {("under_target", target)},
                "baseline": common | {("under_dir", target)},
                "init-private": common | {("under_overlay_target", target)},
                "compose-plan": common | overlay_vault,
                "results": (common - {("under_pi_agent", home + "/.pi/agent")}) | {("under_target", target)},
                "generate": common | overlay_vault,
                "wizard": common | overlay_vault | {("under_target", target)},
            }
            state = SimpleNamespace(overlay=overlay, rows=lambda: [], scan=None)
            adapter = SimpleNamespace(destinations=("local",), options=(), start=lambda context: state)
            wizard_args = SimpleNamespace(account="tester", home=home, target=target, private_dir=output,
                                          adapter="tenant-pi", destination="local", clone=None, ssh_target=None,
                                          manifest=None, overlay=None, local_dir=None, registry=None,
                                          evidence=None, format="json")
            calls = {
                "launcher": lambda: tenant_pi._launcher_location(output, plan, (target,), overlay),
                "baseline": lambda: tenant_pi._baseline(SimpleNamespace(dir=target, out=output), None),
                "init-private": lambda: tenant_pi._init_private(SimpleNamespace(dir=output, target=None, overlay=[])),
                "compose-plan": lambda: tenant_pi._compose_write(
                    {"answers": {"privateDir": output}, "overlay": overlay,
                     "seatEnv": [], "composeEnv": [], "registry": {}}, b""),
                "results": lambda: tenant_pi._results(SimpleNamespace(target=[target], out_dir=output,
                                                                      replace=False, manifest="unused", overlay=None)),
                "generate": lambda: tenant_pi.main(["generate", "--overlay", "unused", "--target", target]),
                "wizard": lambda: wizard.run(wizard_args, tenant_pi, terminal=object()),
            }
            for command, call in calls.items():
                with self.subTest(command=command), ExitStack() as stack:
                    seen = set()
                    destination = target if command == "generate" else output
                    original_check = profile_write.check_location
                    original_outside = tenant_pi._outside

                    def check(path, forbidden=(), field="target"):
                        if path == destination:
                            seen.update(forbidden)
                        return original_check(path, forbidden, field)

                    def outside(path, pairs, field):
                        if path == destination:
                            seen.update(tenant_pi._roots(pairs))
                        return original_outside(path, pairs, field)

                    stack.enter_context(patch.dict(os.environ, {"HOME": home, "WIKI_HOME": wiki}, clear=True))
                    stack.enter_context(patch.object(tenant_pi, "ROOT", Path(kit)))
                    stack.enter_context(patch.object(tenant_pi, "check_location", side_effect=check))
                    stack.enter_context(patch.object(wizard, "check_location", side_effect=check))
                    stack.enter_context(patch.object(tenant_pi, "_outside", side_effect=outside))
                    # Stop at the first operation after the command's location checks.
                    for name in ("preflight", "_open_dir", "write", "_kit_commit"):
                        stack.enter_context(patch.object(tenant_pi, name, side_effect=StopBeforeWrite))
                    stack.enter_context(patch.object(tenant_pi, "prepare", return_value=plan))
                    stack.enter_context(patch.object(wizard.wizard_adapter, "load_adapter", return_value=adapter))
                    if command == "init-private":
                        stack.enter_context(patch.object(tenant_pi, "_load_input", return_value=b"{}"))
                        stack.enter_context(patch.object(tenant_pi, "_parse", return_value=overlay))

                        def init(directory, contents, forbidden):
                            check(directory, forbidden, "init-private.dir")
                            raise StopBeforeWrite

                        stack.enter_context(patch.object(tenant_pi, "init", side_effect=init))
                    elif command == "results":
                        stack.enter_context(patch.object(tenant_pi, "_load_input", side_effect=StopBeforeWrite))
                    else:
                        stack.enter_context(patch.object(tenant_pi, "_load_input", return_value=overlay))
                    try:
                        call()
                    except StopBeforeWrite:
                        pass
                    self.assertEqual(expected[command], seen)

    def test_protected_roots_home_and_symlink_matrix(self):
        with tempfile.TemporaryDirectory(prefix="tenant-pi-location-") as temp:
            base = Path(temp).resolve()
            home = base / "home"
            (home / ".pi").mkdir(parents=True)
            agent = base / "real-agent"
            agent.mkdir()
            (home / ".pi/agent").symlink_to(agent, target_is_directory=True)
            linked_home = base / "linked-home"
            linked_home.symlink_to(home, target_is_directory=True)
            kit = base / "kit"
            real_kit = base / "real-kit"
            real_kit.mkdir()
            kit.symlink_to(real_kit, target_is_directory=True)
            real_vault = base / "real-vault"
            real_vault.mkdir()
            (home / ".llm-wiki").symlink_to(real_vault, target_is_directory=True)
            wiki = base / "wiki"
            chosen = base / "chosen"
            for current_home in (home, linked_home):
                for wiki_home in (None, "", "relative", str(wiki), str(wiki) + "//"):
                    env = {"HOME": str(current_home), "PI_CODING_AGENT_DIR": str(base / "ignored")}
                    if wiki_home is not None:
                        env["WIKI_HOME"] = wiki_home
                    data = {"memory": {"wiki": {"wikiHome": str(chosen)}}}
                    with patch.dict(os.environ, env, clear=True):
                        pairs = (("under_kit", str(kit)), ("under_pi_agent", str(current_home / ".pi/agent")),
                                 *tenant_pi._wiki_vaults(tenant_pi._home("home"), data))
                        roots = tenant_pi._roots(pairs)
                        self.assertIn(("under_pi_agent", str(agent)), roots)
                        self.assertIn(("under_kit", str(real_kit)), roots)
                        self.assertIn(("under_wiki_vault", str(real_vault)), roots)
                        expected_vaults = {str(current_home / ".llm-wiki"), str(chosen / ".llm-wiki")}
                        if wiki_home and wiki_home.startswith("/"):
                            expected_vaults.add(str(wiki / ".llm-wiki"))
                        self.assertEqual(expected_vaults, {root for rule, root in pairs if rule == "under_wiki_vault"})
                        for rule, root in roots:
                            for suffix in ("", "/child", "/nested/child"):
                                with self.subTest(home=str(current_home), wiki_home=wiki_home, rule=rule, suffix=suffix):
                                    for field in ("init-private.dir", "launcher.path", "baseline.out",
                                                  "results.out_dir", "wizard.private_dir"):
                                        with patch.object(profile_write.os, "open", side_effect=AssertionError("file open")), \
                                             self.assertRaises(Invalid) as error:
                                            check_location(root + suffix, roots, field)
                                        self.assertEqual(rule + ": " + field, str(error.exception))
                                    with self.assertRaises(Invalid) as error:
                                        tenant_pi._outside(root + suffix, pairs, "target")
                                    self.assertEqual(rule + ": target", str(error.exception))
                            check_location(root + "-sibling", roots, "target")
                            tenant_pi._outside(root + "-sibling", pairs, "target")
                        # A target link is resolved by _outside, not by the text-only check_location.
                        for rule, destination in (("under_kit", real_kit), ("under_pi_agent", agent),
                                                  ("under_wiki_vault", real_vault)):
                            link = base / (rule + "-link")
                            if not link.is_symlink():
                                link.symlink_to(destination, target_is_directory=True)
                            with self.assertRaisesRegex(Invalid, "^" + rule + ": target$"):
                                tenant_pi._outside(str(link / "child"), pairs, "target")
                        tenant_pi._outside(str(base / "ignored"), pairs, "target")
            for value, error in ((None, "home_required"), ("relative", "absolute_path"), (str(home) + "/", "absolute_path")):
                with patch.dict(os.environ, {} if value is None else {"HOME": value}, clear=True):
                    with self.assertRaisesRegex(Invalid, "^" + error + ": home$"):
                        tenant_pi._home("home")

