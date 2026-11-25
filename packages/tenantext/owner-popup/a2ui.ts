import { A2UI_BASIC_CATALOG, A2UI_VERSION } from "../../walkr/src/a2ui.js";
import { shortSubject, truncateTask, type OwnerRow, type RowOption } from "./rows.ts";

/**
 * Pure A2UI v1.0 surface builder for the two-column owner-task rail (the layout contract with the owner-rail mod of the Herdr app; see `docs/owner-popup.md`).
 * Builds one independent surface per coordinator terminal (`owner-tasks:<address>`).
 * The `root` Column carries `owner_rail_layout: "two-column"`; its children are `header`, optional lines, and `body`
 * (a Row of `left`, all open rows stacked with their answers, and `right`, one Row with a check box for each answered row).
 * Uses only standard components (`Text`, `Row`, `Column`, `Button`, `TextField`), so a mod that does not know the
 * contract draws the surface stacked. Binds only `/rows/<label>/other`, one path for each "Other answer" field drawn.
 */

export const SURFACE_ID_PREFIX = "owner-tasks:";
export const CHIP_CHARS = 60;

export type DeciderStatusWord = "decider ..." | "decider" | "no decider";

export interface RowViewState {
	row: OwnerRow;
	selectedOptionId: string | null;
	/** The text that is the answer of the row (from "Use text"); a non-empty text wins over `selectedOptionId`. */
	customText: string;
	/** The text in the "Other answer" field of the row that is not used yet. It is no answer; it only survives redraws. */
	draft: string;
	confirmed: boolean;
	/** The check box of the row: only a checked row with a valid answer goes into the send line. */
	checked: boolean;
	/**
	 * The version of the answer of the row. It changes when the answer is set, replaced or cleared. The Confirm Button
	 * carries it as the literal `answerVersion`, so a Confirm approves only the answer that its surface showed.
	 */
	answerVersion?: number;
	/**
	 * The row took over an answer from a row that was risky in the old report (by words or by the decider). It needs a
	 * Confirm as a risky row does, until its Confirm or until the risk result of the new report.
	 */
	riskHold?: boolean;
}

export interface CoordinatorGroup {
	address: string;
	revision: string;
	reportDigest?: string;
	name?: string;
	excerpt: string;
	rows: RowViewState[];
	deciderStatus: DeciderStatusWord;
	statusMessage: string;
	/** A press of Send was accepted and its send runs: the surface shows only the small pending form, with no button. */
	receiptPending?: boolean;
	/**
	 * The coordinator works (a delivered send or a turn-start): the surface has no Send button and refuses `send`
	 * until the next report; the other actions still work.
	 */
	locked?: boolean;
	/** After a delivered send with rows left: the labels of the sent rows, shown as "Receipt pending" until the turn-start. */
	sentPending?: string[];
}

export type ButtonActionName = "choose" | "other" | "toggle" | "confirm" | "send" | "close";
export const BUTTON_ACTIONS: ReadonlySet<string> = new Set<ButtonActionName>(["choose", "other", "toggle", "confirm", "send", "close"]);

/** The context key of a Button that carries the draft of row `<label>`: `other_<label>`, bound to `/rows/<label>/other`. */
export const DRAFT_KEY_PREFIX = "other_";
export const DRAFT_KEY_RE = /^other_[A-Za-z]+$/;

export function draftKey(label: string): string {
	return `${DRAFT_KEY_PREFIX}${label}`;
}

export interface RenderedButtonSpec {
	id: string;
	name: ButtonActionName;
	literals: Record<string, string>;
	/** The labels of the rows whose draft this Button context binds (`other_<label>`). */
	drafts: ReadonlySet<string>;
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

/** True when the answer of a row needs a Confirm press: the row is risky, or it holds the risk of the old report. */
export function needsConfirm(item: RowViewState): boolean {
	return item.row.risky || Boolean(item.riskHold);
}

/** True only when a row has an answer and, if risky, has been explicitly confirmed. */
export function isRowConfirmed(item: RowViewState): boolean {
	if (!effectiveAnswer(item)) return false;
	return !needsConfirm(item) || item.confirmed;
}

/** True when a risky row has a picked option or typed custom text that still needs `confirm`. */
export function isRowPendingConfirm(item: RowViewState): boolean {
	return needsConfirm(item) && !item.confirmed && effectiveAnswer(item) !== null;
}

/**
 * True when a row is answered: checked, with a valid answer, and confirmed when risky. An answered row is drawn in
 * `right` and goes into the send line; every other row is open and drawn in `left`.
 */
export function isRowAnswered(item: RowViewState): boolean {
	if (!item.checked || !isRowConfirmed(item)) return false;
	const ans = effectiveAnswer(item);
	return Boolean(ans && sanitizeSendField(item.row.label) && sanitizeSendField(ans.text));
}

/** The rows that go into the send line, in report order: the answered rows. */
export function sendableRows(group: CoordinatorGroup): RowViewState[] {
	return group.rows.filter(isRowAnswered);
}

/**
 * Format the single `[Owner popup]` line sent back to one coordinator (without any receipt suffix).
 * Cleans control/format characters and line breaks in every field and replaces `;`, `[`, `]` with `,`, `(`, `)`.
 * Only the rows of `sendableRows` go in: a row needs its check box, and a risky row needs its Confirm press.
 */
export function formatSendLine(group: CoordinatorGroup): string | null {
	const parts: string[] = [];
	for (const item of sendableRows(group)) {
		const ans = effectiveAnswer(item) as EffectiveAnswer;
		const label = sanitizeSendField(item.row.label);
		const subject = sanitizeSendField(shortSubject(item.row.text));
		parts.push(`[${label}] ${subject}: ${sanitizeSendField(ans.text)}`);
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
	if (needsConfirm(item)) {
		return isRowPendingConfirm(item) ? ["risk", "confirm"] : ["risk"];
	}
	if (item.row.kind === "owner_step") return ["owner step"];
	if (item.row.noClearPick) return ["no clear pick"];
	return [];
}

/** The count of the header and of the Send button: the rows that a press of Send sends now. */
export function sendCount(group: CoordinatorGroup): number {
	return sendableRows(group).length;
}

/** The status line of a locked surface: the coordinator works, so Send waits for its next report. */
export function lockedText(group: Pick<CoordinatorGroup, "address" | "name">): string {
	return `${coordinatorHeading(group)} works now. Send is possible again after its next report; you can prepare answers.`;
}

function ext(extensions: Record<string, unknown>): Record<string, unknown> {
	return { "@metadata": { extensions } };
}

/** The text of the one line of an empty `left`: every row of the surface has an answer. */
/** The label prefix of the chosen option of an open row that waits for Confirm: a plain marker, no check mark. */
export const PENDING_PICK_PREFIX = "Chosen: ";

export function allAnsweredText(group: Pick<CoordinatorGroup, "locked">): string {
	return group.locked ? "All rows have an answer." : "All rows have an answer. Press Send.";
}

/**
 * Build the A2UI v1.0 component list and data model for one coordinator's two-column surface.
 * `left` holds the open rows stacked in report order, flat: for each row its text, its answers, the Confirm row of a
 * risky row with an answer, and the Row of its "Other answer" field and "Use text" button. `right` holds the answered
 * rows. Every Button context binds the draft of each field drawn (`other_<label>` to `/rows/<label>/other`), so a press
 * carries all drafts and a redraw keeps them.
 */
export function buildSurfaceSpec(group: CoordinatorGroup): SurfaceSpec {
	const components: A2uiComponent[] = [];
	const pending = Boolean(group.receiptPending);
	const openRows = pending ? [] : group.rows.filter((item) => !isRowAnswered(item));
	const answeredRows = pending ? [] : group.rows.filter(isRowAnswered);
	const fieldRows = openRows.filter((item) => !item.row.writing);

	const draftBindings: Record<string, unknown> = {};
	for (const item of fieldRows) draftBindings[draftKey(item.row.label)] = { "@path": `/rows/${item.row.label}/other` };
	const surfaceContext = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		targetCoordinator: group.address,
		targetRevision: group.revision,
		...extra,
		...draftBindings,
	});
	// Close binds no draft: it works at any draft size.
	const closeContext = { targetCoordinator: group.address, targetRevision: group.revision };
	const rowContext = (label: string, extra: Record<string, unknown> = {}) => surfaceContext({ targetLabel: label, ...extra });
	const button = (id: string, name: ButtonActionName, label: string, variant: string, context: Record<string, unknown>, more: Record<string, unknown> = {}) => {
		components.push({ id: `${id}_lbl`, component: "Text", text: label });
		components.push({ id, component: "Button", child: `${id}_lbl`, variant, ...more, action: { event: { name, context } } });
	};

	// Header: title, coordinator, decider word, count, Send (not while locked or pending), Close (not while pending).
	const count = sendCount(group);
	const headerChildren = ["hdr_title", "hdr_coord", "hdr_status", "hdr_count"];
	components.push({ id: "hdr_title", component: "Text", text: "Owner tasks", variant: "h4" });
	components.push({ id: "hdr_coord", component: "Text", text: coordinatorHeading(group), variant: "caption" });
	components.push({ id: "hdr_status", component: "Text", text: group.deciderStatus, variant: "caption" });
	components.push({ id: "hdr_count", component: "Text", text: `${count} of ${group.rows.length} answered`, variant: "caption" });
	if (!pending && !group.locked) {
		headerChildren.push("btn_send");
		button("btn_send", "send", count === 1 ? "Send 1 answer" : `Send ${count} answers`, count > 0 ? "primary" : "default", surfaceContext());
	}
	if (!pending) {
		headerChildren.push("btn_close");
		button("btn_close", "close", "Close", "default", closeContext);
	}
	components.push({ id: "header", component: "Row", justify: "spaceBetween", align: "center", children: headerChildren });

	const rootChildren: string[] = ["header"];
	const status = [!pending && group.locked ? lockedText(group) : "", group.statusMessage].filter(Boolean).join(" ");
	if (status) {
		rootChildren.push("status_line");
		components.push({ id: "status_line", component: "Text", text: status, variant: "caption" });
	}

	// Left: the pending line, then each open row flat: text, answers side by side, Confirm row, Other answer + Use text.
	const leftChildren: string[] = [];
	if (pending || (group.sentPending && group.sentPending.length > 0)) {
		const sent = pending ? "" : `: ${(group.sentPending ?? []).map((label) => `[${label}]`).join(", ")}`;
		leftChildren.push("pending_text");
		components.push({ id: "pending_text", component: "Text", text: `Receipt pending for ${coordinatorHeading(group)}${sent}`, variant: "caption" });
	}
	for (const item of openRows) {
		const label = item.row.label;
		const tags = rowTags(item);
		const head = item.row.writing ? `[${label}] · writing answers ...` : tags.length > 0 ? `[${label}] · ${tags.join(" · ")}` : `[${label}]`;
		const sep = item.row.writing || tags.length > 0 ? " — " : " ";
		leftChildren.push(`open_text_${label}`);
		components.push({ id: `open_text_${label}`, component: "Text", text: `${head}${sep}${item.row.text}`, variant: "body" });
		if (item.row.writing) continue;
		const options = item.row.options.slice(0, 3);
		if (options.length > 0) {
			const answerIds: string[] = [];
			for (const opt of options) {
				const id = `answer_${label}_${opt.id}`;
				// A row in `left` has no answer that counts yet: a chosen option of a risky row waits for Confirm. It gets
				// the Button variant "primary" and the prefix "Chosen: ", never a check mark.
				const chosen = item.checked && item.selectedOptionId === opt.id && singleLineText(item.customText).length === 0;
				answerIds.push(id);
				button(id, "choose", `${chosen ? PENDING_PICK_PREFIX : ""}${formatOptionLabel(opt, item.row)}`, chosen ? "primary" : "default", rowContext(label, { optionId: opt.id }));
			}
			leftChildren.push(`answers_${label}`);
			components.push({ id: `answers_${label}`, component: "Row", align: "center", children: answerIds });
		}
		if (item.checked && isRowPendingConfirm(item)) {
			const ans = effectiveAnswer(item) as EffectiveAnswer;
			leftChildren.push(`confirm_row_${label}`);
			// The whole stored answer, not a prefix: the owner confirms the text that they can read. The Text wraps.
			components.push({ id: `confirm_msg_${label}`, component: "Text", text: `risk: confirm the answer "${ans.text}"`, variant: "caption", weight: 1 });
			button(`confirm_${label}`, "confirm", "Confirm", "primary", rowContext(label, { answerVersion: String(item.answerVersion ?? 0) }));
			components.push({ id: `confirm_row_${label}`, component: "Row", justify: "spaceBetween", align: "center", children: [`confirm_msg_${label}`, `confirm_${label}`] });
		}
		leftChildren.push(`other_row_${label}`);
		components.push({ id: `other_${label}`, component: "TextField", label: "Other answer", placeholder: "Other answer", variant: "shortText", value: { "@path": `/rows/${label}/other` }, weight: 1 });
		button(`use_text_${label}`, "other", "Use text", "default", rowContext(label));
		components.push({ id: `other_row_${label}`, component: "Row", align: "center", children: [`other_${label}`, `use_text_${label}`] });
	}
	if (!pending && openRows.length === 0) {
		leftChildren.push("all_answered_text");
		components.push({ id: "all_answered_text", component: "Text", text: allAnsweredText(group), variant: "caption" });
	}
	components.push({ id: "left", component: "Column", children: leftChildren });

	// Right: one Row for each answered row in report order: check box, row text, chosen answer.
	const rightChildren: string[] = [];
	for (const item of answeredRows) {
		const label = item.row.label;
		button(`toggle_${label}`, "toggle", "[x]", "default", rowContext(label), ext({ owner_rail_role: "check", owner_rail_checked: true }));
		components.push({ id: `focus_${label}`, component: "Text", text: `[${label}] ${item.row.text}`, variant: "body", ...ext({ owner_rail_role: "row-text" }) });
		const ans = effectiveAnswer(item);
		components.push({ id: `chip_${label}`, component: "Text", text: ans ? truncateTask(ans.text, CHIP_CHARS) : "", variant: "caption" });
		components.push({ id: `row_${label}`, component: "Row", align: "center", children: [`toggle_${label}`, `focus_${label}`, `chip_${label}`] });
		rightChildren.push(`row_${label}`);
	}
	components.push({ id: "right", component: "Column", children: rightChildren });
	components.push({ id: "body", component: "Row", align: "start", children: ["left", "right"] });
	rootChildren.push("body");

	components.unshift({ id: "root", component: "Column", children: rootChildren, ...ext({ owner_rail_layout: "two-column" }) });

	const rowsModel: Record<string, unknown> = {};
	for (const item of fieldRows) rowsModel[item.row.label] = { other: item.draft };
	return { components, dataModel: { rows: rowsModel } };
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
		if (typeof name !== "string" || !BUTTON_ACTIONS.has(name)) continue;
		const ctx = event.context && typeof event.context === "object" && !Array.isArray(event.context)
			? (event.context as Record<string, unknown>)
			: {};
		const literals: Record<string, string> = {};
		const drafts = new Set<string>();
		for (const [key, val] of Object.entries(ctx)) {
			if (typeof val === "string") {
				literals[key] = val;
			} else if (val && typeof val === "object" && "@path" in val && DRAFT_KEY_RE.test(key)) {
				drafts.add(key.slice(DRAFT_KEY_PREFIX.length));
			}
		}
		map.set(comp.id, { id: comp.id, name: name as ButtonActionName, literals, drafts });
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

/** Build `[updateComponents, updateDataModel]` for in-place choose, other, toggle, confirm, rank, status, and writer updates. */
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
