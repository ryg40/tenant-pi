import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 expandWorkflow, listProviders, listWorkflows,
} from '../../dist/src/workflow/catalog.mjs';

const TEMPLATES = [
 'openai-codex-simple', 'openai-codex-medium', 'openai-codex-high',
 'openai-claude-simple', 'openai-claude',
];
const PROVIDERS = ['openai-codex', 'openai-codex-2'];

/** The approved matrix, written out once so a drift shows as a diff. */
const MATRIX = {
 'openai-codex-simple': {
  coordinator: ['gpt-5.6-sol', 'xhigh'],
  scout: ['gpt-5.6-luna', 'xhigh'],
  researcher: ['gpt-5.6-luna', 'xhigh'],
  worker: ['gpt-5.6-sol', 'medium'],
  reviewer: ['gpt-5.6-luna', 'xhigh'],
 },
 'openai-codex-medium': {
  coordinator: ['gpt-6-astra', 'low'],
  scout: ['gpt-5.6-luna', 'xhigh'],
  researcher: ['gpt-5.6-luna', 'xhigh'],
  worker: ['gpt-5.6-sol', 'medium'],
  reviewer: ['gpt-5.6-luna', 'xhigh'],
 },
 'openai-codex-high': {
  coordinator: ['gpt-6-astra', 'medium'],
  scout: ['gpt-5.6-luna', 'xhigh'],
  researcher: ['gpt-5.6-luna', 'xhigh'],
  worker: ['gpt-6-astra', 'low'],
  reviewer: ['gpt-5.6-luna', 'xhigh'],
 },
 'openai-claude-simple': {
  coordinator: ['gpt-5.6-sol', 'xhigh'],
  scout: ['gpt-5.6-luna', 'xhigh'],
  researcher: ['gpt-5.6-luna', 'xhigh'],
  worker: ['claude-opus-5', 'high'],
  reviewer: ['claude-sonnet-5', 'high'],
 },
 'openai-claude': {
  coordinator: ['gpt-6-astra', 'low'],
  scout: ['gpt-5.6-luna', 'xhigh'],
  researcher: ['gpt-5.6-luna', 'xhigh'],
  worker: ['claude-opus-5', 'high'],
  reviewer: ['claude-sonnet-5', 'high'],
 },
};

const CLAUDE_ROLES = new Set(['worker', 'reviewer']);

function expandOk(template, provider, readiness = 'ready') {
 const result = expandWorkflow({ template, provider, readiness });
 assert.equal(result.ok, true, `expected ${template}/${provider} to expand: ${result.error}`);
 return result.value;
}

function byRole(value) {
 return Object.fromEntries(value.roles.map((role) => [role.role, role]));
}

test('the catalog offers exactly the five named workflows and two OpenAI providers', () => {
 assert.deepEqual(listWorkflows().map((choice) => choice.id), TEMPLATES);
 assert.deepEqual(listProviders().map((choice) => choice.id), PROVIDERS);
 for (const choice of [...listWorkflows(), ...listProviders()]) {
  assert.ok(choice.label.length > 0, `${choice.id} needs a label`);
  assert.ok(choice.description.length > 0, `${choice.id} needs a description`);
 }
});

test('all ten workflow/provider combinations expand to the frozen role matrix', () => {
 let combinations = 0;
 for (const template of TEMPLATES) {
  for (const provider of PROVIDERS) {
   combinations += 1;
   const value = expandOk(template, provider);
   assert.equal(value.version, 1);
   assert.equal(value.template, template);
   assert.equal(value.provider, provider);
   const roles = byRole(value);
   for (const [role, [model, thinking]] of Object.entries(MATRIX[template])) {
    assert.equal(roles[role].model, model, `${template} ${role} model`);
    assert.equal(roles[role].thinking, thinking, `${template} ${role} thinking`);
   }
  }
 }
 assert.equal(combinations, 10);
});

test('role order is stable: coordinator, scout, researcher, worker, reviewer, generator', () => {
 for (const template of TEMPLATES) {
  for (const provider of PROVIDERS) {
   assert.deepEqual(
    expandOk(template, provider).roles.map((role) => role.role),
    ['coordinator', 'scout', 'researcher', 'worker', 'reviewer', 'generator'],
    `${template}/${provider} role order`,
   );
  }
 }
});

test('every OpenAI role binds the selected provider; Claude roles never redirect through it', () => {
 for (const template of TEMPLATES) {
  for (const provider of PROVIDERS) {
   const value = expandOk(template, provider);
   for (const role of value.roles) {
    if (template.startsWith('openai-claude') && CLAUDE_ROLES.has(role.role)) {
     assert.equal(role.provider, 'anthropic', `${template} ${role.role} provider`);
     assert.equal(role.route, 'herdr-claude', `${template} ${role.role} route`);
    } else {
     assert.equal(role.provider, provider, `${template} ${role.role} provider`);
     assert.equal(role.route, 'pi', `${template} ${role.role} route`);
    }
   }
  }
 }
});

test('the generator is always the selected OpenAI provider on Sol medium over Pi', () => {
 for (const template of TEMPLATES) {
  for (const provider of PROVIDERS) {
   const generator = byRole(expandOk(template, provider)).generator;
   assert.deepEqual(generator, {
    role: 'generator', provider, model: 'gpt-5.6-sol', thinking: 'medium', route: 'pi',
   }, `${template}/${provider} generator`);
  }
 }
});

test('scout and researcher stay distinct evidence stages, both on Luna xhigh over Pi', () => {
 const value = expandOk('openai-claude', 'openai-codex');
 const roles = byRole(value);
 assert.notEqual(roles.scout, roles.researcher);
 for (const role of [roles.scout, roles.researcher]) {
  assert.equal(role.model, 'gpt-5.6-luna');
  assert.equal(role.thinking, 'xhigh');
  assert.equal(role.route, 'pi');
 }
 const evidence = value.instructions.join(' ');
 assert.match(evidence, /Scout gathers local repository evidence/);
 assert.match(evidence, /researcher gathers web evidence/);
 assert.match(evidence, /Neither is a local inference provider/);
 assert.match(evidence, /numbered questions with citations and returns UNKNOWN rather than a guess/);
});

test('instructions state the Coordinator-designs / worker-implements / reviewer-checks policy', () => {
 const instructions = expandOk('openai-codex-medium', 'openai-codex').instructions.join(' ');
 assert.match(instructions, /Coordinator designs the solution and writes a detailed implementation packet/);
 assert.match(instructions, /Workers implement the bounded design/);
 assert.match(instructions, /Reviewer checks the actual work independently/);
 assert.match(instructions, /risks the Coordinator ranked first, reports only source-backed P1\/P2 findings with file:line/);
 assert.match(instructions, /No stage is mandatory/);
});

test('instructions scope the reviewer to the diff, bucket hardening as follow-up, and size the route', () => {
 const instructions = expandOk('openai-codex-simple', 'openai-codex').instructions.join(' ');
 assert.match(instructions, /its input is the diff plus the solution brief and it reads only files in that diff/);
 assert.match(instructions, /in-flight-transition hardening the issue does not name is a FOLLOW-UP line, not a finding/);
 assert.match(instructions, /re-review sees the prior findings and the repair diff only and marks each FIXED or NOT FIXED/);
 assert.match(instructions, /Route sizing: a change touching at most 5 source files with no new module is the Coordinator's own solo implementation plus one diff-scoped review/);
 assert.match(instructions, /A diff under 200 changed lines is self-reviewed by the Coordinator/);
});

test('herdr-native execution swaps the headless subagent line for the interactive Herdr session recipe', () => {
 const headless = expandOk('openai-codex-simple', 'openai-codex').instructions.join(' ');
 assert.match(headless, /Execution: delegated roles run headless through the integrated pi-subagents `subagent` tool/);
 assert.doesNotMatch(headless, /herdr_agent/);
 const native = expandWorkflow({ template: 'openai-codex-simple', provider: 'openai-codex', readiness: 'ready', execution: 'herdr-native' }).value;
 const text = native.instructions.join(' ');
 assert.equal(native.execution, 'herdr-native');
 assert.match(text, /interactive Herdr-native Pi sessions, one new tab per role/);
 assert.match(text, /<workspace-prefix>-<role-suffix> \(resea, plan, work, revie/);
 assert.match(text, /The `subagent` tool is not used/);
 assert.match(text, /herdr_layout tab_create \{workspace, label: <name>, cwd, focus: false\}/);
 assert.match(text, /herdr_agent start \{pane, name: <name>, kind: 'pi', agentArgs: \['--provider', <provider>, '--model', <model>, '--thinking', <thinking>\]\}/);
 assert.match(text, /no flag that strips interactivity \(no --no-extensions, --no-skills, --tools or print mode\)/);
 assert.match(text, /retarget with \/model mid-run/);
 assert.match(text, /keep the pane open, name the pane id to the user, submit `\/model <fallback provider>\/<model>` then `continue` once/);
 assert.match(text, /wait for the user instead of relaunching/);
 assert.match(text, /herdr_pane close only after its report is captured; leave blocked, quota-stopped or user-flagged panes open/);
 assert.match(text, /reuse your own idle same-role pane/);
 assert.doesNotMatch(text, /headless through the integrated pi-subagents/);
 // the role matrix, warnings and fallback line are execution-independent
 const base = expandOk('openai-codex-simple', 'openai-codex');
 assert.deepEqual(native.roles, base.roles);
 assert.deepEqual(native.warnings, base.warnings);
 assert.ok(native.instructions.some((l) => l.startsWith('Provider quota fallback (pre-authorized):')));
 assert.match(native.instructions.at(-1), /^Every role runs as a Pi session\b/);
});

test('every expansion names the pre-authorized quota fallback as the other shipped provider', () => {
 for (const template of TEMPLATES) {
  const one = expandOk(template, 'openai-codex').instructions;
  const two = expandOk(template, 'openai-codex-2').instructions;
  const lineOne = one.find((l) => l.startsWith('Provider quota fallback (pre-authorized):'));
  const lineTwo = two.find((l) => l.startsWith('Provider quota fallback (pre-authorized):'));
  assert.match(lineOne, /relaunch that role on openai-codex-2 with the same model and thinking level/);
  assert.match(lineTwo, /relaunch that role on openai-codex with the same model and thinking level/);
  assert.match(lineOne, /continue without asking\. This is the only pre-authorized runtime change; roles on other routes stop\./);
  assert.equal(one.filter((l) => l.startsWith('Provider quota fallback')).length, 1, 'exactly one fallback line');
  assert.match(one.join(' '), /mismatch blocks the send unless it is separately approved; the quota fallback line is that approval for usage-limit errors only/);
 }
});

test('the Claude templates declare independent Claude permissions; others declare Pi-only', () => {
 for (const template of ['openai-claude-simple', 'openai-claude']) {
  const instructions = expandOk(template, 'openai-codex').instructions.join(' ');
  assert.match(instructions, /run through Herdr/);
  assert.match(instructions, /permissions stay independently controlled/);
 }
 for (const template of ['openai-codex-simple', 'openai-codex-medium', 'openai-codex-high']) {
  const instructions = expandOk(template, 'openai-codex').instructions.join(' ');
  assert.match(instructions, /Every role runs as a Pi session on the selected OpenAI provider\./);
  assert.doesNotMatch(instructions, /Herdr/);
 }
});
