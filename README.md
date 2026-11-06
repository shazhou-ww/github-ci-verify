# github-ci-verify

Prove that the **latest GitHub Actions push run for a source SHA** completed
successfully, including one explicitly named job and step. Intended for CI
scripts; it does not run checks, wait for CI, publish packages, or enforce
release/version/tag policies.

The GitHub repository is `shazhou-ww/github-ci-verify`. The package and
executable are `github-ci-verify`.

## CLI

Requires Node.js >=22.13. After installing the package:

```sh
github-ci-verify \
  --repository owner/project \
  --sha 0123456789abcdef0123456789abcdef01234567 \
  --branch main \
  --workflow ci.yaml \
  --job-name 'Release verification (v1)' \
  --step-name 'Confirm required checks succeeded' \
  --json
```

`--job-name` and `--step-name` are required and match API `job.name` and
`step.name` **exactly**, including whitespace, case, and matrix suffixes. They
are not YAML IDs. A contract version carried in a job name (such as `v1`) is
independent of this tool's package version.

| Option            | Default / meaning                                                                   |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--repository`    | `GITHUB_REPOSITORY`, or required outside Actions                                    |
| `--sha`           | Actual checkout's `git rev-parse HEAD`; full lowercase 40-character SHA             |
| `--branch`        | `main` (branch name, not `refs/heads/main`)                                         |
| `--workflow`      | `ci.yaml`; workflow filename, not display name or numeric ID                        |
| `--job-name`      | Required exact display name                                                         |
| `--step-name`     | Required exact display name within that job                                         |
| `--api-url`       | `GITHUB_API_URL`, then `https://api.github.com`; GHES may use `https://host/api/v3` |
| `--json`          | Emit a single JSON object to stdout on success **or failure**                       |
| `--summary`       | Additionally append successful evidence to `GITHUB_STEP_SUMMARY`                    |
| `--help`, `-h`    | Help, used alone                                                                    |
| `--version`, `-v` | Package version, used alone                                                         |

Unknown options, positional arguments, duplicate options, and empty required
values fail. There is deliberately no `--token`, `--contract`, or `--step`.
Tokens come only from `GH_TOKEN`, falling back to `GITHUB_TOKEN`. Do not pass
secrets in command-line arguments. API URLs require HTTPS and forbid embedded
credentials, query strings, and fragments; HTTP is allowed only on loopback for
local testing. Requests reject redirects and time out after 30 seconds each.

### GitHub Actions

```yaml
permissions:
  contents: read
  actions: read

steps:
  # Install the package and check out the source before invoking.
  - name: Verify source CI evidence
    env:
      GH_TOKEN: ${{ github.token }}
    run: |
      github-ci-verify \
        --job-name 'Release verification (v1)' \
        --step-name 'Confirm required checks succeeded' \
        --json --summary
```

Use a token authorized for the target repository's Actions read API. A
fine-grained PAT needs **Actions: read**; classic tokens accessing private
repositories generally need `repo`. Organization/SSO policies still apply. The
default `GITHUB_TOKEN` may not access another repository. This tool cannot grant
access and treats 401/403/404 as errors.

The default SHA deliberately ignores `GITHUB_SHA`: on tag events that variable
may not identify the actual checkout. Pass `--sha` when Git is unavailable or
the desired source differs from HEAD. No checkout or environment is modified.

### Output

Success exits **0**, and all unmet evidence requirements or operational errors
exit **1**. Human output goes to stdout; failures go to stderr. JSON mode emits:

```json
{
  "ok": true,
  "repository": "owner/project",
  "branch": "main",
  "workflow": "ci.yaml",
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "runUrl": "https://github.com/owner/project/actions/runs/42",
  "runId": 42,
  "runAttempt": 2,
  "jobName": "Release verification (v1)",
  "stepName": "Confirm required checks succeeded"
}
```

Failure JSON is `{"ok":false,"error":"..."}` (also diagnosed on stderr). There
is no partial success result. Summary writing is opt-in; a missing path or write
failure fails the command rather than silently skipping the summary. Tokens are
redacted from diagnostics and output.

## Verification guarantees and limits

1. Query workflow runs filtered by exact SHA, configured branch, and `push`,
   **without filtering by status or conclusion**. Only the API's latest run
   (`per_page=1`, newest first) is considered; never fall back to older success.
2. Validate repository and source repository (case-insensitive GitHub names),
   SHA, branch, event, workflow path, completed/success, run ID and attempt.
3. Read **all** jobs using the attempt-specific jobs endpoint, 100 per page.
   Require consistent counts, unique job IDs, and matching run ID, attempt and
   SHA for every returned job. Reject missing/truncated/malformed pages.
4. Require exactly one job matching `--job-name`, completed/success, and exactly
   one step matching `--step-name` inside it, also completed/success.
5. Re-read the latest run after jobs; reject new runs, new attempts, running
   states, or failures observed during verification.

Missing, failed, cancelled, skipped, neutral, queued, and in-progress evidence
does not pass. HTTP, network, JSON, and schema errors fail closed. No retry or
permission fallback is performed.

This is a point-in-time proof from GitHub's API, not an atomic lock on GitHub. A
new run can start after the final read, and API eventual consistency applies. It
does not prove that the configured job's commands are trustworthy or that the
workflow definition is protected. Consumers must select meaningful, versioned
job/step names and protect their source branch/workflow separately.

## JavaScript API (ESM)

```js
import { verifyCi } from "github-ci-verify";

const evidence = await verifyCi({
  repository: "owner/project",
  sha: "0123456789abcdef0123456789abcdef01234567",
  branch: "main",
  workflow: "ci.yaml",
  jobName: "Release verification (v1)",
  stepName: "Confirm required checks succeeded",
  token: process.env.GH_TOKEN,
});
```

The API requires all these fields as strings (TypeScript callers must check the
token exists). Optional `apiUrl` defaults to GitHub.com. It returns typed
`VerificationEvidence` or rejects; it does not read environment variables,
invoke Git, or write output. A second `typeof fetch` argument supports testing.
`VerificationOptions` and `VerificationEvidence` are exported types.

## Development and local artifact verification

Requires pnpm >=11.22 (pinned in package metadata).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:artifact
pnpm pack
# Install the resulting github-ci-verify-0.1.0.tgz in a disposable project.
npm install /absolute/path/to/github-ci-verify-0.1.0.tgz
npx --no-install github-ci-verify --help
```

`pnpm check` enforces formatting, lint, strict types, >=90% coverage thresholds,
build, publint package shape, and a real offline tarball installation/bin smoke
check against a loopback mock GitHub API. `pnpm test:artifact` runs that smoke
check alone and cleans up its disposable consumer. The tarball ships compiled
ESM JavaScript with an executable shebang, declarations/maps, README and
license; not raw TS/tests. Public exports live in `src/index.ts`, tests in
`test/`, generated files in `dist/`. Publishing is configured through GitHub
Actions OIDC Trusted Publishing with the `npm` environment and
`publish-npm.yaml` workflow. No long-lived npm token is used. Releases use
`v<package.version>` tags on commits reachable from `main`. No npm publish or
release tag is needed for local artifact checks.

## Lineage

Derived from
[preset-npm-package](https://github.com/shazhou-ww/preset-npm-package) `main`
with full Git history and a git-lineage birth commit. `.git-lineage.yaml`
records that single immediate parent. With a clean worktree,
`git-lineage update` merges future parent changes forward; it does not push to
either repository.

## License

MIT
