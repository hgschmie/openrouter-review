# Privacy and data handling

Updated: October 29, 2026. This notice describes the current source of OpenRouter Review. Review the version you deploy and the policies of the services you select.

OpenRouter Review is maintained by Henning Schmiedehausen. It runs inside your GitHub Actions runner and uses your credentials. The maintainer does not operate an inference backend for this action. The action contains no maintainer telemetry, analytics service, or separate database. The maintainer receives information you choose to submit by [filing a GitHub issue](https://github.com/hgschmie/openrouter-review/issues/new/choose). These reports are public; see [support and reporting](SUPPORT.md) before submitting information.

## What is processed and where it goes

| Data                                                                        | Purpose and destination                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub event payload and repository/PR identifiers                          | Read in the runner to select the PR, check comment eligibility, and locate GitHub resources. GitHub supplies the workflow event.                                                                                             |
| PR title, body, state, revisions, head commit message, and existing reviews | Retrieved from GitHub to check skip instructions, detect changed commits, and avoid duplicate reviews. These fields are not separately added to the model prompt.                                                            |
| Raw PR diff                                                                 | Downloaded from GitHub into runner memory, subject to `max-diff-bytes`, then filtered. Excluded and binary files are not included in the model's diff, but can be present in the raw download.                               |
| Filtered diff, system/user prompts, and complete triggering comment         | Sent to `base-url` with the selected model and generation options to produce the review. The default endpoint is OpenRouter, which routes requests to model providers. Custom endpoints receive this data instead.           |
| Additional `request-options`                                                | Forwarded to the configured API, except reserved fields. Identifiers or metadata you include there are also disclosed to that service. Provider-side plugins or integrations you enable may introduce additional recipients. |
| Review text and optional returned reasoning                                 | Sent to GitHub as a PR review tied to the captured commit. Anyone with access to that PR may read it. A model can reproduce content from its input.                                                                          |
| Status, review URL, reviewed commit SHA, and errors                         | Written to action outputs, workflow logs, and the job summary. These follow the repository's access and retention settings.                                                                                                  |

The action uses the GitHub token with GitHub's API and the model API key with the configured model endpoint. It does not deliberately include either credential in model prompts or review bodies. Both are registered with GitHub's log masker. This does not redact arbitrary secrets or personal data inside a diff, comment, provider error, or model response.

The action does not intentionally print prompts, diffs, or full model responses to logs. Provider and GitHub error messages may appear in logs and can contain information from a request. Inspect logs before sharing them. The default endpoints use HTTPS; use HTTPS for remote custom endpoints too. HTTP is supported for local testing and does not protect credentials or content in transit.

## Retention, training, and processing locations

The action assembles review inputs in process memory and does not deliberately save a separate copy of the diff or model response to disk. GitHub event files, logs, summaries, review comments, runner diagnostics, swap, and backups are outside that statement. Runner disposal and cleanup depend on your GitHub-hosted or self-hosted environment; terminating a process is not a secure-erasure guarantee.

GitHub retains the review and workflow records according to its services and your repository settings. OpenRouter, the selected model provider, and any custom endpoint have their own rules for retention, training, access, processing countries, and legal preservation. This action does not promise zero retention, prohibit provider training by itself, or enforce a processing country. Confirm those requirements against your selected endpoint, routing configuration, account settings, and contracts before sending data. See [OpenRouter's privacy policy](https://openrouter.ai/privacy), [data collection documentation](https://openrouter.ai/docs/guides/privacy/data-collection), and [provider logging documentation](https://openrouter.ai/docs/guides/privacy/provider-logging). Review [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) for its handling of GitHub-hosted information.

The maintainer uses information voluntarily submitted in GitHub issues to investigate, respond, and maintain the action. Reports remain visible on GitHub unless removed using GitHub's controls. Do not include sensitive information in an issue or its attachments.

## Your choices and requests

Before enabling the action, obtain authorization to send the repository content and contributors' information to the chosen services, and provide any required notices or consent process. Installing a workflow does not establish consent from every person whose information appears in its input.

Use `include-patterns` and `exclude-patterns` to narrow files, leave `watch-mention` unset to avoid sending comments, or disable the workflow to stop future requests. File filters do not filter comment text or custom prompts and are not secret scanners. Setting `reasoning-exclude: true` suppresses returned reasoning; it does not prevent providers from computing or processing it. Change endpoint/model/routing settings if the current recipients do not meet your requirements.

For removal of a posted review or workflow record, contact the target repository administrator. For provider-side data requests, contact the provider or the account holder who made the request. The action maintainer cannot access or delete records in your runner, repository, or provider account merely because you use this action.

For access, correction, or deletion requests concerning a report sent to the maintainer, [file a GitHub issue](https://github.com/hgschmie/openrouter-review/issues/new/choose). Include only the report identifier and a description of your request that is safe to share publicly. Do not repeat the private data you want removed. [Support and reporting](SUPPORT.md) describes the available channels.
