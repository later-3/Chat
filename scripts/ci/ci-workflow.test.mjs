import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parseDocument } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ciSource = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const maintenanceSource = readFileSync(
  resolve(repoRoot, ".github/workflows/maintenance.yml"),
  "utf8",
);
const packageManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

const REQUIRED_EMPTY_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CHAT_DEBUG_PI_KEY_READER",
  "CHAT_DEBUG_PI_PROVIDER_CONFIG",
  "CHAT_EXTERNAL_TEST_COMMAND_NAME",
  "CHAT_MEMMY_TOKEN",
  "CHAT_PLANE_CE_API_TOKEN",
  "CHAT_PROJECT_MODEL_API_KEY_ENV",
  "CHAT_PROJECT_MODEL_BASE_URL",
  "CHAT_PAID_TEST_COMMAND_NAME",
  "CHAT_TENCENT_MEMORYCORE_TOKEN",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PLANE_API_TOKEN",
]);

const REQUIRED_DISABLED_ENV = Object.freeze([
  "CHAT_ALLOW_EXTERNAL_WRITES",
  "CHAT_ALLOW_PAID_TESTS",
  "CHAT_ALLOW_UNKNOWN_EXTERNAL_SERVICES",
  "CHAT_CODE_WORKBENCH_ENABLED",
  "CHAT_MEMORY_ENABLED",
  "CHAT_MEMORY_REAL_TEST",
  "CHAT_PLANE_CE_REAL_TEST",
]);

export function parseCiWorkflow(source) {
  const document = parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    "workflow必须是可可靠解析且无重复key的YAML",
  );
  const workflow = document.toJS();
  assert.ok(workflow !== null && typeof workflow === "object" && !Array.isArray(workflow));
  return workflow;
}

function commandsFor(job) {
  return job.steps.filter((step) => typeof step?.run === "string").map((step) => step.run.trim());
}

function assertSafeWorkflow(workflow) {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.env?.CI, "true");
  for (const name of REQUIRED_EMPTY_ENV) assert.equal(workflow.env?.[name], "", `${name}必须清空`);
  for (const name of REQUIRED_DISABLED_ENV) {
    assert.equal(workflow.env?.[name], "0", `${name}必须关闭`);
  }
}

function assertSafeJob(jobName, job) {
  assert.equal(job.if, undefined, `${jobName}不得条件跳过`);
  assert.equal(job["continue-on-error"], undefined, `${jobName}不得容错`);
  assert.ok(
    Number.isInteger(job["timeout-minutes"]) &&
      job["timeout-minutes"] >= 5 &&
      job["timeout-minutes"] <= 60,
    `${jobName}必须设置5–60分钟timeout`,
  );
  assert.ok(Array.isArray(job.steps), `${jobName}.steps必须是数组`);

  const checkouts = job.steps.filter(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
  assert.equal(checkouts.length, 1, `${jobName}必须精确checkout一次`);
  assert.equal(
    checkouts[0].with?.["persist-credentials"],
    false,
    `${jobName} checkout必须关闭persist-credentials`,
  );

  for (const step of job.steps) {
    assert.equal(step?.["continue-on-error"], undefined, `${jobName}步骤不得continue-on-error`);
    assert.equal(step?.if, undefined, `${jobName}步骤不得条件跳过`);
    if (typeof step?.uses === "string" && !step.uses.startsWith("./")) {
      assert.match(step.uses, /^[^@\s]+@[0-9a-f]{40}$/u, `${jobName} Action必须固定完整SHA`);
    }
    if (typeof step?.run === "string") {
      assert.doesNotMatch(
        step.run,
        /(?:CHAT_ALLOW_PAID_TESTS=1|CHAT_ALLOW_EXTERNAL_WRITES=1|:paid\b|test:provider:|test:external:)/u,
        `${jobName}不得运行paid或external入口`,
      );
    }
  }
}

function requireCommand(job, exactCommand) {
  assert.ok(commandsFor(job).includes(exactCommand), `缺少命令：${exactCommand}`);
}

export function assertCiWorkflowContract(workflow, manifest = packageManifest) {
  assert.deepEqual(workflow.on?.push?.branches, ["main"]);
  assert.ok(Array.isArray(workflow.on?.pull_request) || workflow.on?.pull_request === null);
  assert.equal(workflow.on?.schedule, undefined);
  assert.equal(workflow.on?.workflow_dispatch, undefined);
  assert.deepEqual(workflow.concurrency, {
    group: "ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": true,
  });
  assertSafeWorkflow(workflow);

  assert.deepEqual(Object.keys(workflow.jobs), ["ci"], "普通CI只保留一个稳定Required Job");
  const job = workflow.jobs.ci;
  assert.equal(job.name, "ci");
  assertSafeJob("ci", job);

  assert.equal(
    manifest.scripts?.bootstrap,
    "pnpm managed-sources:prepare && pnpm run setup --memory=off --workbench=off",
    "bootstrap必须同时准备固定Fork、冻结安装与核心运行工件",
  );
  for (const command of [
    "pnpm bootstrap",
    "pnpm build",
    "pnpm lint",
    "pnpm format:check",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:browser:capability-governance",
  ]) {
    requireCommand(job, command);
  }
  assert.equal(
    commandsFor(job).filter((command) => command === "pnpm bootstrap").length,
    1,
    "普通CI必须只准备一次Fork与Chat",
  );
  assert.ok(
    commandsFor(job).some((command) => command.includes("playwright install --with-deps chromium")),
    "普通CI必须准备固定Chromium",
  );

  const systemStep = job.steps.find(
    (step) => step.name === "Installed system starts, becomes healthy, and stops cleanly",
  );
  assert.ok(systemStep, "普通CI缺少完整系统启动门");
  for (const evidence of [
    "node scripts/dev/start.mjs --workbench=off",
    "http://127.0.0.1:43110/",
    "http://127.0.0.1:43111/api/readyz",
    "http://127.0.0.1:43112/healthz",
    'kill -INT "$chat_pid"',
    "pnpm dev:status",
    "本地开发环境未运行",
  ]) {
    assert.ok(systemStep.run.includes(evidence), `完整系统启动门缺少：${evidence}`);
  }
  assert.doesNotMatch(
    commandsFor(job).join("\n"),
    /(?:api-surface:check|compatibility:check|supply-chain:check|supply-chain:audit)/u,
    "普通CI不得把自定义治理器当成独立合入门",
  );
}

export function assertMaintenanceWorkflowContract(workflow) {
  assert.equal(workflow.on?.push, undefined);
  assert.equal(workflow.on?.pull_request, undefined);
  assert.deepEqual(workflow.on?.schedule, [{ cron: "23 18 * * *" }]);
  assert.ok(
    Array.isArray(workflow.on?.workflow_dispatch) || workflow.on?.workflow_dispatch === null,
  );
  assert.deepEqual(workflow.concurrency, {
    group: "maintenance-${{ github.ref }}",
    "cancel-in-progress": true,
  });
  assertSafeWorkflow(workflow);

  assert.deepEqual(Object.keys(workflow.jobs), ["maintenance"]);
  const job = workflow.jobs.maintenance;
  assert.equal(job.name, "maintenance");
  assertSafeJob("maintenance", job);
  for (const command of [
    "pnpm bootstrap",
    "pnpm build",
    "pnpm test:browser",
    "pnpm audit --prod",
  ]) {
    requireCommand(job, command);
  }
  assert.equal(
    commandsFor(job).filter((command) => command === "pnpm bootstrap").length,
    1,
    "维护门必须只准备一次Fork与Chat",
  );
  assert.ok(
    commandsFor(job).some((command) => command.includes("playwright install --with-deps chromium")),
  );
  assert.doesNotMatch(
    commandsFor(job).join("\n"),
    /(?:supply-chain:check|supply-chain:audit)/u,
    "维护门只使用标准生产依赖Audit，不替Fork审计整仓",
  );
}

describe("CI workflow baseline", () => {
  it("keeps one required Chat CI job and one scheduled maintenance job", () => {
    assertCiWorkflowContract(parseCiWorkflow(ciSource));
    assertMaintenanceWorkflowContract(parseCiWorkflow(maintenanceSource));
  });

  it("rejects duplicate Fork preparation and missing Chat completion commands", () => {
    const duplicate = structuredClone(parseCiWorkflow(ciSource));
    duplicate.jobs.ci.steps.push({ run: "pnpm bootstrap" });
    assert.throws(() => assertCiWorkflowContract(duplicate), /只准备一次/u);

    for (const command of ["pnpm build", "pnpm test", "pnpm test:browser:capability-governance"]) {
      const changed = structuredClone(parseCiWorkflow(ciSource));
      changed.jobs.ci.steps = changed.jobs.ci.steps.filter((step) => step.run?.trim() !== command);
      assert.throws(() => assertCiWorkflowContract(changed), /缺少命令/u);
    }
  });

  it("rejects tag-pinned Actions, checkout credentials, conditional skips, and paid commands", () => {
    const unsafeAction = structuredClone(parseCiWorkflow(ciSource));
    const checkout = unsafeAction.jobs.ci.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    checkout.uses = "actions/checkout@v4";
    checkout.with["persist-credentials"] = true;
    assert.throws(() => assertCiWorkflowContract(unsafeAction), /persist-credentials|完整SHA/u);

    const skipped = structuredClone(parseCiWorkflow(ciSource));
    skipped.jobs.ci.steps.find((step) => step.run?.trim() === "pnpm test").if = "false";
    assert.throws(() => assertCiWorkflowContract(skipped), /不得条件跳过/u);

    const paid = structuredClone(parseCiWorkflow(ciSource));
    paid.jobs.ci.steps.push({ run: "pnpm test:paid:provider:bailian" });
    assert.throws(() => assertCiWorkflowContract(paid), /paid或external/u);
  });

  it("rejects removal of install, health, stop, browser regression, or standard audit evidence", () => {
    for (const evidence of [
      "node scripts/dev/start.mjs --workbench=off",
      "http://127.0.0.1:43111/api/readyz",
      'kill -INT "$chat_pid"',
    ]) {
      const changed = structuredClone(parseCiWorkflow(ciSource));
      const step = changed.jobs.ci.steps.find((candidate) =>
        candidate.run?.includes("node scripts/dev/start.mjs"),
      );
      step.run = step.run.replaceAll(evidence, "removed-evidence");
      assert.throws(() => assertCiWorkflowContract(changed), /完整系统启动门缺少/u);
    }

    for (const command of ["pnpm test:browser", "pnpm audit --prod"]) {
      const changed = structuredClone(parseCiWorkflow(maintenanceSource));
      changed.jobs.maintenance.steps = changed.jobs.maintenance.steps.filter(
        (step) => step.run?.trim() !== command,
      );
      assert.throws(() => assertMaintenanceWorkflowContract(changed), /缺少命令/u);
    }
  });
});
