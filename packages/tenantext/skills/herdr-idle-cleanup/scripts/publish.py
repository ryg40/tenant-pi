"""The publish step of herdr-idle-cleanup: render a handoff to HTML, scan both files, upload on request.

Standard library only. The owner starts this step; no other command calls it.

1. Render `<stamp>.md` to one self-contained HTML file `<stamp>.html` beside it (mode 0600): inline CSS, no
   script, no external file, no network.
2. Run the secret scanner on both files. The scanner is the setting `secret_scan_command` (an argv list), else
   `scripts/scan.sh --level warn tree` of the kit tree that holds this script. The command runs with no shell in
   a new scratch Git repository that holds copies of the two files, staged; exit 0 is a clean scan. No scanner,
   a finding or a scanner error stops the step.
3. Only with `--upload` and a clean scan: one POST of the HTML to `<publish_url>/v1/artifacts`, with the bearer
   token of `publish_token_file`. The token stays in this process: never in argv, a log or an output file.
"""
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

SCAN_TIMEOUT = 300
UPLOAD_TIMEOUT = 60
# The artifact service takes at most 10 MiB of content.
MAX_CONTENT = 10 * 1024 * 1024


# ---------------------------------------------------------------------------
# The handoff file
# ---------------------------------------------------------------------------
def resolve_handoff(arg, handoff_dir):
    """The path of the handoff Markdown file for a stem (`20261109-120000`) or a path (.md or .json)."""
    if os.sep in arg or arg.endswith((".md", ".json")):
        path = os.path.abspath(os.path.expanduser(arg))
    else:
        path = os.path.join(handoff_dir, arg + ".md")
    if path.endswith(".json"):
        path = path[:-len(".json")] + ".md"
    if not os.path.isfile(path):
        raise RuntimeError(f"no handoff Markdown file {path}")
    return path


# ---------------------------------------------------------------------------
# Markdown to HTML: the subset that harvest writes (headings, paragraphs, bullets, bold, code, fences)
# ---------------------------------------------------------------------------
_FENCE_RE = re.compile(r"^(~{3,}|`{3,})(.*)$")
_INLINE_RE = re.compile(r"`([^`]+)`|\*\*(.+?)\*\*")

CSS = """body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1d1d1f;background:#fff}
h1{font-size:1.6rem}h2{font-size:1.3rem;border-bottom:1px solid #ddd;padding-bottom:.2rem;margin-top:2rem}h3{font-size:1.1rem}
code{background:#f2f2f2;padding:0 .2rem;border-radius:3px}pre{background:#f6f6f6;border:1px solid #ddd;padding:.8rem;overflow-x:auto;white-space:pre-wrap}
@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#161616}code,pre{background:#262626;border-color:#333}h2{border-color:#333}}"""


def _inline(text):
    out, pos = [], 0
    for m in _INLINE_RE.finditer(text):
        out.append(html.escape(text[pos:m.start()]))
        if m.group(1) is not None:
            out.append("<code>" + html.escape(m.group(1)) + "</code>")
        else:
            out.append("<strong>" + html.escape(m.group(2)) + "</strong>")
        pos = m.end()
    out.append(html.escape(text[pos:]))
    return "".join(out)


def render_html(markdown, title):
    """One self-contained HTML page for the Markdown text. Each text is escaped; no link, image or script."""
    body, para, items = [], [], []

    def flush():
        if para:
            body.append("<p>" + _inline(" ".join(para)) + "</p>")
            para.clear()
        if items:
            body.append("<ul>" + "".join("<li>" + _inline(i) + "</li>" for i in items) + "</ul>")
            items.clear()

    lines = markdown.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        fence = _FENCE_RE.match(line)
        if fence:
            flush()
            marker, block = fence.group(1), []
            i += 1
            while i < len(lines) and lines[i] != marker:
                block.append(lines[i])
                i += 1
            body.append("<pre><code>" + html.escape("\n".join(block)) + "</code></pre>")
        elif m := re.match(r"^(#{1,3}) (.*)$", line):
            flush()
            level = len(m.group(1))
            body.append(f"<h{level}>{_inline(m.group(2))}</h{level}>")
        elif line.startswith("- "):
            if para:
                flush()
            items.append(line[2:])
        elif not line.strip():
            flush()
        elif items:
            items[-1] += " " + line.strip()
        else:
            para.append(line.strip())
        i += 1
    flush()
    return ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>{html.escape(title)}</title><style>{CSS}</style></head>\n<body>\n"
            + "\n".join(body) + "\n</body></html>\n")


def write_private(path, text):
    """Write text to path with mode 0600 through a temporary file and a rename."""
    fd, tmp = tempfile.mkstemp(prefix=".tmp.", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# The secret scan
# ---------------------------------------------------------------------------
def kit_scanner():
    """`<kit>/scripts/scan.sh --level warn tree` when this script runs from a kit tree, else None.

    Level warn: a secret or a policy finding fails; a host-value finding is printed. The artifact service is
    private, and a handoff names the local paths of its panes.
    """
    here = os.path.dirname(os.path.realpath(__file__))
    kit = os.path.abspath(os.path.join(here, "..", "..", "..", "..", ".."))
    scan = os.path.join(kit, "scripts", "scan.sh")
    if os.path.isfile(scan) and os.path.isfile(os.path.join(kit, "config", "manifest.json")):
        return ["sh", scan, "--level", "warn", "tree"]
    return None


def find_scanner(settings):
    command = settings.get("secret_scan_command")
    if command is not None:
        return list(command)
    return kit_scanner()


def _clean_git_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def scan_files(command, paths):
    """(clean, output) of the scanner on copies of paths in a new scratch Git repository."""
    work = tempfile.mkdtemp(prefix="herdr-idle-publish-")
    try:
        env = _clean_git_env()
        subprocess.run(["git", "init", "-q", work], env=env, check=True, capture_output=True, timeout=60)
        names = []
        for path in paths:
            name = os.path.basename(path)
            shutil.copyfile(path, os.path.join(work, name))
            names.append(name)
        subprocess.run(["git", "-C", work, "add", "--", *names], env=env, check=True, capture_output=True,
                       timeout=60)
        try:
            r = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=SCAN_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as e:
            return False, f"scanner did not run: {e}"
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------------------
# The upload
# ---------------------------------------------------------------------------
def read_token(path):
    with open(os.path.expanduser(path), encoding="utf-8") as f:
        token = f.read().strip()
    if not token or any(c.isspace() for c in token):
        raise RuntimeError(f"the token file {path} does not hold one token")
    return token


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Follow no redirect: urllib would send the Authorization header to the new location, also on another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def upload(publish_url, token, content, file_name, title):
    """One POST to <publish_url>/v1/artifacts, with no redirect. The parsed JSON answer; a 3xx answer fails."""
    body = json.dumps({"content": content, "contentType": "text/html", "fileName": file_name,
                       "title": title}).encode("utf-8")
    key = hashlib.sha256(file_name.encode("utf-8") + b"\0" + content.encode("utf-8")).hexdigest()
    request = urllib.request.Request(publish_url.rstrip("/") + "/v1/artifacts", data=body, method="POST", headers={
        "Content-Type": "application/json", "Idempotency-Key": key, "Authorization": "Bearer " + token})
    try:
        with urllib.request.build_opener(_NoRedirect).open(request, timeout=UPLOAD_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"upload failed: HTTP {e.code}") from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise RuntimeError(f"upload failed: {type(e).__name__}") from None


def _first(data, *keys):
    for key in keys:
        if isinstance(data, dict) and data.get(key) not in (None, ""):
            return data[key]
    return None


# ---------------------------------------------------------------------------
# The command
# ---------------------------------------------------------------------------
def publish(handoff, handoff_dir, settings, do_upload=False, out=print):
    """The publish step. 0 on success; 1 when the scan stops it."""
    url, token_file = settings.get("publish_url"), settings.get("publish_token_file")
    if do_upload and (not url or not token_file):
        raise RuntimeError("--upload needs the settings publish_url and publish_token_file")
    md_path = resolve_handoff(handoff, handoff_dir)
    stem = os.path.splitext(os.path.basename(md_path))[0]
    title = f"Herdr idle handoff {stem}"
    with open(md_path, encoding="utf-8") as f:
        markdown = f.read()
    html_path = os.path.join(os.path.dirname(md_path), stem + ".html")
    page = render_html(markdown, title)
    write_private(html_path, page)
    out(f"markdown: {md_path}")
    out(f"html: {html_path}")
    command = find_scanner(settings)
    if not command:
        out("scan: no scanner (set secret_scan_command, or run the script from a kit tree); nothing uploaded")
        return 1
    clean, report = scan_files(command, [md_path, html_path])
    warnings = 0
    for line in report.splitlines():
        line = line.removeprefix("scan: ")
        warnings += line.startswith("warn ")
        out(f"scan: {line}")
    if not clean:
        out("scan: not clean; nothing uploaded")
        return 1
    out("scan: no secret finding" + (f" ({warnings} host-value warnings)" if warnings else ""))
    if not do_upload:
        out("upload: not requested (add --upload)")
        return 0
    if len(page.encode("utf-8")) > MAX_CONTENT:
        raise RuntimeError("the HTML file is larger than 10 MiB; nothing uploaded")
    try:
        token = read_token(token_file)
    except OSError as e:
        raise RuntimeError(f"cannot read the token file {token_file}: {e.strerror}") from None
    answer = upload(url, token, page, stem + ".html", title)
    artifact = answer.get("artifact") if isinstance(answer.get("artifact"), dict) else {}
    out(f"slug: {_first(artifact, 'slug') or _first(answer, 'slug') or '-'}")
    out(f"share link: {_first(answer, 'shareUrl', 'share_url') or '-'}")
    out(f"expires: {_first(artifact, 'expiresAt', 'expires_at') or _first(answer, 'expiresAt', 'expires_at') or '-'}")
    return 0


def main_publish(args, handoff_dir, settings):
    try:
        return publish(args.handoff, handoff_dir, settings, do_upload=args.upload)
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
