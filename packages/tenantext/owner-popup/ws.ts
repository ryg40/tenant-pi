import { createHash } from "node:crypto";
import http from "node:http";
import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { checkA2uiMessages } from "../../walkr/src/a2ui.js";
import { rejectUpgrade, WS_LIMITS } from "../../walkr/src/compare-socket.js";

/**
 * Thin local WebSocket server adapter for the owner-task producer.
 *
 * Reuses `WS_LIMITS` and `rejectUpgrade` from `packages/walkr/src/compare-socket.js`
 * and `checkA2uiMessages` from `packages/walkr/src/a2ui.js`.
 * Note: `compare-socket.js` keeps its RFC 6455 framing loop unexported inside `createCompareSocketHub`,
 * so all transport framing lives behind this single file interface; extracting a shared module later
 * changes only this file.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ERROR_HEADERS = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};

export interface LiveSurfaceState {
	components: Map<string, unknown>;
	data: Record<string, unknown>;
}

export interface LocalWsClient {
	readonly id: number;
	readonly live: Map<string, LiveSurfaceState>;
	readonly closed: boolean;
	sendMessages(messages: unknown[]): boolean;
	close(code?: number, reason?: string): void;
}

export const DEFAULT_CLIENT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export interface LocalWsServerOptions {
	port?: number;
	path?: string;
	maxSockets?: number;
	maxClientFrameBytes?: number;
	maxSendQueueBytes?: number;
	handshakeTimeoutMs?: number;
	clientIdleTimeoutMs?: number;
	pingIntervalMs?: number;
	peerAddress?: (req: http.IncomingMessage) => string;
	onConnect?: (client: LocalWsClient) => void;
	onMessage?: (client: LocalWsClient, text: string) => void;
	onDisconnect?: (client: LocalWsClient) => void;
	onActivity?: () => void;
}

export interface LocalWsServer {
	readonly port: number;
	readonly server: http.Server;
	openSockets(): number;
	clients(): readonly LocalWsClient[];
	broadcast(messages: unknown[]): void;
	close(): Promise<void>;
}

function makeLoopbackPeerCheck(): (peer: string) => boolean {
	const peers = new BlockList();
	peers.addSubnet("127.0.0.0", 8, "ipv4");
	peers.addAddress("::1", "ipv6");
	return (peer: string) => {
		const normalized = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
		const version = isIP(normalized);
		return version !== 0 && peers.check(normalized, version === 6 ? "ipv6" : "ipv4");
	};
}

function hasToken(header: string | string[] | undefined, token: string): boolean {
	return String(header ?? "")
		.split(",")
		.some((part) => part.trim().toLowerCase() === token);
}

function validWebSocketKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const key = value.trim();
	if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
	const decoded = Buffer.from(key, "base64");
	return decoded.length === 16 && decoded.toString("base64") === key;
}

function validCloseCode(code: number): boolean {
	if (code < 1000 || code > 4999) return false;
	if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return false;
	if (code >= 1016 && code < 3000) return false;
	return true;
}

function encodeFrame(opcode: number, payload: string | Buffer = Buffer.alloc(0)): Buffer {
	const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	const len = data.length;
	let head: Buffer;
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

function encodeClose(code?: number, reason = ""): Buffer {
	if (code === undefined) return encodeFrame(0x8);
	const text = Buffer.from(reason, "utf8").subarray(0, 123);
	const body = Buffer.allocUnsafe(2 + text.length);
	body.writeUInt16BE(code, 0);
	text.copy(body, 2);
	return encodeFrame(0x8, body);
}

function applyToLive(live: Map<string, LiveSurfaceState>, messages: readonly unknown[]): void {
	for (const raw of messages) {
		const msg = raw as Record<string, unknown>;
		if (msg.createSurface && typeof msg.createSurface === "object") {
			const cs = msg.createSurface as { surfaceId: string; components?: Array<{ id: string }>; dataModel?: Record<string, unknown> };
			live.set(cs.surfaceId, {
				components: new Map((cs.components ?? []).map((component) => [component.id, component])),
				data: structuredClone(cs.dataModel ?? {}),
			});
		} else if (msg.updateComponents && typeof msg.updateComponents === "object") {
			const uc = msg.updateComponents as { surfaceId: string; components?: Array<{ id: string }> };
			const entry = live.get(uc.surfaceId);
			if (entry) {
				for (const component of uc.components ?? []) entry.components.set(component.id, component);
			}
		} else if (msg.updateDataModel && typeof msg.updateDataModel === "object") {
			const ud = msg.updateDataModel as { surfaceId: string; path?: string; value?: unknown };
			const entry = live.get(ud.surfaceId);
			if (entry && (ud.path === undefined || ud.path === "")) {
				entry.data = (ud.value && typeof ud.value === "object" && !Array.isArray(ud.value)
					? structuredClone(ud.value)
					: {}) as Record<string, unknown>;
			}
		} else if (msg.deleteSurface && typeof msg.deleteSurface === "object") {
			const ds = msg.deleteSurface as { surfaceId: string };
			live.delete(ds.surfaceId);
		}
	}
}

export async function createLocalWsServer(options: LocalWsServerOptions = {}): Promise<LocalWsServer> {
	const listenPort = options.port ?? 18766;
	const routePath = options.path ?? "/a2ui";
	const maxSockets = options.maxSockets ?? WS_LIMITS.maxSockets;
	const maxClientFrameBytes = options.maxClientFrameBytes ?? WS_LIMITS.maxClientFrameBytes;
	const maxSendQueueBytes = options.maxSendQueueBytes ?? WS_LIMITS.maxSendQueueBytes;
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? WS_LIMITS.handshakeTimeoutMs;
	const clientIdleTimeoutMs = options.clientIdleTimeoutMs ?? DEFAULT_CLIENT_IDLE_TIMEOUT_MS;
	const pingIntervalMs =
		options.pingIntervalMs ??
		(clientIdleTimeoutMs > 0 ? Math.min(30_000, Math.max(10, Math.floor(clientIdleTimeoutMs / 3))) : 0);
	const loopbackPeer = makeLoopbackPeerCheck();
	const peerOf = options.peerAddress ?? ((req: http.IncomingMessage) => req.socket.remoteAddress ?? "");

	const activeClients = new Set<LocalWsClient>();
	const closingSockets = new Set<Duplex>();
	const pendingHandshakes = new Map<Duplex, NodeJS.Timeout>();
	const upgradedSockets = new WeakSet<Duplex>();
	let disposed = false;
	let nextClientId = 1;

	const disarmHandshake = (socket: Duplex) => {
		const timer = pendingHandshakes.get(socket);
		if (!timer) return;
		clearTimeout(timer);
		pendingHandshakes.delete(socket);
	};

	const armHandshake = (socket: Duplex) => {
		if (disposed || socket.destroyed || upgradedSockets.has(socket)) return;
		disarmHandshake(socket);
		const timer = setTimeout(() => {
			pendingHandshakes.delete(socket);
			if (!socket.destroyed) socket.destroy();
		}, handshakeTimeoutMs);
		timer.unref();
		pendingHandshakes.set(socket, timer);
	};

	const isLocalGateAllowed = (req: http.IncomingMessage, boundPort: number): boolean => {
		const host = String(req.headers.host ?? "");
		const peer = peerOf(req);
		const loopbackHost = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(host);
		return loopbackHost && loopbackPeer(peer);
	};

	let boundPort = listenPort;

	// No HTTP route adds tasks or exposes state.
	const server = http.createServer((req, res) => {
		disarmHandshake(req.socket);
		if (!isLocalGateAllowed(req, boundPort)) {
			res.writeHead(403, { ...ERROR_HEADERS, "content-type": "text/plain; charset=utf-8" });
			res.end("Forbidden");
			return;
		}
		res.writeHead(404, { ...ERROR_HEADERS, "content-type": "text/plain; charset=utf-8" });
		res.end("Not found");
	});

	server.headersTimeout = handshakeTimeoutMs;
	server.on("connection", (socket) => {
		if (disposed) {
			socket.destroy();
			return;
		}
		armHandshake(socket);
		socket.once("close", () => disarmHandshake(socket));
		socket.once("error", () => disarmHandshake(socket));
	});

	server.on("upgrade", (req, socket, head) => {
		upgradedSockets.add(socket);
		disarmHandshake(socket);
		socket.on("error", () => {});

		const deny = (status: number, code: string, message: string, extra: Record<string, string> = {}) => {
			rejectUpgrade(socket, status, { error: { code, message } }, { headers: { ...ERROR_HEADERS, ...extra } });
		};

		if (!isLocalGateAllowed(req, boundPort)) {
			return deny(403, "FORBIDDEN", "Only loopback peers and loopback Host headers are allowed.");
		}
		if (req.headers.origin !== undefined) {
			return deny(403, "FORBIDDEN", "The A2UI socket refuses Origin headers.");
		}
		if (req.method !== "GET") {
			return deny(405, "METHOD_NOT_ALLOWED", "Use GET for WebSocket upgrades.");
		}
		const url = String(req.url ?? "");
		if (url.includes("?") || url.includes("#")) {
			return deny(400, "INVALID_REQUEST", "Query parameters and fragments are not allowed.");
		}
		if (url !== routePath) {
			return deny(404, "NOT_FOUND", "Unknown route.");
		}
		const major = Number(req.httpVersionMajor);
		const minor = Number(req.httpVersionMinor);
		if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 1 || (major === 1 && minor < 1)) {
			return deny(400, "INVALID_REQUEST", "HTTP/1.1 or later is required for WebSocket upgrades.");
		}
		if (!hasToken(req.headers.upgrade, "websocket") || !hasToken(req.headers.connection, "upgrade")) {
			return deny(400, "INVALID_REQUEST", "Valid WebSocket Upgrade and Connection headers are required.");
		}
		if (String(req.headers["sec-websocket-version"] ?? "").trim() !== "13") {
			return deny(426, "INVALID_REQUEST", "Sec-WebSocket-Version 13 is required.", { "sec-websocket-version": "13" });
		}
		const key = String(req.headers["sec-websocket-key"] ?? "").trim();
		if (!validWebSocketKey(key)) {
			return deny(400, "INVALID_REQUEST", "A valid Sec-WebSocket-Key header is required.");
		}
		if (activeClients.size + closingSockets.size >= maxSockets) {
			return deny(503, "SERVICE_UNAVAILABLE", `At most ${maxSockets} A2UI sockets may be open at once.`);
		}

		const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
		if ("setTimeout" in socket && typeof socket.setTimeout === "function") socket.setTimeout(0);
		if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
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

		const chunks: Buffer[] = [];
		let offset = 0;
		let buffered = 0;
		let closing = false;
		let closed = false;
		let awaitingPeerClose = false;
		let closeTimer: NodeJS.Timeout | null = null;
		let idleTimer: NodeJS.Timeout | null = null;
		let lastHeardAt = Date.now();
		const live = new Map<string, LiveSurfaceState>();
		const id = nextClientId++;

		const clearInput = () => {
			chunks.length = 0;
			offset = 0;
			buffered = 0;
		};

		const peekByte = (at: number): number => {
			let pos = offset + at;
			for (let i = 0; i < chunks.length; i += 1) {
				const chunk = chunks[i];
				if (pos < chunk.length) return chunk[pos];
				pos -= chunk.length;
			}
			return -1;
		};

		const consume = (n: number): Buffer => {
			if (n === 0) return Buffer.alloc(0);
			const first = chunks[0];
			if (first.length - offset >= n) {
				const slice = first.subarray(offset, offset + n);
				offset += n;
				buffered -= n;
				if (offset === first.length) {
					chunks.shift();
					offset = 0;
				}
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
				if (offset === chunk.length) {
					chunks.shift();
					offset = 0;
				}
			}
			return out;
		};

		const endClosingTransport = () => {
			awaitingPeerClose = false;
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
		};

		const cleanup = () => {
			if (closed) return;
			closed = true;
			closing = true;
			awaitingPeerClose = false;
			clearInput();
			if (closeTimer) {
				clearTimeout(closeTimer);
				closeTimer = null;
			}
			if (idleTimer) {
				clearInterval(idleTimer);
				idleTimer = null;
			}
			const wasActive = activeClients.delete(client);
			closingSockets.delete(socket);
			if (wasActive) options.onDisconnect?.(client);
			options.onActivity?.();
		};

		const sendRaw = (frame: Buffer): boolean => {
			if (closing || closed || socket.destroyed || !socket.writable) return false;
			if (socket.writableLength + frame.length > maxSendQueueBytes) {
				closeSocket(1008, "Send queue limit exceeded.");
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
		};

		const closeSocket = (code?: number, reason = "", awaitPeer = false) => {
			if (closed) return;
			if (closing) {
				if (awaitingPeerClose) {
					awaitingPeerClose = false;
					clearInput();
					if (!socket.destroyed) socket.destroy();
				}
				return;
			}
			closing = true;
			awaitingPeerClose = awaitPeer;
			if (!awaitingPeerClose) clearInput();
			if (idleTimer) {
				clearInterval(idleTimer);
				idleTimer = null;
			}
			const wasActive = activeClients.delete(client);
			closingSockets.add(socket);
			if (wasActive) options.onDisconnect?.(client);
			options.onActivity?.();
			if (!socket.destroyed && socket.writable) {
				try {
					const frame = encodeClose(code, reason);
					if (awaitingPeerClose) socket.write(frame);
					else socket.end(frame);
				} catch {
					awaitingPeerClose = false;
					clearInput();
					socket.destroy();
				}
			} else {
				awaitingPeerClose = false;
				clearInput();
				socket.destroy();
			}
			closeTimer = setTimeout(() => {
				closeTimer = null;
				awaitingPeerClose = false;
				clearInput();
				if (!socket.destroyed) socket.destroy();
			}, WS_LIMITS.closeGraceMs);
			closeTimer.unref();
			if (awaitingPeerClose && buffered > 0) parseFrames();
		};

		const client: LocalWsClient = {
			id,
			live,
			get closed() {
				return closed || closing;
			},
			sendMessages(messages: unknown[]): boolean {
				if (closing || closed || messages.length === 0) return false;
				const checked = checkA2uiMessages(messages, live);
				if (!checked.ok) return false;
				const ok = sendRaw(encodeFrame(0x1, JSON.stringify(checked.messages)));
				if (ok) applyToLive(live, checked.messages);
				return ok;
			},
			close(code?: number, reason = "") {
				closeSocket(code, reason, false);
			},
		};

		const handleClientClose = (payload: Buffer) => {
			if (payload.length === 1) {
				closeSocket(1002, "Invalid close frame payload.");
				return;
			}
			let replyCode: number | undefined;
			if (payload.length >= 2) {
				const code = payload.readUInt16BE(0);
				if (!validCloseCode(code)) {
					closeSocket(1002, "Invalid close code.");
					return;
				}
				try {
					UTF8_DECODER.decode(payload.subarray(2));
				} catch {
					closeSocket(1007, "Invalid UTF-8 in close reason.");
					return;
				}
				replyCode = code;
			}
			closeSocket(replyCode);
		};

		const parseFrames = () => {
			while (!closed && (!closing || awaitingPeerClose)) {
				if (buffered < 2) return;
				const b0 = peekByte(0);
				const b1 = peekByte(1);
				const fin = (b0 & 0x80) !== 0;
				const rsv = b0 & 0x70;
				const opcode = b0 & 0x0f;
				const masked = (b1 & 0x80) !== 0;
				const len7 = b1 & 0x7f;

				if (rsv !== 0) {
					closeSocket(1002, "Reserved bits are not supported.");
					return;
				}
				if (!masked) {
					closeSocket(1002, "Client frames must be masked.");
					return;
				}

				const isControl = opcode === 0x8 || opcode === 0x9 || opcode === 0xa;
				if (isControl) {
					if (!fin || len7 > 125) {
						closeSocket(1002, "Invalid control frame.");
						return;
					}
				} else if (opcode === 0x0) {
					closeSocket(1002, "Continuation frames are not supported.");
					return;
				} else if (opcode === 0x2) {
					closeSocket(1003, "Binary frames are not supported.");
					return;
				} else if (opcode === 0x1) {
					if (!fin) {
						closeSocket(1003, "Fragmented frames are not supported.");
						return;
					}
				} else {
					closeSocket(1002, "Unknown opcode.");
					return;
				}

				// Check client frame payload length before accumulating payload bytes.
				let headerLen = 2;
				let payloadLen = len7;
				if (len7 === 126) {
					if (buffered < 4) return;
					payloadLen = (peekByte(2) << 8) | peekByte(3);
					if (payloadLen < 126) {
						closeSocket(1002, "Non-minimal 16-bit frame length.");
						return;
					}
					headerLen = 4;
				} else if (len7 === 127) {
					if (buffered < 10) return;
					const hi = ((peekByte(2) << 24) | (peekByte(3) << 16) | (peekByte(4) << 8) | peekByte(5)) >>> 0;
					const lo = ((peekByte(6) << 24) | (peekByte(7) << 16) | (peekByte(8) << 8) | peekByte(9)) >>> 0;
					if ((hi & 0x80000000) !== 0) {
						closeSocket(1002, "Invalid 64-bit frame length.");
						return;
					}
					if (hi === 0 && lo < 65536) {
						closeSocket(1002, "Non-minimal 64-bit frame length.");
						return;
					}
					if (hi !== 0 || lo > maxClientFrameBytes) {
						closeSocket(1009, "Client frame exceeds 16 KiB.");
						return;
					}
					payloadLen = lo;
					headerLen = 10;
				}

				if (payloadLen > maxClientFrameBytes) {
					closeSocket(1009, "Client frame exceeds 16 KiB.");
					return;
				}

				const totalLen = headerLen + 4 + payloadLen;
				if (buffered < totalLen) return;

				consume(headerLen);
				const mask = consume(4);
				const raw = consume(payloadLen);
				const payload = Buffer.allocUnsafe(payloadLen);
				for (let i = 0; i < payloadLen; i += 1) payload[i] = raw[i] ^ mask[i & 3];

				if (awaitingPeerClose) {
					if (opcode === 0x8) {
						endClosingTransport();
						return;
					}
					continue;
				}

				lastHeardAt = Date.now();
				if (opcode === 0x9) {
					options.onActivity?.();
					sendRaw(encodeFrame(0xa, payload));
				} else if (opcode === 0xa) {
					// Pong proves client liveness.
				} else if (opcode === 0x8) {
					handleClientClose(payload);
					return;
				} else if (opcode === 0x1) {
					options.onActivity?.();
					let text: string;
					try {
						text = UTF8_DECODER.decode(payload);
					} catch {
						closeSocket(1007, "Invalid UTF-8 in text frame.");
						return;
					}
					options.onMessage?.(client, text);
				}
			}
		};

		const onData = (chunk: Buffer) => {
			if (closed || (closing && !awaitingPeerClose) || !chunk.length) return;
			chunks.push(chunk);
			buffered += chunk.length;
			parseFrames();
		};

		activeClients.add(client);
		options.onActivity?.();
		if (clientIdleTimeoutMs > 0 && pingIntervalMs > 0) {
			idleTimer = setInterval(() => {
				if (closed || closing) return;
				if (Date.now() - lastHeardAt >= clientIdleTimeoutMs) {
					closeSocket(1001, "Client idle timeout.");
					return;
				}
				sendRaw(encodeFrame(0x9));
			}, pingIntervalMs);
			idleTimer.unref();
		}
		socket.on("data", onData);
		socket.on("close", cleanup);
		socket.on("end", () => {
			if (!closing) closeSocket();
			else if (awaitingPeerClose) endClosingTransport();
		});
		socket.on("error", cleanup);

		options.onConnect?.(client);
		if (head && head.length > 0) onData(head);
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen({ port: listenPort, host: "127.0.0.1", exclusive: true }, () => {
			server.off("error", rejectListen);
			const addr = server.address();
			boundPort = typeof addr === "object" && addr ? addr.port : listenPort;
			resolveListen();
		});
	});

	return {
		get port() {
			return boundPort;
		},
		server,
		openSockets: () => activeClients.size,
		clients: () => [...activeClients],
		broadcast(messages: unknown[]) {
			for (const client of [...activeClients]) {
				client.sendMessages(messages);
			}
		},
		async close() {
			disposed = true;
			for (const [socket, timer] of pendingHandshakes) {
				clearTimeout(timer);
				if (!socket.destroyed) socket.destroy();
			}
			pendingHandshakes.clear();
			for (const client of [...activeClients]) {
				client.close(1001, "Server shutting down.");
			}
			for (const socket of [...closingSockets]) {
				if (!socket.destroyed) socket.destroy();
			}
			server.closeAllConnections?.();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}
