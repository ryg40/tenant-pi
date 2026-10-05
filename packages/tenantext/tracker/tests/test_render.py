"""Renderer tests: determinism, reading order, escaping, template hooks, budgets."""

import contextlib
import io
import re
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

from tracker.__main__ import main
from tracker.brief import BUDGET_WARN, BriefError, default_brief_word_count, parse, validate
from tracker.render import DEFAULT_TEMPLATE, render

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "tracker-brief.md"
FIXTURE = ROOT / "tests" / "fixtures" / "prototype-fleet-72.md"
VOID = {"meta", "input", "br", "img", "hr", "link"}


def example_model():
    return parse(EXAMPLE.read_text(encoding="utf-8"))


class Outline(HTMLParser):
    """Walk the page and record where each element and text run sits.

    With every <details> closed, the default view shows text outside all
    details plus the <summary> of each outermost details.
    """

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.elements = []
        self.visible = []
        self.feed(html)

    def _details_depth(self):
        return sum(1 for tag, _ in self.stack if tag == "details")

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.elements.append({"tag": tag, "attrs": attrs, "details": self._details_depth()})
        if tag not in VOID:
            self.stack.append((tag, attrs))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        tags = [tag for tag, _ in self.stack]
        if {"script", "style", "title"} & set(tags):
            return
        if any("hidden" in attrs for _, attrs in self.stack):
            return
        depth = self._details_depth()
        if depth == 0:
            self.visible.append(data)
        elif depth == 1 and "summary" in tags:
            last_details = max(i for i, t in enumerate(tags) if t == "details")
            if "summary" in tags[last_details:]:
                self.visible.append(data)

    def find(self, cls=None, **data):
        out = []
        for el in self.elements:
            classes = el["attrs"].get("class", "").split()
            if cls and cls not in classes:
                continue
            if all(el["attrs"].get("data-" + k.replace("_", "-")) == v for k, v in data.items()):
                out.append(el)
        return out

    def visible_text(self):
        return " ".join(" ".join(self.visible).split())


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.model = example_model()
        self.html = render(self.model)
        self.outline = Outline(self.html)

    def test_deterministic(self):
        again = render(example_model())
        self.assertEqual(self.html, again)
        self.assertEqual(render(self.model), render(self.model))

    def test_section_order(self):
        marks = [
            'class="tb-header"',
            'id="tb-attention"',
            'data-card="position"',
            'data-card="changes"',
            'data-card="active"',
            'data-card="next"',
            'id="tb-more"',
            'id="tb-register"',
            'id="tb-gates"',
            'id="tb-unknowns"',
            'id="tb-backlog"',
            'id="tb-packets"',
            'id="tb-evidence-all"',
            'class="tb-footer"',
        ]
        positions = [self.html.index(m) for m in marks]
        self.assertEqual(positions, sorted(positions))

    def test_details_closed_by_default(self):
        self.assertNotRegex(self.html, r"<details[^>]*\sopen")
        details = self.outline.find(None)
        self.assertTrue([e for e in details if e["tag"] == "details"])

    def test_each_factual_card_has_evidence_details(self):
        summaries = re.findall(r"<summary>Evidence and details</summary>", self.html)
        # position + 3 changes + 3 active + recommended path + evidence-bearing gate and unknown
        self.assertEqual(len(summaries), 1 + 3 + 3 + 1 + 2)
        change = self.html[self.html.index('id="rec-chg-parser"'):]
        change = change[: change.index("</details></li>")]
        self.assertIn('href="https://git.example.com/owner/demo/pulls/1"', change)
        self.assertIn("<code>b2c3d4e</code> (not a link)", change)
        self.assertIn('data-kind="commit" data-confidence="verified"', change)
        self.assertIn("revision <code>e5f6a7b</code>", change)
        self.assertLess(change.index("tb-item-text"), change.index("<details"))

    def test_header_facts(self):
        header = self.html[: self.html.index("</header>")]
        for text in [
            '<a href="https://git.example.com/owner/demo" rel="noreferrer">owner/demo</a>',
            "<code>demo@a1b2c3d</code>",
            '<time datetime="2030-01-23T06:30:00Z">2030-01-23 06:30 UTC</time>',
            '<time datetime="2030-01-23T06:25:00Z">2030-01-23 06:25 UTC</time>',
            "Model synthesis",
            "Treat it as stale after",
            '<time datetime="2030-01-30">2030-01-30</time>',
        ]:
            self.assertIn(text, header)
        self.assertNotIn('data-notice="stale-evidence"', header)
        self.assertNotIn('data-notice="minimal"', header)

    def test_critical_items_stay_visible(self):
        visible = self.outline.visible_text()
        for gate in self.model["gates"]:
            if gate["kind"] == "approval":
                self.assertIn(gate["text"], visible)
        for unknown in self.model["unknowns"]:
            if unknown["severity"] == "critical":
                self.assertIn(unknown["text"], visible)
            else:
                self.assertNotIn(unknown["text"], visible)
        self.assertNotIn("Do not start follow-up paths", visible)  # forbidden gate sits in the full list

    def test_default_view_limits_and_collapsed_register(self):
        o = self.outline
        self.assertEqual(len([e for e in o.find("tb-item", record="change") if e["details"] == 0]), 3)
        self.assertEqual(len([e for e in o.find("tb-item", record="active") if e["details"] == 0]), 3)
        self.assertEqual(len([e for e in o.find("tb-path", role="recommended") if e["details"] == 0]), 1)
        self.assertEqual(len([e for e in o.find("tb-path", role="alternative") if e["details"] == 0]), 2)
        self.assertEqual([e for e in o.find("tb-path", role="backlog") if e["details"] == 0], [])
        rows = o.find("tb-issue")
        self.assertEqual(len(rows), 6)
        self.assertTrue(all(e["details"] >= 1 for e in rows))
        self.assertTrue(all(e["details"] >= 1 for e in o.find("tb-packet")))

    def test_register_keeps_state_and_progress_apart(self):
        o = self.outline
        rows = o.find("tb-issue")
        self.assertEqual([r["attrs"]["data-issue-state"] for r in rows], ["open"] * 5 + ["closed"])
        self.assertEqual(rows[0]["attrs"]["data-progress"], "in-progress")
        self.assertIn('<span class="tb-badge" data-issue-state="open">Open</span>', self.html)
        self.assertIn('<span class="tb-badge" data-progress="in-progress">In progress</span>', self.html)
        self.assertIn('<p id="tb-count" class="tb-count" aria-live="polite">6 of 6 issues shown</p>', self.html)
        self.assertIn('<p id="tb-empty" class="tb-empty" hidden>No matching issues.</p>', self.html)
        options = re.findall(r'<option value="([^"]*)">', self.html[self.html.index('id="tb-filter-workstream"'):])
        self.assertEqual(options[:5], ["*", "export", "input", "storage", "validation"])
        for element_id in ["tb-search", "tb-filter-state", "tb-filter-workstream", "tb-reset", "tb-count", "tb-empty"]:
            self.assertEqual(self.html.count(f'id="{element_id}"'), 1)

    def test_visual_states_are_distinct(self):
        model = example_model()
        model["issues"][5]["progress"] = "parked"
        html = render(model)
        for state, label in [
            ("completed", "Done"),
            ("active", "Active"),
            ("blocked", "Blocked"),
            ("parked", "Parked"),
            ("approval-gated", "Needs approval"),
        ]:
            self.assertIn(f'data-state="{state}"', html)
        for label in ["Done", "Active", "Needs approval"]:
            self.assertIn(f">{label}</span>", html)
        self.assertIn('id="rec-4" data-issue-state="open" data-progress="implemented" data-workstream="export" data-state="blocked"', html)
        self.assertIn('id="rec-7" data-issue-state="open" data-progress="parked" data-workstream="input" data-state="parked"', html)

    def test_escaping(self):
        model = example_model()
        model["changes"][0]["title"] = '<script>alert("x")</script>'
        model["issues"][0]["workstream"] = 'a"b<c>'
        model["gates"][1]["text"] = "Approve & <b>bold</b> 'quoted'"
        model["title"] = "Brief @@BODY@@ <i>x</i>"
        html = render(model)
        self.assertEqual(html.count("<script"), 1)  # only the template script
        self.assertIn("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;", html)
        self.assertIn('data-workstream="a&quot;b&lt;c&gt;"', html)
        self.assertIn("Approve &amp; &lt;b&gt;bold&lt;/b&gt; &#x27;quoted&#x27;", html)
        self.assertIn("<title>Brief @@BODY@@ &lt;i&gt;x&lt;/i&gt;</title>", html)
        self.assertEqual(html.count("<main>"), 1)

    def test_only_safe_links(self):
        hrefs = re.findall(r'href="([^"]*)"', self.html)
        self.assertTrue(hrefs)
        for href in hrefs:
            self.assertTrue(href.startswith("https://") or href.startswith("#"), href)
        self.assertNotIn('href="b2c3d4e"', self.html)
        self.assertNotIn('href="tracker/schema.md"', self.html)

    def test_self_contained_and_csp_safe(self):
        lowered = self.html.lower()
        for bad in ["<link", "<iframe", "<form", "<img", " src=", "fetch(", "xmlhttprequest", "http://", "@import", "url(", "websocket", "eventsource"]:
            self.assertNotIn(bad, lowered)

    def test_minimal_synthesis_is_labelled(self):
        model = example_model()
        model["meta"]["synthesis"] = "minimal"
        html = render(model)
        self.assertIn('data-synthesis="minimal"', html)
        self.assertIn("Minimal: scripted facts only", html)
        self.assertIn('data-notice="minimal"', html)
        self.assertIn('data-notice="minimal-paths"', html)
        visible = Outline(html).visible_text()
        self.assertIn("Minimal brief: scripted facts only.", visible)

    def test_static_stale_notices(self):
        model = example_model()
        model["meta"]["evidence_checked"] = "2030-01-10T06:00:00Z"
        model["issues"][0]["checked"] = "2030-01-01T00:00:00Z"
        model["evidence"][0]["checked"] = "2030-01-01T00:00:00Z"
        html = render(model)
        self.assertIn('data-notice="stale-evidence">Evidence was last checked 13 days before this snapshot.', html)
        self.assertIn('data-notice="stale-issues">1 issue records were checked more than 7 days', html)
        self.assertIn('data-stale="true"', html)
        self.assertEqual(html, render(model))

    def test_invalid_model_is_refused(self):
        model = example_model()
        model["issues"][0]["url"] = "javascript:alert(1)"
        with self.assertRaises(BriefError):
            render(model)

    def test_custom_template(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.html"
            path.write_text("<!doctype html><title>@@TITLE@@</title><div>@@BODY@@</div>")
            html = render(self.model, template=path)
            self.assertTrue(html.startswith("<!doctype html><title>Demo restart brief</title><div><header"))
            path.write_text("<div>@@BODY@@</div><h1>@@TITLE@@</h1>")
            self.assertTrue(render(self.model, template=path).endswith("</div><h1>Demo restart brief</h1>"))
            for bad in ["no markers", "@@TITLE@@ @@BODY@@ @@BODY@@", "@@BODY@@"]:
                path.write_text(bad)
                with self.assertRaises(ValueError):
                    render(self.model, template=path)

    def test_schema_documents_every_hook(self):
        model = example_model()
        model["meta"]["synthesis"] = "minimal"
        model["meta"]["evidence_checked"] = "2030-01-01T00:00:00Z"
        model["issues"][0]["checked"] = "2030-01-01T00:00:00Z"
        body = self.html + render(model) + render(parse(FIXTURE.read_text(encoding="utf-8")))
        body = body[body.index("<main>"): body.index("</main>")]
        doc = (ROOT / "schema.md").read_text(encoding="utf-8")
        classes = {c for group in re.findall(r'class="([^"]*)"', body) for c in group.split()}
        attrs = set(re.findall(r"\s(data-[a-z-]+)=", body))
        ids = {i for i in re.findall(r'\sid="([^"]*)"', body) if not i.startswith(("rec-", "packet-", "tb-card-"))}
        notices = set(re.findall(r'data-notice="([^"]*)"', body))
        for name in sorted(classes | attrs | ids | notices):
            self.assertTrue(f"`{name}`" in doc, f"{name} is missing from schema.md HTML hooks")

    def test_default_template_markers(self):
        text = DEFAULT_TEMPLATE.read_text()
        self.assertEqual(text.count("@@TITLE@@"), 1)
        self.assertEqual(text.count("@@BODY@@"), 1)


class HandoffRenderTests(unittest.TestCase):
    """The Next session card shows the stored prompt with a copy button."""

    def setUp(self):
        self.model = example_model()
        self.html = render(self.model)
        self.card = self.html[self.html.index('id="tb-card-next"'):self.html.index("</section>", self.html.index('id="tb-card-next"'))]

    def test_button_status_and_closed_details(self):
        card = self.card
        self.assertIn(
            '<button type="button" class="tb-copy" data-copy-target="tb-handoff-text">'
            "Copy prompt for the next session</button>", card)
        self.assertIn('<span class="tb-copy-status" id="tb-copy-status" role="status" aria-live="polite"></span>', card)
        self.assertIn('<details class="tb-handoff"><summary>Show the prompt</summary>'
                      '<pre class="tb-handoff-text" id="tb-handoff-text">', card)
        self.assertEqual(self.html.count('id="tb-handoff-text"'), 1)
        self.assertEqual(self.html.count('class="tb-copy"'), 1)

    def test_placement_under_the_recommended_path(self):
        card = self.card
        self.assertLess(card.index('id="rec-path-merge-storage"'), card.index('class="tb-next-prompt"'))
        self.assertLess(card.index('class="tb-next-prompt"'), card.index('class="tb-alt-h"'))

    def test_prompt_is_collapsed_but_the_button_is_visible(self):
        outline = Outline(self.html)
        visible = outline.visible_text()
        self.assertIn("Copy prompt for the next session", visible)
        self.assertIn("Show the prompt", visible)
        self.assertNotIn("You coordinate the next work session", visible)
        [pre] = [e for e in outline.elements if e["tag"] == "pre"]
        self.assertEqual(pre["details"], 1)

    def test_stored_text_is_escaped_verbatim(self):
        model = example_model()
        model["handoffs"][0]["text"] = 'Line <script>alert("x")</script> & \'q\'\n\n  indented </pre> line'
        html = render(model)
        self.assertEqual(html.count("<script"), 1)
        self.assertIn(
            '<pre class="tb-handoff-text" id="tb-handoff-text">Line &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; '
            "&amp; &#x27;q&#x27;\n\n  indented &lt;/pre&gt; line</pre>", html)

    def test_renderer_reads_only_the_stored_record(self):
        model = example_model()
        model["handoffs"][0]["text"] = "Only the stored prompt."
        model["paths"][0]["objective"] = "A changed objective that no prompt was built from."
        html = render(model)
        self.assertIn('id="tb-handoff-text">Only the stored prompt.</pre>', html)

    def test_basis_and_source_labels(self):
        self.assertIn('class="tb-next-prompt" data-basis="current" data-source="generated"', self.card)
        self.assertIn('<span class="tb-badge" data-basis="current">Checked at this snapshot</span>', self.card)
        self.assertIn('<span class="tb-badge" data-source="generated">Generated from the brief</span>', self.card)
        self.assertIn('As of <time datetime="2030-01-23T06:30:00Z">', self.card)
        model = example_model()
        model["handoffs"][0].update(basis="carried-forward", source="owner")
        html = render(model)
        self.assertIn('<span class="tb-badge" data-basis="carried-forward">Carried forward, not re-checked</span>', html)
        self.assertIn('<span class="tb-badge" data-source="owner">Written by the owner</span>', html)
        self.assertIn("Carried forward, not re-checked", Outline(html).visible_text())

    def test_no_prompt_without_a_recommended_path(self):
        model = example_model()
        model["paths"][0]["role"] = "backlog"
        model["handoffs"] = []
        html = render(model)
        self.assertNotIn("tb-copy", html[html.index("<main>"):html.index("</main>")])
        self.assertNotIn('id="tb-handoff-text"', html)

    def test_minimal_brief_shows_the_carried_forward_prompt(self):
        from tracker.handoff import refresh

        model = example_model()
        model["meta"]["synthesis"] = "minimal"
        html = render(refresh(model, basis="carried-forward"))
        self.assertIn('data-basis="carried-forward"', html)
        self.assertIn("Carried forward: this path comes from an earlier brief", html)


class PrototypeFixtureTests(unittest.TestCase):
    """The 72-issue, 18-path fixture fits the restart-brief budget."""

    def setUp(self):
        self.text = FIXTURE.read_text(encoding="utf-8")
        self.model = parse(self.text)

    def test_fixture_is_valid_and_within_budget(self):
        self.assertEqual([d for d in validate(self.model) if d.level == "error"], [])
        self.assertEqual(len(self.model["issues"]), 72)
        self.assertEqual(len(self.model["paths"]), 18)
        self.assertLessEqual(default_brief_word_count(self.model), BUDGET_WARN)
        self.assertEqual(sum(row["state"] == "open" for row in self.model["issues"]), 33)
        self.assertEqual(sum(row["state"] == "closed" for row in self.model["issues"]), 39)
        self.assertEqual(
            [len(path["issues"]) for path in self.model["paths"]],
            [1, 6, 6, 1, 2, 2, 2, 2, 3, 3, 1, 1, 2, 2, 2, 1, 1, 3],
        )
        streams = [row["workstream"] for row in self.model["issues"]]
        self.assertEqual(streams, ["interface"] * 21 + ["other"] * 51)

    def test_default_view_stays_short(self):
        outline = Outline(render(self.model))
        top = lambda cls, **kw: [e for e in outline.find(cls, **kw) if e["details"] == 0]  # noqa: E731
        self.assertLessEqual(len(top("tb-item", record="change")), 3)
        self.assertLessEqual(len(top("tb-item", record="active")), 3)
        self.assertEqual(len(top("tb-path", role="recommended")), 1)
        self.assertEqual(len(top("tb-path", role="alternative")), 2)
        self.assertEqual(top("tb-path", role="backlog"), [])
        rows = outline.find("tb-issue")
        self.assertEqual(len(rows), 72)
        self.assertTrue(all(e["details"] == 1 for e in rows))
        self.assertEqual(len([e for e in outline.find("tb-packet") if e["details"] == 1]), 18)
        self.assertLessEqual(len(outline.visible_text().split()), 450)

    def test_fixture_is_sanitized(self):
        urls = re.findall(r"https?://\S+", self.text)
        self.assertEqual(len(re.findall(r"^url: https://\S+/issues/\d+$", self.text, re.M)), 72)
        for url in urls:
            self.assertTrue(url.startswith("https://git.example.com/owner/demo"), url)
        self.assertEqual(self.model["meta"]["repo"], "owner/demo")
        self.assertEqual(self.model["meta"]["snapshot"], "2030-01-23T06:00:00Z")
        self.assertEqual(
            [row["url"] for row in self.model["issues"]],
            [f"https://git.example.com/owner/demo/issues/{n}" for n in range(1, 73)],
        )
        ids = [row["id"] for row in self.model["issues"]]
        self.assertEqual(ids, [str(n) for n in range(1, 73)])
        for row in self.model["issues"]:
            self.assertEqual(row["id"], row["url"].rsplit("/", 1)[1])
        for path in self.model["paths"]:
            for reference in path["issues"]:
                self.assertIn(reference.lstrip("#"), ids)
        self.assertNotRegex(self.text.lower(), r"fleet|prototype")
        self.assertEqual(self.model["evidence"][0]["id"], "ev-register-snapshot")
        for evidence in self.model["evidence"]:
            if evidence["kind"] == "file":
                self.assertTrue((ROOT.parent / evidence["ref"]).is_file(), evidence["ref"])


class CliRenderTests(unittest.TestCase):
    def test_render_writes_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "sub" / "brief.html"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["render", str(EXAMPLE), str(out)]), 0)
            self.assertEqual(out.read_text(encoding="utf-8"), render(example_model()))
            template = Path(tmp) / "t.html"
            template.write_text("<title>@@TITLE@@</title>@@BODY@@")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["render", str(EXAMPLE), str(out), "--template", str(template)]), 0)
            self.assertTrue(out.read_text().startswith("<title>Demo restart brief</title><header"))
            template.write_text("no markers")
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(main(["render", str(EXAMPLE), str(out), "--template", str(template)]), 1)
            self.assertIn("error [template]", err.getvalue())

    def test_render_refuses_invalid_brief(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.md"
            bad.write_text(EXAMPLE.read_text().replace("ref: tracker/schema.md", "ref: javascript:alert(1)"))
            out = Path(tmp) / "out.html"
            with contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(main(["render", str(bad), str(out)]), 1)
            self.assertIn("[url-unsafe]", err.getvalue())
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
