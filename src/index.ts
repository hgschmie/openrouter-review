import * as core from '@actions/core';
import { context } from '@actions/github';
import { readConfig } from './config.ts';
import { createGitHub, selectTrigger } from './github.ts';
import { runReview } from './review.ts';

async function main(): Promise<void> {
  for (const name of ['api-key', 'github-token']) {
    const secret = core.getInput(name);
    if (secret) core.setSecret(secret);
  }
  const config = readConfig((name) => core.getInput(name, { trimWhitespace: false }), core.notice);
  const trigger = selectTrigger(context, config);
  const result =
    'skip' in trigger
      ? { skippedReason: trigger.skip }
      : await runReview(config, trigger, createGitHub(config, context.repo, trigger.number));
  core.setOutput('review-url', result.reviewUrl ?? '');
  core.setOutput('reviewed-sha', result.reviewedSha ?? '');
  core.setOutput('skipped-reason', result.skippedReason ?? '');
  if (result.skippedReason) core.notice(result.skippedReason);
  else core.info(`Review published: ${result.reviewUrl}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading('OpenRouter Review', 2)
      .addRaw(result.skippedReason ?? `Review published for commit ${result.reviewedSha}.`)
      .addEOL()
      .addRaw(result.reviewUrl ? `\n[View review](${result.reviewUrl})\n` : '')
      .write();
  }
}

main().catch((error) => core.setFailed(error instanceof Error ? error.message : 'Review failed.'));
