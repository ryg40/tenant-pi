import "./no-outer-config.js"; // First: no test reads the artifacts config of the outer user.
import test from "./posix-only-mode.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkA2uiMessages } from "../src/a2ui.js";
import { WS_LIMITS, createCompareSocketHub } from "../src/compare-socket.js";
import { CompareStore } from "../src/compare-store.js";
import { createServer } from "../src/server.js";
import { startMirror } from "../mirror/server.js";
import { listen, request } from "./server-fixtures.js";
import { tmpRoot } from "./tmp-root.js";

const API = "/_walkr/compare/api";
const IO_WATCHDOG_MS = 10_000;

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, "walkr-socket-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  return { dir, stateDir, root: path.join(dir, "walkr", "compare") };
}

async function serve(t, f, env = {}) {
  const s = await listen(t, f, { HUMAN_REVIEW_COMPARE_ROOT: f.root, ...env });
  return { ...s, agent: (route, options) => s.api(`${API}/${route}`, options) };
}

function textRequest(actionId = "create-ws") {
  return {
    actionId,
    workflow: "text-revision",
    title: "Socket test session",
    brief: "Pick one option.",
    options: [
      { optionId: "short", label: "Short", format: "text", content: "First option text." },
      { optionId: "shorter", label: "Shorter", format: "markdown", content: "Second option text." },
    ],
  };
}

async function created(s, body = textRequest()) {
  const answer = await s.agent("sessions", { method: "POST", body });
  assert.equal(answer.status, 200, answer.text);
  return answer.json;
}

async function pageInfo(s) {
  const page = await s.agent("page");
  assert.equal(page.status, 200, page.text);
  const shellPath = page.json.path;
  const capability = shellPath.split("/").at(-1);
  const html = await request(s.port, shellPath);
  assert.equal(html.status, 200);
  const token = html.text.match(/data-token="([a-f0-9]{64})"/)[1];
  return {
    capability,
    shellPath,
    socketPath: `/_walkr/compare/a/${capability}`,
    pageCall: (route, options = {}) => request(s.port, `${API}/${route}`, { token, ...options }),
  };
}

/** Send one raw HTTP Upgrade request over TCP and return status, headers, and parsed JSON body if present. */
function rawUpgrade(port, route, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks = [];
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for upgrade response")), 5000);
    const headers = {
      host: `127.0.0.1:${port}`,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": randomBytes(16).toString("base64"),
      "sec-websocket-version": "13",
      ...extraHeaders,
    };
    const head = `GET ${route} HTTP/1.1\r\n` +
      Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("") +
      "\r\n";
    socket.on("connect", () => socket.write(head, "latin1"));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return;
      const headText = raw.subarray(0, split).toString("latin1");
      const [statusLine, ...headerLines] = headText.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const respHeaders = Object.fromEntries(
        headerLines.map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      if (status === 101) {
        finish(null, { status, headers: respHeaders, text: "", json: undefined });
        return;
      }
      const len = Number(respHeaders["content-length"]);
      const body = raw.subarray(split + 4);
      if (Number.isFinite(len) && body.length >= len) {
        const text = body.subarray(0, len).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        finish(null, { status, headers: respHeaders, text, json });
      }
    });
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) { finish(new Error("Connection ended without HTTP response")); return; }
      const headText = raw.subarray(0, split).toString("latin1");
      const [statusLine, ...headerLines] = headText.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const respHeaders = Object.fromEntries(
        headerLines.map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      const text = raw.subarray(split + 4).toString("utf8");
      let json;
      try { json = JSON.parse(text); } catch {}
      finish(null, { status, headers: respHeaders, text, json });
    });
    socket.on("error", (err) => finish(err));
  });
}

async function waitUntil(ready, expected, limit = IO_WATCHDOG_MS) {
  const deadline = Date.now() + limit;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting until ${expected}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** Controlled interval clock so polling tests verify the 2 s rule in logical time rather than host scheduling. */
function createFakePoll() {
  let now = 0;
  let nextId = 1;
  const active = new Map();
  return {
    get now() { return now; },
    get count() { return active.size; },
    setInterval(fn, ms) {
      const id = nextId++;
      active.set(id, { fn, ms, nextAt: now + ms });
      return id;
    },
    clearInterval(id) {
      active.delete(id);
    },
    advanceToNext(maxMs) {
      let earliest = null;
      for (const entry of active.values()) {
        if (!earliest || entry.nextAt < earliest.nextAt) earliest = entry;
      }
      if (!earliest || earliest.nextAt - now > maxMs) {
        now += maxMs;
        return false;
      }
      now = earliest.nextAt;
      earliest.nextAt += earliest.ms;
      earliest.fn();
      return true;
    },
  };
}

async function serveWithPoll(t, f, socketPoll) {
  const service = createServer({ root: f.root, publicSite: null, socketPoll });
  await new Promise((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const port = service.server.address().port;
  t.after(async () => {
    service.dispose();
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  });
  const api = (route, options = {}) => request(port, route, { token: service.token, ...options });
  return { ...service, port, api, agent: (route, options) => api(`${API}/${route}`, options) };
}

/** Upgrade over raw TCP, write raw client frame bytes, and return the status code of the server's Close frame. */
function rawFrameCloseCode(port, route, frameBytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let settled = false;
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(code);
    };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for WebSocket Close frame")), IO_WATCHDOG_MS);
    const head = `GET ${route} HTTP/1.1\r\n` +
      `host: 127.0.0.1:${port}\r\n` +
      "upgrade: websocket\r\n" +
      "connection: Upgrade\r\n" +
      `sec-websocket-key: ${randomBytes(16).toString("base64")}\r\n` +
      "sec-websocket-version: 13\r\n\r\n";

    const parseServerFrames = () => {
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const len7 = buf[1] & 0x7f;
        let headerLen = 2;
        let payloadLen = len7;
        if (len7 === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          headerLen = 4;
        } else if (len7 === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          headerLen = 10;
        }
        if (buf.length < headerLen + payloadLen) return;
        const payload = buf.subarray(headerLen, headerLen + payloadLen);
        buf = buf.subarray(headerLen + payloadLen);
        if (opcode === 0x8) {
          finish(null, payload.length >= 2 ? payload.readUInt16BE(0) : null);
          return;
        }
      }
    };

    socket.on("connect", () => socket.write(head, "latin1"));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const split = buf.indexOf("\r\n\r\n");
        if (split < 0) return;
        const statusLine = buf.subarray(0, split).toString("latin1").split("\r\n")[0];
        const status = Number(statusLine.split(" ")[1]);
        if (status !== 101) { finish(new Error(`Expected 101 upgrade, got ${status}`)); return; }
        upgraded = true;
        buf = buf.subarray(split + 4);
        socket.write(frameBytes);
      }
      parseServerFrames();
    });
    socket.on("end", () => finish(new Error("Server ended connection without a Close frame")));
    socket.on("error", (err) => finish(err));
  });
}

/** Open a Node 24 WebSocket client and collect parsed A2UI frames and close state. */
async function connectSocket(t, port, socketPath) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
  const frames = [];
  const messages = [];
  let closed = null;
  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    frames.push(parsed);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  });
  ws.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
  });
  t.after(async () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
      await waitUntil(() => ws.readyState === WebSocket.CLOSED, "socket closes in teardown", 1000).catch(() => {});
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket open")), IO_WATCHDOG_MS);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed to open")); }, { once: true });
  });
  return { ws, frames, messages, get closed() { return closed; } };
}

test("handshake refusals: wrong capability matches wrong page 404, Origin/query/hosted/mirror/publicOrigin/5th socket are refused", async (t) => {
  const f = await setup(t);
  const publicHost = ["walkr", "example", "org"].join(".");
  const publicOrigin = `https://${publicHost}`;
  const configDir = path.join(f.dir, "config", "tenant-artifacts");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({ walkrPublicOrigin: publicOrigin }));
  const allowedHost = ["review", "example"].join(".");

  const s = await serve(t, f, {
    XDG_CONFIG_HOME: path.join(f.dir, "config"),
    HUMAN_REVIEW_ALLOWED_HOSTS: `${allowedHost}:4802`,
  });
  const info = await pageInfo(s);
  const wrongCap = "0".repeat(64);
  const wrongPage = await request(s.port, `/_walkr/compare/g/${wrongCap}`);
  assert.equal(wrongPage.status, 404);

  const hostedDir = await setup(t);
  const hosted = await serve(t, hostedDir, { HUMAN_REVIEW_HOSTED: "1" });

  const mirror = await startMirror({ root: f.root });
  t.after(mirror.close);
  const mirrorEntry = await request(mirror.port, "/");
  assert.equal(mirrorEntry.status, 302);
  const mirrorCap = mirrorEntry.headers.location.split("/").at(-1);

  const frontPort = s.port === 6790 ? 6791 : 6790;
  const cases = [
    { name: "wrong capability", port: s.port, route: `/_walkr/compare/a/${wrongCap}`, expectedStatus: 404, matchPage404: true },
    { name: "agent token as capability", port: s.port, route: `/_walkr/compare/a/${s.token}`, expectedStatus: 404, matchPage404: true },
    { name: "Origin header", port: s.port, route: info.socketPath, headers: { origin: `http://127.0.0.1:${s.port}` }, expectedStatus: 403 },
    { name: "query string", port: s.port, route: `${info.socketPath}?x=1`, expectedStatus: 400 },
    { name: "fragment", port: s.port, route: `${info.socketPath}#frag`, expectedStatus: 400 },
    { name: "front host on another port", port: s.port, route: info.socketPath, headers: { host: `127.0.0.1:${frontPort}` }, expectedStatus: 403 },
    { name: "allowed host", port: s.port, route: info.socketPath, headers: { host: `${allowedHost}:4802` }, expectedStatus: 403 },
    { name: "public origin host", port: s.port, route: info.socketPath, headers: { host: publicHost }, expectedStatus: 403 },
    { name: "hosted run", port: hosted.port, route: `/_walkr/compare/a/${wrongCap}`, expectedStatus: 403, expectedCode: "HOSTED_UNSUPPORTED" },
    { name: "mirror server", port: mirror.port, route: `/_walkr/compare/a/${mirrorCap}`, expectedStatus: 403 },
  ];

  for (const item of cases) {
    const res = await rawUpgrade(item.port, item.route, item.headers);
    assert.equal(res.status, item.expectedStatus, item.name);
    if (item.matchPage404) {
      assert.deepEqual(res.json, wrongPage.json, `${item.name} matches wrong page 404 body`);
      assert.equal(res.headers["content-type"], wrongPage.headers["content-type"]);
    }
    if (item.expectedCode) assert.equal(res.json?.error?.code, item.expectedCode, item.name);
  }

  // Four open sockets succeed; a fifth upgrade gets 503.
  const open = [];
  for (let i = 0; i < 4; i += 1) {
    open.push(await connectSocket(t, s.port, info.socketPath));
  }
  const fifth = await rawUpgrade(s.port, info.socketPath);
  assert.equal(fifth.status, 503, "fifth socket must be refused");

  open[0].ws.close();
  await waitUntil(() => open[0].ws.readyState === WebSocket.CLOSED, "first socket closes");
  const replacement = await connectSocket(t, s.port, info.socketPath);
  assert.equal(replacement.ws.readyState, WebSocket.OPEN);
});

test("connect sends open surfaces newest first, shared poll delivers create and delete within 2 s logical time, and page submit removes a surface", async (t) => {
  const f = await setup(t);
  const clock = createFakePoll();
  const s = await serveWithPoll(t, f, clock);
  const info = await pageInfo(s);
  const store = new CompareStore({ root: f.root });
  assert.equal(clock.count, 0);

  const first = await store.create(textRequest("ws-live-1"));
  const firstId = first.result.sessionId;

  const client = await connectSocket(t, s.port, info.socketPath);
  assert.equal(clock.count, 1);
  await waitUntil(
    () => client.messages.some((m) => m.createSurface?.surfaceId === firstId),
    "initial open session surface arrives on connect",
  );
  assert.equal(checkA2uiMessages(client.frames[0]).ok, true);
  const initialSurface = client.messages.find((m) => m.createSurface?.surfaceId === firstId).createSurface;
  assert.equal(
    initialSurface.components.some((c) => c.component === "Text" && c.text?.["@path"] === "/status"),
    true,
  );

  // Create a strictly newer session directly in the store (outside the server notify path) so the shared poll must find it.
  await waitUntil(() => Date.now() > Date.parse(first.view.createdAt), "clock advances past first session");
  const second = await store.create({ ...textRequest("ws-live-2"), title: "Newer session" });
  const secondId = second.result.sessionId;

  assert.equal(clock.advanceToNext(2000), true, "shared poll must fire within 2 s of logical time");
  await waitUntil(
    () => client.messages.some((m) => m.createSurface?.surfaceId === secondId),
    "new session surface arrives after shared poll tick",
  );

  // A second socket shares the single poll interval and receives both open surfaces newest first.
  const client2 = await connectSocket(t, s.port, info.socketPath);
  assert.equal(clock.count, 1);
  await waitUntil(
    () => client2.messages.filter((m) => m.createSurface).length >= 2,
    "second socket receives both open surfaces",
  );
  const order = client2.messages.filter((m) => m.createSurface).map((m) => m.createSurface.surfaceId);
  assert.deepEqual(order.slice(0, 2), [secondId, firstId]);

  // Submitting the first session directly in the store (outside notify) removes its surface on the shared poll within 2 s logical time.
  await store.submit(firstId, { actionId: "ext-submit-1", pick: "short", note: "Outside notify" });
  assert.equal(clock.advanceToNext(2000), true, "shared poll must fire within 2 s of logical time for delete");
  await waitUntil(
    () => client.messages.some((m) => m.deleteSurface?.surfaceId === firstId),
    "deleted surface arrives after external submit on shared poll tick",
  );

  // Submitting the second session on the private page also removes its surface.
  const submitted = await info.pageCall(`sessions/${secondId}/submit`, {
    method: "POST",
    body: { actionId: "page-submit-1", pick: "short", note: "From page" },
  });
  assert.equal(submitted.status, 200, submitted.text);
  await waitUntil(
    () => client.messages.some((m) => m.deleteSurface?.surfaceId === secondId),
    "deleted surface arrives after page submit",
  );
});

test("socket submit saves the same result as a page submit and removes the surface; a refused submit writes nothing and updates /status", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const info = await pageInfo(s);

  const pageMade = await created(s, textRequest("ws-parity-page"));
  const sockMade = await created(s, textRequest("ws-parity-sock"));
  const pageId = pageMade.result.sessionId;
  const sockId = sockMade.result.sessionId;

  const pageSubmit = await info.pageCall(`sessions/${pageId}/submit`, {
    method: "POST",
    body: { actionId: "page-parity", pick: "short", comments: {}, note: "Keep this" },
  });
  assert.equal(pageSubmit.status, 200, pageSubmit.text);

  const sockRecordPath = path.join(f.root, "sessions", sockId, "session.json");
  const pageRecordPath = path.join(f.root, "sessions", pageId, "session.json");
  const beforeRefusal = await fs.readFile(sockRecordPath);
  const pageBeforeMismatch = await fs.readFile(pageRecordPath);

  const client = await connectSocket(t, s.port, info.socketPath);
  await waitUntil(
    () => client.messages.some((m) => m.createSurface?.surfaceId === sockId),
    "socket receives open session surface",
  );

  // Refused submit #1: No option fits without a note.
  client.ws.send(JSON.stringify({
    version: "1.0",
    action: {
      name: "submit",
      surfaceId: sockId,
      sourceComponentId: "submit",
      timestamp: new Date().toISOString(),
      context: { sessionId: sockId, button: "submit", pick: [""], note: "" },
    },
  }));
  await waitUntil(
    () => client.messages.some((m) => m.updateDataModel?.surfaceId === sockId && m.updateDataModel.path === "/status"),
    "refused submit sends /status error update",
  );
  const firstError = client.messages.find((m) => m.updateDataModel?.surfaceId === sockId && m.updateDataModel.path === "/status");
  assert.equal(typeof firstError.updateDataModel.value, "string");
  assert.ok(firstError.updateDataModel.value.length > 0);
  assert.equal(client.messages.some((m) => m.deleteSurface?.surfaceId === sockId), false);
  assert.deepEqual(await fs.readFile(sockRecordPath), beforeRefusal);

  // Refused submit #2: mismatched context.sessionId.
  client.ws.send(JSON.stringify({
    version: "1.0",
    action: {
      name: "submit",
      surfaceId: sockId,
      sourceComponentId: "submit",
      timestamp: new Date().toISOString(),
      context: { sessionId: pageId, button: "submit", pick: ["short"], note: "Wrong session" },
    },
  }));
  await waitUntil(
    () => client.messages.filter((m) => m.updateDataModel?.surfaceId === sockId && m.updateDataModel.path === "/status").length >= 2,
    "mismatched sessionId sends second /status error update",
  );
  assert.equal(client.messages.some((m) => m.deleteSurface?.surfaceId === sockId), false);
  assert.deepEqual(await fs.readFile(sockRecordPath), beforeRefusal);
  assert.deepEqual(await fs.readFile(pageRecordPath), pageBeforeMismatch);

  // Valid submit on the same surface saves the result and removes the surface.
  client.ws.send(JSON.stringify({
    version: "1.0",
    action: {
      name: "submit",
      surfaceId: sockId,
      sourceComponentId: "submit",
      timestamp: new Date().toISOString(),
      context: { sessionId: sockId, button: "submit", pick: ["short"], note: "Keep this" },
    },
  }));
  await waitUntil(
    () => client.messages.some((m) => m.deleteSurface?.surfaceId === sockId),
    "accepted submit removes the surface",
  );

  const pageView = (await s.agent(`sessions/${pageId}`)).json.view;
  const sockView = (await s.agent(`sessions/${sockId}`)).json.view;
  assert.equal(sockView.status, "submitted");
  assert.deepEqual(
    { pick: sockView.result.pick, note: sockView.result.note, comments: sockView.result.comments, nextRound: sockView.result.nextRound },
    { pick: pageView.result.pick, note: pageView.result.note, comments: pageView.result.comments, nextRound: pageView.result.nextRound },
  );
});

test("no agent-only operation is possible through the socket: other action names change no record", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const info = await pageInfo(s);
  const made = await created(s, textRequest("ws-no-agent"));
  const sessionId = made.result.sessionId;
  const recordPath = path.join(f.root, "sessions", sessionId, "session.json");
  const beforeBytes = await fs.readFile(recordPath);

  const client = await connectSocket(t, s.port, info.socketPath);
  await waitUntil(
    () => client.messages.some((m) => m.createSurface?.surfaceId === sessionId),
    "socket receives open session surface",
  );

  const forbiddenActions = ["create", "received", "outcome", "rate", "seen"];
  for (const name of forbiddenActions) {
    client.ws.send(JSON.stringify({
      version: "1.0",
      action: {
        name,
        surfaceId: sessionId,
        sourceComponentId: "submit",
        timestamp: new Date().toISOString(),
        context: { sessionId, actionId: `bad-${name}`, summary: "Nope", rating: 10 },
      },
    }));
  }
  await waitUntil(
    () => client.messages.filter((m) => m.updateDataModel?.surfaceId === sessionId && m.updateDataModel.path === "/status").length >= forbiddenActions.length,
    "unsupported actions receive /status error updates",
  );

  // Unknown surface closes the socket with 1008.
  client.ws.send(JSON.stringify({
    version: "1.0",
    action: {
      name: "outcome",
      surfaceId: "20260101T000000Z-000000000000",
      sourceComponentId: "submit",
      timestamp: new Date().toISOString(),
      context: { sessionId: "20260101T000000Z-000000000000" },
    },
  }));
  await waitUntil(() => client.closed !== null, "unknown surface closes the socket");
  assert.equal(client.closed.code, 1008);

  const list = (await s.agent("sessions")).json.sessions;
  assert.deepEqual(list.map((item) => item.sessionId), [sessionId]);
  assert.deepEqual(await fs.readFile(recordPath), beforeBytes);
});

test("a client frame header over 16 KiB closes early with 1009, non-minimal lengths close with 1002, and the server still answers a new socket", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  const info = await pageInfo(s);
  const made = await created(s, textRequest("ws-oversize"));
  const sessionId = made.result.sessionId;

  // Header-only 16-bit extended length announcing 16385 bytes (16 KiB + 1) with 0 payload bytes proves early 1009.
  const oversizeHeader = Buffer.from([0x81, 0xfe, 0x40, 0x01, 0x11, 0x22, 0x33, 0x44]);
  assert.equal(await rawFrameCloseCode(s.port, info.socketPath, oversizeHeader), 1009);

  // Non-minimal extended lengths (126 encoding < 126; 127 encoding < 65536 even when > 16 KiB) close early with 1002.
  const nonMinimal16 = Buffer.from([0x81, 0xfe, 0x00, 0x7d, 0x11, 0x22, 0x33, 0x44]);
  assert.equal(await rawFrameCloseCode(s.port, info.socketPath, nonMinimal16), 1002);
  const nonMinimal64 = Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0x40, 0x01, 0x11, 0x22, 0x33, 0x44]);
  assert.equal(await rawFrameCloseCode(s.port, info.socketPath, nonMinimal64), 1002);

  const next = await connectSocket(t, s.port, info.socketPath);
  await waitUntil(
    () => next.messages.some((m) => m.createSurface?.surfaceId === sessionId),
    "new socket still receives open session surface after 1009",
  );
});

test("a response that ends while a later pipelined request on the same connection still runs does not start the header deadline of that request", async (t) => {
  const f = await setup(t);
  const s = await serve(t, f);
  // The header deadline uses setTimeout. A mock clock ends it here with no wait for the real ten seconds.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = net.connect({ host: "127.0.0.1", port: s.port });
  socket.on("error", () => {});
  const chunks = [];
  let closed = false;
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("close", () => { closed = true; });
  await new Promise((resolve) => socket.once("connect", resolve));
  const statuses = () => [...Buffer.concat(chunks).toString("latin1").matchAll(/^HTTP\/1\.1 (\d{3}) /gm)].map((m) => Number(m[1]));

  // Request A ends at once. Request B waits for its body, so it still runs when response A ends.
  const body = JSON.stringify(textRequest("ws-pipelined"));
  const host = `127.0.0.1:${s.port}`;
  socket.write(
    `GET /health HTTP/1.1\r\nhost: ${host}\r\n\r\n` +
    `POST ${API}/sessions HTTP/1.1\r\nhost: ${host}\r\nx-human-review-token: ${s.token}\r\n` +
    `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n`,
    "latin1",
  );
  // A close or an error before the first status also ends this wait, so the assertion below fails at once.
  await new Promise((resolve) => {
    const check = () => {
      if (statuses().length > 0 || closed || socket.destroyed) {
        socket.off("data", check);
        socket.off("close", check);
        socket.off("error", check);
        resolve();
      }
    };
    socket.on("data", check);
    socket.on("close", check);
    socket.on("error", check);
    check();
  });
  assert.equal(statuses().length > 0, true, "response A arrives before the peer closes");
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(WS_LIMITS.handshakeTimeoutMs);
  t.mock.timers.reset();

  socket.write(body);
  await waitUntil(() => closed, "the server ends the connection after response B");
  assert.deepEqual(statuses(), [200, 200]);
});

test("a repeated submit of a submitted session during each scan does not keep its surface on another socket", async (t) => {
  const f = await setup(t);
  const real = new CompareStore({ root: f.root });
  const sessionId = (await real.create(textRequest("ws-repeat"))).result.sessionId;
  let hub = null;
  let repeats = 0;
  // The server route: a submit, then notify with the answer. From the first submit on, one more submit runs in each scan.
  const route = async (actionId) => hub.notify(sessionId, await real.submit(sessionId, { actionId, pick: "short" }));
  let repeating = false;
  const store = {
    async history() {
      if (repeating && repeats < 5) { repeats += 1; await route(`ws-repeat-${repeats}`); }
      return real.history();
    },
    read: (id) => real.read(id),
  };
  hub = createCompareSocketHub({ getStore: () => store, submitSession: (id, body) => real.submit(id, body), poll: createFakePoll() });
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => hub.upgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { hub.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

  const client = await connectSocket(t, server.address().port, "/");
  await waitUntil(() => client.messages.some((m) => m.createSurface?.surfaceId === sessionId), "the surface arrives");
  repeating = true;
  await route("ws-repeat-first");
  await waitUntil(() => client.messages.some((m) => m.deleteSurface?.surfaceId === sessionId), "the surface is deleted");
  assert.equal(repeats < 5, true, `the delete waited for ${repeats} repeated submits`);
});
