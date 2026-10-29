export const defaults = {
  'base-url': 'https://openrouter.ai/api/v1',
  model: 'deepseek/deepseek-v4-flash',
  'sys-prompt':
    'You are a professional code review assistant responsible for analyzing code changes in GitHub Pull Requests. Identify potential issues such as code style violations, logical errors, security vulnerabilities, and provide improvement suggestions. Clearly list the problems and recommendations in a concise manner.',
  'user-prompt':
    'Write all review explanations in English, regardless of the language used in the code or comments. Please review the following code changes',
  'request-options': '{}',
  'exclude-patterns': 'pnpm-lock.yaml,package-lock.json,*.lock',
  'max-diff-chars': '100000',
  'max-diff-bytes': '20971520',
  'timeout-seconds': '180',
  'allowed-associations': 'OWNER,MEMBER,COLLABORATOR',
};

export interface Config {
  apiKey: string;
  githubToken: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  options: Record<string, unknown>;
  include: string[];
  exclude: string[];
  maxDiffChars: number;
  maxDiffBytes: number;
  timeoutMs: number;
  watchMention: string;
  allowedAssociations: string[];
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function number(
  value: unknown,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
  integer = true,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

export function readConfig(getInput: (name: string) => string, notice?: (message: string) => void): Config {
  const input = (name: string) => getInput(name) || defaults[name as keyof typeof defaults] || '';
  const required = (name: string) => {
    const value = input(name).trim();
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const base = new URL(required('base-url'));
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error('base-url must be an HTTP(S) URL without credentials, query parameters, or a fragment.');
  }
  let options: unknown;
  try {
    options = JSON.parse(input('request-options'));
  } catch {
    throw new Error('request-options must be valid JSON.');
  }
  if (!object(options)) throw new Error('request-options must be a JSON object.');
  for (const key of [
    'model',
    'messages',
    'prompt',
    'stream',
    'stream_options',
    'tools',
    'tool_choice',
    'functions',
    'function_call',
    'n',
  ]) {
    if (key in options)
      throw new Error(
        `request-options cannot set ${key}; the action owns the review conversation and response mode.`,
      );
  }
  for (const [name, key] of [
    ['temperature', 'temperature'],
    ['max-tokens', 'max_tokens'],
  ] as const) {
    if (input(name).trim()) options[key] = Number(input(name));
  }
  if ('temperature' in options) number(options.temperature, 'temperature', 0, 2, false);
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (key in options) number(options[key], key, 1);
  }
  if ('max_tokens' in options && 'max_completion_tokens' in options)
    throw new Error('Set only one of max_tokens and max_completion_tokens.');
  const enabledInput = input('reasoning-enabled').trim();
  const enabled = enabledInput
    ? boolean(enabledInput, 'reasoning-enabled')
    : object(options.reasoning)
      ? options.reasoning.enabled
      : undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean')
    throw new Error('reasoning.enabled must be a JSON boolean.');
  let reasoning: Record<string, unknown>;
  if (enabled === false) {
    // Disabled reasoning ignores all other reasoning settings, including invalid values.
    reasoning = { enabled: false };
  } else {
    if ('reasoning' in options && !object(options.reasoning)) throw new Error('reasoning must be an object.');
    reasoning = { ...(options.reasoning as Record<string, unknown> | undefined) };
    if (enabled !== undefined) reasoning.enabled = enabled;
    for (const key of ['effort', 'exclude', 'max_tokens']) {
      const name = `reasoning-${key.replace('_', '-')}`;
      const value = input(name).trim();
      if (value)
        reasoning[key] =
          key === 'max_tokens' ? Number(value) : key === 'effort' ? value : boolean(value, name);
    }
    if ('max_tokens' in reasoning) {
      number(reasoning.max_tokens, 'reasoning-max-tokens', 1);
      delete reasoning.effort;
    }
    if (
      'effort' in reasoning &&
      (typeof reasoning.effort !== 'string' ||
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning.effort))
    ) {
      throw new Error('reasoning-effort must be none, minimal, low, medium, high, xhigh, or max.');
    }
    if ('exclude' in reasoning && typeof reasoning.exclude !== 'boolean')
      throw new Error('reasoning.exclude must be a JSON boolean.');
    const budget = options.max_tokens ?? options.max_completion_tokens;
    if (
      typeof budget === 'number' &&
      typeof reasoning.max_tokens === 'number' &&
      reasoning.max_tokens >= budget
    ) {
      throw new Error('The output token limit must exceed the reasoning token budget.');
    }
    if (reasoning.effort === 'none') {
      reasoning = { enabled: false };
      notice?.('reasoning disabled because effort is set to none');
    }
  }
  if (Object.keys(reasoning).length) options.reasoning = reasoning;
  else delete options.reasoning;
  const patterns = (name: string) =>
    input(name)
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
  // An explicitly empty exclude input removes the defaults, useful for lockfile reviews.
  const exclude = getInput('exclude-patterns');
  return {
    apiKey: required('api-key'),
    githubToken: required('github-token'),
    baseUrl: base.href.replace(/\/+$/, ''),
    model: required('model'),
    systemPrompt: input('sys-prompt'),
    userPrompt: input('user-prompt'),
    options,
    include: patterns('include-patterns'),
    exclude: exclude
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
    maxDiffChars: number(Number(input('max-diff-chars')), 'max-diff-chars', 0),
    maxDiffBytes: number(Number(input('max-diff-bytes')), 'max-diff-bytes', 1),
    timeoutMs: number(Number(input('timeout-seconds')), 'timeout-seconds', 1, 1800) * 1000,
    watchMention: input('watch-mention').trim(),
    allowedAssociations: patterns('allowed-associations'),
  };
}
