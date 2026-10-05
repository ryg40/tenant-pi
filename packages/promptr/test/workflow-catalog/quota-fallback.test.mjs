// Pre-authorized provider quota fallback text: pure, deterministic, visible when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 QUOTA_FALLBACK_PREFIX, isQuotaFallbackInstruction, quotaFallbackInstruction, quotaFallbackProvider,
} from '../../dist/src/workflow/catalog.mjs';

test('the fallback provider is the next one in picker order, wrapping around', () => {
 assert.equal(quotaFallbackProvider('a', ['a', 'b', 'c']), 'b');
 assert.equal(quotaFallbackProvider('c', ['a', 'b', 'c']), 'a');
 assert.equal(quotaFallbackProvider('b', ['a', 'b']), 'a');
 assert.equal(quotaFallbackProvider('x', ['a', 'b']), 'a', 'an unlisted selection falls back to the first other provider');
 assert.equal(quotaFallbackProvider('a', ['a']), undefined);
 assert.equal(quotaFallbackProvider('a', []), undefined);
});

test('the instruction names the fallback, the same model/thinking, and the quota-only scope', () => {
 const line = quotaFallbackInstruction('openai-codex', ['openai-codex', 'openai-codex-2']);
 assert.ok(line.startsWith(QUOTA_FALLBACK_PREFIX));
 assert.ok(isQuotaFallbackInstruction(line));
 assert.match(line, /usage-limit or quota error/);
 assert.match(line, /relaunch that role on openai-codex-2 with the same model and thinking level/);
 assert.match(line, /record the switch in its report/);
 assert.match(line, /continue without asking/);
 assert.match(line, /only pre-authorized runtime change/);
 assert.equal(line, quotaFallbackInstruction('openai-codex', ['openai-codex', 'openai-codex-2']), 'deterministic');
});

test('a single provider yields an explicit no-fallback line rather than silence', () => {
 const line = quotaFallbackInstruction('github-copilot', ['github-copilot']);
 assert.ok(isQuotaFallbackInstruction(line));
 assert.match(line, /no fallback provider is configured; a usage-limit or quota error is a stop condition to report to the user/);
 assert.equal(isQuotaFallbackInstruction('Every role runs as a Pi session on openai-codex.'), false);
});
