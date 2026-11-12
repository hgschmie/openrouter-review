# Local reviews with or-review

`or-review` sends a local Git diff to OpenRouter and prints an AI-generated Markdown
review. It shares request validation, prompts, filtering, retries, size limits,
and token reporting with the GitHub Action. It does not publish to GitHub or
require GitHub authentication. Git must be installed.

## Installation and builds

The CLI is a single Bun-compiled executable for each OS/architecture. The CI
workflow builds and tests native executables on Linux, macOS, and Windows and
uploads archives with SHA-256 checksums. These are CI artifacts until a maintainer
attaches them to a GitHub release; this change does not publish a release.

Extract the appropriate archive and put `or-review` (or `or-review.exe`) on your
`PATH`. For example, on macOS/Linux:

```sh
mkdir -p ~/.local/bin
install -m 755 or-review ~/.local/bin/or-review
```

Ensure `~/.local/bin` is on your `PATH`. Keep the accompanying license notices.
Only the executable is needed at runtime; no Node, Bun, or npm installation is
required. Archives also contain bundled application source and rebuilding
instructions for using a modified Bun runtime. Release binaries are not yet
Developer ID/notarization or Windows Authenticode signed.

To build from this repository, use Node 24 and npm:

```sh
npm ci
npm run build:cli
# Optional cross-compilation:
npm run build:cli -- bun-linux-x64
npm run build:cli -- bun-darwin-arm64
npm run build:cli -- bun-windows-x64
```

Bun is a pinned development dependency, not a runtime prerequisite. Executables
are placed in `artifacts/or-review-<os>-<arch>/`; versioned `.tar.gz` archives and
their `.sha256` files are placed in `artifacts/`. Supported build targets are
Linux, macOS, and Windows, each with `x64` and `arm64`. Cross-compilation builds
an artifact; native CI is what tests its behavior. After validation, maintainers
can attach the archives and checksums to the corresponding `v`-prefixed release.

## Credentials

```sh
or-review auth login
```

The hidden prompt stores the key and endpoint in user configuration:

- macOS/Linux: `$XDG_CONFIG_HOME/or-review/credentials.json`, defaulting to
  `~/.config/or-review/credentials.json`.
- Windows: `%APPDATA%\or-review\credentials.json`.

Login restricts the directory/file to the current user (0700/0600 on Unix;
user-only inherited access for newly written files on Windows). Storage is
plaintext protected by filesystem permissions, not encrypted keychain storage.
The CLI rejects credential files in Git working trees, including paths redirected
there by symlinks. It refuses Unix credential files with group/other access.
Run login again to replace credentials; delete the credential file to remove them.

`OPENROUTER_API_KEY` overrides the stored key for automation. An empty override is
an error. Keys cannot be supplied as command-line arguments or through `.or-review`.
The executable does not automatically load `.env`, `bunfig.toml`, or project code.

Configure an alternative endpoint explicitly at user level:

```sh
or-review auth login --base-url https://your-provider.example/api/v1
```

HTTPS is required except for loopback development endpoints. A project's
`.or-review` cannot change the endpoint, preventing it from redirecting a saved
key to another server. Logging in without `--base-url` selects OpenRouter again.

## Choosing changes

```sh
or-review                            # Committed branch changes
or-review --base origin/main         # Explicit comparison base
or-review --staged                    # Index changes against HEAD
or-review --working-tree              # Tracked staged + unstaged changes against HEAD
or-review --dry-run                   # Inspect settings, revision, files and size
or-review > review.md                 # Save Markdown; progress remains on stderr
```

Run from anywhere inside the working tree. The repository must have an initial
commit and no unresolved merge conflicts. Branch mode compares the merge-base
of the selected base and `HEAD` to `HEAD`, excluding uncommitted changes. The base
comes from `--base`, then `.or-review`, then the local `origin/HEAD` symbolic ref.
An unknown base produces an error rather than guessing. No fetch occurs; update
remote-tracking refs yourself when needed.

`--base`, `--staged`, and `--working-tree` are mutually exclusive. Untracked files
are excluded; stage new files to include them. Git external diff helpers and
text-conversion commands are disabled. Each run identifies its revision and the
SHA-256 of the captured filtered diff, including for uncommitted changes.

The review goes to stdout, while progress, errors, and the token summary go to
stderr. Dry runs print JSON with effective noncredential settings and never make
a model request. Empty filtered diffs succeed without a model request. Invalid
configuration, Git/API failures, and exceeded limits exit nonzero; model findings
alone do not. Local output is not subject to GitHub's review-comment size limit.

## Project configuration

`or-review init` creates a commented `.or-review` at the Git root and refuses to
overwrite an existing file. This YAML file is intended to be committed:

```yaml
base: origin/main
model: deepseek/deepseek-v4-flash
reasoning-enabled: true
reasoning-exclude: true
reasoning-max-tokens: 8192
max-tokens: 24000
max-diff-chars: 100000
max-diff-bytes: 20971520
timeout-seconds: 180
exclude-patterns:
  - package-lock.json
  - '*.lock'
user-prompt: |
  Review these changes in English.
  Focus on correctness, security, and significant maintainability problems.
request-options:
  top_p: 0.9
```

Supported shared settings are `model`, `sys-prompt`, `user-prompt`, `temperature`,
`max-tokens`, all four `reasoning-*` inputs, `request-options`, `include-patterns`,
`exclude-patterns`, `max-diff-chars`, `max-diff-bytes`, and `timeout-seconds`.
`base` is local-only. See the [action input reference](../README.md#inputs) for
defaults and reasoning precedence. Omitted prompts retain the action's defaults.

Use real YAML numbers and booleans, a mapping for `request-options`, and either
lists or comma/newline-separated strings for patterns. An empty exclusion list
removes the default lockfile exclusions. Duplicate and unknown keys are errors.
GitHub-specific token, mention, and association settings are not accepted.

Command-line options override project settings; omitted values use the action's
defaults. Named options override the corresponding `request-options` fields.
Boolean overrides take explicit values:

```sh
or-review --staged --model another/model --reasoning-enabled false
or-review --base main --request-options '{"top_p":0.8}'
```

Filtered changes and prompts are transmitted to the configured provider when you
run a review, including local changes that have never been pushed. Dry runs are
useful for inspecting the selected file list first. See the [privacy notice](../PRIVACY.md).
