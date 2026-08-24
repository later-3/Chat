import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parseDocument } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowSource = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
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
    "CI workflow必须是可可靠解析且无重复key的YAML",
  );
  const workflow = document.toJS();
  assert.ok(workflow !== null && typeof workflow === "object" && !Array.isArray(workflow));
  return workflow;
}

export function assertCiWorkflowContract(workflow) {
  assert.deepEqual(workflow.on?.push?.branches, ["main"]);
  assert.ok(Array.isArray(workflow.on?.pull_request) || workflow.on?.pull_request === null);
  assert.deepEqual(workflow.on?.schedule, [{ cron: "23 18 * * *" }]);
  assert.ok(
    Array.isArray(workflow.on?.workflow_dispatch) || workflow.on?.workflow_dispatch === null,
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": true,
  });
  assert.equal(workflow.env?.CI, "true");
  for (const name of REQUIRED_EMPTY_ENV) assert.equal(workflow.env?.[name], "", `${name}必须清空`);
  for (const name of REQUIRED_DISABLED_ENV) {
    assert.equal(workflow.env?.[name], "0", `${name}必须关闭`);
  }

  assert.ok(workflow.jobs !== null && typeof workflow.jobs === "object");
  const jobs = Object.entries(workflow.jobs);
  assert.ok(jobs.length > 0);
  for (const requiredJob of ["core", "contract", "integration", "compat", "browser"]) {
    assert.ok(workflow.jobs[requiredJob] !== undefined, `CI缺少${requiredJob} lane Job`);
  }
  const commandsFor = (name) =>
    workflow.jobs[name].steps
      .filter((step) => typeof step?.run === "string")
      .map((step) => step.run.trim());
  assert.ok(commandsFor("core").includes("pnpm verify:core"));
  assert.ok(commandsFor("contract").includes("pnpm test:contract"));
  assert.ok(commandsFor("integration").includes("pnpm test:integration"));
  assert.ok(commandsFor("browser").includes("pnpm test:browser"));
  assert.ok(
    commandsFor("browser").some((command) =>
      command.includes("playwright install --with-deps chromium"),
    ),
  );
  assert.ok(commandsFor("compat").includes("pnpm test:compat"));
  const compatDecision = workflow.jobs.compat.steps.find((step) => step.id === "compat");
  assert.equal(compatDecision?.run, "node scripts/ci/compat-change-gate.mjs");
  for (const step of workflow.jobs.compat.steps.filter((step) =>
    ["pnpm managed-sources:prepare", "pnpm test:compat"].includes(step?.run?.trim()),
  )) {
    assert.equal(step.if, "steps.compat.outputs.run == 'true'");
  }
  for (const [jobName, job] of jobs) {
    assert.equal(job.permissions, undefined, `${jobName}不得扩大根permissions`);
    assert.ok(Array.isArray(job.steps), `${jobName}.steps必须是数组`);

    const checkoutSteps = job.steps.filter(
      (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );
    assert.equal(checkoutSteps.length, 1, `${jobName}必须精确checkout一次Chat`);
    assert.equal(
      checkoutSteps[0].with?.["persist-credentials"],
      false,
      `${jobName} checkout必须关闭persist-credentials`,
    );

    const prepareSteps = job.steps.filter(
      (step) => typeof step?.run === "string" && step.run.trim() === "pnpm managed-sources:prepare",
    );
    assert.equal(prepareSteps.length, 1, `${jobName}必须精确准备一次Managed Sources`);

    for (const step of job.steps) {
      if (typeof step?.uses === "string" && !step.uses.startsWith("./")) {
        assert.match(step.uses, /^[^@\s]+@[0-9a-f]{40}$/u, `${jobName} Action必须固定完整SHA`);
      }
      if (typeof step?.run === "string") {
        assert.doesNotMatch(
          step.run,
          /(?:CHAT_ALLOW_PAID_TESTS=1|CHAT_ALLOW_EXTERNAL_WRITES=1|:paid\b|test:provider:|test:external:)/u,
          `${jobName}普通CI不得运行paid或external入口`,
        );
      }
    }
  }
}

describe("CI workflow baseline", () => {
  it("validates the real YAML structure, job preparation, actions, and safe environment", () => {
    assertCiWorkflowContract(parseCiWorkflow(workflowSource));
  });

  it("rejects the old false-positive shape where one job prepares twice and another never does", () => {
    const workflow = structuredClone(parseCiWorkflow(workflowSource));
    const jobs = Object.values(workflow.jobs);
    const firstPrepare = jobs[0].steps.find(
      (step) => typeof step?.run === "string" && step.run.trim() === "pnpm managed-sources:prepare",
    );
    jobs[0].steps.push(structuredClone(firstPrepare));
    jobs[1].steps = jobs[1].steps.filter(
      (step) =>
        !(typeof step?.run === "string" && step.run.trim() === "pnpm managed-sources:prepare"),
    );
    assert.throws(() => assertCiWorkflowContract(workflow), /精确准备一次/u);
  });

  it("rejects tag-pinned actions and checkout credentials", () => {
    const workflow = structuredClone(parseCiWorkflow(workflowSource));
    const firstJob = Object.values(workflow.jobs)[0];
    const checkout = firstJob.steps.find((step) => step?.uses?.startsWith("actions/checkout@"));
    checkout.uses = "actions/checkout@v4";
    checkout.with["persist-credentials"] = true;
    assert.throws(() => assertCiWorkflowContract(workflow), /persist-credentials|完整SHA/u);
  });
});
