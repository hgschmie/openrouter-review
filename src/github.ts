import { getOctokit } from '@actions/github';
import type { Config } from './config.ts';
import { object } from './config.ts';
import { withRetries } from './http.ts';
import { readDiff } from './diff.ts';

export interface EventContext {
  eventName: string;
  payload: Record<string, unknown>;
  repo: { owner: string; repo: string };
}
export type Trigger = { number: number; expectedHead?: string; comment?: string; commentId?: number };
export type Selection = Trigger | { skip: string };

export function selectTrigger(context: EventContext, config: Config): Selection {
  const { eventName, payload } = context;
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    if (
      !['opened', 'reopened', 'synchronize', 'ready_for_review', 'labeled'].includes(String(payload.action))
    )
      return { skip: 'Unsupported pull request activity.' };
    const pr = payload.pull_request;
    if (!object(pr) || typeof pr.number !== 'number' || !object(pr.head) || typeof pr.head.sha !== 'string')
      throw new Error('Missing pull request number or head SHA in event.');
    return { number: pr.number, expectedHead: pr.head.sha };
  }
  if (eventName !== 'issue_comment')
    return { skip: 'This action requires a pull request or issue_comment event.' };
  if (payload.action !== 'created') return { skip: 'Only new comments trigger reviews.' };
  if (!object(payload.issue) || !object(payload.issue.pull_request))
    return { skip: 'Comment is not on a pull request.' };
  if (!config.watchMention) return { skip: 'Comment triggers are disabled.' };
  const comment = object(payload.comment) ? payload.comment : {};
  const author = object(comment.user) ? comment.user : {};
  const sender = object(payload.sender) ? payload.sender : {};
  if ([author, sender].some((user) => user.type === 'Bot' || String(user.login).endsWith('[bot]')))
    return { skip: 'Bot comments do not trigger reviews.' };
  if (!config.allowedAssociations.includes(String(comment.author_association)))
    return { skip: 'Comment author association is not allowed.' };
  const mention = config.watchMention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    typeof comment.body !== 'string' ||
    !new RegExp(`(^|[^A-Za-z0-9_-])${mention}([^A-Za-z0-9_-]|$)`).test(comment.body)
  )
    return { skip: 'Configured mention was not found.' };
  if (typeof payload.issue.number !== 'number' || typeof comment.id !== 'number')
    throw new Error('Missing PR number or comment ID in event.');
  return { number: payload.issue.number, comment: comment.body, commentId: comment.id };
}

export interface PullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  locked: boolean;
  state: string;
}
export interface PublishedReview {
  url: string;
  sha: string;
}
export interface PrClient {
  getPullRequest(): Promise<PullRequest>;
  getCommit(sha: string): Promise<{ sha: string; message: string }>;
  getDiff(): Promise<string>;
  findReview(marker: string, sha: string): Promise<PublishedReview | undefined>;
  publish(body: string, sha: string, marker: string): Promise<PublishedReview>;
}

export function createGitHub(
  config: Config,
  repo: EventContext['repo'],
  number: number,
  client = getOctokit(config.githubToken),
): PrClient {
  const params = { ...repo, pull_number: number };
  client.hook.wrap('request', async (request, options) => {
    const send = async () => {
      // Octokit's existing hooks share this options object; update it in place.
      options.request = { ...options.request, signal: AbortSignal.timeout(config.timeoutMs) };
      return request(options);
    };
    return options.method === 'GET' ? withRetries(send) : send();
  });
  const findReview: PrClient['findReview'] = async (marker, sha) => {
    for await (const { data } of client.paginate.iterator(client.rest.pulls.listReviews, {
      ...params,
      per_page: 100,
    })) {
      const review = data.find(
        (item) =>
          item.state === 'COMMENTED' &&
          item.commit_id === sha &&
          item.body.startsWith(`${marker}\n`) &&
          (item.user?.type === 'Bot' ||
            ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(item.author_association)),
      );
      if (review) return { url: review.html_url, sha };
    }
  };
  return {
    async getPullRequest() {
      const { data } = await client.rest.pulls.get(params);
      return {
        head: data.head.sha,
        base: data.base.sha,
        title: data.title,
        body: data.body ?? '',
        locked: data.locked,
        state: data.state,
      };
    },
    async getCommit(sha) {
      // The repository commit endpoint also returns file patches, which can be huge.
      const { data } = await client.rest.git.getCommit({ ...repo, commit_sha: sha });
      return { sha: data.sha, message: data.message };
    },
    async getDiff() {
      const { data, headers } = await client.rest.pulls.get({
        ...params,
        mediaType: { format: 'diff' },
        request: { parseSuccessResponseBody: false },
      });
      const body: unknown = data;
      if (!object(body) || typeof body.getReader !== 'function') {
        throw new Error('GitHub did not return a diff response stream.');
      }
      // Fetch decompresses the stream; a compressed Content-Length describes
      // different bytes. Always enforce the limit on the actual decoded chunks.
      const contentLength =
        !headers['content-encoding'] || headers['content-encoding'] === 'identity'
          ? headers['content-length']
          : undefined;
      return readDiff(body as unknown as ReadableStream<Uint8Array>, config.maxDiffBytes, contentLength);
    },
    findReview,
    async publish(body, sha, marker) {
      try {
        const { data } = await client.rest.pulls.createReview({
          ...params,
          body,
          commit_id: sha,
          event: 'COMMENT',
        });
        return { url: data.html_url, sha };
      } catch (error) {
        // A timed-out write may have succeeded. Reconcile once, without a second POST.
        const existing = await findReview(marker, sha).catch(() => undefined);
        if (existing) return existing;
        throw error;
      }
    },
  };
}
