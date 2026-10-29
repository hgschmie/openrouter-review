# OpenRouter Review

A TypeScript GitHub Action that sends a filtered pull request diff to OpenRouter and posts one Markdown review. Runs on GitHub's Node 24 runtime, with its dependencies bundled in `dist/`.

## Usage

Store your OpenRouter key as the repository secret `OPENROUTER_API_KEY`. After publishing this repository, replace `OWNER/openrouter-review@1.0.0` with its repository and release tag (or pinned commit SHA).

```yaml
name: Code review
on:
  pull_request_target:
    types: [opened, reopened, synchronize]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: openrouter-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: OWNER/openrouter-review@1.0.0
        with:
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
          model: deepseek/deepseek-v4-flash
          reasoning-effort: high
          reasoning-exclude: 'true'
```

The action reads changes through GitHub's API; a checkout step is unnecessary. This supports fork PRs with `pull_request_target` while keeping execution on trusted action code. Keep PR code out of this job. `contents: read` retrieves the exact head commit's message; `pull-requests: write` reads the PR and publishes its review. The configured model provider receives the filtered diff and any triggering comment.

The action also accepts `pull_request` events where the workflow has the required token permissions and model secret. The supported PR activities are `opened`, `reopened`, `synchronize`, `ready_for_review`, and `labeled`. To run only on a label, select `types: [labeled]` and add a job condition such as `if: github.event.label.name == 'ai review'`.

## Inputs

| Input                  | Default                                   | Meaning                                                                                       |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `api-key`              | Required                                  | OpenRouter API key, or the key for your configured endpoint.                                  |
| `github-token`         | `${{ github.token }}`                     | Token with the permissions above.                                                             |
| `base-url`             | `https://openrouter.ai/api/v1`            | Base URL; `/chat/completions` is appended.                                                    |
| `model`                | `deepseek/deepseek-v4-flash`              | Model ID accepted by the endpoint.                                                            |
| `sys-prompt`           | See below                                 | System message; accepts multiline text.                                                       |
| `user-prompt`          | See below                                 | Text preceding the diff; accepts multiline text.                                              |
| `temperature`          | Unset                                     | Number from 0 to 2.                                                                           |
| `max-tokens`           | Unset                                     | Maximum generated tokens, including reasoning on most providers.                              |
| `reasoning-effort`     | Unset                                     | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; support varies by model.       |
| `reasoning-enabled`    | Unset                                     | Explicit `true` or `false`.                                                                   |
| `reasoning-exclude`    | Unset                                     | `true` omits returned reasoning; it does not disable reasoning or its cost.                   |
| `reasoning-max-tokens` | Unset                                     | Positive reasoning token budget; use instead of `reasoning-effort`.                           |
| `request-options`      | `{}`                                      | JSON object of additional request parameters.                                                 |
| `include-patterns`     | Empty (all files)                         | Comma or newline separated file globs.                                                        |
| `exclude-patterns`     | `pnpm-lock.yaml,package-lock.json,*.lock` | Comma or newline separated file globs. Set to `''` to disable.                                |
| `max-diff-chars`       | `100000`                                  | Maximum filtered diff size in Unicode code points; `0` disables this limit.                   |
| `max-diff-bytes`       | `20971520` (20 MiB)                       | Maximum raw diff download before filtering, measured in decompressed bytes. Must be positive. |
| `timeout-seconds`      | `180`                                     | Timeout per HTTP attempt, between 1 and 1800 seconds.                                         |
| `watch-mention`        | Empty (disabled)                          | Literal string that triggers a review in a new PR comment.                                    |
| `allowed-associations` | `OWNER,MEMBER,COLLABORATOR`               | Author associations permitted to trigger a review by comment.                                 |

Unset generation options are omitted from the request, allowing the provider's defaults to apply. Explicit `false` and `0` remain intact. Model-specific capabilities are validated by OpenRouter, rather than maintained in a local model catalog. A custom base URL must accept the same chat completion format; the action does not translate provider-specific APIs.

Named inputs override corresponding fields in `request-options`, including individual fields within `reasoning`. For example:

```yaml
with:
  api-key: ${{ secrets.OPENROUTER_API_KEY }}
  reasoning-effort: high
  reasoning-exclude: 'true'
  max-tokens: '12000'
  request-options: |
    {
      "top_p": 0.9,
      "seed": 42,
      "provider": {
        "require_parameters": true,
        "allow_fallbacks": false
      }
    }
```

The action owns `model`, `messages`, `prompt`, `stream`, `stream_options`, `n`, and tool/function-calling fields; setting these through `request-options` is rejected. The request always uses `stream: false`. Set either `max_tokens` or `max_completion_tokens`, not both. A reasoning budget must be smaller than the configured output limit. Contradictory reasoning controls fail before contacting either API.

See OpenRouter's [request parameters](https://openrouter.ai/docs/api_reference/parameters), [reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), and [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection). Not all providers enforce every parameter; `provider.require_parameters` can restrict routing to providers that support the requested parameters.

## Prompts

The defaults match the `sys-prompt` and `user-prompt` inputs of [DeepSeek Review](https://github.com/hgschmie/github-deepseek-review).

Default system prompt:

> You are a professional code review assistant responsible for analyzing code changes in GitHub Pull Requests. Identify potential issues such as code style violations, logical errors, security vulnerabilities, and provide improvement suggestions. Clearly list the problems and recommendations in a concise manner.

Default user prompt:

> Please review the following code changes

The user message consists of the user prompt, a colon and newline, and the filtered diff. For comment triggers, the triggering comment is appended inside `<comment>` tags. These delimiters organize context; they do not guarantee that a model will ignore instructions embedded in code or comments. The model has no tools or execution access.

Override prompts directly in the workflow:

```yaml
with:
  api-key: ${{ secrets.OPENROUTER_API_KEY }}
  sys-prompt: |
    Review the changes for correctness and security.
    Prioritize actionable bugs. Explain each finding with file references.
  user-prompt: |
    Review this diff. Focus on behavior changes and missing error handling.
```

## Trigger by comment

Add `issue_comment: { types: [created] }` to the workflow's `on` section and set `watch-mention: '@review'`. Then comment `@review check the error handling` on a PR. The complete comment is sent as additional context.

Only the configured author associations may trigger a review. Bot authors/senders, comments on ordinary issues, edited comments, and partial matches such as `@review-other` are ignored. Associations are GitHub's relationship labels, not a fresh repository permission lookup. Each distinct qualifying comment can request another review; rerunning the same comment event deduplicates.

## Filtering and results

Patterns use standard [minimatch](https://github.com/isaacs/minimatch) globs. Patterns without a slash match basenames at any depth, so `*.lock` and `package-lock.json` also cover nested files. Dot directories are included. Use `src/**` to constrain a directory, or `**/*.ts` for TypeScript files at any depth. Exclusions win over inclusions. For renames, either path can match an inclusion and either path can trigger exclusion. Because commas separate patterns, use separate patterns instead of comma-containing brace expressions. `!` is treated literally; use `exclude-patterns` for exclusions.

Binary files are skipped. Text, rename-only and mode-only changes are preserved. A review is skipped if the PR is closed or locked, if `skip cr` or `skip review` appears in its title, body, or head commit message (case insensitive), or if a diff size limit is exceeded or the filtered diff is empty. This version reviews the whole filtered diff in one request and does not fetch additional repository context or split large diffs.

Two independent limits control diff size:

- `max-diff-bytes` bounds the raw download before file filtering. The action reads the response incrementally and cancels it when decompressed bytes exceed the limit, including chunked responses without a `Content-Length`. An oversized uncompressed `Content-Length` allows an earlier rejection. The default is 20 MiB. Excluded files still count toward this limit; increase it explicitly if needed, with a corresponding increase in memory usage. This limit cannot be disabled.
- `max-diff-chars` bounds the filtered review input in Unicode code points, not model tokens. Counting stops when the limit is exceeded without allocating an array of characters. Setting this input to `0` disables only the character limit; the raw download limit remains active.

Exceeding either limit skips the review successfully with a `skipped-reason` output. No partial diff is sent to the model, and no review is posted. Network errors and timeouts still fail the action. Only bounded diff bodies are assembled into strings. The head commit message is fetched through the Git commit-object endpoint, avoiding an additional download of its file patches.

The result is a formal `COMMENT` review on the captured commit, without inline comments, approval, or change requests. Returned reasoning is included in a collapsible section unless `reasoning-exclude: 'true'` is set. If reasoning would make the review too large, only that section is omitted with a note. An oversized final answer, an empty response, or a truncated completion fails rather than publishing a partial review. Findings do not fail the action; execution/API errors do.

The action rechecks both head and base commits before requesting the model and before posting. Automatic reviews are deduplicated by commit, base revision, filtered content, endpoint, and request settings. JSON key order does not change the fingerprint. Markers on reviews from bots or trusted collaborator associations are recognized. Preserve the hidden marker when editing a review. Manual deletion permits a new review.

Keep the per-PR concurrency group from the example: GitHub review creation has no atomic compare-and-post operation. The revision and duplicate checks reduce races, but cannot prevent every concurrent write or a push in the final interval before posting. A late write still carries the original commit SHA.

Transient HTTP failures (429, 5xx, or GitHub 403 with `Retry-After`) receive at most three attempts with exponential backoff. Delays honor `Retry-After` up to 30 seconds; longer delays fail for a later workflow retry. Model connection errors/timeouts are not retried because the request may already have been processed. Retryable model failures can still incur additional provider usage. Review POSTs are never blindly retried: a failed write is reconciled by looking for its marker. The workflow timeout bounds the entire job.

| Output           | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `review-url`     | New or already existing review URL; otherwise empty.                 |
| `reviewed-sha`   | Commit associated with a published/existing review; otherwise empty. |
| `skipped-reason` | Reason no new review was posted; empty on success.                   |

The job summary reports the outcome and links to the review. API keys are registered with GitHub's log masker; prompts, diffs and full model responses are not printed to logs.

## Development

Use Node 24 and npm:

```sh
npm ci
npm run build
npm run check
```

`check` type-checks, lints, runs the tests, and checks that `dist/` matches a fresh build. Tests use mocked responses and local HTTP servers; they require no secrets or paid API requests. Bundle tests copy the action to a temporary directory outside the source tree to verify that it runs without `node_modules`, including oversized chunked and gzip-compressed downloads. A memory regression test processes a 20 MiB diff under a 64 MiB JavaScript heap limit. CI runs these checks on Linux, macOS, and Windows.

Source modules cover configuration, diff filtering, GitHub operations, OpenRouter requests, HTTP retries, and orchestration. `src/index.ts` is the Actions entry point. The `dist/` files are generated, including bundled dependencies; edit `src/` and run `npm run build`.

This repository uses Semantic Versioning: `MAJOR.MINOR.PATCH`. Breaking changes to the action's inputs, outputs, or supported behavior require a major release; backward-compatible features increment the minor version, and backward-compatible fixes increment the patch version.

To release, update the version in `package.json` and `package-lock.json`, commit the tested sources, lockfile and generated `dist/` files, then create an annotated version tag without a `v` prefix (for example `1.0.0`). Publish the commit and tag when ready. Released version tags are immutable. No npm publication is needed.

----

## License

Copyright (C) 2026 Henning Schmiedehausen. Licensed under the [Apache License 2.0](LICENSE).

Prompt defaults and selected behavior are adapted from [hustcer/deepseek-review](https://github.com/hustcer/deepseek-review) which is under MIT license, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Developed use AI tools. If you object to the use of AI tooling for software development, you are free to not use this action.
