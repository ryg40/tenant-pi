"""Opt-in publication of the rendered brief to an artifact service.

The endpoint, credential file and receipt directory are configuration. Nothing here
runs unless the owner asks for publication.

Contract (artifact service v1):
- First publication: POST {endpoint}/v1/artifacts with `Authorization: Bearer`, a
  stable `Idempotency-Key` and a JSON body {content, contentType, fileName, title}.
  The response holds `shareUrl`, `artifact` (with `slug`, `expiresAt`) and `editToken`.
- Refresh: PUT {endpoint}/v1/artifacts/{slug} with the bearer token and
  `X-Orca-Edit-Token`. The link stays the same.
- Verify: GET the HTTPS share URL; expect HTTP 200 and the exact uploaded bytes.

The full create response (with the edit token) goes to a mode-0600 receipt outside
Git. Tokens never enter logs, errors, the state directory, Markdown or HTML.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from tracker.checkpoint import (atomic_write, format_utc, home_relative, one_line, read_json, redact,
                                sha256_text, utc_now, write_json)

HttpRequest = Callable[[str, str, dict, "bytes | None"], tuple]
DEFAULT_FILE_NAME = "tracker-brief.html"


class PublishError(RuntimeError):
    pass


def default_http(method: str, url: str, headers: dict, body: bytes | None = None, timeout: int = 30) -> tuple:
    """Send one request. Returns (status, lower-case headers, body bytes)."""
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, {k.lower(): v for k, v in (exc.headers or {}).items()}, exc.read() or b""
    except (urllib.error.URLError, OSError) as exc:
        raise PublishError("network error: %s" % one_line(getattr(exc, "reason", exc), 200)) from exc


def _https(url: str | None, what: str) -> str:
    parts = urllib.parse.urlsplit((url or "").strip())
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise PublishError("%s must be a credential-free HTTPS URL" % what)
    return urllib.parse.urlunsplit(parts).rstrip("/")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def idempotency_key(repo_slug: str, content: str) -> str:
    """Stable key for one content version. A retry of the same content reuses it."""
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", repo_slug)[:40].strip("-") or "repo"
    return "tracker-%s-%s" % (slug, sha256_text(content)[:32])


def read_credential(path) -> str:
    try:
        value = Path(path).expanduser().read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise PublishError("credential file not found: %s" % home_relative(path)) from exc
    except OSError as exc:
        raise PublishError("credential file cannot be read: %s" % home_relative(path)) from exc
    if not value:
        raise PublishError("credential file is empty: %s" % home_relative(path))
    return value


class Publisher:
    def __init__(self, *, endpoint: str, credential_file, receipt_dir, repo_slug: str, state_dir,
                 title: str, repo_root=None, file_name: str = DEFAULT_FILE_NAME,
                 http: HttpRequest | None = None, clock=None):
        self.endpoint = _https(endpoint, "publication endpoint")
        self.credential_file = Path(credential_file).expanduser() if credential_file else None
        self.receipt_dir = Path(receipt_dir).expanduser()
        self.repo_slug = repo_slug
        self.state_dir = Path(state_dir)
        self.title = one_line(title, 120)
        self.file_name = file_name
        self.http = http or default_http
        self.clock = clock or utc_now
        # Receipts hold the edit token: keep them out of the repository and the state directory.
        for root, what in ((repo_root, "the repository"), (self.state_dir, "the state directory")):
            if root and _inside(self.receipt_dir, Path(root)):
                raise PublishError("receipt directory must be outside %s: %s"
                                   % (what, home_relative(self.receipt_dir)))

    @property
    def receipt_path(self) -> Path:
        return self.receipt_dir / ("%s.json" % self.repo_slug)

    @property
    def record_path(self) -> Path:
        return self.state_dir / "publication.json"

    def _save_receipt(self, data: dict) -> None:
        self.receipt_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.receipt_dir, 0o700)
        atomic_write(self.receipt_path, json.dumps(data, indent=2) + "\n", 0o600)

    def load_receipt(self) -> dict | None:
        return read_json(self.receipt_path)

    def _request(self, method: str, url: str, headers: dict, payload: dict | None, secrets: list) -> tuple:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        try:
            status, resp_headers, data = self.http(method, url, headers, body)
        except PublishError as exc:
            raise PublishError(redact(str(exc), secrets)) from None
        except Exception as exc:  # any transport failure becomes a queued retry, never a crash
            raise PublishError(redact("request failed: %s" % one_line(exc, 200), secrets)) from None
        return status, resp_headers, data

    @staticmethod
    def _code(data: bytes) -> str:
        try:
            parsed = json.loads(data.decode("utf-8"))
            return one_line(parsed.get("code"), 60) if isinstance(parsed, dict) else ""
        except (ValueError, UnicodeDecodeError, AttributeError):
            return ""

    def publish(self, html: str, *, replace: bool = False) -> dict:
        """Publish or refresh the brief. Returns a result without any secret."""
        if not self.credential_file:
            raise PublishError("publication credential file is not configured")
        token = read_credential(self.credential_file)
        receipt = self.load_receipt()
        edit_token = (receipt or {}).get("editToken")
        secrets = [token, edit_token]
        payload = {"content": html, "contentType": "text/html", "fileName": self.file_name, "title": self.title}
        base_headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
                        "Accept": "application/json"}
        slug = ((receipt or {}).get("artifact") or {}).get("slug")
        if receipt and slug and edit_token and not replace:
            method = "PUT"
            url = "%s/v1/artifacts/%s" % (self.endpoint, urllib.parse.quote(slug))
            status, _, data = self._request("PUT", url, dict(base_headers, **{"X-Orca-Edit-Token": edit_token}),
                                            payload, secrets)
            if status == 404:
                raise PublishError("the existing artifact is expired or deleted; rerun publish with --replace "
                                   "to create a new link")
            if status != 200:
                raise PublishError("update failed with HTTP %s %s" % (status, self._code(data)))
            response = json.loads(data.decode("utf-8"))
            receipt = dict(receipt, artifact=response.get("artifact") or receipt.get("artifact"),
                           shareUrl=response.get("shareUrl") or receipt.get("shareUrl"),
                           updated=format_utc(self.clock()))
            self._save_receipt(receipt)
        else:
            if receipt and not replace:
                raise PublishError("a receipt exists without edit authority; rerun publish with --replace "
                                   "to create a new link")
            if receipt and replace:
                stamp = self.clock().strftime("%Y%m%dT%H%M%SZ")
                atomic_write(self.receipt_dir / ("%s.replaced-%s.json" % (self.repo_slug, stamp)),
                             self.receipt_path.read_text(encoding="utf-8"), 0o600)
            method = "POST"
            key = idempotency_key(self.repo_slug, html)
            record = read_json(self.record_path) or {}
            record.update(pending_key=key, pending_sha256=sha256_text(html))
            write_json(self.record_path, record)
            status, _, data = self._request("POST", self.endpoint + "/v1/artifacts",
                                            dict(base_headers, **{"Idempotency-Key": key}), payload, secrets)
            if status == 409:
                raise PublishError("the idempotency key was already used for different content")
            if status not in (200, 201):
                raise PublishError("create failed with HTTP %s %s" % (status, self._code(data)))
            response = json.loads(data.decode("utf-8"))
            if not response.get("editToken") or not (response.get("artifact") or {}).get("slug"):
                raise PublishError("create response lacks the artifact slug or edit token")
            secrets.append(response.get("editToken"))
            receipt = dict(response, endpoint=self.endpoint, idempotencyKey=key, created=format_utc(self.clock()))
            self._save_receipt(receipt)
        share_url = _https(receipt.get("shareUrl"), "share URL")
        status, _, data = self._request("GET", share_url, {"Accept": "text/html"}, None, secrets)
        verified = status == 200 and data == html.encode("utf-8")
        artifact = receipt.get("artifact") or {}
        result = {
            "share_url": share_url, "slug": artifact.get("slug"), "method": method,
            "published": format_utc(self.clock()), "expires": artifact.get("expiresAt"),
            "content_sha256": sha256_text(html), "verified": verified,
            "receipt": home_relative(self.receipt_path),
        }
        write_json(self.record_path, result)
        if not verified:
            raise PublishError("verification failed: HTTP %s or content differs from the upload" % status)
        return result
