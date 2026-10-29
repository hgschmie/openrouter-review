import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { defaults } from '../src/config.ts';
import { completion, patch } from './helpers.ts';

const exec = promisify(execFile);

for (const diffMode of ['normal', 'oversized-chunked', 'oversized-gzip'] as const)
  test(
    `standalone bundle handles ${diffMode} diffs through real HTTP and exports action outputs`,
    { timeout: 30_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'openrouter-review-test-'));
      const requests: { method: string; path: string }[] = [];
      const errors: unknown[] = [];
      let modelRequest: Record<string, unknown> | undefined;
      let posted: Record<string, unknown> | undefined;
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url!, 'http://localhost');
          requests.push({ method: req.method!, path: url.pathname });
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString('utf8');
          let result: unknown;
          if (url.pathname === '/api/v1/chat/completions') {
            assert.equal(req.headers.authorization, 'Bearer fake-model-key');
            modelRequest = JSON.parse(body);
            result = completion('Found a potential issue.', { reasoning: 'Consider the boundary case.' });
          } else {
            assert.equal(req.headers.authorization, 'token fake-github-key');
            if (url.pathname.endsWith('/git/commits/HEAD')) result = { sha: 'HEAD', message: 'Fix bug' };
            else if (url.pathname.endsWith('/reviews') && req.method === 'POST') {
              posted = JSON.parse(body);
              result = { html_url: 'https://github.test/owner/repo/pull/42#review-1' };
            } else if (url.pathname.endsWith('/reviews')) result = [];
            else if (url.pathname.endsWith('/pulls/42') && req.headers.accept?.includes('diff')) {
              res.setHeader('content-type', 'text/plain');
              if (diffMode === 'normal') res.end(patch() + patch('nested/package-lock.json'));
              else if (diffMode === 'oversized-gzip') {
                res.setHeader('content-encoding', 'gzip');
                res.end(gzipSync(patch() + 'x'.repeat(131072)));
              } else {
                res.write(patch()); // Chunked response, without Content-Length.
                res.end('x'.repeat(131072));
              }
              return;
            } else if (url.pathname.endsWith('/pulls/42'))
              result = {
                head: { sha: 'HEAD' },
                base: { sha: 'BASE' },
                state: 'open',
                locked: false,
                title: 'Fix bug',
                body: '',
              };
            else throw new Error(`Unexpected request ${req.method} ${url.pathname}`);
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (error) {
          errors.push(error);
          res.statusCode = 500;
          res.end('{}');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        // Execute only the published files, outside the source tree and node_modules.
        await copyFile(resolve('dist/index.js'), join(dir, 'index.js'));
        await copyFile(resolve('dist/package.json'), join(dir, 'package.json'));
        await writeFile(
          join(dir, 'event.json'),
          JSON.stringify({ action: 'opened', pull_request: { number: 42, head: { sha: 'HEAD' } } }),
        );
        await writeFile(join(dir, 'outputs'), '');
        await writeFile(join(dir, 'summary'), '');
        const env = {
          ...process.env,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
          NO_PROXY: '*',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_API_URL: base,
          GITHUB_EVENT_NAME: 'pull_request_target',
          GITHUB_EVENT_PATH: join(dir, 'event.json'),
          GITHUB_OUTPUT: join(dir, 'outputs'),
          GITHUB_STEP_SUMMARY: join(dir, 'summary'),
          ...Object.fromEntries(
            Object.entries(defaults).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]),
          ),
          'INPUT_API-KEY': 'fake-model-key',
          'INPUT_GITHUB-TOKEN': 'fake-github-key',
          'INPUT_BASE-URL': `${base}/api/v1`,
          'INPUT_REASONING-EFFORT': 'high',
          'INPUT_REASONING-EXCLUDE': 'false',
          'INPUT_MAX-DIFF-BYTES': diffMode === 'normal' ? defaults['max-diff-bytes'] : '65536',
          INPUT_TEMPERATURE: '0',
        };
        const result = await exec(process.execPath, [join(dir, 'index.js')], {
          cwd: dir,
          env,
          timeout: 20_000,
        });
        assert.deepEqual(errors, []);
        // @actions/core writes platform-native line endings to GITHUB_OUTPUT.
        const outputs = (await readFile(join(dir, 'outputs'), 'utf8')).replace(/\r\n/g, '\n');
        if (diffMode !== 'normal') {
          assert.match(result.stdout, /Raw diff exceeds max-diff-bytes/);
          assert.equal(modelRequest, undefined);
          assert.equal(posted, undefined);
          assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
          assert.match(outputs, /skipped-reason<<[^\n]+\nRaw diff exceeds/);
          assert.match(outputs, /reviewed-sha<<[^\n]+\n\n/);
          return;
        }
        assert.match(result.stdout, /Review published/);
        assert.deepEqual(modelRequest?.reasoning, { effort: 'high', exclude: false });
        assert.equal(modelRequest?.temperature, 0);
        assert.equal(modelRequest?.stream, false);
        assert.doesNotMatch(JSON.stringify(modelRequest?.messages), /package-lock/);
        assert.equal(posted?.event, 'COMMENT');
        assert.equal(posted?.commit_id, 'HEAD');
        assert.match(String(posted?.body), /Found a potential issue/);
        assert.match(String(posted?.body), /Reasoning Details/);
        assert.match(outputs, /review-url<</);
        assert.match(outputs, /reviewed-sha<<[^\n]+\nHEAD\n/);
        assert.match(await readFile(join(dir, 'summary'), 'utf8'), /View review/);
        assert.equal(requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reviews')).length, 1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
