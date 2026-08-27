import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-planning-faux-real");
const completion = "PLANNING_FAUX_E2E_COMPLETED";

test("真实DSH/API/Product Store/Workflow：Faux Plan审核、刷新恢复、批准与正式Assistant", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const notice = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await notice
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await notice.click();
  }

  const composer = page.locator("textarea:visible").last();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  await composer.fill("执行确定性Planning浏览器纵向");
  const send = page.getByRole("button", { name: /发送消息|Send message/u });
  await expect(send).toBeEnabled({ timeout: 10_000 });
  await send.click();

  await expect(page.getByTestId("lifeos-plan-card")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("lifeos-run-status")).toHaveText("等待你审核");
  await expect(page.getByText("一个步骤完成确定性浏览器纵向", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("lifeos-plan-card")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("lifeos-run-status")).toHaveText("等待你审核");
  await page.getByTestId("lifeos-approve").click();

  await expect(page.getByTestId("lifeos-plan-card")).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByText(completion, { exact: true })).toBeVisible({ timeout: 120_000 });

  const snapshot = JSON.parse(
    await readFile(resolve(dataRoot, "product-store.v1.json"), "utf8"),
  ) as {
    schemaVersion: string;
    entities: {
      runs: Record<string, { status: string; phase: string }>;
      messages: Record<string, { role: string; content: { text: string }; sourceRunId?: string }>;
      decisions: Record<string, { kind: string }>;
    };
  };
  expect(snapshot.schemaVersion).toBe("chat-product-store.v20");
  expect(Object.values(snapshot.entities.runs)).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "succeeded", phase: "completed" })]),
  );
  expect(Object.values(snapshot.entities.decisions).map((decision) => decision.kind)).toEqual([
    "approve",
  ]);
  const assistants = Object.values(snapshot.entities.messages).filter(
    (message) => message.role === "assistant",
  );
  expect(assistants).toHaveLength(1);
  expect(assistants[0]?.content.text).toContain(completion);
  expect(assistants[0]?.sourceRunId).toBeDefined();

  const operationFiles = await readdir(resolve(dataRoot, "pi-executor/operations"));
  expect(operationFiles).toHaveLength(1);
  const operation = JSON.parse(
    await readFile(resolve(dataRoot, "pi-executor/operations", operationFiles[0]!), "utf8"),
  ) as {
    integrityVersion: string;
    status: string;
    events: Array<{ type: string }>;
  };
  expect(operation.integrityVersion).toBe("full-operation.v3");
  expect(operation.status).toBe("succeeded");
  expect(operation.events.map((event) => event.type)).toEqual(
    expect.arrayContaining([
      "session.started",
      "provider.started",
      "provider.completed",
      "session.settled",
      "operation.completed",
    ]),
  );

  const sentinel = JSON.parse(
    await readFile(resolve(dataRoot, "environment-sentinel.json"), "utf8"),
  ) as { providerCredentialsVisible: boolean; checked: string[] };
  expect(sentinel.providerCredentialsVisible).toBe(false);
  for (const name of ["DASHSCOPE_API_KEY", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) {
    expect(sentinel.checked).toContain(name);
  }
  const piSentinel = JSON.parse(
    await readFile(resolve(dataRoot, "pi-executor/environment-sentinel.json"), "utf8"),
  ) as { providerCredentialsVisible: boolean; checked: string[] };
  expect(piSentinel).toEqual(sentinel);
  const browserSurface = await page.evaluate(() => ({
    html: document.documentElement.innerHTML,
    storage: Object.fromEntries(Object.entries(localStorage)),
  }));
  expect(JSON.stringify(browserSurface)).not.toMatch(
    /DASHSCOPE_API_KEY|GITHUB_TOKEN|SSH_AUTH_SOCK|hookToken|workflowRunId|piSessionId/u,
  );
});
