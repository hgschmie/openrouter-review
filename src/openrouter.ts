import type { Config } from './config.ts';
import { object } from './config.ts';
import { HttpError, withRetries } from './http.ts';

export function buildRequest(config: Config, diff: string, comment?: string): Record<string, unknown> {
  let content = `${config.userPrompt}:\n${diff}`;
  if (comment)
    content += `\n\nAdditional context from PR comment (enclosed in <comment> tags):\n<comment>\n${comment}\n</comment>`;
  return {
    ...config.options,
    model: config.model,
    stream: false,
    messages: [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content },
    ],
  };
}

export interface Completion {
  review: string;
  reasoning?: string;
}

export async function completeReview(
  config: Config,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  wait?: (ms: number) => Promise<unknown>,
): Promise<Completion> {
  return withRetries(async () => {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: 'error',
    });
    // Non-JSON error pages must still participate in status-based retries.
    const data: unknown = await response.json().catch(() => null);
    const apiError = object(data) && object(data.error) ? data.error : undefined;
    if (!response.ok || apiError) {
      const status = response.ok && typeof apiError?.code === 'number' ? apiError.code : response.status;
      const detail = typeof apiError?.message === 'string' ? `: ${apiError.message.slice(0, 500)}` : '';
      throw new HttpError(
        `Model request failed (HTTP ${status})${detail}`,
        status,
        response.headers.get('retry-after'),
      );
    }
    const choice: unknown = object(data) && Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!object(choice) || !object(choice.message))
      throw new Error('The model returned an invalid chat completion.');
    if (choice.finish_reason !== 'stop') {
      throw new Error(
        'The model did not finish a complete text review. Check the output token budget, content filters, and request options.',
      );
    }
    const review = choice.message.content;
    if (typeof review !== 'string' || !review.trim())
      throw new Error(
        'The model returned an empty review. Increase the output token budget if reasoning consumed it.',
      );
    const reasoning = choice.message.reasoning ?? choice.message.reasoning_content;
    const exclude = object(config.options.reasoning) && config.options.reasoning.exclude === true;
    return {
      review: review.trim(),
      reasoning: !exclude && typeof reasoning === 'string' ? reasoning.trim() : undefined,
    };
  }, wait);
}

export function formatReview(completion: Completion, marker: string): string {
  const body = `${marker}\n\n${completion.review}`;
  // Leave space below GitHub's comment limit; measure bytes conservatively for Unicode.
  if (Buffer.byteLength(body) > 60_000)
    throw new Error('The review is too large to publish. Lower max-tokens or request a more concise review.');
  if (!completion.reasoning) return body;
  const details = `\n\n<details>\n<summary>Reasoning Details</summary>\n\n${completion.reasoning}\n\n</details>`;
  return Buffer.byteLength(body + details) <= 60_000
    ? body + details
    : body + '\n\n_Reasoning omitted because it exceeds the review size limit._';
}
