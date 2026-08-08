import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalDtoSchema,
  beginPlanningContextResponseSchema,
  decisionDtoSchema,
  messageDtoSchema,
  planDtoSchema,
  preparePlanningContextResponseSchema,
  problemDetailSchema,
  runDtoSchema,
  sessionDtoSchema,
  cursorPageSchema,
  memoryBackendProfileDtoSchema,
  memoryImportDtoSchema,
  memoryImportResultResponseSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  runContextDtoSchema,
  type CommandId,
  type PlanContent,
  type ProductRunId,
} from "@chat/contracts";
import {
  compilePlanningInput,
  normalizeMemoryQueryResult,
  updateOutboxStatus,
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
  const backend = {
    describe: () => ({
      backendId: "mbk_memmy" as never,
      displayName: "memmy 本地记忆",
      kind: "memmy" as const,
      adapterContractVersion: "memmy-http-query.v1" as const,
      authMode: "bearer" as const,
      credentialRevision: "api-test-key-1",
      configurationFingerprint: "f".repeat(64),
      configured: true,
      capabilities: {
        query: true as const,
        tags: true as const,
        layers: ["L2"] as const,
        maxLimit: 20,
        maxContextBudget: 8192,
      },
    }),
    health: async () => ({ status: "ready" as const }),
    query: async () => ({
      externalQueryId: "search-test-1",
      hitCount: 1,
      tokenEstimate: 12,
      sections: [
        {
          externalObjectIds: ["memory-test-1"],
          title: "测试来源",
          kind: "trace" as const,
          memoryLayer: "L2" as const,
          content: "只用于API合同测试的记忆正文",
          tags: ["api-test"],
          score: 0.9,
          tokenEstimate: 12,
        },
      ],
    }),
    describeImport: () => ({
      descriptor: {
        backendId: "mbk_memmy" as never,
        displayName: "memmy 本地记忆",
        kind: "memmy" as const,
        adapterContractVersion: "memmy-http-import.v1" as const,
        authMode: "bearer" as const,
        credentialRevision: "api-test-key-1" as never,
        configurationFingerprint: "f".repeat(64) as never,
        configured: true,
        capabilities: {
          mode: "explicit_fact" as const,
          layers: ["L2"] as ["L2"],
          title: true as const,
          tags: true as const,
          maxContentChars: 50_000,
        },
      },
    }),
    import: async () => ({
      externalObjectId: "memory-import-api-1",
      responseSha256: "a".repeat(64),
    }),
    reconcile: async () => ({
      status: "outcome_unknown" as const,
      errorCode: "memory.import.test_unknown",
    }),
  };
  const deps: ApplicationDeps = {
    store,
    now,
    ids: idFactory,
    memoryBackends: {
      list: () => [backend],
      get: (backendId) => (backendId === "mbk_memmy" ? backend : undefined),
    },
    memoryImportBackends: {
      list: () => [backend],
      get: (backendId) => (backendId === "mbk_memmy" ? backend : undefined),
    },
  };
  const app = createApiApp({
    traceSink: null,
    product: { deps, principalId: DEBUG_PRINCIPAL_ID },
    internalRuntime: { credential: "rtk_test" },
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

async function postInternal(app: ApiApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat-runtime-key": "rtk_test" },
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

  it("显式导入Message原子创建Intent/Result/Outbox，并按command与语义双重幂等", async () => {
    const { app, deps } = await testApp();
    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "M2 canary：发布前必须完成真实浏览器验收。" },
    });
    const message = messageDtoSchema.parse(((await sent.json()) as { message: unknown }).message);
    expect(message.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const payload = {
      sourceSelection: {
        kind: "full_message" as const,
        sourceMessageId: message.messageId,
        sourceMessageSha256: message.sha256!,
      },
      backendId: "mbk_memmy",
      title: " M2 验收规则 ",
      tags: ["Release", "m2", "release"],
    };
    const commandId = nextCmd();
    const imported = await postJson(app, "/api/memory-imports", { commandId, payload });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const first = memoryImportDtoSchema.parse(
      ((await imported.json()) as { memoryImport: unknown }).memoryImport,
    );
    expect(first).toMatchObject({
      status: "queued",
      sourceMessageId: message.messageId,
      title: "M2 验收规则",
      tags: ["m2", "release"],
      allowedActions: [],
    });

    const replayed = await postJson(app, "/api/memory-imports", { commandId, payload });
    expect(
      memoryImportDtoSchema.parse(
        ((await replayed.json()) as { memoryImport: unknown }).memoryImport,
      ).memoryImportIntentId,
    ).toBe(first.memoryImportIntentId);
    const semanticDuplicate = await postJson(app, "/api/memory-imports", {
      commandId: nextCmd(),
      payload,
    });
    expect(
      memoryImportDtoSchema.parse(
        ((await semanticDuplicate.json()) as { memoryImport: unknown }).memoryImport,
      ).memoryImportIntentId,
    ).toBe(first.memoryImportIntentId);

    const listed = await app.request(`/api/sessions/${session.sessionId}/memory-imports`);
    const listedBody = (await listed.json()) as { memoryImports: unknown[] };
    expect(listedBody.memoryImports).toHaveLength(1);
    expect(JSON.stringify(listedBody)).not.toContain("api-test-key-1");
    expect(JSON.stringify(listedBody)).not.toContain("configurationFingerprint");

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const intent = snapshot.entities.memoryImportIntents[first.memoryImportIntentId];
    if (intent === undefined) throw new Error("缺少Memory Import Intent");
    expect(Object.keys(snapshot.entities.memoryImportIntents)).toHaveLength(1);
    expect(Object.keys(snapshot.entities.memoryImportResults)).toHaveLength(1);
    expect(
      Object.values(snapshot.outbox).filter((entry) => entry.kind === "memory_import_start"),
    ).toHaveLength(1);

    const wrongIdentity = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/mark-dispatching",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: "mii_wrongidentity1",
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: 1,
      },
    );
    expect(wrongIdentity.status).toBe(409);

    const mark = await postInternal(app, "/internal/runtime/v1/memory-import/mark-dispatching", {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
      commandId: nextCmd(),
      memoryImportIntentId: first.memoryImportIntentId,
      memoryImportResultId: first.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: 1,
    });
    const dispatching = memoryImportResultResponseSchema.parse(await mark.json()).result;
    expect(dispatching).toMatchObject({ status: "dispatching", revision: 2, dispatchAttempts: 1 });

    const acceptedResponse = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/commit-accepted",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: first.memoryImportIntentId,
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: dispatching.revision,
        accepted: {
          externalObjectId: "memory-api-1",
          externalStatus: "activated",
          responseSha256: "b".repeat(64),
        },
      },
    );
    const acceptedResult = memoryImportResultResponseSchema.parse(
      await acceptedResponse.json(),
    ).result;
    expect(acceptedResult).toMatchObject({ status: "accepted", revision: 3 });
    expect("dispatchStartedAt" in acceptedResult).toBe(false);

    const overwriteAcceptedIdentity = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/commit-materialized",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: first.memoryImportIntentId,
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: acceptedResult.revision,
        accepted: {
          externalObjectId: "memory-api-overwrite",
          externalStatus: "activated",
          responseSha256: "b".repeat(64),
        },
        verificationKind: "read_by_id_and_search",
        verificationSha256: "c".repeat(64),
      },
    );
    expect(overwriteAcceptedIdentity.status).toBe(409);

    const firstReconcile = await postJson(
      app,
      `/api/memory-imports/${first.memoryImportIntentId}/reconcile`,
      {
        commandId: nextCmd(),
        expectedRevision: acceptedResult.revision,
        payload: {},
      },
    );
    expect(firstReconcile.status).toBe(202);
    let afterReconcile = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const reconcileOutbox = Object.values(afterReconcile.outbox).find(
      (entry) => entry.kind === "memory_import_reconcile",
    );
    expect(reconcileOutbox).toBeDefined();
    await updateOutboxStatus(deps, {
      commandId: nextCmd(),
      outboxId: reconcileOutbox!.outboxId,
      status: "acknowledged",
      incrementDispatchAttempts: true,
    });
    const duplicateReconcile = await postJson(
      app,
      `/api/memory-imports/${first.memoryImportIntentId}/reconcile`,
      {
        commandId: nextCmd(),
        expectedRevision: acceptedResult.revision,
        payload: {},
      },
    );
    expect(duplicateReconcile.status).toBe(202);
    afterReconcile = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(afterReconcile.outbox).filter(
        (entry) => entry.kind === "memory_import_reconcile",
      ),
    ).toHaveLength(1);

    const materializedResponse = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/commit-materialized",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: first.memoryImportIntentId,
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: acceptedResult.revision,
        accepted: {
          externalObjectId: "memory-api-1",
          externalStatus: "activated",
          responseSha256: "b".repeat(64),
        },
        verificationKind: "read_by_id_and_search",
        verificationSha256: "c".repeat(64),
        reconciled: true,
      },
    );
    const materializedResult = memoryImportResultResponseSchema.parse(
      await materializedResponse.json(),
    ).result;
    expect(materializedResult).toMatchObject({
      status: "materialized",
      revision: 4,
      reconcileAttempts: 1,
    });
  });

  it("浏览器不能向Memory Import注入layer、endpoint、operationId、状态或凭据", async () => {
    const { app } = await testApp();
    const response = await postJson(app, "/api/memory-imports", {
      commandId: nextCmd(),
      payload: {
        sourceSelection: {
          kind: "full_message",
          sourceMessageId: "msg_injected",
          sourceMessageSha256: "a".repeat(64),
        },
        backendId: "mbk_memmy",
        title: "非法注入",
        tags: [],
        layer: "L3",
        endpoint: "https://attacker.invalid",
        operationId: "mii_attacker",
        status: "materialized",
        token: "never-accept",
      },
    });
    expect(response.status).toBe(400);
    expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
  });

  it("安全列出Memory后端并恢复Run Context来源，不暴露服务配置", async () => {
    const { app, deps } = await testApp();
    const backendsResponse = await app.request("/api/memory-backends");
    expect(backendsResponse.status).toBe(200);
    const backendBody = z
      .object({ backends: z.array(memoryBackendProfileDtoSchema) })
      .parse(await backendsResponse.json());
    expect(backendBody.backends[0]?.backendId).toBe("mbk_memmy");
    expect(JSON.stringify(backendBody)).not.toContain("baseUrl");
    expect(JSON.stringify(backendBody)).not.toContain("token");
    expect(JSON.stringify(backendBody)).not.toContain("authMode");
    expect(JSON.stringify(backendBody)).not.toContain("api-test-key-1");

    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: {
        text: "使用测试记忆规划",
        context: {
          memory: {
            backendId: "mbk_memmy",
            requirement: "required",
            tags: ["api-test"],
            layers: ["L2"],
            limit: 3,
            contextBudget: 512,
          },
        },
      },
    });
    expect(sent.status).toBe(201);
    const { run } = (await sent.json()) as { run: { productRunId: ProductRunId } };
    const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowAttempt = Object.values(snapshot.entities.attempts).find(
      (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
    );
    expect(workflowAttempt).toBeDefined();
    if (workflowAttempt === undefined) throw new Error("缺少Workflow Attempt");
    const beginResponse = await postInternal(app, "/internal/runtime/v1/begin-planning-context", {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: nextCmd(),
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    expect(beginResponse.status).toBe(200);
    const begun = beginPlanningContextResponseSchema.parse(await beginResponse.json());
    // begin只冻结派发意图；若Router直接调用外部Memory，这里会错误地返回ready。
    if (begun.status !== "dispatch_required") throw new Error("缺少Memory查询派发");
    const backend = deps.memoryBackends?.get(begun.query.backendId);
    if (backend === undefined) throw new Error("缺少Memory测试后端");
    const output = await backend.query({
      operationId: begun.query.memoryQueryId,
      productRunId: begun.query.productRunId,
      productSessionId: begun.query.productSessionId,
      query: begun.query.queryText,
      tags: begun.query.tags,
      layers: begun.query.layers,
      limit: begun.query.limit,
      contextBudget: begun.query.contextBudget,
    });
    const persistResponse = await postInternal(
      app,
      "/internal/runtime/v1/persist-planning-context-result",
      {
        schemaVersion: "chat-internal-runtime.v1",
        commandId: nextCmd(),
        productRunId: run.productRunId,
        attemptId: workflowAttempt.attemptId,
        memoryQueryId: begun.query.memoryQueryId,
        result: normalizeMemoryQueryResult(begun.query, output),
      },
    );
    expect(persistResponse.status).toBe(200);
    expect(preparePlanningContextResponseSchema.parse(await persistResponse.json()).status).toBe(
      "ready",
    );

    const contextResponse = await app.request(`/api/runs/${run.productRunId}/context`);
    expect(contextResponse.status).toBe(200);
    const context = runContextDtoSchema.parse(
      ((await contextResponse.json()) as { context: unknown }).context,
    );
    expect(context.memory?.queryStatus).toBe("completed");
    expect(context.contextPackage?.sources).toHaveLength(1);
    expect(context.contextPackage?.sources[0]?.title).toBe("测试来源");
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("只用于API合同测试的记忆正文");
    expect(serialized).not.toContain("memory-test-1");
  });

  it("Memory选择拒绝浏览器提交endpoint、Token和namespace", async () => {
    const { app } = await testApp();
    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const response = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: {
        text: "非法配置",
        context: {
          memory: {
            backendId: "mbk_memmy",
            requirement: "optional",
            tags: [],
            layers: ["L2"],
            limit: 3,
            contextBudget: 512,
            endpoint: "https://evil.example",
            token: "secret",
            namespace: { userId: "other" },
          },
        },
      },
    });
    expect(response.status).toBe(400);
    expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
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
