import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';

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
const packages = new Set(
  Object.keys(result.metafile.inputs)
    .map((path) => path.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1])
    .filter(Boolean),
);
const licenses = [];
for (const path of [...packages].sort()) {
  const meta = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
  const names = (await readdir(path))
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(name))
    .sort();
  if (!names.length) throw new Error(`Missing bundled license for ${meta.name}`);
  const contents = await Promise.all(names.map((name) => readFile(`${path}/${name}`, 'utf8')));
  licenses.push(`${meta.name}@${meta.version}\n${contents.join('\n').replace(/\r\n/g, '\n').trim()}`);
}
artifacts.set('dist/licenses.txt', Buffer.from(licenses.join('\n\n' + '='.repeat(72) + '\n\n') + '\n'));
for (const [path, content] of artifacts) {
  if (process.argv.includes('--check')) {
    const actual = await readFile(path).catch(() => Buffer.alloc(0));
    if (!actual.equals(Buffer.from(content))) throw new Error(`${path} is stale; run npm run build`);
  } else {
    await mkdir('dist', { recursive: true });
    await writeFile(path, content);
  }
}
