import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "github-ci-verify-artifact-"));
const consumer = join(temporary, "consumer");
const tarball = join(temporary, "package.tgz");
const manager = process.env.npm_execpath;
assert(manager, "Run this check using pnpm test:artifact.");
const managerCommand = /\.[cm]?js$/u.test(manager)
  ? [process.execPath, manager]
  : [manager];
const env = {
  ...process.env,
  GH_TOKEN: "artifact-test-secret",
  GITHUB_TOKEN: "",
  GITHUB_SHA: "b".repeat(40),
  GITHUB_REPOSITORY: "example/project-",
};

function command(executable, args, cwd = root, environment = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`Command terminated by ${signal}.`));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function pnpm(args, cwd = root) {
  return command(managerCommand[0], [...managerCommand.slice(1), ...args], cwd);
}

const sha = "a".repeat(40);
const jobName = "Checks (v1)";
const stepName = "Confirm checks";
const run = {
  id: 42,
  run_attempt: 2,
  repository: { full_name: env.GITHUB_REPOSITORY },
  head_repository: { full_name: env.GITHUB_REPOSITORY },
  head_sha: sha,
  head_branch: "main",
  event: "push",
  path: ".github/workflows/ci.yaml",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/project-/actions/runs/42",
};
let failure = false;
let requests = [];
let serverError;
const server = createServer((request, response) => {
  try {
    assert.equal(request.headers.authorization, `Bearer ${env.GH_TOKEN}`);
    const url = new URL(request.url, "http://localhost");
    requests.push(url);
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/workflows/ci.yaml/runs")) {
      assert.equal(url.searchParams.get("head_sha"), sha);
      assert.equal(url.searchParams.get("branch"), "main");
      assert.equal(url.searchParams.get("event"), "push");
      assert.equal(url.searchParams.get("per_page"), "1");
      assert.equal(url.searchParams.has("status"), false);
      response.end(
        JSON.stringify({
          workflow_runs: [
            { ...run, conclusion: failure ? "failure" : "success" },
          ],
        }),
      );
    } else {
      assert.equal(
        url.pathname,
        "/repos/example/project-/actions/runs/42/attempts/2/jobs",
      );
      assert.equal(url.searchParams.get("page"), "1");
      response.end(
        JSON.stringify({
          total_count: 1,
          jobs: [
            {
              id: 100,
              name: jobName,
              run_id: 42,
              run_attempt: 2,
              head_sha: sha,
              status: "completed",
              conclusion: "success",
              steps: [
                { name: stepName, status: "completed", conclusion: "success" },
              ],
            },
          ],
        }),
      );
    }
  } catch (error) {
    serverError = error;
    response.writeHead(500).end("{}");
  }
});

try {
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  const packed = await pnpm(["pack", "--out", tarball]);
  assert.equal(packed.code, 0, packed.stderr);
  const installed = await pnpm(
    ["add", "--offline", "--ignore-scripts", tarball],
    consumer,
  );
  assert.equal(installed.code, 0, installed.stderr);
  const packageRoot = join(consumer, "node_modules", "github-ci-verify");
  const metadata = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(metadata.private, false);
  assert.equal(metadata.name, "github-ci-verify");
  assert.deepEqual(metadata.bin, { "github-ci-verify": "dist/bin.js" });
  assert.deepEqual(Object.keys(metadata.exports), [".", "./package.json"]);
  const entries = await readdir(packageRoot);
  // pnpm can create a local .bin directory while linking an installed package.
  if (entries.includes("node_modules")) {
    assert.deepEqual(await readdir(join(packageRoot, "node_modules")), [
      ".bin",
    ]);
  }
  assert.deepEqual(entries.filter((entry) => entry !== "node_modules").sort(), [
    "LICENSE",
    "README.md",
    "dist",
    "package.json",
  ]);
  assert(
    (await readFile(join(packageRoot, "dist", "bin.js"), "utf8")).startsWith(
      "#!/usr/bin/env node\n",
    ),
  );

  const help = await pnpm(["exec", "github-ci-verify", "--help"], consumer);
  assert.equal(help.code, 0, help.stderr);
  assert(help.stdout.includes("--job-name"));
  const version = await pnpm(
    ["exec", "github-ci-verify", "--version"],
    consumer,
  );
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), metadata.version);
  const invalid = await pnpm(["exec", "github-ci-verify", "--json"], consumer);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
  assert(invalid.stderr.includes("--job-name"));
  const api = await command(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    const api = await import("github-ci-verify");
    assert.deepEqual(Object.keys(api), ["verifyCi"]);
    await assert.rejects(import("github-ci-verify/dist/verify.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  `,
    ],
    consumer,
  );
  assert.equal(api.code, 0, api.stderr);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const args = [
    "exec",
    "github-ci-verify",
    "--job-name",
    jobName,
    "--step-name",
    stepName,
    "--sha",
    sha,
    "--api-url",
    `http://127.0.0.1:${address.port}`,
    "--json",
  ];
  env.GITHUB_STEP_SUMMARY = join(temporary, "summary.md");
  const success = await pnpm([...args, "--summary"], consumer);
  assert.equal(success.code, 0, success.stderr);
  assert.equal(success.stderr, "");
  const proof = JSON.parse(success.stdout);
  assert.deepEqual(proof, {
    ok: true,
    repository: env.GITHUB_REPOSITORY,
    branch: "main",
    workflow: "ci.yaml",
    sourceSha: sha,
    runUrl: run.html_url,
    runId: 42,
    runAttempt: 2,
    jobName,
    stepName,
  });
  assert.equal(requests.length, 3);
  assert(
    (await readFile(env.GITHUB_STEP_SUMMARY, "utf8")).includes(run.html_url),
  );
  failure = true;
  requests = [];
  const rejected = await pnpm(args, consumer);
  assert.equal(rejected.code, 1);
  assert.equal(JSON.parse(rejected.stdout).ok, false);
  assert(rejected.stderr.includes("did not succeed"));
  assert.equal(requests.length, 1);
  assert(
    !`${success.stdout}${success.stderr}${rejected.stdout}${rejected.stderr}`.includes(
      env.GH_TOKEN,
    ),
  );
  if (serverError) throw serverError;
  console.log(
    "Tarball install, package exports, executable bin, success/failure JSON, exit codes and summary: passed.",
  );
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
