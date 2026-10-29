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
    reasoning: { enabled: false },
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

const reasoningBudgets: [string, Record<string, string>][] = [
  ['both named inputs', { 'reasoning-effort': 'high', 'reasoning-max-tokens': '1000' }],
  ['both JSON fields', { 'request-options': '{"reasoning":{"effort":"high","max_tokens":1000}}' }],
  [
    'named budget and JSON effort',
    { 'reasoning-max-tokens': '1000', 'request-options': '{"reasoning":{"effort":"high","max_tokens":500}}' },
  ],
  [
    'JSON budget and named effort',
    { 'reasoning-effort': 'high', 'request-options': '{"reasoning":{"max_tokens":1000}}' },
  ],
  ['ignored invalid effort', { 'reasoning-effort': 'extreme', 'reasoning-max-tokens': '1000' }],
  [
    'ignored none effort with reasoning enabled',
    { 'reasoning-effort': 'none', 'reasoning-max-tokens': '1000' },
  ],
];
for (const [label, overrides] of reasoningBudgets)
  test(`reasoning token budget takes precedence: ${label}`, () => {
    const notices: string[] = [];
    const payload = buildRequest(
      config(
        {
          ...overrides,
          'max-tokens': '2000',
          'reasoning-enabled': 'true',
          'reasoning-exclude': 'true',
        },
        (message) => notices.push(message),
      ),
      patch(),
    );
    assert.deepEqual(payload.reasoning, { max_tokens: 1000, enabled: true, exclude: true });
    assert.equal(payload.max_tokens, 2000);
    assert.deepEqual(notices, []);
  });

const disabledReasoning: [string, Record<string, string>][] = [
  [
    'named false overrides JSON settings and ignores an excessive budget',
    {
      'reasoning-enabled': 'false',
      'request-options':
        '{"reasoning":{"enabled":true,"effort":"high","max_tokens":2000,"exclude":true,"extra":42}}',
    },
  ],
  [
    'JSON false ignores invalid named settings',
    {
      'request-options': '{"reasoning":{"enabled":false}}',
      'reasoning-effort': 'invalid',
      'reasoning-max-tokens': 'invalid',
      'reasoning-exclude': 'invalid',
    },
  ],
  [
    'JSON false ignores invalid JSON settings',
    { 'request-options': '{"reasoning":{"enabled":false,"effort":[],"max_tokens":-1,"exclude":"invalid"}}' },
  ],
  [
    'named false ignores malformed reasoning object',
    { 'reasoning-enabled': 'false', 'request-options': '{"reasoning":[]}' },
  ],
  ['explicit false takes precedence over none', { 'reasoning-enabled': 'false', 'reasoning-effort': 'none' }],
];
for (const [label, overrides] of disabledReasoning)
  test(`disabled reasoning: ${label}`, () => {
    const notices: string[] = [];
    const payload = buildRequest(
      config({ ...overrides, 'max-tokens': '1000' }, (message) => notices.push(message)),
      patch(),
    );
    assert.deepEqual(payload.reasoning, { enabled: false });
    assert.equal(payload.max_tokens, 1000);
    assert.deepEqual(notices, []);
  });

for (const overrides of [
  { 'reasoning-enabled': 'true', 'reasoning-effort': 'none' },
  { 'request-options': '{"reasoning":{"enabled":true,"effort":"none","exclude":true}}' },
  { 'reasoning-enabled': 'true', 'request-options': '{"reasoning":{"effort":"none"}}' },
  { 'reasoning-effort': 'none', 'request-options': '{"reasoning":{"enabled":true}}' },
  { 'reasoning-effort': 'none' },
] as Record<string, string>[])
  test(`none effort disables reasoning and reports why: ${JSON.stringify(overrides)}`, () => {
    const notices: string[] = [];
    const payload = buildRequest(
      config(overrides, (message) => notices.push(message)),
      patch(),
    );
    assert.deepEqual(payload.reasoning, { enabled: false });
    assert.deepEqual(notices, ['reasoning disabled because effort is set to none']);
  });

test('named true overrides JSON false and preserves active reasoning settings', () => {
  const cfg = config({
    'reasoning-enabled': 'true',
    'reasoning-exclude': 'false',
    'request-options': '{"reasoning":{"enabled":false,"effort":"high","exclude":true}}',
  });
  assert.deepEqual(cfg.options.reasoning, { enabled: true, effort: 'high', exclude: false });
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
  ['JSON enabled string', { 'request-options': '{"reasoning":{"enabled":"false"}}' }],
  ['JSON numeric string', { 'request-options': '{"temperature":"0"}' }],
  ['reasoning array', { 'request-options': '{"reasoning":[]}' }],
  ['invalid reasoning budget with effort', { 'reasoning-effort': 'high', 'reasoning-max-tokens': '0' }],
  [
    'JSON reasoning budget string',
    { 'request-options': '{"reasoning":{"effort":"high","max_tokens":"1000"}}' },
  ],
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
