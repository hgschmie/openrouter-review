import { defaults, readConfig } from '../src/config.ts';

export function config(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    ...defaults,
    'api-key': 'model-test-key',
    'github-token': 'github-test-key',
    ...overrides,
  };
  return readConfig((name) => values[name] ?? '');
}

export const patch = (path = 'src/main.ts') =>
  `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`;
export const completion = (content = 'A useful review.', extra = {}) => ({
  choices: [{ finish_reason: 'stop', message: { content, ...extra } }],
});
export const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
