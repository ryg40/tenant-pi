"""Architecture diagrams: a deterministic public build, the public reader rules, and a complete graph.

The local edition is development-only. Its tests run only when its values file is present, so a
portable snapshot skips them.
"""
import copy
import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import architecture_build  # noqa: E402
import publish_check  # noqa: E402
from scripts.doc_check import published  # noqa: E402

LOCAL = ROOT / architecture_build.LOCAL_REL
PUBLIC_FILES = (architecture_build.PUBLIC_OUT, architecture_build.MODEL_REL, "docs/architecture.md")
# A placeholder left in the page. The test keeps its own pattern, so a narrow build pattern cannot hide a leak.
LEAK = re.compile(r"\{\{[a-z0-9_]+\}\}")


def encoded(value):
    """A value as the build writes it into the JSON data of the page."""
    text = json.dumps(value, ensure_ascii=True)[1:-1]
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def editions():
    yield "public", architecture_build.build(ROOT)
    if LOCAL.is_file():
        yield "local", architecture_build.build(ROOT, local=True)


class PublicBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph = architecture_build.build(ROOT)
        cls.text = architecture_build.render(cls.graph)

    def test_build_is_deterministic(self):
        self.assertEqual(self.text, architecture_build.render(architecture_build.build(ROOT)))

    def test_committed_file_is_current(self):
        committed = (ROOT / architecture_build.PUBLIC_OUT).read_text(encoding="utf-8")
        self.assertEqual(committed, self.text, "run python3 scripts/architecture_build.py")

    def test_self_contained(self):
        for pattern in (r"<script[^>]*\ssrc=", r"<link\b", r"@import", r"\bfetch\(", r"XMLHttpRequest",
                        r"url\(\s*['\"]?https?:", r"\bimport\(", r"<iframe", r"<img\b"):
            self.assertIsNone(re.search(pattern, self.text), pattern)

    def test_public_reader_rules(self):
        for number, line in enumerate(self.text.split("\n"), 1):
            for rule, pattern in publish_check.PUBLIC_RULES:
                self.assertIsNone(pattern.search(line), f"{rule}: line {number}")
        self.assertEqual([], publish_check.public_findings(list(PUBLIC_FILES)))

    def test_no_placeholder_token_left(self):
        self.assertIsNone(LEAK.search(self.text))

    def test_public_files_are_published(self):
        for name in (*PUBLIC_FILES, "scripts/architecture_build.py", "tests/test_architecture_build.py"):
            self.assertIn(name, publish_check.PUBLISH)

    def test_links_point_into_the_publish_set(self):
        for view in self.graph["views"]:
            for node in view["nodes"]:
                for path in node.get("files", []) + [node.get("doc", ""), node.get("script", "")]:
                    if architecture_build.is_repo_path(path):
                        self.assertTrue(published(path.partition("#")[0]), f"{view['id']}.{node['id']}")


class GraphTests(unittest.TestCase):
    def test_every_edge_points_to_a_node(self):
        for edition, graph in editions():
            for view in graph["views"]:
                ids = {node["id"] for node in view["nodes"]}
                for edge in view["edges"]:
                    self.assertIn(edge["from"], ids, f"{edition}.{view['id']}")
                    self.assertIn(edge["to"], ids, f"{edition}.{view['id']}")

    def test_every_view_has_a_node(self):
        for edition, graph in editions():
            self.assertEqual([view["id"] for view in graph["views"][:5]],
                             ["overview", "profile", "runtime", "memory", "components"])
            for view in graph["views"]:
                self.assertTrue(view["nodes"], f"{edition}.{view['id']}")

    def test_every_tour_step_points_to_a_node(self):
        for edition, graph in editions():
            nodes = {(view["id"], node["id"]) for view in graph["views"] for node in view["nodes"]}
            for step in graph["tour"]:
                self.assertIn((step["view"], step["node"]), nodes, edition)

    def test_components_view_holds_each_manifest_component(self):
        manifest = json.loads((ROOT / "config/manifest.json").read_text(encoding="utf-8"))["components"]
        graph = architecture_build.build(ROOT)
        view = next(view for view in graph["views"] if view["id"] == "components")
        nodes = {node["component"]: node for node in view["nodes"] if "component" in node}
        self.assertEqual(sorted(manifest), sorted(nodes))
        for cid, node in nodes.items():
            self.assertEqual(manifest[cid]["status"], node["status"], cid)

    def test_nodes_stay_inside_their_group(self):
        for edition, graph in editions():
            for view in graph["views"]:
                groups = {group["id"]: group for group in view["groups"]}
                for node in view["nodes"]:
                    group = groups[node["group"]]
                    self.assertTrue(group["x"] <= node["x"] and node["x"] + node["w"] <= group["x"] + group["w"]
                                    and group["y"] <= node["y"] and node["y"] + node["h"] <= group["y"] + group["h"],
                                    f"{edition}.{view['id']}.{node['id']}")

    def test_a_dangling_edge_is_refused(self):
        graph = copy.deepcopy(architecture_build.build(ROOT))
        graph["views"][0]["edges"].append({"from": graph["views"][0]["nodes"][0]["id"], "to": "absent-node"})
        with self.assertRaisesRegex(architecture_build.BuildError, "^edge_endpoint: "):
            architecture_build.check(graph, ROOT)

    def test_an_unknown_placeholder_is_refused(self):
        with self.assertRaisesRegex(architecture_build.BuildError, "^unknown_placeholder: absent$"):
            architecture_build.substitute({"text": "{{absent}}"}, {})

    def test_a_placeholder_name_can_hold_digits(self):
        self.assertEqual({"seat_2"}, architecture_build.tokens(["a {{seat_2}} b"]))
        self.assertEqual("a x b", architecture_build.substitute("a {{seat_2}} b", {"seat_2": "x"}))
        self.assertIsNotNone(LEAK.search("{{seat_2}}"))

    def test_a_group_sets_the_width_of_its_nodes(self):
        view = {"id": "v", "groups": [{"id": "g", "x": 0, "y": 0, "cols": 2, "nodeW": 250}],
                "nodes": [{"id": "a", "group": "g"}, {"id": "b", "group": "g"}]}
        architecture_build.layout(view)
        self.assertEqual([250, 250], [node["w"] for node in view["nodes"]])
        self.assertEqual(2 * 250 + architecture_build.GAP_X + 2 * architecture_build.PAD, view["groups"][0]["w"])

    def test_an_unknown_planned_value_is_refused(self):
        with self.assertRaisesRegex(architecture_build.BuildError, "^local_planned_unknown: absent$"):
            architecture_build.merge_local({"views": [], "tour": []}, {"values": {}, "planned": ["absent"]})


def script_function(name):
    """The body of one top-level function of the page script."""
    match = re.search(r"\n  function " + name + r"\([^)]*\) \{\n(.*?)\n  \}\n", architecture_build.JS, re.S)
    if match is None:
        raise AssertionError(f"function {name} not found in the page script")
    return match.group(1)


class PageScriptTests(unittest.TestCase):
    """The page script needs a browser. These tests read its source and the graph data that it uses."""

    def test_path_finder_reports_a_missing_path(self):
        view = next(view for view in architecture_build.build(ROOT)["views"] if view["id"] == "components")
        reach, todo = {"anthropic-usage"}, ["anthropic-usage"]
        while todo:
            current = todo.pop()
            for edge in view["edges"]:
                for one, other in ((edge["from"], edge["to"]), (edge["to"], edge["from"])):
                    if one == current and other not in reach:
                        reach.add(other)
                        todo.append(other)
        self.assertNotIn("codex-accounts", reach, "the case of the review needs two nodes without a path")
        body = script_function("runPath")
        self.assertIn("if (!state.path) {", body)
        self.assertIn('"No path from " + name(from) + " to " + name(to) + " in this view."', body)
        self.assertNotIn("!p.nodes", script_function("showPathResult"))

    def test_a_view_change_ends_the_tour(self):
        self.assertIn("endTour();", script_function("setView"))
        self.assertIn("onclick: () => setView(v.id)", architecture_build.JS)

    def test_labels_and_titles_are_fitted_by_measure(self):
        body = script_function("render")
        self.assertNotIn("clip(n.label", body)
        self.assertIn("fitText(label, n.label,", body)
        self.assertIn("fitTitle(title, grp.label.toUpperCase(), grp.w - 36)", body)
        self.assertIn('s("title", null, n.label', body)


@unittest.skipUnless(LOCAL.is_file(), "the local values file is development-only")
class LocalBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.values = json.loads(LOCAL.read_text(encoding="utf-8"))["values"]
        cls.local = architecture_build.render(architecture_build.build(ROOT, local=True))
        cls.public = architecture_build.render(architecture_build.build(ROOT))

    def test_local_build_contains_each_value(self):
        for name, value in self.values.items():
            self.assertIn(encoded(value), self.local, name)

    def test_public_build_holds_no_local_value(self):
        for name, value in self.values.items():
            self.assertNotIn(value, self.public, name)
            self.assertNotIn(encoded(value), self.public, name)

    def test_local_build_is_deterministic_and_current(self):
        self.assertEqual(self.local, architecture_build.render(architecture_build.build(ROOT, local=True)))
        out = ROOT / architecture_build.LOCAL_OUT
        if out.is_file():
            self.assertEqual(out.read_text(encoding="utf-8"), self.local, "run python3 scripts/architecture_build.py --local")

    def test_a_planned_value_is_tagged(self):
        planned = json.loads(LOCAL.read_text(encoding="utf-8")).get("planned", [])
        self.assertIn("seat_address", planned)
        graph = architecture_build.build(ROOT, local=True)
        tagged = {node["id"] for view in graph["views"] for node in view["nodes"]
                  if architecture_build.PLANNED_TAG in node.get("tags", [])}
        self.assertIn("r-ssh", tagged)
        self.assertNotIn(architecture_build.PLANNED_TAG, self.public)

    def test_local_files_are_development_only(self):
        entries = publish_check.private_excludes(ROOT)
        for name in (architecture_build.LOCAL_REL, architecture_build.LOCAL_OUT):
            self.assertTrue(publish_check.excluded_files({name}, entries), name)
            self.assertNotIn(name, publish_check.PUBLISH)


class RuntimeContractTests(unittest.TestCase):
    def test_default_view_is_runtime_not_install_pipeline(self):
        graph = architecture_build.build(ROOT)
        view = graph["views"][0]
        ids = {node["id"] for node in view["nodes"]}
        self.assertLessEqual(len(ids), 12)
        self.assertTrue({"terminal", "herdr", "pi", "modules", "profile-state", "models", "remote-memory"} <= ids)
        self.assertFalse({"manifest", "validate", "plan", "generate"} & ids)
        self.assertEqual({"account", "endpoints"}, {b["id"] for b in view["boundaries"]})

    def test_model_routes_are_parallel_alternatives(self):
        graph = architecture_build.build(ROOT)
        view = next(v for v in graph["views"] if v["id"] == "runtime")
        routes = {(e["from"], e["to"]) for e in view["edges"] if e["style"] == "model"}
        self.assertEqual(routes, {("r-native", "r-provider"), ("r-direct", "r-inference"), ("r-codex", "r-gateway")})

    def test_visible_routes_clear_cards_and_frame_lanes(self):
        for edition, graph in editions():
            for view in graph["views"]:
                for edge in view["edges"]:
                    if edge.get("detailOnly"):
                        continue
                    for a, b in zip(edge["points"], edge["points"][1:]):
                        horizontal = a[1] == b[1]
                        self.assertTrue(horizontal or a[0] == b[0])
                        for card in view["nodes"]:
                            thin, start, end = (a[1], min(a[0], b[0]), max(a[0], b[0])) if horizontal else (a[0], min(a[1], b[1]), max(a[1], b[1]))
                            low, high = (card["y"], card["y"] + card["h"]) if horizontal else (card["x"], card["x"] + card["w"])
                            left, right = (card["x"], card["x"] + card["w"]) if horizontal else (card["y"], card["y"] + card["h"])
                            self.assertFalse(low < thin < high and min(end, right) - max(start, left) > 1,
                                             (edition, view["id"], edge["label"], card["id"]))
                        for frame in view["groups"] + view.get("boundaries", []):
                            borders = (frame["y"], frame["y"] + frame["h"]) if horizontal else (frame["x"], frame["x"] + frame["w"])
                            left, right = (frame["x"], frame["x"] + frame["w"]) if horizontal else (frame["y"], frame["y"] + frame["h"])
                            for border in borders:
                                self.assertFalse(abs(thin - border) < 3 and min(end, right) - max(start, left) > 1,
                                                 (edition, view["id"], edge["label"], frame["id"]))

    def test_a_diagonal_route_is_refused(self):
        graph = architecture_build.build(ROOT)
        graph["views"][0]["edges"][0]["points"] = [[0, 0], [100, 100]]
        with self.assertRaisesRegex(architecture_build.BuildError, "^edge_orthogonal: "):
            architecture_build.check(graph, ROOT)

    def test_a_detached_route_is_refused(self):
        graph = architecture_build.build(ROOT)
        graph["views"][0]["edges"][0]["points"][0][0] += 10
        with self.assertRaisesRegex(architecture_build.BuildError, "^edge_attachment: "):
            architecture_build.check(graph, ROOT)

    def test_local_extension_never_enters_public_views(self):
        self.assertNotIn("devrel", {v["id"] for v in architecture_build.build(ROOT)["views"]})
        with self.assertRaisesRegex(architecture_build.BuildError, "^unknown_view: "):
            architecture_build.merge_local({"views": [], "tour": []}, {"views": {"new": {"nodes": []}}})


# Actual rendered SVG coordinates, independent of zoom and viewport size. Perpendicular frame
# crossings are necessary; collinear frame lanes and any label crossing are defects.
BROWSER_GEOMETRY = r"""() => {
  const viewport = document.querySelector('#viewport');
  const inverse = viewport.getScreenCTM().inverse();
  function box(element) {
    const bounds = element.getBBox();
    const matrix = inverse.multiply(element.getScreenCTM());
    const first = new DOMPoint(bounds.x, bounds.y).matrixTransform(matrix);
    const last = new DOMPoint(bounds.x + bounds.width, bounds.y + bounds.height).matrixTransform(matrix);
    return {x: first.x, y: first.y, w: last.x - first.x, h: last.y - first.y};
  }
  const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
  function hit(a, b, rect) {
    if (Math.abs(a[1] - b[1]) < 0.1) {
      return a[1] > rect.y + 0.5 && a[1] < rect.y + rect.h - 0.5
        && Math.min(Math.max(a[0], b[0]), rect.x + rect.w) - Math.max(Math.min(a[0], b[0]), rect.x) > 1;
    }
    return a[0] > rect.x + 0.5 && a[0] < rect.x + rect.w - 0.5
      && Math.min(Math.max(a[1], b[1]), rect.y + rect.h) - Math.max(Math.min(a[1], b[1]), rect.y) > 1;
  }
  const nodes = [...viewport.querySelectorAll('.nbox')].map(el => ({id: el.parentElement.dataset.id, ...box(el)}));
  const frames = [...viewport.querySelectorAll('.grp rect')].map(el => ({id: el.parentElement.dataset.id, ...box(el)}));
  const texts = [...viewport.querySelectorAll('text:not(.ndrill)')].map(el => ({id: el.textContent, ...box(el)}));
  const errors = [];
  const contains = (point, rect) => point[0] >= rect.x - 1 && point[0] <= rect.x + rect.w + 1
    && point[1] >= rect.y - 1 && point[1] <= rect.y + rect.h + 1;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (overlap(texts[i], texts[j])) errors.push(['text collision', texts[i].id, texts[j].id]);
    }
  }
  for (const [selector, category] of [['.node text:not(.ndrill)', 'node'], ['.grp text', 'frame']]) {
    for (const element of viewport.querySelectorAll(selector)) {
      const text = box(element), rect = box(element.parentElement.querySelector('rect'));
      if (text.x < rect.x || text.x + text.w > rect.x + rect.w + 1
          || text.y < rect.y || text.y + text.h > rect.y + rect.h + 1) {
        errors.push([category + ' text overflow', element.textContent]);
      }
    }
  }
  for (const element of viewport.querySelectorAll('.edge')) {
    const line = element.querySelector('.eline');
    const coordinates = line.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
    const points = [];
    for (let i = 0; i < coordinates.length; i += 2) points.push(coordinates.slice(i, i + 2));
    const label = element.querySelector('.elabel'), labelBox = box(label), id = label.textContent;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      for (const node of nodes) if (hit(a, b, node)) errors.push(['line through card', id, node.id]);
      for (const text of texts) if (hit(a, b, text)) errors.push(['line through text', id, text.id]);
      for (const frame of frames) {
        if (!contains(points[0], frame) && !contains(points[points.length - 1], frame) && hit(a, b, frame)) {
          errors.push(['line through unrelated frame', id, frame.id]);
        }
        if (Math.abs(a[1] - b[1]) < 0.1) {
          for (const y of [frame.y, frame.y + frame.h]) {
            if (Math.abs(a[1] - y) < 3
                && Math.min(Math.max(a[0], b[0]), frame.x + frame.w) - Math.max(Math.min(a[0], b[0]), frame.x) > 1) {
              errors.push(['lane on frame', id, frame.id]);
            }
          }
        } else {
          for (const x of [frame.x, frame.x + frame.w]) {
            if (Math.abs(a[0] - x) < 3
                && Math.min(Math.max(a[1], b[1]), frame.y + frame.h) - Math.max(Math.min(a[1], b[1]), frame.y) > 1) {
              errors.push(['lane on frame', id, frame.id]);
            }
          }
        }
      }
    }
    for (const node of nodes) if (overlap(labelBox, node)) errors.push(['label on card', id, node.id]);
    for (const frame of frames) {
      const borders = [
        {x: frame.x - 1, y: frame.y, w: 2, h: frame.h},
        {x: frame.x + frame.w - 1, y: frame.y, w: 2, h: frame.h},
        {x: frame.x, y: frame.y - 1, w: frame.w, h: 2},
        {x: frame.x, y: frame.y + frame.h - 1, w: frame.w, h: 2},
      ];
      for (const border of borders) if (overlap(labelBox, border)) errors.push(['label on frame', id, frame.id]);
    }
  }
  return errors;
}
"""


@unittest.skipUnless(os.environ.get("ARCHITECTURE_BROWSER_TESTS") == "1", "opt-in: existing Playwright and Chromium required")
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

    def page(self, width=1440, height=1000, local=False):
        context = self.browser.new_context(viewport={"width": width, "height": height}, reduced_motion="reduce")
        self.addCleanup(context.close)
        self.requests, self.errors = [], []
        def refuse(route):
            self.requests.append(route.request.url)
            route.abort()
        context.route(re.compile(r"^https?://"), refuse)
        page = context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.goto((ROOT / (architecture_build.LOCAL_OUT if local else architecture_build.PUBLIC_OUT)).as_uri())
        return page

    def test_rendered_geometry_and_offline_navigation(self):
        for local in (False, True) if LOCAL.exists() else (False,):
            for width, height in ((1440, 1000), (390, 844)):
                with self.subTest(local=local, width=width):
                    page = self.page(width, height, local)
                    graph = json.loads(page.locator("#graph-data").text_content())
                    self.assertEqual("Installed environment", page.locator("#panel-body h2").inner_text())
                    self.assertTrue(page.locator(".evidence").is_visible())
                    for index, view in enumerate(graph["views"]):
                        page.keyboard.press(str(index + 1))
                        self.assertEqual(view["label"], page.locator("#panel-body h2").inner_text())
                        self.assertEqual([], page.evaluate(BROWSER_GEOMETRY), (local, width, view["id"]))
                        self.assertEqual(len([e for e in view["edges"] if not e.get("detailOnly")]), page.locator(".eline").count())
                        for node in view["nodes"]:
                            # Real keyboard navigation also reaches small cards on a narrow viewport.
                            card = page.locator('.node[data-id="' + node["id"] + '"]')
                            card.focus()
                            page.keyboard.press("Enter")
                            self.assertEqual(node["label"], page.locator("#panel-body h2").inner_text())
                            page.keyboard.press("Enter")
                            page.wait_for_function("location.hash.includes('drill=1')")
                            self.assertEqual([], page.evaluate(BROWSER_GEOMETRY), (view["id"], node["id"], "drill"))
                            page.keyboard.press("Escape")
                            page.keyboard.press("Escape")
                    page.keyboard.press("1")
                    page.locator('.node[data-id="pi"]').click()
                    self.assertEqual("Pi runtime", page.locator("#panel-body h2").inner_text())
                    page.keyboard.press("Escape")
                    page.keyboard.press("/")
                    self.assertTrue(page.locator("#search").evaluate("el => el === document.activeElement"))
                    page.locator("#search").fill("agentcore")
                    page.keyboard.press("ArrowDown")
                    page.keyboard.press("ArrowUp")
                    page.keyboard.press("Enter")
                    self.assertIn("agentcore", page.locator("#panel-body h2").inner_text().lower())
                    page.keyboard.press("Escape")
                    page.locator("#tabs button").last.click()
                    self.assertTrue(page.locator("#tabs button").last.get_attribute("aria-pressed") == "true")
                    page.keyboard.press("5")
                    page.locator("#path-open").click()
                    page.locator("#pf-from").select_option("anthropic-usage")
                    page.locator("#pf-to").select_option("codex-accounts")
                    page.locator("#pf-go").click()
                    self.assertIn("No path from", page.locator("#pf-result").inner_text())
                    page.keyboard.press("1")
                    page.locator("#pf-from").select_option("terminal")
                    page.locator("#pf-to").select_option("models")
                    page.locator("#pf-go").click()
                    self.assertIn("2 steps", page.locator("#pf-result").inner_text())
                    page.keyboard.press("Escape")
                    page.locator("#tour-start").click()
                    self.assertTrue(page.locator("#tour").is_visible())
                    page.keyboard.press("ArrowRight")
                    self.assertIn("STEP 2", page.locator("#tour-count").inner_text().upper())
                    for index in range(2, len(graph["tour"])):
                        page.keyboard.press("ArrowRight")
                        self.assertIn(f"STEP {index + 1} OF", page.locator("#tour-count").inner_text().upper())
                    page.locator("#tabs button").nth(1).click()
                    self.assertTrue(page.locator("#tour").is_hidden())
                    page.keyboard.press("1")
                    page.keyboard.press("f")
                    page.evaluate("document.querySelector('#pathfinder').open = false")
                    self.assertFalse(page.evaluate("document.documentElement.scrollWidth > window.innerWidth"))
                    page.evaluate("window.scrollTo(0,0)")
                    out = os.environ.get("ARCHITECTURE_SCREENSHOT_DIR")
                    if out:
                        page.screenshot(path=str(Path(out) / f"architecture-{'local' if local else 'public'}-{width}.png"), full_page=True)
                    if not local and width == 1440 and out:
                        for view in graph["views"][1:]:
                            page.locator("#tabs button").filter(has_text=view["label"]).click()
                            self.assertEqual([], page.evaluate(BROWSER_GEOMETRY))
                            page.screenshot(path=str(Path(out) / f"architecture-public-{view['id']}-1440.png"))
                    self.assertEqual([], self.requests, "the page must stay offline")
                    self.assertEqual([], self.errors)
                    page.context.close()

    def test_geometry_checker_detects_injected_defects(self):
        page = self.page()
        self.assertEqual([], page.evaluate(BROWSER_GEOMETRY))
        mutations = [
            ("line through card", "document.querySelector('.eline').setAttribute('d','M60,164 L260,164')"),
            ("lane on frame", "document.querySelector('.eline').setAttribute('d','M40,80 L280,80')"),
            ("line through text", "document.querySelector('.eline').setAttribute('d','M40,105 L280,105')"),
            ("line through unrelated frame", "document.querySelector('.eline').setAttribute('d','M30,125 L290,125')"),
            ("label on frame", "const e=document.querySelector('.elabel');e.setAttribute('x',40);e.setAttribute('y',175)"),
            ("label on card", "const e=document.querySelector('.elabel');e.setAttribute('x',160);e.setAttribute('y',177)"),
            ("text collision", "const e=document.querySelector('.elabel'), f=document.querySelectorAll('.elabel')[1];f.setAttribute('x',e.getAttribute('x'));f.setAttribute('y',e.getAttribute('y'))"),
            ("node text overflow", "document.querySelector('.nlabel').textContent='A deliberately excessive label '.repeat(20)"),
        ]
        for expected, mutation in mutations:
            page.reload()
            page.evaluate(mutation)
            self.assertIn(expected, {item[0] for item in page.evaluate(BROWSER_GEOMETRY)}, mutation)


if __name__ == "__main__":
    unittest.main()
