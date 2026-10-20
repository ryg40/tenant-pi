"""Shared test tiers. The default suite includes every release test."""
import inspect
import json
import os
import unittest

slow = unittest.skipIf(os.environ.get("TENANT_PI_TIER") == "fast", "release tier")


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
