"""install.sh makes the installed path a link to the skill folder. It runs with a temporary HOME only.

Run: python3 -m unittest discover -s skills/herdr/tests
"""
import glob
import os
import subprocess
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def install(home):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home,
           "HERDR_SKILL_HOME": os.path.join(home, ".agents/skills/herdr"),
           "HERDR_RELAY_SKILL_HOME": os.path.join(home, ".agents/skills/herdr-relay")}
    return subprocess.run(["bash", os.path.join(SKILL, "install.sh")], env=env, capture_output=True, text=True, check=True).stdout


class InstallLink(unittest.TestCase):
    def test_the_installed_path_is_a_link_and_a_real_directory_moves_to_a_backup(self):
        with tempfile.TemporaryDirectory(prefix="herdr-install-test-") as home:
            dest = os.path.join(home, ".agents/skills/herdr")
            os.makedirs(dest)
            os.makedirs(os.path.join(home, ".pi/agent"))
            with open(os.path.join(dest, "note.txt"), "w", encoding="utf-8") as f:
                f.write("a user file")
            out = install(home)
            self.assertTrue(os.path.islink(dest))
            self.assertEqual(os.path.realpath(dest), os.path.realpath(SKILL))
            backups = glob.glob(dest + ".backup-*")
            self.assertEqual(len(backups), 1)
            self.assertIn(f"backup:  {backups[0]}", out)
            with open(os.path.join(backups[0], "note.txt"), encoding="utf-8") as f:
                self.assertEqual(f.read(), "a user file")
            self.assertEqual(os.path.realpath(os.path.join(home, ".pi/agent/skills/herdr")), os.path.realpath(SKILL))
            # A second run replaces the link and makes no new backup.
            self.assertNotIn("backup:", install(home))
            self.assertTrue(os.path.islink(dest))
            self.assertEqual(len(glob.glob(dest + ".backup-*")), 1)


if __name__ == "__main__":
    unittest.main()
