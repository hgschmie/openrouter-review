import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { bundledLicenses } from './licenses.mjs';

const target = process.argv[2] || `bun-${process.platform}-${process.arch}`;
if (!/^bun-(darwin|linux|windows|win32)-(arm64|x64)$/.test(target))
  throw new Error('Unsupported compile target.');
const normalized = target.replace('win32', 'windows');
const name = `or-review-${normalized.slice(4)}`;
const directory = resolve('artifacts', name);
const executable = `${directory}/or-review${normalized.includes('windows') ? '.exe' : ''}`;
await mkdir(directory, { recursive: true });
const result = await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'artifacts/cli.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  metafile: true,
  legalComments: 'none',
});
const bun = resolve('node_modules/bun/bin/bun.exe');
execFileSync(
  bun,
  [
    'build',
    '--compile',
    `--target=${normalized}`,
    '--env=disable',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--no-compile-autoload-tsconfig',
    '--no-compile-autoload-package-json',
    'artifacts/cli.cjs',
    '--outfile',
    executable,
  ],
  { stdio: 'inherit' },
);
await copyFile('LICENSE', `${directory}/LICENSE`);
// Keep the bundled application available for rebuilding with a modified Bun runtime.
await copyFile('artifacts/cli.cjs', `${directory}/cli.cjs`);
await writeFile(
  `${directory}/REBUILD.txt`,
  `or-review is Apache-2.0 licensed. Runtime and dependency notices are in licenses.txt.
The standalone executable is the only file needed to run or-review.
cli.cjs is the bundled application source, included for rebuilding with a modified runtime.
Application source: https://github.com/hgschmie/openrouter-review
Bun source: https://github.com/oven-sh/bun/tree/bun-v1.4.4
See Bun's license notices for its JavaScriptCore source and rebuild instructions.
With a locally rebuilt Bun, repackage the application using:
  bun build --compile --compile-executable-path=/path/to/rebuilt/bun --no-compile-autoload-dotenv --no-compile-autoload-bunfig cli.cjs --outfile or-review
`,
);
await writeFile(
  `${directory}/licenses.txt`,
  (await bundledLicenses(result.metafile)) +
    '\nBun 1.4.4 runtime (https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md)\n' +
    (await readFile('scripts/licenses/bun.txt', 'utf8')),
);
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const archive = resolve('artifacts', `${name}-v${version}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', directory, '.'], { stdio: 'inherit' });
const hash = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex');
await writeFile(`${archive}.sha256`, `${hash}  ${name}-v${version}.tar.gz\n`);
console.log(`Executable: ${executable}\nArchive: ${archive}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `executable=${executable}\n`);
