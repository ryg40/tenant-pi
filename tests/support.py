"""Shared test tiers. The default suite includes every release test."""
import inspect
import os
import unittest

slow = unittest.skipIf(os.environ.get("TENANT_PI_TIER") == "fast", "release tier")


def block_process(args, *positional, **kwargs):
    """Model an absent Git for the one provenance call; refuse every other process."""
    if args == ["git", "rev-parse", "HEAD"]:
        raise FileNotFoundError("git")
    raise AssertionError("external operation")


# The child interpreter cannot import tests until the CLI has set its module path.
BLOCK_PROCESS_HOOK = inspect.getsource(block_process) + "\nsubprocess.Popen = block_process\n"
