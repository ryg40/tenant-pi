"""Shared memory tutorials: a deterministic build, a self-contained page, the tutorials in order, example values only.

The browser tests are opt-in (`EXPLAINER_BROWSER_TESTS=1`): they need an existing Playwright and Chromium.
"""
import contextlib
import copy
import html
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import explainer_build  # noqa: E402
import publish_check  # noqa: E402
from scripts.doc_check import published  # noqa: E402

SOURCE = ROOT / explainer_build.SOURCE_REL
TUTORIALS = ROOT / explainer_build.TUTORIALS_REL
# The development-only values of one host. A portable snapshot has no such file.
LOCAL_VALUES = ROOT / "docs/architecture/local-values.json"
PEOPLE = {"alice": "Alice Archer", "bruno": "Bruno Brook", "chen": "Chen Cole", "dana": "Dana Dunn"}
PROJECTS = {"example-project", "example-site", "<projectId>"}
# Built at run time, so the published test file holds no complete canary.
CANARY = "-".join(("canary", "explainer", "private", "4f1c"))
TAG_ATTRIBUTE = re.compile(r"<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\s(src|href)\s*=\s*\"([^\"]*)\"")
# The value shapes of a live run. A frame with a live shape keeps the shape and takes an example value.
# A session id of Pi or Claude Code is a UUID; the examples have zeros in their first two groups.
UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
# A time of a record, a ledger line or a key file name, and a bare date. The examples are in March 2026.
TIMESTAMP = re.compile(r"\b(\d{4})-?(\d{2})-?(\d{2})T\d{2}:?\d{2}")
BARE_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b(?!T)")
POLICY_VERSION = "2012-10-17"
# A JSON field of a person: compact, escaped inside a hook string, or typed in the AWS CLI form.
PERSON_FIELD = re.compile(r'\b(actorId|approvedBy|rejectedBy|maintainer|projectId|host|session|session_id)\\*"\s*:\s*\\*"([^"\\]*)')
TYPED_FIELD = re.compile(r'"(actorId|approvedBy|rejectedBy|projectId|host|session)": \{</div>\s*<div class="ln out">\s*'
                         r'"stringValue": "([^"]*)"')
# The public hosts of the links. A remote of a frame is below example.com.
LINK_HOSTS = {"docs.aws.amazon.com", "bitwarden.com", "code.claude.com", "docs.claude.com"}


def sources():
    return sorted(path.relative_to(ROOT).as_posix() for path in SOURCE.rglob("*") if path.is_file())


def link_targets():
    """The relative link targets of the sources, without anchors."""
    found = set()
    for name in sources():
        text = (ROOT / name).read_text(encoding="utf-8")
        found |= {match.group(1).partition("#")[0] for match in re.finditer(r"\]\(([^)\s]+)\)", text)}
        if name.endswith("page.json"):
            found |= {link["target"].partition("#")[0] for link in json.loads(text)["links"]}
    return {target for target in found if target and not re.match(r"^[a-z][a-z0-9+.-]*:", target)}


def scratch_root(directory):
    """A minimal copy of the repository: the sources, the page and an empty file for each link target."""
    root = Path(directory)
    shutil.copytree(SOURCE, root / explainer_build.SOURCE_REL)
    shutil.copy2(ROOT / explainer_build.OUT_REL, root / explainer_build.OUT_REL)
    for target in link_targets():
        (root / target).parent.mkdir(parents=True, exist_ok=True)
        (root / target).touch()
    return root


def run_main(argv, root):
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        code = explainer_build.main(argv, root=root)
    return code, output.getvalue()


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = explainer_build.build(ROOT)
        cls.page, cls.tutorials = explainer_build.load(ROOT)

    def test_build_is_deterministic(self):
        self.assertEqual(self.text.encode("utf-8"), explainer_build.build(ROOT).encode("utf-8"))

    def test_committed_file_is_current(self):
        committed = (ROOT / explainer_build.OUT_REL).read_text(encoding="utf-8")
        self.assertEqual(committed, self.text, "run python3 scripts/explainer_build.py")
        self.assertEqual((0, "explainer current: EXPLAINER.html\n"), run_main(["--check"], ROOT))

    def test_check_fails_on_a_changed_source_and_passes_after_a_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_root(directory)
            self.assertEqual(0, run_main(["--check"], root)[0])
            first = root / explainer_build.TUTORIALS_REL / sorted(path.name for path in TUTORIALS.iterdir())[0]
            data = json.loads(first.read_text(encoding="utf-8"))
            data["goal"] += " Changed."
            first.write_text(json.dumps(data, indent=2), encoding="utf-8")
            self.assertEqual((1, "explainer differs: EXPLAINER.html\n"), run_main(["--check"], root))
            self.assertEqual(0, run_main([], root)[0])
            self.assertEqual(0, run_main(["--check"], root)[0])
            (root / explainer_build.CSS_REL).write_text("body{}\n", encoding="utf-8")
            self.assertEqual(1, run_main(["--check"], root)[0])

    def test_self_contained(self):
        for pattern in (r"<script\b", r"<link\b", r"@import", r"url\(", r"<iframe", r"<img\b", r"<object\b", r"<embed\b",
                        r"\bfetch\(", r"XMLHttpRequest", r"\bimport\("):
            self.assertIsNone(re.search(pattern, self.text, re.IGNORECASE), pattern)
        for tag, attribute, value in TAG_ATTRIBUTE.findall(self.text):
            if tag.lower() != "a":
                self.assertIsNone(re.match(r"^(?:https?:)?//", value), f"{tag} {attribute}")
            self.assertFalse(value.lower().startswith(("javascript:", "data:")), f"{tag} {attribute}")

    def test_every_tutorial_is_in_the_page_in_order(self):
        names = sorted(path.name for path in TUTORIALS.iterdir())
        self.assertEqual(8, len(names))
        self.assertEqual(len(names), self.text.count('<section class="tutorial"'))
        last = -1
        for number, name in enumerate(names, 1):
            title = json.loads((TUTORIALS / name).read_text(encoding="utf-8"))["title"]
            start = self.text.index(f'<section class="tutorial" id="tutorial-{number}"')
            heading = self.text.index(f'<h2 id="tutorial-{number}-title">{html.escape(title, quote=False)}</h2>')
            self.assertGreater(start, last, name)
            self.assertGreater(heading, start, name)
            self.assertIn(f'<a href="#tutorial-{number}">', self.text, name)
            last = heading

    def test_each_tutorial_ends_with_the_two_lists(self):
        for number, tutorial in enumerate(self.tutorials, 1):
            section = self.text.split(f'id="tutorial-{number}"', 1)[1].split("</section>", 1)[0]
            self.assertIn("<h3>What you learned</h3>", section, number)
            self.assertIn("<h3>What cannot happen</h3>", section, number)
            self.assertTrue(tutorial["learned"] and tutorial["cannot"], number)

    def test_the_four_example_people_and_no_other(self):
        for actor, name in PEOPLE.items():
            self.assertIn(name, self.text)
            self.assertIn(f"<code>{actor}</code>", self.text)
        self.assertLessEqual(set(re.findall(r"/actor/([a-z0-9-]+)/", self.text)), set(PEOPLE))
        # A key file name adds a time to the user name: pi-memory-person-<actorId>-<yyyymmddThhmmssZ>.
        users = re.findall(r"pi-memory-person-([a-z0-9-]+?)(?=-[0-9]{8}T[0-9]{6}Z|[^a-z0-9-]|$)", self.text)
        self.assertLessEqual(set(users), set(PEOPLE))
        self.assertLessEqual(set(re.findall(r"/project/([a-z0-9<>A-Z-]+)/", self.text)), PROJECTS)
        self.assertLessEqual(set(re.findall(r"/home/([a-z0-9-]+)/", self.text)), set(PEOPLE))
        self.assertLessEqual(set(re.findall(r"\b([a-z]+)@(?:laptop|desk)\b", self.text)), set(PEOPLE))

    def test_example_values_only(self):
        for value in re.findall(r"mem-[A-Za-z0-9_-]+", self.text):
            self.assertTrue(value.startswith("mem-EXAMPLE"), value)
        # The last group of an example session id has 12 digits too; the session rule checks it.
        accounts = re.findall(r"(?<![0-9])[0-9]{12}(?![0-9])", UUID.sub("", self.text))
        self.assertEqual({"123456789012"}, set(accounts))
        self.assertIsNone(re.search(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", self.text))
        self.assertIsNone(re.search(r"(?i)aws_secret_access_key\s*=\s*[A-Za-z0-9/+]{20,}", self.text))

    def test_session_ids_and_times_are_examples(self):
        for value in UUID.findall(self.text):
            self.assertTrue(value.startswith("00000000-0000-"), value)
        times = TIMESTAMP.findall(self.text)
        self.assertTrue(times)
        for year, month, _ in times:
            self.assertEqual(("2026", "03"), (year, month))
        self.assertEqual({POLICY_VERSION}, set(BARE_DATE.findall(self.text)))

    def test_fields_of_people_hold_example_values(self):
        people, projects = set(PEOPLE), PROJECTS - {"<projectId>"}
        fields = PERSON_FIELD.findall(self.text) + TYPED_FIELD.findall(self.text)
        self.assertTrue(fields)
        for name, value in fields:
            if name in ("actorId", "approvedBy", "rejectedBy", "maintainer"):
                self.assertIn(value, people, name)
            elif name == "projectId":
                self.assertIn(value, projects, name)
            elif name == "host":
                self.assertRegex(value, r"^(alice|bruno|chen|dana)-(laptop|desk)$")
            else:
                self.assertRegex(value, r"^00000000-0000-", name)
        for value in re.findall(r'projectId=\\*"([^"\\]*)', self.text):
            self.assertIn(value, projects)
        for value in re.findall(r"(?:person: |Handoff for |provision plan for |actorId=)([a-z0-9-]+)", self.text):
            self.assertIn(value, people)
        for option, value in re.findall(r"--(project|actor|person|owner) ([a-z0-9-]+)", self.text):
            self.assertIn(value, projects if option == "project" else people, option)
        for value in re.findall(r"--profile ([a-z0-9-]+)", self.text):
            self.assertRegex(value, r"^(example-admin|pi-memory-person-(alice|bruno|chen|dana))$")

    def test_prompts_hosts_and_paths_are_examples(self):
        prompts = re.findall(r'<span class="ps">([^<]*)</span>', self.text)
        self.assertTrue(prompts)
        for prompt in prompts:
            self.assertRegex(prompt, r"^(alice|bruno|chen|dana)@(laptop|desk):~[a-z/-]*\$$")
        for host in re.findall(r"https://([^/\"\s<]+)", self.text):
            self.assertTrue(host in LINK_HOSTS or host == "example.com" or host.endswith(".example.com"), host)
        self.assertEqual([], re.findall(r"(?<![\w.~-])/(?:opt|root|srv|mnt|var|tmp)/", self.text))

    def test_each_live_frame_names_its_round(self):
        frames = [step["frame"] for tutorial in self.tutorials for step in tutorial["steps"]]
        live = [frame for frame in frames if frame["live"]]
        self.assertTrue(live)
        for frame in live:
            self.assertRegex(frame["source"], r"^rounds? [0-9]", frame["title"])
            self.assertIn("of the live proof", frame["source"], frame["title"])
        self.assertEqual(len(live), self.text.count("Shape from a live run."))

    def test_no_private_canary_reaches_the_page(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_root(directory)
            for name in ("docs/architecture/local-values.json", ".local/host-values.deny",
                         ".local/agentcore-memory/registry.json", "docs/explainer/notes.local.md"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text(json.dumps({"values": {"canary": CANARY}}), encoding="utf-8")
            text = explainer_build.build(root)
        self.assertEqual(self.text, text)
        self.assertNotIn(CANARY, text)

    @unittest.skipUnless(LOCAL_VALUES.is_file(), "the local values file is development-only")
    def test_page_holds_no_local_value(self):
        for name, value in json.loads(LOCAL_VALUES.read_text(encoding="utf-8"))["values"].items():
            self.assertNotIn(value, self.text, name)

    def test_public_reader_rules(self):
        files = [explainer_build.OUT_REL, *sources()]
        for name in files:
            for number, line in enumerate((ROOT / name).read_text(encoding="utf-8").split("\n"), 1):
                for rule, pattern in publish_check.PUBLIC_RULES:
                    self.assertIsNone(pattern.search(line), f"{rule}: {name}:{number}")
        self.assertEqual([], publish_check.public_findings(files))

    def test_files_are_published(self):
        for name in (explainer_build.OUT_REL, "scripts/explainer_build.py", "tests/test_explainer_build.py", *sources()):
            self.assertIn(name, publish_check.PUBLISH)

    def test_links_point_into_the_publish_set(self):
        for tag, _, value in TAG_ATTRIBUTE.findall(self.text):
            if tag.lower() == "a" and not value.startswith("#") and not re.match(r"^[a-z][a-z0-9+.-]*:", value):
                self.assertTrue(published(value.partition("#")[0]), value)
            elif tag.lower() == "a" and value.startswith("#"):
                self.assertIn(f'id="{value[1:]}"', self.text, value)
            elif tag.lower() == "a":
                self.assertTrue(value.startswith("https://"), value)

    def test_not_verified_names_each_frame_without_a_live_run(self):
        section = self.text.split('<section id="not-verified"', 1)[1]
        rows = explainer_build.not_verified_rows(self.tutorials)
        frames = [step["frame"] for tutorial in self.tutorials for step in tutorial["steps"]]
        self.assertEqual(len([frame for frame in frames if not frame["live"]]), len(rows))
        for number, index, _, _ in rows:
            self.assertIn(f'<a href="#tutorial-{number}-step-{index}">{number}.{index}</a>', section)
        self.assertEqual(len(frames), self.text.count('<figure class="frame '))

    def test_glossary_holds_the_terms(self):
        terms = {entry["term"].lower() for entry in self.page["glossary"]}
        for term in ("namespace", "actor", "project", "proposal", "maintainer", "profile", "record"):
            self.assertIn(term, terms)
        self.assertIn('<section id="glossary"', self.text)


class RefusalTests(unittest.TestCase):
    def tutorial(self):
        return copy.deepcopy(explainer_build.load(ROOT)[1][0])

    def refused(self, rule, value):
        with self.assertRaisesRegex(explainer_build.BuildError, "^" + rule + ":") as ctx:
            explainer_build.check_tutorial(value, "t")
        self.assertNotIn(CANARY, str(ctx.exception))

    def test_an_unknown_key_is_refused(self):
        value = self.tutorial()
        value["extra"] = CANARY
        self.refused("unknown_key", value)

    def test_an_unknown_line_kind_is_refused(self):
        value = self.tutorial()
        value["steps"][0]["frame"]["lines"].append({"t": "script", "text": CANARY})
        self.refused("line_kind", value)

    def test_an_unknown_frame_kind_is_refused(self):
        value = self.tutorial()
        value["steps"][0]["frame"]["kind"] = "browser"
        self.refused("frame_kind", value)

    def test_a_missing_live_flag_is_refused(self):
        value = self.tutorial()
        del value["steps"][0]["frame"]["live"]
        self.refused("missing_key", value)

    def test_a_link_outside_the_repository_or_https_is_refused(self):
        for target, rule in (("javascript:alert(1)", "link_scheme"), ("http://example.com/", "link_scheme"),
                             ("docs/absent-file.md", "link_target"), ("../outside.md", "link_target"),
                             ("/etc/hosts", "link_target")):
            with self.assertRaisesRegex(explainer_build.BuildError, "^" + rule + ":"):
                explainer_build.inline(f"[label]({target})", "field", ROOT)

    def test_markup_in_a_source_is_escaped(self):
        self.assertEqual("&lt;b&gt;x&lt;/b&gt; <code>&lt;i&gt;</code>", explainer_build.inline("<b>x</b> `<i>`", "f", ROOT))
        self.assertEqual("&lt;script&gt;", explainer_build.mono("<script>"))

    def test_a_bad_tutorial_file_name_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = scratch_root(directory)
            (root / explainer_build.TUTORIALS_REL / "Extra Tutorial.json").write_text("{}", encoding="utf-8")
            code, output = run_main(["--check"], root)
        self.assertEqual(2, code)
        self.assertTrue(output.startswith("tutorial_name: "), output)


@unittest.skipUnless(os.environ.get("EXPLAINER_BROWSER_TESTS") == "1", "opt-in: existing Playwright and Chromium required")
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except Exception:
            cls.playwright.stop()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def test_rendered_page_offline_and_readable(self):
        for width, height in ((1440, 1000), (390, 844)):
            with self.subTest(width=width):
                context = self.browser.new_context(viewport={"width": width, "height": height}, reduced_motion="reduce")
                requests, errors = [], []

                def refuse(route):
                    requests.append(route.request.url)
                    route.abort()
                context.route(re.compile(r"^https?://"), refuse)
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto((ROOT / explainer_build.OUT_REL).as_uri())
                self.assertEqual(len(sorted(TUTORIALS.iterdir())), page.locator("section.tutorial").count())
                for target in page.locator("nav.toc a").evaluate_all("links => links.map((link) => link.hash.slice(1))"):
                    self.assertEqual(1, page.locator(f"#{target}").count(), target)
                self.assertFalse(page.evaluate("document.documentElement.scrollWidth > window.innerWidth"))
                wide = page.evaluate("[...document.querySelectorAll('figure.frame')].filter((f) => "
                                     "f.getBoundingClientRect().right > window.innerWidth + 1).length")
                self.assertEqual(0, wide)
                out = os.environ.get("EXPLAINER_SCREENSHOT_DIR")
                if out:
                    page.screenshot(path=str(Path(out) / f"explainer-{width}.png"), full_page=True)
                    if width == 1440:
                        for anchor in ("tutorial-2-step-3", "tutorial-3-step-2", "tutorial-4-step-4", "tutorial-6-step-5"):
                            page.locator(f"#{anchor}").screenshot(path=str(Path(out) / f"explainer-{anchor}.png"))
                self.assertEqual([], requests, "the page must stay offline")
                self.assertEqual([], errors)
                context.close()


if __name__ == "__main__":
    unittest.main()
