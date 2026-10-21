"""install.sh makes the installed path a link to the skill folder. It runs with a temporary HOME only.

Run: python3 -m unittest discover -s skills/herdr-relay/tests
"""
import glob
import os
import subprocess
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class InstallLink(unittest.TestCase):
    def test_the_installed_path_is_a_link_and_a_real_directory_moves_to_a_backup(self):
        with tempfile.TemporaryDirectory(prefix="herdr-relay-install-test-") as home:
            dest = os.path.join(home, ".agents/skills/herdr-relay")
            os.makedirs(dest)
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home,
                   "HERDR_SKILL_HOME": os.path.join(home, ".agents/skills/herdr"), "HERDR_RELAY_SKILL_HOME": dest}
            run = lambda: subprocess.run(["bash", os.path.join(SKILL, "install.sh")], env=env,  # noqa: E731
                                         capture_output=True, text=True, check=True)
            first = run()
            self.assertTrue(os.path.islink(dest))
            self.assertEqual(os.path.realpath(dest), os.path.realpath(SKILL))
            self.assertEqual(len(glob.glob(dest + ".backup-*")), 1)
            self.assertIn("the herdr skill is not installed", first.stderr)
            self.assertNotIn("backup:", run().stdout)


if __name__ == "__main__":
    unittest.main()
