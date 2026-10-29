import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { object } from './config.ts';
import { DiffTooLargeError, exceedsCharLimit, filterDiff } from './diff.ts';
import type { PrClient, PullRequest, Trigger } from './github.ts';
import { buildRequest, completeReview, formatReview } from './openrouter.ts';

export interface ReviewResult {
  reviewUrl?: string;
  reviewedSha?: string;
  skippedReason?: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function skipReason(pr: PullRequest): string | undefined {
  if (pr.state !== 'open') return 'Pull request is closed.';
  if (pr.locked) return 'Pull request conversation is locked.';
  if (/skip (?:cr|review)/i.test(`${pr.title}\n${pr.body}`))
    return 'Pull request requests skipping the review.';
}

export async function runReview(
  config: Config,
  trigger: Trigger,
  github: PrClient,
  complete = completeReview,
): Promise<ReviewResult> {
  const pr = await github.getPullRequest();
  const skip = skipReason(pr);
  if (skip) return { skippedReason: skip };
  if (trigger.expectedHead && trigger.expectedHead !== pr.head)
    return { skippedReason: 'Event refers to an outdated commit.' };
  const commit = await github.getCommit(pr.head);
  if (commit.sha !== pr.head) return { skippedReason: 'Pull request changed while reading its commits.' };
  if (/skip (?:cr|review)/i.test(commit.message))
    return { skippedReason: 'Head commit requests skipping the review.' };
  let raw: string;
  try {
    raw = await github.getDiff();
  } catch (error) {
    if (error instanceof DiffTooLargeError) return { skippedReason: error.message };
    throw error;
  }
  const diff = filterDiff(raw, config.include, config.exclude);
  raw = '';
  if (!diff.trim()) return { skippedReason: 'No reviewable changes remain after filtering.' };
  if (exceedsCharLimit(diff, config.maxDiffChars))
    return {
      skippedReason: `Filtered diff exceeds max-diff-chars (${config.maxDiffChars} characters).`,
    };
  const request = buildRequest(config, diff, trigger.comment);
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          base: pr.base,
          head: pr.head,
          url: config.baseUrl,
          request,
          commentId: trigger.commentId,
        }),
      ),
    )
    .digest('hex');
  const marker = `<!-- openrouter-review:v1:${hash} -->`;
  const duplicate = async (): Promise<ReviewResult | undefined> => {
    const review = await github.findReview(marker, pr.head);
    if (review)
      return {
        reviewUrl: review.url,
        reviewedSha: review.sha,
        skippedReason: 'This commit and configuration have already been reviewed.',
      };
  };
  const existing = await duplicate();
  if (existing) return existing;
  const current = await github.getPullRequest();
  if (current.head !== pr.head || current.base !== pr.base || skipReason(current))
    return { skippedReason: 'Pull request changed while fetching its diff.' };
  const completion = await complete(config, request);
  const body = formatReview(completion, marker);
  const latest = await github.getPullRequest();
  if (latest.head !== pr.head || latest.base !== pr.base || skipReason(latest))
    return { skippedReason: 'Pull request changed while generating the review; result was not posted.' };
  const concurrent = await duplicate();
  if (concurrent) return concurrent;
  const review = await github.publish(body, pr.head, marker);
  return { reviewUrl: review.url, reviewedSha: review.sha };
}
