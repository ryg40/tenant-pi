// A2UI v1.0 surfaces for Walkr pages: a check of the agent-to-renderer messages, and a renderer that draws them.
// A2UI (Agent-to-User Interface, Apache-2.0) describes a user interface as JSON data; the page draws it with its own
// components. This file takes the message kinds createSurface, updateComponents, updateDataModel and deleteSurface,
// and the supported catalog components and Walkr extensions. Browser and Node tests load the same file.
// The renderer draws with createElement and textContent only. It sets no style attribute and no event attribute, and it
// sends nothing to a server: a Button action goes to the onAction callback of the page. The only request is the load
// of a sandboxed frame of this origin (WalkrFrame or a preview in walkr_optionDetails).

import { isRating, RATING_MIN, RATING_MAX, starsLabel, stepRating } from "./compare-stars.js";

export const A2UI_VERSION = "1.0";
export const A2UI_BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
/** The limits of one call of the check or of `apply`, and of one surface. */
export const A2UI_LIMITS = Object.freeze({ messages: 8, components: 200, bytes: 64 * 1024, surfaces: 4, idChars: 64, depth: 32 });
/**
 * The budget of one draw pass of a surface: drawn component instances, drawn text characters, and `steps`, the work of
 * the @checks conditions. `index` is the largest array index of a data model path, and `items` the most items that one
 * template draws.
 */
export const A2UI_DRAW = Object.freeze({ instances: 2000, text: 64 * 1024, steps: 10000, index: 999, items: 200 });
/**
 * The Walkr extension of a ChoicePicker, in `@metadata.extensions`: a list of `{ value, description?, recommended?,
 * preview? }`. The option of the basic catalog has only `label` and `value`.
 * `preview` is a small sketch of the content of the option, in a box of a fixed small height that cuts it. It is
 * `{ "text": "..." }`, a literal text that the sender has cut already, or `{ "frame": "/path" }`, a path of this origin
 * whose document shows scaled down in a sandboxed frame with no rights: no scripts, an opaque origin, no forms, no
 * popups. A preview takes no click, no focus and no place in the accessibility tree; a click on it selects the option.
 * A chip (`displayStyle: "chips"`) shows no preview.
 */
export const A2UI_OPTION_DETAILS = "walkr_optionDetails";
/**
 * The Walkr extension of a TextField or a ChoicePicker, in `@metadata.extensions`: true, or a `{"@path"}` binding to a
 * boolean. While it is true, the input shows its value and takes no change. The basic catalog has no such property.
 */
export const A2UI_READ_ONLY = "walkr_readOnly";
/**
 * The Walkr extension of a TextField, in `@metadata.extensions`: the most characters that the user can enter. Not for
 * the variant `number`: a browser does not apply the limit to a number input.
 */
export const A2UI_MAX_LENGTH = "walkr_maxLength";
/**
 * The Walkr extension of a TextField, in `@metadata.extensions`: `true`. The input keeps its accessible name
 * (`aria-label`) from `label` and draws no visible label text above the field.
 */
export const A2UI_HIDE_LABEL = "walkr_hideLabel";

const JUSTIFY = ["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"];
const ALIGN = ["start", "center", "end", "stretch"];
// The components of the basic catalog: their properties, the required ones, the enumerations and the URL properties.
// The Text variants h1 to h5 are not in the v1.0 catalog (it has caption and body); the first prototype draws them.
const CATALOG = {
  Text: { props: ["text", "variant"], required: ["text"], enums: { variant: ["caption", "body", "h1", "h2", "h3", "h4", "h5"] } },
  WalkrFrame: { props: ["frame", "label"], required: ["frame", "label"] },
  Image: { props: ["url", "description", "fit", "variant"], required: ["url"], urls: ["url"],
    enums: { fit: ["contain", "cover", "fill", "none", "scaleDown"], variant: ["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"] } },
  Icon: { props: ["name"], required: ["name"] },
  Video: { props: ["url", "posterUrl"], required: ["url"], urls: ["url", "posterUrl"] },
  AudioPlayer: { props: ["url", "description"], required: ["url"], urls: ["url"] },
  Row: { props: ["children", "justify", "align"], required: ["children"], enums: { justify: JUSTIFY, align: ALIGN } },
  Column: { props: ["children", "justify", "align"], required: ["children"], enums: { justify: JUSTIFY, align: ALIGN } },
  List: { props: ["children", "direction", "align"], required: ["children"], enums: { direction: ["vertical", "horizontal"], align: ALIGN } },
  Card: { props: ["child"], required: ["child"] },
  Tabs: { props: ["tabs"], required: ["tabs"] },
  Modal: { props: ["trigger", "content"], required: ["trigger", "content"] },
  Divider: { props: ["axis"], enums: { axis: ["horizontal", "vertical"] } },
  Button: { props: ["child", "variant", "action"], required: ["child", "action"], enums: { variant: ["default", "primary", "borderless"] }, checkable: true },
  TextField: { props: ["label", "value", "placeholder", "variant"], required: ["label", "value"], enums: { variant: ["shortText", "longText", "number", "obscured"] }, checkable: true },
  CheckBox: { props: ["label", "value"], required: ["label", "value"], checkable: true },
  ChoicePicker: { props: ["label", "variant", "options", "value", "displayStyle", "filterable"], required: ["options", "value"],
    enums: { variant: ["multipleSelection", "mutuallyExclusive"], displayStyle: ["checkbox", "chips"] }, checkable: true },
  Slider: { props: ["label", "min", "max", "value", "steps"], required: ["value", "max"], checkable: true },
  DateTimeInput: { props: ["value", "enableDate", "enableTime", "min", "max", "label"], required: ["value"], checkable: true },
};
const COMPONENTS = Object.keys(CATALOG);
/** The properties that hold the ID of another component. */
const REFERENCES = { child: "one", children: "list", trigger: "one", content: "one" };
const STRUCTURE = new Set(["id", "component", "tabs", "options", "action", "@checks", "@metadata", ...Object.keys(REFERENCES)]);
const MESSAGE_KINDS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"];
const BODY_KEYS = {
  createSurface: ["surfaceId", "catalogId", "components", "dataModel", "theme", "sendDataModel", "metadata"],
  updateComponents: ["surfaceId", "components"],
  updateDataModel: ["surfaceId", "path", "value"],
  deleteSurface: ["surfaceId"],
};
// The functions of a check rule. The renderer runs them; regex stays out, so no pattern of a message can stall the page.
const CHECKS = ["required", "length", "and", "or", "not"];
const ID = /^[A-Za-z0-9_.:-]+$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
/** A binding path: a JSON pointer, or a path relative to the item of a template ("name", "a/b"). */
const PATH = /^(?:(?:[^~/]|~[01])+)?(?:\/(?:[^~/]|~[01])*)*$/;
const EXTENSION_KEY = /^[\p{XID_Start}_][\p{XID_Continue}]*$/u;
// The frame of a preview: a path of the origin of the page. No scheme, no host, no "//", no backslash, no query.
const FRAME_PATH = /^\/[A-Za-z0-9._~-][A-Za-z0-9._~%/-]{0,2046}$/;
// A data model write never names these steps: a page object or prototype stays as it is.
const UNSAFE_STEPS = new Set(["__proto__", "constructor", "prototype"]);

class Refusal extends Error {}
const refuse = (text) => { throw new Refusal(text); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// A short text of a value for an error text. A JSON object becomes JSON: its own "toString" key is never called.
const clip = (value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value)).slice(0, 40);
const byteLength = (text) => new TextEncoder().encode(text).length;

function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(`${where}: unknown key "${clip(key)}". Allowed keys: ${allowed.join(", ")}.`);
}

function idOf(value, where, name = "a component ID") {
  if (typeof value !== "string" || value.length === 0 || value.length > A2UI_LIMITS.idChars || !ID.test(value)) {
    refuse(`${where}: ${name} must be 1 to ${A2UI_LIMITS.idChars} characters of A-Z, a-z, 0-9, _ . : -.`);
  }
  return value;
}

/** The depth limit and the key "__proto__", for each value of a message. */
function depthOf(value, where, depth = 0) {
  if (depth > A2UI_LIMITS.depth) refuse(`${where}: the JSON is deeper than ${A2UI_LIMITS.depth} levels.`);
  if (Array.isArray(value)) for (const item of value) depthOf(item, where, depth + 1);
  else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (key === "__proto__") refuse(`${where}: the key "__proto__" is not allowed.`);
      depthOf(value[key], where, depth + 1);
    }
  }
}

/**
 * A value of a property: a literal, `{"@path": "/json/pointer"}` or `{"@call": "formatString", "args": {"value": "..."}}`.
 * Each other object with an "@" key is refused. A literal object or array is checked at each depth.
 */
function checkValue(value, where) {
  if (Array.isArray(value)) { value.forEach((item, index) => checkValue(item, `${where}[${index}]`)); return; }
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  if (keys.some((key) => key.startsWith("@"))) {
    if (keys.length === 1 && keys[0] === "@path") {
      if (typeof value["@path"] !== "string" || !PATH.test(value["@path"])) refuse(`${where}: @path must be a JSON pointer such as "/form/day", or a path relative to a template item.`);
      return;
    }
    if (Object.hasOwn(value, "@call")) {
      if (value["@call"] !== "formatString") refuse(`${where}: @call "${clip(value["@call"])}" is not supported here. A value takes formatString only.`);
      onlyKeys(value, ["@call", "args"], where);
      if (!isObject(value.args) || typeof value.args.value !== "string") refuse(`${where}: formatString needs args.value, a text with \${/path} parts.`);
      onlyKeys(value.args, ["value"], `${where}.args`);
      return;
    }
    refuse(`${where}: a value object takes "@path" alone or "@call" with "args".`);
  }
  for (const [key, item] of Object.entries(value)) checkValue(item, `${where}.${key}`);
}

/** A condition of a check rule: a binding, or a call of required, length, and, or, not. Inside and, or, not: also true or false. */
function checkCondition(value, where, inner = false) {
  if (inner && typeof value === "boolean") return;
  if (!isObject(value)) refuse(`${where}: a condition is a {"@path"} binding or a call of ${CHECKS.join(", ")}.`);
  if (Object.hasOwn(value, "@path")) { checkValue(value, where); return; }
  const name = value["@call"];
  if (!CHECKS.includes(name)) refuse(`${where}: @call "${clip(name)}" is not supported in a check. Use one of ${CHECKS.join(", ")}.`);
  onlyKeys(value, ["@call", "args"], where);
  const args = value.args;
  if (!isObject(args)) refuse(`${where}.args: give an object.`);
  if (name === "and" || name === "or") {
    onlyKeys(args, ["values"], `${where}.args`);
    if (!Array.isArray(args.values) || args.values.length < 2) refuse(`${where}.args.values: give at least 2 conditions.`);
    args.values.forEach((item, index) => checkCondition(item, `${where}.args.values[${index}]`, true));
  } else if (name === "not") {
    onlyKeys(args, ["value"], `${where}.args`);
    checkCondition(args.value, `${where}.args.value`, true);
  } else {
    onlyKeys(args, name === "length" ? ["value", "min", "max"] : ["value"], `${where}.args`);
    if (!Object.hasOwn(args, "value")) refuse(`${where}.args: ${name} needs "value".`);
    checkValue(args.value, `${where}.args.value`);
    if (name === "length") {
      if (args.min === undefined && args.max === undefined) refuse(`${where}.args: length needs "min" or "max".`);
      for (const key of ["min", "max"]) if (args[key] !== undefined && !(Number.isInteger(args[key]) && args[key] >= 0)) refuse(`${where}.args.${key}: give a whole number of 0 or more.`);
    }
  }
}

function checkUrl(value, where) {
  if (isObject(value) && Object.keys(value).some((key) => key.startsWith("@"))) return; // A bound URL is checked when it draws.
  if (typeof value !== "string") refuse(`${where}: give the URL as a text or as a @path binding.`);
  let url;
  try { url = new URL(value); } catch { refuse(`${where}: "${value.slice(0, 80)}" is not an absolute URL.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") refuse(`${where}: only https: and http: URLs are allowed.`);
  if (url.username !== "" || url.password !== "") refuse(`${where}: a URL with credentials is not allowed.`);
}

function checkMetadata(raw, at) {
  const metadata = raw["@metadata"];
  if (metadata === undefined) return {};
  if (!isObject(metadata)) refuse(`${at}.@metadata: give {"extensions": {...}}.`);
  onlyKeys(metadata, ["extensions"], `${at}.@metadata`);
  const extensions = metadata.extensions ?? {};
  if (!isObject(extensions)) refuse(`${at}.@metadata.extensions: give an object.`);
  for (const key of Object.keys(extensions)) if (!EXTENSION_KEY.test(key)) refuse(`${at}.@metadata.extensions: the key "${clip(key)}" is not an identifier.`);
  return extensions;
}

/** The extension walkr_optionDetails: each entry names one option of the picker by its value. */
function checkOptionDetails(raw, extensions, at) {
  if (!Object.hasOwn(extensions, A2UI_OPTION_DETAILS)) return;
  const where = `${at}.@metadata.extensions.${A2UI_OPTION_DETAILS}`;
  if (raw.component !== "ChoicePicker") refuse(`${where}: this extension is for a ChoicePicker only.`);
  const details = extensions[A2UI_OPTION_DETAILS];
  if (!Array.isArray(details)) refuse(`${where}: give an array of {"value", "description", "recommended", "preview"}.`);
  const values = new Set(raw.options.map((option) => option.value)), seen = new Set();
  details.forEach((detail, index) => {
    const item = `${where}[${index}]`;
    if (!isObject(detail)) refuse(`${item}: give {"value", "description", "recommended", "preview"}.`);
    onlyKeys(detail, ["value", "description", "recommended", "preview"], item);
    if (typeof detail.value !== "string" || !values.has(detail.value)) refuse(`${item}.value: name the value of one option of this picker.`);
    if (seen.has(detail.value)) refuse(`${item}.value: the option "${clip(detail.value)}" has details twice.`);
    seen.add(detail.value);
    if (detail.description !== undefined) checkValue(detail.description, `${item}.description`);
    if (detail.recommended !== undefined && typeof detail.recommended !== "boolean") refuse(`${item}.recommended: give true or false.`);
    if (detail.preview !== undefined) checkPreview(detail.preview, `${item}.preview`);
  });
}

/** The preview of one option: `{ "text" }`, a nonempty literal text, or `{ "frame" }`, a path of the origin of the page. */
function checkPreview(preview, where) {
  const shape = `give {"text": "..."} or {"frame": "/path"}`;
  if (!isObject(preview)) refuse(`${where}: ${shape}.`);
  onlyKeys(preview, ["text", "frame"], where);
  if (Object.keys(preview).length !== 1) refuse(`${where}: ${shape}, with exactly one of the two keys.`);
  if (Object.hasOwn(preview, "text") && (typeof preview.text !== "string" || preview.text === "")) refuse(`${where}.text: give a nonempty literal text.`);
  if (Object.hasOwn(preview, "frame") && (typeof preview.frame !== "string" || !FRAME_PATH.test(preview.frame))) {
    refuse(`${where}.frame: give a path of this origin of at most 2048 characters, such as "/doc/1": no scheme, no host, no query.`);
  }
}

/** The extensions walkr_readOnly (a TextField or a ChoicePicker) and walkr_maxLength (a TextField that is not a number field). */
function checkInputExtensions(raw, extensions, at) {
  const where = (key) => `${at}.@metadata.extensions.${key}`;
  if (Object.hasOwn(extensions, A2UI_READ_ONLY)) {
    const value = extensions[A2UI_READ_ONLY];
    if (raw.component !== "TextField" && raw.component !== "ChoicePicker" && !(raw.component === "Slider" && extensions.walkr_stars === true)) refuse(`${where(A2UI_READ_ONLY)}: this extension needs a text field, picker or star rating.`);
    if (typeof value !== "boolean" && !(isObject(value) && Object.hasOwn(value, "@path"))) refuse(`${where(A2UI_READ_ONLY)}: give true, false or a {"@path"} binding.`);
    checkValue(value, where(A2UI_READ_ONLY));
  }
  if (Object.hasOwn(extensions, A2UI_MAX_LENGTH)) {
    const value = extensions[A2UI_MAX_LENGTH];
    if (raw.component !== "TextField") refuse(`${where(A2UI_MAX_LENGTH)}: this extension is for a TextField only.`);
    // A browser does not apply an entry limit to a number input.
    if (raw.variant === "number") refuse(`${where(A2UI_MAX_LENGTH)}: a TextField of the variant "number" takes no entry limit. Use another variant, or leave the extension out.`);
    if (!Number.isInteger(value) || value < 1 || value > A2UI_DRAW.text) refuse(`${where(A2UI_MAX_LENGTH)}: give a whole number from 1 to ${A2UI_DRAW.text}.`);
  }
  if (Object.hasOwn(extensions, A2UI_HIDE_LABEL)) {
    if (extensions[A2UI_HIDE_LABEL] !== true || raw.component !== "TextField") refuse(`${where(A2UI_HIDE_LABEL)}: this extension needs true on a TextField.`);
    if (typeof raw.label === "string" && raw.label.trim() === "") refuse(`${where(A2UI_HIDE_LABEL)}: a literal label must have nonblank text.`);
  }
}

/** The component IDs that one component names. A template names its one component. */
function referencesOf(component) {
  const ids = [];
  for (const [key, kind] of Object.entries(REFERENCES)) {
    const value = component[key];
    if (value === undefined) continue;
    if (kind === "one") ids.push(value);
    else if (Array.isArray(value)) ids.push(...value);
    else ids.push(value.componentId);
  }
  if (component.component === "Tabs") for (const tab of component.tabs) ids.push(tab.child);
  return ids;
}

function checkComponent(raw, where) {
  if (!isObject(raw)) refuse(`${where}: a component must be an object with "id" and "component".`);
  const id = idOf(raw.id, `${where}.id`);
  const name = raw.component, at = `${where} (${id})`;
  if (typeof name !== "string" || !Object.hasOwn(CATALOG, name)) refuse(`${at}: component "${clip(name)}" is not in the basic catalog. Use one of: ${COMPONENTS.join(", ")}.`);
  const rules = CATALOG[name];
  onlyKeys(raw, ["id", "component", "weight", "@metadata", ...rules.props, ...(rules.checkable ? ["@checks"] : [])], at);
  for (const key of rules.required ?? []) if (raw[key] === undefined) refuse(`${at}: ${name} needs "${key}".`);
  for (const [key, kind] of Object.entries(REFERENCES)) {
    const value = raw[key];
    if (value === undefined) continue;
    if (kind === "one") idOf(value, `${at}.${key}`);
    else if (Array.isArray(value)) value.forEach((item, index) => idOf(item, `${at}.${key}[${index}]`));
    else if (isObject(value)) {
      onlyKeys(value, ["componentId", "path"], `${at}.${key}`);
      idOf(value.componentId, `${at}.${key}.componentId`);
      if (typeof value.path !== "string" || !PATH.test(value.path)) refuse(`${at}.${key}.path: give a JSON pointer to a list of the data model.`);
    } else refuse(`${at}.${key}: give an array of component IDs or a template {"componentId", "path"}.`);
  }
  if (name === "Tabs") {
    if (!Array.isArray(raw.tabs) || raw.tabs.length === 0) refuse(`${at}.tabs: give an array of {"title", "child"}.`);
    raw.tabs.forEach((tab, index) => {
      if (!isObject(tab)) refuse(`${at}.tabs[${index}]: give {"title", "child"}.`);
      onlyKeys(tab, ["title", "child"], `${at}.tabs[${index}]`);
      checkValue(tab.title, `${at}.tabs[${index}].title`);
      idOf(tab.child, `${at}.tabs[${index}].child`);
    });
  }
  if (name === "ChoicePicker") {
    if (!Array.isArray(raw.options) || raw.options.length === 0) refuse(`${at}.options: give an array of {"label", "value"}.`);
    const values = new Set();
    raw.options.forEach((option, index) => {
      if (!isObject(option) || option.label === undefined || typeof option.value !== "string") refuse(`${at}.options[${index}]: give {"label", "value"} with a text value.`);
      onlyKeys(option, ["label", "value"], `${at}.options[${index}]`);
      checkValue(option.label, `${at}.options[${index}].label`);
      if (values.has(option.value)) refuse(`${at}.options[${index}]: the value "${clip(option.value)}" is used twice.`);
      values.add(option.value);
    });
    if (raw.filterable !== undefined && typeof raw.filterable !== "boolean") refuse(`${at}.filterable: give true or false.`);
  }
  const extensions = checkMetadata(raw, at);
  const binding = (value) => isObject(value) && Object.keys(value).length === 1 && typeof value["@path"] === "string" && PATH.test(value["@path"]) && value["@path"] !== "";
  const short = (value) => typeof value === "string" && value.trim() !== "" && value.length <= 256;
  if (name === "WalkrFrame" && (!short(raw.label) || typeof raw.frame !== "string" || !/^\/_walkr\/compare\/o\/[a-f0-9]{64}\/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.frame))) {
    refuse(`${at}: a WalkrFrame needs a short label and a literal Compare option frame path.`);
  }
  const { walkr_fold: fold, walkr_marks: marks, walkr_activeTab: tab } = extensions;
  if (fold !== undefined && (name !== "Column" || !(short(fold) || binding(fold)))) refuse(`${at}: walkr_fold needs a Column and a short summary or binding.`);
  if (extensions.walkr_stars !== undefined && (extensions.walkr_stars !== true || name !== "Slider" || !short(raw.label) || !binding(raw.value) || raw.min !== RATING_MIN || raw.max !== RATING_MAX || raw.steps !== RATING_MAX - RATING_MIN)) refuse(`${at}: walkr_stars needs a labelled, bound Slider with min 1, max 10 and 9 steps.`);
  if (tab !== undefined && (name !== "Tabs" || !binding(tab))) refuse(`${at}: walkr_activeTab needs Tabs and a path binding.`);
  if (marks !== undefined) {
    if (name !== "Text" || typeof raw.text !== "string" || !Array.isArray(marks) || marks.length > 200) refuse(`${at}: walkr_marks needs literal Text and at most 200 ranges.`);
    let end = 0;
    for (const range of marks) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger) || range[0] < end || range[0] >= range[1] || range[1] > raw.text.length) refuse(`${at}: invalid word range.`);
      end = range[1];
    }
  }
  checkOptionDetails(raw, extensions, at);
  checkInputExtensions(raw, extensions, at);
  for (const [key, allowed] of Object.entries(rules.enums ?? {})) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) refuse(`${at}.${key}: use one of ${allowed.join(", ")}.`);
  }
  for (const key of rules.urls ?? []) if (raw[key] !== undefined) checkUrl(raw[key], `${at}.${key}`);
  if (raw.weight !== undefined && !(typeof raw.weight === "number" && raw.weight > 0 && raw.weight <= 100)) refuse(`${at}.weight: give a number above 0, at most 100.`);
  if (raw.action !== undefined) {
    const action = raw.action;
    if (!isObject(action) || !isObject(action.event)) refuse(`${at}.action: give {"event": {"name", "context"}}. Only event actions are supported.`);
    onlyKeys(action, ["event"], `${at}.action`);
    onlyKeys(action.event, ["name", "context", "userMessage"], `${at}.action.event`);
    const event = action.event;
    if (typeof event.name !== "string" || event.name === "" || event.name.length > A2UI_LIMITS.idChars) refuse(`${at}.action.event.name: give a name of 1 to ${A2UI_LIMITS.idChars} characters.`);
    if (event.context !== undefined && !isObject(event.context)) refuse(`${at}.action.event.context: give an object.`);
    checkValue(event.context ?? {}, `${at}.action.event.context`);
    if (event.userMessage !== undefined) checkValue(event.userMessage, `${at}.action.event.userMessage`);
  }
  if (raw["@checks"] !== undefined) {
    if (!Array.isArray(raw["@checks"])) refuse(`${at}.@checks: give an array of {"condition", "message"}.`);
    raw["@checks"].forEach((rule, index) => {
      const item = `${at}.@checks[${index}]`;
      if (!isObject(rule)) refuse(`${item}: give {"condition", "message"}.`);
      onlyKeys(rule, ["condition", "message"], item);
      checkCondition(rule.condition, `${item}.condition`);
      if (rule.message !== undefined && typeof rule.message !== "string") refuse(`${item}.message: give a text.`);
    });
  }
  for (const [key, value] of Object.entries(raw)) if (!STRUCTURE.has(key)) checkValue(value, `${at}.${key}`);
  return raw;
}

function checkComponents(list, where) {
  if (!Array.isArray(list)) refuse(`${where}: components must be an array.`);
  const seen = new Set();
  return list.map((raw, index) => {
    const component = checkComponent(raw, `${where}[${index}]`);
    if (seen.has(component.id)) refuse(`${where}: the ID "${component.id}" is used twice in one message.`);
    seen.add(component.id);
    return component;
  });
}

const stepsOf = (pointer) => pointer === "" ? [] : pointer.slice(1).split("/").map((step) => step.replaceAll("~1", "/").replaceAll("~0", "~"));

/** True for an array step that a write accepts: an index from 0 to the array length, at most A2UI_DRAW.index. */
function indexAllowed(list, step, remove) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(step)) return false;
  const index = Number(step);
  return index <= A2UI_DRAW.index && (remove ? index < list.length : index <= list.length);
}

/**
 * Put `value` at `pointer` in the object `root`; an absent value takes the item out, a missing level becomes an object.
 * Each step is checked before any change. Returns null, or the reason of a refusal, and then nothing has changed.
 */
function place(root, pointer, value) {
  const steps = stepsOf(pointer);
  if (steps.length === 0) return "a write names a path below the root of the data model";
  let node = root;
  for (const [index, step] of steps.entries()) {
    const last = index === steps.length - 1, remove = last && value === undefined;
    if (UNSAFE_STEPS.has(step)) return `the path step "${step}" is not allowed`;
    if (Array.isArray(node) && !indexAllowed(node, step, remove)) {
      const top = Math.min(remove ? node.length - 1 : node.length, A2UI_DRAW.index);
      return `the step "${clip(step)}" is in an array of ${node.length} items; ${remove && node.length === 0 ? "the array is empty, so no item can be taken out" : `give an index from 0 to ${top} to ${remove ? "take an item out" : "write"}`}`;
    }
    if (!last) { const next = Object.hasOwn(node, step) ? node[step] : undefined; node = next !== null && typeof next === "object" ? next : {}; }
  }
  node = root;
  for (const step of steps.slice(0, -1)) {
    if (!Object.hasOwn(node, step) || node[step] === null || typeof node[step] !== "object") node[step] = {};
    node = node[step];
  }
  const last = steps.at(-1);
  if (value === undefined) { if (Array.isArray(node)) node.splice(Number(last), 1); else delete node[last]; }
  else node[last] = value;
  return null;
}

/** Each surface: its root, each reference with a target, no cycle, and a drawn tree within the instance budget. */
function checkSurface(surfaceId, components) {
  const where = `surface ${surfaceId}`;
  if (components.size > A2UI_LIMITS.components) refuse(`${where}: at most ${A2UI_LIMITS.components} components.`);
  if (!components.has("root")) refuse(`${where}: no component has the ID "root". Exactly one component must be "root".`);
  for (const component of components.values()) {
    for (const target of referencesOf(component)) if (!components.has(target)) refuse(`${where}: component "${component.id}" names "${target}", and no component has that ID.`);
  }
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") refuse(`${where}: component "${id}" contains itself.`);
    state.set(id, "open");
    for (const target of referencesOf(components.get(id))) visit(target);
    state.set(id, "done");
  };
  visit("root");
  // The renderer draws each occurrence of a component: count the expanded instances from root, each tab and modal content
  // included. Each ChoicePicker option and each tab button is one instance too. A template counts its component once; the
  // renderer charges each item of a template against the same budget when it draws.
  const counts = new Map();
  const count = (id) => {
    if (counts.has(id)) return counts.get(id);
    const component = components.get(id);
    let sum = 1 + (component.component === "ChoicePicker" ? component.options.length : 0) + (component.component === "Tabs" ? component.tabs.length : 0);
    for (const target of referencesOf(component)) sum = Math.min(sum + count(target), A2UI_DRAW.instances + 1);
    counts.set(id, sum);
    return sum;
  };
  if (count("root") > A2UI_DRAW.instances) refuse(`${where}: the tree from "root" expands to more than ${A2UI_DRAW.instances} drawn components. Each reference draws its component again; use fewer shared references.`);
}

/** The messages as plain JSON within the limits of one call: a copy, so a later change by the caller changes nothing here. */
function normalize(input) {
  if (!Array.isArray(input) || input.length === 0) refuse("messages must be a non-empty array of A2UI v1.0 messages.");
  if (input.length > A2UI_LIMITS.messages) refuse(`at most ${A2UI_LIMITS.messages} messages in one call; this call has ${input.length}.`);
  let json;
  try { json = JSON.stringify(input); } catch { refuse("messages must be JSON data: no cycle, no BigInt and no deeper nesting than the limit."); }
  const bytes = byteLength(json);
  if (bytes > A2UI_LIMITS.bytes) refuse(`the messages have ${bytes} bytes of JSON; the limit is ${A2UI_LIMITS.bytes}.`);
  return JSON.parse(json);
}

/** The envelope of each message: version, one kind, the keys of its body, a surface ID, and the limits of the call. */
function envelope(list) {
  let components = 0;
  const created = new Set();
  return list.map((message, index) => {
    const where = `message ${index + 1}`;
    if (!isObject(message)) refuse(`${where}: a message must be an object.`);
    if (message.version !== A2UI_VERSION) refuse(`${where}: version must be "1.0".`);
    const kinds = Object.keys(message).filter((key) => key !== "version");
    if (kinds.length !== 1 || !MESSAGE_KINDS.includes(kinds[0])) {
      refuse(`${where}: a message has "version" and exactly one of ${MESSAGE_KINDS.join(", ")}; found ${kinds.length === 0 ? "none" : kinds.map((kind) => `"${clip(kind)}"`).join(", ")}.`);
    }
    const kind = kinds[0], body = message[kind];
    if (!isObject(body)) refuse(`${where}.${kind}: give an object.`);
    depthOf(body, `${where}.${kind}`);
    onlyKeys(body, BODY_KEYS[kind], `${where}.${kind}`);
    const surfaceId = idOf(body.surfaceId, `${where}.${kind}.surfaceId`, "surfaceId");
    if (Array.isArray(body.components)) components += body.components.length;
    if (components > A2UI_LIMITS.components) refuse(`at most ${A2UI_LIMITS.components} components in one call.`);
    if (kind === "createSurface" && created.add(surfaceId).size > A2UI_LIMITS.surfaces) refuse(`at most ${A2UI_LIMITS.surfaces} surfaces in one call.`);
    return { kind, body, surfaceId, where };
  });
}

/**
 * The state of each surface that the messages change, after they apply in order. `known` holds the surfaces of earlier
 * calls ({ components, data }); they are copied, never changed. Throws a Refusal with a text that an agent can act on.
 */
function review(entries, known) {
  const states = new Map();
  for (const { kind, body, surfaceId, where } of entries) {
    const at = `${where}.${kind}`;
    if (kind === "createSurface") {
      if (body.catalogId !== undefined && body.catalogId !== A2UI_BASIC_CATALOG) refuse(`${at}.catalogId: only the basic catalog ${A2UI_BASIC_CATALOG} is supported.`);
      if (body.sendDataModel !== undefined && typeof body.sendDataModel !== "boolean") refuse(`${at}.sendDataModel: give true or false.`);
      if (body.dataModel !== undefined && !isObject(body.dataModel)) refuse(`${at}.dataModel: give a JSON object.`);
      const components = body.components === undefined ? [] : checkComponents(body.components, `${at}.components`);
      states.set(surfaceId, { components: new Map(components.map((component) => [component.id, component])), data: structuredClone(body.dataModel ?? {}), deleted: false });
      continue;
    }
    if (kind === "deleteSurface") { states.set(surfaceId, { components: new Map(), data: {}, deleted: true }); continue; }
    if (!states.has(surfaceId) && known.has(surfaceId)) {
      const old = known.get(surfaceId);
      states.set(surfaceId, { components: new Map(old.components), data: structuredClone(old.data), deleted: false });
    }
    const state = states.get(surfaceId);
    if (!state || state.deleted) refuse(`${at}: surface "${surfaceId}" does not exist. Create it first with createSurface.`);
    if (kind === "updateComponents") {
      for (const component of checkComponents(body.components, `${at}.components`)) state.components.set(component.id, component);
      continue;
    }
    if (body.path !== undefined && (typeof body.path !== "string" || !POINTER.test(body.path))) refuse(`${at}.path: give a JSON pointer such as "/form/day".`);
    const value = Object.hasOwn(body, "value") ? structuredClone(body.value) : undefined;
    if ((body.path ?? "") === "") {
      if (value !== undefined && !isObject(value)) refuse(`${at}.value: the root of the data model is a JSON object.`);
      state.data = value ?? {};
    } else {
      const reason = place(state.data, body.path, value);
      if (reason) refuse(`${at}.path: ${reason}.`);
    }
  }
  for (const [surfaceId, state] of states) if (!state.deleted) checkSurface(surfaceId, state.components);
  return states;
}

/**
 * Check the A2UI v1.0 messages of one call. Without `known`, each surface that the call changes must be created in that
 * call. With `known` (a Map of existing surface states `{ components, data }`), updates to those surfaces are checked
 * against them. Returns the checked copy of the messages, or one error text. It never throws.
 */
export function checkA2uiMessages(messages, known = new Map()) {
  try {
    const list = normalize(messages);
    const states = review(envelope(list), known instanceof Map ? known : new Map());
    return { ok: true, messages: list, surfaces: [...states].map(([surfaceId, state]) => ({ surfaceId, components: state.components.size, deleted: state.deleted })) };
  } catch (error) {
    // Any other error is a defect of the check. The messages are then refused too.
    return { ok: false, error: error instanceof Refusal ? error.message : "The messages could not be checked." };
  }
}

// ---- The renderer

// The serial number of the element IDs of all hosts of a page: two hosts never make the same ID.
let serial = 0;

const getData = (data, pointer) => {
  let value = data;
  for (const step of stepsOf(pointer)) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, step)) return undefined;
    value = value[step];
  }
  return value;
};
const absolute = (path, scope) => {
  const text = String(path ?? "");
  return text === "" || text.startsWith("/") ? text : `${scope === "/" ? "" : scope}/${text}`;
};
const textOf = (value) => value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
const boundPath = (value, scope) => isObject(value) && typeof value["@path"] === "string" ? absolute(value["@path"], scope) : null;
const isFormat = (value) => isObject(value) && value["@call"] === "formatString";
const listOf = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : typeof value === "string" ? [value] : [];
// A copy of a value without prototypes: a key "__proto__" stays a plain key of the JSON.
const plain = (value) => {
  if (Array.isArray(value)) return value.map(plain);
  if (!isObject(value)) return value;
  const copy = Object.create(null);
  for (const [key, item] of Object.entries(value)) copy[key] = plain(item);
  return copy;
};
// "required" of a value that is not an object: a value that is set. A text of spaces counts as empty, as the Compare
// page has always done.
const filled = (value) => value === undefined || value === null ? false : typeof value === "string" ? value.trim() !== ""
  : Array.isArray(value) ? value.length > 0 : true;
const valid = (value) => value === true || (isObject(value) && value.valid === true);

// The budget of one pass: a first draw of a surface, a later draw of a tab panel or a modal content, or one refresh after
// a change of the data model. Each component instance, ChoicePicker option and tab button takes one instance before it is
// made; each drawn character takes one of `text`; each condition step of @checks takes one of `steps`. A click checks
// again with a budget of its own. `out`: the budget is used up, so the pass stops.
const newBudget = () => ({ instances: A2UI_DRAW.instances, text: A2UI_DRAW.text, steps: A2UI_DRAW.steps, out: false });
function take(budget) {
  if (!budget.out && --budget.instances < 0) budget.out = true;
  return !budget.out;
}
function step(budget, size = 1) {
  if (!budget.out && (budget.steps -= size) < 0) budget.out = true;
  return !budget.out;
}
function charge(budget, text) {
  if (text.length > budget.text) { budget.out = true; text = text.slice(0, Math.max(budget.text, 0)); }
  budget.text -= text.length;
  return text;
}
// Run `work` in a pass. A nested call (the first tab inside the surface draw) uses the budget of its outer pass, and the
// outer budget comes back at the end. When the outermost pass ends with its budget used up, `ctx.over()` shows one line.
function pass(ctx, work) {
  const outer = ctx.budget, budget = outer ?? newBudget();
  ctx.budget = budget;
  try { return work(budget); } finally { ctx.budget = outer; if (!outer && budget.out) ctx.over(); }
}

/**
 * The renderer of A2UI surfaces on a page. `onAction(message)` gets the A2UI v1.0 `action` message of a Button; nothing
 * goes to a server. `onChange({ surfaceId, path, value })` follows each write of an input to the data model.
 * `apply(messages)` checks and applies one call; each surface has its own boundary, so one refused or broken surface
 * shows an error line and the other surfaces go on. It returns `{ ok, errors }`. `close()` removes the surfaces.
 */
export function createA2uiHost(document, { onAction = () => {}, onChange = () => {} } = {}) {
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const element = make("div", "a2ui-host");
  const surfaces = new Map();
  let closed = false;

  function add(id) {
    const section = make("section", "a2ui-surface");
    section.dataset.a2uiSurface = id;
    const error = make("p", "a2-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const content = make("div", "a2-content");
    section.append(error, content);
    element.append(section);
    // `generation` counts the draws of the surface. A delete and a failed draw count too, so a control of an earlier
    // draw is never current again.
    const surface = { id, section, error, content, components: new Map(), data: {}, valid: false, updaters: [], ctx: null, generation: 0 };
    surfaces.set(id, surface);
    return surface;
  }

  function apply(messages) {
    if (closed) return { ok: false, errors: ["The A2UI host is closed."] };
    let entries;
    try { entries = envelope(normalize(messages)); } catch (failure) {
      return { ok: false, errors: [failure instanceof Refusal ? failure.message : "The messages could not be checked."] };
    }
    const groups = new Map();
    for (const entry of entries) groups.set(entry.surfaceId, [...(groups.get(entry.surfaceId) ?? []), entry]);
    const errors = [];
    // The boundary of each surface: a refused or broken surface shows an error line, and the next surface goes on.
    for (const [id, group] of groups) {
      const live = surfaces.get(id);
      let state;
      try { state = review(group, new Map(live?.valid ? [[id, live]] : [])).get(id); } catch (failure) {
        const reason = failure instanceof Refusal ? failure.message : "the check failed.";
        errors.push(`Surface ${id}: ${reason}`);
        const surface = live ?? add(id);
        surface.error.textContent = `Surface ${id} not changed: ${reason}`;
        surface.error.hidden = false;
        continue;
      }
      if (state.deleted) {
        if (live) { live.generation += 1; live.updaters = []; live.section.remove(); }
        surfaces.delete(id);
        continue;
      }
      const surface = live ?? add(id);
      const full = !surface.valid || group.some((entry) => entry.kind !== "updateDataModel");
      Object.assign(surface, { components: state.components, data: state.data, valid: true });
      try {
        if (full) draw(surface); else refresh(surface);
        surface.error.hidden = true;
      } catch {
        surface.generation += 1;
        surface.updaters = [];
        surface.content.replaceChildren();
        errors.push(`Surface ${id}: the surface could not be drawn.`);
        surface.error.textContent = `Surface ${id} not shown: the surface could not be drawn.`;
        surface.error.hidden = false;
      }
    }
    return { ok: errors.length === 0, errors };
  }

  function close() {
    closed = true;
    for (const surface of surfaces.values()) surface.updaters = [];
    surfaces.clear();
    element.replaceChildren();
  }

  // Draw one surface again from "root". A data model change runs the updaters instead: inputs keep focus and text.
  function draw(surface) {
    surface.updaters = [];
    let over = null;
    const ctx = { open: new Set(), budget: null, generation: ++surface.generation, over: () => {
      over ??= make("p", "a2-missing a2-over", "Surface too large: the draw stops here.");
      surface.content.append(over);
    } };
    surface.ctx = ctx;
    surface.content.replaceChildren();
    surface.content.prepend(pass(ctx, () => drawOne(surface, "root", "", 0, ctx)));
  }
  function refresh(surface) {
    pass(surface.ctx, (budget) => { for (const update of surface.updaters) { if (budget.out) break; update(); } });
  }
  // A listener of one draw. It acts only while that draw is the current one of its surface: a later draw, a delete or a
  // failed draw makes it do nothing, so a control that a page still holds cannot act on a surface that is gone.
  function listen(surface, ctx, node, type, listener) {
    node.addEventListener(type, (event) => { if (!closed && surface.generation === ctx.generation) listener(event); });
  }

  // One write of an input: the value at its path, then each bound text and input draws again, all in one pass.
  function write(surface, path, value) {
    if (closed || path === null || place(surface.data, path, value) !== null) return;
    refresh(surface);
    onChange({ surfaceId: surface.id, path, value: plain(getData(surface.data, path)) });
  }

  const placeholder = (text) => make("span", "a2-missing", text);
  // The preview of an option card (walkr_optionDetails). It is inert and aria-hidden: it takes no click, no focus and
  // no place in the accessibility tree, so a click on it goes to the card, and a screen reader reads the label and the
  // description only. A text draws with textContent. A frame gets the sandbox of an option frame of the Compare page.
  function previewOf(preview, budget) {
    const wrap = make("span", "a2-option-preview");
    wrap.setAttribute("aria-hidden", "true");
    wrap.setAttribute("inert", "");
    const box = make("span", "a2-preview-box");
    if (typeof preview.text === "string") {
      box.classList.add("is-text");
      box.textContent = charge(budget, preview.text);
    } else {
      box.classList.add("is-html");
      const frame = make("iframe", "a2-preview-frame");
      frame.setAttribute("sandbox", "");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("loading", "lazy");
      // The box cuts the document: the frame shows no scroll bar of its own.
      frame.setAttribute("scrolling", "no");
      frame.src = preview.frame;
      box.append(frame);
    }
    wrap.append(box);
    return wrap;
  }
  // A media URL draws only as a link, and only with https: or http:.
  function link(url, text) {
    let parsed = null;
    try { parsed = new URL(String(url)); } catch {}
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) return placeholder(`${text} (no allowed URL)`);
    const anchor = make("a", "a2-media", text);
    anchor.href = parsed.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    return anchor;
  }

  // One component instance, charged against the budget of the pass. When the budget is used up, the pass stops: each
  // instance after that is an empty span, each list stops, and the surface shows one line.
  function drawOne(surface, id, scope, depth, ctx) {
    if (!take(ctx.budget)) return make("span");
    const component = surface.components.get(id);
    if (!component) return placeholder(`Missing component ${id}`);
    const key = `${id}@${scope}`;
    if (depth > 64 || ctx.open.has(key)) return placeholder(`Component ${id} repeats`);
    ctx.open.add(key);
    try {
      const node = drawComponent(surface, component, scope, depth, ctx);
      if (!node.dataset.a2uiPart) node.dataset.a2uiId = id;
      if (typeof component.weight === "number") node.style.setProperty("flex-grow", String(component.weight));
      return node;
    } finally { ctx.open.delete(key); }
  }

  // The children of a container: a list of IDs, or a template that repeats one component for each item of a list.
  function children(surface, value, scope, depth, ctx) {
    const drawn = [];
    const each = (ids, scopeOf) => { for (const [index, id] of ids.entries()) { if (ctx.budget.out) break; drawn.push(drawOne(surface, id, scopeOf(index), depth + 1, ctx)); } };
    if (Array.isArray(value)) { each(value.map(String), () => scope); return drawn; }
    if (!isObject(value) || typeof value.componentId !== "string") return drawn;
    const path = absolute(value.path, scope), list = getData(surface.data, path);
    const keys = (Array.isArray(list) ? list.map((_, index) => String(index)) : isObject(list) ? Object.keys(list) : []).slice(0, A2UI_DRAW.items);
    each(keys.map(() => value.componentId), (index) => `${path}/${keys[index].replaceAll("~", "~0").replaceAll("/", "~1")}`);
    return drawn;
  }

  // The @checks of a component: the first rule that fails shows its message below it. A failed rule disables a Button.
  // The conditions take steps and the message takes characters of the budget of the pass. A rule that the budget cannot
  // finish fails as a whole, so a used-up budget never lets an action through.
  function checks(surface, c, scope, ctx, main) {
    const rules = Array.isArray(c["@checks"]) ? c["@checks"] : [];
    if (!rules.length) return null;
    const line = make("small", "a2-check");
    line.id = `a2-check-${++serial}`;
    line.setAttribute("aria-live", "polite");
    main.setAttribute("aria-describedby", line.id);
    const failing = (budget) => rules.find((rule) => passes(surface, rule.condition, scope, budget) !== true || budget.out);
    const update = () => {
      const budget = ctx.budget ?? newBudget(), rule = failing(budget);
      const text = rule ? charge(budget, rule.message ?? "Check this value.") : "";
      line.hidden = !rule;
      if (line.textContent !== text) line.textContent = text;
      if (c.component === "Button") main.disabled = Boolean(rule);
      else if (rule) main.setAttribute("aria-invalid", "true"); else main.removeAttribute("aria-invalid");
    };
    update();
    surface.updaters.push(update);
    // A click checks again with a budget of its own.
    return { line, failing: () => failing(newBudget()) };
  }
  // The verdict of one condition: true, false, or null when the budget is used up. A null ends each operator around it
  // at once and stays null, so `not` and `or` cannot turn a used-up budget into a pass.
  function passes(surface, condition, scope, budget) {
    if (!step(budget)) return null;
    if (typeof condition === "boolean") return condition;
    if (!isObject(condition)) return false;
    if (typeof condition["@path"] === "string") return valid(getData(surface.data, absolute(condition["@path"], scope)));
    const args = isObject(condition.args) ? condition.args : {};
    const read = (value) => readValue(surface, value, scope, budget);
    switch (condition["@call"]) {
      case "and": case "or": {
        // `and` ends at the first item that is not true, `or` at the first that is not false.
        if (!Array.isArray(args.values)) return false;
        const goOn = condition["@call"] === "and";
        for (const item of args.values) {
          const verdict = passes(surface, item, scope, budget);
          if (verdict !== goOn) return verdict;
        }
        return goOn;
      }
      case "not": {
        const verdict = passes(surface, args.value, scope, budget);
        return verdict === null ? null : !verdict;
      }
      case "required": {
        const value = read(args.value);
        // A formatString text that the budget cut is not the value: the condition ends with null.
        if (budget.out) return null;
        if (!isObject(value)) return filled(value);
        // Each key of a bound object takes one step: a large object cannot stall the checks of repeated fields.
        const size = Object.keys(value).length;
        return step(budget, size) ? size > 0 : null;
      }
      case "length": {
        // length measures a text (a DynamicString). A list or an object fails it and is never turned into JSON.
        const value = read(args.value);
        if (budget.out) return null;
        if (value !== null && typeof value === "object") return false;
        const size = textOf(value).length;
        return (args.min === undefined || size >= args.min) && (args.max === undefined || size <= args.max);
      }
      default: return false;
    }
  }

  // A value of a property: a literal, a binding {"@path"} or the call formatString.
  function readValue(surface, value, scope, budget) {
    if (!isObject(value)) return value;
    if (typeof value["@path"] === "string") return getData(surface.data, absolute(value["@path"], scope));
    if (isFormat(value)) return format(surface, String(value.args?.value ?? ""), scope, budget);
    return value;
  }
  // A formatString text, in one forward pass over the template: "${/path}" puts in the value at the path, "\${" keeps
  // "${" as text, and a "${" with no "}" after it is plain text. Each scanned character of the template and each
  // character of a value takes one character of `budget`. The text stops before a part that does not fit: that cut uses
  // the budget up.
  function format(surface, template, scope, budget) {
    if (budget.out) return "";
    let text = "", at = 0;
    const spend = (size) => {
      if (budget.out || size > budget.text) { budget.out = true; return false; }
      budget.text -= size;
      return true;
    };
    const add = (part) => { if (!spend(part.length)) return false; text += part; return true; };
    while (at < template.length) {
      const open = template.indexOf("${", at), close = open < 0 ? -1 : template.indexOf("}", open + 2);
      // No "${...}" is left: no later "${" can find a "}" either, so the rest is plain text.
      if (close < 0) { add(template.slice(at)); break; }
      const escaped = open > at && template[open - 1] === "\\";
      if (!add(template.slice(at, escaped ? open - 1 : open))) return text;
      if (escaped) {
        if (!spend(1) || !add(template.slice(open, close + 1))) return text;
      } else {
        const path = absolute(template.slice(open + 2, close).trim(), scope);
        if (!spend(close + 1 - open) || !add(textOf(getData(surface.data, path)))) return text;
      }
      at = close + 1;
    }
    return text;
  }

  // The action message of a Button: its context resolved against the data model now. The context has no prototype.
  function actionOf(surface, c, scope, budget) {
    const event = c.action.event, context = Object.create(null);
    for (const [key, value] of Object.entries(isObject(event.context) ? event.context : {})) context[key] = plain(readValue(surface, value, scope, budget) ?? null);
    const action = { name: String(event.name), surfaceId: surface.id, sourceComponentId: c.id, timestamp: new Date().toISOString(), context };
    if (event.userMessage !== undefined) action.userMessage = textOf(readValue(surface, event.userMessage, scope, budget));
    return { version: A2UI_VERSION, action };
  }

  function field(surface, c, control, text, className = "a2-field") {
    const wrap = make("label", className);
    if (c.label !== undefined) {
      const label = make("span", "a2-label", text(c.label));
      wrap.append(label);
      if (isObject(c.label)) surface.updaters.push(() => { label.textContent = text(c.label); });
    }
    wrap.append(control);
    return wrap;
  }

  // The extension walkr_readOnly of an input: true, or a binding that holds true now.
  function frozenOf(surface, c, scope) {
    const value = c["@metadata"]?.extensions?.[A2UI_READ_ONLY];
    return () => isObject(value) ? getData(surface.data, absolute(value["@path"], scope)) === true : value === true;
  }

  function drawComponent(surface, c, scope, depth, ctx) {
    const on = (node, type, listener) => listen(surface, ctx, node, type, listener);
    // Each read and each drawn text runs in a pass and takes its characters from the budget of that pass.
    const budget = () => ctx.budget ?? newBudget();
    const read = (value) => readValue(surface, value, scope, budget());
    const text = (value) => {
      const spend = budget(), raw = readValue(surface, value, scope, spend);
      return isFormat(value) ? textOf(raw) : charge(spend, textOf(raw));
    };
    const dynamic = (value, update) => { if (isObject(value)) surface.updaters.push(update); };
    const ext = c["@metadata"]?.extensions ?? {};
    switch (c.component) {
      case "WalkrFrame": {
        const frame = make("iframe");
        frame.title = text(c.label);
        frame.setAttribute("sandbox", "");
        frame.src = c.frame;
        return frame;
      }
      case "Text": {
        const variant = /^h[1-5]$/.test(c.variant) ? c.variant : c.variant === "caption" ? "caption" : "body";
        const node = make(variant.startsWith("h") ? variant : variant === "caption" ? "small" : "p", `a2-text a2-${variant}`, text(c.text));
        if (ext.walkr_marks?.length && !ctx.budget.out) {
          const content = node.textContent;
          node.replaceChildren();
          let end = 0;
          for (const [from, to] of ext.walkr_marks) {
            if (!take(ctx.budget)) return node;
            node.append(content.slice(end, from), make("mark", "a2-mark", content.slice(from, to)));
            end = to;
          }
          node.append(content.slice(end));
        }
        dynamic(c.text, () => { node.textContent = text(c.text); });
        return node;
      }
      case "Row": case "Column": case "List": {
        const row = c.component === "Row" || (c.component === "List" && c.direction === "horizontal");
        const node = make("div", `a2-box ${row ? "a2-row" : "a2-column"}${c.component === "List" ? " a2-list" : ""}`);
        if (c.component === "List") node.setAttribute("role", "list");
        if (JUSTIFY.includes(c.justify)) node.classList.add(`a2-justify-${c.justify}`);
        if (ALIGN.includes(c.align)) node.classList.add(`a2-align-${c.align}`);
        for (const child of children(surface, c.children, scope, depth, ctx)) {
          if (c.component !== "List") { node.append(child); continue; }
          const item = make("div", "a2-item");
          item.setAttribute("role", "listitem");
          item.append(child);
          node.append(item);
        }
        if (ext.walkr_fold !== undefined) {
          const fold = make("details", "a2-fold"), summary = make("summary", "", text(ext.walkr_fold));
          dynamic(ext.walkr_fold, () => { const value = text(ext.walkr_fold); if (summary.textContent !== value) summary.textContent = value; });
          fold.append(summary, node);
          return fold;
        }
        return node;
      }
      case "Card": {
        const node = make("div", "a2-card");
        node.append(drawOne(surface, String(c.child), scope, depth + 1, ctx));
        return node;
      }
      case "Divider": {
        const node = make(c.axis === "vertical" ? "span" : "hr", c.axis === "vertical" ? "a2-divider a2-vertical" : "a2-divider");
        node.setAttribute("role", "separator");
        return node;
      }
      case "Tabs": {
        const node = make("div", "a2-tabs"), bar = make("div", "a2-tabbar"), panel = make("div", "a2-tabpanel");
        bar.setAttribute("role", "tablist");
        panel.setAttribute("role", "tabpanel");
        const tabs = c.tabs.filter(isObject), buttons = [], panels = [];
        const active = boundPath(ext.walkr_activeTab, scope);
        let selected = -1;
        // Each panel is drawn once, at its first selection, and kept: its bound controls stay the ones on the page.
        const pick = (index) => {
          if (index === selected) return;
          selected = index;
          buttons.forEach((button, at) => button.setAttribute("aria-selected", String(at === index)));
          panels[index] ??= pass(ctx, () => drawOne(surface, String(tabs[index].child), scope, depth + 1, ctx));
          panel.replaceChildren(panels[index]);
        };
        for (const [index, tab] of tabs.entries()) {
          if (!take(ctx.budget)) break;
          const button = make("button", "a2-tab", text(tab.title) || `Tab ${index + 1}`);
          button.type = "button";
          button.setAttribute("role", "tab");
          dynamic(tab.title, () => { const title = text(tab.title); if (button.textContent !== title) button.textContent = title; });
          on(button, "click", () => active === null ? pick(index) : write(surface, active, index));
          buttons.push(button);
          bar.append(button);
        }
        node.append(bar, panel);
        const show = () => {
          const value = active === null ? 0 : getData(surface.data, active);
          if (buttons.length) pick(Number.isInteger(value) && value >= 0 && value < buttons.length ? value : 0);
        };
        show();
        if (active !== null) surface.updaters.push(show);
        return node;
      }
      case "Modal": {
        const node = make("div", "a2-modal"), trigger = make("div", "a2-trigger"), content = make("div", "a2-modal-content");
        content.hidden = true;
        trigger.append(drawOne(surface, String(c.trigger), scope, depth + 1, ctx));
        on(trigger, "click", () => {
          content.hidden = !content.hidden;
          if (!content.hidden && !content.childElementCount) {
            const shut = make("button", "a2-button a2-default", "Close");
            shut.type = "button";
            on(shut, "click", () => { content.hidden = true; });
            content.append(pass(ctx, () => drawOne(surface, String(c.content), scope, depth + 1, ctx)), shut);
          }
        });
        node.append(trigger, content);
        return node;
      }
      case "Button": {
        const button = make("button", `a2-button a2-${["primary", "borderless"].includes(c.variant) ? c.variant : "default"}`);
        button.type = "button";
        button.append(drawOne(surface, String(c.child), scope, depth + 1, ctx));
        const checked = checks(surface, c, scope, ctx, button);
        on(button, "click", () => {
          if (checked?.failing()) return;
          onAction(actionOf(surface, c, scope, newBudget()));
        });
        if (!checked) return button;
        // The message line of the checks stands below the button; the button keeps the component ID.
        button.dataset.a2uiId = c.id;
        const wrap = make("span", "a2-checked");
        wrap.dataset.a2uiPart = "checks";
        wrap.append(button, checked.line);
        return wrap;
      }
      case "TextField": {
        const long = c.variant === "longText";
        const input = make(long ? "textarea" : "input", "a2-input");
        if (long) input.rows = 3;
        else input.type = c.variant === "number" ? "number" : c.variant === "obscured" ? "password" : "text";
        if (c.placeholder !== undefined) {
          input.placeholder = text(c.placeholder);
          dynamic(c.placeholder, () => { const value = text(c.placeholder); if (input.placeholder !== value) input.placeholder = value; });
        }
        const limit = c["@metadata"]?.extensions?.[A2UI_MAX_LENGTH];
        if (Number.isInteger(limit)) input.maxLength = limit;
        const path = boundPath(c.value, scope), frozen = frozenOf(surface, c, scope);
        // A field with focus keeps the text of the user: a refresh does not write into it.
        const show = () => {
          input.readOnly = frozen();
          // A confirmed result can arrive while the owner reads this field. Its saved text wins.
          if (input.readOnly || document.activeElement !== input) {
            const value = text(c.value); if (input.value !== value) input.value = value;
          }
        };
        show();
        surface.updaters.push(show);
        on(input, "input", () => {
          // A frozen field takes no change: it shows the value of the data model again.
          if (frozen()) { input.value = text(c.value); return; }
          write(surface, path, c.variant === "number" && input.value !== "" ? Number(input.value) : input.value);
        });
        let wrap;
        if (ext[A2UI_HIDE_LABEL]) {
          const name = () => { const value = text(c.label); if (input.getAttribute("aria-label") !== value) input.setAttribute("aria-label", value); };
          name();
          dynamic(c.label, name);
          wrap = make("div", "a2-field");
          wrap.append(input);
        } else wrap = field(surface, c, input, text);
        const checked = checks(surface, c, scope, ctx, input);
        if (checked) wrap.append(checked.line);
        return wrap;
      }
      case "CheckBox": {
        const input = make("input", "a2-check-input");
        input.type = "checkbox";
        const path = boundPath(c.value, scope), show = () => { input.checked = Boolean(read(c.value)); };
        show();
        surface.updaters.push(show);
        on(input, "change", () => write(surface, path, input.checked));
        const wrap = field(surface, c, input, text, "a2-field a2-inline");
        wrap.prepend(input);
        const checked = checks(surface, c, scope, ctx, input);
        if (checked) wrap.append(checked.line);
        return wrap;
      }
      case "ChoicePicker": return picker(surface, c, scope, ctx, text, on);
      case "Slider": {
        if (ext.walkr_stars) {
          const group = make("div", "cmp-stars"), path = boundPath(c.value, scope), frozen = frozenOf(surface, c, scope);
          group.setAttribute("role", "radiogroup");
          group.setAttribute("aria-label", text(c.label));
          const select = (point) => { if (!frozen()) { write(surface, path, point); group.children[point - 1]?.focus(); } };
          for (let point = RATING_MIN; point <= RATING_MAX; point++) {
            if (!take(ctx.budget)) break;
            const half = make("button", `cmp-star ${point % 2 ? "is-left" : "is-right"}`);
            half.type = "button"; half.title = starsLabel(point);
            half.setAttribute("role", "radio"); half.setAttribute("aria-label", half.title);
            on(half, "click", () => select(point)); group.append(half);
          }
          on(group, "keydown", (event) => {
            const by = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
            if (by) { event.preventDefault(); select(stepRating(read(c.value), by)); }
          });
          const show = () => {
            const value = read(c.value);
            for (const [i, half] of [...group.children].entries()) {
              half.classList.toggle("is-on", isRating(value) && i + 1 <= value);
              half.setAttribute("aria-checked", String(i + 1 === value)); half.disabled = frozen();
              half.tabIndex = i + 1 === (isRating(value) ? value : RATING_MIN) ? 0 : -1;
            }
          };
          show(); surface.updaters.push(show);
          const wrap = make("div"), checked = checks(surface, c, scope, ctx, group);
          wrap.append(group); if (checked) wrap.append(checked.line);
          return wrap;
        }
        const input = make("input", "a2-slider"), out = make("output", "a2-out");
        input.type = "range";
        const min = Number(read(c.min) ?? 0), max = Number(read(c.max) ?? 100), steps = Number(read(c.steps));
        input.min = String(Number.isFinite(min) ? min : 0);
        input.max = String(Number.isFinite(max) ? max : 100);
        if (Number.isFinite(steps) && steps > 0) input.step = String((Number(input.max) - Number(input.min)) / steps);
        const path = boundPath(c.value, scope), show = () => { const value = read(c.value); if (value !== undefined) input.value = String(value); out.textContent = input.value; };
        show();
        surface.updaters.push(show);
        on(input, "input", () => { out.textContent = input.value; write(surface, path, Number(input.value)); });
        const wrap = field(surface, c, input, text);
        wrap.append(out);
        const checked = checks(surface, c, scope, ctx, input);
        if (checked) wrap.append(checked.line);
        return wrap;
      }
      case "DateTimeInput": {
        const input = make("input", "a2-input");
        const date = c.enableDate !== false, time = c.enableTime === true;
        input.type = date && time ? "datetime-local" : time ? "time" : "date";
        if (c.min !== undefined) input.min = text(c.min);
        if (c.max !== undefined) input.max = text(c.max);
        const path = boundPath(c.value, scope), show = () => { if (document.activeElement !== input) input.value = text(c.value); };
        show();
        surface.updaters.push(show);
        on(input, "change", () => write(surface, path, input.value));
        const wrap = field(surface, c, input, text);
        const checked = checks(surface, c, scope, ctx, input);
        if (checked) wrap.append(checked.line);
        return wrap;
      }
      case "Icon": {
        const node = make("span", "a2-icon", `[${text(c.name)}]`);
        node.setAttribute("aria-label", `icon ${text(c.name)}`);
        return node;
      }
      case "Image": return link(read(c.url), `Image: ${text(c.description) || "open the image"}`);
      case "Video": return link(read(c.url), "Video: open the video");
      case "AudioPlayer": return link(read(c.url), `Audio: ${text(c.description) || "open the audio"}`);
      default: return placeholder(`Unknown component ${String(c.component)}`);
    }
  }

  /**
   * A ChoicePicker. One choice (`mutuallyExclusive`, the default) is a radio group: the arrow keys move and select, and
   * Tab enters and leaves the group once. Many choices (`multipleSelection`) are checkboxes; Space toggles one. Each
   * option is one row that the whole row selects, with its description, a Recommended mark and a preview from the
   * extension walkr_optionDetails. `filterable` adds a filter field; an option that the filter hides keeps its
   * selection. While the extension walkr_readOnly is true, the options are disabled and the selection does not change.
   */
  function picker(surface, c, scope, ctx, text, on) {
    const single = c.variant !== "multipleSelection", chips = c.displayStyle === "chips";
    const path = boundPath(c.value, scope), name = `a2-choice-${++serial}`;
    const wrap = make("div", "a2-field a2-picker");
    const group = make("div", `a2-choices${chips ? " a2-chips" : ""}`);
    group.id = `${name}-group`;
    group.setAttribute("role", single ? "radiogroup" : "group");
    if (c.label !== undefined) {
      const label = make("span", "a2-label", text(c.label));
      label.id = `${name}-label`;
      group.setAttribute("aria-labelledby", label.id);
      wrap.append(label);
      if (isObject(c.label)) surface.updaters.push(() => { label.textContent = text(c.label); });
    }
    const details = new Map();
    for (const detail of c["@metadata"]?.extensions?.[A2UI_OPTION_DETAILS] ?? []) details.set(detail.value, detail);
    // A picker without a binding keeps its selection here.
    let local = listOf(readValue(surface, c.value, scope, ctx.budget ?? newBudget()));
    const chosen = () => path === null ? local : listOf(getData(surface.data, path));
    const controls = [], frozen = frozenOf(surface, c, scope);
    const mark = () => {
      const now = chosen(), still = frozen();
      for (const control of controls) { control.mark(now.includes(control.value)); control.freeze(still); }
    };
    const select = (value, chosenNow) => {
      if (frozen()) { mark(); return; }
      const now = chosen();
      const next = single ? (chosenNow ? [value] : now) : chosenNow ? [...now.filter((item) => item !== value), value] : now.filter((item) => item !== value);
      if (path === null) { local = next; mark(); } else write(surface, path, next);
    };
    const move = (event, from) => {
      const by = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (!by) return;
      event.preventDefault();
      if (frozen()) return;
      const shown = controls.filter((control) => !control.row.hidden);
      if (!shown.length) return;
      const at = shown.indexOf(from);
      const next = shown[at < 0 ? (by > 0 ? 0 : shown.length - 1) : (at + by + shown.length) % shown.length];
      next.focus();
      select(next.value, true);
    };
    for (const [index, option] of c.options.entries()) {
      if (!take(ctx.budget)) break;
      const value = String(option.value), detail = details.get(value), id = `${name}-${index}`;
      const label = make("span", "a2-option-label", text(option.label));
      label.id = `${id}-label`;
      if (isObject(option.label)) surface.updaters.push(() => { label.textContent = text(option.label); });
      const head = make("span", "a2-option-head");
      head.append(label);
      const labelledBy = [label.id];
      if (detail?.recommended) {
        const badge = make("span", "a2-recommended", "Recommended");
        badge.id = `${id}-mark`;
        head.append(badge);
        labelledBy.push(badge.id);
      }
      const body = make("span", "a2-option-text");
      body.append(head);
      let description = null;
      if (detail?.description !== undefined) {
        description = make("span", "a2-option-description", text(detail.description));
        description.id = `${id}-description`;
        body.append(description);
        if (isObject(detail.description)) surface.updaters.push(() => { description.textContent = text(detail.description); });
      }
      if (detail?.preview && !chips) body.append(previewOf(detail.preview, ctx.budget ?? newBudget()));
      const words = () => `${label.textContent}\n${description?.textContent ?? ""}`.toLocaleLowerCase();
      let control;
      if (chips) {
        const row = make("button", "a2-option a2-chip");
        row.type = "button";
        row.append(body);
        on(row, "click", () => select(value, single || row.getAttribute("aria-pressed") !== "true"));
        control = { value, row, words, focus: () => row.focus(), freeze: (still) => { row.disabled = still; row.classList.toggle("is-frozen", still); },
          mark: (picked) => { row.setAttribute("aria-pressed", String(picked)); row.classList.toggle("is-on", picked); } };
      } else {
        const row = make("label", "a2-option");
        const input = make("input");
        input.type = single ? "radio" : "checkbox";
        input.name = name;
        input.value = value;
        input.setAttribute("aria-labelledby", labelledBy.join(" "));
        if (description) input.setAttribute("aria-describedby", description.id);
        on(input, "change", () => select(value, input.checked));
        if (single) on(input, "keydown", (event) => move(event, control));
        row.append(input, body);
        control = { value, row, words, focus: () => input.focus(), freeze: (still) => { input.disabled = still; row.classList.toggle("is-frozen", still); },
          mark: (picked) => { input.checked = picked; row.classList.toggle("is-on", picked); } };
      }
      control.row.dataset.value = value;
      if (detail?.recommended) control.row.classList.add("is-recommended");
      controls.push(control);
      group.append(control.row);
    }
    if (c.filterable === true) {
      const filter = make("input", "a2-input a2-filter");
      filter.type = "search";
      filter.placeholder = "Filter the options";
      filter.setAttribute("aria-label", "Filter the options");
      filter.setAttribute("aria-controls", group.id);
      const none = make("p", "a2-nomatch", "No option matches the filter.");
      none.setAttribute("role", "status");
      none.hidden = true;
      // Each word of the filter must be in the label or the description. The filter changes no selection.
      on(filter, "input", () => {
        const wanted = filter.value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
        let shown = 0;
        for (const control of controls) {
          const hit = wanted.every((word) => control.words().includes(word));
          control.row.hidden = !hit;
          shown += hit ? 1 : 0;
        }
        none.hidden = shown > 0;
      });
      wrap.append(filter, group, none);
    } else wrap.append(group);
    mark();
    surface.updaters.push(mark);
    const checked = checks(surface, c, scope, ctx, group);
    if (checked) wrap.append(checked.line);
    return wrap;
  }

  return { element, apply, close };
}
