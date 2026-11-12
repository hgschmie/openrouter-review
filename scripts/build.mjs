import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { bundledLicenses } from './licenses.mjs';

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'linked',
  metafile: true,
  write: false,
});
const artifacts = new Map(
  result.outputFiles.map((file) => [relative(process.cwd(), file.path), file.contents]),
);
artifacts.set('dist/package.json', Buffer.from('{"type":"commonjs"}\n'));
// Include each bundled package's full license, not only comments in its JS.
artifacts.set('dist/licenses.txt', Buffer.from(await bundledLicenses(result.metafile)));
for (const [path, content] of artifacts) {
  if (process.argv.includes('--check')) {
    const actual = await readFile(path).catch(() => Buffer.alloc(0));
    if (!actual.equals(Buffer.from(content))) throw new Error(`${path} is stale; run npm run build`);
  } else {
    await mkdir('dist', { recursive: true });
    await writeFile(path, content);
  }
}
