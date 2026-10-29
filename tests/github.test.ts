import test from 'node:test';
import assert from 'node:assert/strict';
import { getOctokit } from '@actions/github';
import { createGitHub, selectTrigger } from '../src/github.ts';
import type { EventContext } from '../src/github.ts';
import { config, json, patch } from './helpers.ts';
import { DiffTooLargeError } from '../src/diff.ts';

const context: EventContext = {
  eventName: 'issue_comment',
  repo: { owner: 'owner', repo: 'repo' },
  payload: {
    action: 'created',
    issue: { number: 42, pull_request: {} },
    sender: { login: 'alice', type: 'User' },
    comment: {
      id: 123,
      body: '@review please check this',
      author_association: 'MEMBER',
      user: { login: 'alice', type: 'User' },
    },
  },
};
const cfg = config({ 'watch-mention': '@review' });

test('recognizes a permitted mention and captures its context and ID', () => {
  assert.deepEqual(selectTrigger(context, cfg), {
    number: 42,
    comment: '@review please check this',
    commentId: 123,
  });
});

for (const [label, mutate] of [
  [
    'issue comment',
    (payload: Record<string, unknown>) => {
      payload.issue = { number: 42 };
    },
  ],
  [
    'edit',
    (payload: Record<string, unknown>) => {
      payload.action = 'edited';
    },
  ],
  [
    'bot sender',
    (payload: Record<string, unknown>) => {
      payload.sender = { type: 'Bot' };
    },
  ],
  [
    'untrusted author',
    (payload: Record<string, unknown>) => {
      payload.comment = { ...(context.payload.comment as object), author_association: 'CONTRIBUTOR' };
    },
  ],
  [
    'bot author',
    (payload: Record<string, unknown>) => {
      payload.comment = { ...(context.payload.comment as object), user: { login: 'other[bot]' } };
    },
  ],
  [
    'mention prefix',
    (payload: Record<string, unknown>) => {
      payload.comment = { ...(context.payload.comment as object), body: 'hello@review-more' };
    },
  ],
] as const)
  test(`skips ${label}`, () => {
    const event = structuredClone(context);
    mutate(event.payload);
    assert.ok('skip' in selectTrigger(event, cfg));
  });

test('mention matching escapes regex syntax and requires token boundaries', () => {
  const event = structuredClone(context);
  event.payload.comment = { ...(event.payload.comment as object), body: '(@review.v1+), please' };
  assert.ok('number' in selectTrigger(event, config({ 'watch-mention': '@review.v1+' })));
  event.payload.comment = { ...(event.payload.comment as object), body: '@reviewXv111' };
  assert.ok('skip' in selectTrigger(event, config({ 'watch-mention': '@review.v1+' })));
});

test('comment triggers default to disabled; unsupported events skip', () => {
  assert.ok('skip' in selectTrigger(context, config()));
  assert.ok('skip' in selectTrigger({ ...context, eventName: 'push' }, cfg));
});

test('PR events use the actual PR head rather than the workflow merge/base SHA', () => {
  for (const eventName of ['pull_request', 'pull_request_target']) {
    assert.deepEqual(
      selectTrigger(
        {
          ...context,
          eventName,
          payload: { action: 'synchronize', pull_request: { number: 42, head: { sha: 'HEAD' } } },
        },
        cfg,
      ),
      { number: 42, expectedHead: 'HEAD' },
    );
  }
});

function client(fetchImpl: typeof fetch, settings = cfg) {
  return createGitHub(
    settings,
    context.repo,
    42,
    getOctokit('test-token', { baseUrl: 'https://github.test', request: { fetch: fetchImpl } }),
  );
}

test('GitHub adapter fetches the exact head commit and requests the full diff media type', async () => {
  const github = client(async (url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    if (String(url).endsWith('/git/commits/HEAD')) return json({ sha: 'HEAD', message: 'Fix bug' });
    assert.ok(String(url).endsWith('/pulls/42'));
    assert.match(new Headers(init?.headers).get('accept')!, /diff/);
    return new Response(patch(), { headers: { 'content-type': 'text/plain' } });
  });
  assert.deepEqual(await github.getCommit('HEAD'), { sha: 'HEAD', message: 'Fix bug' });
  assert.equal(await github.getDiff(), patch());
});

for (const contentLength of [undefined, '1']) {
  test(`diff download stops while reading with ${contentLength ? 'understated' : 'missing'} Content-Length`, async () => {
    let calls = 0;
    let chunks = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunks++ === 6400)
            controller.close(); // 100 MiB if fully consumed
          else controller.enqueue(new Uint8Array(16384));
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const github = client(
      async () => {
        calls++;
        const headers = new Headers({ 'content-type': 'text/plain' });
        if (contentLength) headers.set('content-length', contentLength);
        return new Response(body, { headers });
      },
      config({ 'max-diff-bytes': '65536' }),
    );
    await assert.rejects(github.getDiff(), DiffTooLargeError);
    assert.equal(chunks, 5);
    assert.equal(canceled, true);
    assert.equal(calls, 1); // Oversize responses are not retried.
  });
}

test('compressed Content-Length is ignored in favor of decoded bytes', async () => {
  const github = client(
    async () =>
      new Response(patch(), {
        // fetch exposes decompressed bytes but retains the wire response headers.
        headers: { 'content-encoding': 'gzip', 'content-length': '999999' },
      }),
    config({ 'max-diff-bytes': String(Buffer.byteLength(patch())) }),
  );
  assert.equal(await github.getDiff(), patch());
});

test('the request timeout still applies while consuming a stalled diff body', async () => {
  const keepAlive = setInterval(() => {}, 100);
  let calls = 0;
  const github = client(
    async (_url, init) => {
      calls++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from(patch()));
          init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), {
            once: true,
          });
        },
      });
      return new Response(body);
    },
    { ...cfg, timeoutMs: 20 },
  );
  try {
    await assert.rejects(github.getDiff(), /timeout/i);
    assert.equal(calls, 1);
  } finally {
    clearInterval(keepAlive);
  }
});

test('deduplication paginates reviews and ignores untrusted human or pending reviews', async () => {
  let reads = 0;
  const review = {
    body: '<!-- marker -->\nReview',
    state: 'COMMENTED',
    commit_id: 'HEAD',
    html_url: 'https://github.test/review/1',
    user: { type: 'Bot' },
    author_association: 'NONE',
  };
  const github = client(async (url) => {
    reads++;
    if (String(url).includes('page=2')) return json([review]);
    return json(
      [
        { ...review, state: 'PENDING' },
        { ...review, user: { type: 'User' } },
        { ...review, commit_id: 'OLD' },
      ],
      200,
      { link: '<https://github.test/repos/owner/repo/pulls/42/reviews?page=2>; rel="next"' },
    );
  });
  assert.deepEqual(await github.findReview('<!-- marker -->', 'HEAD'), { url: review.html_url, sha: 'HEAD' });
  assert.equal(reads, 2);
});

test('publishing sends COMMENT and the reviewed commit SHA', async () => {
  const github = client(async (_url, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      body: '<!-- marker -->\nReview',
      commit_id: 'HEAD',
      event: 'COMMENT',
    });
    return json({ html_url: 'https://github.test/review/1' });
  });
  assert.deepEqual(await github.publish('<!-- marker -->\nReview', 'HEAD', '<!-- marker -->'), {
    url: 'https://github.test/review/1',
    sha: 'HEAD',
  });
});

test('an ambiguous write is reconciled with a read, never blindly posted twice', async () => {
  let posts = 0;
  const github = client(async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      throw new Error('Socket closed after accepting review');
    }
    return json([
      {
        body: '<!-- marker -->\nReview',
        state: 'COMMENTED',
        commit_id: 'HEAD',
        html_url: 'url',
        user: { type: 'Bot' },
      },
    ]);
  });
  assert.deepEqual(await github.publish('body', 'HEAD', '<!-- marker -->'), { url: 'url', sha: 'HEAD' });
  assert.equal(posts, 1);
});

test('a failed write with no published review fails the action', async () => {
  let posts = 0;
  const github = client(async (_url, init) => {
    if (init?.method === 'POST') {
      posts++;
      return json({ message: 'Forbidden' }, 403);
    }
    return json([]);
  });
  await assert.rejects(github.publish('body', 'HEAD', '<!-- marker -->'), /Forbidden/);
  assert.equal(posts, 1);
});
