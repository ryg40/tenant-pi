import { A2UI_BASIC_CATALOG, A2UI_VERSION } from "../../walkr/src/a2ui.js";
import { COMPACT_TASK_CHARS, shortSubject, truncateTask, type OwnerRow, type RowOption } from "./rows.ts";

/**
 * Pure A2UI v1.0 surface builder for Layout B (compact cards in one row, focused card grows).
 * Builds one independent surface per coordinator terminal (`owner-tasks:<address>`).
 * Uses only components drawn by the Herdr app panel (`Text`, `Row`, `Column`, `Card`, `Button`,
 * `ChoicePicker`, `TextField`). Uses `weight` (never `width`, `flex`, or `distribution`).
 * Binds only data-model paths shown by controls in the current draw.
 */

export const SURFACE_ID_PREFIX = "owner-tasks:";
export const FOCUSED_CARD_WEIGHT = 42;
export const COMPACT_CARD_WEIGHT = 16;

export type DeciderStatusWord = "decider ..." | "decider" | "no decider";

export interface RowViewState {
	row: OwnerRow;
	selectedOptionId: string | null;
	customText: string;
	confirmed: boolean;
}

export interface CoordinatorGroup {
	address: string;
	revision: string;
	reportDigest?: string;
	name?: string;
	excerpt: string;
	rows: RowViewState[];
	focusedLabel: string | null;
	deciderStatus: DeciderStatusWord;
	statusMessage: string;
}

export interface RenderedButtonSpec {
	id: string;
	name: "focus" | "confirm" | "send" | "close";
	literals: Record<string, string>;
	bindsPick: boolean;
	bindsOther: boolean;
}

export interface SurfaceState {
	coordinators: CoordinatorGroup[];
}

export interface EffectiveAnswer {
	text: string;
	picked: 1 | 2 | 3 | "custom";
}

export interface A2uiComponent {
	id: string;
	component: string;
	weight?: number;
	[key: string]: unknown;
}

export interface SurfaceSpec {
	components: A2uiComponent[];
	dataModel: Record<string, unknown>;
}

/** Build the A2UI surface ID for one coordinator terminal address. */
export function surfaceIdFor(address: string): string {
	return `${SURFACE_ID_PREFIX}${address}`;
}

/** Extract the coordinator terminal address from a surface ID, or null if not an owner-tasks surface ID. */
export function addressFromSurfaceId(surfaceId: string): string | null {
	if (!surfaceId.startsWith(SURFACE_ID_PREFIX)) return null;
	const address = surfaceId.slice(SURFACE_ID_PREFIX.length);
	return address.length > 0 ? address : null;
}

/** Collapse line breaks and control/format characters so every sent field stays on one line. */
export function singleLineText(text: string): string {
	return text.replace(/[\r\n\t\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
}

/** Clean control/format characters and line breaks, and neutralize row delimiters (`;`, `[`, `]`). */
export function sanitizeSendField(text: string): string {
	return singleLineText(text)
		.replace(/;/g, ",")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/\s+/g, " ")
		.trim();
}

export function effectiveAnswer(item: RowViewState): EffectiveAnswer | null {
	const custom = singleLineText(item.customText);
	if (custom.length > 0) {
		return { text: custom, picked: "custom" };
	}
	if (!item.selectedOptionId) return null;
	const optionIndex = item.row.options.findIndex((opt) => opt.id === item.selectedOptionId);
	if (optionIndex >= 0) {
		const rank = (optionIndex + 1) as 1 | 2 | 3;
		const clean = singleLineText(item.row.options[optionIndex].text);
		return clean ? { text: clean, picked: rank } : null;
	}
	const fallback = item.row.candidates.find((opt) => opt.id === item.selectedOptionId);
	if (fallback) {
		const clean = singleLineText(fallback.text);
		return clean ? { text: clean, picked: 1 } : null;
	}
	return null;
}

/** True only when a row has an answer and, if risky, has been explicitly confirmed. */
export function isRowConfirmed(item: RowViewState): boolean {
	if (!effectiveAnswer(item)) return false;
	return !item.row.risky || item.confirmed;
}

/** True when a risky row has a picked option or typed custom text that still needs `confirm`. */
export function isRowPendingConfirm(item: RowViewState): boolean {
	return item.row.risky && !item.confirmed && effectiveAnswer(item) !== null;
}

/**
 * Format the single `[Owner popup]` line sent back to one coordinator (without any receipt suffix).
 * Cleans control/format characters and line breaks in every field and replaces `;`, `[`, `]` with `,`, `(`, `)`.
 * Only confirmed rows go in: a risky row needs its Confirm press.
 */
export function formatSendLine(group: CoordinatorGroup): string | null {
	const parts: string[] = [];
	for (const item of group.rows) {
		const ans = effectiveAnswer(item);
		if (!ans) continue;
		if (!isRowConfirmed(item)) continue;
		const label = sanitizeSendField(item.row.label);
		const subject = sanitizeSendField(shortSubject(item.row.text));
		const answer = sanitizeSendField(ans.text);
		if (!label || !answer) continue;
		parts.push(`[${label}] ${subject}: ${answer}`);
	}
	if (parts.length === 0) return null;
	return `[Owner popup] ${parts.join("; ")}`;
}

export function coordinatorHeading(group: Pick<CoordinatorGroup, "address" | "name">): string {
	return group.name ? `${group.name} · ${group.address}` : group.address;
}

/** Format one ChoicePicker option label, adding probability and "recommended" only when allowed. */
export function formatOptionLabel(option: RowOption, row: OwnerRow): string {
	if (row.deciderApplied && option.probability !== undefined) {
		const prob = option.probability.toFixed(2);
		if (option.recommended && !row.risky) {
			return `${option.text} (${prob}, recommended)`;
		}
		return `${option.text} (${prob})`;
	}
	return option.text;
}

export function rowTags(item: RowViewState): string[] {
	if (item.row.writing) return ["writing..."];
	if (item.row.risky) {
		return isRowPendingConfirm(item) ? ["risk", "confirm"] : ["risk"];
	}
	if (item.row.kind === "owner_step") return ["owner step"];
	if (item.row.noClearPick) return ["no clear pick"];
	return [];
}

function compactAnswerSummary(item: RowViewState): string {
	if (item.row.writing) return "writing answers ...";
	const ans = effectiveAnswer(item);
	if (!ans) return "open";
	if (item.row.risky && !item.confirmed) {
		return `needs confirm: ${truncateTask(ans.text, 52)}`;
	}
	const prefix = item.row.risky ? "confirmed" : "answered";
	return `${prefix}: ${truncateTask(ans.text, 60)}`;
}

function headerProgressText(rows: readonly RowViewState[]): string {
	const total = rows.length;
	const answered = rows.filter(isRowConfirmed).length;
	const pendingRisk = rows.filter(isRowPendingConfirm);
	const openRows = rows.filter((item) => !isRowConfirmed(item) && !isRowPendingConfirm(item));

	if (pendingRisk.length > 0) {
		const labels = pendingRisk.map((item) => `[${item.row.label}]`).join(", ");
		return `${answered} answered · ${labels} needs confirm`;
	}
	if (answered > 0 && openRows.length > 0 && openRows.length <= 2) {
		const labels = openRows.map((item) => `[${item.row.label}]`).join(", ");
		return `${answered} of ${total} answered · ${labels} open`;
	}
	return `${answered} of ${total} answered`;
}

/** Resolve which row is currently focused on one coordinator surface; defaults to its first row when unset or stale. */
export function resolveFocused(group: CoordinatorGroup): RowViewState | null {
	if (group.focusedLabel) {
		const item = group.rows.find((r) => r.row.label === group.focusedLabel);
		if (item) return item;
	}
	return group.rows[0] ?? null;
}

/**
 * Build the A2UI v1.0 component list and data model for one coordinator's surface.
 * Only paths shown by controls in this drawing (`/focused/pick`, `/focused/other`) are bound in buttons.
 */
export function buildSurfaceSpec(group: CoordinatorGroup): SurfaceSpec {
	const components: A2uiComponent[] = [];
	const focusedItem = resolveFocused(group);

	const hasPicker = Boolean(focusedItem && !focusedItem.row.writing && focusedItem.row.options.length > 0);
	const hasOther = Boolean(focusedItem && !focusedItem.row.writing);

	const buttonContext = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
		const ctx: Record<string, unknown> = { ...extra };
		if (focusedItem) {
			ctx.focusedCoordinator = group.address;
			ctx.focusedLabel = focusedItem.row.label;
			ctx.focusedRevision = group.revision;
			if (hasPicker) ctx.focusedPick = { "@path": "/focused/pick" };
			if (hasOther) ctx.focusedOther = { "@path": "/focused/other" };
		}
		return ctx;
	};

	const anyActionable = group.rows.some(isRowConfirmed);
	const rootChildren: string[] = ["hdr"];

	// Header row
	components.push({ id: "hdr_title", component: "Text", text: "Owner tasks", variant: "h4" });
	components.push({
		id: "hdr_coord",
		component: "Text",
		text: coordinatorHeading(group),
		variant: "caption",
	});
	components.push({ id: "hdr_status", component: "Text", text: group.deciderStatus, variant: "caption" });
	components.push({
		id: "hdr_left",
		component: "Row",
		align: "center",
		children: ["hdr_title", "hdr_coord", "hdr_status"],
	});

	components.push({
		id: "hdr_count",
		component: "Text",
		text: headerProgressText(group.rows),
		variant: "caption",
	});
	// A surface exists only while its coordinator sits at its prompt, so the primary button is always "Send answers".
	components.push({ id: "btn_send_lbl", component: "Text", text: "Send answers" });
	components.push({
		id: "btn_send",
		component: "Button",
		child: "btn_send_lbl",
		variant: anyActionable ? "primary" : "default",
		action: {
			event: {
				name: "send",
				context: buttonContext({ targetCoordinator: group.address, targetRevision: group.revision }),
			},
		},
	});
	components.push({ id: "btn_close_lbl", component: "Text", text: "Close" });
	components.push({
		id: "btn_close",
		component: "Button",
		child: "btn_close_lbl",
		variant: "default",
		action: {
			event: {
				name: "close",
				context: buttonContext({ targetCoordinator: group.address, targetRevision: group.revision }),
			},
		},
	});
	components.push({
		id: "hdr_right",
		component: "Row",
		align: "center",
		children: ["hdr_count", "btn_send", "btn_close"],
	});
	components.push({
		id: "hdr",
		component: "Row",
		justify: "spaceBetween",
		align: "center",
		children: ["hdr_left", "hdr_right"],
	});

	if (group.statusMessage) {
		rootChildren.push("status_line");
		components.push({ id: "status_line", component: "Text", text: group.statusMessage, variant: "caption" });
	}

	// One Row of Cards for this coordinator's open tasks
	const rowId = "coord_row_0";
	const cardIds: string[] = [];

	group.rows.forEach((item, ri) => {
		const prefix = `c_0_${ri}`;
		const isFocused = Boolean(focusedItem && focusedItem.row.label === item.row.label);
		const tags = rowTags(item);
		const headText = tags.length > 0 ? `[${item.row.label}] · ${tags.join(" · ")}` : `[${item.row.label}]`;

		const colChildren: string[] = [];

		if (isFocused) {
			const focusedHead = item.row.writing ? `[${item.row.label}] · writing answers ...` : headText;
			const focusedText =
				item.row.writing || tags.length > 0 ? `${focusedHead} — ${item.row.text}` : `${focusedHead} ${item.row.text}`;
			colChildren.push(`${prefix}_q`);
			components.push({ id: `${prefix}_q`, component: "Text", text: focusedText, variant: "body" });

			if (!item.row.writing) {
				if (hasPicker) {
					colChildren.push("focused_picker");
					components.push({
						id: "focused_picker",
						component: "ChoicePicker",
						label: "Answers",
						variant: "mutuallyExclusive",
						value: { "@path": "/focused/pick" },
						options: item.row.options.slice(0, 3).map((opt) => ({
							value: opt.id,
							label: formatOptionLabel(opt, item.row),
						})),
					});
				}
				if (item.row.risky) {
					colChildren.push("focused_confirm_row");
					components.push({
						id: "focused_confirm_msg",
						component: "Text",
						text: item.confirmed ? "risk: confirmed" : "risk: confirm this answer",
						variant: "caption",
					});
					components.push({ id: "focused_confirm_lbl", component: "Text", text: "Confirm" });
					components.push({
						id: "focused_confirm_btn",
						component: "Button",
						child: "focused_confirm_lbl",
						variant: "primary",
						action: {
							event: {
								name: "confirm",
								context: buttonContext({
									targetCoordinator: group.address,
									targetLabel: item.row.label,
									targetRevision: group.revision,
								}),
							},
						},
					});
					components.push({
						id: "focused_confirm_row",
						component: "Row",
						justify: "spaceBetween",
						align: "center",
						children: ["focused_confirm_msg", "focused_confirm_btn"],
					});
				}
				if (hasOther) {
					colChildren.push("focused_other");
					components.push({
						id: "focused_other",
						component: "TextField",
						label: "Other answer",
						placeholder: "Other answer",
						variant: "shortText",
						value: { "@path": "/focused/other" },
					});
				}
			}
		} else {
			colChildren.push(`${prefix}_head`, `${prefix}_q`, `${prefix}_ans`, `${prefix}_btn`);
			components.push({ id: `${prefix}_head`, component: "Text", text: headText, variant: "h5" });
			components.push({
				id: `${prefix}_q`,
				component: "Text",
				text: truncateTask(item.row.text, COMPACT_TASK_CHARS),
				variant: "body",
			});
			components.push({
				id: `${prefix}_ans`,
				component: "Text",
				text: compactAnswerSummary(item),
				variant: "caption",
			});
			components.push({ id: `${prefix}_btn_lbl`, component: "Text", text: `Focus [${item.row.label}]` });
			components.push({
				id: `${prefix}_btn`,
				component: "Button",
				child: `${prefix}_btn_lbl`,
				variant: "borderless",
				action: {
					event: {
						name: "focus",
						context: buttonContext({
							targetCoordinator: group.address,
							targetLabel: item.row.label,
							targetRevision: group.revision,
						}),
					},
				},
			});
		}

		components.push({ id: `${prefix}_col`, component: "Column", children: colChildren });
		components.push({
			id: prefix,
			component: "Card",
			child: `${prefix}_col`,
			weight: isFocused ? FOCUSED_CARD_WEIGHT : COMPACT_CARD_WEIGHT,
		});
		cardIds.push(prefix);
	});

	if (cardIds.length > 0) {
		rootChildren.push(rowId);
		components.push({ id: rowId, component: "Row", align: "stretch", children: cardIds });
	}

	// Send-line preview when at least one row for this coordinator is ready to send
	const preview = formatSendLine(group);
	if (preview) {
		rootChildren.push("preview_line");
		components.push({ id: "preview_line", component: "Text", text: `Send line: ${preview}`, variant: "caption" });
	}

	components.unshift({ id: "root", component: "Column", children: rootChildren });

	const focusedModel: Record<string, unknown> = {};
	if (hasPicker && focusedItem) {
		focusedModel.pick = focusedItem.selectedOptionId ? [focusedItem.selectedOptionId] : [];
	}
	if (hasOther && focusedItem) {
		focusedModel.other = focusedItem.customText;
	}

	const dataModel: Record<string, unknown> = { focused: focusedModel };
	return { components, dataModel };
}

/** Map of all currently rendered Button components on one coordinator surface and their bound literal/path contexts. */
export function renderedButtonSpecs(group: CoordinatorGroup): Map<string, RenderedButtonSpec> {
	const map = new Map<string, RenderedButtonSpec>();
	const { components } = buildSurfaceSpec(group);
	for (const comp of components) {
		if (comp.component !== "Button") continue;
		const event = (comp.action as { event?: { name?: unknown; context?: unknown } } | undefined)?.event;
		if (!event) continue;
		const name = event.name;
		if (name !== "focus" && name !== "confirm" && name !== "send" && name !== "close") continue;
		const ctx = event.context && typeof event.context === "object" && !Array.isArray(event.context)
			? (event.context as Record<string, unknown>)
			: {};
		const literals: Record<string, string> = {};
		let bindsPick = false;
		let bindsOther = false;
		for (const [key, val] of Object.entries(ctx)) {
			if (typeof val === "string") {
				literals[key] = val;
			} else if (val && typeof val === "object" && "@path" in val) {
				if (key === "focusedPick") bindsPick = true;
				if (key === "focusedOther") bindsOther = true;
			}
		}
		map.set(comp.id, { id: comp.id, name, literals, bindsPick, bindsOther });
	}
	return map;
}

/** Build the `createSurface` message batch for a client that does not yet have this surface. */
export function toCreateSurfaceMessages(group: CoordinatorGroup): unknown[] {
	const { components, dataModel } = buildSurfaceSpec(group);
	return [
		{
			version: A2UI_VERSION,
			createSurface: {
				surfaceId: surfaceIdFor(group.address),
				catalogId: A2UI_BASIC_CATALOG,
				components,
				dataModel,
			},
		},
	];
}

/** Build `[deleteSurface, createSurface]` in one batch to replace a surface that a client already has. */
export function toReplaceSurfaceMessages(group: CoordinatorGroup): unknown[] {
	const surfaceId = surfaceIdFor(group.address);
	const { components, dataModel } = buildSurfaceSpec(group);
	return [
		{
			version: A2UI_VERSION,
			deleteSurface: {
				surfaceId,
			},
		},
		{
			version: A2UI_VERSION,
			createSurface: {
				surfaceId,
				catalogId: A2UI_BASIC_CATALOG,
				components,
				dataModel,
			},
		},
	];
}

/** Build `[updateComponents, updateDataModel]` for in-place focus, confirm, rank, status, and writer updates. */
export function toUpdateSurfaceMessages(group: CoordinatorGroup): unknown[] {
	const surfaceId = surfaceIdFor(group.address);
	const { components, dataModel } = buildSurfaceSpec(group);
	return [
		{
			version: A2UI_VERSION,
			updateComponents: {
				surfaceId,
				components,
			},
		},
		{
			version: A2UI_VERSION,
			updateDataModel: {
				surfaceId,
				path: "",
				value: dataModel,
			},
		},
	];
}

/** Build the `deleteSurface` message for one coordinator surface. */
export function toDeleteSurfaceMessages(surfaceId: string): unknown[] {
	return [
		{
			version: A2UI_VERSION,
			deleteSurface: {
				surfaceId,
			},
		},
	];
}
