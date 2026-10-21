"""Shared test tiers. The default suite includes every release test."""
import inspect
import json
import os
from pathlib import Path
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]
slow = unittest.skipIf(os.environ.get("TENANT_PI_TIER") == "fast", "release tier")


def needs_folder(*paths):
    """Skip a test that reads a folder that a kit can leave out: the package folder of a tree component.

    Without a path, the test needs the folder of each tree component of the manifest.
    """
    from scripts.validate import TREE_COMPONENTS, optional_tree_absent
    absent = ([path for path in paths if not (ROOT / path).is_dir()] if paths else
              [cid for cid in TREE_COMPONENTS if optional_tree_absent(cid)])
    return unittest.skipIf(absent, "absent from this kit: " + ", ".join(absent))


def launch_parts(line):
    """The process variables before `env`, and the names that `env -u` removes.

    Only `tests/test_profile_plan.py` compares a whole launch line.
    """
    words = shlex.split(line)
    start = words.index("env")
    return words[:start], [words[i + 1] for i in range(start, len(words) - 1) if words[i] == "-u"]


def without_hint(stderr):
    """The JSON diagnostic of `stderr` without `hint`, the one key that names a link in the path.

    `tests/test_refusal_rules.py` checks the text of the hint.
    """
    data = json.loads(stderr)
    data.pop("hint", None)
    return data


def block_process(args, *positional, **kwargs):
    """Model an absent Git for the one provenance call; refuse every other process."""
    if args == ["git", "rev-parse", "HEAD"]:
        raise FileNotFoundError("git")
    raise AssertionError("external operation")


# The child interpreter cannot import tests until the CLI has set its module path.
BLOCK_PROCESS_HOOK = inspect.getsource(block_process) + "\nsubprocess.Popen = block_process\n"
