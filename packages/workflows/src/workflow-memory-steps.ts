import {
  normalizeWorkflowMemoryQueryResult,
  WorkflowMemoryProviderError,
  type WorkflowMemoryQueryProviderPort,
} from "@chat/application";
import {
  workflowMemoryQueryExecutionResultSchema,
  type BeginWorkflowMemoryQueryResponse,
  type FreezeWorkflowMemoryContextResponse,
  type PersistWorkflowMemoryQueryResultResponse,
  type WorkflowMemoryQueryDispatchDto,
  type WorkflowMemoryQueryExecutionResult,
} from "@chat/contracts";
import { computeMemoryProviderDescriptorSha256 } from "@chat/domain";
import { getStepMetadata } from "workflow";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { cmdId, runStep, wrapApiError } from "./workflow-step-support.js";

export interface WorkflowMemoryNodeIdentity {
  readonly workflowAttemptId: string;
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
}

function executionIdentity(input: WorkflowMemoryNodeIdentity): string {
  return [
    input.workflowRunSpecId,
    input.definitionNodeId,
    ...input.executionPath.map(
      (segment) => `${segment.containerNodeId}:${String(segment.iteration)}`,
    ),
    `attempt:${String(input.attemptNumber)}`,
  ].join("/");
}

export async function beginWorkflowMemoryQueryStep(
  input: WorkflowMemoryNodeIdentity,
): Promise<BeginWorkflowMemoryQueryResponse> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "begin_workflow_memory_query",
    async () => {
      try {
        return await getWorkflowRuntimeContext().api.beginWorkflowMemoryQuery({
          commandId: cmdId(
            "begin-workflow-memory-query",
            input.productRunId,
            executionIdentity(input),
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          definitionNodeId: input.definitionNodeId,
          executionPath: input.executionPath.map((segment) => ({
            containerNodeId: segment.containerNodeId as never,
            iteration: segment.iteration,
          })),
          attemptNumber: input.attemptNumber,
        });
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

function assertFrozenProvider(
  query: WorkflowMemoryQueryDispatchDto,
): WorkflowMemoryQueryProviderPort {
  const provider = getWorkflowRuntimeContext().workflowMemoryProviders.getQuery(query.providerId);
  if (provider === undefined) {
    throw new WorkflowMemoryProviderError({
      code: "memory.provider.not_configured",
      message: "Workflow Runtime未注册冻结的Memory Provider",
      retryable: false,
    });
  }
  const runtimeDescriptor = provider.describeProvider();
  if (
    query.providerDescriptor.providerId !== query.providerId ||
    runtimeDescriptor.providerId !== query.providerId ||
    computeMemoryProviderDescriptorSha256(query.providerDescriptor) !==
      query.providerDescriptorSha256 ||
    computeMemoryProviderDescriptorSha256(runtimeDescriptor) !== query.providerDescriptorSha256
  ) {
    throw new WorkflowMemoryProviderError({
      code: "memory.provider.profile_changed",
      message: "Memory Provider配置与冻结查询意图不一致",
      retryable: false,
    });
  }
  return provider;
}

/** 唯一越过外部Query边界的Step；返回值经strict schema进入Workflow checkpoint。 */
export async function queryWorkflowMemoryProviderStep(input: {
  readonly query: WorkflowMemoryQueryDispatchDto;
  readonly workflowAttemptId: string;
}): Promise<WorkflowMemoryQueryExecutionResult> {
  "use step";
  return runStep(
    input.query.productRunId,
    input.workflowAttemptId,
    "query_workflow_memory_provider",
    async () => {
      try {
        const provider = assertFrozenProvider(input.query);
        const output = await provider.queryMemory({
          operationId: input.query.operationId,
          productRunId: input.query.productRunId,
          productSessionId: input.query.productSessionId,
          principalId: input.query.principalId,
          query: input.query.queryText,
          maxResults: input.query.maxResults,
          maxContextCharacters: input.query.maxContextCharacters,
        });
        return workflowMemoryQueryExecutionResultSchema.parse(
          normalizeWorkflowMemoryQueryResult(input.query, output),
        );
      } catch (error) {
        // 只读查询允许由Workflow重试；最后一次仍失败时必须返回可持久化结果，
        // 让Application把optional/required失败和Node终态原子提交，不能让Runner丢证据。
        if (
          error instanceof WorkflowMemoryProviderError &&
          error.retryable &&
          getStepMetadata().attempt <= 2
        ) {
          throw error;
        }
        const errorCode =
          error instanceof WorkflowMemoryProviderError ? error.code : "memory.provider.unavailable";
        return workflowMemoryQueryExecutionResultSchema.parse({
          outcome: "failure",
          errorCode,
        });
      }
    },
  );
}
queryWorkflowMemoryProviderStep.maxRetries = 2;

export async function persistWorkflowMemoryQueryResultStep(input: {
  readonly identity: WorkflowMemoryNodeIdentity;
  readonly workflowMemoryQueryId: string;
  readonly result: WorkflowMemoryQueryExecutionResult;
}): Promise<PersistWorkflowMemoryQueryResultResponse> {
  "use step";
  return runStep(
    input.identity.productRunId,
    input.identity.workflowAttemptId,
    "persist_workflow_memory_query_result",
    async () => {
      try {
        return await getWorkflowRuntimeContext().api.persistWorkflowMemoryQueryResult({
          commandId: cmdId(
            "persist-workflow-memory-query-result",
            input.identity.productRunId,
            executionIdentity(input.identity),
          ) as never,
          productRunId: input.identity.productRunId as never,
          workflowRunSpecId: input.identity.workflowRunSpecId as never,
          definitionNodeId: input.identity.definitionNodeId,
          executionPath: input.identity.executionPath.map((segment) => ({
            containerNodeId: segment.containerNodeId as never,
            iteration: segment.iteration,
          })),
          attemptNumber: input.identity.attemptNumber,
          workflowMemoryQueryId: input.workflowMemoryQueryId as never,
          result: input.result,
        });
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

export async function freezeWorkflowMemoryContextStep(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly workflowAttemptId: string;
}): Promise<FreezeWorkflowMemoryContextResponse> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "freeze_workflow_memory_context",
    async () => {
      try {
        return await getWorkflowRuntimeContext().api.freezeWorkflowMemoryContext({
          commandId: cmdId(
            "freeze-workflow-memory-context",
            input.productRunId,
            input.workflowRunSpecId,
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
        });
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}
