"""Scripted fact collection: Git facts from temp repos, issues from a fake Gitea API."""
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from tracker import collect


def _support():
    name = "tracker_pipeline_support"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, Path(__file__).resolve().parent / "fixtures" / "pipeline_support.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


S = _support()
CANARY = "CANARY-GITEA-TOKEN-7f3a9c"


class IdentityTests(unittest.TestCase):
    def test_remote_identity_drops_credentials(self):
        got = collect.remote_identity("https://user:secret@git.example.com/owner/demo.git")
        self.assertEqual(got["repo"], "owner/demo")
        self.assertEqual(got["repo_url"], "https://git.example.com/owner/demo")
        self.assertNotIn("secret", json.dumps(got))

    def test_remote_identity_ssh_forms(self):
        for url in ("git@git.example.com:owner/demo.git", "ssh://git@git.example.com:2222/owner/demo.git"):
            got = collect.remote_identity(url)
            self.assertEqual(got["repo"], "owner/demo", url)
            self.assertTrue(got["repo_url"].startswith("https://git.example.com"), url)

    def test_safe_https_url(self):
        self.assertEqual(collect.safe_https_url("https://git.example.com/x"), "https://git.example.com/x")
        for bad in ("http://git.example.com/x", "https://a:b@git.example.com/x", "javascript:alert(1)", None):
            self.assertIsNone(collect.safe_https_url(bad))

    def test_parse_ref_and_slug(self):
        self.assertEqual(collect.parse_ref("main@a1b2c3d"), ("main", "a1b2c3d"))
        self.assertEqual(collect.parse_ref("feature/x@abc1234"), ("feature/x", "abc1234"))
        self.assertEqual(collect.repo_slug("Owner/Demo.Repo"), "owner-demo-repo")


class GitFactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = S.make_repo(Path(self.tmp.name) / "repo", 20, merge_every=5)
        self.git = collect.git_runner(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_commits_since_previous_ref_are_exact_and_bounded(self):
        base = S.head_short(self.repo)
        S.add_commits(self.repo, 40, start=S.EPOCH + timedelta(days=5), prefix="Later")
        facts = collect.collect_git(self.git, repo_url=S.REPO_URL, previous_ref="main@" + base, max_commits=10)
        self.assertEqual(facts["base_source"], "previous ref")
        self.assertEqual(facts["commit_count"], 40)
        self.assertEqual(len(facts["commits"]), 10)
        self.assertTrue(facts["commits_truncated"])
        self.assertTrue(all(c["subject"].startswith("Later") for c in facts["commits"]))
        self.assertTrue(facts["commits"][0]["url"].startswith(S.REPO_URL + "/commit/"))
        self.assertEqual(facts["ref"], "main@" + S.head_short(self.repo))
        self.assertGreater(facts["changed_files"]["count"], 0)
        self.assertEqual(facts["branches"][0]["name"], "main")
        self.assertEqual(facts["worktrees"][0]["branch"], "main")

    def test_falls_back_to_snapshot_time_when_ref_is_unknown(self):
        facts = collect.collect_git(self.git, repo_url=S.REPO_URL, previous_ref="main@0000000",
                                    previous_snapshot=S.iso(S.EPOCH + timedelta(hours=9, minutes=30)))
        self.assertEqual(facts["base_source"], "previous snapshot time")
        self.assertTrue(0 < facts["commit_count"] < 24)

    def test_no_previous_brief_lists_recent_commits(self):
        facts = collect.collect_git(self.git, repo_url=S.REPO_URL, max_commits=5)
        self.assertEqual(facts["base_source"], "none")
        self.assertEqual(len(facts["commits"]), 5)
        self.assertTrue(any(c["merge"] for c in collect.collect_git(self.git, repo_url=S.REPO_URL)["commits"]))

    def test_uncommitted_files_are_counted(self):
        (self.repo / "new.txt").write_text("x")
        facts = collect.collect_git(self.git, repo_url=S.REPO_URL)
        self.assertEqual(facts["uncommitted"]["count"], 1)


class IssueFactsTests(unittest.TestCase):
    def items(self):
        rows = [S.issue(n, updated=S.EPOCH + timedelta(minutes=n)) for n in range(1, 121)]
        rows += [S.issue(200 + n, state="closed", updated=S.EPOCH + timedelta(days=n)) for n in range(1, 11)]
        rows += [S.issue(300 + n, pr=True, updated=S.EPOCH + timedelta(days=1)) for n in range(1, 31)]
        return rows

    def test_pagination_excludes_pull_requests_and_uses_since(self):
        api = S.FakeIssueAPI(self.items())
        since = S.iso(S.EPOCH + timedelta(days=6))
        result = collect.collect_issues(S.API, S.REPO, token=CANARY, since=since, repo_url=S.REPO_URL,
                                        http_get=api, page_size=50, max_pages=10)
        numbers = {i["number"] for i in result["items"]}
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len([n for n in numbers if n < 200]), 120, "all open issues")
        self.assertEqual({n for n in numbers if 200 < n < 300}, set(range(206, 211)), "closed since the checkpoint")
        self.assertFalse(any(n > 300 for n in numbers), "pull requests are excluded")
        closed_calls = [u for u, _ in api.calls if "state=closed" in u]
        self.assertTrue(all("since=" in u and "type=issues" in u for u in closed_calls))
        self.assertTrue(all(h.get("Authorization") == "token " + CANARY for _, h in api.calls))
        self.assertTrue(all(CANARY not in u for u, _ in api.calls), "the token never goes in a URL")
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertTrue(all(i["url"].startswith(S.REPO_URL + "/issues/") for i in result["items"]))

    def test_page_count_is_bounded(self):
        api = S.FakeIssueAPI(self.items())
        result = collect.collect_issues(S.API, S.REPO, repo_url=S.REPO_URL, http_get=api, page_size=20, max_pages=2)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(result["pages_read"], 4)
        self.assertLessEqual(len(api.calls), 4)

    def test_not_configured_and_errors_are_labeled(self):
        result = collect.collect_issues(None, S.REPO)
        self.assertEqual(result["status"], "not-configured")
        failing = S.FakeIssueAPI([], fail_status=500)
        result = collect.collect_issues(S.API, S.REPO, token=CANARY, http_get=failing)
        self.assertEqual(result["status"], "error")
        self.assertIn("HTTP 500", result["error"])
        broken = S.FakeIssueAPI([], raise_error=collect.CollectError("issue API not reachable: " + CANARY))
        result = collect.collect_issues(S.API, S.REPO, token=CANARY, http_get=broken)
        self.assertEqual(result["status"], "error")
        self.assertNotIn(CANARY, json.dumps(result))
        result = collect.collect_issues("http://git.example.com/api/v1", S.REPO, http_get=failing)
        self.assertEqual(result["status"], "error")

    def test_facts_packet(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = S.make_repo(Path(tmp) / "repo", 3)
            facts = collect.collect_facts(git=collect.git_runner(repo), repo=S.REPO, repo_url=S.REPO_URL,
                                          previous_ref=None, previous_snapshot=None, issues_api=S.API,
                                          token=CANARY, http_get=S.FakeIssueAPI(self.items()[:3]), now=S.EPOCH)
            self.assertEqual(facts["schema"], collect.FACTS_SCHEMA)
            self.assertEqual(facts["collected"], S.iso(S.EPOCH))
            self.assertEqual(facts["git"]["checked"], S.iso(S.EPOCH))
            self.assertEqual(facts["issues"]["checked"], S.iso(S.EPOCH))
            self.assertNotIn(CANARY, json.dumps(facts))


if __name__ == "__main__":
    unittest.main()
