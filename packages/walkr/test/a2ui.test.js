// The A2UI module of Walkr pages (src/a2ui.js): the check, the boundaries of the renderer, and the ChoicePicker.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { A2UI_BASIC_CATALOG, A2UI_DRAW, A2UI_HIDE_LABEL, A2UI_LIMITS, A2UI_OPTION_DETAILS, checkA2uiMessages, createA2uiHost } from "../src/a2ui.js";

const create = (components, extra = {}, surfaceId = "main") => ({ version: "1.0", createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG, components, ...extra } });
const refused = (messages, name) => assert.equal(checkA2uiMessages(messages).ok, false, name);

function page(t, options) {
  const dom = new JSDOM("<!doctype html><body></body>");
  t.after(() => dom.window.close());
  const host = createA2uiHost(dom.window.document, options);
  dom.window.document.body.append(host.element);
  return { window: dom.window, doc: dom.window.document, host };
}

test("the check refuses a wrong version, an unknown component, a surface over the limits, a javascript: URL and a __proto__ key", () => {
  const text = { id: "root", component: "Text", text: "Hello" };
  assert.equal(checkA2uiMessages([create([text])]).ok, true);
  refused([{ ...create([text]), version: "0.9" }], "a wrong version");
  refused([create([{ id: "root", component: "Chart" }])], "an unknown component");
  // A component name that is an object with a "toString" key is refused, not thrown.
  refused([create([{ id: "root", component: { toString: 1 } }])], "a component name that is an object");
  const many = Array.from({ length: A2UI_LIMITS.components }, (_, index) => ({ id: `t${index}`, component: "Divider" }));
  const column = (items) => create([{ id: "root", component: "Column", children: items.map((item) => item.id) }, ...items]);
  assert.equal(checkA2uiMessages([column(many.slice(1))]).ok, true, "a surface at the component limit");
  refused([column(many)], "a surface over the component limit");
  // Shared references that expand past the instance budget: 1 + 10 + 100 + 1000 + 10000 drawn components.
  const levels = Array.from({ length: 4 }, (_, level) => ({ id: `l${level}`, component: "Column", children: Array(10).fill(`l${level + 1}`) }));
  refused([create([{ ...levels[0], id: "root" }, ...levels.slice(1), { id: "l4", component: "Divider" }])], "a tree past the instance budget");
  refused([create([{ id: "root", component: "Image", url: "javascript:alert(1)" }])], "a javascript: URL");
  const proto = JSON.parse('{"version":"1.0","createSurface":{"surfaceId":"main","components":[{"id":"root","component":"Text","text":"x"}],"dataModel":{"__proto__":{"polluted":true}}}}');
  refused([proto], "a __proto__ key");
  refused([create([text], { dataModel: {} }), { version: "1.0", updateDataModel: { surfaceId: "main", path: "/constructor/prototype", value: 1 } }], "a constructor step");
  assert.equal({}.polluted, undefined);
});

test("the renderer stops a tree past the instance budget, and a refused surface does not stop the next one", (t) => {
  const { doc, host } = page(t);
  // Nested templates pass the check (3 components) and would draw 200 * 200 leaves without the budget of the pass.
  const big = create([
    { id: "root", component: "List", children: { componentId: "row", path: "/items" } },
    { id: "row", component: "Row", children: { componentId: "leaf", path: "/items" } },
    { id: "leaf", component: "Text", text: "x" },
  ], { dataModel: { items: Array(200).fill(0) } }, "big");
  const broken = create([{ id: "top", component: "Text", text: "No root" }], {}, "broken");
  const good = create([{ id: "root", component: "Text", text: { "@path": "/name" } }], { dataModel: { name: "Still drawn" } }, "good");
  const result = host.apply([big, broken, good]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, "only the broken surface is refused");
  const surface = (id) => doc.querySelector(`[data-a2ui-surface="${id}"]`);
  assert.ok(surface("big").querySelectorAll('[data-a2ui-id="leaf"]').length < A2UI_DRAW.instances, "the draw stops inside the budget");
  assert.equal(surface("broken").querySelector('[role="alert"]').hidden, false, "the broken surface shows its error line");
  assert.equal(surface("good").textContent, "Still drawn");
  // The host goes on after the refusal: a later update of the good surface draws.
  assert.deepEqual(host.apply([{ version: "1.0", updateDataModel: { surfaceId: "good", path: "/name", value: "Updated" } }]), { ok: true, errors: [] });
  assert.equal(surface("good").textContent, "Updated");
});

test("one arrow key moves the pick of a one-choice picker, and the filter hides an option without losing the pick", (t) => {
  const changes = [];
  const { window, doc, host } = page(t, { onChange: (change) => changes.push(change) });
  const options = [{ label: "Queue only", value: "a" }, { label: "Queue and alarm", value: "b" }, { label: "No queue", value: "c" }];
  const picker = {
    id: "root", component: "ChoicePicker", variant: "mutuallyExclusive", filterable: true, options, value: { "@path": "/pick" },
    "@metadata": { extensions: { [A2UI_OPTION_DETAILS]: [{ value: "b", description: "Two new resources", recommended: true }] } },
  };
  assert.deepEqual(host.apply([create([picker], { dataModel: { pick: ["a"] } })]), { ok: true, errors: [] });
  const radios = [...doc.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios.map((radio) => radio.checked), [true, false, false]);
  radios[0].focus();
  radios[0].dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  assert.deepEqual(radios.map((radio) => radio.checked), [false, true, false]);
  assert.equal(doc.activeElement, radios[1]);
  assert.deepEqual(changes, [{ surfaceId: "main", path: "/pick", value: ["b"] }]);

  const filter = doc.querySelector('input[type="search"]');
  // An option shows while no element around its radio is hidden.
  const search = (text) => { filter.value = text; filter.dispatchEvent(new window.Event("input")); return radios.map((radio) => !radio.closest("[hidden]")); };
  assert.deepEqual(search("two resources"), [false, true, false], "the filter reads the description too");
  assert.deepEqual(search("no queue"), [false, false, true]);
  assert.equal(radios[1].checked, true, "the hidden option keeps its pick");
  assert.equal(changes.length, 1, "the filter writes nothing");
  search("nothing like this");
  assert.equal(doc.querySelector('[role="status"]').hidden, false, "a filter with no match says so");
});

test("a control of a replaced or deleted surface does nothing", (t) => {
  const actions = [], changes = [];
  const { window, doc, host } = page(t, { onAction: (message) => actions.push(message), onChange: (change) => changes.push(change) });
  const form = create([
    { id: "root", component: "Column", children: ["note", "send"] },
    { id: "note", component: "TextField", label: "Note", value: { "@path": "/note" } },
    { id: "send", component: "Button", child: "sendLabel", action: { event: { name: "submit", context: { note: { "@path": "/note" } } } } },
    { id: "sendLabel", component: "Text", text: "Submit" },
  ], { dataModel: { note: "" } });
  const controls = () => ({ field: doc.querySelector('[data-a2ui-id="note"] input'), button: doc.querySelector('button[data-a2ui-id="send"]') });
  const use = ({ field, button }) => {
    field.value = "typed";
    field.dispatchEvent(new window.Event("input"));
    button.click();
  };
  assert.equal(host.apply([form]).ok, true);
  const first = controls();
  use(first);
  assert.equal(actions.length, 1, "the controls of the current draw act");
  assert.equal(changes.length, 1);
  assert.equal(host.apply([form]).ok, true, "the same surface ID again replaces the surface");
  const second = controls();
  use(first);
  assert.deepEqual([actions.length, changes.length], [1, 1], "the controls of the replaced draw do nothing");
  assert.equal(host.apply([{ version: "1.0", deleteSurface: { surfaceId: "main" } }]).ok, true);
  use(second);
  assert.deepEqual([actions.length, changes.length], [1, 1], "the controls of a deleted surface do nothing");
});

test("repeated fields with failed checks stay inside the draw budget and do not throw", (t) => {
  const actions = [];
  const { window, doc, host } = page(t, { onAction: (message) => actions.push(message) });
  const items = Array(A2UI_DRAW.items).fill({});
  // Each field fails its check: without a charge, the messages would draw 200 times 2000 characters.
  const messages = create([
    { id: "root", component: "List", children: { componentId: "field", path: "/items" } },
    { id: "field", component: "TextField", label: "Name", value: { "@path": "name" },
      "@checks": [{ condition: { "@call": "required", args: { value: { "@path": "name" } } }, message: "m".repeat(2000) }] },
  ], { dataModel: { items } }, "messages");
  // Each rule passes when it is evaluated to its end, but no budget can finish it: `not` around more condition steps
  // than one pass has, and `or` around a formatString text longer than the text budget.
  const call = (name, args) => ({ "@call": name, args });
  const button = (id, condition) => [{ id, component: "Button", child: `${id}Label`, action: { event: { name: id } }, "@checks": [{ condition }] },
    { id: `${id}Label`, component: "Text", text: id }];
  const steps = create([
    { id: "root", component: "List", children: { componentId: "go", path: "/items" } },
    ...button("go", call("not", { value: call("and", { values: [...Array(A2UI_DRAW.steps).fill(true), false] }) })),
  ], { dataModel: { items } }, "steps");
  const either = create(button("root", call("or", { values: [call("required", { value: call("formatString", { value: "${/long}".repeat(70) }) }), true] })),
    { dataModel: { long: "x".repeat(1000) } }, "either");
  host.apply([messages, steps, either]);
  const surface = (id) => doc.querySelector(`[data-a2ui-surface="${id}"]`);
  // The message lines of the checks are the live regions of the surface.
  const shown = () => [...surface("messages").querySelectorAll("[aria-live]")].reduce((sum, line) => sum + line.textContent.length, 0);
  assert.ok(shown() <= A2UI_DRAW.text, "the check messages take characters of the budget");
  const buttons = surface("steps").querySelectorAll('button[data-a2ui-id="go"]');
  assert.ok(buttons.length > 0 && buttons.length < items.length, "the condition steps end the pass");
  const used = { not: buttons[0], or: surface("either").querySelector('button[data-a2ui-id="root"]') };
  for (const [name, node] of Object.entries(used)) {
    assert.equal(node.disabled, true, `a used-up budget fails the rule with ${name}`);
    node.disabled = false;
    node.click();
  }
  assert.equal(actions.length, 0, "a click checks again with its own budget, and a used-up budget sends nothing");
  // An input refreshes the surface in one pass, inside the same budget.
  const field = surface("messages").querySelector("input");
  field.value = "x";
  field.dispatchEvent(new window.Event("input"));
  assert.ok(shown() <= A2UI_DRAW.text);
});

test("a preview of a wrong shape is refused; a text preview draws inside its card, and a click on it selects the card", (t) => {
  const changes = [];
  const { doc, host } = page(t, { onChange: (change) => changes.push(change) });
  const options = [{ label: "Short", value: "a" }, { label: "Shorter", value: "b" }];
  const picker = (preview) => create([{
    id: "root", component: "ChoicePicker", variant: "mutuallyExclusive", options, value: { "@path": "/pick" },
    "@metadata": { extensions: { [A2UI_OPTION_DETAILS]: [{ value: "b", description: "One line", preview }] } },
  }], { dataModel: { pick: ["a"] } });
  const wrong = { "a plain text": "Deployed.", "both keys": { text: "Deployed.", frame: "/doc/1" }, "an unknown key": { html: "<p>x</p>" },
    "an empty text": { text: "" }, "a frame of another origin": { frame: "//other/doc" }, "a frame with a scheme": { frame: "javascript:alert(1)" } };
  for (const [name, preview] of Object.entries(wrong)) refused([picker(preview)], name);
  assert.deepEqual(host.apply([picker({ text: "Deployed.\nAll checks passed." })]), { ok: true, errors: [] });
  const card = doc.querySelector('[data-value="b"]');
  const preview = card.querySelector(".a2-option-preview");
  assert.equal(preview.textContent, "Deployed.\nAll checks passed.");
  assert.equal(preview.getAttribute("aria-hidden"), "true");
  preview.click();
  assert.equal(card.querySelector('input[type="radio"]').checked, true, "a click on the preview selects its card");
  assert.deepEqual(changes, [{ surfaceId: "main", path: "/pick", value: ["b"] }]);
});

test("session extensions refuse malformed values and draw only their checked content", (t) => {
  const { host, doc } = page(t);
  const ext = (key, value) => ({ "@metadata": { extensions: { [key]: value } } });
  const literal = { id: "root", component: "Text", text: "<b>word</b>" };
  const frame = { id: "root", component: "WalkrFrame", label: "Sketch", frame: `/_walkr/compare/o/${"a".repeat(64)}/20260101T000000Z-0123456789ab/fig` };
  for (const value of ["/doc/1", frame.frame + "/more", frame.frame + "?query", "//outside", frame.frame + "x".repeat(64)]) refused([create([{ ...frame, frame: value }])]);
  assert.equal(host.apply([create([frame])]).ok, true);
  assert.equal(doc.querySelector("iframe").getAttribute("sandbox"), "");
  assert.equal(doc.querySelector("iframe").getAttribute("src"), frame.frame);
  for (const ranges of [null, [[-1, 2]], [[2, 1]], [[0, 2], [1, 3]], [[0, 12]], Array(201).fill([0, 1])]) refused([create([{ ...literal, ...ext("walkr_marks", ranges) }])]);
  assert.equal(host.apply([create([{ ...literal, ...ext("walkr_marks", [[3, 7]]) }])]).ok, true);
  assert.equal(doc.querySelector("mark").textContent, "word"); assert.equal(doc.querySelector("b"), null);
  const column = { id: "root", component: "Column", children: [] };
  for (const summary of [false, "", "x".repeat(257)]) refused([create([{ ...column, ...ext("walkr_fold", summary) }])]);
  const tabs = { id: "root", component: "Tabs", tabs: [{ title: "One", child: "leaf" }] };
  refused([create([{ ...tabs, ...ext("walkr_activeTab", 1) }, { ...literal, id: "leaf" }])]);
  refused([create([{ ...literal, ...ext("walkr_activeTab", { "@path": "/tab" }) }])]);
});


test("star ratings require ten bound half points; arrows clamp and a lock refuses changes", (t) => {
  const changes = [], { host, doc, window } = page(t, { onChange: ({ value }) => changes.push(value) });
  const stars = { id: "root", component: "Slider", label: "Rating", value: { "@path": "/rating" }, min: 1, max: 10, steps: 9,
    "@metadata": { extensions: { walkr_stars: true, walkr_readOnly: { "@path": "/locked" } } } };
  for (const patch of [{ max: 11 }, { steps: 10 }, { value: 7 }, { label: "" }, { "@metadata": { extensions: { walkr_stars: false } } }]) refused([create([{ ...stars, ...patch }])]);
  assert.equal(host.apply([create([stars], { dataModel: { rating: 9 } })]).ok, true);
  const arrow = () => doc.querySelector('[role="radio"][tabindex="0"]').dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  arrow(); arrow();
  assert.deepEqual(changes, [10, 10]);
  host.apply([{ version: "1.0", updateDataModel: { surfaceId: "main", path: "/locked", value: true } }]);
  arrow(); assert.equal(changes.length, 2);
});

test("walkr_hideLabel refuses invalid uses, moves the field label to aria-label, and updates bound placeholders", (t) => {
  const { host, doc } = page(t);
  const field = (extensions, extra = {}) => ({ id: "root", component: "TextField", label: "Comment on First", variant: "longText",
    value: { "@path": "/comment" }, placeholder: { "@path": "/hint" }, ...extra, "@metadata": { extensions } });
  for (const bad of [false, "yes", 1, { "@path": "/hide" }]) refused([create([field({ [A2UI_HIDE_LABEL]: bad })])], `hideLabel ${String(bad)}`);
  refused([create([{ id: "root", component: "Text", text: "Hello", "@metadata": { extensions: { [A2UI_HIDE_LABEL]: true } } }])], "hideLabel on Text");
  for (const blank of ["", "   "]) refused([create([field({ [A2UI_HIDE_LABEL]: true }, { label: blank })])], "hideLabel blank label");
  assert.equal(checkA2uiMessages([create([field({ [A2UI_HIDE_LABEL]: true }, { label: { "@path": "/label" } })])]).ok, true);
  assert.equal(host.apply([create([field({ [A2UI_HIDE_LABEL]: true })], { dataModel: { comment: "", hint: "Comment on First (optional)" } })]).ok, true);
  assert.equal(doc.querySelector(".a2-label"), null);
  const input = doc.querySelector("textarea");
  assert.equal(input.getAttribute("aria-label"), "Comment on First");
  assert.equal(input.placeholder, "Comment on First (optional)");
  assert.equal(host.apply([{ version: "1.0", updateDataModel: { surfaceId: "main", path: "/hint", value: "No comment" } }]).ok, true);
  assert.equal(input.placeholder, "No comment");
});
