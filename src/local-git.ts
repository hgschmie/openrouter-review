import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { readDiff } from './diff.ts';

const execute = promisify(execFile);
// Repository selection and diff helpers must not be changed by inherited Git overrides.
const gitEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const prefix = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=true'];

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', [...prefix, ...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  return stdout.trim();
}

export async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('Run or-review inside a Git working tree. Git must be installed.');
  }
}

export type DiffMode = 'branch' | 'staged' | 'working-tree';

export async function localDiff(root: string, mode: DiffMode, base: string | undefined, maxBytes: number) {
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (await git(root, ['ls-files', '--unmerged']))
    throw new Error('Resolve merge conflicts before reviewing.');
  let description = `${mode}, HEAD ${head}`;
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
  if (mode === 'branch') {
    if (!base) {
      try {
        base = await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
      } catch {
        throw new Error('Cannot determine the base branch. Set base in .or-review or pass --base.');
      }
    }
    const baseSha = await git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]);
    const mergeBase = await git(root, ['merge-base', baseSha, head]);
    args.push(mergeBase, head);
    description = `branch, base ${base} (${baseSha}), merge-base ${mergeBase}, head ${head}`;
  } else if (mode === 'staged') args.push('--cached', head);
  else args.push(head);
  args.push('--');
  const child = spawn('git', [...prefix, ...args], {
    cwd: root,
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(0, 4096);
  });
  const done = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code }));
  });
  try {
    const diff = await readDiff(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, maxBytes);
    const result = await done;
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`git diff failed: ${stderr}`);
    return { diff, description, head };
  } catch (error) {
    child.kill();
    await done;
    throw error;
  }
}
