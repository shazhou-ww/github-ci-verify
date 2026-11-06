import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { verifyCi } from "./verify.js";

const help = `Usage: github-ci-verify --job-name <name> --step-name <name> [options]

Verify the latest push CI run for an exact source commit. Names match the
GitHub API job.name / step.name exactly, not YAML IDs.

  --repository <owner/repo>  Default: GITHUB_REPOSITORY
  --sha <full-sha>           Default: actual checkout's git rev-parse HEAD
  --branch <branch>          Default: main
  --workflow <filename>      Default: ci.yaml
  --job-name <name>          Required, exact job display name
  --step-name <name>         Required, exact step display name
  --api-url <url>            Default: GITHUB_API_URL or https://api.github.com
  --json                    Emit one JSON result (including failures)
  --summary                 Append evidence to GITHUB_STEP_SUMMARY
  --help, -h                Show help
  --version, -v             Show package version

Token: GH_TOKEN, falling back to GITHUB_TOKEN; requires actions: read.
No token argument is accepted. Success exits 0; all failures exit 1.
`;

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  checkoutSha: () => string;
  appendSummary: (path: string, text: string) => void;
  verify: typeof verifyCi;
  version: () => string;
}

const defaults: CliDependencies = {
  env: process.env,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  checkoutSha: () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  appendSummary: (path, text) => {
    appendFileSync(path, text, "utf8");
  },
  verify: verifyCi,
  version: () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (
      typeof pkg !== "object" ||
      pkg === null ||
      !("version" in pkg) ||
      typeof pkg.version !== "string"
    ) {
      throw new Error("Invalid package version.");
    }
    return pkg.version;
  },
};

function summaryCode(value: string): string {
  // HTML entities prevent Markdown/HTML injection from display names.
  return `<code>${value.replace(/[&<>"'\r\n`|]/gu, (char) => `&#${char.codePointAt(0)};`)}</code>`;
}

/** Kept outside the public exports; dependency injection tests the CLI boundary. */
export async function runCli(
  args: string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...defaults, ...dependencies };
  const redact = (text: string) => {
    for (const secret of [deps.env.GH_TOKEN, deps.env.GITHUB_TOKEN]) {
      if (secret) text = text.split(secret).join("[REDACTED]");
    }
    return text;
  };
  let json = args.includes("--json");
  try {
    const { values, tokens } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        repository: { type: "string" },
        sha: { type: "string" },
        branch: { type: "string" },
        workflow: { type: "string" },
        "job-name": { type: "string" },
        "step-name": { type: "string" },
        "api-url": { type: "string" },
        json: { type: "boolean" },
        summary: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind === "option") {
        if (seen.has(token.name))
          throw new Error(`Duplicate option --${token.name}.`);
        seen.add(token.name);
      }
    }
    json = values.json ?? false;
    if (values.help || values.version) {
      if (seen.size !== 1)
        throw new Error("--help and --version must be used alone.");
      deps.stdout(values.help ? help : `${deps.version()}\n`);
      return 0;
    }
    const repository = values.repository ?? deps.env.GITHUB_REPOSITORY;
    const jobName = values["job-name"];
    const stepName = values["step-name"];
    if (!repository?.trim())
      throw new Error("--repository or GITHUB_REPOSITORY is required.");
    if (!jobName?.trim()) throw new Error("--job-name is required.");
    if (!stepName?.trim()) throw new Error("--step-name is required.");
    const token = deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN;
    if (!token)
      throw new Error(
        "GH_TOKEN or GITHUB_TOKEN with actions: read is required.",
      );
    const summaryPath = deps.env.GITHUB_STEP_SUMMARY;
    if (values.summary && !summaryPath)
      throw new Error("--summary requires GITHUB_STEP_SUMMARY.");
    let sha = values.sha;
    if (sha === undefined) {
      try {
        sha = deps.checkoutSha();
      } catch {
        throw new Error(
          "Cannot resolve checkout HEAD; provide --sha explicitly.",
        );
      }
    }
    const evidence = await deps.verify({
      repository,
      sha,
      branch: values.branch ?? "main",
      workflow: values.workflow ?? "ci.yaml",
      jobName,
      stepName,
      token,
      apiUrl:
        values["api-url"] ??
        deps.env.GITHUB_API_URL ??
        "https://api.github.com",
    });
    if (values.summary) {
      const rows = Object.entries(evidence)
        .map(([key, value]) => `| ${key} | ${summaryCode(String(value))} |`)
        .join("\n");
      try {
        deps.appendSummary(
          summaryPath ?? "",
          redact(
            `\n## GitHub CI verification\n\n| Evidence | Value |\n| --- | --- |\n${rows}\n`,
          ),
        );
      } catch {
        throw new Error("Failed to append GitHub Actions summary.");
      }
    }
    deps.stdout(
      redact(
        json
          ? `${JSON.stringify({ ok: true, ...evidence })}\n`
          : `Verified ${evidence.sourceSha}: ${evidence.runUrl} (run ${evidence.runId}, attempt ${evidence.runAttempt})\nJob: ${evidence.jobName}\nStep: ${evidence.stepName}\n`,
      ),
    );
    return 0;
  } catch (error) {
    const message = redact(
      error instanceof Error ? error.message : "CI verification failed.",
    );
    if (json) deps.stdout(`${JSON.stringify({ ok: false, error: message })}\n`);
    deps.stderr(`github-ci-verify: ${message}\n`);
    return 1;
  }
}
