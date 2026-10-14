"""Architecture diagrams: a deterministic public build, the public reader rules, and a complete graph.

The local edition is development-only. Its tests run only when its values file is present, so a
portable snapshot skips them.
"""
import copy
import json
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
            self.assertGreaterEqual(len(graph["views"]), 5)
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


if __name__ == "__main__":
    unittest.main()
