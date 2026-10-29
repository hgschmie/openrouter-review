import { setTimeout } from 'node:timers/promises';
import { object } from './config.ts';

export class HttpError extends Error {
  status: number;
  retryAfterMs: number;
  constructor(message: string, status: number, retryAfter: string | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterDelay(retryAfter);
  }
}

function retryAfterDelay(value: string | null): number {
  if (!value) return 0;
  const delay = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

// Only retry known transient HTTP failures. An interrupted POST may already have
// been processed, so connection errors and timeouts are not blindly retried.
export async function withRetries<T>(
  operation: () => Promise<T>,
  wait: (ms: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!object(error)) throw error;
      const status = error.status;
      const response = object(error.response) ? error.response : {};
      const headers = object(response.headers) ? response.headers : {};
      const retryAfter =
        typeof error.retryAfterMs === 'number'
          ? error.retryAfterMs
          : retryAfterDelay(String(headers['retry-after'] ?? ''));
      const transient =
        status === 429 ||
        (typeof status === 'number' && status >= 500 && status <= 599) ||
        (status === 403 && retryAfter > 0);
      if (!transient || attempt >= 2 || retryAfter > 30_000) throw error;
      await wait(Math.max(retryAfter, 1000 * 2 ** attempt));
    }
  }
}
