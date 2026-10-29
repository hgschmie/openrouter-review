import test from 'node:test';
import assert from 'node:assert/strict';
import { DiffTooLargeError, exceedsCharLimit, filterDiff, readDiff } from '../src/diff.ts';
import { patch } from './helpers.ts';

test('filters full file blocks, including nested lockfiles and dot directories', () => {
  const source = patch('src/main.ts');
  const hidden = patch('.github/workflows/ci.yml');
  const diff = source + hidden + patch('nested/package-lock.json') + patch('Cargo.lock');
  assert.equal(filterDiff(diff, [], ['package-lock.json', '*.lock']), source + hidden);
  assert.equal(filterDiff(diff, ['src/**', '.github/**'], ['**/*.yml']), source);
  assert.equal(filterDiff(diff, ['*.ts'], []), source);
  assert.equal(filterDiff(diff, ['absent/**'], []), '');
});

test('handles added and deleted files, spaces, and literal regex characters', () => {
  const added = patch('a+b (copy).ts').replace('--- a/a+b (copy).ts', '--- /dev/null');
  const deleted = patch('old file.ts').replace('+++ b/old file.ts', '+++ /dev/null');
  assert.equal(filterDiff(added + deleted, ['*.ts'], []), added + deleted);
  assert.equal(filterDiff(added + deleted, [], ['old file.ts']), added);
});

test('Git octal UTF-8, tabs, and escaped quotes decode before matching', () => {
  const quoted = '"a/caf\\303\\251\\t\\"x.ts"';
  const newer = '"b/caf\\303\\251\\t\\"x.ts"';
  const diff = `diff --git ${quoted} ${newer}\n--- ${quoted}\n+++ ${newer}\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.equal(filterDiff(diff, ['café\t"x.ts'], []), diff);
  assert.equal(filterDiff(diff, [], ['café\t"x.ts']), '');
});

test('renames match either path and exclusions win across a rename', () => {
  const diff =
    'diff --git a/old file.ts b/new file.ts\nsimilarity index 100%\nrename from old file.ts\nrename to new file.ts\n';
  assert.equal(filterDiff(diff, ['new file.ts'], []), diff);
  assert.equal(filterDiff(diff, ['old file.ts'], ['new file.ts']), '');
});

test('retains mode-only changes and handles ambiguous spaces in headers', () => {
  const diff = 'diff --git a/a b/c b/a b/c\nold mode 100644\nnew mode 100755\n';
  assert.equal(filterDiff(diff, ['a b/c'], []), diff);
  assert.equal(filterDiff(diff, [], ['a b/c']), '');
});

test('binary and empty diffs are skipped, unexpected formats fail visibly', () => {
  const binary = 'diff --git a/photo.png b/photo.png\nBinary files a/photo.png and b/photo.png differ\n';
  assert.equal(filterDiff(binary, [], []), '');
  assert.equal(filterDiff('', [], []), '');
  assert.throws(() => filterDiff('<html>bad gateway</html>', [], []), /unrecognized/);
});

test('character limit counts code points and permits exactly the configured limit', () => {
  for (const [text, length] of [
    ['', 0],
    ['abc', 3],
    ['a💻é', 3],
    ['💻💻', 2],
    ['\ud800x\udc00', 3],
  ] as const) {
    assert.equal(exceedsCharLimit(text, length), false);
    assert.equal(exceedsCharLimit(text, length + 1), false);
    if (length > 1) assert.equal(exceedsCharLimit(text, length - 1), true);
    assert.equal(exceedsCharLimit(text, 0), false);
  }
});

test('download limit preserves UTF-8 split across chunks and accepts the exact byte limit', async () => {
  const text = 'a💻é\n';
  const bytes = Buffer.from(text);
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(index, ++index));
      },
    },
    { highWaterMark: 0 },
  );
  assert.equal(await readDiff(body, bytes.length), text);
  assert.equal(body.locked, false);
});

test('a declared oversize body is canceled before the first read', async () => {
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(readDiff(body, 100, '101'), DiffTooLargeError);
  assert.equal(pulls, 0);
  assert.equal(canceled, true);
  assert.equal(body.locked, false);
});

test('an oversized chunk is rejected even when cancellation fails', async () => {
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(101));
      },
      cancel() {
        throw new Error('Already disconnected');
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(readDiff(body, 100), DiffTooLargeError);
  assert.equal(body.locked, false);
});

test('a failed response stream propagates the error without returning a partial diff', async () => {
  let reads = 0;
  const failure = new Error('Connection lost');
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (reads++ === 0) controller.enqueue(Buffer.from(patch()));
        else controller.error(failure);
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(readDiff(body, 1024), (error) => error === failure);
  assert.equal(body.locked, false);
});
