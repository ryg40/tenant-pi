declare module "*/walkr/src/a2ui.js" {
	export const A2UI_VERSION: "1.0";
	export const A2UI_BASIC_CATALOG: string;
	export const A2UI_LIMITS: Readonly<{
		messages: number;
		components: number;
		bytes: number;
		surfaces: number;
		idChars: number;
		depth: number;
	}>;
	export function checkA2uiMessages(
		messages: unknown,
		known?: Map<string, { components: Map<string, unknown>; data: Record<string, unknown> }>,
	): { ok: true; messages: unknown[]; surfaces: Array<{ surfaceId: string; components: number; deleted: boolean }> } | { ok: false; error: string };
}

declare module "*/walkr/src/compare-socket.js" {
	import type { Duplex } from "node:stream";
	export const WS_LIMITS: Readonly<{
		maxSockets: number;
		maxSurfaces: number;
		maxClientFrameBytes: number;
		maxSendQueueBytes: number;
		handshakeTimeoutMs: number;
		pollMs: number;
		maxPendingActions: number;
		closeGraceMs: number;
	}>;
	export function rejectUpgrade(
		socket: Duplex,
		status: number,
		payload: unknown,
		options?: { headers?: Record<string, string> },
	): void;
}
