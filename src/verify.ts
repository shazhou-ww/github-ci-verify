import assert from "node:assert/strict";

export interface VerificationOptions {
  repository: string;
  sha: string;
  branch: string;
  /** Workflow filename, for example ci.yaml (not its display name). */
  workflow: string;
  jobName: string;
  stepName: string;
  token: string;
  apiUrl?: string;
}

export interface VerificationEvidence {
  repository: string;
  branch: string;
  workflow: string;
  sourceSha: string;
  runUrl: string;
  runId: number;
  runAttempt: number;
  jobName: string;
  stepName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value), "Expected an array in CI evidence.");
  return value.map((item: unknown) => {
    assert(isRecord(item), "Expected an object in CI evidence.");
    return item;
  });
}

function positiveInteger(value: unknown): number {
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "Expected a positive integer in CI evidence.",
  );
  return value;
}

function apiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid GitHub API URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  assert(
    (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "GitHub API URL must use HTTPS without credentials, query, or fragment (HTTP is allowed only on loopback).",
  );
  return url.href.replace(/\/+$/u, "");
}

/** Verify existing evidence only; never start, retry, or wait for a workflow. */
export async function verifyCi(
  options: VerificationOptions,
  request: typeof fetch = fetch,
): Promise<VerificationEvidence> {
  const { repository, sha, branch, workflow, jobName, stepName, token } =
    options;
  assert(
    typeof repository === "string" && /^[\w.-]+\/[\w.-]+$/u.test(repository),
    "repository must identify an owner/repository.",
  );
  assert(
    typeof sha === "string" && /^[a-f\d]{40}$/u.test(sha),
    "Expected a full lowercase 40-character source commit SHA.",
  );
  assert(typeof branch === "string" && branch.trim(), "branch is required.");
  assert(
    typeof workflow === "string" && /^[\w.-]+\.ya?ml$/u.test(workflow),
    "workflow must be a YAML filename, for example ci.yaml.",
  );
  assert(typeof jobName === "string" && jobName.trim(), "jobName is required.");
  assert(
    typeof stepName === "string" && stepName.trim(),
    "stepName is required.",
  );
  assert(
    typeof token === "string" && token.trim() && !/\s/u.test(token),
    "A GitHub token with actions: read is required (no whitespace).",
  );
  const base = `${apiBase(options.apiUrl ?? "https://api.github.com")}/repos/${repository}/actions`;
  // Do not filter by success: a newer failure must supersede an older success.
  const runsUrl = `${base}/workflows/${encodeURIComponent(workflow)}/runs?${new URLSearchParams(
    { head_sha: sha, branch, event: "push", per_page: "1" },
  ).toString()}`;

  async function get(url: string) {
    let response: Response;
    try {
      response = await request(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Transport errors may contain credentials or response bodies.
      throw new Error(
        "GitHub CI evidence request failed (network, redirect, or timeout).",
      );
    }
    assert(
      response.ok,
      `GitHub CI evidence request failed: HTTP ${response.status}.`,
    );
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error("Invalid JSON in GitHub CI evidence response.");
    }
    assert(isRecord(data), "Invalid GitHub CI evidence response.");
    return data;
  }

  async function latestRun() {
    const data = await get(runsUrl);
    const runs = records(data.workflow_runs);
    assert.equal(runs.length, 1, "No unique latest push CI run found.");
    const run = runs[0];
    assert(run);
    assert(isRecord(run.repository), "Missing CI repository.");
    assert(isRecord(run.head_repository), "Missing CI source repository.");
    // Repository names on GitHub are case-insensitive.
    assert(
      typeof run.repository.full_name === "string" &&
        run.repository.full_name.toLowerCase() === repository.toLowerCase(),
      "Wrong CI repository.",
    );
    assert(
      typeof run.head_repository.full_name === "string" &&
        run.head_repository.full_name.toLowerCase() ===
          repository.toLowerCase(),
      "Wrong CI source repository.",
    );
    assert.equal(run.head_sha, sha, "Wrong CI source SHA.");
    assert.equal(run.head_branch, branch, "Wrong CI branch.");
    assert.equal(run.event, "push", "Wrong CI event.");
    assert.equal(
      run.path,
      `.github/workflows/${workflow}`,
      "Wrong CI workflow.",
    );
    assert.equal(run.status, "completed", "Latest CI run is not completed.");
    assert.equal(run.conclusion, "success", "Latest CI run did not succeed.");
    const id = positiveInteger(run.id);
    const attempt = positiveInteger(run.run_attempt);
    assert(typeof run.html_url === "string", "Missing CI run URL.");
    let url: URL;
    try {
      url = new URL(run.html_url);
    } catch {
      throw new Error("Invalid CI run URL.");
    }
    assert(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.toLowerCase() ===
          `/${repository}/actions/runs/${id}`.toLowerCase(),
      "Invalid CI run URL.",
    );
    return { id, attempt, url: url.href };
  }

  const run = await latestRun();
  const jobs: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  let total: number | undefined;
  let page = 1;
  do {
    const data = await get(
      `${base}/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`,
    );
    assert(
      typeof data.total_count === "number" &&
        Number.isSafeInteger(data.total_count) &&
        data.total_count > 0,
      "Invalid or empty CI job count.",
    );
    total ??= data.total_count;
    assert.equal(
      data.total_count,
      total,
      "CI job count changed during pagination.",
    );
    const batch = records(data.jobs);
    assert.equal(
      batch.length,
      Math.min(100, total - jobs.length),
      "Incomplete or inconsistent CI job page.",
    );
    for (const job of batch) {
      const id = positiveInteger(job.id);
      assert(!ids.has(id), "Duplicate CI job ID during pagination.");
      ids.add(id);
      assert.equal(job.run_id, run.id, "CI job belongs to another run.");
      assert.equal(
        job.run_attempt,
        run.attempt,
        "CI job belongs to another attempt.",
      );
      assert.equal(job.head_sha, sha, "CI job has the wrong source SHA.");
      assert(typeof job.name === "string", "Missing CI job name.");
    }
    jobs.push(...batch);
    page++;
  } while (jobs.length < total);

  const matches = jobs.filter((job) => job.name === jobName);
  assert.equal(
    matches.length,
    1,
    "Missing or ambiguous verification job name.",
  );
  const job = matches[0];
  assert(job);
  assert.equal(job.status, "completed", "Verification job is incomplete.");
  assert.equal(job.conclusion, "success", "Verification job did not succeed.");
  const steps = records(job.steps).filter((step) => step.name === stepName);
  assert.equal(steps.length, 1, "Missing or ambiguous verification step name.");
  const step = steps[0];
  assert(step);
  assert.equal(step.status, "completed", "Verification step is incomplete.");
  assert.equal(
    step.conclusion,
    "success",
    "Verification step did not succeed.",
  );

  const current = await latestRun();
  assert.equal(
    current.id,
    run.id,
    "Latest CI run changed during verification.",
  );
  assert.equal(
    current.attempt,
    run.attempt,
    "Latest CI attempt changed during verification.",
  );
  return {
    repository,
    branch,
    workflow,
    sourceSha: sha,
    runUrl: run.url,
    runId: run.id,
    runAttempt: run.attempt,
    jobName,
    stepName,
  };
}
