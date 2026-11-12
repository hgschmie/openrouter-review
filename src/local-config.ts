import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { defaults, object, readReviewConfig } from './config.ts';

export const settingNames = [
  'model',
  'sys-prompt',
  'user-prompt',
  'temperature',
  'max-tokens',
  'reasoning-effort',
  'reasoning-enabled',
  'reasoning-exclude',
  'reasoning-max-tokens',
  'request-options',
  'include-patterns',
  'exclude-patterns',
  'max-diff-chars',
  'max-diff-bytes',
  'timeout-seconds',
] as const;
const booleans = new Set(['reasoning-enabled', 'reasoning-exclude']);
const numbers = new Set([
  'temperature',
  'max-tokens',
  'reasoning-max-tokens',
  'max-diff-chars',
  'max-diff-bytes',
  'timeout-seconds',
]);

export function parseProjectConfig(source: string): Record<string, string> {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid .or-review YAML (check syntax and duplicate keys).');
  const data: unknown = document.toJS({ maxAliasCount: 20 }) ?? {};
  if (!object(data)) throw new Error('.or-review must be a YAML mapping.');
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'base' && !settingNames.some((name) => name === key))
      throw new Error(
        `Unsupported .or-review setting: ${key}. Credentials and base-url belong in user configuration.`,
      );
    if (key === 'request-options') {
      if (!object(value)) throw new Error('request-options must be a YAML mapping.');
      result[key] = JSON.stringify(value);
    } else if (key.endsWith('-patterns') && Array.isArray(value)) {
      if (!value.every((item) => typeof item === 'string')) throw new Error(`${key} must contain strings.`);
      result[key] = value.join('\n');
    } else {
      const expected = booleans.has(key) ? 'boolean' : numbers.has(key) ? 'number' : 'string';
      if (typeof value !== expected) throw new Error(`${key} must be a YAML ${expected}.`);
      result[key] = String(value);
    }
  }
  return result;
}

export async function projectConfig(root: string): Promise<Record<string, string>> {
  try {
    const text = await readFile(join(root, '.or-review'), 'utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('.or-review exceeds 256 KiB.');
    return parseProjectConfig(text);
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

export function localConfig(
  values: Record<string, string>,
  apiKey: string,
  baseUrl: string,
  notice?: (text: string) => void,
) {
  const inputs: Record<string, string> = { ...defaults, ...values, 'api-key': apiKey, 'base-url': baseUrl };
  return readReviewConfig((name) => inputs[name] ?? '', notice);
}

export async function initConfig(root: string): Promise<void> {
  await writeFile(
    join(root, '.or-review'),
    `# Project settings; never put credentials in this file.
# Omitted settings use the same defaults as the GitHub action.
# base: origin/main
# model: ${defaults.model}
# reasoning-enabled: true
# reasoning-exclude: true
# reasoning-max-tokens: 8192
# max-tokens: 24000
# user-prompt: |
#   Review these changes in English. Focus on correctness and security.
# exclude-patterns:
#   - package-lock.json
#   - "*.lock"
`,
    { flag: 'wx' },
  );
}
