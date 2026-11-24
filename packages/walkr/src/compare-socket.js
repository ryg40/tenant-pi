import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { A2UI_VERSION, checkA2uiMessages } from "./a2ui.js";
import { decisionMessages, FEEDBACK_ROUND, FROM_FEEDBACK, NO_FIT } from "./compare.js";
import { StoreError } from "./store-files.js";

// Minimal RFC 6455 WebSocket server for the local Walkr Compare A2UI panel.
// No runtime dependency: SHA-1 accept key, unmasked server frames, masked client FIN text frames only,
// ping/pong and close handshake. Checks the client frame length field before reading payload bytes.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const SESSION_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;
const ALLOWED_ACTION_KEYS = new Set(["name", "surfaceId", "sourceComponentId", "timestamp", "context", "userMessage"]);
const ALLOWED_CONTEXT_KEYS = new Set(["sessionId", "button", "pick", "note", "next"]);
const NOTE_MAX = 8000;
const MAX_ERROR_TEXT = 500;
// A socket surface has no onChange stream back to the server, so chose: true shows any Next round cards up front.
const EMPTY_DRAFT = Object.freeze({ pick: null, none: false, note: "", comments: Object.freeze({}), next: FROM_FEEDBACK, chose: true });
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export const WS_LIMITS = Object.freeze({
  maxSockets: 4,
  maxSurfaces: 8,
  maxClientFrameBytes: 16 * 1024,
  maxSendQueueBytes: 1024 * 1024,
  handshakeTimeoutMs: 10 * 1000,
  pollMs: 1000,
  maxPendingActions: 8,
  closeGraceMs: 1000,
});

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sessionTime = (id) => {
  const m = SESSION_TIME.exec(id ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : "";
};

/** Write one plain HTTP error response directly to an upgrade socket and close it. */
export function rejectUpgrade(socket, status, payload, { headers: extra = {} } = {}) {
  if (!socket || socket.destroyed) return;
  socket.on("error", () => {});
  if (!socket.writable) { socket.destroy(); return; }
  const isJson = typeof payload !== "string";
  const body = Buffer.from(isJson ? JSON.stringify(payload) : payload, "utf8");
  const reason = http.STATUS_CODES[status] || "Error";
  const headers = {
    ...extra,
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "content-length": String(body.length),
    connection: "close",
  };
  const head = `HTTP/1.1 ${status} ${reason}\r\n` +
    Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("") +
    "\r\n";
  let timer = null;
  const finish = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!socket.destroyed) socket.destroy();
  };
  timer = setTimeout(finish, WS_LIMITS.closeGraceMs);
  timer.unref();
  socket.once("close", () => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
  try {
    socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]), finish);
  } catch {
    finish();
  }
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[0] = 0x80 | opcode;
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, data]);
}

function encodeClose(code, reason = "") {
  if (code === undefined) return encodeFrame(0x8);
  const text = Buffer.from(reason, "utf8").subarray(0, 123);
  const body = Buffer.allocUnsafe(2 + text.length);
  body.writeUInt16BE(code, 0);
  text.copy(body, 2);
  return encodeFrame(0x8, body);
}

function validCloseCode(code) {
  if (code < 1000 || code > 4999) return false;
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return false;
  if (code >= 1016 && code < 3000) return false;
  return true;
}

function hasToken(header, token) {
  return String(header || "").split(",").some((part) => part.trim().toLowerCase() === token);
}

function validWebSocketKey(value) {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  const decoded = Buffer.from(key, "base64");
  return decoded.length === 16 && decoded.toString("base64") === key;
}

function applyToLive(live, messages) {
  for (const msg of messages) {
    if (msg.createSurface) {
      const cs = msg.createSurface;
      live.set(cs.surfaceId, {
        components: new Map((cs.components ?? []).map((component) => [component.id, component])),
        data: structuredClone(cs.dataModel ?? {}),
      });
    } else if (msg.deleteSurface) {
      live.delete(msg.deleteSurface.surfaceId);
    } else if (msg.updateDataModel) {
      const entry = live.get(msg.updateDataModel.surfaceId);
      if (entry && msg.updateDataModel.path === "/status") {
        entry.data.status = msg.updateDataModel.value;
      }
    }
  }
}

/** Validate a submit action's context and build the store submit body, or return an error string. */
function buildSubmitBody(surfaceId, context) {
  if (!isPlainObject(context)) return { error: "Submit context must be an object." };
  for (const key of Object.keys(context)) {
    if (!ALLOWED_CONTEXT_KEYS.has(key)) return { error: "Unexpected field in submit context." };
  }
  if (context.sessionId !== surfaceId) return { error: "Submit sessionId must match the surface." };
  if (context.button !== "submit" && context.button !== "more") return { error: "Unknown submit button." };
  if (!Array.isArray(context.pick) || context.pick.length !== 1 || typeof context.pick[0] !== "string") {
    return { error: "Pick one option, or select No option fits." };
  }
  const pick = context.pick[0] === NO_FIT ? null : context.pick[0];

  let note;
  if (context.note !== undefined && context.note !== null) {
    if (typeof context.note !== "string") return { error: "Note must be a string." };
    if (context.note.length > NOTE_MAX) note = context.note;
    else {
      const trimmed = context.note.trim();
      if (trimmed) note = trimmed;
    }
  }

  let nextRound;
  if (context.button === "more") {
    if (context.next === undefined || context.next === null) {
      nextRound = FEEDBACK_ROUND;
    } else if (Array.isArray(context.next)) {
      if (context.next.length === 0) nextRound = FEEDBACK_ROUND;
      else if (context.next.length === 1 && typeof context.next[0] === "string") {
        nextRound = context.next[0] === FROM_FEEDBACK ? FEEDBACK_ROUND : context.next[0];
      } else {
        return { error: "Invalid next round selection." };
      }
    } else {
      return { error: "Invalid next round selection." };
    }
  }

  return {
    body: {
      actionId: randomUUID(),
      pick,
      ...(note !== undefined ? { note } : {}),
      ...(nextRound !== undefined ? { nextRound } : {}),
    },
  };
}

/**
 * Hub of local A2UI WebSocket connections for one Compare root.
 * Polls open sessions once a second with one shared read while at least one socket is open.
 */
export function createCompareSocketHub({ getStore, submitSession, onActivity = null, errorHeaders = {}, poll = null }) {
  const sockets = new Set();
  const closingSockets = new Set();
  const viewCache = new Map();
  let pollTimer = null;
  let refreshing = null;
  let refreshAgain = false;
  // The IDs of the sessions that a submit or a notification changed while the current scan ran; null with no scan.
  let changedDuringScan = null;

  const scheduleInterval = poll?.setInterval ?? ((fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return timer;
  });
  const cancelInterval = poll?.clearInterval ?? clearInterval;

  function stopPolling() {
    if (pollTimer !== null) {
      cancelInterval(pollTimer);
      pollTimer = null;
    }
    viewCache.clear();
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = scheduleInterval(() => {
      if (sockets.size === 0) { stopPolling(); return; }
      scheduleRefresh();
    }, WS_LIMITS.pollMs);
  }

  function sendMessages(conn, messages) {
    let batch = [];
    const flush = () => {
      if (batch.length === 0 || conn.closing || conn.closed) return true;
      const checked = checkA2uiMessages(batch, conn.live);
      if (!checked.ok) { batch = []; return false; }
      const json = JSON.stringify(checked.messages);
      if (!conn.sendText(json)) { batch = []; return false; }
      applyToLive(conn.live, checked.messages);
      batch = [];
      return true;
    };
    for (const msg of messages) {
      if (conn.closing || conn.closed) return false;
      const candidate = [...batch, msg];
      if (checkA2uiMessages(candidate, conn.live).ok) {
        batch = candidate;
      } else {
        if (batch.length > 0 && !flush()) return false;
        if (checkA2uiMessages([msg], conn.live).ok) batch = [msg];
      }
    }
    return flush();
  }

  function sendStatus(conn, surfaceId, message) {
    if (conn.closing || conn.closed || !conn.live.has(surfaceId)) return;
    const text = String(message || "Request refused.").slice(0, MAX_ERROR_TEXT);
    sendMessages(conn, [{ version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/status", value: text } }]);
  }

  async function loadOpenSessions() {
    let rows;
    try {
      rows = await getStore().history();
    } catch {
      return null;
    }
    const openRows = rows
      .filter((entry) => !entry.error && entry.status === "open")
      .sort((a, b) => String(b.createdAt ?? sessionTime(b.sessionId)).localeCompare(String(a.createdAt ?? sessionTime(a.sessionId)))
        || String(b.sessionId).localeCompare(String(a.sessionId)));

    const currentIds = new Set(openRows.map((row) => row.sessionId));
    for (const id of viewCache.keys()) {
      if (!currentIds.has(id)) viewCache.delete(id);
    }

    const needed = new Set();
    for (const conn of sockets) {
      let liveOpen = 0;
      for (const id of conn.live.keys()) {
        if (currentIds.has(id)) liveOpen += 1;
      }
      let slots = WS_LIMITS.maxSurfaces - liveOpen;
      for (const row of openRows) {
        if (slots <= 0) break;
        if (!conn.live.has(row.sessionId)) {
          needed.add(row.sessionId);
          slots -= 1;
        }
      }
    }

    for (const row of openRows) {
      if (!needed.has(row.sessionId)) continue;
      const cached = viewCache.get(row.sessionId);
      if (cached && cached.updatedAt === row.updatedAt) continue;
      try {
        const view = await getStore().read(row.sessionId);
        if (view.status !== "open") {
          currentIds.delete(row.sessionId);
          viewCache.delete(row.sessionId);
          continue;
        }
        const [createMessage] = decisionMessages(view, EMPTY_DRAFT, { surfaceId: view.sessionId, status: true });
        viewCache.set(row.sessionId, { updatedAt: row.updatedAt, createMessage });
      } catch {
        currentIds.delete(row.sessionId);
        viewCache.delete(row.sessionId);
      }
    }

    return { openRows: openRows.filter((row) => currentIds.has(row.sessionId)), currentIds };
  }

  /** A session in `changed` changed during the scan, so its read can be stale: this pass leaves its surface as it is. */
  function syncConnection(conn, snapshot, changed) {
    if (conn.closing || conn.closed) return;
    const deletes = [];
    for (const id of conn.live.keys()) {
      if (!snapshot.currentIds.has(id) && !changed.has(id)) {
        deletes.push({ version: A2UI_VERSION, deleteSurface: { surfaceId: id } });
      }
    }
    if (deletes.length > 0 && !sendMessages(conn, deletes)) return;
    if (conn.closing || conn.closed) return;

    // The free slots go to the newest open rows that this socket does not show. A changed row keeps its slot empty
    // for the next pass, so an older cached row cannot take the place of a newer session.
    const creates = [];
    let freeSlots = WS_LIMITS.maxSurfaces - conn.live.size;
    for (const row of snapshot.openRows) {
      if (freeSlots <= 0) break;
      if (conn.live.has(row.sessionId)) continue;
      freeSlots -= 1;
      if (changed.has(row.sessionId)) continue;
      const cached = viewCache.get(row.sessionId);
      if (cached) creates.push(cached.createMessage);
    }
    if (creates.length > 0) sendMessages(conn, creates);
  }

  function scheduleRefresh() {
    if (sockets.size === 0) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        if (sockets.size === 0) break;
        const changed = changedDuringScan = new Set();
        const snapshot = await loadOpenSessions();
        changedDuringScan = null;
        if (snapshot && sockets.size > 0) {
          for (const conn of [...sockets]) syncConnection(conn, snapshot, changed);
        }
        // A change during the scan also asked for the next pass (sessionChanged), which reads the changed sessions again.
      } while (refreshAgain && sockets.size > 0);
    })().finally(() => {
      refreshing = null;
      changedDuringScan = null;
    });
  }

  /** A submit or a notification changed this session: a running scan leaves it out, and the next pass reads it. */
  function sessionChanged(sessionId) {
    changedDuringScan?.add(sessionId);
    viewCache.delete(sessionId);
    scheduleRefresh();
  }

  function upgrade(req, socket, head) {
    socket.on("error", () => {});
    const deny = (status, code, message, extra = {}) => {
      rejectUpgrade(socket, status, { error: { code, message } }, { headers: { ...errorHeaders, ...extra } });
    };

    const major = Number(req.httpVersionMajor);
    const minor = Number(req.httpVersionMinor);
    if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 1 || (major === 1 && minor < 1)) {
      return deny(400, "INVALID_REQUEST", "HTTP/1.1 or later is required for WebSocket upgrades.");
    }
    if (!hasToken(req.headers.upgrade, "websocket") || !hasToken(req.headers.connection, "upgrade")) {
      return deny(400, "INVALID_REQUEST", "Valid WebSocket Upgrade and Connection headers are required.");
    }
    if (String(req.headers["sec-websocket-version"] || "").trim() !== "13") {
      return deny(426, "INVALID_REQUEST", "Sec-WebSocket-Version 13 is required.", { "sec-websocket-version": "13" });
    }
    const key = String(req.headers["sec-websocket-key"] || "").trim();
    if (!validWebSocketKey(key)) {
      return deny(400, "INVALID_REQUEST", "A valid Sec-WebSocket-Key header is required.");
    }
    if (sockets.size + closingSockets.size >= WS_LIMITS.maxSockets) {
      return deny(503, "SERVICE_UNAVAILABLE", "At most 4 A2UI sockets may be open at once.");
    }

    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.setTimeout(0);
    socket.setNoDelay(true);
    try {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        "latin1",
      );
    } catch {
      socket.destroy();
      return;
    }

    const chunks = [];
    let offset = 0;
    let buffered = 0;
    let closeTimer = null;
    let pendingActions = 0;
    let actionChain = Promise.resolve();

    const clearInput = () => {
      chunks.length = 0;
      offset = 0;
      buffered = 0;
    };

    const peekByte = (at) => {
      let pos = offset + at;
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (pos < chunk.length) return chunk[pos];
        pos -= chunk.length;
      }
      return -1;
    };

    const consume = (n) => {
      if (n === 0) return Buffer.alloc(0);
      const first = chunks[0];
      if (first.length - offset >= n) {
        const slice = first.subarray(offset, offset + n);
        offset += n;
        buffered -= n;
        if (offset === first.length) { chunks.shift(); offset = 0; }
        return slice;
      }
      const out = Buffer.allocUnsafe(n);
      let written = 0;
      while (written < n) {
        const chunk = chunks[0];
        const take = Math.min(chunk.length - offset, n - written);
        chunk.copy(out, written, offset, offset + take);
        written += take;
        offset += take;
        buffered -= take;
        if (offset === chunk.length) { chunks.shift(); offset = 0; }
      }
      return out;
    };

    const conn = {
      live: new Map(),
      closing: false,
      closed: false,
      awaitingPeerClose: false,
      sendRaw(frame) {
        if (conn.closing || conn.closed || socket.destroyed || !socket.writable) return false;
        if (socket.writableLength + frame.length > WS_LIMITS.maxSendQueueBytes) {
          conn.close(1008, "Send queue limit exceeded.");
          return false;
        }
        try {
          socket.write(frame);
          return true;
        } catch {
          cleanup();
          if (!socket.destroyed) socket.destroy();
          return false;
        }
      },
      sendText(text) {
        return conn.sendRaw(encodeFrame(0x1, text));
      },
      close(code, reason = "", { awaitPeerClose = false } = {}) {
        if (conn.closed) return;
        if (conn.closing) {
          if (conn.awaitingPeerClose) {
            conn.awaitingPeerClose = false;
            clearInput();
            if (!socket.destroyed) socket.destroy();
          }
          return;
        }
        conn.closing = true;
        conn.awaitingPeerClose = Boolean(awaitPeerClose);
        if (!conn.awaitingPeerClose) clearInput();
        sockets.delete(conn);
        closingSockets.add(socket);
        if (sockets.size === 0) stopPolling();
        onActivity?.();
        if (!socket.destroyed && socket.writable) {
          try {
            const frame = encodeClose(code, reason);
            if (conn.awaitingPeerClose) socket.write(frame);
            else socket.end(frame);
          } catch {
            conn.awaitingPeerClose = false;
            clearInput();
            socket.destroy();
          }
        } else {
          conn.awaitingPeerClose = false;
          clearInput();
          socket.destroy();
        }
        closeTimer = setTimeout(() => {
          closeTimer = null;
          conn.awaitingPeerClose = false;
          clearInput();
          if (!socket.destroyed) socket.destroy();
        }, WS_LIMITS.closeGraceMs);
        closeTimer.unref();
        if (conn.awaitingPeerClose && buffered > 0) parseFrames();
      },
    };

    function endClosingTransport() {
      conn.awaitingPeerClose = false;
      clearInput();
      if (!socket.destroyed && socket.writable) {
        try {
          socket.end();
        } catch {
          socket.destroy();
        }
      } else if (!socket.destroyed) {
        socket.destroy();
      }
    }

    function cleanup() {
      if (conn.closed) return;
      conn.closed = true;
      conn.closing = true;
      conn.awaitingPeerClose = false;
      clearInput();
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      sockets.delete(conn);
      closingSockets.delete(socket);
      if (sockets.size === 0) stopPolling();
      onActivity?.();
    }

    /**
     * The Close frame of the peer, in the open state and in the shutdown state. In the shutdown state the server sent
     * its Close already: conn.close() then ends the transport with no second Close, and a valid reply ends it normally.
     */
    function handleClientClose(payload) {
      if (payload.length === 1) {
        conn.close(1002, "Invalid close frame payload.");
        return;
      }
      let replyCode;
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0);
        if (!validCloseCode(code)) {
          conn.close(1002, "Invalid close code.");
          return;
        }
        try {
          UTF8_DECODER.decode(payload.subarray(2));
        } catch {
          conn.close(1007, "Invalid UTF-8 in close reason.");
          return;
        }
        replyCode = code;
      }
      if (conn.awaitingPeerClose) endClosingTransport();
      else conn.close(replyCode);
    }

    function handleTextFrame(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        conn.close(1008, "Malformed JSON frame.");
        return;
      }
      const surfaceId = isPlainObject(msg) && isPlainObject(msg.action) && typeof msg.action.surfaceId === "string"
        ? msg.action.surfaceId : null;
      if (!surfaceId || !conn.live.has(surfaceId)) {
        conn.close(1008, "Unknown surface or malformed frame.");
        return;
      }
      const topKeys = Object.keys(msg);
      if (msg.version !== A2UI_VERSION || topKeys.some((key) => key !== "version" && key !== "action")) {
        sendStatus(conn, surfaceId, "Malformed action message.");
        return;
      }
      const action = msg.action;
      for (const key of Object.keys(action)) {
        if (!ALLOWED_ACTION_KEYS.has(key)) {
          sendStatus(conn, surfaceId, "Malformed action message.");
          return;
        }
      }
      if (typeof action.name !== "string" || !action.name
        || typeof action.sourceComponentId !== "string" || !action.sourceComponentId
        || typeof action.timestamp !== "string" || !action.timestamp
        || (action.userMessage !== undefined && typeof action.userMessage !== "string")
        || !isPlainObject(action.context)) {
        sendStatus(conn, surfaceId, "Malformed action message.");
        return;
      }
      if (action.name !== "submit") {
        sendStatus(conn, surfaceId, "Only the submit action is supported.");
        return;
      }
      const parsed = buildSubmitBody(surfaceId, action.context);
      if (parsed.error) {
        sendStatus(conn, surfaceId, parsed.error);
        return;
      }
      if (pendingActions >= WS_LIMITS.maxPendingActions) {
        conn.close(1008, "Too many pending actions.");
        return;
      }
      pendingActions += 1;
      actionChain = actionChain.then(async () => {
        if (conn.closing || conn.closed || !conn.live.has(surfaceId)) return;
        try {
          const answer = await submitSession(surfaceId, parsed.body);
          if (answer?.result?.outcome === "submitted" || answer?.result?.outcome === "already-submitted") {
            if (!conn.closing && !conn.closed && conn.live.has(surfaceId)) {
              sendMessages(conn, [{ version: A2UI_VERSION, deleteSurface: { surfaceId } }]);
            }
            // A replay or an already-submitted answer changed nothing, so the other sockets keep their next delete.
            if (answer.result.replay !== true) sessionChanged(surfaceId);
            return;
          }
          if (conn.closing || conn.closed || !conn.live.has(surfaceId)) return;
          sendStatus(conn, surfaceId, "Compare could not confirm this submit. Try again.");
        } catch (error) {
          if (conn.closing || conn.closed || !conn.live.has(surfaceId)) return;
          const message = error instanceof StoreError
            ? String(error.message || "Submit refused.").slice(0, MAX_ERROR_TEXT)
            : "Compare could not save this submit. Try again.";
          sendStatus(conn, surfaceId, message);
        }
      }).finally(() => {
        pendingActions -= 1;
      });
    }

    function parseFrames() {
      while (!conn.closed && (!conn.closing || conn.awaitingPeerClose)) {
        if (buffered < 2) return;
        const b0 = peekByte(0);
        const b1 = peekByte(1);
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        const len7 = b1 & 0x7f;

        if (rsv !== 0) { conn.close(1002, "Reserved bits are not supported."); return; }
        if (!masked) { conn.close(1002, "Client frames must be masked."); return; }

        const isControl = opcode === 0x8 || opcode === 0x9 || opcode === 0xA;
        if (isControl) {
          if (!fin || len7 > 125) { conn.close(1002, "Invalid control frame."); return; }
        } else if (opcode === 0x0) {
          conn.close(1002, "Continuation frames are not supported."); return;
        } else if (opcode === 0x2) {
          conn.close(1003, "Binary frames are not supported."); return;
        } else if (opcode === 0x1) {
          if (!fin) { conn.close(1003, "Fragmented frames are not supported."); return; }
        } else {
          conn.close(1002, "Unknown opcode."); return;
        }

        // Check payload length before reading or accumulating payload bytes.
        let headerLen = 2;
        let payloadLen = len7;
        if (len7 === 126) {
          if (buffered < 4) return;
          payloadLen = (peekByte(2) << 8) | peekByte(3);
          if (payloadLen < 126) { conn.close(1002, "Non-minimal 16-bit frame length."); return; }
          headerLen = 4;
        } else if (len7 === 127) {
          if (buffered < 10) return;
          const hi = ((peekByte(2) << 24) | (peekByte(3) << 16) | (peekByte(4) << 8) | peekByte(5)) >>> 0;
          const lo = ((peekByte(6) << 24) | (peekByte(7) << 16) | (peekByte(8) << 8) | peekByte(9)) >>> 0;
          if ((hi & 0x80000000) !== 0) { conn.close(1002, "Invalid 64-bit frame length."); return; }
          if (hi === 0 && lo < 65536) { conn.close(1002, "Non-minimal 64-bit frame length."); return; }
          if (hi !== 0 || lo > WS_LIMITS.maxClientFrameBytes) {
            conn.close(1009, "Client frame exceeds 16 KiB.");
            return;
          }
          payloadLen = lo;
          headerLen = 10;
        }

        if (payloadLen > WS_LIMITS.maxClientFrameBytes) {
          conn.close(1009, "Client frame exceeds 16 KiB.");
          return;
        }

        const totalLen = headerLen + 4 + payloadLen;
        if (buffered < totalLen) return;

        consume(headerLen);
        const mask = consume(4);
        const raw = consume(payloadLen);
        const payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) payload[i] = raw[i] ^ mask[i & 3];

        if (conn.awaitingPeerClose) {
          if (opcode === 0x8) {
            handleClientClose(payload);
            return;
          }
          continue;
        }

        onActivity?.();
        if (opcode === 0x9) {
          conn.sendRaw(encodeFrame(0xA, payload));
        } else if (opcode === 0xA) {
          // Ignore pong.
        } else if (opcode === 0x8) {
          handleClientClose(payload);
          return;
        } else if (opcode === 0x1) {
          let text;
          try {
            text = UTF8_DECODER.decode(payload);
          } catch {
            conn.close(1007, "Invalid UTF-8 in text frame.");
            return;
          }
          handleTextFrame(text);
        }
      }
    }

    const onData = (chunk) => {
      if (conn.closed || (conn.closing && !conn.awaitingPeerClose) || !chunk.length) return;
      chunks.push(chunk);
      buffered += chunk.length;
      parseFrames();
    };

    sockets.add(conn);
    onActivity?.();
    startPolling();

    socket.on("data", onData);
    socket.on("close", cleanup);
    socket.on("end", () => {
      if (!conn.closing) conn.close();
      else if (conn.awaitingPeerClose) endClosingTransport();
    });
    socket.on("error", cleanup);

    if (head && head.length > 0) onData(head);
    scheduleRefresh();
  }

  return {
    upgrade,
    /**
     * The HTTP routes call this after a create or a submit of the session `sessionId`, with the answer of the store.
     * A replay answer (a repeated create or submit, or an already-submitted session) changed nothing, so the call
     * does not hold back the surfaces of that session in a running scan.
     */
    notify(sessionId, answer = null) {
      if (answer?.result?.replay === true) return;
      sessionChanged(sessionId);
    },
    openSockets: () => sockets.size,
    close() {
      stopPolling();
      const priorClosing = [...closingSockets];
      for (const conn of [...sockets]) conn.close(1001, "Server shutting down.", { awaitPeerClose: true });
      for (const socket of priorClosing) {
        if (!socket.destroyed) socket.destroy();
      }
    },
  };
}
