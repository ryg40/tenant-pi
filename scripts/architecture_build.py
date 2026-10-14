#!/usr/bin/env python3
"""Build the interactive architecture diagrams of the kit as one self-contained HTML file (Python 3.11+).

The public build reads `docs/architecture/model.json` and `config/manifest.json` and writes
`docs/architecture.html`. With `--local`, the build also reads the development-only
`docs/architecture/local-values.json`: the real value of each placeholder and the nodes of one
host. It writes `docs/architecture-local.html`. The output has inline CSS, JavaScript and SVG.
It loads no external file and sends no request. The same input gives the same bytes.

A refusal prints `rule: field` on standard error and exits with code 2. `--check` writes nothing:
it exits with code 1 when the file on disk differs from the build.
"""
import sys

# Direct script invocation imports project modules; never leave bytecode in the kit.
sys.dont_write_bytecode = True

import argparse
import copy
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL_REL = "docs/architecture/model.json"
LOCAL_REL = "docs/architecture/local-values.json"
MANIFEST_REL = "config/manifest.json"
PUBLIC_OUT = "docs/architecture.html"
LOCAL_OUT = "docs/architecture-local.html"

# The grid of a group: node size, gaps, inner padding and the height of the group header.
NODE_W, NODE_H, GAP_X, GAP_Y, PAD, HEAD = 180, 52, 20, 22, 20, 58
MARGIN = 40
TOKEN = re.compile(r"\{\{([a-z0-9_]+)\}\}")
EDGE_STYLES = ("flow", "writes", "reads", "optional", "requires", "refuses")
NODE_KEYS = {"id", "group", "label", "sub", "kind", "summary", "tags", "files", "doc", "script", "drill",
             "component", "inputs", "consent"}
STATUS_LABEL = {"tested": "unverified", "unverified": "unverified", "blocked": "blocked"}
# The tag of a local node that shows a planned value: a plan of the host, not a record of a run.
PLANNED_TAG = "planned value, not a record"


class BuildError(Exception):
    """A refused model. The text is `rule: field` and never holds a value of the model."""


def fail(rule, field):
    raise BuildError(f"{rule}: {field}")


def load_json(path, field):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        fail("unreadable", field)


def tokens(value):
    """The placeholder names in each string of a JSON value."""
    if isinstance(value, str):
        return set(TOKEN.findall(value))
    if isinstance(value, list):
        return set().union(*(tokens(item) for item in value)) if value else set()
    if isinstance(value, dict):
        return set().union(*(tokens(item) for item in value.values())) if value else set()
    return set()


def substitute(value, values):
    """Replace each `{{name}}` with its value. An unknown name stops the build."""
    if isinstance(value, str):
        def replace(match):
            if match.group(1) not in values:
                fail("unknown_placeholder", match.group(1))
            return values[match.group(1)]
        return TOKEN.sub(replace, value)
    if isinstance(value, list):
        return [substitute(item, values) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, values) for key, item in value.items()}
    return value


def is_repo_path(path):
    """A repository-relative path: not absolute, not a home or variable form, no blank."""
    return bool(path) and not path.startswith(("/", "~", "$", "<", "{")) and " " not in path


def merge_local(model, local):
    """Add the nodes, edges, groups and tour steps of the local values to a copy of the model.

    Each node that uses a name of the `planned` list gets the planned tag.
    """
    merged = copy.deepcopy(model)
    views = {view["id"]: view for view in merged["views"]}
    for view_id, extra in sorted(local.get("views", {}).items()):
        if view_id not in views:
            fail("unknown_view", f"local.views.{view_id}")
        for key in ("groups", "nodes", "edges"):
            views[view_id][key] = views[view_id][key] + list(extra.get(key, []))
    merged["tour"] = merged["tour"] + list(local.get("tour", []))
    planned = set(local.get("planned", []))
    for name in sorted(planned - set(local.get("values", {}))):
        fail("local_planned_unknown", name)
    for view in merged["views"]:
        for node in view["nodes"]:
            if tokens(node) & planned:
                node["tags"] = node.get("tags", []) + [PLANNED_TAG]
    return merged


def component_node(node, component, root):
    """Fill one component node from its manifest entry: status, source, fields, gaps and files."""
    cid = node["component"]
    source = component.get("source") or {}
    kind = source.get("kind", "none")
    status = component["status"]
    if kind == "tree":
        source_text, base = f"tree {source['path']}", source["path"]
    elif kind == "npm":
        source_text, base = f"npm {source['spec']}", None
    else:
        source_text, base = kind, None
    requires = [item for item in component.get("requires", []) if item != "core"]
    files = [MANIFEST_REL]
    if base:
        resources = component.get("resources", {})
        for item in resources.get("extensions", []) + resources.get("prompts", []) + resources.get("themes", []):
            files.append(f"{base}/{item}")
        for item in resources.get("skills", []):
            files.append(f"{base}/{item}/SKILL.md")
    files += node.get("files", [])
    node["files"] = [path for index, path in enumerate(files) if path not in files[:index]
                     and (not is_repo_path(path) or (root / path).exists())]
    node.setdefault("sub", f"{kind} source, {status}")
    node["status"] = status
    node["tags"] = [f"manifest {status}", f"{kind} source", f"owner {component['owner']}"] + [
        f"requires {item}" for item in requires] + node.get("tags", [])
    node["fields"] = [
        ["Component", cid],
        ["Status", f"manifest {status}; label {STATUS_LABEL.get(status, status)} when enabled"],
        ["Source", source_text],
        ["Owner", component["owner"]],
        ["License", component.get("license") or "none"],
        ["Requires", ", ".join(component.get("requires", [])) or "none"],
        ["Inputs", node.pop("inputs", "none")],
        ["Consent", node.pop("consent", "none")],
        ["Environment", ", ".join(component.get("env", [])) or "none"],
        ["Boundary", (component.get("configOwnership") or {}).get("boundary", "none")],
    ]
    node["gaps"] = [[gap["code"], gap["fact"]] for gap in component.get("gaps", [])]


def layout(view):
    """Place the nodes of each group on its grid; set the size of each group and of the view.

    The `nodeW` key of a group gives its nodes a larger width for long labels.
    """
    members = {group["id"]: [] for group in view["groups"]}
    for node in view["nodes"]:
        if node.get("group") not in members:
            fail("unknown_group", f"{view['id']}.{node['id']}")
        members[node["group"]].append(node)
    for group in view["groups"]:
        cols, width = group.get("cols", 1), group.get("nodeW", NODE_W)
        nodes = members[group["id"]]
        rows = -(-len(nodes) // cols)
        group["w"] = cols * width + (cols - 1) * GAP_X + 2 * PAD
        group["h"] = HEAD + rows * NODE_H + max(rows - 1, 0) * GAP_Y + PAD
        for index, node in enumerate(nodes):
            row, col = divmod(index, cols)
            node.update(x=group["x"] + PAD + col * (width + GAP_X), y=group["y"] + HEAD + row * (NODE_H + GAP_Y),
                        w=width, h=NODE_H)
    boxes = view["groups"]
    for index, first in enumerate(boxes):
        for second in boxes[index + 1:]:
            if (first["x"] < second["x"] + second["w"] and second["x"] < first["x"] + first["w"]
                    and first["y"] < second["y"] + second["h"] and second["y"] < first["y"] + first["h"]):
                fail("group_overlap", f"{view['id']}.{first['id']}")
    view["width"] = max(group["x"] + group["w"] for group in boxes) + MARGIN
    view["height"] = max(group["y"] + group["h"] for group in boxes) + MARGIN


def check(graph, root):
    """Refuse a graph with a dangling reference, a duplicate id, an unknown kind or a missing file."""
    views = {view["id"] for view in graph["views"]}
    if len(views) != len(graph["views"]):
        fail("duplicate_view", "views")
    for view in graph["views"]:
        if not view["nodes"]:
            fail("empty_view", view["id"])
        ids = [node["id"] for node in view["nodes"]]
        if len(set(ids)) != len(ids):
            fail("duplicate_node", view["id"])
        if len({group["id"] for group in view["groups"]}) != len(view["groups"]):
            fail("duplicate_group", view["id"])
        for group in view["groups"]:
            if group.get("tone", "neutral") not in graph["tones"]:
                fail("unknown_tone", f"{view['id']}.{group['id']}")
        for node in view["nodes"]:
            where = f"{view['id']}.{node['id']}"
            if set(node) - NODE_KEYS - {"x", "y", "w", "h", "status", "fields", "gaps"}:
                fail("unknown_key", where)
            if node["kind"] not in graph["kinds"]:
                fail("unknown_kind", where)
            if node.get("drill") and node["drill"] not in views:
                fail("unknown_drill", where)
            for path in node.get("files", []) + [node.get("doc", ""), node.get("script", "")]:
                if is_repo_path(path) and not (root / path.partition("#")[0].rstrip("/")).exists():
                    fail("file_missing", where)
        for index, edge in enumerate(view["edges"]):
            if edge["from"] not in ids or edge["to"] not in ids:
                fail("edge_endpoint", f"{view['id']}.edges[{index}]")
            if edge.get("style", "flow") not in EDGE_STYLES:
                fail("edge_style", f"{view['id']}.edges[{index}]")
    nodes = {(view["id"], node["id"]) for view in graph["views"] for node in view["nodes"]}
    for index, step in enumerate(graph["tour"]):
        if (step["view"], step["node"]) not in nodes:
            fail("tour_target", f"tour[{index}]")


def build(root=ROOT, local=False):
    """The graph of the public edition, or of the local edition with `local`."""
    root = Path(root)
    model = load_json(root / MODEL_REL, MODEL_REL)
    manifest = load_json(root / MANIFEST_REL, MANIFEST_REL)["components"]
    placeholders = model["placeholders"]
    for name in sorted(set(placeholders) - tokens([model["views"], model["tour"], model["meta"]])):
        fail("placeholder_unused", name)
    values = dict(placeholders)
    if local:
        extra = load_json(root / LOCAL_REL, LOCAL_REL)
        for name in sorted(extra.get("values", {})):
            if name not in placeholders:
                fail("local_value_unknown", name)
        values.update(extra.get("values", {}))
        model = merge_local(model, extra)
    graph = {
        "meta": dict(model["meta"], edition="local" if local else "public", base="../",
                     build="python3 scripts/architecture_build.py" + (" --local" if local else ""),
                     model=MODEL_REL),
        "kinds": model["kinds"],
        "tones": model["tones"],
        "views": substitute(model["views"], values),
        "tour": substitute(model["tour"], values),
    }
    graph["meta"] = substitute(graph["meta"], values)
    seen = set()
    for view in graph["views"]:
        for node in view["nodes"]:
            if "component" in node:
                cid = node["component"]
                if cid not in manifest or cid in seen:
                    fail("unknown_component", f"{view['id']}.{node['id']}")
                seen.add(cid)
                component_node(node, manifest[cid], root)
        layout(view)
    if seen != set(manifest):
        fail("component_missing", "components")
    check(graph, root)
    return graph


def render(graph):
    """One self-contained HTML document of the graph."""
    data = json.dumps(graph, sort_keys=True, indent=1, ensure_ascii=True)
    data = data.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    local = graph["meta"]["edition"] == "local"
    title = graph["meta"]["title"] + (" (local edition)" if local else "")
    badge = ('<span class="badge local" title="This file holds the values of one host. It is development-only.">Local edition, never publish</span>' if local
             else '<span class="badge">Public edition</span>')
    page = PAGE.replace("__TITLE__", html.escape(title)).replace("__BADGE__", badge)
    page = page.replace("__EDITION__", "local" if local else "public")
    return page.replace("__CSS__", CSS.strip()).replace("__JS__", JS.strip()).replace("__DATA__", data)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the self-contained architecture HTML file of the kit.")
    parser.add_argument("--local", action="store_true",
                        help=f"use {LOCAL_REL} and write {LOCAL_OUT} (development-only)")
    parser.add_argument("--check", action="store_true", help="write nothing; exit 1 when the file differs")
    args = parser.parse_args(argv)
    out = ROOT / (LOCAL_OUT if args.local else PUBLIC_OUT)
    try:
        text = render(build(ROOT, local=args.local))
    except BuildError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    rel = out.relative_to(ROOT).as_posix()
    if args.check:
        current = out.read_text(encoding="utf-8") if out.is_file() else None
        print(f"architecture {'current' if current == text else 'differs'}: {rel}")
        return 0 if current == text else 1
    out.write_text(text, encoding="utf-8")
    print(f"architecture written: {rel}")
    return 0


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="scripts/architecture_build.py">
<title>__TITLE__</title>
<style>
__CSS__
</style>
</head>
<body class="ed-__EDITION__">
<header class="top">
 <div class="brand">
  <svg class="mark" viewBox="0 0 28 28" aria-hidden="true"><rect x="2" y="3" width="24" height="7" rx="3"/><rect x="5" y="12" width="18" height="6" rx="3"/><rect x="8" y="20" width="12" height="5" rx="2.5"/></svg>
  <div><h1 id="title">__TITLE__</h1>__BADGE__</div>
 </div>
 <nav id="tabs" aria-label="Views"></nav>
 <div class="tools">
  <div class="searchbox">
   <input id="search" type="search" placeholder="Search nodes  /" autocomplete="off" spellcheck="false" aria-label="Search nodes" aria-controls="results">
   <ul id="results" role="listbox" hidden></ul>
  </div>
  <button id="tour-start" class="btn" type="button" title="Start the guided tour">Tour</button>
  <button id="path-open" class="btn" type="button" title="Find a path between two nodes">Path</button>
 </div>
</header>
<main>
 <section id="stage" aria-label="Diagram">
  <div id="crumbs"></div>
  <svg id="canvas" role="group" aria-label="Architecture diagram">
   <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#1b2433"/></pattern>
    <marker id="m-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#5d6d8a"/></marker>
    <marker id="m-writes" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#4fae72"/></marker>
    <marker id="m-reads" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#5f86bd"/></marker>
    <marker id="m-optional" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#56627a"/></marker>
    <marker id="m-requires" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#c9a24b"/></marker>
    <marker id="m-refuses" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#ff6b6b"/></marker>
    <marker id="m-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#f2b84b"/></marker>
   </defs>
   <rect class="grid" width="100%" height="100%" fill="url(#dots)"/>
   <g id="viewport"><g id="layer-groups"></g><g id="layer-edges"></g><g id="layer-nodes"></g></g>
  </svg>
  <div id="zoom" class="float"><button type="button" data-zoom="in" title="Zoom in (+)">+</button><button type="button" data-zoom="out" title="Zoom out (-)">&minus;</button><button type="button" data-zoom="fit" title="Fit the view (f)">Fit</button></div>
  <div id="legend" class="float"></div>
  <div id="tour" class="float" hidden>
   <div class="tour-head"><span id="tour-count"></span><button type="button" id="tour-end" class="link" title="End the tour (Esc)">End tour</button></div>
   <h3 id="tour-title"></h3>
   <p id="tour-text"></p>
   <div class="tour-nav"><button type="button" id="tour-prev" class="btn">Back</button><button type="button" id="tour-next" class="btn primary">Next</button></div>
  </div>
  <noscript><p class="noscript">This diagram needs JavaScript. EXPLAINER.md has the same diagrams as text.</p></noscript>
 </section>
 <aside id="panel" aria-label="Details">
  <details id="pathfinder">
   <summary>Path finder</summary>
   <div class="pf">
    <label>From <select id="pf-from"></select></label>
    <label>To <select id="pf-to"></select></label>
    <div class="pf-actions"><button type="button" id="pf-go" class="btn primary">Find path</button><button type="button" id="pf-swap" class="btn">Swap</button><button type="button" id="pf-clear" class="btn">Clear</button></div>
    <div id="pf-result"></div>
   </div>
  </details>
  <div id="panel-body"></div>
  <footer class="foot" id="foot"></footer>
 </aside>
</main>
<script type="application/json" id="graph-data">__DATA__</script>
<script>
__JS__
</script>
</body>
</html>
"""

CSS = r"""
:root{--bg:#090d14;--canvas:#0b1019;--panel:#0e1520;--panel2:#121b29;--line:#1c2738;--line2:#283650;--text:#e6edf7;--muted:#8d9ab0;--faint:#5b687e;--accent:#f2b84b;--sky:#5fa8ff;--danger:#ff6b6b;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);display:flex;flex-direction:column;overflow:hidden}
button{font:inherit;color:inherit}
code,.mono{font-family:var(--mono);font-size:12px}
a{color:var(--sky);text-decoration:none}
a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:20px;padding:10px 18px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#0f1622,#0a0f17);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;min-width:220px}
.brand .mark{width:26px;height:26px;fill:none;stroke:var(--accent);stroke-width:1.6}
.brand h1{font-size:15px;line-height:1.2;margin:0 0 3px;font-weight:650;letter-spacing:.01em}
.badge{display:inline-block;padding:0 8px;border-radius:999px;border:1px solid var(--line2);font:600 10px/18px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--sky);background:#0f1a2b}
.badge.local{color:#ffb38a;border-color:#6b3b2a;background:#25140d}
#tabs{display:flex;gap:2px;padding:3px;border:1px solid var(--line);border-radius:12px;background:#0b111b;flex-wrap:wrap}
#tabs button{border:0;background:transparent;padding:6px 12px;border-radius:9px;cursor:pointer;color:var(--muted);font-size:13px;white-space:nowrap}
#tabs button:hover{color:var(--text);background:#141d2c}
#tabs button[aria-pressed="true"]{color:var(--text);background:#1a2538;box-shadow:inset 0 0 0 1px var(--line2)}
#tabs button kbd{font:10px var(--mono);color:var(--faint);margin-right:6px}
.tools{display:flex;align-items:center;gap:8px;margin-left:auto}
.searchbox{position:relative}
#search{width:260px;padding:7px 12px;border-radius:10px;border:1px solid var(--line2);background:#0b111b;color:var(--text);outline:none}
#search:focus{border-color:var(--sky);box-shadow:0 0 0 3px #5fa8ff22}
#results{position:absolute;right:0;top:calc(100% + 6px);width:360px;max-height:420px;overflow:auto;margin:0;padding:6px;list-style:none;background:var(--panel2);border:1px solid var(--line2);border-radius:12px;box-shadow:0 18px 40px #000a;z-index:20}
#results li{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:8px;cursor:pointer}
#results li[aria-selected="true"],#results li:hover{background:#1a2538}
#results .r-main{flex:1;min-width:0}
#results .r-label{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#results .r-sub{display:block;font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#results .r-view{font-size:11px;color:var(--faint);white-space:nowrap}
#results .empty{color:var(--muted);cursor:default}
.btn{border:1px solid var(--line2);background:#111a28;border-radius:9px;padding:6px 12px;cursor:pointer;font-size:13px}
.btn:hover{background:#18233a}
.btn.primary{background:#2a2110;border-color:#6b5320;color:#ffd58a}
.btn.primary:hover{background:#352a14}
.btn[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.link{border:0;background:none;color:var(--muted);cursor:pointer;padding:0;font-size:12px}
.link:hover{color:var(--text)}
main{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 390px;min-height:0}
#stage{position:relative;overflow:hidden;background:radial-gradient(1200px 700px at 30% 20%,#0f1828 0%,var(--canvas) 60%)}
#canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none;user-select:none}
#canvas.dragging{cursor:grabbing}
#viewport{transform-origin:0 0}
#viewport.anim{transition:transform .38s cubic-bezier(.2,.7,.2,1)}
.grp .glabel{font:700 11px var(--sans);letter-spacing:.14em}
.grp .gsub{font:11px var(--mono);fill:var(--muted)}
.edge .eline{fill:none;stroke-width:1.5;stroke:#5d6d8a;marker-end:url(#m-flow)}
.edge .ehit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke}
.edge.st-writes .eline{stroke:#4fae72;marker-end:url(#m-writes)}
.edge.st-reads .eline{stroke:#5f86bd;stroke-dasharray:5 4;marker-end:url(#m-reads)}
.edge.st-optional .eline{stroke:#56627a;stroke-dasharray:7 5;marker-end:url(#m-optional)}
.edge.st-requires .eline{stroke:#c9a24b;stroke-dasharray:2 4;marker-end:url(#m-requires)}
.edge.st-refuses .eline{stroke:#ff6b6b;stroke-dasharray:7 4;marker-end:url(#m-refuses)}
.edge .elabel{font:600 11px var(--sans);fill:#dfe7f3;paint-order:stroke;stroke:#0b1019;stroke-width:5px;stroke-linejoin:round;opacity:0;pointer-events:none;transition:opacity .15s}
.edge:hover .elabel,.edge.on .elabel{opacity:1}
.edge:hover .eline{stroke-width:2.4}
.edge.on .eline{stroke:var(--accent);stroke-width:2.2;marker-end:url(#m-hl)}
.pathing .edge.on .eline{stroke-dasharray:9 6;animation:flow 1s linear infinite}
@keyframes flow{to{stroke-dashoffset:-15}}
.node{cursor:pointer;outline:none}
.node .nbox{fill:#121a28;stroke:#27344b;stroke-width:1.2;transition:stroke .15s,fill .15s}
.node:hover .nbox,.node:focus-visible .nbox{stroke:var(--kc);fill:#162133}
.node .nbar{fill:var(--kc)}
.node .nlabel{font:600 13px var(--sans);fill:var(--text)}
.node .nsub{font:10.5px var(--mono);fill:var(--muted)}
.node .ndrill{font:700 13px var(--sans);fill:var(--faint)}
.node .ndot{stroke:#0b1019;stroke-width:2}
.node .ndot.s-tested{fill:#6cd47e}
.node .ndot.s-unverified{fill:#f2b84b}
.node .ndot.s-blocked{fill:#ff6b6b}
.node.sel .nbox{stroke:var(--kc);stroke-width:2.2;fill:#18243a;filter:drop-shadow(0 0 10px color-mix(in srgb,var(--kc) 55%,transparent))}
.focus .node,.focus .edge{transition:opacity .2s}
.focus .node:not(.on){opacity:.22}
.focus .edge:not(.on){opacity:.12}
.focus .grp{opacity:.55}
.float{position:absolute;z-index:5}
#crumbs{position:absolute;left:16px;top:12px;z-index:5;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);background:#0b1019cc;border:1px solid var(--line);border-radius:10px;padding:5px 10px;backdrop-filter:blur(6px)}
#crumbs b{color:var(--text);font-weight:600}
#zoom{right:14px;top:12px;display:flex;gap:4px}
#zoom button{border:1px solid var(--line2);background:#0f1724e6;border-radius:8px;min-width:32px;height:30px;cursor:pointer;font-size:13px}
#zoom button:hover{background:#18233a}
#legend{left:14px;bottom:14px;max-width:min(560px,70%);display:flex;flex-wrap:wrap;gap:6px 14px;padding:9px 12px;background:#0b1019d9;border:1px solid var(--line);border-radius:12px;font-size:11.5px;color:var(--muted);backdrop-filter:blur(6px)}
#legend .li{display:flex;align-items:center;gap:6px;white-space:nowrap}
#legend .sw{width:10px;height:10px;border-radius:3px}
#legend svg{width:26px;height:8px}
#legend .sep{flex-basis:100%;height:0}
#tour{left:50%;bottom:18px;transform:translateX(-50%);width:min(520px,calc(100% - 40px));background:#121b29f2;border:1px solid #6b5320;border-radius:14px;padding:12px 16px 14px;box-shadow:0 20px 50px #000b;backdrop-filter:blur(8px)}
#tour .tour-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
#tour h3{margin:6px 0 4px;font-size:16px}
#tour p{margin:0 0 10px;color:#c9d3e2}
#tour .tour-nav{display:flex;justify-content:flex-end;gap:8px}
.noscript{position:absolute;inset:40% 0 auto;text-align:center;color:var(--muted)}
#panel{border-left:1px solid var(--line);background:var(--panel);overflow:auto;display:flex;flex-direction:column;min-height:0}
#pathfinder{border-bottom:1px solid var(--line);padding:0 18px}
#pathfinder summary{cursor:pointer;padding:12px 0;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);list-style:none}
#pathfinder summary::-webkit-details-marker{display:none}
#pathfinder summary::before{content:"\25B8";display:inline-block;margin-right:8px;transition:transform .15s}
#pathfinder[open] summary::before{transform:rotate(90deg)}
#pathfinder[open] summary{color:var(--accent)}
.pf{display:grid;gap:8px;padding-bottom:14px}
.pf label{display:grid;grid-template-columns:44px 1fr;align-items:center;font-size:12px;color:var(--muted)}
.pf select{width:100%;padding:6px 8px;border-radius:8px;border:1px solid var(--line2);background:#0b111b;color:var(--text)}
.pf-actions{display:flex;gap:6px}
#pf-result ol{margin:6px 0 0;padding-left:20px}
#pf-result li{margin:3px 0}
#pf-result .via{display:block;font-size:11px;color:var(--faint)}
#pf-result .note{font-size:12px;color:var(--muted);margin:6px 0 0}
#pf-result .note.none{color:#ffb38a;padding:7px 10px;border:1px solid #6b3b2a;border-radius:9px;background:#25140d}
#panel-body{padding:16px 18px 10px;flex:1}
#panel-body h2{margin:4px 0 2px;font-size:20px;line-height:1.25}
#panel-body h3{margin:18px 0 6px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
#panel-body .sub{color:var(--muted);word-break:break-all}
#panel-body .summary{color:#d4dcea;margin:10px 0}
.kindrow{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted)}
.dot{width:9px;height:9px;border-radius:50%;flex:none}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
.tag{font-size:11px;padding:1px 8px;border-radius:999px;background:#162033;border:1px solid var(--line2);color:#b9c5d8}
dl.fields{display:grid;grid-template-columns:96px 1fr;gap:5px 10px;margin:0;font-size:12.5px}
dl.fields dt{color:var(--muted)}
dl.fields dd{margin:0;word-break:break-word}
ul.files,ul.links,ul.gaps{list-style:none;margin:0;padding:0;display:grid;gap:4px}
ul.files li{display:flex;align-items:center;gap:6px;min-width:0}
ul.files a,ul.files code{font:12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
ul.files .copy{margin-left:auto;flex:none;font-size:11px}
ul.gaps li{font-size:12.5px;padding:7px 9px;background:#121b29;border:1px solid var(--line);border-radius:9px}
ul.gaps code{color:var(--accent)}
ul.links button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:8px;padding:5px 7px;cursor:pointer;font-size:13px}
ul.links button:hover{background:#152034;border-color:var(--line)}
ul.links .via{margin-left:auto;font-size:11px;color:var(--faint);text-align:right}
.actions{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 4px}
.stats{font-size:12px;color:var(--muted)}
.howto{margin:0;padding-left:18px;color:#c3cddc;font-size:13px}
.howto kbd,.foot kbd{font:11px var(--mono);border:1px solid var(--line2);border-bottom-width:2px;border-radius:5px;padding:0 5px;color:var(--text);background:#121a28}
.groupcard{margin:10px 0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#0f1725}
.groupcard .gh{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.groupcard .gh span{font:11px var(--mono);color:var(--muted);text-transform:none;letter-spacing:0;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line2);background:#121b29;border-radius:8px;padding:3px 8px;font-size:12px;cursor:pointer}
.chip:hover{border-color:var(--sky)}
.foot{padding:12px 18px 16px;border-top:1px solid var(--line);font-size:11.5px;color:var(--faint)}
.foot code{font-size:11px;color:var(--muted)}
.ed-local header.top{box-shadow:inset 0 -2px 0 #6b3b2a}
@media (max-width:980px){body{overflow:auto}main{grid-template-columns:1fr;grid-template-rows:62vh auto}#panel{border-left:0;border-top:1px solid var(--line)}#search{width:180px}#results{width:300px}}
@media (prefers-reduced-motion:reduce){#viewport.anim{transition:none}.pathing .edge.on .eline{animation:none}}
"""

JS = r"""
(() => {
  "use strict";
  const DATA = JSON.parse(document.getElementById("graph-data").textContent);
  const NS = "http://www.w3.org/2000/svg";
  const VIEWS = new Map(DATA.views.map((v) => [v.id, v]));
  const ORDER = DATA.views.map((v) => v.id);
  const STYLE_LABEL = { flow: "flow", writes: "writes or creates", reads: "reads", optional: "optional or by hand", requires: "requires", refuses: "refuses or excludes" };
  const STYLE_COLOR = { flow: "#5d6d8a", writes: "#4fae72", reads: "#5f86bd", optional: "#56627a", requires: "#c9a24b", refuses: "#ff6b6b" };
  const STYLE_DASH = { flow: "", writes: "", reads: "5 4", optional: "7 5", requires: "2 4", refuses: "7 4" };
  const state = { view: ORDER[0], selected: null, drill: null, path: null, tour: -1, k: 1, tx: 0, ty: 0, hit: -1, found: [] };
  const byId = (id) => document.getElementById(id);
  const svgRoot = byId("canvas"), viewport = byId("viewport");
  const layers = { groups: byId("layer-groups"), edges: byId("layer-edges"), nodes: byId("layer-nodes") };
  const panel = byId("panel-body"), search = byId("search"), results = byId("results");

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
    return e;
  }
  function s(tag, attrs, ...kids) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined) e.append(kid instanceof Node ? kid : String(kid));
    return e;
  }
  const clip = (text, max) => (text && text.length > max ? text.slice(0, max - 1) + "…" : text || "");
  const kindOf = (id) => DATA.kinds[id] || { label: id, color: "#8b98ad" };

  /* Text fitting: measure the rendered text, never guess from the number of characters. */
  const meters = { glabel: s("text", { class: "glabel" }), nlabel: s("text", { class: "nlabel" }), nsub: s("text", { class: "nsub" }) };
  svgRoot.append(s("g", { visibility: "hidden", "aria-hidden": "true" },
    s("g", { class: "grp" }, meters.glabel), s("g", { class: "node" }, meters.nlabel, meters.nsub)));
  const fitted = new Map();
  function textWidth(cls, text) { meters[cls].textContent = text; return meters[cls].getComputedTextLength(); }
  function fitText(el, text, max) {
    // A label that is too wide ends with an ellipsis. The title of its node holds the full text.
    const key = el.getAttribute("class") + "\u0001" + max + "\u0001" + text;
    if (fitted.has(key)) { el.textContent = fitted.get(key); return; }
    el.textContent = text;
    const width = el.getComputedTextLength();
    if (!width) { el.textContent = clip(text, Math.floor(max / 7.5)); return; }
    if (width > max) {
      let lo = 0, hi = text.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        el.textContent = text.slice(0, mid).trimEnd() + "…";
        if (el.getComputedTextLength() <= max) lo = mid; else hi = mid - 1;
      }
      el.textContent = text.slice(0, lo).trimEnd() + "…";
    }
    fitted.set(key, el.textContent);
  }
  function fitTitle(el, text, max) {
    // A group title keeps each character: first tighter letter spacing, then a condensed font.
    el.textContent = text;
    if (el.getComputedTextLength() <= max) return;
    el.style.letterSpacing = ".03em";
    if (el.getComputedTextLength() > max) { el.setAttribute("textLength", max); el.setAttribute("lengthAdjust", "spacingAndGlyphs"); }
  }
  const graph = () => (state.drill ? state.drill.graph : VIEWS.get(state.view));
  const nodeIn = (g, id) => g.nodes.find((n) => n.id === id) || null;

  /* Drill-down: the context and the files of one node, built from its view. */
  function drillGraph(view, node) {
    const W = 180, H = 52, GAP = 24, TOP = 100;
    const ins = [], outs = [], used = new Set([node.id]);
    for (const e of view.edges) {
      if (e.to === node.id && !used.has(e.from)) { used.add(e.from); ins.push(nodeIn(view, e.from)); }
    }
    for (const e of view.edges) {
      if (e.from === node.id && !used.has(e.to)) { used.add(e.to); outs.push(nodeIn(view, e.to)); }
    }
    // A context column is as wide as its longest measured label, up to a limit.
    const CW = Math.min(280, Math.max(W, ...[node, ...ins, ...outs].map((n) => Math.ceil(textWidth("nlabel", n.label) + (n.status ? 41 : 29)))));
    const xs = [40, CW + 200, 2 * CW + 360];
    const cols = [["Comes from", ins, "clone"], ["Selected", [node], "actions"], ["Goes to", outs, "profile"]];
    const rows = Math.max(1, ...cols.map((c) => c[1].length));
    const nodes = [], groups = [], edges = [];
    cols.forEach(([title, items, tone], ci) => {
      if (!items.length) return;
      const top = TOP + ((rows - items.length) * (H + GAP)) / 2;
      items.forEach((n, i) => nodes.push(Object.assign({}, n, { x: xs[ci] + 20, y: top + i * (H + GAP), w: CW, h: H })));
      groups.push({ id: "drill-" + ci, label: title, sub: ci === 1 ? kindOf(node.kind).label : items.length + (items.length === 1 ? " node" : " nodes"),
        x: xs[ci], y: top - 58, w: CW + 40, h: items.length * (H + GAP) - GAP + 78, tone });
    });
    for (const e of view.edges) if ((e.to === node.id) !== (e.from === node.id)) edges.push(Object.assign({}, e));
    let bottom = TOP + rows * (H + GAP) - GAP + 20, width = xs[2] + CW + 80;
    const files = node.files || [];
    if (files.length) {
      const items = files.map((path) => {
        const parts = path.replace(/\/$/, "").split("/"), base = parts.pop() + (path.endsWith("/") ? "/" : "");
        const generic = /^(SKILL\.md|README\.md|index\.ts|package\.json)$/.test(base) && parts.length;
        const label = generic ? parts.pop() + "/" + base : base, dir = parts.join("/");
        return { path, label, sub: dir.length > 25 ? "\u2026/" + parts.slice(-1)[0] : dir };
      });
      // A file box is as wide as its longest measured line, up to a limit.
      const FW = Math.min(340, Math.max(W, ...items.map((f) => Math.ceil(Math.max(textWidth("nlabel", f.label), textWidth("nsub", f.sub)) + 29))));
      const per = Math.max(1, Math.min(4, files.length, Math.floor(1040 / (FW + 20)))), frows = Math.ceil(files.length / per), fy = bottom + 40 + 58;
      items.forEach((f, i) => nodes.push({ id: "file-" + i, kind: "file", label: f.label, sub: f.sub, summary: "A file of " + node.label + ".", files: [f.path], tags: [],
        x: 60 + (i % per) * (FW + 20), y: fy + Math.floor(i / per) * (H + 22), w: FW, h: H }));
      const title = "Files of " + node.label, gw = Math.max(per * FW + (per - 1) * 20 + 40, Math.ceil(textWidth("glabel", title.toUpperCase())) + 36);
      groups.push({ id: "drill-files", label: title, sub: files.length + (files.length === 1 ? " file" : " files"),
        x: 40, y: fy - 58, w: gw, h: 58 + frows * H + (frows - 1) * 22 + 20, tone: "neutral" });
      bottom = fy + frows * (H + 22);
      width = Math.max(width, 40 + gw + 40);
    }
    return { id: view.id + "/" + node.id, label: node.label, summary: "The context and the files of " + node.label + ". Double-click another node to move the focus.",
      groups, nodes, edges, width, height: bottom + 60 };
  }

  /* Edge geometry: a cubic curve between the nearest sides of two boxes. */
  function curve(a, b) {
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2, dx = bx - ax, dy = by - ay;
    let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
    if (Math.abs(dx) > Math.abs(dy) * 1.6 || Math.abs(dy) < a.h) {
      const sx = dx >= 0 ? 1 : -1;
      x1 = sx > 0 ? a.x + a.w : a.x; y1 = ay; x2 = sx > 0 ? b.x : b.x + b.w; y2 = by;
      const off = Math.max(40, Math.abs(x2 - x1) / 2) * sx;
      c1x = x1 + off; c1y = y1; c2x = x2 - off; c2y = y2;
    } else {
      const sy = dy >= 0 ? 1 : -1;
      x1 = ax; y1 = sy > 0 ? a.y + a.h : a.y; x2 = bx; y2 = sy > 0 ? b.y : b.y + b.h;
      const off = Math.max(34, Math.abs(y2 - y1) / 2) * sy;
      c1x = x1; c1y = y1 + off; c2x = x2; c2y = y2 - off;
    }
    return { d: `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`,
      mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8, my: (y1 + 3 * c1y + 3 * c2y + y2) / 8 };
  }

  function render() {
    const g = graph();
    for (const layer of Object.values(layers)) layer.replaceChildren();
    for (const grp of g.groups) {
      const tone = DATA.tones[grp.tone] || DATA.tones.neutral;
      const title = s("text", { class: "glabel", x: grp.x + 18, y: grp.y + 25, fill: tone }), sub = grp.sub ? s("text", { class: "gsub", x: grp.x + 18, y: grp.y + 43 }) : null;
      layers.groups.append(s("g", { class: "grp" },
        s("rect", { x: grp.x, y: grp.y, width: grp.w, height: grp.h, rx: 18, fill: tone, "fill-opacity": 0.055, stroke: tone, "stroke-opacity": 0.4 }),
        title, sub, s("title", null, grp.label + (grp.sub ? "\n" + grp.sub : ""))));
      fitTitle(title, grp.label.toUpperCase(), grp.w - 36);
      if (sub) fitText(sub, grp.sub, grp.w - 36);
    }
    const nodes = new Map(g.nodes.map((n) => [n.id, n]));
    g.edges.forEach((e, i) => {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      if (!a || !b) return;
      const c = curve(a, b), style = e.style || "flow";
      layers.edges.append(s("g", { class: "edge st-" + style, "data-i": i },
        s("path", { class: "ehit", d: c.d }), s("path", { class: "eline", d: c.d }),
        e.label ? s("text", { class: "elabel", x: c.mx, y: c.my - 5, "text-anchor": "middle" }, e.label) : null,
        s("title", null, a.label + " → " + b.label + (e.label ? ": " + e.label : ""))));
    });
    for (const n of g.nodes) {
      const k = kindOf(n.kind);
      const canDrill = !state.drill && ((n.files && n.files.length) || n.drill || g.edges.some((e) => e.from === n.id || e.to === n.id));
      const label = s("text", { class: "nlabel", x: 19, y: 23 }), sub = n.sub ? s("text", { class: "nsub", x: 19, y: 40 }) : null;
      const el = s("g", { class: "node", transform: `translate(${n.x},${n.y})`, tabindex: 0, role: "button", "data-id": n.id,
        "aria-label": n.label + (n.sub ? ", " + n.sub : "") + ", " + k.label },
        s("rect", { class: "nbox", width: n.w, height: n.h, rx: 10 }),
        s("rect", { class: "nbar", x: 7, y: 10, width: 3, height: n.h - 20, rx: 1.5 }),
        label, sub,
        n.status ? s("circle", { class: "ndot s-" + n.status, cx: n.w - 13, cy: 13, r: 4.5 }) : null,
        canDrill ? s("text", { class: "ndrill", x: n.w - 15, y: n.h - 11 }, "›") : null,
        s("title", null, n.label + (n.sub ? "\n" + n.sub : "")));
      el.style.setProperty("--kc", k.color);
      layers.nodes.append(el);
      // The label ends before the status dot, the sub line before the drill mark.
      fitText(label, n.label, n.w - 19 - (n.status ? 22 : 10));
      if (sub) fitText(sub, n.sub, n.w - 19 - (canDrill ? 20 : 10));
    }
    applyFocus(); renderTabs(); renderCrumbs(); renderLegend(); renderPanel(); fillPathOptions();
  }

  function applyFocus() {
    const g = graph(), on = new Set(), onEdges = new Set();
    let focus = false;
    if (state.path) {
      focus = true; state.path.nodes.forEach((id) => on.add(id)); state.path.edges.forEach((i) => onEdges.add(i));
    } else if (state.drill && state.selected === state.drill.from) {
      focus = true; g.nodes.forEach((n) => on.add(n.id)); g.edges.forEach((e, i) => onEdges.add(i));
    } else if (state.selected && nodeIn(g, state.selected)) {
      focus = true; on.add(state.selected);
      g.edges.forEach((e, i) => { if (e.from === state.selected || e.to === state.selected) { onEdges.add(i); on.add(e.from); on.add(e.to); } });
    }
    svgRoot.classList.toggle("focus", focus);
    svgRoot.classList.toggle("pathing", !!state.path);
    for (const el of layers.nodes.children) { el.classList.toggle("on", on.has(el.dataset.id)); el.classList.toggle("sel", el.dataset.id === state.selected); }
    for (const el of layers.edges.children) el.classList.toggle("on", onEdges.has(Number(el.dataset.i)));
  }

  /* Pan and zoom. */
  function applyTransform(animate) {
    viewport.classList.toggle("anim", !!animate);
    viewport.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.k})`;
  }
  function fit(animate) {
    const g = graph(), r = svgRoot.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pad = 28, bottom = state.tour >= 0 ? 150 : 70;
    state.k = Math.min((r.width - pad * 2) / g.width, (r.height - pad - bottom) / g.height, 1.3);
    state.tx = (r.width - g.width * state.k) / 2; state.ty = pad + (r.height - pad - bottom - g.height * state.k) / 2;
    applyTransform(animate);
  }
  function centerOn(id, animate, zoom) {
    const n = nodeIn(graph(), id), r = svgRoot.getBoundingClientRect();
    if (!n || !r.width) return;
    state.k = Math.min(Math.max(zoom || state.k, 0.75), 2.2);
    state.tx = r.width / 2 - (n.x + n.w / 2) * state.k;
    state.ty = (state.tour >= 0 ? r.height * 0.38 : r.height / 2) - (n.y + n.h / 2) * state.k;
    applyTransform(animate);
  }
  function zoomBy(factor, px, py) {
    const r = svgRoot.getBoundingClientRect();
    px = px === undefined ? r.width / 2 : px; py = py === undefined ? r.height / 2 : py;
    const k = Math.min(3, Math.max(0.15, state.k * factor));
    state.tx = px - (px - state.tx) * (k / state.k); state.ty = py - (py - state.ty) * (k / state.k); state.k = k;
    applyTransform(false);
  }
  svgRoot.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = svgRoot.getBoundingClientRect();
    zoomBy(Math.exp(-ev.deltaY * 0.0016), ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  let drag = null, suppress = false;
  svgRoot.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    suppress = false; drag = { x: ev.clientX, y: ev.clientY, tx: state.tx, ty: state.ty, moved: false };
  });
  window.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true; svgRoot.classList.add("dragging");
    state.tx = drag.tx + dx; state.ty = drag.ty + dy; applyTransform(false);
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    suppress = drag.moved; drag = null; svgRoot.classList.remove("dragging");
  });
  svgRoot.addEventListener("click", (ev) => {
    if (suppress) { suppress = false; return; }
    const n = ev.target.closest(".node");
    if (n) select(n.dataset.id);
    else if (state.selected || state.path) { state.path = null; showPathResult(); select(null); }
  });
  svgRoot.addEventListener("dblclick", (ev) => { const n = ev.target.closest(".node"); if (n) drill(n.dataset.id); });
  layers.nodes.addEventListener("keydown", (ev) => {
    const n = ev.target.closest(".node");
    if (!n) return;
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); if (state.selected === n.dataset.id && ev.key === "Enter") drill(n.dataset.id); else select(n.dataset.id); }
  });
  byId("zoom").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.zoom === "fit") fit(true); else zoomBy(b.dataset.zoom === "in" ? 1.25 : 0.8);
  });

  /* Selection, views and drill-down. */
  function select(id, opts) {
    opts = opts || {};
    state.selected = id;
    if (!opts.keepPath) { state.path = null; showPathResult(); }
    applyFocus(); renderPanel(); syncHash();
    if (opts.center && id) centerOn(id, true);
  }
  function setView(id, node) {
    if (!VIEWS.has(id)) return;
    endTour();
    state.view = id; state.drill = null; state.path = null; state.selected = node || null;
    showPathResult(); render();
    if (node) centerOn(node, true, 1.05); else fit(true);
    syncHash();
  }
  function drill(id) {
    const base = VIEWS.get(state.view), n = nodeIn(base, id);
    if (!n) return;
    state.drill = { graph: drillGraph(base, n), from: id };
    state.selected = id; state.path = null; showPathResult(); render(); fit(true); syncHash();
  }
  function undrill() {
    const id = state.drill ? state.drill.from : null;
    state.drill = null; state.path = null; state.selected = id; showPathResult(); render();
    if (id) centerOn(id, true); else fit(true);
    syncHash();
  }

  function renderTabs() {
    const nav = byId("tabs");
    nav.replaceChildren(...DATA.views.map((v, i) => h("button", { type: "button", "aria-pressed": String(v.id === state.view), title: v.summary,
      onclick: () => setView(v.id) }, h("kbd", null, String(i + 1)), v.label)));
  }
  function renderCrumbs() {
    const box = byId("crumbs"), view = VIEWS.get(state.view);
    if (state.drill) box.replaceChildren(h("button", { type: "button", class: "link", onclick: undrill, title: "Back to the view (Esc)" }, "← " + view.label),
      h("span", null, "/"), h("b", null, state.drill.graph.label), h("span", null, "context and files"));
    else box.replaceChildren(h("b", null, view.label), h("span", null, view.nodes.length + " nodes, " + view.edges.length + " edges"));
  }
  function renderLegend() {
    const g = graph(), kinds = new Set(g.nodes.map((n) => n.kind)), styles = new Set(g.edges.map((e) => e.style || "flow"));
    const items = Object.keys(DATA.kinds).filter((k) => kinds.has(k)).map((k) =>
      h("span", { class: "li" }, h("span", { class: "sw", style: "background:" + DATA.kinds[k].color }), DATA.kinds[k].label));
    const lines = Object.keys(STYLE_LABEL).filter((k) => styles.has(k)).map((k) => {
      const icon = s("svg", { viewBox: "0 0 26 8" }, s("line", { x1: 1, y1: 4, x2: 25, y2: 4, stroke: STYLE_COLOR[k], "stroke-width": 2, "stroke-dasharray": STYLE_DASH[k] || null }));
      return h("span", { class: "li" }, icon, STYLE_LABEL[k]);
    });
    byId("legend").replaceChildren(...items, h("span", { class: "sep" }), ...lines);
  }

  /* The panel. */
  function fileLink(path) {
    const repo = !/^[\/~$<]/.test(path) && !/\s/.test(path);
    if (repo) return h("a", { href: DATA.meta.base + path, target: "_blank", rel: "noopener", title: "Open " + path }, path);
    if (DATA.meta.edition === "local" && path.startsWith("/")) return h("a", { href: "file://" + path, target: "_blank", rel: "noopener", title: "Open " + path }, path);
    return h("code", { title: path }, path);
  }
  function copyButton(text) {
    return h("button", { type: "button", class: "link copy", title: "Copy the path", onclick: (ev) => {
      const b = ev.currentTarget, done = () => { b.textContent = "copied"; setTimeout(() => { b.textContent = "copy"; }, 1200); };
      try { navigator.clipboard.writeText(text).then(done, () => { b.textContent = "select it"; }); } catch (err) { b.textContent = "select it"; }
    } }, "copy");
  }
  function nodeButton(g, id, via) {
    const n = nodeIn(g, id);
    if (!n) return null;
    return h("li", null, h("button", { type: "button", onclick: () => select(id, { center: true }) },
      h("span", { class: "dot", style: "background:" + kindOf(n.kind).color }), n.label, via ? h("span", { class: "via" }, via) : null));
  }
  function renderPanel() {
    const g = graph(), n = state.selected ? nodeIn(g, state.selected) : null;
    panel.replaceChildren();
    if (n) renderNode(g, n); else renderOverview(g);
    panel.scrollTop = 0;
  }
  function renderOverview(g) {
    const view = VIEWS.get(state.view);
    panel.append(h("div", { class: "kindrow" }, state.drill ? "Drill-down" : "View " + (ORDER.indexOf(state.view) + 1) + " of " + ORDER.length),
      h("h2", null, state.drill ? g.label : view.label), h("p", { class: "summary" }, g.summary || ""),
      h("div", { class: "stats" }, g.nodes.length + " nodes, " + g.edges.length + " edges"));
    for (const grp of g.groups) {
      const members = g.nodes.filter((n) => (n.group || "") === grp.id || (state.drill && sameColumn(g, grp, n)));
      panel.append(h("div", { class: "groupcard" },
        h("div", { class: "gh", style: "color:" + (DATA.tones[grp.tone] || DATA.tones.neutral) }, grp.label, grp.sub ? h("span", { title: grp.sub }, grp.sub) : null),
        h("div", { class: "chips" }, members.map((m) => h("button", { type: "button", class: "chip", onclick: () => select(m.id, { center: true }) },
          h("span", { class: "dot", style: "background:" + kindOf(m.kind).color }), m.label)))));
    }
    panel.append(h("h3", null, "How to use"), h("ul", { class: "howto" },
      h("li", null, "Click a node to see its summary, tags, files and connections."),
      h("li", null, "Double-click a node, or press ", h("kbd", null, "Enter"), " on a selected node, to see its context and files."),
      h("li", null, "Press ", h("kbd", null, "/"), " to search all views. Press ", h("kbd", null, "1"), " to ", h("kbd", null, String(ORDER.length)), " to change the view."),
      h("li", null, "Drag to pan. Scroll to zoom. Press ", h("kbd", null, "f"), " to fit and ", h("kbd", null, "Esc"), " to go back."),
      h("li", null, "Hover an edge to read its label.")));
  }
  function sameColumn(g, grp, n) { return n.x >= grp.x && n.x < grp.x + grp.w && n.y >= grp.y && n.y < grp.y + grp.h; }
  function renderNode(g, n) {
    const k = kindOf(n.kind), grp = g.groups.find((x) => x.id === n.group);
    panel.append(h("div", { class: "kindrow" }, h("span", { class: "dot", style: "background:" + k.color }), k.label, grp ? " · " + grp.label : ""),
      h("h2", null, n.label), n.sub ? h("div", { class: "mono sub" }, n.sub) : null, h("p", { class: "summary" }, n.summary || ""));
    if (n.tags && n.tags.length) panel.append(h("div", { class: "tags" }, n.tags.map((t) => h("span", { class: "tag" }, t))));
    const rows = (n.fields || []).slice();
    if (n.script) rows.push(["Script", fileLink(n.script)]);
    if (n.doc) rows.push(["Doc", fileLink(n.doc)]);
    if (rows.length) panel.append(h("h3", null, "Facts"), h("dl", { class: "fields" }, rows.map(([a, b]) => [h("dt", null, a), h("dd", null, b)])));
    if (n.gaps && n.gaps.length) panel.append(h("h3", null, "Readiness gaps (" + n.gaps.length + ")"),
      h("ul", { class: "gaps" }, n.gaps.map(([code, fact]) => h("li", null, h("code", null, code), h("div", null, fact)))));
    if (n.files && n.files.length) panel.append(h("h3", null, "Files (" + n.files.length + ")"),
      h("ul", { class: "files" }, n.files.map((f) => h("li", null, fileLink(f), copyButton(f)))));
    const outs = g.edges.filter((e) => e.from === n.id), ins = g.edges.filter((e) => e.to === n.id);
    if (outs.length) panel.append(h("h3", null, "Goes to"), h("ul", { class: "links" }, outs.map((e) => nodeButton(g, e.to, e.label))));
    if (ins.length) panel.append(h("h3", null, "Comes from"), h("ul", { class: "links" }, ins.map((e) => nodeButton(g, e.from, e.label))));
    const acts = [];
    if (!state.drill && n.kind !== "file") acts.push(h("button", { type: "button", class: "btn primary", onclick: () => drill(n.id) }, "Drill in"));
    if (n.drill && n.drill !== state.view) acts.push(h("button", { type: "button", class: "btn", onclick: () => setView(n.drill) }, "Open view: " + VIEWS.get(n.drill).label));
    if (state.drill) acts.push(h("button", { type: "button", class: "btn", onclick: undrill }, "Back to the view"));
    acts.push(h("button", { type: "button", class: "btn", onclick: () => pathEnd("from", n.id) }, "Path from here"));
    acts.push(h("button", { type: "button", class: "btn", onclick: () => pathEnd("to", n.id) }, "Path to here"));
    panel.append(h("div", { class: "actions" }, acts));
  }

  /* The path finder: the shortest path along the edges of the current graph. */
  const pf = { box: byId("pathfinder"), from: byId("pf-from"), to: byId("pf-to"), out: byId("pf-result") };
  function fillPathOptions() {
    const g = graph(), keep = [pf.from.value, pf.to.value];
    const sorted = g.nodes.slice().sort((a, b) => a.label.localeCompare(b.label));
    [pf.from, pf.to].forEach((sel, i) => {
      sel.replaceChildren(h("option", { value: "" }, "choose a node"), ...sorted.map((n) => h("option", { value: n.id }, n.label + (n.sub ? "  (" + clip(n.sub, 30) + ")" : ""))));
      if (nodeIn(g, keep[i])) sel.value = keep[i];
    });
  }
  function pathEnd(which, id) {
    pf.box.open = true;
    (which === "from" ? pf.from : pf.to).value = id;
    if (pf.from.value && pf.to.value) runPath(); else (which === "from" ? pf.to : pf.from).focus();
  }
  function shortest(g, from, to, directed) {
    const prev = new Map([[from, null]]), queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) break;
      g.edges.forEach((e, i) => {
        const next = e.from === cur ? e.to : !directed && e.to === cur ? e.from : null;
        if (next !== null && !prev.has(next)) { prev.set(next, [cur, i]); queue.push(next); }
      });
    }
    if (!prev.has(to)) return null;
    const nodes = [to], edges = [];
    for (let cur = to; prev.get(cur); cur = prev.get(cur)[0]) { edges.unshift(prev.get(cur)[1]); nodes.unshift(prev.get(cur)[0]); }
    return { nodes, edges, directed };
  }
  function runPath() {
    const g = graph(), from = pf.from.value, to = pf.to.value;
    if (!from || !to) { pf.out.replaceChildren(h("p", { class: "note" }, "Choose two nodes of this view.")); return; }
    state.path = from === to ? { nodes: [from], edges: [], directed: true } : shortest(g, from, to, true) || shortest(g, from, to, false);
    state.selected = null; applyFocus(); renderPanel(); showPathResult(); syncHash();
    if (!state.path) {
      const name = (id) => (nodeIn(g, id) || { label: id }).label;
      pf.out.replaceChildren(h("p", { class: "note none", role: "status" }, "No path from " + name(from) + " to " + name(to) + " in this view."));
    }
  }
  function showPathResult() {
    const g = graph(), p = state.path;
    if (!p) { pf.out.replaceChildren(); return; }
    const items = p.nodes.map((id, i) => {
      const n = nodeIn(g, id), e = i > 0 ? g.edges[p.edges[i - 1]] : null;
      return h("li", null, e ? h("span", { class: "via" }, (e.from === id ? "← " : "→ ") + (e.label || "")) : null,
        h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); centerOn(id, true); } }, n ? n.label : id));
    });
    pf.out.replaceChildren(h("p", { class: "note" }, (p.edges.length ? p.edges.length + " steps" : "The same node") + (p.directed ? ", along the edge direction." : ", in either direction: no directed path exists.")), h("ol", null, items));
  }
  byId("pf-go").addEventListener("click", runPath);
  byId("pf-swap").addEventListener("click", () => { const a = pf.from.value; pf.from.value = pf.to.value; pf.to.value = a; if (pf.out.firstChild) runPath(); });
  byId("pf-clear").addEventListener("click", () => { pf.from.value = ""; pf.to.value = ""; state.path = null; showPathResult(); applyFocus(); });
  byId("path-open").addEventListener("click", () => { pf.box.open = !pf.box.open; if (pf.box.open) pf.from.focus(); });

  /* Search over every view. */
  const INDEX = [];
  for (const v of DATA.views) for (const n of v.nodes)
    INDEX.push({ v, n, hay: [n.label, n.sub, n.id, n.summary, (n.tags || []).join(" "), (n.files || []).join(" ")].join(" \u0001 ").toLowerCase() });
  function find(text) {
    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored = [];
    for (const item of INDEX) {
      if (!words.every((w) => item.hay.includes(w))) continue;
      const label = item.n.label.toLowerCase(), first = words.join(" ");
      const score = label === first ? 0 : label.startsWith(first) ? 1 : label.includes(first) ? 2 : (item.n.sub || "").toLowerCase().includes(first) ? 3 : 4;
      scored.push([score, ORDER.indexOf(item.v.id), item]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].n.label.localeCompare(b[2].n.label));
    return scored.slice(0, 14).map((x) => x[2]);
  }
  function showResults() {
    const found = state.found;
    results.hidden = !search.value.trim();
    if (results.hidden) return;
    if (!found.length) { results.replaceChildren(h("li", { class: "empty" }, "No node matches.")); return; }
    results.replaceChildren(...found.map((item, i) => h("li", { role: "option", "aria-selected": String(i === state.hit),
      onmousedown: (ev) => { ev.preventDefault(); pick(i); } },
      h("span", { class: "dot", style: "background:" + kindOf(item.n.kind).color }),
      h("span", { class: "r-main" }, h("span", { class: "r-label" }, item.n.label), item.n.sub ? h("span", { class: "r-sub" }, item.n.sub) : null),
      h("span", { class: "r-view" }, item.v.label))));
  }
  function pick(i) {
    const item = state.found[i];
    if (!item) return;
    search.value = ""; state.found = []; state.hit = -1; results.hidden = true; search.blur();
    endTour();
    if (state.view !== item.v.id || state.drill) setView(item.v.id, item.n.id);
    else { select(item.n.id); centerOn(item.n.id, true, 1.05); }
  }
  search.addEventListener("input", () => { state.found = find(search.value); state.hit = state.found.length ? 0 : -1; showResults(); });
  search.addEventListener("blur", () => { results.hidden = true; });
  search.addEventListener("focus", () => { if (search.value.trim()) showResults(); });
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (state.found.length) state.hit = (state.hit + (ev.key === "ArrowDown" ? 1 : -1) + state.found.length) % state.found.length;
      showResults();
    } else if (ev.key === "Enter") { ev.preventDefault(); pick(Math.max(state.hit, 0)); }
    else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); if (search.value) { search.value = ""; state.found = []; showResults(); } else search.blur(); }
  });

  /* The guided tour. */
  const tour = { card: byId("tour"), count: byId("tour-count"), title: byId("tour-title"), text: byId("tour-text"), prev: byId("tour-prev"), next: byId("tour-next") };
  function tourGo(i) {
    const steps = DATA.tour;
    if (!steps.length) return;
    state.tour = Math.max(0, Math.min(steps.length - 1, i));
    const step = steps[state.tour];
    tour.card.hidden = false;
    if (state.view !== step.view || state.drill) { state.view = step.view; state.drill = null; render(); }
    state.path = null; showPathResult(); state.selected = step.node; applyFocus(); renderPanel(); syncHash();
    tour.count.textContent = "Step " + (state.tour + 1) + " of " + steps.length + " · " + VIEWS.get(step.view).label;
    tour.title.textContent = step.title; tour.text.textContent = step.text;
    tour.prev.disabled = state.tour === 0;
    tour.next.textContent = state.tour === steps.length - 1 ? "Finish" : "Next";
    byId("tour-start").setAttribute("aria-pressed", "true");
    centerOn(step.node, true, 1.1);
  }
  function endTour() {
    if (state.tour < 0) return;
    state.tour = -1; tour.card.hidden = true; byId("tour-start").setAttribute("aria-pressed", "false");
  }
  byId("tour-start").addEventListener("click", () => (state.tour >= 0 ? endTour() : tourGo(0)));
  tour.prev.addEventListener("click", () => tourGo(state.tour - 1));
  tour.next.addEventListener("click", () => (state.tour >= DATA.tour.length - 1 ? endTour() : tourGo(state.tour + 1)));
  byId("tour-end").addEventListener("click", endTour);

  /* Keyboard. */
  document.addEventListener("keydown", (ev) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((ev.target && ev.target.tagName) || "");
    if (ev.key === "Escape") {
      if (typing) { ev.target.blur(); return; }
      if (state.tour >= 0) endTour();
      else if (state.path) { state.path = null; showPathResult(); applyFocus(); }
      else if (state.drill) undrill();
      else if (state.selected) select(null);
      return;
    }
    if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === "/") { ev.preventDefault(); search.focus(); search.select(); }
    else if (state.tour >= 0 && ev.key === "ArrowRight") tourGo(state.tour + 1);
    else if (state.tour >= 0 && ev.key === "ArrowLeft") tourGo(state.tour - 1);
    else if (ev.key === "f") fit(true);
    else if (ev.key === "+" || ev.key === "=") zoomBy(1.25);
    else if (ev.key === "-") zoomBy(0.8);
    else if (/^[1-9]$/.test(ev.key) && Number(ev.key) <= ORDER.length) setView(ORDER[Number(ev.key) - 1]);
  });

  /* The address: #view=<id>&node=<id>&drill=1 */
  function currentHash() {
    const parts = ["view=" + encodeURIComponent(state.view)];
    if (state.drill) parts.push("node=" + encodeURIComponent(state.drill.from), "drill=1");
    else if (state.selected) parts.push("node=" + encodeURIComponent(state.selected));
    return parts.join("&");
  }
  function syncHash() {
    const next = "#" + currentHash();
    try { if (location.hash !== next) history.replaceState(null, "", next); } catch (err) { /* a file URL can refuse it */ }
  }
  function fromHash() {
    const p = new URLSearchParams(location.hash.slice(1)), view = p.get("view"), node = p.get("node");
    if (!view || !VIEWS.has(view)) return false;
    state.view = view; state.drill = null; state.selected = null; render();
    if (node && nodeIn(VIEWS.get(view), node)) { if (p.get("drill") === "1") drill(node); else { select(node); centerOn(node, false, 1.05); } }
    else fit(false);
    return true;
  }
  window.addEventListener("hashchange", () => { if (location.hash !== "#" + currentHash()) fromHash(); });
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => (state.selected ? centerOn(state.selected, false) : fit(false)), 120); });

  byId("foot").append("Built by ", h("code", null, DATA.meta.build), " from ", h("code", null, DATA.meta.model), " and ", h("code", null, "config/manifest.json"), ". ",
    DATA.meta.edition === "local" ? "This local edition holds the values of one host. It is development-only." : "This public edition uses placeholders: replace them with your values.");
  if (!fromHash()) { render(); fit(false); }
})();
"""


if __name__ == "__main__":
    sys.exit(main())
