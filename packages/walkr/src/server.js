import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BlockList, isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { recordError } from "./diagnostics.js";
import { ensureStateDir, SERVER_PROTOCOL, serverPath, stateDir } from "./paths.js";
import { allowedHosts, publicOrigin } from "./allowed-hosts.js";
import { configPath } from "./compare-remote.js";
import { createCompareHandler } from "./compare-server.js";
import { rejectUpgrade, WS_LIMITS } from "./compare-socket.js";
import { compareRoot } from "./compare-store.js";

// The background server of Walkr: the Compare routes, the two theme files and the health check. Every other path
// answers 404 and reads no request body. Core, Double, Coinflip, Trainer and the shared GUI are retired
// (CHANGELOG.md); their routes are not here.

const here = path.dirname(fileURLToPath(import.meta.url));

const IDLE_SHUTDOWN_MS = Number(process.env.HUMAN_REVIEW_IDLE_MS || 45 * 60 * 1000);
/** How often the server checks for idle time and for its own files. Tests shorten it. */
const SWEEP_MS = Number(process.env.HUMAN_REVIEW_SWEEP_MS || 60 * 1000);
// The file name comes from this table, never from the request.
const THEME = { "/theme.css": ["theme.css", "text/css; charset=utf-8"], "/theme.js": ["theme.js", "text/javascript; charset=utf-8"] };

function reportError(operation, error) {
  const code = `WR-${crypto.randomBytes(6).toString("hex")}`;
  recordError(code, operation, error);
  return code;
}

/** True for a peer address on loopback. */
function loopbackPeerCheck() {
  const peers = new BlockList();
  peers.addSubnet("127.0.0.0", 8, "ipv4");
  peers.addAddress("::1", "ipv6");
  return (peer) => Boolean(peer) && isIP(peer) !== 0 && peers.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4");
}

/** The public origin of the artifacts config key walkrPublicOrigin, read once at the start; a bad value logs one line. */
function startPublicOrigin() {
  return publicOrigin(configPath(), (line) => {
    console.error(line);
    recordError("WR-public-origin", "config", line);
  });
}

export function createServer({ ownFiles = [], publicSite = startPublicOrigin(), root = compareRoot(), socketPoll = null } = {}) {
  /**
   * Random per-run secret of the agent. The Compare API requires it or the token of the private page, so a web page
   * that sends blind cross-origin requests to 127.0.0.1 cannot read or write a session. The CLI reads it from
   * server.json.
   */
  const token = crypto.randomBytes(16).toString("hex");
  // Hosted mode is retired. With the old variable set, the Compare handler refuses each route, as before.
  const hosted = process.env.HUMAN_REVIEW_HOSTED === "1";
  const loopbackPeer = loopbackPeerCheck();
  let lastActivity = Date.now();
  const compare = createCompareHandler({ token, root, hosted, onSocketActivity: () => { lastActivity = Date.now(); }, socketPoll });

  const json = (res, code, payload) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  };

  let disposed = false;
  const pendingHandshakes = new Map();
  const upgradedSockets = new WeakSet();
  // The count of responses of each socket that have not ended. Pipelined requests share one socket, so the header
  // timer starts only after the last of them ends.
  const openResponses = new Map();

  const disarmHandshake = (socket) => {
    const timer = pendingHandshakes.get(socket);
    if (!timer) return;
    clearTimeout(timer);
    pendingHandshakes.delete(socket);
  };

  const armHandshake = (socket) => {
    if (disposed || !socket || socket.destroyed || upgradedSockets.has(socket) || openResponses.has(socket)) return;
    disarmHandshake(socket);
    const timer = setTimeout(() => {
      pendingHandshakes.delete(socket);
      if (!socket.destroyed) socket.destroy();
    }, WS_LIMITS.handshakeTimeoutMs);
    timer.unref();
    pendingHandshakes.set(socket, timer);
  };

  const server = http.createServer(async (req, res) => {
    const socket = req.socket;
    disarmHandshake(socket);
    if (typeof res?.once === "function") {
      openResponses.set(socket, (openResponses.get(socket) ?? 0) + 1);
      // A response ends with "finish", or with "close" alone when its connection ends first. Both lower the count.
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        const left = (openResponses.get(socket) ?? 1) - 1;
        if (left > 0) {
          openResponses.set(socket, left);
          return;
        }
        openResponses.delete(socket);
        if (!socket || socket.destroyed || upgradedSockets.has(socket)) return;
        if (disposed) socket.destroy();
        else if (res.shouldKeepAlive) armHandshake(socket);
      };
      res.once("finish", end);
      res.once("close", end);
    }
    const pathname = String(req.url || "").split("?")[0];
    // A health check arrives on a timer (the CLI, the artifacts server, Sheprd), so it is no sign of use.
    if (pathname !== "/health") lastActivity = Date.now();

    try {
      // A request that arrived via a DNS-rebound hostname carries that hostname in Host. Refusing it means a
      // malicious page can never speak to this server as if it were same-origin.
      const host = String(req.headers.host || "");
      const port = req.socket.localPort;
      const peer = req.socket.remoteAddress || "";
      const loopbackHost = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
      const local = loopbackHost && loopbackPeer(peer);
      // A local front (the artifacts server, a Sheprd tunnel) passes the Compare page with the Host of its own port.
      // So a loopback peer with a loopback Host of any port reaches Compare and the theme files.
      const anyPort = host.toLowerCase().match(/^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/);
      const frontHost = Boolean(anyPort) && Number(anyPort[1]) >= 1 && Number(anyPort[1]) <= 65535 && !hosted && loopbackPeer(peer);
      // A host of HUMAN_REVIEW_ALLOWED_HOSTS reaches Compare and the theme files from another computer.
      const allowedHost = allowedHosts().includes(host.toLowerCase());
      // The host of the public origin (walkrPublicOrigin): a reverse proxy sends it unchanged through an SSH forward,
      // so the peer is loopback. It reaches Compare and the theme files only, and the agent token is not valid for it.
      const publicHost = Boolean(publicSite) && host.toLowerCase() === publicSite.host && !hosted && loopbackPeer(peer);
      const page = pathname.startsWith("/_walkr/compare/") || Object.hasOwn(THEME, pathname);
      if (!local && !((loopbackHost || frontHost || allowedHost || publicHost) && page)) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("Forbidden");
      }

      // Compare checks the Origin of a page write only for a request that the front exception alone admitted.
      // A request of the public host has the rules of the public origin (compare-server.js).
      if (await compare(req, res, { viaFront: frontHost && !loopbackHost && !allowedHost,
        publicOrigin: publicHost ? publicSite.origin : null })) return;

      if (pathname === "/health") return json(res, 200, { ok: true, pid: process.pid, protocol: SERVER_PROTOCOL });

      if (Object.hasOwn(THEME, pathname) && req.method === "GET") {
        const [file, type] = THEME[pathname];
        const body = await fs.promises.readFile(path.join(here, file));
        res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        return res.end(body);
      }

      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    } catch (error) {
      const code = reportError("request", error);
      return json(res, 500, { error: `Request failed. Reference: ${code}` });
    }
  });

  // Drop clients that do not finish sending their HTTP / WebSocket upgrade headers within 10 s,
  // including subsequent requests/upgrades on reused keep-alive connections.
  server.headersTimeout = WS_LIMITS.handshakeTimeoutMs;
  server.on("connection", (socket) => {
    if (disposed) { socket.destroy(); return; }
    armHandshake(socket);
    const forget = () => {
      disarmHandshake(socket);
      openResponses.delete(socket);
    };
    socket.once("close", forget);
    socket.once("error", forget);
  });

  // WebSocket upgrades never reach the HTTP request handler and require the strict local Host and peer gate:
  // only a loopback Host with this server's port and a loopback peer. Front hosts, allowed hosts and the public host get 403.
  server.on("upgrade", (req, socket, head) => {
    upgradedSockets.add(socket);
    disarmHandshake(socket);
    try {
      const host = String(req.headers.host || "");
      const port = req.socket.localPort;
      const peer = req.socket.remoteAddress || "";
      const loopbackHost = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
      const local = loopbackHost && loopbackPeer(peer);
      if (!local) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      lastActivity = Date.now();
      if (compare.upgrade(req, socket, head, { publicOrigin: null })) return;
      rejectUpgrade(socket, 404, "Not found");
    } catch (error) {
      const code = reportError("upgrade", error);
      rejectUpgrade(socket, 500, { error: `Request failed. Reference: ${code}` });
    }
  });

  const sweep = setInterval(() => {
    // The checkout or the state directory was deleted: nobody can use this server again.
    if (ownFiles.some((file) => !fs.existsSync(file))) process.exit(0);
    // An open A2UI socket counts as use of the server, so idle shutdown waits while a panel is connected.
    if (compare.openSockets() > 0) {
      lastActivity = Date.now();
      return;
    }
    // No request for the idle time: the page of an open browser tab reads every two seconds, so it keeps the server.
    if (IDLE_SHUTDOWN_MS > 0 && Date.now() - lastActivity > IDLE_SHUTDOWN_MS) process.exit(0);
  }, SWEEP_MS);
  sweep.unref();

  const dispose = () => {
    disposed = true;
    clearInterval(sweep);
    for (const [socket, timer] of pendingHandshakes) {
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
    }
    pendingHandshakes.clear();
    compare.close();
    server.close();
  };

  return { server, token, dispose };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1200 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
  });
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

const lockPath = () => path.join(stateDir(), "server.lock");
let holdsLock = false;

/**
 * Exactly one Walkr server per state directory. Two commands racing to start one would otherwise each spawn a
 * server, and the page would talk to one while the agent waits on the other.
 * A live server on the current protocol wins; an older one is asked to leave.
 */
async function claimServerSlot() {
  ensureStateDir();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(lockPath(), String(process.pid), { flag: "wx" });
      holdsLock = true;
      break;
    } catch {
      let holder = 0;
      try {
        holder = Number(fs.readFileSync(lockPath(), "utf8"));
      } catch {}
      if (holder === process.pid) {
        holdsLock = true;
        break;
      }
      if (holder && pidAlive(holder)) {
        // Another process is starting or running; let it, unless it is
        // stale and never got as far as announcing itself.
        await sleep(300);
        const saved = readServerRecord();
        if (saved && saved.pid === holder) return { proceed: false };
        if (attempt < 2) continue;
        return { proceed: false };
      }
      try {
        fs.unlinkSync(lockPath());
      } catch {}
    }
  }
  if (!holdsLock) return { proceed: false };

  const saved = readServerRecord();
  if (saved && saved.pid && saved.pid !== process.pid) {
    const health = await probeHealth(saved.port);
    if (health && health.pid === saved.pid) {
      if (saved.protocol === SERVER_PROTOCOL) return { proceed: false };
      // An older server: it answered /health with its own pid, so this is
      // ours to replace. A waiting command connects to the new one on its next call.
      try {
        process.kill(saved.pid, "SIGTERM");
      } catch {}
      for (let i = 0; i < 30 && (await probeHealth(saved.port)); i += 1) await sleep(100);
    }
  }
  return { proceed: true };
}

function releaseServerSlot() {
  if (!holdsLock) return;
  holdsLock = false;
  try {
    if (Number(fs.readFileSync(lockPath(), "utf8")) === process.pid) fs.unlinkSync(lockPath());
  } catch {}
}

function readServerRecord() {
  try {
    return JSON.parse(fs.readFileSync(serverPath(), "utf8"));
  } catch {
    return null;
  }
}

process.on("exit", releaseServerSlot);

/** `exitWhenFilesGone`: the detached server ends when its entry file or its state directory is deleted. */
export async function start(port = 0, { exitWhenFilesGone = false } = {}) {
  const claim = await claimServerSlot();
  if (!claim.proceed) {
    const err = new Error("a Walkr server is already running for this state directory");
    err.code = "EALREADY";
    throw err;
  }
  const ownFiles = exitWhenFilesGone ? [path.join(here, "server-entry.js"), stateDir()] : [];
  const { server, token, dispose } = createServer({ ownFiles });
  return new Promise((resolve, reject) => {
    // Without this, a busy HUMAN_REVIEW_PORT dies as an uncaught exception.
    server.once("error", (err) => {
      console.error(`Walkr server could not listen on port ${port}: ${err.message}`);
      reject(err);
    });
    server.listen(port, process.env.HUMAN_REVIEW_BIND || "127.0.0.1", () => {
      const actual = server.address().port;
      ensureStateDir();
      fs.writeFileSync(serverPath(), JSON.stringify({ port: actual, pid: process.pid, token, protocol: SERVER_PROTOCOL }));
      try {
        fs.chmodSync(serverPath(), 0o600);
      } catch {
        // Windows has no meaningful chmod; the state dir mode covers it.
      }
      resolve({ server, port: actual, token, dispose });
    });
  });
}
