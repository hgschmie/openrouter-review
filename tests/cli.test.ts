import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { git } from '../src/local-git.ts';
import { parseProjectConfig, localConfig } from '../src/local-config.ts';
import { defaults } from '../src/config.ts';

const execute = promisify(execFile);
const binary = process.env.OR_REVIEW_BINARY;
const cli = resolve('src/cli.ts');
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'or-review-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  const home = join(directory, 'config');
  await mkdir(root);
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'CLI tests']);
  await git(root, ['config', 'user.email', 'cli@example.invalid']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(root, 'code.ts'), 'const before = 1;\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'Initial']);
  await git(root, ['checkout', '-b', 'feature']);
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: home, APPDATA: home };
  delete env.OPENROUTER_API_KEY;
  delete env.BUN_OPTIONS;
  delete env.BUN_BE_BUN;
  const run = async (args: string[], extraEnv: NodeJS.ProcessEnv = {}, cwd = root) => {
    try {
      const output = await execute(binary || process.execPath, binary ? args : [cli, ...args], {
        cwd,
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        timeout: 30_000,
      });
      return { ...output, code: 0 };
    } catch (error) {
      const failure = error as Error & { stdout: string; stderr: string; code: number };
      return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
    }
  };
  const credentials = async (url: string, key = 'test-secret') => {
    await mkdir(join(home, 'or-review'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, 'or-review', 'credentials.json'),
      JSON.stringify({ 'base-url': url, 'api-key': key }),
      { mode: 0o600 },
    );
  };
  return { root, home, run, credentials };
}

test('YAML uses typed settings, action defaults, and existing reasoning precedence', () => {
  const values = parseProjectConfig(
    'reasoning-enabled: false\nreasoning-effort: impossible\nexclude-patterns: []\nrequest-options:\n  top_p: 0.5\n',
  );
  const config = localConfig(values, 'key', defaults['base-url']);
  assert.deepEqual(config.options.reasoning, { enabled: false });
  assert.equal(config.options.top_p, 0.5);
  assert.deepEqual(config.exclude, []);
  assert.equal(config.systemPrompt, defaults['sys-prompt']);
  assert.equal(config.userPrompt, defaults['user-prompt']);
});

for (const source of [
  'api-key: secret',
  'base-url: https://attacker.invalid',
  'github-token: secret',
  'watch-mention: review',
  'model: a\nmodel: b',
  'max-tokens: nope',
  'model: [a]',
  'unknown: true',
]) {
  test(`rejects invalid or forbidden project config: ${source.split(':')[0]}`, () => {
    assert.throws(() => parseProjectConfig(source));
  });
}

test('branch, staged, and working tree modes select distinct changes from any subdirectory', async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, 'code.ts'), 'const committed = 2;\n');
  await git(root, ['commit', '-am', 'Change']);
  await writeFile(join(root, 'staged.ts'), 'const staged = 3;\n');
  await git(root, ['add', 'staged.ts']);
  await writeFile(join(root, 'code.ts'), 'const working = 4;\n');
  await writeFile(join(root, 'untracked.ts'), 'not included');
  await writeFile(join(root, '.or-review'), 'base: main\nmodel: configured-model\n');
  await mkdir(join(root, 'nested'));
  for (const [args, expected] of [
    [[], ['code.ts']],
    [['--staged'], ['staged.ts']],
    [['--working-tree'], ['code.ts', 'staged.ts']],
  ] as [string[], string[]][]) {
    const output = await run([...args, '--dry-run', '--model', 'overridden-model'], {}, join(root, 'nested'));
    assert.equal(output.code, 0, output.stderr);
    const data = JSON.parse(output.stdout);
    assert.deepEqual(data.files.sort(), expected.sort());
    assert.equal(data.settings.model, 'overridden-model');
    assert.equal(data.settings.apiKey, undefined);
    assert.match(data.diffSha256, /^[a-f0-9]{64}$/);
  }
  assert.notEqual((await run(['--staged', '--base', 'main'])).code, 0);
});

test('init creates a secret-free config and refuses to overwrite it', async (t) => {
  const { root, run } = await fixture(t);
  assert.equal((await run(['init'])).code, 0);
  const original = await readFile(join(root, '.or-review'), 'utf8');
  assert.deepEqual(parseProjectConfig(original), {});
  assert.notEqual((await run(['init'])).code, 0);
  assert.equal(await readFile(join(root, '.or-review'), 'utf8'), original);
});

test('size limits fail, empty diffs skip, and missing bases are actionable', async (t) => {
  const { root, run } = await fixture(t);
  assert.match((await run(['--dry-run'])).stderr, /Set base/);
  assert.equal((await run(['--working-tree'])).code, 0);
  await writeFile(join(root, 'code.ts'), 'x'.repeat(10_000));
  for (const flag of ['--max-diff-bytes', '--max-diff-chars']) {
    const result = await run(['--working-tree', '--dry-run', flag, '100']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /exceeds/);
  }
});

test('Git external diff and text conversion helpers are never executed', async (t) => {
  const { root, run } = await fixture(t);
  await git(root, ['config', 'diff.external', 'or-review-nonexistent-helper']);
  await git(root, ['config', 'diff.unsafe.textconv', 'or-review-nonexistent-helper']);
  await writeFile(join(root, '.gitattributes'), '*.ts diff=unsafe\n');
  await writeFile(join(root, 'code.ts'), 'changed\n');
  const result = await run(['--working-tree', '--dry-run']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).files.includes('code.ts'));
});

test('local HTTP completion uses saved endpoint, environment key override, and separate usage output', async (t) => {
  const { root, run, credentials } = await fixture(t);
  const requests: { authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: 'Useful review.' } }],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 10 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await credentials(`http://127.0.0.1:${address.port}/v1`);
  await writeFile(join(root, 'code.ts'), 'changed\n');
  await writeFile(join(root, '.or-review'), 'reasoning-max-tokens: 8192\nmax-tokens: 24000\n');
  const result = await run(['--working-tree'], { OPENROUTER_API_KEY: 'override-secret' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /AI-generated review.*\n\nUseful review/s);
  assert.doesNotMatch(result.stdout, /tokens:/);
  assert.match(result.stderr, /prompt tokens: 40 \/ completion tokens: 20 \/ reasoning tokens: 10/);
  assert.doesNotMatch(result.stdout + result.stderr, /override-secret|test-secret/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.authorization, 'Bearer override-secret');
  assert.equal(requests[0]?.body.max_tokens, 24000);
});

test('credential files in a repository and malformed files fail without disclosing keys', async (t) => {
  const { root, run, home, credentials } = await fixture(t);
  await writeFile(join(root, 'code.ts'), 'changed\n');
  await mkdir(join(root, 'or-review'));
  await writeFile(join(root, 'or-review', 'credentials.json'), '{"api-key":"hidden"}', { mode: 0o600 });
  const inside = await run(['--working-tree'], { XDG_CONFIG_HOME: root, APPDATA: root });
  assert.notEqual(inside.code, 0);
  assert.match(inside.stderr, /outside any Git/);
  await credentials(defaults['base-url']);
  await writeFile(join(home, 'or-review', 'credentials.json'), 'INVALID test-secret');
  const invalid = await run(['--working-tree']);
  assert.notEqual(invalid.code, 0);
  assert.doesNotMatch(invalid.stderr, /test-secret/);
  if (process.platform !== 'win32')
    assert.equal((await stat(join(home, 'or-review', 'credentials.json'))).mode & 0o777, 0o600);
});

test('project dotenv and Bun preload configuration cannot supply keys or execute code', async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, 'code.ts'), 'changed\n');
  await writeFile(join(root, '.env'), 'OPENROUTER_API_KEY=project-secret\n');
  await writeFile(join(root, 'bunfig.toml'), 'preload = ["./untrusted.ts"]\n');
  await writeFile(join(root, 'untrusted.ts'), 'throw new Error("UNTRUSTED_EXECUTION");');
  const result = await run(['--working-tree']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /No API key/);
  assert.doesNotMatch(result.stderr, /project-secret|UNTRUSTED_EXECUTION/);
});

test('compiled executable starts without Node or Bun on PATH', { skip: !binary }, async (t) => {
  const { run } = await fixture(t);
  const result = await run(['--version'], { PATH: '' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^or-review \d+\.\d+\.\d+/);
});
