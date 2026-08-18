import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  beginWorkflowMemoryQueryResponseSchema,
  persistWorkflowMemoryQueryResultResponseSchema,
  workflowMemoryContextIdSchema,
  workflowMemoryQueryIdSchema,
  workflowMemoryQueryNodeConfigSchema,
  workflowMemoryQuerySchema,
  workflowMemorySnapshotIdSchema,
  workflowMemorySnapshotSchema,
  type BeginWorkflowMemoryQueryRequest,
  type BeginWorkflowMemoryQueryResponse,
  type FreezeWorkflowMemoryContextRequest,
  type FreezeWorkflowMemoryContextResponse,
  type NodeProductRef,
  type PersistWorkflowMemoryQueryResultRequest,
  type PersistWorkflowMemoryQueryResultResponse,
  type WorkflowMemoryQuery,
  type WorkflowMemoryQueryDispatchDto,
  type WorkflowMemoryQueryExecutionResult,
  type WorkflowMemorySnapshot,
} from "@chat/contracts";
import {
  assertWorkflowMemoryContextOrder,
  computeMemoryProviderDescriptorSha256,
  computeWorkflowMemoryContextSha256,
  computeWorkflowMemoryMessageSha256,
  computeWorkflowMemoryQueryResultSha256,
  computeWorkflowMemorySnapshotSha256,
  hashCanonical,
  normalizeWorkflowMemorySections,
  sha256Hex,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, notFound, revisionConflict } from "./errors.js";
import { commitPlanningContextNodeFact } from "./planning-context-node-facts.js";
import { requirePlanningRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";
import { emitWorkflowMemoryNodeTrace } from "./workflow-memory-trace.js";

function queryIdentity(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
}) {
  return {
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    definitionNodeId: input.definitionNodeId,
    executionPath: input.executionPath,
    attemptNumber: input.attemptNumber,
  };
}

function derivedQueryId(input: ReturnType<typeof queryIdentity>) {
  return workflowMemoryQueryIdSchema.parse(
    `wmq_${hashCanonical("id.workflow-memory-query.v1", input).slice(0, 32)}`,
  );
}

function dispatchDto(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  query: WorkflowMemoryQuery,
): WorkflowMemoryQueryDispatchDto {
  const message = snapshot.entities.messages[query.sourceMessageId];
  if (message === undefined || sha256Hex(message.content.text) !== query.querySha256) {
    throw revisionConflict("Workflow Memory Query来源消息不存在或已变化");
  }
  return {
    workflowMemoryQueryId: query.workflowMemoryQueryId,
    operationId: query.operationId,
    productRunId: query.productRunId,
    productSessionId: query.productSessionId,
    principalId: query.requestedByPrincipalId,
    workflowRunSpecId: query.workflowRunSpecId,
    definitionNodeId: query.definitionNodeId,
    providerId: query.providerId,
    providerDescriptor: query.providerDescriptor,
    providerDescriptorSha256: query.providerDescriptorSha256,
    requirement: query.requirement,
    sourceMessageId: query.sourceMessageId,
    sourceMessageSha256: query.sourceMessageSha256,
    querySha256: query.querySha256,
    queryText: message.content.text,
    maxResults: query.maxResults,
    maxContextCharacters: query.maxContextCharacters,
  };
}

function terminalQueryStatus(
  query: WorkflowMemoryQuery,
): BeginWorkflowMemoryQueryResponse["status"] {
  if (query.status === "completed") return "completed";
  if (query.status === "failed") {
    return query.requirement === "required" ? "required_failed" : "optional_failed";
  }
  return "dispatch_required";
}

/**
 * 冻结单个memory.query节点的Provider合同与来源消息。该事务不调用外部服务；
 * Workflow重放只会拿到同一个wmq_*，不会产生第二个查询身份。
 */
export async function beginWorkflowMemoryQuery(
  deps: ApplicationDeps,
  input: Omit<BeginWorkflowMemoryQueryRequest, "schemaVersion">,
): Promise<BeginWorkflowMemoryQueryResponse> {
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const existingId = derivedQueryId(queryIdentity(input));
  const existing = before.entities.workflowMemoryQueries[existingId];
  if (existing !== undefined) {
    const status = terminalQueryStatus(existing);
    return beginWorkflowMemoryQueryResponseSchema.parse({
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      status,
      workflowMemoryQueryId: existing.workflowMemoryQueryId,
      productRunId: existing.productRunId,
      workflowRunSpecId: existing.workflowRunSpecId,
      ...(status === "dispatch_required" ? { query: dispatchDto(before, existing) } : {}),
    });
  }

  const run = before.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Planning Run不存在");
  const planningRun = requirePlanningRun(run);
  const session = before.entities.sessions[planningRun.sessionId];
  const message = before.entities.messages[planningRun.sourceMessageId];
  const rawRunSpec = before.entities.workflowRunSpecs[input.workflowRunSpecId];
  const validated =
    rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
  if (
    session === undefined ||
    message === undefined ||
    planningRun.workflowRunSpecId !== input.workflowRunSpecId ||
    rawRunSpec?.productRunId !== input.productRunId ||
    validated === undefined ||
    !validated.success
  ) {
    throw revisionConflict("Workflow Memory Query的Run/RunSpec绑定无效");
  }
  const node = validated.runSpec.nodeResolutions.find(
    (candidate) => candidate.definitionNodeId === input.definitionNodeId,
  );
  if (node?.nodeType !== "memory.query" || node.activation === "skipped") {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "指定节点不是可执行的memory.query节点",
    });
  }
  const parsedConfig = workflowMemoryQueryNodeConfigSchema.safeParse(node.config);
  if (!parsedConfig.success) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "memory.query冻结配置损坏",
      recoveryAction: "contact_support",
    });
  }
  const provider = deps.workflowMemoryProviders?.getQuery(parsedConfig.data.providerId);
  if (provider === undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Workflow Runtime未注册所选Memory Provider",
    });
  }
  const providerDescriptor = provider.describeProvider();
  const queryCapability = providerDescriptor.capabilities.query;
  if (
    providerDescriptor.providerId !== parsedConfig.data.providerId ||
    queryCapability === null ||
    parsedConfig.data.maxResults > queryCapability.maxResults ||
    parsedConfig.data.maxContextCharacters > queryCapability.maxContextCharacters
  ) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "memory.query配置超出Provider冻结能力",
    });
  }
  const now = deps.now();
  const workflowMemoryQueryId = existingId;
  const providerDescriptorSha256 = computeMemoryProviderDescriptorSha256(providerDescriptor);
  const sourceMessageSha256 = computeWorkflowMemoryMessageSha256(message);
  const querySha256 = sha256Hex(message.content.text);
  const query = workflowMemoryQuerySchema.parse({
    schemaVersion: "workflow-memory-query.v1",
    workflowMemoryQueryId,
    operationId: workflowMemoryQueryId,
    productRunId: input.productRunId,
    productSessionId: planningRun.sessionId,
    requestedByPrincipalId: session.ownerPrincipalId,
    workflowRunSpecId: input.workflowRunSpecId,
    workflowRunSpecSha256: validated.runSpec.sha256,
    definitionNodeId: input.definitionNodeId,
    executionPath: input.executionPath,
    attemptNumber: input.attemptNumber,
    sourceMessageId: message.messageId,
    sourceMessageSha256,
    querySha256,
    providerId: parsedConfig.data.providerId,
    providerDescriptor,
    providerDescriptorSha256,
    requirement: parsedConfig.data.required ? "required" : "optional",
    maxResults: parsedConfig.data.maxResults,
    maxContextCharacters: parsedConfig.data.maxContextCharacters,
    status: "pending",
    startedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginWorkflowMemoryQuery",
    requestSha256: hashCanonical("command.begin-workflow-memory-query.v1", {
      ...queryIdentity(input),
      workflowMemoryQueryId,
      sourceMessageSha256,
      querySha256,
      providerDescriptorSha256,
    }),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const collision = draft.entities.workflowMemoryQueries[workflowMemoryQueryId];
      if (collision !== undefined) {
        if (collision.querySha256 !== query.querySha256) {
          throw revisionConflict("Workflow Memory Query稳定身份发生冲突");
        }
      } else {
        draft.entities.workflowMemoryQueries[workflowMemoryQueryId] = query;
      }
      return { resultRefs: { workflowMemoryQueryId, productRunId: input.productRunId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committed =
    snapshot.entities.workflowMemoryQueries[transaction.resultRefs["workflowMemoryQueryId"] ?? ""];
  if (committed === undefined) throw notFound("Workflow Memory Query不存在");
  return beginWorkflowMemoryQueryResponseSchema.parse({
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    status: "dispatch_required",
    workflowMemoryQueryId: committed.workflowMemoryQueryId,
    productRunId: committed.productRunId,
    workflowRunSpecId: committed.workflowRunSpecId,
    query: dispatchDto(snapshot, committed),
  });
}

/** Provider输出与Workflow checkpoint共用同一规范化算法。 */
export function normalizeWorkflowMemoryQueryResult(
  query: Pick<WorkflowMemoryQuery, "maxResults" | "maxContextCharacters">,
  output: {
    readonly externalQueryId: string;
    readonly hitCount: number;
    readonly sections: readonly {
      readonly externalObjectIds: readonly string[];
      readonly title: string;
      readonly category: WorkflowMemorySnapshot["category"];
      readonly content: string;
      readonly labels: readonly string[];
      readonly score?: number | undefined;
      readonly sourceUpdatedAt?: string | undefined;
    }[];
  },
): Extract<WorkflowMemoryQueryExecutionResult, { readonly outcome: "success" }> {
  const sections = normalizeWorkflowMemorySections({
    sections: output.sections,
    hitCount: output.hitCount,
    maxResults: query.maxResults,
    maxContextCharacters: query.maxContextCharacters,
  });
  return {
    outcome: "success",
    externalQueryId: output.externalQueryId,
    hitCount: output.hitCount,
    sections: sections.map((section) => ({
      ...section,
      externalObjectIds: [...section.externalObjectIds],
      labels: [...section.labels],
    })),
    resultSetSha256: computeWorkflowMemoryQueryResultSha256({
      externalQueryId: output.externalQueryId,
      hitCount: output.hitCount,
      sections,
    }) as never,
  };
}

/** 外部调用结果已由Workflow checkpoint后，本命令原子提交Query、Snapshots和Node终态。 */
export async function persistWorkflowMemoryQueryResult(
  deps: ApplicationDeps,
  input: Omit<PersistWorkflowMemoryQueryResultRequest, "schemaVersion">,
): Promise<PersistWorkflowMemoryQueryResultResponse> {
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const query = before.entities.workflowMemoryQueries[input.workflowMemoryQueryId];
  if (query === undefined || query.productRunId !== input.productRunId) {
    throw notFound("Workflow Memory Query不存在");
  }
  const normalized =
    input.result.outcome === "success"
      ? normalizeWorkflowMemoryQueryResult(query, input.result)
      : input.result;
  if (
    input.result.outcome === "success" &&
    normalized.outcome === "success" &&
    normalized.resultSetSha256 !== input.result.resultSetSha256
  ) {
    throw revisionConflict("Workflow checkpoint的Memory Query结果Hash不一致");
  }
  const now = deps.now();
  let didTransition = false;
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistWorkflowMemoryQueryResult",
    requestSha256: hashCanonical("command.persist-workflow-memory-query-result.v1", {
      ...queryIdentity(input),
      workflowMemoryQueryId: input.workflowMemoryQueryId,
      result: normalized,
    }),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const current = draft.entities.workflowMemoryQueries[input.workflowMemoryQueryId];
      if (current === undefined) throw notFound("Workflow Memory Query不存在");
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Planning Run不存在");
      const planningRun = requirePlanningRun(run);
      const rawRunSpec = draft.entities.workflowRunSpecs[input.workflowRunSpecId];
      const validated =
        rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
      if (
        validated === undefined ||
        !validated.success ||
        rawRunSpec?.productRunId !== input.productRunId ||
        current.workflowRunSpecId !== input.workflowRunSpecId ||
        current.definitionNodeId !== input.definitionNodeId ||
        current.attemptNumber !== input.attemptNumber ||
        JSON.stringify(current.executionPath) !== JSON.stringify(input.executionPath)
      ) {
        throw revisionConflict("Workflow Memory Query执行身份不一致");
      }
      if (current.status !== "pending") {
        assertTerminalQueryMatches(current, normalized);
        const nodeRun = Object.values(draft.entities.workflowNodeRuns).find(
          (candidate) =>
            candidate.productRunId === current.productRunId &&
            candidate.definitionNodeId === current.definitionNodeId &&
            candidate.attemptNumber === current.attemptNumber &&
            JSON.stringify(candidate.executionPath) === JSON.stringify(current.executionPath),
        );
        if (nodeRun === undefined) throw revisionConflict("终态Query缺少Node证据");
        return {
          resultRefs: {
            workflowMemoryQueryId: current.workflowMemoryQueryId,
            productRunId: current.productRunId,
            workflowNodeRunId: nodeRun.workflowNodeRunId,
          },
        };
      }
      const message = draft.entities.messages[current.sourceMessageId];
      if (
        message === undefined ||
        computeWorkflowMemoryMessageSha256(message) !== current.sourceMessageSha256
      ) {
        throw revisionConflict("Workflow Memory Query来源消息已变化");
      }
      const inputRef: NodeProductRef = {
        kind: "message",
        id: message.messageId,
        revision: message.revision,
        sha256: current.sourceMessageSha256,
        label: "Memory查询来源消息",
      };
      let outputRefs: NodeProductRef[] = [];
      let outcomeCode: "success" | "empty" | "optional_unavailable" | "required_unavailable";
      let terminal: "succeeded" | "failed";
      let publicSummary: string;
      if (normalized.outcome === "success") {
        const snapshots = normalized.sections.map((section, index) => {
          const sha256 = computeWorkflowMemorySnapshotSha256({
            providerId: current.providerId,
            ...section,
          });
          const workflowMemorySnapshotId = workflowMemorySnapshotIdSchema.parse(
            `wms_${hashCanonical("id.workflow-memory-snapshot.v1", {
              workflowMemoryQueryId: current.workflowMemoryQueryId,
              index,
              sha256,
            }).slice(0, 32)}`,
          );
          const memorySnapshot = workflowMemorySnapshotSchema.parse({
            schemaVersion: "workflow-memory-snapshot.v1",
            workflowMemorySnapshotId,
            workflowMemoryQueryId: current.workflowMemoryQueryId,
            providerId: current.providerId,
            ...section,
            sha256,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          draft.entities.workflowMemorySnapshots[workflowMemorySnapshotId] = memorySnapshot;
          return memorySnapshot;
        });
        draft.entities.workflowMemoryQueries[current.workflowMemoryQueryId] =
          workflowMemoryQuerySchema.parse({
            ...current,
            status: "completed",
            externalQueryId: normalized.externalQueryId,
            hitCount: normalized.hitCount,
            selectedCount: snapshots.length,
            selectedCharacters: snapshots.reduce(
              (sum, item) => sum + item.title.length + item.content.length,
              0,
            ),
            resultSetSha256: normalized.resultSetSha256,
            completedAt: now,
            revision: 2,
            updatedAt: now,
          });
        outputRefs = snapshots.map((item) => ({
          kind: "workflow_memory_snapshot" as const,
          id: item.workflowMemorySnapshotId,
          revision: item.revision,
          sha256: item.sha256,
          label: item.title,
        }));
        outcomeCode = snapshots.length === 0 ? "empty" : "success";
        terminal = "succeeded";
        publicSummary =
          snapshots.length === 0
            ? "Memory查询完成，没有采用条目"
            : `Memory查询完成，冻结${String(snapshots.length)}条快照`;
      } else {
        draft.entities.workflowMemoryQueries[current.workflowMemoryQueryId] =
          workflowMemoryQuerySchema.parse({
            ...current,
            status: "failed",
            errorCode: normalized.errorCode,
            completedAt: now,
            revision: 2,
            updatedAt: now,
          });
        const required = current.requirement === "required";
        outcomeCode = required ? "required_unavailable" : "optional_unavailable";
        terminal = required ? "failed" : "succeeded";
        publicSummary = required
          ? "必需Memory查询失败，工作流已安全停止"
          : "可选Memory查询失败，继续执行工作流";
      }
      const nodeRun = commitPlanningContextNodeFact(draft, {
        run: planningRun,
        runSpec: validated.runSpec,
        definitionNodeId: input.definitionNodeId,
        nodeType: "memory.query",
        executionPath: input.executionPath,
        attemptNumber: input.attemptNumber,
        terminal,
        outcomeCode,
        publicSummary,
        inputSlots: [{ name: "message", refs: [inputRef] }],
        outputSlots: outputRefs.length === 0 ? [] : [{ name: "snapshots", refs: outputRefs }],
        at: now,
      });
      didTransition = true;
      return {
        resultRefs: {
          workflowMemoryQueryId: current.workflowMemoryQueryId,
          productRunId: current.productRunId,
          workflowNodeRunId: nodeRun.workflowNodeRunId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committed =
    snapshot.entities.workflowMemoryQueries[transaction.resultRefs["workflowMemoryQueryId"] ?? ""];
  if (committed === undefined || committed.status === "pending") {
    throw revisionConflict("Workflow Memory Query未进入终态");
  }
  const node =
    snapshot.entities.workflowNodeRuns[transaction.resultRefs["workflowNodeRunId"] ?? ""];
  // 同command或不同command观察到相同Query终态时都不重复追加轨迹事件。
  if (didTransition && node !== undefined) emitWorkflowMemoryNodeTrace(deps, snapshot, node);
  return persistWorkflowMemoryQueryResultResponseSchema.parse({
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    workflowMemoryQueryId: committed.workflowMemoryQueryId,
    productRunId: committed.productRunId,
    workflowRunSpecId: committed.workflowRunSpecId,
    status:
      committed.status === "completed"
        ? "completed"
        : committed.requirement === "required"
          ? "required_failed"
          : "optional_failed",
    snapshotCount: Object.values(snapshot.entities.workflowMemorySnapshots).filter(
      (item) => item.workflowMemoryQueryId === committed.workflowMemoryQueryId,
    ).length,
  });
}

function assertTerminalQueryMatches(
  current: Exclude<WorkflowMemoryQuery, { readonly status: "pending" }>,
  result: WorkflowMemoryQueryExecutionResult,
): void {
  if (
    (current.status === "completed" &&
      (result.outcome !== "success" || current.resultSetSha256 !== result.resultSetSha256)) ||
    (current.status === "failed" &&
      (result.outcome !== "failure" || current.errorCode !== result.errorCode))
  ) {
    throw revisionConflict("Workflow Memory Query终态与重复结果不一致");
  }
}

/** 在第一个agent.plan前把本轮所有query终态冻结成唯一、Provider中立的Context。 */
export async function freezeWorkflowMemoryContext(
  deps: ApplicationDeps,
  input: Omit<FreezeWorkflowMemoryContextRequest, "schemaVersion">,
): Promise<FreezeWorkflowMemoryContextResponse> {
  const now = deps.now();
  const workflowMemoryContextId = workflowMemoryContextIdSchema.parse(
    `wmc_${hashCanonical("id.workflow-memory-context.v1", {
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    }).slice(0, 32)}`,
  );
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "FreezeWorkflowMemoryContext",
    requestSha256: hashCanonical("command.freeze-workflow-memory-context.v1", input),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      const runSpec = draft.entities.workflowRunSpecs[input.workflowRunSpecId];
      if (
        run === undefined ||
        run.workflowRunSpecId !== input.workflowRunSpecId ||
        runSpec?.productRunId !== input.productRunId
      ) {
        throw revisionConflict("Workflow Memory Context的RunSpec绑定无效");
      }
      const queries = Object.values(draft.entities.workflowMemoryQueries)
        .filter(
          (candidate) =>
            candidate.productRunId === input.productRunId &&
            candidate.workflowRunSpecId === input.workflowRunSpecId,
        )
        .sort((left, right) =>
          left.workflowMemoryQueryId.localeCompare(right.workflowMemoryQueryId),
        );
      if (queries.length === 0) {
        return { resultRefs: { productRunId: input.productRunId } };
      }
      if (queries.some((query) => query.status === "pending")) {
        throw revisionConflict("仍有Memory Query未完成，不能冻结Planning Context");
      }
      if (queries.some((query) => query.status === "failed" && query.requirement === "required")) {
        throw revisionConflict("必需Memory Query失败，不能进入Planner");
      }
      const queryRefs = queries.map((query) => {
        if (query.status === "completed") {
          return {
            workflowMemoryQueryId: query.workflowMemoryQueryId,
            revision: query.revision,
            providerId: query.providerId,
            outcome: "completed" as const,
            resultSetSha256: query.resultSetSha256,
          };
        }
        if (query.status === "pending") {
          throw revisionConflict("仍有Memory Query未完成，不能冻结Planning Context");
        }
        return {
          workflowMemoryQueryId: query.workflowMemoryQueryId,
          revision: query.revision,
          providerId: query.providerId,
          outcome: "optional_failed" as const,
          errorCode: query.errorCode,
        };
      });
      const snapshots = Object.values(draft.entities.workflowMemorySnapshots)
        .filter((item) =>
          queries.some((query) => query.workflowMemoryQueryId === item.workflowMemoryQueryId),
        )
        .sort((left, right) =>
          left.workflowMemorySnapshotId.localeCompare(right.workflowMemorySnapshotId),
        );
      const items = snapshots.map((item) => ({
        workflowMemorySnapshotId: item.workflowMemorySnapshotId,
        revision: item.revision,
        sha256: item.sha256,
      }));
      const totalContentCharacters = snapshots.reduce(
        (sum, item) => sum + item.title.length + item.content.length,
        0,
      );
      assertWorkflowMemoryContextOrder({ queries: queryRefs, items });
      const hashInput = {
        productRunId: input.productRunId,
        workflowRunSpecId: input.workflowRunSpecId,
        workflowRunSpecSha256: runSpec.sha256,
        queries: queryRefs,
        items,
        totalContentCharacters,
      };
      const context = {
        schemaVersion: "workflow-memory-context.v1" as const,
        workflowMemoryContextId,
        ...hashInput,
        sha256: computeWorkflowMemoryContextSha256(hashInput),
        revision: 1 as const,
        createdAt: now,
        updatedAt: now,
      };
      const existing = draft.entities.workflowMemoryContexts[workflowMemoryContextId];
      if (existing !== undefined && existing.sha256 !== context.sha256) {
        throw revisionConflict("Workflow Memory Context已冻结且内容不同");
      }
      draft.entities.workflowMemoryContexts[workflowMemoryContextId] = existing ?? context;
      return { resultRefs: { productRunId: input.productRunId, workflowMemoryContextId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const context =
    snapshot.entities.workflowMemoryContexts[
      transaction.resultRefs["workflowMemoryContextId"] ?? ""
    ];
  if (context === undefined) {
    return {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "none",
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    };
  }
  return {
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    status: "ready",
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    contextRef: {
      workflowMemoryContextId: context.workflowMemoryContextId,
      revision: context.revision,
      sha256: context.sha256,
    },
  };
}
