"""Browser checks with Playwright: filters, empty state, keyboard details, layout, copy button.

The page is served under a strict CSP like the artifact service. The tests
skip cleanly when Playwright or a Chromium build is missing.
"""

import unittest
from pathlib import Path

from tracker.brief import parse
from tracker.render import render

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - depends on the machine
    sync_playwright = None

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "tracker-brief.md"
FIXTURE = ROOT / "tests" / "fixtures" / "prototype-fleet-72.md"
ORIGIN = "https://brief.test/"
CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
# The artifact service adds `sandbox allow-scripts`: the page origin is null there.
SANDBOX_CSP = "sandbox allow-scripts; " + CSP
WIDTHS = (1280, 390)
CLIPBOARD = ["clipboard-read", "clipboard-write"]
REJECT_WRITE = "navigator.clipboard.writeText = function () { return Promise.reject(new DOMException('denied', 'NotAllowedError')); };"
NO_CLIPBOARD_API = "Object.defineProperty(Navigator.prototype, 'clipboard', {get: function () { return undefined; }, configurable: true});"
SPY_EXEC = (
    "(function () { var run = document.execCommand; document.execCommand = function (name) {"
    " window.__exec = (window.__exec || []).concat([name]); return run.apply(document, arguments); }; })();"
)
FAIL_EXEC = "document.execCommand = function (name) { window.__exec = (window.__exec || []).concat([name]); return false; };"
STATUS_SET = "() => document.getElementById('tb-copy-status').textContent !== ''"


def _html(path):
    return render(parse(path.read_text(encoding="utf-8")))


def _long_prompt_html():
    model = parse(EXAMPLE.read_text(encoding="utf-8"))
    rows = ["Long line " + " ".join(["word"] * 60) for _ in range(5)]
    rows += ["", "https://git.example.com/owner/tenantext/" + "x" * 400, "- " + "y" * 300, "    indented " + "z" * 200]
    model["handoffs"][0]["text"] = "\n".join(rows)
    return render(model)


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sync_playwright is None:
            raise unittest.SkipTest("playwright is not installed")
        cls.pw = None
        try:
            cls.pw = sync_playwright().start()
            cls.browser = cls.pw.chromium.launch()
        except Exception as exc:  # pragma: no cover - depends on the machine
            if cls.pw is not None:
                cls.pw.stop()
            raise unittest.SkipTest(f"no Chromium for Playwright: {exc}")
        cls.pages = {"example": _html(EXAMPLE), "fixture": _html(FIXTURE), "long-prompt": _long_prompt_html()}
        cls.prompt = parse(EXAMPLE.read_text(encoding="utf-8"))["handoffs"][0]["text"]

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, name, width=1280, *, csp=CSP, permissions=(), init=""):
        html = self.pages[name]
        context = self.browser.new_context(viewport={"width": width, "height": 900}, permissions=list(permissions))
        self.addCleanup(context.close)
        if init:
            context.add_init_script(init)
        page = context.new_page()
        self.errors, self.requests = [], []
        page.on("console", lambda msg: self.errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: self.errors.append(str(exc)))
        page.on("request", lambda request: self.requests.append(request.url))

        def handle(route):
            if route.request.url == ORIGIN:
                route.fulfill(
                    status=200,
                    headers={"content-type": "text/html; charset=utf-8", "content-security-policy": csp},
                    body=html,
                )
            else:
                route.abort()

        page.route("**/*", handle)
        page.goto(ORIGIN)
        return page

    def test_loads_under_csp_without_requests_or_errors(self):
        for name in self.pages:
            with self.subTest(page=name):
                self.open(name)
                self.assertEqual(self.errors, [])
                self.assertEqual(self.requests, [ORIGIN])

    def test_register_is_collapsed_until_opened(self):
        page = self.open("fixture")
        rows = page.locator("tr.tb-issue")
        self.assertEqual(rows.count(), 72)
        self.assertFalse(rows.first.is_visible())
        page.locator("#tb-register > summary").click()
        self.assertTrue(rows.first.is_visible())
        self.assertEqual(page.locator("#tb-count").inner_text(), "72 of 72 issues shown")

    def visible_rows(self, page):
        return page.eval_on_selector_all("tr.tb-issue", "rows => rows.filter(r => !r.hidden).map(r => r.textContent.toLowerCase())")

    def test_filters_empty_state_and_reset(self):
        page = self.open("fixture")
        page.locator("#tb-register > summary").click()
        empty = page.locator("#tb-empty")

        page.fill("#tb-search", "footer")
        shown = self.visible_rows(page)
        self.assertTrue(0 < len(shown) < 72)
        self.assertTrue(all("footer" in text for text in shown))
        self.assertEqual(page.locator("#tb-count").inner_text(), f"{len(shown)} of 72 issues shown")
        self.assertFalse(empty.is_visible())

        page.fill("#tb-search", "")
        page.select_option("#tb-filter-state", "closed")
        closed = page.eval_on_selector_all("tr.tb-issue", "rows => rows.filter(r => !r.hidden).map(r => r.dataset.issueState)")
        self.assertEqual(set(closed), {"closed"})
        self.assertEqual(len(closed), 39)

        page.select_option("#tb-filter-state", "open")
        page.select_option("#tb-filter-workstream", "interface")
        both = page.eval_on_selector_all(
            "tr.tb-issue", "rows => rows.filter(r => !r.hidden).map(r => r.dataset.issueState + '/' + r.dataset.workstream)"
        )
        self.assertTrue(both)
        self.assertEqual(set(both), {"open/interface"})

        page.fill("#tb-search", "no issue matches this text")
        self.assertEqual(self.visible_rows(page), [])
        self.assertTrue(empty.is_visible())
        self.assertEqual(page.locator("#tb-count").inner_text(), "0 of 72 issues shown")

        page.click("#tb-reset")
        self.assertEqual(len(self.visible_rows(page)), 72)
        self.assertFalse(empty.is_visible())
        self.assertEqual(page.input_value("#tb-search"), "")
        self.assertEqual(page.eval_on_selector("#tb-filter-state", "s => s.selectedIndex"), 0)
        self.assertEqual(page.eval_on_selector("#tb-filter-workstream", "s => s.selectedIndex"), 0)

    def test_details_toggle_by_keyboard(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.open("example", width)
                details = page.locator(".tb-card details.tb-evidence").first
                summary = details.locator("summary")
                self.assertFalse(details.evaluate("d => d.open"))
                evidence = details.locator(".tb-ev").first
                self.assertFalse(evidence.is_visible())
                summary.focus()
                page.keyboard.press("Enter")
                self.assertTrue(details.evaluate("d => d.open"))
                self.assertTrue(evidence.is_visible())
                page.keyboard.press("Space")
                self.assertFalse(details.evaluate("d => d.open"))
                register = page.locator("#tb-register > summary")
                register.focus()
                page.keyboard.press("Enter")
                self.assertTrue(page.locator("#tb-register").evaluate("d => d.open"))

    def test_anchor_opens_collapsed_target(self):
        page = self.open("example")
        link = page.locator(".tb-alternatives a.tb-path-title").first
        target = link.get_attribute("href")
        link.click()
        self.assertTrue(page.locator("#tb-packets").evaluate("d => d.open"))
        self.assertTrue(page.locator(target).is_visible())

    def click_copy(self, page):
        button = page.get_by_role("button", name="Copy prompt for the next session")
        self.assertTrue(button.is_visible())
        button.click()
        page.wait_for_function(STATUS_SET)
        return page.inner_text("#tb-copy-status")

    def clipboard(self, write=None):
        """Read (or first overwrite) the browser clipboard from a separate page that may use it."""
        context = self.browser.new_context(permissions=CLIPBOARD)
        self.addCleanup(context.close)
        page = context.new_page()
        page.route("**/*", lambda route: route.fulfill(status=200, headers={"content-type": "text/html"}, body="<p>x</p>"))
        page.goto(ORIGIN)
        if write is not None:
            page.evaluate("text => navigator.clipboard.writeText(text)", write)
        return page.evaluate("navigator.clipboard.readText()")

    def test_copy_button_copies_inside_the_click(self):
        page = self.open("example", permissions=CLIPBOARD, init=SPY_EXEC)
        self.assertEqual(page.text_content("#tb-handoff-text"), self.prompt)
        self.assertEqual(self.clipboard(write="before"), "before")
        self.assertEqual(self.click_copy(page), "Copied")
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), self.prompt)
        self.assertEqual(page.evaluate("window.__exec"), ["copy"], "the synchronous copy runs first")
        self.assertFalse(page.locator("details.tb-handoff").evaluate("d => d.open"), "the prompt stays collapsed")
        self.assertEqual(page.get_attribute("#tb-copy-status", "aria-live"), "polite")
        self.assertEqual(self.errors, [])
        self.assertEqual(self.requests, [ORIGIN])

    def test_clipboard_api_copies_when_exec_command_fails(self):
        page = self.open("example", permissions=CLIPBOARD, init=FAIL_EXEC)
        self.assertEqual(self.clipboard(write="before"), "before")
        self.assertEqual(self.click_copy(page), "Copied")
        self.assertEqual(page.evaluate("window.__exec"), ["copy"])
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), self.prompt)
        self.assertFalse(page.locator("details.tb-handoff").evaluate("d => d.open"))
        self.assertEqual(self.errors, [])

    def test_rejected_clipboard_api_falls_back_to_exec_command(self):
        page = self.open("example", permissions=CLIPBOARD, init=REJECT_WRITE + SPY_EXEC)
        self.assertEqual(self.clipboard(write="before"), "before")
        self.assertEqual(self.click_copy(page), "Copied")
        self.assertEqual(page.evaluate("window.__exec"), ["copy"])
        self.assertEqual(page.evaluate("navigator.clipboard.readText()"), self.prompt)
        self.assertEqual(page.locator("textarea").count(), 0, "the temporary textarea is removed")
        self.assertFalse(page.locator("details.tb-handoff").evaluate("d => d.open"))
        self.assertEqual(self.errors, [])

    def test_sandboxed_null_origin_copies_with_exec_command(self):
        page = self.open("example", csp=SANDBOX_CSP, init=SPY_EXEC)
        self.assertEqual(page.evaluate("self.origin"), "null")
        self.assertEqual(self.clipboard(write="before"), "before")
        self.assertEqual(self.click_copy(page), "Copied")
        self.assertEqual(page.evaluate("window.__exec"), ["copy"], "execCommand copied inside the click")
        self.assertEqual(self.clipboard(), self.prompt)
        self.assertEqual(self.errors, [])

    def test_missing_clipboard_api_uses_exec_command(self):
        page = self.open("example", init=NO_CLIPBOARD_API + SPY_EXEC)
        self.assertEqual(self.click_copy(page), "Copied")
        self.assertEqual(page.evaluate("window.__exec"), ["copy"])
        self.assertEqual(self.errors, [])

    def test_manual_copy_when_every_copy_path_fails(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.open("example", width, init=REJECT_WRITE + FAIL_EXEC)
                self.assertEqual(self.click_copy(page), "Press Ctrl+C or Cmd+C to copy")
                self.assertEqual(page.evaluate("window.__exec"), ["copy"])
                self.assertTrue(page.locator("details.tb-handoff").evaluate("d => d.open"))
                self.assertTrue(page.locator("#tb-handoff-text").is_visible())
                self.assertEqual(page.evaluate("window.getSelection().toString()"), self.prompt)
                self.assertEqual(self.errors, [])

    def test_long_prompt_wraps_without_overflow(self):
        script = "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        for width in WIDTHS:
            with self.subTest(width=width):
                page = self.open("long-prompt", width)
                page.locator("details.tb-handoff > summary").click()
                pre = page.locator("#tb-handoff-text")
                self.assertTrue(pre.is_visible())
                self.assertLessEqual(page.evaluate(script), 0)
                self.assertLessEqual(pre.evaluate("p => p.scrollWidth - p.clientWidth"), 0)
                self.assertGreater(pre.evaluate("p => p.getBoundingClientRect().height"), 300, "long lines wrap")

    def test_no_horizontal_overflow(self):
        script = "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        for name in self.pages:
            for width in WIDTHS:
                with self.subTest(page=name, width=width):
                    page = self.open(name, width)
                    self.assertLessEqual(page.evaluate(script), 0)
                    page.evaluate("() => document.querySelectorAll('details').forEach(d => { d.open = true; })")
                    self.assertLessEqual(page.evaluate(script), 0)
                    wide = page.evaluate(
                        "() => [...document.querySelectorAll('.tb-table-wrap')].filter(w => w.scrollWidth > w.clientWidth + 1).length"
                    )
                    self.assertEqual(wide, 0)


if __name__ == "__main__":
    unittest.main()
