# This repository's code review workflow

[The workflow](../.github/workflows/code-review.yml) reviews ready pull requests
targeting `main`, using the EmmyLua workflow's prompts and generation settings.

- PR authors with GitHub's `OWNER` or `MEMBER` association receive automatic
  reviews on opening, reopening, pushes, and becoming ready. For this personally
  owned repository, `OWNER` covers the repository owner; `MEMBER` covers members
  if the repository is moved to an organization, not a particular GitHub team.
- Approve an outside PR by adding the `code-review` label. GitHub restricts label
  application to users with [triage access or higher](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels).
  These users are trusted to authorize model requests. Ordinary outside
  contributors cannot apply the label themselves.
- Adding the label requests one review of that event's head revision. Leaving it
  attached does not approve later pushes. Remove and reapply it to request a
  review after an update, or once a draft is ready. Reserve this label for manual
  approval; do not have bots apply it automatically.

There is no comment command, custom authorization script, or checkout of PR code.
The commit-pinned released action reads the diff through GitHub's API and posts
its review on the captured commit. Closed or locked PRs and stale head revisions
are skipped by the action. GitHub's ordinary approval of fork CI runs is separate
from adding the review label.

## Setup

The `code-review` label is available. Merge the workflow into `main` to activate
it. The repository secret `OPENROUTER_API_KEY` and variable
`DEEPSEEK_REVIEW_MODEL` are already configured. The workflow falls back to
`deepseek/deepseek-v4-flash` if the model variable is unset.

Ensure Actions policies allow the pinned action and `pull_request_target`; see
[GitHub's event policy documentation](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target#default-policy-for-pull_request_target).
The workflow retains the reference's 8,192 reasoning tokens, 131,072 output-token
limit, disabled filtered-character limit, and 1,500-second HTTP timeout. The
20 MiB raw download limit still applies. Approval permits sending the filtered
diff to OpenRouter and its selected model provider; see the [privacy notice](../PRIVACY.md).
