import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DSH_CAPABILITY_GOVERNANCE_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-capability-governance-real");
const productStorePath = resolve(dataRoot, "product-store.v1.json");
const toolOutputPath = resolve(dataRoot, "tool-output.txt");
const handlerInvocationPath = resolve(dataRoot, "handler-invocations.log");
const rejectedHandlerInvocationPath = resolve(dataRoot, "rejected-handler-invocations.log");
const environmentSentinelPath = resolve(dataRoot, "pi-environment-sentinel.json");
const resultLossMarkerPath = resolve(dataRoot, "product-result-response-loss.injected");

test.describe.configure({ mode: "serial" });

async function dismissNotice(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await button
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await button.click();
  }
}

async function selectDirectWorkflow(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/");
  await dismissNotice(page);
  const composer = page.locator("textarea:visible").last();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  await page.getByTestId("lifeos-workflow-current").click();
  await page.getByRole("menuitem", { name: /执行 Agent（逐次提示词审核）/u }).click();
  await page.getByTestId("lifeos-workflow-config-open").click();
  const configuration = page.getByRole("dialog", { name: /配置 · 执行 Agent/u });
  const promptReview = configuration.getByRole("switch", {
    name: "发送前审核提示词，当前开启",
  });
  if (await promptReview.isVisible()) await promptReview.click();
  await configuration.getByRole("button", { name: "应用到当前会话", exact: true }).click();
  return composer;
}

test.beforeAll(async ({ request }) => {
  await expect(async () => {
    const response = await request.get(
      `http://127.0.0.1:${String(DSH_CAPABILITY_GOVERNANCE_E2E_PORTS.api)}/api/readyz`,
    );
    expect(response.status(), await response.text()).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [500, 1_000] });
});

test("真实DSH重复批准仍handler一次，并在Product Result响应未知窗口杀进程恢复", async ({
  page,
  request,
}) => {
  const composer = await selectDirectWorkflow(page);

  await composer.fill("执行确定性Capability治理纵向");
  await page.getByRole("button", { name: "Send message", exact: true }).click();

  const card = page.getByTestId("lifeos-tool-review-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  const details = card.getByTestId("lifeos-tool-review-details");
  await expect(details).toContainText("pi_direct:tool:builtin:bash");
  await expect(details).toContainText("影响：shell");
  await expect(details).toContainText("Scope：workspace:root_chat");
  await expect(details).toContainText("参数 Hash：");
  await expect(details).toContainText("handler-invocations.log");

  // 同一浏览器事件循环内重复提交批准；Controller必须同步设置submitting，第二次调用
  // 在任何HTTP前返回false，不能制造第二个Decision、claim或handler执行。
  await card.getByTestId("lifeos-approve-tool").evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect(card).toBeHidden({ timeout: 30_000 });
  await expect(async () => expect(await access(resultLossMarkerPath)).toBeUndefined()).toPass({
    timeout: 60_000,
    intervals: [100, 250],
  });
  expect((await readFile(handlerInvocationPath, "utf8")).trim().split("\n")).toEqual([
    "approved-handler",
  ]);

  const restarted = await request.post(
    `http://127.0.0.1:${String(DSH_CAPABILITY_GOVERNANCE_E2E_PORTS.piControl)}/restart`,
    { headers: { "x-capability-e2e-control": "capability-e2e-control" } },
  );
  expect(restarted.status(), await restarted.text()).toBe(204);
  await expect(async () => {
    const health = await request.get(
      `http://127.0.0.1:${String(DSH_CAPABILITY_GOVERNANCE_E2E_PORTS.piExecutor)}/healthz`,
    );
    expect(health.status()).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [200, 500] });

  expect(await readFile(toolOutputPath, "utf8")).toBe("CAPABILITY_GOVERNANCE_E2E_ONCE\n");
  const snapshot = JSON.parse(await readFile(productStorePath, "utf8")) as {
    schemaVersion: string;
    entities: {
      runs: Record<string, { status: string }>;
      toolExecutionIntents: Record<string, { status: string; inputSha256: string }>;
      toolExecutionDecisions: Record<
        string,
        { kind: string; inputSha256: string; capabilityDescriptorSha256: string }
      >;
      toolExecutionResults: Record<string, { outcome: string; resultSha256?: string }>;
    };
  };
  expect(snapshot.schemaVersion).toBe("chat-product-store.v23");
  const intents = Object.values(snapshot.entities.toolExecutionIntents);
  const decisions = Object.values(snapshot.entities.toolExecutionDecisions);
  const results = Object.values(snapshot.entities.toolExecutionResults);
  expect(intents).toHaveLength(1);
  expect(decisions).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(intents[0]?.status).toBe("completed");
  expect(decisions[0]).toMatchObject({ kind: "approve", inputSha256: intents[0]?.inputSha256 });
  expect(decisions[0]?.capabilityDescriptorSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(results[0]?.outcome).toBe("completed");
  expect(results[0]?.resultSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect((await readFile(handlerInvocationPath, "utf8")).trim().split("\n")).toHaveLength(1);
  const sentinel = JSON.parse(await readFile(environmentSentinelPath, "utf8")) as {
    providerCredentialsVisible: boolean;
    checked: string[];
  };
  expect(sentinel.providerCredentialsVisible).toBe(false);
  expect(sentinel.checked).toContain("DASHSCOPE_API_KEY");
  await expect(access(resultLossMarkerPath)).resolves.toBeUndefined();

  const operationFiles = (await readdir(resolve(dataRoot, "pi-executor/direct-operations"))).filter(
    (name) => name.endsWith(".json"),
  );
  expect(operationFiles).toHaveLength(1);
  const journal = JSON.parse(
    await readFile(resolve(dataRoot, "pi-executor/direct-operations", operationFiles[0]!), "utf8"),
  ) as { events: Array<{ type: string; capability?: { ref: unknown } }> };
  const journalIntent = journal.events.find((event) => event.type === "tool.intent_persisted");
  expect(journalIntent?.capability?.ref).toEqual(
    (intents[0] as unknown as { capability: { ref: unknown } }).capability.ref,
  );
});

test("DSH拒绝精确Tool Decision后handler零执行且Pi收到tool.blocked", async ({ page }) => {
  const composer = await selectDirectWorkflow(page);
  await composer.fill("拒绝本次确定性Capability动作");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const card = page.getByTestId("lifeos-tool-review-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("lifeos-tool-review-details")).toContainText(
    "rejected-handler-invocations.log",
  );
  await card.getByTestId("lifeos-reject-tool").click();
  await expect(card).toBeHidden({ timeout: 30_000 });
  await expect(page.getByText("CAPABILITY_GOVERNANCE_E2E_REJECTED", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(access(rejectedHandlerInvocationPath)).rejects.toThrow();
  const snapshot = JSON.parse(await readFile(productStorePath, "utf8")) as {
    entities: {
      toolExecutionIntents: Record<string, { status: string }>;
      toolExecutionDecisions: Record<string, { kind: string }>;
      toolExecutionResults: Record<string, { outcome: string }>;
    };
  };
  expect(
    Object.values(snapshot.entities.toolExecutionIntents)
      .map((item) => item.status)
      .sort(),
  ).toEqual(["completed", "rejected"]);
  expect(
    Object.values(snapshot.entities.toolExecutionDecisions)
      .map((item) => item.kind)
      .sort(),
  ).toEqual(["approve", "reject"]);
  expect(Object.values(snapshot.entities.toolExecutionResults)).toHaveLength(1);
});

test("再次重启不重复执行已闭合handler", async ({ request }) => {
  const beforeStore = await readFile(productStorePath, "utf8");
  const beforeInvocations = await readFile(handlerInvocationPath, "utf8");
  const restarted = await request.post(
    `http://127.0.0.1:${String(DSH_CAPABILITY_GOVERNANCE_E2E_PORTS.piControl)}/restart`,
    { headers: { "x-capability-e2e-control": "capability-e2e-control" } },
  );
  expect(restarted.status(), await restarted.text()).toBe(204);
  await expect(async () => {
    const health = await request.get(
      `http://127.0.0.1:${String(DSH_CAPABILITY_GOVERNANCE_E2E_PORTS.piExecutor)}/healthz`,
    );
    expect(health.status()).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [200, 500] });
  expect(await readFile(handlerInvocationPath, "utf8")).toBe(beforeInvocations);
  expect(await readFile(productStorePath, "utf8")).toBe(beforeStore);
});
