# This repository's code review workflow

[The workflow](../.github/workflows/code-review.yml) reviews pull requests targeting
`main`, using the same prompts, reasoning budget, output limit, and timeout as the
EmmyLua review workflow.

## Who can request a review

- PRs authored by `hgschmie` are reviewed automatically on opening, reopening,
  pushes, and becoming ready for review, when the triggering user is also
  `hgschmie`.
- For every other author, `hgschmie` must post a new PR conversation comment
  containing exactly `@code-review`. This explicitly approves one review request.
  The same command can request another review on an owner-authored PR.
- Outside contributors, bots, and other collaborators cannot authorize reviews.
  Being a previous contributor or having a label is not approval. The trusted
  identity is deliberately restricted to `hgschmie`; extending it requires a
  workflow change.

Comments on ordinary issues, edited comments, drafts, closed or locked PRs, and
PRs targeting other branches do not run the reviewer. A denied event does not
receive the OpenRouter key or make a model request.

Approval requests a review of the current PR revision when the action starts;
it is not an approval of a particular commit SHA. New commits to an outside PR
do not automatically receive another review: post a fresh `@code-review` comment
when ready. A queued or manually rerun approved workflow can see a newer head,
so check the logged revision and the commit attached to the published review.
The action checks for a changed head before publishing. Reviews on the same PR
are serialized without cancelling an in-progress model request.

## Setup

1. Merge the workflow into `main`. In particular, comment triggers require the
   workflow to exist on the default branch; this PR does not activate it.
2. Add the repository Actions secret `OPENROUTER_API_KEY`.
3. Optionally set the Actions variable `DEEPSEEK_REVIEW_MODEL` to an OpenRouter
   model ID. Without it, the workflow uses `deepseek/deepseek-v4-flash`.
4. Ensure repository Actions policies permit the two pinned actions and
   `pull_request_target`. GitHub's default policy for affected public repositories
   is currently evaluated and is scheduled for enforcement on December 2, 2026;
   see [GitHub's event policy documentation](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target#default-policy-for-pull_request_target).

The output budget is 131,072 tokens, including up to 8,192 reasoning tokens;
the provider/model must support those settings and sufficient credit must be
available. As in the EmmyLua workflow, the filtered character limit is disabled
(`max-diff-chars: 0`), while the action's 20 MiB raw download limit still applies.
Approval permits sending the filtered diff to OpenRouter and its selected model
provider; see the [privacy notice](../PRIVACY.md).

## Execution boundary

The privileged workflow runs trusted workflow code and commit-pinned releases of
`actions/github-script` and `hgschmie/openrouter-review`. It does not check out,
build, install dependencies from, or execute PR code. The authorization script
reads event fields through `context`, without interpolating contributor text
into executable code. Only the authorized review step receives the model key.
GitHub token permissions are limited to `contents: read` and
`pull-requests: write`.

Keep the reviewer pinned to a released commit rather than `./` or a PR head.
Changes to this action in a PR are reviewed by the released action, not executed
with credentials. GitHub's ordinary approval of fork CI runs is separate from
the owner-comment approval used here.
