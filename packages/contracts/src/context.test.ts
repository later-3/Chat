import { describe, expect, it } from "vitest";
import {
  contextPackageSchema,
  memoryAdoptionSchema,
  memoryBackendDescriptorSchema,
  memoryQuerySchema,
  memoryResultSnapshotSchema,
  runContextRequestSchema,
  workspaceInstructionsInputSchema,
  workspaceInstructionsSnapshotSchema,
} from "./context.js";
import { memoryImportBackendDescriptorSchema } from "./memory-import.js";
import {
  beginPlanningContextResponseSchema,
  compilePlanningInputRequestSchema,
  memoryQueryExecutionResultSchema,
  persistPlanningContextResultRequestSchema,
} from "./internal-runtime.js";
import { runContextMemoryDtoSchema } from "./product-api.js";

const NOW = "2026-08-08T00:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const descriptor = {
  backendId: "mbk_memmy",
  displayName: "memmy 本地记忆",
  kind: "memmy",
  adapterContractVersion: "memmy-http-query.v1",
  configured: true,
  authMode: "none",
  credentialRevision: "none",
  configurationFingerprint: SHA_A,
  capabilities: {
    query: true,
    tags: true,
    layers: ["L2"],
    maxLimit: 8,
    maxContextBudget: 1_800,
  },
} as const;

const pendingQuery = {
  schemaVersion: "memory-query.v1",
  memoryQueryId: "mqy_contract1",
  contextRequestId: "ctxr_contract1",
  productRunId: "run_contract1",
  planRevision: 1,
  backendId: "mbk_memmy",
  backendDescriptor: descriptor,
  backendDescriptorSha256: SHA_B,
  requirement: "required",
  sourceMessageSha256: SHA_A,
  tags: ["project"],
  layers: ["L2"],
  limit: 2,
  contextBudget: 512,
  status: "pending",
  startedAt: NOW,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const section = {
  externalObjectIds: ["memory-contract-1"],
  title: "已采用事实",
  kind: "policy",
  memoryLayer: "L2",
  content: "正文只允许存在于耐久 checkpoint 与 Product Store。",
  tags: ["project"],
  tokenEstimate: 16,
} as const;

describe("Context 产品合同", () => {
  it("后端描述冻结认证模式与非秘密凭据版本，不接受 endpoint、Token 或 namespace", () => {
    expect(memoryBackendDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const extra of [
      { endpoint: "http://127.0.0.1:18960" },
      { token: "secret" },
      { namespace: { profileId: "private" } },
    ]) {
      expect(memoryBackendDescriptorSchema.safeParse({ ...descriptor, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      memoryBackendDescriptorSchema.safeParse({ ...descriptor, credentialRevision: "secret value" })
        .success,
    ).toBe(false);
    expect(
      memoryBackendDescriptorSchema.safeParse({
        ...descriptor,
        authMode: "bearer",
        credentialRevision: "none",
      }).success,
    ).toBe(false);
  });

  it("Tencent MemoryCore用独立判别合同表达无标签L1查询与异步L0导入", () => {
    const tencentQuery = {
      backendId: "mbk_tencentmemorycore",
      displayName: "Tencent MemoryCore",
      kind: "tencent_memorycore",
      adapterContractVersion: "tencent-memorycore-http-query.v1",
      configured: true,
      authMode: "bearer",
      credentialRevision: "memorycore-key-v1",
      configurationFingerprint: SHA_A,
      capabilities: {
        query: true,
        tags: false,
        layers: ["L1"],
        maxLimit: 20,
        maxContextBudget: 8_192,
      },
    } as const;
    expect(memoryBackendDescriptorSchema.safeParse(tencentQuery).success).toBe(true);
    expect(
      memoryBackendDescriptorSchema.safeParse({
        ...tencentQuery,
        authMode: "none",
        credentialRevision: "none",
      }).success,
    ).toBe(false);
    expect(
      memoryBackendDescriptorSchema.safeParse({
        ...tencentQuery,
        adapterContractVersion: "memmy-http-query.v1",
      }).success,
    ).toBe(false);

    const tencentImport = {
      backendId: "mbk_tencentmemorycore",
      displayName: "Tencent MemoryCore",
      kind: "tencent_memorycore",
      adapterContractVersion: "tencent-memorycore-http-import.v1",
      configured: true,
      authMode: "bearer",
      credentialRevision: "memorycore-key-v1",
      configurationFingerprint: SHA_A,
      capabilities: {
        mode: "conversation_capture",
        layers: ["L0"],
        title: false,
        tags: false,
        maxContentChars: 8_192,
      },
    } as const;
    expect(memoryImportBackendDescriptorSchema.safeParse(tencentImport).success).toBe(true);
    expect(
      memoryImportBackendDescriptorSchema.safeParse({
        ...tencentImport,
        capabilities: { ...tencentImport.capabilities, layers: ["L2"] },
      }).success,
    ).toBe(false);
  });

  it("ContextRequest 是 revision=1 的 strict 不可变快照", () => {
    const request = {
      schemaVersion: "run-context-request.v1",
      contextRequestId: "ctxr_contract1",
      productRunId: "run_contract1",
      requestedByPrincipalId: "usr_contract1",
      sourceMessageId: "msg_contract1",
      sourceMessageSha256: SHA_A,
      memory: {
        backendId: "mbk_memmy",
        requirement: "required",
        tags: ["project"],
        layers: ["L2"],
        limit: 2,
        contextBudget: 512,
      },
      sha256: SHA_B,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(runContextRequestSchema.safeParse(request).success).toBe(true);
    expect(runContextRequestSchema.safeParse({ ...request, revision: 2 }).success).toBe(false);
    expect(runContextRequestSchema.safeParse({ ...request, provider: "bailian" }).success).toBe(
      false,
    );
  });

  it("Workspace指令输入有界，冻结后只能进入v2 ContextRequest", () => {
    const input = {
      schemaVersion: "workspace-instructions-input.v1",
      items: [{ content: "# AGENTS.md\n中文回复" }],
    };
    expect(workspaceInstructionsInputSchema.safeParse(input).success).toBe(true);
    expect(
      workspaceInstructionsInputSchema.safeParse({
        ...input,
        items: [{ content: " ".repeat(3) }],
      }).success,
    ).toBe(false);

    const snapshot = {
      schemaVersion: "workspace-instructions-snapshot.v1",
      items: [{ content: input.items[0]!.content, sha256: SHA_A }],
      totalContentCharacters: input.items[0]!.content.length,
      sha256: SHA_B,
    };
    expect(workspaceInstructionsSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      runContextRequestSchema.safeParse({
        schemaVersion: "run-context-request.v2",
        contextRequestId: "ctxr_contract2",
        productRunId: "run_contract2",
        requestedByPrincipalId: "usr_contract1",
        sourceMessageId: "msg_contract2",
        sourceMessageSha256: SHA_A,
        workspaceInstructions: snapshot,
        sha256: SHA_B,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      runContextRequestSchema.safeParse({
        schemaVersion: "run-context-request.v1",
        contextRequestId: "ctxr_contract2",
        productRunId: "run_contract2",
        requestedByPrincipalId: "usr_contract1",
        sourceMessageId: "msg_contract2",
        sourceMessageSha256: SHA_A,
        workspaceInstructions: snapshot,
        sha256: SHA_B,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it("MemoryQuery 用状态判别联合绑定 revision 与终态证据", () => {
    expect(memoryQuerySchema.safeParse(pendingQuery).success).toBe(true);
    expect(
      memoryQuerySchema.safeParse({ ...pendingQuery, externalQueryId: "not-yet-known" }).success,
    ).toBe(false);
    const completed = {
      ...pendingQuery,
      status: "completed",
      externalQueryId: "search-contract-1",
      hitCount: 1,
      adoptedCount: 1,
      tokenEstimate: 16,
      resultSetSha256: SHA_A,
      completedAt: NOW,
      revision: 2,
    };
    expect(memoryQuerySchema.safeParse(completed).success).toBe(true);
    expect(memoryQuerySchema.safeParse({ ...completed, revision: 1 }).success).toBe(false);
    const { resultSetSha256: removedHash, ...missingHash } = completed;
    expect(removedHash).toBe(SHA_A);
    expect(memoryQuerySchema.safeParse(missingHash).success).toBe(false);
    expect(
      memoryQuerySchema.safeParse({
        ...pendingQuery,
        status: "failed",
        errorCode: "memory.backend.timeout",
        completedAt: NOW,
        revision: 2,
      }).success,
    ).toBe(true);
  });

  it("Snapshot、Adoption 与ContextPackage只接受 revision=1", () => {
    const snapshot = {
      schemaVersion: "memory-result-snapshot.v1",
      memoryResultSnapshotId: "mrs_contract1",
      memoryQueryId: "mqy_contract1",
      backendId: "mbk_memmy",
      ...section,
      sha256: SHA_A,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const contextPackage = {
      schemaVersion: "context-package.v1",
      contextPackageId: "ctxp_contract1",
      contextRequestId: "ctxr_contract1",
      productRunId: "run_contract1",
      assembledForPlanRevision: 1,
      purpose: "planning",
      memoryQueryId: "mqy_contract1",
      items: [
        {
          kind: "memory_snapshot",
          memoryResultSnapshotId: "mrs_contract1",
          revision: 1,
          sha256: SHA_A,
          selection: "retrieved",
          reasonCode: "within_budget",
        },
      ],
      exclusions: [],
      sha256: SHA_B,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const adoption = {
      schemaVersion: "memory-adoption.v1",
      memoryAdoptionId: "mad_contract1",
      productRunId: "run_contract1",
      contextPackageId: "ctxp_contract1",
      memoryResultSnapshotId: "mrs_contract1",
      status: "adopted",
      reasonCode: "within_budget",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    for (const [schema, value] of [
      [memoryResultSnapshotSchema, snapshot],
      [contextPackageSchema, contextPackage],
      [memoryAdoptionSchema, adoption],
    ] as const) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, revision: 2 }).success).toBe(false);
    }
  });
});

describe("Memory Workflow 私有合同", () => {
  const dispatch = {
    memoryQueryId: "mqy_contract1",
    contextRequestId: "ctxr_contract1",
    productRunId: "run_contract1",
    productSessionId: "psn_contract1",
    backendId: "mbk_memmy",
    backendDescriptor: descriptor,
    backendDescriptorSha256: SHA_B,
    requirement: "required",
    sourceMessageSha256: SHA_A,
    queryText: "查找项目事实",
    tags: ["project"],
    layers: ["L2"],
    limit: 2,
    contextBudget: 512,
  } as const;

  it("begin 响应只在 dispatch_required 携带完整冻结查询", () => {
    expect(
      beginPlanningContextResponseSchema.safeParse({
        schemaVersion: "chat-internal-runtime.v1",
        status: "dispatch_required",
        query: dispatch,
      }).success,
    ).toBe(true);
    expect(
      beginPlanningContextResponseSchema.safeParse({
        schemaVersion: "chat-internal-runtime.v1",
        status: "none",
        query: dispatch,
      }).success,
    ).toBe(false);
  });

  it("durable query checkpoint 用 outcome 绑定成功正文或稳定错误", () => {
    const success = {
      outcome: "success",
      externalQueryId: "search-contract-1",
      hitCount: 1,
      tokenEstimate: 16,
      resultSetSha256: SHA_A,
      sections: [section],
    };
    expect(memoryQueryExecutionResultSchema.safeParse(success).success).toBe(true);
    expect(
      memoryQueryExecutionResultSchema.safeParse({
        outcome: "failure",
        errorCode: "memory.backend.timeout",
      }).success,
    ).toBe(true);
    expect(
      memoryQueryExecutionResultSchema.safeParse({
        outcome: "failure",
        errorCode: "memory.backend.timeout",
        sections: [section],
      }).success,
    ).toBe(false);
  });

  it("persist 与 compile 都必须绑定完整产品引用，拒绝Runtime私有身份", () => {
    const persisted = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_contractpersist",
      productRunId: "run_contract1",
      attemptId: "att_contract1",
      memoryQueryId: "mqy_contract1",
      result: {
        outcome: "failure",
        errorCode: "memory.backend.timeout",
      },
    };
    expect(persistPlanningContextResultRequestSchema.safeParse(persisted).success).toBe(true);
    expect(
      persistPlanningContextResultRequestSchema.safeParse({
        ...persisted,
        workflowRunId: "wf_private1",
      }).success,
    ).toBe(false);

    const compiled = {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: "cmd_contractcompile",
      productRunId: "run_contract1",
      planRevision: 1,
      contextPackageRef: {
        contextPackageId: "ctxp_contract1",
        revision: 1,
        sha256: SHA_A,
      },
      planningMemorySelectionRef: {
        planningMemorySelectionId: "pmsl_contract1",
        revision: 1,
        sha256: SHA_B,
      },
      planningProjectContextRef: {
        planningProjectContextId: "pcx_contract1",
        revision: 1,
        sha256: SHA_B,
      },
      ruleSelectionRef: {
        ruleSelectionId: "rsl_contract1",
        revision: 1,
        sha256: SHA_A,
      },
    };
    expect(compilePlanningInputRequestSchema.safeParse(compiled).success).toBe(true);
    expect(
      compilePlanningInputRequestSchema.safeParse({
        ...compiled,
        contextPackageRef: { ...compiled.contextPackageRef, revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      compilePlanningInputRequestSchema.safeParse({
        ...compiled,
        planningMemorySelectionRef: {
          ...compiled.planningMemorySelectionRef,
          snapshots: ["正文不能由Workflow提交"],
        },
      }).success,
    ).toBe(false);
    expect(
      compilePlanningInputRequestSchema.safeParse({
        ...compiled,
        ruleSelectionRef: { ...compiled.ruleSelectionRef, body: "不能由Workflow注入正文" },
      }).success,
    ).toBe(false);
  });
});

describe("Run Context 公开投影合同", () => {
  const base = {
    backendId: "mbk_memmy",
    requirement: "optional",
    memoryQueryId: "mqy_contract1",
  } as const;

  it("queryStatus严格绑定公开计数或错误，不允许不可能状态", () => {
    expect(runContextMemoryDtoSchema.safeParse({ ...base, queryStatus: "pending" }).success).toBe(
      true,
    );
    expect(
      runContextMemoryDtoSchema.safeParse({
        ...base,
        queryStatus: "completed",
        hitCount: 1,
        adoptedCount: 1,
      }).success,
    ).toBe(true);
    expect(
      runContextMemoryDtoSchema.safeParse({
        ...base,
        queryStatus: "failed",
        errorCode: "memory.backend.timeout",
      }).success,
    ).toBe(true);
    expect(
      runContextMemoryDtoSchema.safeParse({
        ...base,
        queryStatus: "pending",
        errorCode: "memory.backend.timeout",
      }).success,
    ).toBe(false);
    expect(
      runContextMemoryDtoSchema.safeParse({ ...base, queryStatus: "completed", hitCount: 1 })
        .success,
    ).toBe(false);
    expect(runContextMemoryDtoSchema.safeParse({ ...base, queryStatus: "failed" }).success).toBe(
      false,
    );
  });
});
