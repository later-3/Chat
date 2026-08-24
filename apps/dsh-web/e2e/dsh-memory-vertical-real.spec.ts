import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { DSH_MEMORY_VERTICAL_E2E_PORTS } from "../../../scripts/e2e/dsh-real-environment.mjs";
import {
  MEMORY_REAL_FACT,
  seedMemoryPlanningReal,
} from "../../../scripts/memory/seed-memory-planning-real.mjs";

const API_ORIGIN = `http://127.0.0.1:${String(DSH_MEMORY_VERTICAL_E2E_PORTS.api)}`;
const MEMMY_ORIGIN = `http://127.0.0.1:${String(DSH_MEMORY_VERTICAL_E2E_PORTS.memmy)}`;
const RUN_KEY = `memory_vertical_${Date.now().toString(36)}`;
const PREFERENCE_MARKER = `MEMORY_VERTICAL_PREFERENCE_${RUN_KEY}`;
const WRITE_ONLY_MARKER = `MEMORY_WRITE_ONLY_${RUN_KEY}`;
const WRITE_ONLY_ACK = "MEMORY_WRITE_ONLY_ACKNOWLEDGED";

interface MemoryCandidateItem {
  readonly itemKey: string;
  readonly content: string;
}

interface MemoryCandidate {
  readonly memoryAgentWriteCandidateId: string;
  readonly status: "pending_review" | "approved" | "rejected";
  readonly items: readonly MemoryCandidateItem[];
  readonly memoryWriteIntentIds?: readonly string[];
}

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

async function openConversation(page: Page): Promise<Locator> {
  await page.goto("/");
  await dismissNotice(page);
  const composer = page.locator("textarea:visible").last();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  return composer;
}

async function chooseWorkflow(page: Page, title: string): Promise<void> {
  await page.getByTestId("lifeos-workflow-current").click();
  await page.getByRole("menuitem", { name: title }).click();
  await expect(page.getByTestId("lifeos-workflow-current")).toContainText(title);
}

async function overrideDirectPrompt(request: APIRequestContext): Promise<void> {
  const currentResponse = await request.get(`${API_ORIGIN}/api/agent-profiles/direct`);
  expect(currentResponse.status(), await currentResponse.text()).toBe(200);
  const current = (await currentResponse.json()) as {
    systemPrompt: { aggregateRevision: number };
  };
  const response = await request.post(`${API_ORIGIN}/api/agent-profiles/direct/prompt-revisions`, {
    data: {
      commandId: `cmd_memoryvertical${Date.now().toString(36)}`,
      payload: {
        expectedAggregateRevision: current.systemPrompt.aggregateRevision,
        bodyMarkdown: [
          "# Memory Vertical Direct Agent",
          "",
          "只回答当前问题，不调用工具。",
          "Atlas部署代号必须从本轮Workflow Memory Context读取；答案只输出代号本身。",
          `如果用户消息包含${WRITE_ONLY_MARKER}，不要读取Memory，答案只输出${WRITE_ONLY_ACK}。`,
        ].join("\n"),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function waitForAnswerOrNextReview(
  page: Page,
  approvedRequestIndex: number,
  expectedAnswer: string,
): Promise<"answer" | number> {
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    if (
      await page
        .getByText(expectedAnswer, { exact: true })
        .last()
        .isVisible()
        .catch(() => false)
    ) {
      return "answer";
    }
    const card = page.getByTestId("lifeos-prompt-review-card");
    if (await card.isVisible().catch(() => false)) {
      const text = await card
        .getByText(/Pi Coding Agent · 第 \d+ 次发送审核/u)
        .textContent()
        .catch(() => null);
      const next = /第\s+(\d+)\s+次/u.exec(text ?? "")?.[1];
      if (next !== undefined && Number(next) > approvedRequestIndex) return Number(next);
    }
    await page.waitForTimeout(250);
  }
  throw new Error("等待真实Direct回答或下一张Provider审核卡超时");
}

async function approveProviderUntilAnswer(
  page: Page,
  expectedAnswer: string,
  memoryExpectation: "present" | "absent",
): Promise<void> {
  let requestIndex = 1;
  for (let approvedCount = 0; approvedCount < 4; approvedCount += 1) {
    const card = page.getByTestId("lifeos-prompt-review-card");
    await expect(card).toBeVisible({ timeout: 6 * 60_000 });
    await expect(
      card.getByText(`Pi Coding Agent · 第 ${String(requestIndex)} 次发送审核`, { exact: true }),
    ).toBeVisible();
    if (requestIndex === 1) {
      const readable = card.getByTestId("lifeos-prompt-readable");
      if (memoryExpectation === "present") await expect(readable).toContainText(MEMORY_REAL_FACT);
      else await expect(readable).not.toContainText("<chat_memory_context");
    }
    await card.getByTestId("lifeos-approve-prompt").click();
    const next = await waitForAnswerOrNextReview(page, requestIndex, expectedAnswer);
    if (next === "answer") return;
    requestIndex = next;
  }
  throw new Error("真实Direct Agent在4次Provider请求内没有提交Memory答案");
}

async function enterMemorySettings(page: Page): Promise<void> {
  const settings = page.locator('button[aria-haspopup="dialog"]').last();
  await expect(settings).toBeVisible({ timeout: 30_000 });
  await settings.click();
  const entry = page.getByRole("button", { name: "Memory", exact: true }).last();
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByTestId("lifeos-memory-management")).toBeVisible();
}

async function waitForCandidate(page: Page, request: APIRequestContext): Promise<MemoryCandidate> {
  const list = page.getByTestId("lifeos-memory-candidates");
  await expect(async () => {
    await page
      .getByTestId("lifeos-memory-management")
      .getByRole("button", { name: "刷新" })
      .click();
    await expect(list.locator(".lifeos-memory-list-card").first()).toBeVisible();
  }).toPass({ timeout: 6 * 60_000, intervals: [1_000, 2_000, 5_000] });
  await list.locator(".lifeos-memory-list-card").first().click();
  const detail = page.getByTestId("lifeos-memory-candidate-detail");
  await expect(detail).toBeVisible();
  const response = await request.get(
    "/lifeos/memory/write-candidates?status=pending_review&limit=100",
  );
  const responseText = await response.text();
  expect(response.status(), responseText).toBe(200);
  const candidates = (JSON.parse(responseText) as { candidates: readonly MemoryCandidate[] })
    .candidates;
  const candidate = candidates[0];
  expect(candidate?.items.length).toBeGreaterThan(0);
  if (candidate === undefined) throw new Error("页面显示了候选，但查询接口没有返回候选事实");
  for (const item of candidate.items) await expect(detail).toContainText(item.content);
  return candidate;
}

async function searchMemmy(query: string): Promise<{
  readonly sourceMemoryIds?: readonly string[];
  readonly sections?: readonly { readonly content?: string }[];
}> {
  const response = await fetch(`${MEMMY_ORIGIN}/api/v1/memory/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adapterId: "chat",
      namespace: { source: "chat", profileId: "chat-debug" },
      query,
      layers: ["L2"],
      tags: [],
      limit: 8,
      contextBudget: 4_096,
      includeInjectedContext: true,
      verbose: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await response.text();
  expect(response.status, responseText).toBe(200);
  const body = JSON.parse(responseText) as {
    debug?: {
      sourceMemoryIds?: readonly string[];
      sections?: readonly { readonly content?: string }[];
    };
  };
  return body.debug ?? {};
}

async function waitForMaterializedWrites(
  request: APIRequestContext,
  candidateId: string,
): Promise<readonly { readonly itemKey: string; readonly externalObjectId: string }[]> {
  let approved: MemoryCandidate | undefined;
  await expect(async () => {
    const response = await request.get(
      `/lifeos/memory/write-candidates/${encodeURIComponent(candidateId)}`,
    );
    const responseText = await response.text();
    expect(response.status(), responseText).toBe(200);
    approved = (JSON.parse(responseText) as { candidate: MemoryCandidate }).candidate;
    expect(approved.status).toBe("approved");
    expect(approved.memoryWriteIntentIds?.length).toBe(approved.items.length);
  }).toPass({ timeout: 60_000, intervals: [500, 1_000, 2_000] });
  if (approved?.memoryWriteIntentIds === undefined) {
    throw new Error("已批准候选缺少Memory Write Intent事实");
  }

  const materialized: { itemKey: string; externalObjectId: string }[] = [];
  for (const intentId of approved.memoryWriteIntentIds) {
    await expect(async () => {
      const response = await request.get(
        `${API_ORIGIN}/api/memory-writes/${encodeURIComponent(intentId)}`,
      );
      const responseText = await response.text();
      expect(response.status(), responseText).toBe(200);
      const memoryWrite = (
        JSON.parse(responseText) as {
          memoryWrite: {
            sourceSelection: { itemKey?: string };
            result: { status: string; externalObjectId?: string };
          };
        }
      ).memoryWrite;
      expect(memoryWrite.result.status).toBe("materialized");
      expect(memoryWrite.sourceSelection.itemKey).toBeTruthy();
      expect(memoryWrite.result.externalObjectId).toBeTruthy();
      materialized.push({
        itemKey: memoryWrite.sourceSelection.itemKey!,
        externalObjectId: memoryWrite.result.externalObjectId!,
      });
    }).toPass({ timeout: 2 * 60_000, intervals: [500, 1_000, 2_000, 5_000] });
  }
  return materialized;
}

async function approveCandidateAndAssertMaterialized(
  page: Page,
  request: APIRequestContext,
): Promise<MemoryCandidate> {
  const candidate = await waitForCandidate(page, request);
  const detail = page.getByTestId("lifeos-memory-candidate-detail");
  await detail.getByRole("button", { name: "批准并创建写入", exact: true }).click();
  await expect(detail).toContainText("approved", { timeout: 60_000 });

  const writes = await waitForMaterializedWrites(request, candidate.memoryAgentWriteCandidateId);
  for (const write of writes) {
    const item = candidate.items.find((candidateItem) => candidateItem.itemKey === write.itemKey);
    if (item === undefined) throw new Error(`写回结果引用了未知候选项：${write.itemKey}`);
    await expect(async () => {
      const result = await searchMemmy(item.content);
      expect(result.sourceMemoryIds).toContain(write.externalObjectId);
      expect(result.sections?.some((section) => section.content?.includes(item.content))).toBe(
        true,
      );
    }).toPass({ timeout: 2 * 60_000, intervals: [1_000, 2_000, 5_000] });
  }
  return candidate;
}

test.beforeAll(async ({ request }) => {
  await expect(async () => {
    const [api, memmy] = await Promise.all([
      request.get(`${API_ORIGIN}/api/readyz`),
      request.get(`${MEMMY_ORIGIN}/api/v1/health`),
    ]);
    expect(api.status(), await api.text()).toBe(200);
    expect(memmy.status(), await memmy.text()).toBe(200);
  }).toPass({ timeout: 60_000, intervals: [500, 1_000, 2_000] });
  await seedMemoryPlanningReal({
    baseUrl: MEMMY_ORIGIN,
    evidencePath: resolve(
      import.meta.dirname,
      "../../../.data/e2e/dsh-memory-vertical-real/memmy-seed-evidence.json",
    ),
  });
  await overrideDirectPrompt(request);
});

test("真实浏览器分别使用只查询、只整理与完整Memory组合工作流", async ({ page, request }) => {
  let composer = await openConversation(page);

  await chooseWorkflow(page, "只查询 Memory 后回答");
  await composer.fill("项目 Atlas 的生产部署代号是什么？答案只输出代号。");
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();
  await approveProviderUntilAnswer(page, MEMORY_REAL_FACT, "present");
  await expect(page.getByText(MEMORY_REAL_FACT, { exact: true }).last()).toBeVisible();
  const afterRead = await request.get(
    "/lifeos/memory/write-candidates?status=pending_review&limit=100",
  );
  const afterReadText = await afterRead.text();
  expect(afterRead.status(), afterReadText).toBe(200);
  expect((JSON.parse(afterReadText) as { candidates: unknown[] }).candidates).toHaveLength(0);

  await chooseWorkflow(page, "只整理为 Memory 候选");
  await composer.fill(`${WRITE_ONLY_MARKER}\n我的长期偏好是：发布前先运行真实浏览器端到端验证。`);
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();
  await approveProviderUntilAnswer(page, WRITE_ONLY_ACK, "absent");
  await expect(page.getByText(WRITE_ONLY_ACK, { exact: true }).last()).toBeVisible();
  await enterMemorySettings(page);
  await approveCandidateAndAssertMaterialized(page, request);

  await page.reload();
  await dismissNotice(page);
  composer = await openConversation(page);
  await chooseWorkflow(page, "Memory Agent 增强执行");
  const input = [
    "项目 Atlas 的生产部署代号是什么？答案只输出代号。",
    `我的长期偏好是：每次发布前先运行真实浏览器端到端验证。标记：${PREFERENCE_MARKER}`,
  ].join("\n");
  await composer.fill(input);
  await page.getByRole("button", { name: /发送消息|Send message/u }).click();
  await approveProviderUntilAnswer(page, MEMORY_REAL_FACT, "present");
  await expect(page.getByText(MEMORY_REAL_FACT, { exact: true }).last()).toBeVisible();

  await enterMemorySettings(page);
  const providers = await request.get("/lifeos/memory/providers");
  const providerText = await providers.text();
  expect(providers.status(), providerText).toBe(200);
  expect(JSON.parse(providerText)).toMatchObject({
    providers: [{ providerId: "mbk_memmy", configured: true }],
  });
  const candidate = await approveCandidateAndAssertMaterialized(page, request);

  await page.reload();
  await dismissNotice(page);
  const approved = await request.get("/lifeos/memory/write-candidates?status=approved&limit=100");
  const approvedText = await approved.text();
  expect(approved.status(), approvedText).toBe(200);
  expect(approvedText).toContain(candidate.memoryAgentWriteCandidateId);
});
