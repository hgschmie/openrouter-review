import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('a large diff fails cleanly with a 64 MiB JS heap', { timeout: 30_000 }, async () => {
  const script = `
    import { runReview } from './src/review.ts';
    import { config, patch } from './tests/helpers.ts';
    // These valid removed/added lines also resemble diff file headers. The
    // parser must stop after the actual headers instead of collecting them all.
    const lines = '--- old text\\n+++ new text\\n';
    const diff = patch() + lines.repeat(Math.floor(20 * 1024 * 1024 / lines.length));
    const pr = { head: 'HEAD', base: 'BASE', state: 'open', locked: false, title: 'Fix', body: '' };
    const unexpected = async () => { throw new Error('Oversized diff reached the model or review API'); };
    await runReview(config(), { number: 1 }, {
      getPullRequest: async () => pr,
      getCommit: async sha => ({ sha, message: 'Fix' }),
      getDiff: async () => diff,
      findReview: unexpected,
      publish: unexpected,
    }, unexpected);
  `;
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ['--max-old-space-size=64', '--input-type=module', '--eval', script],
      { timeout: 20_000 },
    ),
    (error: Error & { code?: number; stderr: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Error: Filtered diff exceeds max-diff-chars/);
      return true;
    },
  );
});
