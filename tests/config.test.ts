import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { defaults } from '../src/config.ts';
import { buildRequest } from '../src/openrouter.ts';
import { config, patch } from './helpers.ts';

test('action metadata and runtime defaults agree', () => {
  const action = parse(readFileSync('action.yml', 'utf8'));
  assert.equal(action.runs.using, 'node24');
  for (const [name, value] of Object.entries(defaults))
    assert.equal(action.inputs[name].default, value, name);
});

test('default payload omits optional generation settings', () => {
  const payload = buildRequest(config(), patch());
  assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'stream']);
  assert.equal(payload.model, 'deepseek/deepseek-v4-flash');
  assert.equal(payload.stream, false);
  assert.deepEqual(payload.messages, [
    { role: 'system', content: defaults['sys-prompt'] },
    { role: 'user', content: `Please review the following code changes:\n${patch()}` },
  ]);
});

test('multiline prompts and mention context reach the payload unchanged', () => {
  const cfg = config({ 'sys-prompt': 'System\nline two', 'user-prompt': 'User\nline two' });
  assert.deepEqual(buildRequest(cfg, 'DIFF', '@review look at tests').messages, [
    { role: 'system', content: 'System\nline two' },
    {
      role: 'user',
      content:
        'User\nline two:\nDIFF\n\nAdditional context from PR comment (enclosed in <comment> tags):\n<comment>\n@review look at tests\n</comment>',
    },
  ]);
});

test('explicit zero and false survive named overrides and nested JSON merging', () => {
  const cfg = config({
    'request-options': JSON.stringify({
      temperature: 1,
      top_p: 0.8,
      seed: 0,
      provider: { require_parameters: true },
      reasoning: { enabled: true, exclude: true },
    }),
    temperature: '0',
    'reasoning-enabled': 'false',
    'reasoning-exclude': 'false',
  });
  assert.deepEqual(cfg.options, {
    temperature: 0,
    top_p: 0.8,
    seed: 0,
    provider: { require_parameters: true },
    reasoning: { enabled: false, exclude: false },
  });
});

test('reasoning effort overrides its JSON field without dropping other reasoning fields', () => {
  assert.deepEqual(
    config({ 'request-options': '{"reasoning":{"effort":"low","exclude":true}}', 'reasoning-effort': 'high' })
      .options.reasoning,
    { effort: 'high', exclude: true },
  );
  assert.deepEqual(config({ 'reasoning-max-tokens': '1000', 'max-tokens': '2000' }).options, {
    max_tokens: 2000,
    reasoning: { max_tokens: 1000 },
  });
});

test('patterns accept commas and newlines, and empty exclusions disable filtering', () => {
  const cfg = config({ 'include-patterns': ' src/**,\n .github/** ', 'exclude-patterns': '' });
  assert.deepEqual(cfg.include, ['src/**', '.github/**']);
  assert.deepEqual(cfg.exclude, []);
  assert.equal(config({ 'base-url': 'https://example.test/v1///' }).baseUrl, 'https://example.test/v1');
});

const invalid: [string, Record<string, string>][] = [
  ['missing key', { 'api-key': '' }],
  ['missing GitHub token', { 'github-token': '' }],
  ['malformed JSON', { 'request-options': '{' }],
  ['JSON array', { 'request-options': '[]' }],
  ['JSON null', { 'request-options': 'null' }],
  ['bad temperature', { temperature: 'many' }],
  ['temperature range', { temperature: '3' }],
  ['zero tokens', { 'max-tokens': '0' }],
  ['fractional limit', { 'max-diff-chars': '2.5' }],
  ['negative limit', { 'max-diff-chars': '-1' }],
  ['disabled download limit', { 'max-diff-bytes': '0' }],
  ['negative download limit', { 'max-diff-bytes': '-1' }],
  ['fractional download limit', { 'max-diff-bytes': '1.5' }],
  ['invalid download limit', { 'max-diff-bytes': 'unlimited' }],
  ['bad timeout', { 'timeout-seconds': '0' }],
  ['invalid effort', { 'reasoning-effort': 'extreme' }],
  ['JSON effort array', { 'request-options': '{"reasoning":{"effort":["high"]}}' }],
  ['invalid boolean', { 'reasoning-enabled': 'yes' }],
  ['JSON boolean string', { 'request-options': '{"reasoning":{"exclude":"false"}}' }],
  ['JSON numeric string', { 'request-options': '{"temperature":"0"}' }],
  ['reasoning array', { 'request-options': '{"reasoning":[]}' }],
  ['effort and budget', { 'reasoning-effort': 'high', 'reasoning-max-tokens': '1000' }],
  ['disabled with effort', { 'reasoning-enabled': 'false', 'reasoning-effort': 'high' }],
  ['enabled with none', { 'reasoning-enabled': 'true', 'reasoning-effort': 'none' }],
  ['insufficient output budget', { 'max-tokens': '100', 'reasoning-max-tokens': '100' }],
  ['two output budgets', { 'max-tokens': '100', 'request-options': '{"max_completion_tokens":200}' }],
  ['URL credentials', { 'base-url': 'https://key@example.test/v1' }],
  ['URL query', { 'base-url': 'https://example.test/v1?key=secret' }],
  ['URL scheme', { 'base-url': 'file:///tmp' }],
];
for (const [label, overrides] of invalid)
  test(`rejects ${label}`, () => assert.throws(() => config(overrides)));
for (const key of ['model', 'messages', 'prompt', 'stream', 'tools', 'n']) {
  test(`protects action-owned ${key}`, () =>
    assert.throws(() => config({ 'request-options': JSON.stringify({ [key]: 'override' }) }), /cannot set/));
}
