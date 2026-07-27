import { expect, test } from "@playwright/test";

// 真实组件布局证据：经Vite静态路由加载仓库根的harness HTML（不进生产dist），
// 由该页面import并挂载真实ExecutionDraftWorkbench（API响应经route拦截提供fixture）。
// 覆盖390px：冻结contract只在自身pre内横滚，Workbench与页面不横溢（P2-7）。

const LONG_HASH = "ab".repeat(32);

const SECTION_KEYS = [
  "identity_lineage",
  "intent_goal",
  "project_work_binding",
  "background",
  "accepted_decisions",
  "scope",
  "plan",
  "context_binding",
  "resource_manifest",
  "runtime_target",
  "capability_grant",
  "model_envelope",
  "prompt_assembly_plan",
  "hitl_plan",
  "validation_plan",
  "output_commit_contract",
  "stop_escalation",
];

function fixtureDraft() {
  const payload: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) payload[key] = {};
  payload.validation_plan = {
    checks: ["structured intent", "repository snapshot freshness"],
    evidence: "workflow trace",
    contract: {
      plan_revision_id: "plan-revision-1",
      contract_hash: LONG_HASH,
      rules: [
        {
          ordinal: 1,
          capability_key: "pytest-suite",
          capability_version: "1.0.0",
          capability_hash: LONG_HASH,
          expanded_argv: ["-m", "pytest", "-c", "/dev/null", "--rootdir", ".", "tests", "-q"],
          expanded_argv_hash: LONG_HASH,
        },
      ],
    },
  };
  return {
    id: "harness-draft",
    status: "reviewable",
    row_version: 1,
    revision_id: "revision-1",
    revision: 1,
    revision_status: "reviewable",
    draft_hash: LONG_HASH,
    context_hash: LONG_HASH,
    execution_brief: "在隔离Workspace完成一次精确edit并通过确定性Validation。",
    payload,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/execution-drafts/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureDraft()),
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/execution-draft-workbench-harness.html");
  await expect(page.getByLabel("冻结的Validation Contract")).toBeVisible({ timeout: 20_000 });
});

test("真实Workbench在390px渲染冻结contract且不横溢", async ({ page }) => {
  const workbench = page.locator(".execution-draft-workbench");
  await expect(workbench).toBeVisible();
  const frozen = page.getByLabel("冻结的Validation Contract");
  await expect(frozen).toBeVisible();
  await expect(frozen.getByText("机器冻结的 Validation Contract（只读）")).toBeVisible();

  const workbenchOverflow = await workbench.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(workbenchOverflow).toBeLessThanOrEqual(0);
  const documentOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(documentOverflow).toBeLessThanOrEqual(0);

  const pre = frozen.locator("pre");
  await expect(pre).toBeVisible();
  const preScrollOverflow = await pre.evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(preScrollOverflow).toBeGreaterThan(0);
  const preFontSize = await pre.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).fontSize),
  );
  expect(preFontSize).toBeGreaterThanOrEqual(11);
});

test("真实冻结区域内没有输入或增删控件，验证计划其他字段仍可编辑", async ({ page }) => {
  const frozen = page.getByLabel("冻结的Validation Contract");
  await expect(frozen.locator("input")).toHaveCount(0);
  await expect(frozen.locator("textarea")).toHaveCount(0);
  await expect(frozen.locator("select")).toHaveCount(0);
  await expect(frozen.getByRole("button", { name: /添加|删除/ })).toHaveCount(0);

  const sectionBody = page.locator(".execution-draft-section--open .execution-draft-section-body");
  await expect(sectionBody.first()).toBeVisible();
  const editableOutsideFrozen = await page
    .locator(".execution-draft-workbench input, .execution-draft-workbench textarea")
    .count();
  expect(editableOutsideFrozen).toBeGreaterThan(0);
});
