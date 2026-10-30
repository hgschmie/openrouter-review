import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrClient, PullRequest, Trigger } from '../src/github.ts';
import { runReview } from '../src/review.ts';
import { completeReview } from '../src/openrouter.ts';
import { DiffTooLargeError } from '../src/diff.ts';
import { config, completion, json, patch } from './helpers.ts';

function fixture() {
  const pr: PullRequest = {
    head: 'HEAD',
    base: 'BASE',
    title: 'Fix a bug',
    body: '',
    locked: false,
    state: 'open',
  };
  const seen = { modelCalls: 0, writes: 0, reads: 0, body: '', sha: '', marker: '' };
  const github: PrClient = {
    async getPullRequest() {
      seen.reads++;
      return { ...pr };
    },
    async getCommit(sha) {
      return { sha, message: 'Fix bug' };
    },
    async getDiff() {
      return patch();
    },
    async findReview() {
      return undefined;
    },
    async publish(body, sha, marker) {
      seen.writes++;
      seen.body = body;
      seen.sha = sha;
      seen.marker = marker;
      return { url: 'https://github.test/review/1', sha };
    },
  };
  const complete: typeof completeReview = async (cfg, request) => {
    seen.modelCalls++;
    return completeReview(cfg, request, async () =>
      json(completion('Review result', { reasoning: 'Reasoning result' })),
    );
  };
  const trigger: Trigger = { number: 42, expectedHead: 'HEAD' };
  return { pr, seen, github, complete, trigger };
}

test('full flow sends a filtered diff and publishes the answer on the captured commit', async () => {
  const f = fixture();
  f.github.getDiff = async () => patch() + patch('package-lock.json');
  const messages: string[] = [];
  const result = await runReview(
    config(),
    f.trigger,
    f.github,
    async (cfg, request) => {
      assert.deepEqual(messages, ['Requesting model review for PR #42: head HEAD, base BASE.']);
      assert.doesNotMatch(JSON.stringify(request), /package-lock/);
      return f.complete(cfg, request);
    },
    (message) => messages.push(message),
  );
  assert.deepEqual(result, { reviewUrl: 'https://github.test/review/1', reviewedSha: 'HEAD' });
  assert.equal(f.seen.writes, 1);
  assert.equal(f.seen.sha, 'HEAD');
  assert.match(f.seen.body, /^<!-- openrouter-review:v1:[a-f0-9]{64} -->\n/);
  assert.match(f.seen.body, /Review result[\s\S]*Reasoning result/);
});

for (const [label, changes] of [
  ['closed', { state: 'closed' }],
  ['locked', { locked: true }],
  ['skip title', { title: 'Fix bug [SKIP CR]' }],
  ['skip body', { body: 'skip review' }],
  ['stale event', { head: 'NEW' }],
] as const)
  test(`skips ${label} before requesting the model`, async () => {
    const f = fixture();
    Object.assign(f.pr, changes);
    assert.ok((await runReview(config(), f.trigger, f.github, f.complete)).skippedReason);
    assert.equal(f.seen.modelCalls, 0);
    assert.equal(f.seen.writes, 0);
  });

test('honors the head commit skip marker', async () => {
  const f = fixture();
  f.github.getCommit = async (sha) => ({ sha, message: 'skip review' });
  assert.match((await runReview(config(), f.trigger, f.github, f.complete)).skippedReason!, /Head commit/);
  assert.equal(f.seen.modelCalls, 0);
});

test('skips all-filtered diffs without making a paid request', async () => {
  const f = fixture();
  const result = await runReview(
    config({ 'include-patterns': 'absent/**' }),
    f.trigger,
    f.github,
    f.complete,
  );
  assert.ok(result.skippedReason);
  assert.equal(f.seen.modelCalls, 0);
});

test('oversized filtered diffs fail without a model call or review', async () => {
  const f = fixture();
  await assert.rejects(
    runReview(config({ 'max-diff-chars': '1' }), f.trigger, f.github, f.complete),
    /Filtered diff exceeds max-diff-chars \(1 characters\).*increase max-diff-chars/,
  );
  assert.equal(f.seen.modelCalls, 0);
  assert.equal(f.seen.writes, 0);
});

test('oversized downloads fail without a model call or review, even with the character limit disabled', async () => {
  const f = fixture();
  f.github.getDiff = async () => {
    throw new DiffTooLargeError(20971520);
  };
  await assert.rejects(
    runReview(config({ 'max-diff-chars': '0' }), f.trigger, f.github, f.complete),
    /Raw diff exceeds max-diff-bytes \(20971520 bytes\).*increase max-diff-bytes/,
  );
  assert.equal(f.seen.modelCalls, 0);
  assert.equal(f.seen.writes, 0);
});

test('other download failures remain errors', async () => {
  const f = fixture();
  f.github.getDiff = async () => {
    throw new Error('Network unavailable');
  };
  await assert.rejects(runReview(config(), f.trigger, f.github, f.complete), /Network unavailable/);
  assert.equal(f.seen.modelCalls, 0);
});

test('size limit counts Unicode code points; zero disables it', async () => {
  const f = fixture();
  const diff = patch('💻.ts');
  f.github.getDiff = async () => diff;
  assert.equal(
    (await runReview(config({ 'max-diff-chars': String([...diff].length) }), f.trigger, f.github, f.complete))
      .skippedReason,
    undefined,
  );
  assert.equal(
    (await runReview(config({ 'max-diff-chars': '0' }), f.trigger, f.github, f.complete)).skippedReason,
    undefined,
  );
});

test('detects a changed revision before making the paid request', async () => {
  const f = fixture();
  const messages: string[] = [];
  f.github.getDiff = async () => {
    f.pr.head = 'NEW';
    return patch();
  };
  const result = await runReview(config(), f.trigger, f.github, f.complete, (message) =>
    messages.push(message),
  );
  assert.match(result.skippedReason!, /fetching/);
  assert.deepEqual(messages, []);
  assert.equal(f.seen.modelCalls, 0);
});

for (const field of ['head', 'base', 'state', 'locked'] as const)
  test(`does not post if ${field} changes during model generation`, async () => {
    const f = fixture();
    const result = await runReview(config(), f.trigger, f.github, async () => {
      if (field === 'locked') f.pr.locked = true;
      else f.pr[field] = field === 'state' ? 'closed' : 'NEW';
      return { review: 'Now stale' };
    });
    assert.match(result.skippedReason!, /not posted/);
    assert.equal(result.reviewedSha, undefined);
    assert.equal(f.seen.writes, 0);
  });

test('identical settings deduplicate regardless of JSON object key order', async () => {
  const f = fixture();
  await runReview(
    config({ 'request-options': '{"seed":7,"provider":{"sort":"price","allow_fallbacks":false}}' }),
    f.trigger,
    f.github,
    f.complete,
  );
  f.github.findReview = async (marker, sha) =>
    marker === f.seen.marker ? { url: 'existing', sha } : undefined;
  const result = await runReview(
    config({ 'request-options': '{"provider":{"allow_fallbacks":false,"sort":"price"},"seed":7}' }),
    f.trigger,
    f.github,
    f.complete,
  );
  assert.equal(result.reviewUrl, 'existing');
  assert.ok(result.skippedReason);
  assert.equal(f.seen.modelCalls, 1);
  assert.equal(f.seen.writes, 1);
});

test('new settings and distinct mention IDs request new reviews, but replaying a mention deduplicates', async () => {
  const f = fixture();
  const markers = new Set<string>();
  f.github.findReview = async (marker, sha) => (markers.has(marker) ? { url: 'existing', sha } : undefined);
  f.github.publish = async (_body, sha, marker) => {
    markers.add(marker);
    return { url: 'new', sha };
  };
  await runReview(config(), f.trigger, f.github, f.complete);
  await runReview(config({ model: 'another/model' }), f.trigger, f.github, f.complete);
  for (const commentId of [1, 2, 2])
    await runReview(config(), { number: 42, comment: '@review', commentId }, f.github, f.complete);
  assert.equal(f.seen.modelCalls, 4);
});

test('a concurrent completed review is detected again immediately before publishing', async () => {
  const f = fixture();
  let checks = 0;
  f.github.findReview = async (_marker, sha) => (++checks === 2 ? { url: 'concurrent', sha } : undefined);
  const result = await runReview(config(), f.trigger, f.github, f.complete);
  assert.equal(result.reviewUrl, 'concurrent');
  assert.equal(f.seen.writes, 0);
});
