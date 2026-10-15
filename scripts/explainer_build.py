#!/usr/bin/env python3
"""Build EXPLAINER.html, the beginner tutorials of the shared AgentCore memory (Python 3.11+).

The build reads `docs/explainer/`: `page.json` (the introduction, the people, the glossary and the
general "Not verified" items), one JSON file per tutorial in `docs/explainer/tutorials/` (in the
order of the file names), `explainer.css` and `template.html`. It writes `EXPLAINER.html` at the
repository root. The page has inline CSS and no script. It loads no external file. The same input
gives the same bytes.

A refusal prints `rule: field` on standard error and exits with code 2. `--check` writes nothing:
it exits with code 1 when the file on disk differs from the build.
"""
import sys

# Direct script invocation imports project modules; never leave bytecode in the kit.
sys.dont_write_bytecode = True

import argparse
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REL = "docs/explainer"
PAGE_REL = "docs/explainer/page.json"
TUTORIALS_REL = "docs/explainer/tutorials"
CSS_REL = "docs/explainer/explainer.css"
TEMPLATE_REL = "docs/explainer/template.html"
OUT_REL = "EXPLAINER.html"
BUILD = "python3 scripts/explainer_build.py"

# A tutorial file name: two digits, a dash, a slug, `.json`. The digits give the order.
TUTORIAL_NAME = re.compile(r"^[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.json$")
PAGE_KEYS = {"title", "subtitle", "badge", "intro", "people", "glossary", "notVerified", "links"}
BLOCK_KEYS = {"p": {"kind", "text"}, "list": {"kind", "items"}, "steps": {"kind", "items"},
              "table": {"kind", "head", "rows"}, "heading": {"kind", "id", "text"}}
TUTORIAL_KEYS = {"title", "who", "goal", "place", "steps", "learned", "cannot", "notVerified"}
STEP_KEYS = {"title", "before", "frame", "after"}
FRAME_KEYS = {"kind", "title", "source", "live", "lines"}
FRAME_KINDS = {"shell": "Terminal", "pi": "Pi", "claude": "Claude Code", "file": "File", "send": "Bitwarden Send"}
# The keys of each line kind. `text` keeps its line breaks.
LINE_KEYS = {
    "cmd": {"t", "prompt", "text"},
    "out": {"t", "text"},
    "err": {"t", "text"},
    "ask": {"t", "text", "answer"},
    "user": {"t", "text"},
    "agent": {"t", "text"},
    "tool": {"t", "name", "args", "result", "error"},
    "dialog": {"t", "title", "text", "options", "selected", "hint"},
    "hidden": {"t", "label", "text"},
    "status": {"t", "label", "text"},
    "blank": {"t"},
}
REQUIRED_LINE_KEYS = {"tool": {"t", "name", "args", "result"}, "dialog": {"t", "title", "text", "options"}}
# Inline markup of a prose string: a code span in backticks, or a link `[label](target)`.
INLINE = re.compile(r"`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:")


class BuildError(Exception):
    """A refused source. The text is `rule: field` and never holds a value of the source."""


def fail(rule, field):
    raise BuildError(f"{rule}: {field}")


def load_json(path, field):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        fail("unreadable", field)


def read_text(path, field):
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        fail("unreadable", field)


def need_keys(value, allowed, field, required=None):
    if not isinstance(value, dict):
        fail("not_an_object", field)
    unknown = sorted(set(value) - allowed)
    if unknown:
        fail("unknown_key", f"{field}.{unknown[0]}")
    missing = sorted((allowed if required is None else required) - set(value))
    if missing:
        fail("missing_key", f"{field}.{missing[0]}")


def need_text(value, field):
    if not isinstance(value, str) or not value.strip():
        fail("text", field)
    return value


def need_texts(value, field, empty=False):
    if not isinstance(value, list) or (not value and not empty):
        fail("list", field)
    return [need_text(item, f"{field}[{index}]") for index, item in enumerate(value)]


def check_target(target, field, root):
    """A link goes to a repository file or to an https page. Nothing else."""
    if target.startswith("#"):
        return
    if SCHEME.match(target):
        if not target.startswith("https://"):
            fail("link_scheme", field)
        return
    path = target.partition("#")[0]
    if path.startswith(("/", "~")) or ".." in path.split("/") or not (Path(root) / path).exists():
        fail("link_target", field)


def code_spans(text):
    """Escaped HTML of a string with its code spans and no link."""
    parts, last = [], 0
    for match in re.finditer(r"`([^`]+)`", text):
        parts.append(html.escape(text[last:match.start()], quote=False))
        parts.append(f"<code>{html.escape(match.group(1), quote=False)}</code>")
        last = match.end()
    parts.append(html.escape(text[last:], quote=False))
    return "".join(parts)


def inline(text, field, root):
    """Escaped HTML of one prose string with its code spans and links."""
    parts, last = [], 0
    for match in INLINE.finditer(text):
        parts.append(html.escape(text[last:match.start()], quote=False))
        if match.group(1) is not None:
            parts.append(f"<code>{html.escape(match.group(1), quote=False)}</code>")
        else:
            check_target(match.group(3), field, root)
            parts.append(f'<a href="{html.escape(match.group(3))}">{code_spans(match.group(2))}</a>')
        last = match.end()
    parts.append(html.escape(text[last:], quote=False))
    return "".join(parts)


def mono(text):
    """Escaped text of a terminal line. No markup."""
    return html.escape(text, quote=False)


def load(root=ROOT):
    """The checked page source and the tutorials in file-name order."""
    root = Path(root)
    page = load_json(root / PAGE_REL, PAGE_REL)
    need_keys(page, PAGE_KEYS, "page")
    for key in ("title", "subtitle", "badge"):
        need_text(page[key], f"page.{key}")
    for index, block in enumerate(page["intro"]):
        check_block(block, f"page.intro[{index}]")
    for index, person in enumerate(page["people"]):
        need_keys(person, {"name", "actorId", "role"}, f"page.people[{index}]")
    for index, entry in enumerate(page["glossary"]):
        need_keys(entry, {"term", "text"}, f"page.glossary[{index}]")
    need_texts(page["notVerified"], "page.notVerified")
    for index, link in enumerate(page["links"]):
        need_keys(link, {"label", "target", "text"}, f"page.links[{index}]")
    directory = root / TUTORIALS_REL
    names = sorted(path.name for path in directory.iterdir()) if directory.is_dir() else []
    if not names:
        fail("no_tutorial", TUTORIALS_REL)
    tutorials = []
    for name in names:
        if not TUTORIAL_NAME.match(name):
            fail("tutorial_name", f"{TUTORIALS_REL}/{name}")
        field = f"{TUTORIALS_REL}/{name}"
        tutorial = load_json(directory / name, field)
        check_tutorial(tutorial, field)
        tutorials.append(tutorial)
    return page, tutorials


def check_block(block, field):
    if not isinstance(block, dict) or block.get("kind") not in BLOCK_KEYS:
        fail("block_kind", field)
    need_keys(block, BLOCK_KEYS[block["kind"]], field)
    if block["kind"] in ("list", "steps"):
        need_texts(block["items"], f"{field}.items")
    elif block["kind"] == "table":
        need_texts(block["head"], f"{field}.head")
        for index, row in enumerate(block["rows"]):
            if len(need_texts(row, f"{field}.rows[{index}]")) != len(block["head"]):
                fail("table_row", f"{field}.rows[{index}]")


def check_tutorial(tutorial, field):
    need_keys(tutorial, TUTORIAL_KEYS, field)
    for key in ("title", "who", "goal", "place"):
        need_text(tutorial[key], f"{field}.{key}")
    if not isinstance(tutorial["steps"], list) or not tutorial["steps"]:
        fail("list", f"{field}.steps")
    for index, step in enumerate(tutorial["steps"]):
        where = f"{field}.steps[{index}]"
        need_keys(step, STEP_KEYS, where, required={"title", "before", "frame"})
        need_text(step["title"], f"{where}.title")
        need_texts(step["before"], f"{where}.before")
        need_texts(step.get("after", []), f"{where}.after", empty=True)
        check_frame(step["frame"], f"{where}.frame")
    need_texts(tutorial["learned"], f"{field}.learned")
    need_texts(tutorial["cannot"], f"{field}.cannot")
    need_texts(tutorial["notVerified"], f"{field}.notVerified", empty=True)


def check_frame(frame, field):
    need_keys(frame, FRAME_KEYS, field)
    if frame["kind"] not in FRAME_KINDS:
        fail("frame_kind", field)
    need_text(frame["title"], f"{field}.title")
    need_text(frame["source"], f"{field}.source")
    if not isinstance(frame["live"], bool):
        fail("live", field)
    if not isinstance(frame["lines"], list) or not frame["lines"]:
        fail("list", f"{field}.lines")
    for index, line in enumerate(frame["lines"]):
        where = f"{field}.lines[{index}]"
        if not isinstance(line, dict) or line.get("t") not in LINE_KEYS:
            fail("line_kind", where)
        need_keys(line, LINE_KEYS[line["t"]], where, required=REQUIRED_LINE_KEYS.get(line["t"]))
        for key, value in line.items():
            if key == "options":
                need_texts(value, f"{where}.options")
            elif key == "selected":
                if not isinstance(value, int) or not 0 <= value < len(line["options"]):
                    fail("selected", where)
            elif key == "error":
                if not isinstance(value, bool):
                    fail("error", where)
            elif key in ("text", "args", "result", "answer", "prompt"):
                if not isinstance(value, str):
                    fail("text", f"{where}.{key}")
            elif key != "t":
                need_text(value, f"{where}.{key}")


# --- rendering ---------------------------------------------------------------------------------------

def render_block(block, root, field):
    kind = block["kind"]
    if kind == "p":
        return f"<p>{inline(block['text'], field, root)}</p>"
    if kind == "heading":
        return f'<h3 id="{html.escape(block["id"])}">{inline(block["text"], field, root)}</h3>'
    if kind in ("list", "steps"):
        tag = "ol" if kind == "steps" else "ul"
        items = "".join(f"<li>{inline(item, field, root)}</li>" for item in block["items"])
        return f"<{tag}>{items}</{tag}>"
    head = "".join(f"<th>{inline(cell, field, root)}</th>" for cell in block["head"])
    rows = "".join("<tr>" + "".join(f"<td>{inline(cell, field, root)}</td>" for cell in row) + "</tr>"
                   for row in block["rows"])
    return f'<div class="table"><table><thead><tr>{head}</tr></thead><tbody>{rows}</tbody></table></div>'


def render_line(line, kind):
    t = line["t"]
    if t == "blank":
        return '<div class="ln blank"> </div>'
    if t == "cmd":
        return (f'<div class="ln cmd"><span class="ps">{mono(line["prompt"])}</span> '
                f'<span class="typed">{mono(line["text"])}</span></div>')
    if t == "ask":
        return (f'<div class="ln ask">{mono(line["text"])}<span class="typed">{mono(line["answer"])}</span></div>')
    if t in ("out", "err"):
        return f'<div class="ln {t}">{mono(line["text"])}</div>'
    if t == "user":
        mark = "&gt; " if kind == "claude" else ""
        return f'<div class="ln user">{mark}{mono(line["text"])}</div>'
    if t == "agent":
        mark = '<span class="bullet">&#x25CF;</span> ' if kind == "claude" else ""
        return f'<div class="ln agent">{mark}{mono(line["text"])}</div>'
    if t == "tool":
        state = " failed" if line.get("error") else ""
        if kind == "claude":
            return (f'<div class="tool claude{state}"><div class="ln call"><span class="bullet">&#x25CF;</span> '
                    f'<b>{mono(line["name"])}</b>{mono(line["args"])}</div>'
                    f'<div class="ln result">  &#x2514;  {mono(line["result"])}</div></div>')
        # Pi: the call line `name key="value"`, then the output text. A pending call has no output yet.
        state = state or ("" if line["result"] else " pending")
        result = f'<div class="ln result">{mono(line["result"])}</div>' if line["result"] else ""
        return (f'<div class="tool pi{state}"><div class="ln call"><b>{mono(line["name"])}</b> '
                f'<span class="args">{mono(line["args"])}</span></div>{result}</div>')
    if t == "dialog":
        selected = line.get("selected", 0)
        options = []
        for index, option in enumerate(line["options"]):
            if kind == "claude":
                mark = "&#x276F; " if index == selected else "  "
            else:
                mark = "&#x2192; " if index == selected else "  "
            options.append(f'<div class="ln opt{" on" if index == selected else ""}">{mark}{mono(option)}</div>')
        hint = f'<div class="ln hint">{mono(line["hint"])}</div>' if line.get("hint") else ""
        return (f'<div class="dialog {kind}"><div class="ln dtitle">{mono(line["title"])}</div>'
                f'<div class="ln dtext">{mono(line["text"])}</div>{"".join(options)}{hint}</div>')
    label = mono(line["label"])
    return (f'<div class="{t}"><div class="ln label">{label}</div>'
            f'<div class="ln">{mono(line["text"])}</div></div>')


def render_frame(frame, caption, root):
    kind = frame["kind"]
    lines = "".join(render_line(line, kind) for line in frame["lines"])
    if frame["live"]:
        shape = f"Shape from a live run. Source: {inline(frame['source'], 'frame.source', root)}."
    else:
        shape = (f'Not verified: no live run produced this frame. It is rendered from '
                 f'{inline(frame["source"], "frame.source", root)}. See <a href="#not-verified">Not verified</a>.')
    return (f'<figure class="frame {kind}" aria-label="{html.escape(caption)}">'
            f'<div class="bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>'
            f'<span class="ttl">{mono(frame["title"])}</span><span class="kind">{FRAME_KINDS[kind]}</span></div>'
            f'<div class="screen">{lines}</div>'
            f'<figcaption>{shape}</figcaption></figure>')


def render_tutorial(number, tutorial, root):
    field = f"tutorial {number}"
    out = [f'<section class="tutorial" id="tutorial-{number}" aria-labelledby="tutorial-{number}-title">',
           f'<p class="eyebrow">Tutorial {number} &middot; {inline(tutorial["who"], field, root)}</p>',
           f'<h2 id="tutorial-{number}-title">{inline(tutorial["title"], field, root)}</h2>',
           f'<p class="goal">{inline(tutorial["goal"], field, root)}</p>',
           f'<p class="place"><span>Where:</span> {inline(tutorial["place"], field, root)}</p>',
           '<ol class="steps">']
    for index, step in enumerate(tutorial["steps"], 1):
        out.append(f'<li class="step" id="tutorial-{number}-step-{index}">')
        out.append(f'<h3><span class="n">{number}.{index}</span> {inline(step["title"], field, root)}</h3>')
        out.extend(f"<p>{inline(text, field, root)}</p>" for text in step["before"])
        out.append(render_frame(step["frame"], step["title"], root))
        out.extend(f"<p>{inline(text, field, root)}</p>" for text in step.get("after", []))
        out.append("</li>")
    out.append("</ol>")
    out.append('<div class="wrap-up"><div class="learned"><h3>What you learned</h3><ul>')
    out.extend(f"<li>{inline(item, field, root)}</li>" for item in tutorial["learned"])
    out.append('</ul></div><div class="cannot"><h3>What cannot happen</h3><ul>')
    out.extend(f"<li>{inline(item, field, root)}</li>" for item in tutorial["cannot"])
    out.append("</ul></div></div></section>")
    return "\n".join(out)


def not_verified_rows(tutorials):
    """(tutorial number, step number, step title, frame source) of each frame that no live run produced."""
    return [(number, index, step["title"], step["frame"]["source"])
            for number, tutorial in enumerate(tutorials, 1)
            for index, step in enumerate(tutorial["steps"], 1) if not step["frame"]["live"]]


def render(page, tutorials, root=ROOT):
    """One self-contained HTML document."""
    root = Path(root)
    toc = ['<li><a href="#before-you-start">Before you start</a></li>']
    toc += [f'<li><a href="#tutorial-{number}"><span class="n">{number}</span> {inline(t["title"], "toc", root)}</a></li>'
            for number, t in enumerate(tutorials, 1)]
    toc += ['<li><a href="#glossary">Glossary</a></li>', '<li><a href="#documents">The documents</a></li>',
            '<li><a href="#not-verified">Not verified</a></li>']
    body = ['<section id="before-you-start" aria-labelledby="before-you-start-title">',
            '<h2 id="before-you-start-title">Before you start</h2>']
    body += [render_block(block, root, f"page.intro[{index}]") for index, block in enumerate(page["intro"])]
    people = "".join(f"<tr><td>{inline(p['name'], 'people', root)}</td><td><code>{mono(p['actorId'])}</code></td>"
                     f"<td>{inline(p['role'], 'people', root)}</td></tr>" for p in page["people"])
    body.append('<h3 id="the-example-people">The four example people</h3>')
    body.append('<div class="table"><table><thead><tr><th>Person</th><th>actorId</th><th>Role in the tutorials</th></tr>'
                f"</thead><tbody>{people}</tbody></table></div>")
    body.append("</section>")
    body += [render_tutorial(number, tutorial, root) for number, tutorial in enumerate(tutorials, 1)]
    glossary = "".join(f'<dt id="term-{re.sub(r"[^a-z0-9]+", "-", entry["term"].lower()).strip("-")}">'
                       f'{inline(entry["term"], "glossary", root)}</dt><dd>{inline(entry["text"], "glossary", root)}</dd>'
                       for entry in page["glossary"])
    body.append(f'<section id="glossary" aria-labelledby="glossary-title"><h2 id="glossary-title">Glossary</h2>'
                f'<dl class="glossary">{glossary}</dl></section>')
    links = "".join(f'<li><a href="{html.escape(link["target"])}">{inline(link["label"], "links", root)}</a>: '
                    f'{inline(link["text"], "links", root)}</li>' for link in page["links"])
    for index, link in enumerate(page["links"]):
        check_target(link["target"], f"page.links[{index}]", root)
    body.append(f'<section id="documents" aria-labelledby="documents-title"><h2 id="documents-title">The documents</h2>'
                f"<ul>{links}</ul></section>")
    general = "".join(f"<li>{inline(item, 'notVerified', root)}</li>" for item in page["notVerified"])
    specific = "".join(f"<li><b>Tutorial {number}.</b> {inline(item, 'notVerified', root)}</li>"
                       for number, tutorial in enumerate(tutorials, 1) for item in tutorial["notVerified"])
    rows = "".join(f'<tr><td><a href="#tutorial-{number}-step-{index}">{number}.{index}</a></td>'
                   f"<td>{inline(title, 'notVerified', root)}</td><td>{inline(source, 'notVerified', root)}</td></tr>"
                   for number, index, title, source in not_verified_rows(tutorials))
    body.append('<section id="not-verified" aria-labelledby="not-verified-title"><h2 id="not-verified-title">Not verified</h2>'
                f"<ul>{general}{specific}</ul>"
                '<h3 id="frames-without-a-live-run">Frames without a live run</h3>'
                "<p>Each frame below shows an output shape that no live run produced. "
                "The table names the code, the test or the documentation that the shape comes from.</p>"
                '<div class="table"><table><thead><tr><th>Step</th><th>Frame</th><th>Shape from</th></tr></thead>'
                f"<tbody>{rows}</tbody></table></div></section>")
    template = read_text(root / TEMPLATE_REL, TEMPLATE_REL)
    css = read_text(root / CSS_REL, CSS_REL)
    for token in ("__TITLE__", "__SUBTITLE__", "__BADGE__", "__CSS__", "__TOC__", "__BODY__", "__BUILD__"):
        if token not in template:
            fail("template_token", token)
    values = {
        "__TITLE__": html.escape(page["title"]), "__SUBTITLE__": inline(page["subtitle"], "page.subtitle", root),
        "__BADGE__": html.escape(page["badge"]), "__CSS__": css.strip(), "__TOC__": "\n".join(toc),
        "__BODY__": "\n".join(body), "__BUILD__": html.escape(BUILD),
    }
    # One pass over the template: a value can never be read as a token.
    return re.sub(r"__[A-Z]+__", lambda match: values.get(match.group(0), match.group(0)), template)


def build(root=ROOT):
    page, tutorials = load(root)
    return render(page, tutorials, root)


def main(argv=None, root=ROOT):
    parser = argparse.ArgumentParser(description="Build the self-contained shared memory tutorials EXPLAINER.html.")
    parser.add_argument("--check", action="store_true", help="write nothing; exit 1 when the file differs")
    args = parser.parse_args(argv)
    out = Path(root) / OUT_REL
    try:
        text = build(root)
    except BuildError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if args.check:
        current = out.read_text(encoding="utf-8") if out.is_file() else None
        print(f"explainer {'current' if current == text else 'differs'}: {OUT_REL}")
        return 0 if current == text else 1
    out.write_text(text, encoding="utf-8")
    print(f"explainer written: {OUT_REL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
