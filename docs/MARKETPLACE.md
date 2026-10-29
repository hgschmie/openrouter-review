# Marketplace publication review

Prepared October 29, 2026 for maintainer review. This records implementation evidence and pending work; it does not assert Marketplace approval or acceptance of legal terms.

## Policy references

- [GitHub Marketplace Developer Agreement](https://docs.github.com/en/site-policy/github-terms/github-marketplace-developer-agreement): §3.4 covers testing AI output, identifying AI content, feedback to GitHub and the developer, and appropriate-use guidance. §§3.1 and 5.1 and the data protection addendum address data handling; §2.4 addresses end-user licensing.
- [Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace): repository, naming, metadata, agreement acceptance, release, and two-factor authentication requirements.
- [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies): requirements also apply to content the action posts.

The reviewed agreement does not prohibit AI-assisted source-code development. The action's generated reviews bring it within the generative-AI provisions. The maintainer remains responsible for the product and its listing.

## Evidence and review status

| Area              | Evidence in the proposed change                                                                                           | Remaining review                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI identification | Fixed notice before every newly generated review; format and bundle tests cover it.                                       | Inspect a rendered review from the candidate commit. Existing reviews are not rewritten.                                                                                                                                 |
| Feedback          | Visible maintainer/GitHub reporting links, an AI feedback issue form, and [support instructions](../SUPPORT.md).          | Confirm the [GitHub issue submission link](https://github.com/hgschmie/openrouter-review/issues/new/choose) and GitHub reporting links. Issues are public; the docs instruct users to omit sensitive details.            |
| Appropriate use   | README documents false positives, missed defects, prompt injection, untrusted output, human review, and operating limits. | Approve the wording and intended uses.                                                                                                                                                                                   |
| Privacy           | [Privacy notice](../PRIVACY.md) describes recipients, credentials, logs, retention limits, account choices, and requests. | Confirm the GitHub issue reporting and retention wording. Review applicable provider terms, processing locations, and required notices/consent for the intended deployment. No blanket provider-retention claim is made. |
| AI evaluation     | [Synthetic evaluation cases and results template](AI_EVALUATION.md).                                                      | Live-model evaluation is **pending**. Automated mocked responses do not replace it. Record actual evidence and resolve findings before publication.                                                                      |
| License           | Apache 2.0 [LICENSE](../LICENSE), upstream MIT notice, bundled dependency licenses.                                       | Confirm rights to the distributed material and use LICENSE as the linked end-user license terms.                                                                                                                         |
| Packaging         | Public action repository, one root `action.yml`, bundled Node 24 entry point, reproducible bundle check.                  | Confirm Marketplace name availability and metadata validation in the release interface.                                                                                                                                  |

## Publication steps after review

- [ ] Approve the source, docs, contact information, and privacy wording; complete and record the live evaluation.
- [ ] Run `npm run check` and review CI for the exact release commit.
- [ ] Choose the release version and ensure package metadata and the README example match. Do not move an existing release tag.
- [ ] Commit the reviewed source, docs, tests, and rebuilt `dist/` files; create and push a new annotated `vMAJOR.MINOR.PATCH` tag.
- [ ] The repository owner confirms two-factor authentication and reviews/accepts the Marketplace Developer Agreement if needed. Acceptance has not been verified or performed by this change.
- [ ] Draft a GitHub Release for that tag, select **Publish this Action to the GitHub Marketplace**, resolve name/metadata validation, and choose appropriate categories.
- [ ] Check the listing's description, support and privacy links, license, and release notes, then publish the reviewed release.

The issue form and disclosure links become useful to external users once the supporting files are on the repository's default branch. No repository settings, Marketplace terms, or published releases are changed by preparing these files.
