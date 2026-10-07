"""Unit tests for the job files, the configuration and the arguments. No Herdr server is needed.

Run: python3 -m unittest discover -s skills/herdr-relay/tests
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

SKILL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["HERDR_SKILL_HOME"] = os.path.join(os.path.dirname(SKILL), "herdr")
os.environ["HERDR_SKILL_STATE_DIR"] = tempfile.mkdtemp(prefix="herdr-relay-test-")

spec = importlib.util.spec_from_file_location("relay", os.path.join(SKILL, "scripts", "relay.py"))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)


class Jobs(unittest.TestCase):
    def run_job(self, command, cwd=None):
        job_dir = relay.new_job(cwd or tempfile.gettempdir(), command, 600, "w1:p1")
        p = subprocess.run(["bash", os.path.join(job_dir, "run.sh")], capture_output=True, text=True)
        return job_dir, p

    def test_output_and_exit_code_come_from_the_files(self):
        job_dir, p = self.run_job("echo out; echo err >&2; exit 3\n")
        self.assertEqual(relay.job_result(job_dir), (3, "out\nerr\n"))
        # The worker sees one short line, not the output.
        self.assertEqual(p.stdout.strip(), f"relay {os.path.basename(job_dir)} exit=3 bytes=8")
        self.assertEqual(p.returncode, 0)

    def test_command_runs_in_the_cwd_with_quotes_kept(self):
        cwd = tempfile.mkdtemp(prefix="relay it's ")
        job_dir, _ = self.run_job("pwd; printf '%s\\n' \"a b\" 'c $HOME'\n", cwd)
        self.assertEqual(relay.job_result(job_dir), (0, f"{os.path.realpath(cwd)}\na b\nc $HOME\n"))

    def test_second_run_of_a_job_does_not_run_the_command_again(self):
        marker = os.path.join(tempfile.mkdtemp(), "count")
        job_dir, _ = self.run_job(f"echo x >> {marker}\n")
        p = subprocess.run(["bash", os.path.join(job_dir, "run.sh")], capture_output=True, text=True)
        self.assertIn("ran before: exit=0", p.stdout)
        with open(marker) as f:
            self.assertEqual(f.read(), "x\n")

    def test_missing_cwd_gives_a_result_not_a_hang(self):
        job_dir = relay.new_job("/nonexistent-relay-dir", "echo no\n", 600, "w1:p1")
        subprocess.run(["bash", os.path.join(job_dir, "run.sh")], capture_output=True, text=True)
        code, out = relay.job_result(job_dir)
        self.assertNotEqual(code, 0)
        self.assertIn("nonexistent-relay-dir", out)

    def test_no_result_before_the_job_runs(self):
        job_dir = relay.new_job(tempfile.gettempdir(), "true\n", 600, "w1:p1")
        self.assertEqual(relay.job_result(job_dir), (None, ""))

    def test_prompt_names_one_command_and_shows_the_text(self):
        job_dir = relay.new_job("/tmp", "systemctl status x\n", 90, "w1:p1")
        with open(os.path.join(job_dir, "prompt.md")) as f:
            prompt = f.read()
        self.assertIn(f"bash {os.path.join(job_dir, 'run.sh')}", prompt)
        self.assertIn("systemctl status x", prompt)
        self.assertIn("timeout of 90 seconds", prompt)
        self.assertIn(f"RELAY {os.path.basename(job_dir)} NOT RUN", prompt)

    def test_old_jobs_are_removed(self):
        old = relay.new_job("/tmp", "true\n", 600, "w1:p1")
        new = relay.new_job("/tmp", "true\n", 600, "w1:p1")
        self.assertNotEqual(old, new)  # two jobs in the same second get two directories
        os.utime(old, (0, 0))
        relay.prune_jobs()
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(new))


class Config(unittest.TestCase):
    def test_no_file_means_no_model(self):
        cfg = relay.load_config("/nonexistent/relay.json")
        self.assertEqual(cfg, {"harness": "pi", "role": "worker", "model": None, "thinking": None})

    def test_machine_file_sets_the_worker_and_other_keys_are_dropped(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"model": "example-model", "thinking": "max", "comment": "x"}, f)
        cfg = relay.load_config(f.name)
        self.assertEqual((cfg["model"], cfg["thinking"], cfg["harness"]), ("example-model", "max", "pi"))
        self.assertNotIn("comment", cfg)

    def test_the_skill_stores_no_model_name(self):
        self.assertIsNone(relay.DEFAULTS["model"])
        self.assertIsNone(relay.DEFAULTS["thinking"])


class Arguments(unittest.TestCase):
    def test_run_options(self):
        o = relay.parse(["run", "--cmd", "ls -la", "--cwd", "/tmp", "--timeout", "90", "--reason", "denied"])
        self.assertEqual((o["action"], o["cmd"], o["cwd"], o["timeout"], o["reason"]),
                         ("run", "ls -la", "/tmp", 90, "denied"))

    def test_collect_takes_the_job(self):
        self.assertEqual(relay.parse(["collect", "20261004-120000-1"])["job"], "20261004-120000-1")

    def test_unknown_argument_fails(self):
        with self.assertRaises(SystemExit):
            relay.parse(["run", "--nope", "1"])
        with self.assertRaises(SystemExit):
            relay.parse(["run", "ls"])


if __name__ == "__main__":
    unittest.main()
