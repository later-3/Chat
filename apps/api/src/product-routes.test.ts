import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalDtoSchema,
  decisionDtoSchema,
  messageDtoSchema,
  planDtoSchema,
  problemDetailSchema,
  runDtoSchema,
  sessionDtoSchema,
  cursorPageSchema,
  type CommandId,
  type PlanContent,
  type ProductRunId,
} from "@chat/contracts";
import {
  compilePlanningInput,
  publishPlanForReview as publishPlanForReviewUseCase,
  type ApplicationDeps,
  type IdFactory,
} from "@chat/application";
import { JsonProductStore } from "@chat/product-store-json";
import { z } from "zod";
import { createApiApp, type ApiApp } from "./app.js";
import { DEBUG_PRINCIPAL_ID } from "./composition.js";

/**
 * 公开产品API合同测试。
 *
 * 使用真实JsonProductStore（临时目录）；Plan发布属于Workflow私有命令（M2），
 * 测试通过Application用例直接播种，公开API只验证Query/Decision语义。
 */

const idCounter = 0;
const now = (): string =>
  new Date(Date.parse("2026-08-07T12:00:00.000Z") + idCounter * 1000).toISOString();

async function testApp(): Promise<{ app: ApiApp; deps: ApplicationDeps }> {
  const filePath = join(mkdtempSync(join(tmpdir(), "chat-api-product-")), "store.json");
  const store = await JsonProductStore.open({ filePath, now });
  // 合法ID工厂：不同前缀分别生成
  let n = 0;
  const gen = (prefix: string) => `${prefix}_${(++n).toString(36).padStart(4, "0")}z`;
  const idFactory = {
    session: () => gen("psn"),
    message: () => gen("msg"),
    run: () => gen("run"),
    attempt: () => gen("att"),
    plan: () => gen("pln"),
    planRevision: () => gen("plr"),
    revisionInput: () => gen("rin"),
    approval: () => gen("apr"),
    decision: () => gen("dec"),
    executionContract: () => gen("exc"),
    executionCandidate: () => gen("xcd"),
    validationResult: () => gen("val"),
    artifact: () => gen("art"),
    outbox: () => gen("obx"),
  } as IdFactory;
  const deps: ApplicationDeps = { store, now, ids: idFactory };
  const app = createApiApp({
    traceSink: null,
    product: { deps, principalId: DEBUG_PRINCIPAL_ID },
  });
  return { app, deps };
}

const planContent: PlanContent = {
  objective: "整理项目进展并生成Markdown周报",
  summary: "先归纳输入，再产出周报",
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "结构化原始输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      requestedCapabilities: [],
      risk: "low",
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  warnings: [],
};

let cmdCounter = 0;
const nextCmd = (): CommandId => `cmd_${(++cmdCounter).toString(36)}x` as CommandId;

async function postJson(app: ApiApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function publishPlanForReview(
  deps: ApplicationDeps,
  input: { productRunId: ProductRunId; commandId: CommandId; content: PlanContent },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const planRevision =
    Object.values(snapshot.entities.plans).filter(
      (plan) => plan.productRunId === input.productRunId,
    ).length + 1;
  const planning = await compilePlanningInput(deps, {
    commandId: nextCmd(),
    productRunId: input.productRunId,
    planRevision,
  });
  return publishPlanForReviewUseCase(deps, {
    ...input,
    attemptId: planning.attemptId,
    expectedRunRevision: planning.inputRunRevision,
    inputManifestSha256: planning.inputManifestSha256,
  });
}

describe("公开产品API", () => {
  it("完整链路：建Session -> 发消息 -> 查消息/运行 -> 决定", async () => {
    const { app, deps } = await testApp();

    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: unknown };
    const sessionDto = sessionDtoSchema.parse(session);

    const commandId = nextCmd();
    const sent = await postJson(app, `/api/sessions/${sessionDto.sessionId}/messages`, {
      commandId,
      payload: { text: "根据我输入的项目进展生成周报" },
    });
    expect(sent.status).toBe(201);
    const sentBody = (await sent.json()) as { message: unknown; run: unknown };
    const message = messageDtoSchema.parse(sentBody.message);
    const run = runDtoSchema.parse(sentBody.run);
    expect(message.role).toBe("user");
    expect(run.status).toBe("pending");
    expect(run.phase).toBe("queued");

    // 相同commandId重试：不新增Message/Run
    const retried = await postJson(app, `/api/sessions/${sessionDto.sessionId}/messages`, {
      commandId,
      payload: { text: "根据我输入的项目进展生成周报" },
    });
    expect(retried.status).toBe(201);
    const retriedBody = (await retried.json()) as {
      message: { messageId: string };
      run: { productRunId: string };
    };
    expect(retriedBody.message.messageId).toBe(message.messageId);
    expect(retriedBody.run.productRunId).toBe(run.productRunId);

    // 相同commandId不同payload：409 COMMAND_ID_REUSED
    const conflict = await postJson(app, `/api/sessions/${sessionDto.sessionId}/messages`, {
      commandId,
      payload: { text: "不同内容" },
    });
    expect(conflict.status).toBe(409);
    expect(problemDetailSchema.parse(await conflict.json()).code).toBe("command_id_reused");

    // 消息列表：服务端cursor分页
    const messages = await app.request(`/api/sessions/${sessionDto.sessionId}/messages`);
    expect(messages.status).toBe(200);
    const page = cursorPageSchema(messageDtoSchema).parse(await messages.json());
    expect(page.items).toHaveLength(1);

    for (const query of [
      "limit=1junk",
      "limit=1.5",
      "limit=%201",
      "limit=1&limit=2",
      "cursor=",
      "unknown=1",
    ]) {
      const invalidPage = await app.request(
        `/api/sessions/${sessionDto.sessionId}/messages?${query}`,
      );
      expect(invalidPage.status, query).toBe(400);
      expect(problemDetailSchema.parse(await invalidPage.json()).code).toBe("validation_failed");
    }

    // 播种Plan v1（私有命令路径，M2由Workflow调用）
    const published = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: nextCmd(),
      content: planContent,
    });

    const runRes = await app.request(`/api/runs/${run.productRunId}`);
    const runDetail = runDtoSchema.parse(((await runRes.json()) as { run: unknown }).run);
    expect(runDetail.status).toBe("waiting_human");
    expect(runDetail.phase).toBe("plan_review");
    expect(runDetail.allowedActions).toEqual(["request_revision", "approve", "reject"]);
    expect(runDetail.currentPlan?.planRevision).toBe(1);

    const plansRes = await app.request(`/api/runs/${run.productRunId}/plans`);
    const plans = z.object({ items: z.array(planDtoSchema) }).parse(await plansRes.json());
    expect(plans.items).toHaveLength(1);

    const approvalRes = await app.request(`/api/runs/${run.productRunId}/approvals/current`);
    const approvalBody = z
      .object({ approval: approvalDtoSchema.nullable() })
      .parse(await approvalRes.json());
    expect(approvalBody.approval?.status).toBe("open");

    // 缺少expectedRevision：400
    const missingRevision = await postJson(app, `/api/runs/${run.productRunId}/decisions`, {
      commandId: nextCmd(),
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: 1,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    expect(missingRevision.status).toBe(400);
    expect(problemDetailSchema.parse(await missingRevision.json()).code).toBe("validation_failed");

    // 正常approve：201 + running/executing
    const decided = await postJson(app, `/api/runs/${run.productRunId}/decisions`, {
      commandId: nextCmd(),
      expectedRevision: runDetail.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: 1,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    expect(decided.status).toBe(201);
    const decidedBody = (await decided.json()) as { decision: unknown; run: unknown };
    decisionDtoSchema.parse(decidedBody.decision);
    const decidedRun = runDtoSchema.parse(decidedBody.run);
    expect(decidedRun.status).toBe("running");
    expect(decidedRun.phase).toBe("executing");

    // 旧Approval重复决定：409 APPROVAL_ALREADY_DECIDED
    const duplicated = await postJson(app, `/api/runs/${run.productRunId}/decisions`, {
      commandId: nextCmd(),
      expectedRevision: decidedRun.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: 1,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    expect(duplicated.status).toBe(409);
    expect(problemDetailSchema.parse(await duplicated.json()).code).toBe(
      "approval_already_decided",
    );
  });

  it("浏览器指定Provider/模型被validation_failed拒绝", async () => {
    const { app } = await testApp();
    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const res = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "hi", provider: "bailian", model: "qwen3.7-plus" },
    });
    expect(res.status).toBe(400);
    expect(problemDetailSchema.parse(await res.json()).code).toBe("validation_failed");
  });

  it("未知资源返回not_found；公开响应不携带Runtime私有身份", async () => {
    const { app, deps } = await testApp();
    const res = await app.request("/api/runs/run_nonexistent");
    expect(res.status).toBe(404);
    expect(problemDetailSchema.parse(await res.json()).code).toBe("not_found");

    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "hi" },
    });
    const { run } = (await sent.json()) as { run: { productRunId: string } };
    await publishPlanForReview(deps, {
      productRunId: run.productRunId as ProductRunId,
      commandId: nextCmd(),
      content: planContent,
    });
    for (const path of [
      `/api/runs/${run.productRunId}`,
      `/api/runs/${run.productRunId}/plans`,
      `/api/runs/${run.productRunId}/approvals/current`,
      `/api/sessions/${session.sessionId}/messages`,
    ]) {
      const queryRes = await app.request(path);
      const text = await queryRes.text();
      expect(text).not.toContain("workflowRunId");
      expect(text).not.toContain("hookToken");
      expect(text).not.toContain("piSessionId");
      expect(text).not.toContain("dashscope");
    }
  });

  it("骨架模式（无产品上下文）下产品路由返回not_found", async () => {
    const app = createApiApp({ traceSink: null });
    const res = await app.request("/api/runs/run_1");
    expect(res.status).toBe(404);
  });
});
