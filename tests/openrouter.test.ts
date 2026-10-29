import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, completeReview, formatReview } from '../src/openrouter.ts';
import { HttpError, withRetries } from '../src/http.ts';
import { config, completion, json, patch } from './helpers.ts';

test('sends the configured endpoint, authorization, body and timeout signal', async () => {
  const cfg = config({
    'base-url': 'https://models.test/v1',
    'reasoning-effort': 'high',
    'reasoning-exclude': 'false',
  });
  const payload = buildRequest(cfg, patch());
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://models.test/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer model-test-key');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, 'error');
    return json(completion(' Review ', { reasoning: ' Reasoning ' }));
  };
  assert.deepEqual(await completeReview(cfg, payload, fake), { review: 'Review', reasoning: 'Reasoning' });
});

test('respects reasoning exclusion even if a provider returns reasoning', async () => {
  const cfg = config({ 'reasoning-exclude': 'true' });
  const result = await completeReview(cfg, {}, async () =>
    json(completion('Review', { reasoning_content: 'Secret-ish reasoning' })),
  );
  assert.equal(result.reasoning, undefined);
});

test('retries rate limiting and non-JSON server errors, honoring Retry-After', async () => {
  let calls = 0;
  const waits: number[] = [];
  const fake: typeof fetch = async () => {
    calls++;
    if (calls === 1) return json({ error: { message: 'Slow down' } }, 429, { 'retry-after': '3' });
    if (calls === 2) return new Response('Unavailable', { status: 503 });
    return json(completion());
  };
  await completeReview(config(), {}, fake, async (ms) => {
    waits.push(ms);
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3000, 2000]);
});

test('retries embedded API errors returned with HTTP 200', async () => {
  let calls = 0;
  await completeReview(
    config(),
    {},
    async () => (++calls === 1 ? json({ error: { code: 503, message: 'Unavailable' } }) : json(completion())),
    async () => {},
  );
  assert.equal(calls, 2);
});

test('stops after three transient failures', async () => {
  let calls = 0;
  await assert.rejects(
    completeReview(
      config(),
      {},
      async () => {
        calls++;
        return json({ error: { message: 'Unavailable' } }, 503);
      },
      async () => {},
    ),
    /503/,
  );
  assert.equal(calls, 3);
});

test('does not retry authentication failures, ambiguous connection errors, or excessive Retry-After', async () => {
  for (const failure of [
    new HttpError('Unauthorized', 401),
    new TypeError('Network lost'),
    new HttpError('Wait', 429, '120'),
  ]) {
    let calls = 0;
    await assert.rejects(
      withRetries(
        async () => {
          calls++;
          throw failure;
        },
        async () => {
          assert.fail('Unexpected retry');
        },
      ),
    );
    assert.equal(calls, 1);
  }
});

test('times out an unresponsive model request without retrying', async () => {
  const cfg = { ...config(), timeoutMs: 10 };
  // Keep the process alive because AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 100);
  let calls = 0;
  try {
    await assert.rejects(
      completeReview(cfg, {}, async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
        );
      }),
      /timeout/i,
    );
    assert.equal(calls, 1);
  } finally {
    clearInterval(keepAlive);
  }
});

for (const [label, data] of [
  ['empty answer', completion('')],
  ['invalid structure', {}],
  ['truncated answer', { choices: [{ finish_reason: 'length', message: { content: 'Partial' } }] }],
  ['filtered answer', { choices: [{ finish_reason: 'content_filter', message: { content: 'Filtered' } }] }],
  ['tool call', { choices: [{ finish_reason: 'tool_calls', message: { content: '' } }] }],
])
  test(`rejects ${label}`, async () => {
    await assert.rejects(completeReview(config(), {}, async () => json(data)));
  });

test('formats reasoning details and preserves the complete answer when reasoning is too large', () => {
  assert.match(
    formatReview({ review: 'Answer', reasoning: 'Reason' }, '<!-- marker -->'),
    /<details>[\s\S]*Reason/,
  );
  const largeReasoning = formatReview(
    { review: 'Full answer', reasoning: 'x'.repeat(61_000) },
    '<!-- marker -->',
  );
  assert.match(largeReasoning, /Full answer/);
  assert.match(largeReasoning, /Reasoning omitted/);
  assert.throws(() => formatReview({ review: '💻'.repeat(20_000) }, '<!-- marker -->'), /too large/);
});
