import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { object, defaults } from './config.ts';

export function credentialPath(): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return resolve(base, 'or-review', 'credentials.json');
}

async function outsideRepository(directory: string): Promise<void> {
  // Check the real directory, including user configuration paths redirected by symlinks.
  let actual = await realpath(directory);
  for (;;) {
    const marker = await lstat(join(actual, '.git')).catch((error: unknown) => {
      if (object(error) && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (marker) throw new Error('Credentials must be stored outside any Git working tree.');
    const parent = dirname(actual);
    if (parent === actual) return;
    actual = parent;
  }
}

export function endpoint(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Endpoint must be an HTTP(S) URL without credentials, query parameters, or fragments.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Endpoints require HTTPS, except for local loopback servers.');
  return url.href.replace(/\/+$/, '');
}

export async function loadCredentials() {
  const path = credentialPath();
  let stored: Record<string, unknown> = {};
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Credentials must be a regular file, not a symlink.');
    await outsideRepository(dirname(path));
    if (process.platform !== 'win32' && stat.mode & 0o077)
      throw new Error(`Credential file permissions are too broad; run chmod 600 on ${path}.`);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('Cannot read credentials. Run or-review auth login again.');
    }
    if (!object(data)) throw new Error('Invalid credential file. Run or-review auth login again.');
    stored = data;
  } catch (error) {
    if (!object(error) || error.code !== 'ENOENT') throw error;
  }
  const key = process.env.OPENROUTER_API_KEY ?? stored['api-key'];
  if (key !== undefined && (typeof key !== 'string' || !key.trim()))
    throw new Error('The API key is empty or invalid.');
  const url = stored['base-url'] ?? defaults['base-url'];
  if (typeof url !== 'string') throw new Error('Invalid credential endpoint.');
  return { apiKey: typeof key === 'string' ? key.trim() : undefined, baseUrl: endpoint(url) };
}

export async function saveCredentials(apiKey: string, baseUrl: string): Promise<string> {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('API key must be a nonempty single line.');
  const url = endpoint(baseUrl);
  const path = credentialPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await outsideRepository(directory);
  if (process.platform === 'win32') {
    const execute = promisify(execFile);
    const { stdout } = await execute('whoami', ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new Error('Cannot identify the Windows user for credential permissions.');
    await execute('icacls', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  } else await chmod(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await file.writeFile(JSON.stringify({ 'api-key': apiKey.trim(), 'base-url': url }) + '\n');
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}
