"""Shared test tiers. The default suite includes every release test."""
import os
from pathlib import Path
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
