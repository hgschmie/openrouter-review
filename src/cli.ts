import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { defaults } from './config.ts';
import { settingNames, initConfig, projectConfig, localConfig } from './local-config.ts';
import { credentialPath, loadCredentials, saveCredentials } from './credentials.ts';
import { repositoryRoot, localDiff } from './local-git.ts';
import { diffFiles, exceedsCharLimit, filterDiff } from './diff.ts';
import { buildRequest, completeReview } from './openrouter.ts';
import metadata from '../package.json' with { type: 'json' };

const help = `Usage: or-review [options]
       or-review init
       or-review auth login [--base-url URL]

Review committed branch changes against the merge-base with the configured base.
  --base REF          Override base (otherwise .or-review or local origin/HEAD)
  --staged            Review staged changes against HEAD
  --working-tree      Review tracked staged and unstaged changes against HEAD
  --dry-run           Print revision, files, size and settings without calling the API
  --help              Show this help
  --version           Show version

Generation settings can be overridden with --model, --sys-prompt, --user-prompt,
--temperature, --max-tokens, --reasoning-effort, --reasoning-enabled true|false,
--reasoning-exclude true|false, --reasoning-max-tokens, --request-options JSON,
--include-patterns, --exclude-patterns, --max-diff-chars, --max-diff-bytes,
and --timeout-seconds. Separate patterns with commas or newlines.

Configuration: .or-review at the Git root (YAML). Credentials: ${credentialPath()}
OPENROUTER_API_KEY overrides the stored key. Project .env files are not loaded.
Review Markdown goes to stdout; progress and token usage go to stderr.
`;

async function hiddenKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error('auth login requires an interactive terminal. Use OPENROUTER_API_KEY for automation.');
  process.stderr.write('OpenRouter API key (hidden): ');
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') {
          finish(new Error('Login cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
        if (value.length > 8192) {
          finish(new Error('API key is too long.'));
          return;
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

let secret = process.env.OPENROUTER_API_KEY;
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      ...Object.fromEntries(settingNames.map((name) => [name, { type: 'string' as const }])),
      base: { type: 'string' },
      'base-url': { type: 'string' },
      staged: { type: 'boolean' },
      'working-tree': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    process.stdout.write(`or-review ${metadata.version}\n`);
    return;
  }
  if (positionals.join(' ') === 'auth login') {
    if (Object.keys(values).some((key) => key !== 'base-url'))
      throw new Error('auth login only accepts --base-url.');
    secret = await hiddenKey();
    const path = await saveCredentials(secret, String(values['base-url'] || defaults['base-url']));
    process.stderr.write(`Credentials saved to ${path}\n`);
    return;
  }
  if (values['base-url'] !== undefined)
    throw new Error('Configure endpoints with or-review auth login --base-url URL.');
  const root = await repositoryRoot(process.cwd());
  if (positionals.join(' ') === 'init') {
    if (Object.keys(values).length) throw new Error('init does not accept review options.');
    await initConfig(root);
    process.stderr.write(`Created ${root}/.or-review\n`);
    return;
  }
  if (positionals.length) throw new Error('Unknown command. Run or-review --help.');
  if (
    [values.base !== undefined, values.staged === true, values['working-tree'] === true].filter(Boolean)
      .length > 1
  )
    throw new Error('Choose only one of --base, --staged, or --working-tree.');
  const project = await projectConfig(root);
  const overrides = Object.fromEntries(
    Object.entries(values).filter(([key]) => settingNames.some((name) => name === key)),
  ) as Record<string, string>;
  const credentials = await loadCredentials();
  secret = credentials.apiKey;
  const config = localConfig(
    { ...project, ...overrides },
    secret || 'dry-run',
    credentials.baseUrl,
    (message) => process.stderr.write(`${message}\n`),
  );
  const mode = values.staged ? 'staged' : values['working-tree'] ? 'working-tree' : 'branch';
  const snapshot = await localDiff(
    root,
    mode,
    (values.base as string | undefined) ?? project.base,
    config.maxDiffBytes,
  );
  const diff = filterDiff(snapshot.diff, config.include, config.exclude);
  snapshot.diff = '';
  if (exceedsCharLimit(diff, config.maxDiffChars))
    throw new Error(
      `Filtered diff exceeds max-diff-chars (${config.maxDiffChars}). Adjust filters or the limit.`,
    );
  const hash = createHash('sha256').update(diff).digest('hex');
  process.stderr.write(`Reviewing ${snapshot.description}; filtered diff SHA-256 ${hash}\n`);
  if (values['dry-run']) {
    const { apiKey: _key, ...settings } = config;
    void _key;
    process.stdout.write(
      JSON.stringify(
        {
          revision: snapshot.description,
          diffSha256: hash,
          files: diffFiles(diff),
          bytes: Buffer.byteLength(diff),
          settings,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (!diff.trim()) {
    process.stderr.write('No reviewable changes remain after filtering.\n');
    return;
  }
  if (!secret) throw new Error('No API key. Run or-review auth login or set OPENROUTER_API_KEY.');
  let usage: string | undefined;
  try {
    const completion = await completeReview(
      config,
      buildRequest(config, diff),
      fetch,
      undefined,
      (message) => {
        usage = message;
      },
    );
    process.stdout.write(
      '> **AI-generated review**. Verify findings before applying changes.\n\n' + completion.review + '\n',
    );
    if (completion.reasoning)
      process.stdout.write(
        `\n<details>\n<summary>Reasoning Details</summary>\n\n${completion.reasoning}\n\n</details>\n`,
      );
  } finally {
    if (usage) process.stderr.write(`${usage}\n`);
  }
}

main().catch((error) => {
  let message = error instanceof Error ? error.message : 'Review failed.';
  if (secret) message = message.replaceAll(secret, '[REDACTED]');
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
