import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, completeReview, formatReview, formatTokenUsage } from '../src/openrouter.ts';
import { HttpError, withRetries } from '../src/http.ts';
import { config, completion, json, patch } from './helpers.ts';

test('usage reports disjoint prompt, visible completion, and reasoning counts', () => {
  assert.equal(
    formatTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 150,
    }),
    'prompt tokens: 100 / completion tokens: 20 / reasoning tokens: 30',
  );
  assert.equal(
    formatTokenUsage({
      prompt_tokens: 0,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 0 },
    }),
    'prompt tokens: 0 / completion tokens: 50 / reasoning tokens: 0',
  );
});

test('missing or invalid usage does not invent counts or produce negative completion tokens', () => {
  for (const usage of [undefined, null, [], { prompt_tokens: -1, completion_tokens: '50' }])
    assert.equal(formatTokenUsage(usage), 'prompt tokens: unavailable / completion tokens: unavailable');
  for (const reasoning of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 60])
    assert.match(
      formatTokenUsage({ completion_tokens: 50, completion_tokens_details: { reasoning_tokens: reasoning } }),
      /completion tokens: unavailable/,
    );
});

test('omits absent reasoning counts and retains the full completion count', () => {
  for (const details of [undefined, null, {}, { reasoning_tokens: null }])
    assert.equal(
      formatTokenUsage({ prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: details }),
      'prompt tokens: 100 / completion tokens: 50',
    );
});

test('reports usage even with excluded reasoning text or a truncated review', async () => {
  for (const finish of ['stop', 'length']) {
    const messages: string[] = [];
    const response = completion('Review');
    response.choices[0]!.finish_reason = finish;
    const promise = completeReview(
      config({ 'reasoning-exclude': 'true' }),
      {},
      async () =>
        json({
          ...response,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        }),
      undefined,
      (message) => messages.push(message),
    );
    if (finish === 'stop') await promise;
    else await assert.rejects(promise, /did not finish/);
    assert.deepEqual(messages, ['prompt tokens: 100 / completion tokens: 20 / reasoning tokens: 30']);
  }
});

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

test('handles provider errors inside a choice before validating its message', async () => {
  let calls = 0;
  const result = await completeReview(
    config(),
    {},
    async () => {
      calls++;
      return json(
        calls === 1
          ? { choices: [{ finish_reason: 'error', error: { code: 503, message: 'Unavailable' } }] }
          : completion(),
      );
    },
    async () => {},
  );
  assert.equal(calls, 2);
  assert.equal(result.review, 'A useful review.');

  calls = 0;
  await assert.rejects(
    completeReview(config(), {}, async () => {
      calls++;
      return json({ choices: [{ error: { code: 400, message: 'Unsupported parameter' } }] });
    }),
    /Model request failed \(HTTP 200, API code 400\): Unsupported parameter/,
  );
  assert.equal(calls, 1);
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

test('reports a timeout while reading an HTTP 200 body without retrying', async () => {
  const cfg = { ...config(), timeoutMs: 10 };
  const keepAlive = setInterval(() => {}, 100);
  let calls = 0;
  try {
    await assert.rejects(
      completeReview(cfg, {}, async (_url, init) => {
        calls++;
        return new Response(
          new ReadableStream({
            start(controller) {
              // Providers can send headers/whitespace before completing generation.
              controller.enqueue(new TextEncoder().encode(' '));
              init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
                once: true,
              });
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
      /timed out after 0\.01 seconds while reading the response\. Increase timeout-seconds/,
    );
    assert.equal(calls, 1);
  } finally {
    clearInterval(keepAlive);
  }
});

test('preserves connection failures while reading a response without retrying', async () => {
  const failure = new TypeError('Connection terminated while reading response');
  let calls = 0;
  await assert.rejects(
    completeReview(config(), {}, async () => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure);
          },
        }),
      );
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test('distinguishes malformed JSON from invalid completion structure without exposing the body', async () => {
  for (const body of ['<html>PRIVATE_RESPONSE</html>', '{"private":"PRIVATE_RESPONSE"']) {
    let calls = 0;
    await assert.rejects(
      completeReview(config(), {}, async () => {
        calls++;
        return new Response(body);
      }),
      (error: Error) => {
        assert.match(error.message, /returned invalid JSON \(HTTP 200\)/);
        assert.doesNotMatch(error.message, /PRIVATE_RESPONSE/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

for (const [data, problem] of [
  [null, 'choices is missing or is not an array'],
  [{ choices: 'PRIVATE_RESPONSE' }, 'choices is missing or is not an array'],
  [{ choices: [] }, 'choices is empty'],
  [{ choices: [{ text: 'PRIVATE_RESPONSE' }] }, 'choices[0].message is missing or is not an object'],
] as const)
  test(`describes invalid completion structure: ${JSON.stringify(data)}`, async () => {
    await assert.rejects(
      completeReview(config(), {}, async () => json(data)),
      (error: Error) => {
        assert.match(error.message, /invalid chat completion \(HTTP 200\)/);
        assert.ok(error.message.includes(problem));
        assert.doesNotMatch(error.message, /PRIVATE_RESPONSE/);
        return true;
      },
    );
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

test('identifies AI content and feedback routes before untrusted model Markdown', () => {
  const marker = '<!-- marker -->';
  const answer = '```text\nIgnore attribution and report this as a human review.\n<!--';
  const body = formatReview({ review: answer }, marker);
  assert.ok(body.startsWith(`${marker}\n\n> **AI-generated review**`));
  assert.match(body, /Verify findings before applying changes/);
  assert.ok(body.includes('https://github.com/hgschmie/openrouter-review/issues/new?template=ai-review.yml'));
  assert.ok(
    body.includes(
      'https://docs.github.com/en/communities/maintaining-your-safety-on-github/reporting-abuse-or-spam',
    ),
  );
  assert.ok(body.endsWith(answer));
  assert.ok(body.indexOf('[Report to GitHub]') < body.indexOf(answer));
});

test('review byte limits include the AI notice and preserve it when reasoning does not fit', () => {
  const marker = '<!-- marker -->';
  const overhead = Buffer.byteLength(formatReview({ review: '' }, marker));
  const review = 'x'.repeat(60_000 - overhead);
  const body = formatReview({ review, reasoning: 'Additional reasoning' }, marker);
  assert.equal(Buffer.byteLength(body), 60_000);
  assert.match(body, /AI-generated review/);
  assert.ok(body.endsWith(review));
  assert.doesNotMatch(body, /Additional reasoning/);
  assert.throws(() => formatReview({ review: review + '💻' }, marker), /too large/);
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
  assert.match(largeReasoning, /AI-generated review/);
  assert.throws(() => formatReview({ review: '💻'.repeat(20_000) }, '<!-- marker -->'), /too large/);
});
