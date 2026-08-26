import {
  normalizeWorkflowMemoryQueryResult,
  WorkflowMemoryProviderError,
  type WorkflowMemoryQueryProviderPort,
} from "@chat/application";
import {
  workflowMemoryQueryExecutionResultSchema,
  type DirectAgentCandidateId,
  type MemoryAgentOperation,
  type MemoryWriteAgentProposal,
  type WorkflowMemoryQueryDispatchDto,
} from "@chat/contracts";
import {
  computeMemoryAgentOperationInputSha256,
  computeMemoryProviderDescriptorSha256,
  computeMemoryRetrievalAgentSourceSha256,
} from "@chat/domain";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { cmdId, runStep, wrapApiError } from "./workflow-step-support.js";
import type { WorkflowMemoryNodeIdentity } from "./workflow-memory-steps.js";

/**
 * 此校验必须保持为Step文件私有函数；若从Step模块导出，Workflow编译器会把服务端
 * Provider与Node crypto依赖误带入沙箱Bundle。
 */
function requireFrozenProvider(
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
      code: "memory.provider_descriptor_mismatch",
      message: "Workflow Runtime Provider与冻结描述不一致",
      retryable: false,
    });
  }
  return provider;
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

function stableAgentError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { readonly code: unknown }).code);
    if (/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u.test(code)) return code;
  }
  return "memory_agent.runtime_failed";
}

function unavailableOutcome(required: boolean) {
  return required ? ("required_unavailable" as const) : ("optional_unavailable" as const);
}

function retrievalOperationSourceSha256(query: WorkflowMemoryQueryDispatchDto): string {
  return computeMemoryRetrievalAgentSourceSha256({
    workflowMemoryQueryId: query.workflowMemoryQueryId,
    workflowRunSpecSha256: query.workflowRunSpecSha256,
    sourceMessageSha256: query.sourceMessageSha256,
    querySha256: query.querySha256,
    providerDescriptorSha256: query.providerDescriptorSha256,
    requirement: query.requirement,
    maxResults: query.maxResults,
    maxContextCharacters: query.maxContextCharacters,
  });
}

function operationFailureCode(operation: MemoryAgentOperation): string {
  return operation.status === "failed" || operation.status === "outcome_unknown"
    ? operation.errorCode
    : "memory_agent.operation_outcome_unknown";
}

/**
 * Query、Memory工具调用、Agent筛选与产品持久化在同一个耐久Step内完成。正文只存在于
 * 本Step调用栈和Provider模型上下文；Vercel Workflow checkpoint只收到有界终态字符串。
 * 模型/Memory外部调用不自动重试，避免重复付费或隐藏第二次查询。
 */
export async function executeMemoryRetrievalAgentStep(input: {
  readonly identity: WorkflowMemoryNodeIdentity;
}): Promise<"success" | "empty" | "optional_unavailable" | "required_unavailable"> {
  "use step";
  return runStep(
    input.identity.productRunId,
    input.identity.workflowAttemptId,
    "execute_memory_retrieval_agent",
    async () => {
      const ctx = getWorkflowRuntimeContext();
      let begun;
      try {
        begun = await ctx.api.beginWorkflowMemoryQuery({
          commandId: cmdId(
            "begin-memory-retrieval-agent-query",
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
        });
      } catch (error) {
        wrapApiError(error);
      }
      if (begun.status !== "dispatch_required") {
        if (begun.status === "completed") return "success";
        return begun.status === "required_failed" ? "required_unavailable" : "optional_unavailable";
      }
      const sourceSha256 = retrievalOperationSourceSha256(begun.query);
      const operationInputSha256 = computeMemoryAgentOperationInputSha256({
        operationKind: "retrieval",
        productRunId: input.identity.productRunId,
        workflowRunSpecId: input.identity.workflowRunSpecId,
        definitionNodeId: input.identity.definitionNodeId,
        sourceSha256,
      });
      let gate;
      try {
        gate = await ctx.api.beginMemoryAgentOperation({
          commandId: cmdId(
            "begin-memory-retrieval-agent-operation",
            input.identity.productRunId,
            executionIdentity(input.identity),
          ) as never,
          productRunId: input.identity.productRunId as never,
          workflowRunSpecId: input.identity.workflowRunSpecId as never,
          definitionNodeId: input.identity.definitionNodeId,
          operationKind: "retrieval",
          inputSha256: operationInputSha256,
          sourceSha256,
        });
      } catch (error) {
        wrapApiError(error);
      }
      let result;
      if (gate.status === "succeeded") {
        if (gate.operation.result.kind !== "retrieval") {
          throw new Error("memory_agent.operation_result_kind_mismatch");
        }
        result = workflowMemoryQueryExecutionResultSchema.parse({
          outcome: "success",
          externalQueryId: gate.operation.result.externalQueryId,
          hitCount: gate.operation.result.hitCount,
          sections: gate.operation.result.sections,
        });
      } else if (gate.status === "failed" || gate.status === "outcome_unknown") {
        result = workflowMemoryQueryExecutionResultSchema.parse({
          outcome: "failure",
          errorCode: operationFailureCode(gate.operation),
        });
      } else if (gate.status === "recovery_required") {
        try {
          await ctx.api.markMemoryAgentOperationOutcomeUnknown({
            commandId: cmdId(
              "recover-memory-retrieval-agent-operation",
              input.identity.productRunId,
              executionIdentity(input.identity),
            ) as never,
            memoryAgentOperationId: gate.operation.memoryAgentOperationId,
            expectedRevision: 1,
            inputSha256: operationInputSha256,
            errorCode: "memory_agent.operation_outcome_unknown",
            providerRequestCount: gate.operation.providerRequestCount,
          });
        } catch (error) {
          wrapApiError(error);
        }
        result = workflowMemoryQueryExecutionResultSchema.parse({
          outcome: "failure",
          errorCode: "memory_agent.operation_outcome_unknown",
        });
      } else {
        let providerRequestsStarted = 0;
        try {
          const provider = requireFrozenProvider(begun.query);
          if (ctx.memoryRetrievalAgent === undefined) {
            throw Object.assign(new Error("Memory检索Agent未配置"), {
              code: "memory_agent.not_configured",
            });
          }
          const agent = await ctx.memoryRetrievalAgent({
            config: ctx.bailian,
            sourceText: begun.query.queryText,
            maxResults: begun.query.maxResults,
            onProviderRequestStart: () => {
              providerRequestsStarted += 1;
            },
            search: async () => {
              const output = await provider.queryMemory({
                operationId: begun.query.operationId,
                productRunId: begun.query.productRunId,
                productSessionId: begun.query.productSessionId,
                principalId: begun.query.principalId,
                query: begun.query.queryText,
                maxResults: begun.query.maxResults,
                maxContextCharacters: begun.query.maxContextCharacters,
              });
              const normalized = normalizeWorkflowMemoryQueryResult(begun.query, output);
              return {
                externalQueryId: normalized.externalQueryId,
                hitCount: normalized.hitCount,
                sections: normalized.sections,
              };
            },
          });
          if (agent.kind === "selected") {
            const normalized = normalizeWorkflowMemoryQueryResult(begun.query, agent.output);
            const completed = await ctx.api.completeMemoryAgentOperation({
              commandId: cmdId(
                "complete-memory-retrieval-agent-operation",
                input.identity.productRunId,
                executionIdentity(input.identity),
              ) as never,
              memoryAgentOperationId: gate.operation.memoryAgentOperationId,
              expectedRevision: 1,
              inputSha256: operationInputSha256,
              outcome: {
                kind: "succeeded",
                result: {
                  kind: "retrieval",
                  externalQueryId: normalized.externalQueryId,
                  hitCount: normalized.hitCount,
                  sections: normalized.sections,
                },
                providerRequestCount: agent.providerRequestCount,
                ...(agent.usage === undefined ? {} : { usage: agent.usage }),
              },
            });
            if (completed.operation.status !== "succeeded") {
              throw new Error("memory_agent.operation_completion_missing");
            }
            result = workflowMemoryQueryExecutionResultSchema.parse(normalized);
          } else {
            await ctx.api.completeMemoryAgentOperation({
              commandId: cmdId(
                "fail-memory-retrieval-agent-operation",
                input.identity.productRunId,
                executionIdentity(input.identity),
              ) as never,
              memoryAgentOperationId: gate.operation.memoryAgentOperationId,
              expectedRevision: 1,
              inputSha256: operationInputSha256,
              outcome: {
                kind: "failed",
                errorCode: agent.errorCode,
                providerRequestCount: agent.providerRequestCount,
              },
            });
            result = workflowMemoryQueryExecutionResultSchema.parse({
              outcome: "failure",
              errorCode: agent.errorCode,
            });
          }
        } catch (error) {
          const errorCode =
            error instanceof WorkflowMemoryProviderError ? error.code : stableAgentError(error);
          try {
            if (providerRequestsStarted === 0) {
              await ctx.api.completeMemoryAgentOperation({
                commandId: cmdId(
                  "fail-memory-retrieval-agent-operation",
                  input.identity.productRunId,
                  executionIdentity(input.identity),
                ) as never,
                memoryAgentOperationId: gate.operation.memoryAgentOperationId,
                expectedRevision: 1,
                inputSha256: operationInputSha256,
                outcome: { kind: "failed", errorCode, providerRequestCount: 0 },
              });
              result = workflowMemoryQueryExecutionResultSchema.parse({
                outcome: "failure",
                errorCode,
              });
            } else {
              await ctx.api.markMemoryAgentOperationOutcomeUnknown({
                commandId: cmdId(
                  "unknown-memory-retrieval-agent-operation",
                  input.identity.productRunId,
                  executionIdentity(input.identity),
                ) as never,
                memoryAgentOperationId: gate.operation.memoryAgentOperationId,
                expectedRevision: 1,
                inputSha256: operationInputSha256,
                errorCode: "memory_agent.operation_outcome_unknown",
                providerRequestCount: providerRequestsStarted,
              });
              result = workflowMemoryQueryExecutionResultSchema.parse({
                outcome: "failure",
                errorCode: "memory_agent.operation_outcome_unknown",
              });
            }
          } catch (settlementError) {
            wrapApiError(settlementError);
          }
        }
      }
      let persisted;
      try {
        persisted = await ctx.api.persistWorkflowMemoryQueryResult({
          commandId: cmdId(
            "persist-memory-retrieval-agent-result",
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
          workflowMemoryQueryId: begun.workflowMemoryQueryId,
          result,
        });
      } catch (error) {
        wrapApiError(error);
      }
      if (persisted.status === "required_failed") return "required_unavailable";
      if (persisted.status === "optional_failed") return "optional_unavailable";
      return persisted.snapshotCount === 0 ? "empty" : "success";
    },
  );
}
executeMemoryRetrievalAgentStep.maxRetries = 0;

export type MemoryWriteAgentStepResult =
  | { readonly outcome: "candidate_ready"; readonly candidateId: string }
  | { readonly outcome: "nothing_useful" }
  | {
      readonly outcome: "optional_unavailable" | "required_unavailable";
      readonly errorCode: string;
    };

/** 写入Agent只提交Product Candidate；真正外部写入必须等待公开Decision命令。 */
export async function executeMemoryWriteAgentStep(input: {
  readonly productRunId: string;
  readonly workflowAttemptId: string;
  readonly workflowRunSpecId: string;
  readonly directAgentCandidateId: string;
  readonly candidateSha256: string;
}): Promise<MemoryWriteAgentStepResult> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "execute_memory_write_agent",
    async () => {
      const ctx = getWorkflowRuntimeContext();
      let prepared;
      try {
        prepared = await ctx.api.prepareMemoryWriteAgentInput({
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          directAgentCandidateId: input.directAgentCandidateId as DirectAgentCandidateId,
          candidateSha256: input.candidateSha256,
        });
      } catch (error) {
        wrapApiError(error);
      }
      const sourceSha256 = prepared.evidenceSha256;
      const operationInputSha256 = computeMemoryAgentOperationInputSha256({
        operationKind: "write",
        productRunId: input.productRunId,
        workflowRunSpecId: input.workflowRunSpecId,
        definitionNodeId: "memory-agent.write",
        sourceSha256,
      });
      let gate;
      try {
        gate = await ctx.api.beginMemoryAgentOperation({
          commandId: cmdId(
            "begin-memory-write-agent-operation",
            input.productRunId,
            input.directAgentCandidateId,
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          definitionNodeId: "memory-agent.write",
          operationKind: "write",
          inputSha256: operationInputSha256,
          sourceSha256,
        });
      } catch (error) {
        wrapApiError(error);
      }
      let proposal: MemoryWriteAgentProposal;
      let completedOperation: Extract<MemoryAgentOperation, { readonly status: "succeeded" }>;
      if (gate.status === "succeeded") {
        if (gate.operation.result.kind !== "write") {
          throw new Error("memory_agent.operation_result_kind_mismatch");
        }
        proposal = gate.operation.result.proposal;
        completedOperation = gate.operation;
      } else if (gate.status === "failed" || gate.status === "outcome_unknown") {
        return {
          outcome: unavailableOutcome(prepared.required),
          errorCode: operationFailureCode(gate.operation),
        };
      } else if (gate.status === "recovery_required") {
        try {
          await ctx.api.markMemoryAgentOperationOutcomeUnknown({
            commandId: cmdId(
              "recover-memory-write-agent-operation",
              input.productRunId,
              input.directAgentCandidateId,
            ) as never,
            memoryAgentOperationId: gate.operation.memoryAgentOperationId,
            expectedRevision: 1,
            inputSha256: operationInputSha256,
            errorCode: "memory_agent.operation_outcome_unknown",
            providerRequestCount: gate.operation.providerRequestCount,
          });
        } catch (error) {
          wrapApiError(error);
        }
        return {
          outcome: unavailableOutcome(prepared.required),
          errorCode: "memory_agent.operation_outcome_unknown",
        };
      } else {
        let providerRequestsStarted = 0;
        let generated;
        try {
          if (ctx.memoryWriteAgent === undefined) {
            throw Object.assign(new Error("Memory写入Agent未配置"), {
              code: "memory_agent.not_configured",
            });
          }
          generated = await ctx.memoryWriteAgent({
            config: ctx.bailian,
            evidence: prepared.evidence.map((item) => ({
              label: item.label,
              role: item.role,
              content: item.content,
            })),
            maxItems: prepared.maxItems,
            onProviderRequestStart: () => {
              providerRequestsStarted += 1;
            },
          });
        } catch (error) {
          const errorCode = stableAgentError(error);
          try {
            if (providerRequestsStarted === 0) {
              await ctx.api.completeMemoryAgentOperation({
                commandId: cmdId(
                  "fail-memory-write-agent-operation",
                  input.productRunId,
                  input.directAgentCandidateId,
                ) as never,
                memoryAgentOperationId: gate.operation.memoryAgentOperationId,
                expectedRevision: 1,
                inputSha256: operationInputSha256,
                outcome: { kind: "failed", errorCode, providerRequestCount: 0 },
              });
              return { outcome: unavailableOutcome(prepared.required), errorCode };
            }
            await ctx.api.markMemoryAgentOperationOutcomeUnknown({
              commandId: cmdId(
                "unknown-memory-write-agent-operation",
                input.productRunId,
                input.directAgentCandidateId,
              ) as never,
              memoryAgentOperationId: gate.operation.memoryAgentOperationId,
              expectedRevision: 1,
              inputSha256: operationInputSha256,
              errorCode: "memory_agent.operation_outcome_unknown",
              providerRequestCount: providerRequestsStarted,
            });
            return {
              outcome: unavailableOutcome(prepared.required),
              errorCode: "memory_agent.operation_outcome_unknown",
            };
          } catch (settlementError) {
            wrapApiError(settlementError);
          }
        }
        if (generated.kind !== "candidate") {
          const errorCode =
            generated.kind === "provider_failed"
              ? generated.errorCode
              : `memory_agent.${generated.errorCode}`;
          try {
            await ctx.api.completeMemoryAgentOperation({
              commandId: cmdId(
                "fail-memory-write-agent-operation",
                input.productRunId,
                input.directAgentCandidateId,
              ) as never,
              memoryAgentOperationId: gate.operation.memoryAgentOperationId,
              expectedRevision: 1,
              inputSha256: operationInputSha256,
              outcome: {
                kind: "failed",
                errorCode,
                providerRequestCount: generated.providerCallCount,
                ...(generated.usage === undefined ? {} : { usage: generated.usage }),
              },
            });
          } catch (error) {
            wrapApiError(error);
          }
          return { outcome: unavailableOutcome(prepared.required), errorCode };
        }
        let completed;
        try {
          completed = await ctx.api.completeMemoryAgentOperation({
            commandId: cmdId(
              "complete-memory-write-agent-operation",
              input.productRunId,
              input.directAgentCandidateId,
            ) as never,
            memoryAgentOperationId: gate.operation.memoryAgentOperationId,
            expectedRevision: 1,
            inputSha256: operationInputSha256,
            outcome: {
              kind: "succeeded",
              result: { kind: "write", proposal: generated.candidate },
              providerRequestCount: generated.providerCallCount,
              ...(generated.usage === undefined ? {} : { usage: generated.usage }),
            },
          });
        } catch (error) {
          wrapApiError(error);
        }
        if (completed.operation.status !== "succeeded") {
          throw new Error("memory_agent.operation_completion_missing");
        }
        proposal = generated.candidate;
        completedOperation = completed.operation;
      }
      let persisted;
      try {
        persisted = await ctx.api.persistMemoryWriteAgentCandidate({
          commandId: cmdId(
            "persist-memory-write-agent-candidate",
            input.productRunId,
            input.directAgentCandidateId,
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          directAgentCandidateId: input.directAgentCandidateId as DirectAgentCandidateId,
          candidateSha256: input.candidateSha256,
          expectedEvidenceSha256: prepared.evidenceSha256,
          memoryAgentOperationId: completedOperation.memoryAgentOperationId,
          operationResultSha256: completedOperation.resultSha256,
          proposal,
        });
      } catch (error) {
        return {
          outcome: prepared.required ? "required_unavailable" : "optional_unavailable",
          errorCode: stableAgentError(error),
        };
      }
      return persisted.status === "nothing_useful"
        ? { outcome: "nothing_useful" }
        : {
            outcome: "candidate_ready",
            candidateId: persisted.memoryAgentWriteCandidateId,
          };
    },
  );
}
executeMemoryWriteAgentStep.maxRetries = 0;
