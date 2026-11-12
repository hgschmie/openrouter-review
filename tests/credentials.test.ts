import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialPath, endpoint, loadCredentials, saveCredentials } from '../src/credentials.ts';

test('login saves and replaces credentials outside the project with restricted permissions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'or-review-auth-'));
  const previous = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  process.env.XDG_CONFIG_HOME = directory;
  process.env.APPDATA = directory;
  delete process.env.OPENROUTER_API_KEY;
  const path = await saveCredentials('first-key', 'https://openrouter.ai/api/v1/');
  assert.equal(path, credentialPath());
  assert.deepEqual(await loadCredentials(), { apiKey: 'first-key', baseUrl: 'https://openrouter.ai/api/v1' });
  await saveCredentials('replacement-key', 'http://127.0.0.1:8080/v1');
  assert.equal((await loadCredentials()).apiKey, 'replacement-key');
  assert.doesNotMatch(await readFile(path, 'utf8'), /first-key/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await assert.rejects(loadCredentials(), /permissions are too broad/);
    await chmod(path, 0o600);
  }
  process.env.OPENROUTER_API_KEY = 'environment-key';
  assert.equal((await loadCredentials()).apiKey, 'environment-key');
  process.env.OPENROUTER_API_KEY = '';
  await assert.rejects(loadCredentials(), /empty or invalid/);
  delete process.env.OPENROUTER_API_KEY;
  const project = join(directory, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  process.env.XDG_CONFIG_HOME = project;
  process.env.APPDATA = project;
  await assert.rejects(saveCredentials('never-write', 'https://openrouter.ai/api/v1'), /outside any Git/);
  await assert.rejects(readFile(credentialPath()), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    const linked = join(directory, 'linked');
    await symlink(project, linked, 'dir');
    process.env.XDG_CONFIG_HOME = linked;
    await assert.rejects(saveCredentials('never-write', 'https://openrouter.ai/api/v1'), /outside any Git/);
  }
});

test('credential endpoints require HTTPS except for local loopback development', () => {
  for (const value of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com?key=x',
    'file:///tmp/key',
  ])
    assert.throws(() => endpoint(value));
  assert.equal(endpoint('http://localhost:8080/v1/'), 'http://localhost:8080/v1');
});
