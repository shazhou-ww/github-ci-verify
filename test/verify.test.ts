import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

import { verifyCi } from "../src/index.js";
import type { VerificationOptions } from "../src/index.js";

const sha = "a".repeat(40);
const options: VerificationOptions = {
  repository: "example/project-",
  sha,
  branch: "main",
  workflow: "ci.yaml",
  jobName: "Release verification (v1)",
  stepName: "Confirm required checks succeeded",
  token: "test-secret",
};

function run() {
  return {
    id: 42,
    run_attempt: 2,
    repository: { full_name: options.repository },
    head_repository: { full_name: options.repository },
    head_sha: sha,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/ci.yaml",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example/project-/actions/runs/42",
  };
}

function step() {
  return { name: options.stepName, status: "completed", conclusion: "success" };
}

function job() {
  return {
    id: 100,
    name: options.jobName,
    run_id: 42,
    run_attempt: 2,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    steps: [step()],
  };
}

function responses(...bodies: unknown[]) {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("Unexpected request"));
  for (const body of bodies) request.mockResolvedValueOnce(Response.json(body));
  return request;
}

function requestUrl(input: Parameters<typeof fetch>[0] | undefined) {
  assert(typeof input === "string");
  return new URL(input);
}

function evidence(
  first: object = run(),
  jobs: object[] = [job()],
  last: object = first,
) {
  return responses(
    { workflow_runs: [first] },
    { total_count: jobs.length, jobs },
    { workflow_runs: [last] },
  );
}

describe("verifyCi", () => {
  it("returns exact evidence and never requests success-filtered or all-attempt jobs", async () => {
    const request = evidence();
    await expect(verifyCi(options, request)).resolves.toEqual({
      repository: options.repository,
      sourceSha: sha,
      branch: "main",
      workflow: "ci.yaml",
      runId: 42,
      runAttempt: 2,
      runUrl: run().html_url,
      jobName: options.jobName,
      stepName: options.stepName,
    });
    const first = requestUrl(request.mock.calls[0]?.[0]);
    expect(first.pathname).toBe(
      "/repos/example/project-/actions/workflows/ci.yaml/runs",
    );
    expect(Object.fromEntries(first.searchParams)).toEqual({
      head_sha: sha,
      branch: "main",
      event: "push",
      per_page: "1",
    });
    expect(request.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/example/project-/actions/runs/42/attempts/2/jobs?per_page=100&page=1",
    );
    expect(request.mock.calls[2]?.[0]).toBe(request.mock.calls[0]?.[0]);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-secret",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
    });
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("supports configured GHES base, branch, workflow and case-insensitive repositories", async () => {
    const custom = {
      ...options,
      apiUrl: "https://git.example/api/v3/",
      repository: "Example/Project-",
      branch: "release/next",
      workflow: "checks.yml",
    };
    const first = {
      ...run(),
      head_branch: custom.branch,
      path: ".github/workflows/checks.yml",
    };
    const request = evidence(first);
    await expect(verifyCi(custom, request)).resolves.toMatchObject({
      branch: custom.branch,
    });
    const url = requestUrl(request.mock.calls[0]?.[0]);
    expect(url.pathname).toBe(
      "/api/v3/repos/Example/Project-/actions/workflows/checks.yml/runs",
    );
    expect(url.searchParams.get("branch")).toBe("release/next");
  });

  it.each([
    ["repository", "", "owner/repository"],
    ["repository", "../owner/project", "owner/repository"],
    ["repository", "owner/project?x", "owner/repository"],
    ["sha", "abc", "source commit SHA"],
    ["sha", "A".repeat(40), "source commit SHA"],
    ["branch", " ", "branch is required"],
    ["workflow", "../ci.yaml", "YAML filename"],
    ["workflow", ".github/workflows/ci.yaml", "YAML filename"],
    ["workflow", "CI", "YAML filename"],
    ["jobName", "", "jobName is required"],
    ["stepName", " ", "stepName is required"],
    ["token", "", "actions: read"],
    ["token", "bad token", "whitespace"],
    ["apiUrl", "", "Invalid GitHub API URL"],
    ["apiUrl", "http://api.github.com", "HTTPS"],
    ["apiUrl", "ftp://localhost", "HTTPS"],
    ["apiUrl", "https://user:pass@example.com", "credentials"],
    ["apiUrl", "https://example.com?token=secret", "query"],
    ["apiUrl", "https://example.com#fragment", "fragment"],
  ] as const)(
    "rejects invalid %s (%j) before HTTP",
    async (key, value, message) => {
      const request = evidence();
      await expect(
        verifyCi({ ...options, [key]: value }, request),
      ).rejects.toThrow(message);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows HTTP loopback %s",
    async (host) => {
      await expect(
        verifyCi({ ...options, apiUrl: `http://${host}:8080` }, evidence()),
      ).resolves.toMatchObject({ runId: 42 });
    },
  );

  it.each([
    ["repository", null, "Missing CI repository"],
    ["repository", { full_name: "other/project-" }, "Wrong CI repository"],
    ["repository", { full_name: 123 }, "Wrong CI repository"],
    ["head_repository", null, "Missing CI source repository"],
    [
      "head_repository",
      { full_name: "fork/project-" },
      "Wrong CI source repository",
    ],
    ["head_repository", {}, "Wrong CI source repository"],
    ["head_sha", "b".repeat(40), "Wrong CI source SHA"],
    ["head_branch", "feature", "Wrong CI branch"],
    ["event", "pull_request", "Wrong CI event"],
    ["event", "workflow_dispatch", "Wrong CI event"],
    ["path", ".github/workflows/old-ci.yaml", "Wrong CI workflow"],
    ["status", "queued", "not completed"],
    ["status", "in_progress", "not completed"],
    ["conclusion", "failure", "did not succeed"],
    ["conclusion", "cancelled", "did not succeed"],
    ["conclusion", "skipped", "did not succeed"],
    ["conclusion", "neutral", "did not succeed"],
    ["conclusion", null, "did not succeed"],
    ["id", 0, "positive integer"],
    ["id", Number.MAX_SAFE_INTEGER + 1, "positive integer"],
    ["run_attempt", 1.5, "positive integer"],
    ["html_url", null, "Missing CI run URL"],
    ["html_url", "", "Invalid CI run URL"],
    ["html_url", "javascript:alert(1)", "Invalid CI run URL"],
    [
      "html_url",
      "https://user:pass@github.com/example/project-/actions/runs/42",
      "Invalid CI run URL",
    ],
    [
      "html_url",
      "https://github.com/example/project-/actions/runs/42?token=secret",
      "Invalid CI run URL",
    ],
    [
      "html_url",
      "https://github.com/example/project-/actions/runs/41",
      "Invalid CI run URL",
    ],
  ] as const)("rejects wrong run %s (%j)", async (key, value, message) => {
    const request = evidence({ ...run(), [key]: value });
    await expect(verifyCi(options, request)).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    {},
    { workflow_runs: null },
    { workflow_runs: [null] },
    { workflow_runs: [] },
    { workflow_runs: [run(), run()] },
  ])("rejects malformed or missing latest run (%j)", async (body) => {
    await expect(verifyCi(options, responses(body))).rejects.toThrow();
  });

  it("does not fall back to an older success after the latest failure", async () => {
    const request = responses(
      { workflow_runs: [{ ...run(), conclusion: "failure" }] },
      { workflow_runs: [run()] },
    );
    await expect(verifyCi(options, request)).rejects.toThrow("did not succeed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["name", "Release verification (v0)", "verification job name"],
    ["name", "release verification (v1)", "verification job name"],
    ["name", "Release verification (v1) ", "verification job name"],
    ["name", null, "Missing CI job name"],
    ["id", 0, "positive integer"],
    ["run_id", 41, "another run"],
    ["run_attempt", 1, "another attempt"],
    ["head_sha", "b".repeat(40), "wrong source SHA"],
    ["status", "queued", "job is incomplete"],
    ["status", "in_progress", "job is incomplete"],
    ["conclusion", "failure", "job did not succeed"],
    ["conclusion", "cancelled", "job did not succeed"],
    ["conclusion", "skipped", "job did not succeed"],
    ["conclusion", "neutral", "job did not succeed"],
    ["conclusion", null, "job did not succeed"],
    ["steps", [], "verification step name"],
    ["steps", null, "Expected an array"],
    ["steps", [null], "Expected an object"],
  ] as const)("rejects wrong job %s (%j)", async (key, value, message) => {
    await expect(
      verifyCi(options, evidence(run(), [{ ...job(), [key]: value }])),
    ).rejects.toThrow(message);
  });

  it.each([
    ["name", "Old step", "verification step name"],
    ["name", "Confirm required checks succeeded ", "verification step name"],
    ["status", "queued", "step is incomplete"],
    ["status", "in_progress", "step is incomplete"],
    ["conclusion", "failure", "step did not succeed"],
    ["conclusion", "cancelled", "step did not succeed"],
    ["conclusion", "skipped", "step did not succeed"],
    ["conclusion", "neutral", "step did not succeed"],
    ["conclusion", null, "step did not succeed"],
  ] as const)("rejects wrong step %s (%j)", async (key, value, message) => {
    await expect(
      verifyCi(
        options,
        evidence(run(), [{ ...job(), steps: [{ ...step(), [key]: value }] }]),
      ),
    ).rejects.toThrow(message);
  });

  it("rejects duplicate names even when only one duplicate succeeds", async () => {
    await expect(
      verifyCi(
        options,
        evidence(run(), [job(), { ...job(), id: 101, conclusion: "skipped" }]),
      ),
    ).rejects.toThrow("ambiguous verification job");
    await expect(
      verifyCi(
        options,
        evidence(run(), [
          { ...job(), steps: [step(), { ...step(), conclusion: "skipped" }] },
        ]),
      ),
    ).rejects.toThrow("ambiguous verification step");
  });

  it.each([
    { total_count: -1, jobs: [] },
    { total_count: "1", jobs: [job()] },
    { total_count: 0, jobs: [] },
    { total_count: 1.1, jobs: [] },
    { total_count: 1, jobs: null },
    { total_count: 1, jobs: [null] },
    { total_count: 1, jobs: [] },
    { total_count: 1, jobs: [job(), job()] },
    { total_count: 101, jobs: [job()] },
  ])("rejects malformed, empty, or incomplete jobs (%j)", async (body) => {
    await expect(
      verifyCi(options, responses({ workflow_runs: [run()] }, body)),
    ).rejects.toThrow();
  });

  function pageJobs() {
    return Array.from({ length: 100 }, (_, index) => ({
      ...job(),
      id: index + 1000,
      name: `Other job ${index}`,
    }));
  }

  it("finds required job on page two and revalidates after all pages", async () => {
    const request = responses(
      { workflow_runs: [run()] },
      { total_count: 101, jobs: pageJobs() },
      { total_count: 101, jobs: [job()] },
      { workflow_runs: [run()] },
    );
    await expect(verifyCi(options, request)).resolves.toMatchObject({
      runAttempt: 2,
    });
    expect(request.mock.calls).toHaveLength(4);
    expect(request.mock.calls[2]?.[0]).toContain(
      "/runs/42/attempts/2/jobs?per_page=100&page=2",
    );
  });

  it.each([
    { total_count: 102, jobs: [job()] },
    { total_count: 101, jobs: [] },
    { total_count: 101, jobs: [{ ...job(), id: 1000 }] },
    { total_count: 101, jobs: [{ ...job(), name: "Other", run_attempt: 1 }] },
    { total_count: 101, jobs: [{ ...job(), name: "Other", run_id: 41 }] },
    {
      total_count: 101,
      jobs: [{ ...job(), name: "Other", head_sha: "b".repeat(40) }],
    },
    { total_count: 101, jobs: [{ ...job(), name: options.jobName }] },
  ])(
    "rejects drift, truncation, duplicate IDs and mismatched jobs on later pages (%j)",
    async (last) => {
      const jobs = pageJobs();
      jobs[0] = { ...job(), id: 1000 };
      await expect(
        verifyCi(
          options,
          responses(
            { workflow_runs: [run()] },
            { total_count: 101, jobs },
            last,
          ),
        ),
      ).rejects.toThrow();
    },
  );

  it.each([
    {
      ...run(),
      id: 43,
      html_url: "https://github.com/example/project-/actions/runs/43",
    },
    { ...run(), run_attempt: 3 },
    { ...run(), status: "in_progress" },
    { ...run(), conclusion: "failure" },
    { ...run(), conclusion: "cancelled" },
    { ...run(), head_sha: "b".repeat(40) },
  ])("rejects run/attempt/state changes after jobs (%j)", async (last) => {
    await expect(
      verifyCi(options, evidence(run(), [job()], last)),
    ).rejects.toThrow();
  });

  it.each([401, 403, 404, 429, 500])(
    "fails HTTP %s without echoing response bodies",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("test-secret", { status, statusText: "test-secret" }),
        );
      await expect(verifyCi(options, request)).rejects.toThrow(
        `HTTP ${status}`,
      );
      await expect(verifyCi(options, request)).rejects.not.toThrow(
        "test-secret",
      );
    },
  );

  it.each([0, 1, 2])(
    "fails network errors at request %s without leaking secrets",
    async (index) => {
      const request = evidence();
      request.mockReset();
      const bodies = [
        { workflow_runs: [run()] },
        { total_count: 1, jobs: [job()] },
      ];
      for (let i = 0; i < index; i++)
        request.mockResolvedValueOnce(Response.json(bodies[i]));
      request.mockRejectedValueOnce(new Error("test-secret"));
      await expect(verifyCi(options, request)).rejects.toThrow(
        "network, redirect, or timeout",
      );
    },
  );

  it.each([0, 1, 2])("fails invalid JSON at request %s", async (index) => {
    const request = evidence();
    request.mockReset();
    const bodies = [
      { workflow_runs: [run()] },
      { total_count: 1, jobs: [job()] },
    ];
    for (let i = 0; i < index; i++)
      request.mockResolvedValueOnce(Response.json(bodies[i]));
    request.mockResolvedValueOnce(new Response("{test-secret"));
    await expect(verifyCi(options, request)).rejects.toThrow("Invalid JSON");
  });
});
