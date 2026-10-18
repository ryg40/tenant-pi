"""Shared test tiers. The default suite includes every release test."""
import os
import unittest

slow = unittest.skipIf(os.environ.get("TENANT_PI_TIER") == "fast", "release tier")
