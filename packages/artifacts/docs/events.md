# The event channel

The local server of `packages/artifacts` has one live channel for a desktop app, for example the Herdr app (Sheprd). The app connects one time and then gets one message for each change. It needs no poll of the store, of the Walkr sessions or of `artifacts --json status`.

The channel goes one way: from the server to the app. It is an event stream over plain HTTP (`text/event-stream`, Server-Sent Events). This document is the contract. Its version is 1.

## Address

```text
GET http://127.0.0.1:<port>/events/v1
```

- `<port>` is the port of the local server (6790 by default). Through a port forward, use the local port of the forward.
- `artifacts --json status` names the address and the token file while the server runs:

  ```json
  {"events": {"url": "http://127.0.0.1:6790/events/v1", "version": 1, "token_file": "/home/me/.local/state/tenant-artifacts/events-token"}}
  ```

  The key `events` is absent when the server is stopped or is older than the channel.
- The server listens on `127.0.0.1` only. It answers a request only from a loopback peer with a loopback name in the `Host` header, as for each page.
- The path takes no query. `/events/v1?x` is not the channel and gets 404.

## Sign-in

Send the token as a Bearer credential:

```text
GET /events/v1 HTTP/1.1
Host: 127.0.0.1:6790
Authorization: Bearer <token>
Accept: text/event-stream
```

- The token is in the file `events-token` of the state directory of the server, by default `~/.local/state/tenant-artifacts/events-token`. The file has mode 0600, so only the user of the server reads it. For another computer, read the file over the SSH connection that you have to that computer.
- The server makes a new token at each start. After a 401, read the file again.
- The token is 64 hex characters. The server compares it in constant time.
- The token is in no status answer, in no address and in no log line. Do not put it in a URL.
- A request with an `Origin` header or a `Sec-Fetch-Site` header is a request of a web page. It gets 403 before the token check, also with a valid token. So no page in a browser opens the channel. A client must not send these two headers.

## Answers

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | The stream | Signed in. |
| 401 | `{"error": {"code": "UNAUTHORIZED", ...}}` | No token, or a wrong token. Read the token file again. |
| 403 | `{"error": {"code": "FORBIDDEN", ...}}` or a text line | A page header (`Origin`, `Sec-Fetch-Site`), or a `Host` that is not loopback. |
| 405 | A text line | Another method than GET. |
| 503 | `{"error": {"code": "BUSY", ...}}` | 8 clients are connected. Try again later. |

## The stream

Each message has three lines and an empty line:

```text
event: <kind>
id: <epoch>-<seq>
data: <one JSON object in one line>

```

- A line that starts with `:` is a comment. The server sends `: open` at the start and `: beat` after 15 seconds with no message. A client that gets no byte for 45 seconds can take the link as dead and connect again.
- `seq` is the sequence number of the event in this server run. It starts at 1 and grows by 1. `epoch` is 12 hex characters and names the server run.
- The first message of a new connection has the kind `state`. Its `seq` is the number of the last event that the state includes.
- The server ends the stream when it stops. Its last message is `module.stopped` with the ID `artifacts`.

### state

The present state: the counts and the open items.

```json
{"kind": "state", "version": 1, "epoch": "1a2b3c4d5e6f", "seq": 12, "time": "2026-11-23T10:15:00Z",
 "artifacts": {"count": 3},
 "compare": {"waiting": 1, "unreceived": 0,
             "sessions": [{"id": "20261123T101400Z-0a1b2c3d4e5f", "title": "Which layout?", "createdAt": "2026-11-23T10:14:00.000Z", "workflow": "layout-options", "repo": "example-app"}]},
 "modules": {"artifacts": "running", "walkr": "running", "memory": "stopped"}}
```

| Field | Meaning |
| --- | --- |
| `artifacts.count` | The count of all stored artifacts, including the archive. |
| `compare.waiting` | The count of Compare sessions that wait for a pick (status `open`). |
| `compare.unreceived` | The count of submitted results that the agent did not confirm yet and that have no outcome. |
| `compare.sessions` | The waiting sessions, the newest first, at most 100. `repo` is present only when the session names a repository. |
| `modules` | Each installed module with `running` or `stopped`. `walkr` is `running` while the live Walkr server answers. A module that is not installed is absent. |

### Events

Each event has `kind`, `id`, `time` (UTC, to the second) and `seq`. Some have more fields.

| Kind | `id` | More fields | When |
| --- | --- | --- | --- |
| `artifact.added` | The slug | `title` | An artifact is new in the store. |
| `artifact.changed` | The slug | `title` | An artifact has a new version (`upload --replace`). |
| `artifact.archived` | The slug | `title` | An artifact moved to the archive. The count stays the same. |
| `artifact.restored` | The slug | `title` | An artifact moved back to the index. The count stays the same. |
| `artifact.removed` | The slug | None | An artifact left the store (`delete`, or the retention sweep). |
| `compare.waiting` | The session ID | `title`, `createdAt`, `workflow`, `repo` (only when named) | A Compare session was created and waits for a pick. |
| `compare.submitted` | The session ID | `title` | The user submitted the result of a session. |
| `compare.received` | The session ID | None | The agent confirmed that it received the result. |
| `module.started` | The module name | None | A module started: `walkr`, `memory`. |
| `module.stopped` | The module name | None | A module stopped. `artifacts` is the server itself: the stream ends after it. |

```text
event: compare.waiting
id: 1a2b3c4d5e6f-13
data: {"kind":"compare.waiting","id":"20261123T101600Z-6f5e4d3c2b1a","time":"2026-11-23T10:16:01Z","seq":13,"title":"Which wording?","createdAt":"2026-11-23T10:16:00.000Z","workflow":"text-revision"}

event: artifact.added
id: 1a2b3c4d5e6f-14
data: {"kind":"artifact.added","id":"AbCdEfGhIjKlMnOpQrStUvWxYz012345","time":"2026-11-23T10:17:10Z","seq":14,"title":"Weekly report"}
```

The page of an item:

| Item | Page on the port of the server |
| --- | --- |
| An artifact | `/v/<slug>` |
| The main list / archive list | `/artifacts` / `/artifacts/archive` |
| A Compare session | The address that `artifacts walkr-url <session ID>` prints. Its path holds a secret of the Walkr server run, so no event holds it. `/walkr` leads to the same page without a selected session. |
| The memory viewer | `/memory/` |

## Order and resume

- The events of one stream come in the order of `seq`, with no gap.
- A client that comes back sends the ID of its last message: `Last-Event-ID: <epoch>-<seq>`.
  - Same epoch, and the server still keeps each later event: the client gets those events, in order, and no `state`.
  - Another epoch (the server started again), an ID that the server does not know, or events that are no longer kept: the client gets `state` first. Then it replaces what it knows with that state.
- The server keeps the last 512 events of its run.
- An event can arrive up to 2 seconds after the change, plus the time of one read of the store. The server reads its sources every 2 seconds while a client is connected, and one time at each connect. So a client that comes back also gets the changes from the time when no client was connected.
- A change that starts and ends between two reads shows only its end state. For example, an artifact that is added and deleted in one second gives no event.
- A title has at most 200 characters. A message has at most 16 KiB; a larger one loses its title and its session list, never its counts or identifiers.

## Limits

| Limit | Value | Effect |
| --- | --- | --- |
| Clients at one time | 8 | One more gets 503. |
| Bytes of one message | 16 KiB | See above. |
| Waiting messages of one client | 256 | A client that does not read is closed. |
| Time of one write | 10 seconds | A client that does not read is closed. |
| Kept events | 512 | An older `Last-Event-ID` gets `state`. |
| Listed waiting sessions | 100 | The count `compare.waiting` is always complete. |

## Where the events come from

The server calls no other program for the events and sends the Walkr server no request.

- Artifacts: the server reads its own store.
- Compare: the server reads the session records of the default Compare root, `~/.local/.walkr/compare/sessions/<id>/session.json`. It follows no symlink, reads only a regular file of at most 16 MiB, and reads a record again only when the file changed. It reads no agent token. The read does not keep the Walkr server awake.
- Modules: the health check of the live Walkr server (`/health`, no sign of use), and the state of the memory process.

## Versions

- The answer field `version` and the path `/events/v1` name the version of this contract.
- A new field in a message, a new event kind or a new module name is no new version. A client must ignore a field and a kind that it does not know.
- A change that an old client cannot read (a removed field, another meaning, another sign-in) gets version 2 on `/events/v2`. The server then keeps `/events/v1` for at least one release, and `status` names the newest version.
- Commands from the app to the server are not a part of version 1. A later version can add a `POST` route beside the stream with the same token.

## Test client

`artifacts events` is a small client for a person. It reads the token file, connects and prints each message as one line, `<kind> <JSON>`:

```sh
artifacts events                 # until Ctrl-C or the stop of the server
artifacts events --count 3       # end after 3 messages
artifacts events --last-id 1a2b3c4d5e6f-12
```

Exit code 3: no server with a channel runs, the token file cannot be read, or the channel refused the request.
