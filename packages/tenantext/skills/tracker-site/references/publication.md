# Publication

Publish only when the user asks. Publication never runs by default, in the background, or on a timer.

## Configuration

Set `publish.endpoint` (the artifact service origin, for example `https://artifacts.example.com`) and `publish.credential_file` (a file that holds the service token, mode 0600). See [configuration.md](configuration.md). The tool reads the token into memory only. It never prints or writes it.

## Service contract (artifact service API v1)

- Create: `POST {endpoint}/v1/artifacts` with `Authorization: Bearer <token>` and `Idempotency-Key`. Body: `content` (the HTML), `contentType` (`text/html`), `fileName` (`tracker-brief.html`), `title`. The response holds `shareUrl`, `artifact` (with `slug` and `expiresAt`) and `editToken`.
- Refresh: `PUT {endpoint}/v1/artifacts/{slug}` with the bearer token and the edit token in the edit-token header. The link stays the same.
- Verify: `GET` the HTTPS share URL. Expect HTTP 200 and exactly the uploaded bytes.
- The service returns 409 when a key is reused with different content, and 404 for an expired or deleted link.

The name of the edit-token header differs between services. The default is `X-Edit-Token`. Set `publish.edit_token_header` to the name that your service documents. With the wrong name, the service refuses the refresh, usually with HTTP 403; the first publication still works. A setup that used the old fixed header name sets `publish.edit_token_header` to that name.

Check the service's own README before the first use on a new installation.

## What the tool does

1. It derives the idempotency key from the repository slug and the content hash. A retry of the same HTML reuses the key, so a lost response never creates a second artifact.
2. It stores the full create response, with the edit token, in `<receipt dir>/<repo-slug>.json`. The file has mode 0600. The directory has mode 0700. The tool refuses a receipt directory inside the repository or the state directory. The default is `~/.pi/agent/tracker-publications/`.
3. It refreshes the existing link with PUT when a receipt exists.
4. It verifies the page and writes `publication.json` in the state directory: link, slug, expiry, content hash, verification result. No tokens.
5. On failure it keeps the local HTML and Markdown, writes `publish-queue.json`, and marks the stage `queued`. Retry with `tracker publish`.
6. When the old link expired or the receipt lacks edit authority, it stops and says so. `tracker publish --replace` creates a new link and keeps the old receipt as `<repo-slug>.replaced-<time>.json`.

## What to report

Tell the user the link, the expiry date, and whether verification passed. State the access limits: anyone who can reach the artifact service and has the link can read the page, and the service may list active links. Links are not per-reader authentication.

## Page constraints

The service Content Security Policy blocks external resources and network requests. The rendered page is self-contained: inline CSS and JavaScript, no CDN, no fonts from the network, no forms, no polling.

## Not verified

The tool is tested against an offline fake of this contract. A live publication has not been run from this package.
