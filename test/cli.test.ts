import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import type { CliDependencies } from "../src/cli.js";
import type { VerificationEvidence } from "../src/index.js";

const sha = "a".repeat(40);
const result: VerificationEvidence = {
  repository: "owner/repo-",
  branch: "main",
  workflow: "ci.yaml",
  sourceSha: sha,
  runId: 42,
  runAttempt: 2,
  runUrl: "https://github.com/owner/repo-/actions/runs/42",
  jobName: "Checks (v1)",
  stepName: "Confirm checks",
};
const names = ["--job-name", result.jobName, "--step-name", result.stepName];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function harness(env: NodeJS.ProcessEnv = {}) {
  return {
    env: {
      GITHUB_REPOSITORY: "owner/repo-",
      GITHUB_TOKEN: "test-secret",
      ...env,
    },
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>(),
    checkoutSha: vi.fn(() => sha),
    appendSummary: vi.fn<(path: string, text: string) => void>(),
    verify: vi.fn<CliDependencies["verify"]>().mockResolvedValue(result),
    version: vi.fn(() => "0.1.0"),
  };
}

describe("CLI boundary", () => {
  it("uses the real stdout/stderr, Git checkout resolver, package version and summary writer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "github-ci-verify-cli-"));
    const path = join(directory, "summary.md");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.stubEnv("GITHUB_REPOSITORY", result.repository);
    vi.stubEnv("GH_TOKEN", "test-secret");
    vi.stubEnv("GITHUB_STEP_SUMMARY", path);
    const verify = vi.fn<CliDependencies["verify"]>().mockResolvedValue(result);
    try {
      expect(await runCli(["--version"])).toBe(0);
      expect(stdout).toHaveBeenCalledWith("0.1.0\n");
      expect(await runCli([...names, "--summary"], { verify })).toBe(0);
      const actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      expect(verify.mock.calls[0]?.[0].sha).toBe(actualHead);
      expect(readFileSync(path, "utf8")).toContain(result.runUrl);
      expect(await runCli([])).toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        "github-ci-verify: --job-name is required.\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sets the executable process exit code", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      process.argv = [process.execPath, "github-ci-verify", "--version"];
      await import("../src/bin.js");
      expect(process.exitCode).toBe(0);
      expect(stdout).toHaveBeenCalledWith("0.1.0\n");
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  });

  it.each(["--help", "-h", "--version", "-v"])(
    "supports %s without Git, env or HTTP",
    async (flag) => {
      const deps = harness({ GITHUB_TOKEN: undefined });
      expect(await runCli([flag], deps)).toBe(0);
      expect(deps.stdout.mock.calls[0]?.[0]).toContain(
        flag.includes("help") || flag === "-h" ? "--job-name" : "0.1.0",
      );
      expect(deps.checkoutSha).not.toHaveBeenCalled();
      expect(deps.verify).not.toHaveBeenCalled();
    },
  );

  it("uses checkout HEAD, never tag event GITHUB_SHA", async () => {
    const deps = harness({ GITHUB_SHA: "b".repeat(40) });
    expect(await runCli(names, deps)).toBe(0);
    expect(deps.verify).toHaveBeenCalledWith({
      repository: "owner/repo-",
      sha,
      branch: "main",
      workflow: "ci.yaml",
      jobName: result.jobName,
      stepName: result.stepName,
      token: "test-secret",
      apiUrl: "https://api.github.com",
    });
    expect(deps.stdout.mock.calls[0]?.[0]).toContain(result.runUrl);
    expect(deps.stdout.mock.calls[0]?.[0]).toContain("attempt 2");
    expect(deps.stderr).not.toHaveBeenCalled();
    expect(deps.appendSummary).not.toHaveBeenCalled();
  });

  it("honors explicit parameters over env and GH_TOKEN over GITHUB_TOKEN", async () => {
    const deps = harness({
      GH_TOKEN: "gh-secret",
      GITHUB_API_URL: "https://env/api/v3",
    });
    expect(
      await runCli(
        [
          ...names,
          "--repository",
          "explicit/repo",
          "--sha",
          sha,
          "--branch",
          "release",
          "--workflow",
          "checks.yml",
          "--api-url",
          "https://explicit/api/v3",
          "--json",
        ],
        deps,
      ),
    ).toBe(0);
    expect(deps.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "explicit/repo",
        sha,
        branch: "release",
        workflow: "checks.yml",
        apiUrl: "https://explicit/api/v3",
        token: "gh-secret",
      }),
    );
    expect(deps.checkoutSha).not.toHaveBeenCalled();
    expect(deps.stdout).toHaveBeenCalledExactlyOnceWith(
      `${JSON.stringify({ ok: true, ...result })}\n`,
    );
  });

  it("uses API URL from the Actions environment", async () => {
    const deps = harness({ GITHUB_API_URL: "https://env/api/v3" });
    expect(await runCli(names, deps)).toBe(0);
    expect(deps.verify).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: "https://env/api/v3" }),
    );
  });

  it.each([
    [[], "--job-name"],
    [["--job-name", "Checks"], "--step-name"],
    [[...names, "--sha"], "argument missing"],
    [[...names, "--job-name", "Other"], "Duplicate option"],
    [[...names, "--json", "--json"], "Duplicate option"],
    [[...names, "--contract", "v1"], "Unknown option"],
    [[...names, "--step", "x"], "Unknown option"],
    [[...names, "--token", "secret"], "Unknown option"],
    [[...names, "positional"], "Unexpected argument"],
    [["--help", "--version"], "used alone"],
    [["--help", "--json"], "used alone"],
    [["--job-name", " ", "--step-name", "Step"], "--job-name"],
    [["--job-name", "Job", "--step-name", ""], "--step-name"],
  ])("rejects invalid args %j", async (args, message) => {
    const deps = harness();
    expect(await runCli(args, deps)).toBe(1);
    expect(deps.stderr.mock.calls[0]?.[0].toLowerCase()).toContain(
      message.toLowerCase(),
    );
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it.each([
    [{ GITHUB_REPOSITORY: undefined }, "GITHUB_REPOSITORY"],
    [{ GITHUB_REPOSITORY: "" }, "GITHUB_REPOSITORY"],
    [{ GITHUB_TOKEN: undefined }, "GITHUB_TOKEN"],
    [{ GITHUB_TOKEN: "" }, "GITHUB_TOKEN"],
  ])("rejects missing environment %j", async (env, message) => {
    const deps = harness(env);
    expect(await runCli(names, deps)).toBe(1);
    expect(deps.stderr.mock.calls[0]?.[0]).toContain(message);
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it("reports failed checkout resolution, without echoing Git errors", async () => {
    const deps = harness();
    deps.checkoutSha.mockImplementation(() => {
      throw new Error("test-secret");
    });
    expect(await runCli(names, deps)).toBe(1);
    expect(deps.stderr.mock.calls[0]?.[0]).toContain("provide --sha");
    expect(deps.stderr.mock.calls[0]?.[0]).not.toContain("test-secret");
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "fails verification with stderr and JSON=%s",
    async (json) => {
      const deps = harness({ GH_TOKEN: "gh-secret" });
      deps.verify.mockRejectedValue(new Error("failed gh-secret test-secret"));
      expect(await runCli([...names, ...(json ? ["--json"] : [])], deps)).toBe(
        1,
      );
      expect(deps.stderr).toHaveBeenCalledWith(
        "github-ci-verify: failed [REDACTED] [REDACTED]\n",
      );
      if (json) {
        expect(deps.stdout).toHaveBeenCalledWith(
          '{"ok":false,"error":"failed [REDACTED] [REDACTED]"}\n',
        );
      } else {
        expect(deps.stdout).not.toHaveBeenCalled();
      }
    },
  );

  it("redacts secrets in successful output and summary too", async () => {
    const deps = harness({ GITHUB_STEP_SUMMARY: "summary.md" });
    deps.verify.mockResolvedValue({ ...result, jobName: "test-secret" });
    expect(await runCli([...names, "--json", "--summary"], deps)).toBe(0);
    expect(deps.stdout.mock.calls[0]?.[0]).not.toContain("test-secret");
    expect(deps.appendSummary.mock.calls[0]?.[1]).not.toContain("test-secret");
  });

  it("handles unknown thrown values as explicit failure", async () => {
    const deps = harness();
    deps.verify.mockRejectedValue(null);
    expect(await runCli([...names, "--json"], deps)).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      "github-ci-verify: CI verification failed.\n",
    );
  });

  it("writes escaped summary containing all verified evidence only when requested", async () => {
    const deps = harness({ GITHUB_STEP_SUMMARY: "summary.md" });
    deps.verify.mockResolvedValue({ ...result, jobName: "<img>&\"'`|\r\n" });
    expect(await runCli([...names, "--summary"], deps)).toBe(0);
    const summary = deps.appendSummary.mock.calls[0]?.[1];
    expect(summary).toContain(result.runUrl);
    expect(summary).toContain("| runAttempt | <code>2</code> |");
    expect(summary).toContain(
      "&#60;img&#62;&#38;&#34;&#39;&#96;&#124;&#13;&#10;",
    );
    expect(summary).not.toContain("<img>");
    expect(deps.appendSummary.mock.calls[0]?.[0]).toBe("summary.md");
  });

  it("rejects missing summary path before verification", async () => {
    const deps = harness();
    expect(await runCli([...names, "--summary"], deps)).toBe(1);
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.stderr.mock.calls[0]?.[0]).toContain("GITHUB_STEP_SUMMARY");
  });

  it("fails summary write without emitting success JSON", async () => {
    const deps = harness({ GITHUB_STEP_SUMMARY: "summary.md" });
    deps.appendSummary.mockImplementation(() => {
      throw new Error("test-secret");
    });
    expect(await runCli([...names, "--json", "--summary"], deps)).toBe(1);
    expect(deps.stdout).toHaveBeenCalledWith(
      '{"ok":false,"error":"Failed to append GitHub Actions summary."}\n',
    );
  });
});
