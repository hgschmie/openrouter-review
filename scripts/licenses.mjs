import { readFile, readdir } from 'node:fs/promises';

export async function bundledLicenses(metafile) {
  const packages = new Set(
    Object.keys(metafile.inputs)
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
  return licenses.join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
}
