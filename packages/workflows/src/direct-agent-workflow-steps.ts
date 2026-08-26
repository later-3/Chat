import { FatalError } from "workflow";
import {
  directAgentCapabilityModeSchema,
  type DirectAgentPromptReviewDecisionRef,
  type PromptReviewDecisionId,
} from "@chat/contracts";
import type { DirectPromptReviewRef, PiDirectExecutorClientOutcome } from "@chat/pi-runtime";
import {
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_FAMILY,
  MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { cmdId, PiStepFailure, runStep, wrapApiError } from "./workflow-step-support.js";
import { promptReviewHookToken } from "./direct-agent-workflow-input.js";
import { emitPiDirectExecutorActivity } from "./pi-direct-executor-activity.js";

export interface PreparedDirectAgentOperationRef {
  readonly directAgentAttemptId: string;
  readonly workflowRunSpecSha256: string;
  readonly inputManifestSha256: string;
}

interface DirectWorkflowStepIdentity {
  readonly productRunId: string;
  readonly workflowAttemptId: string;
}

interface DirectNodeStepIdentity extends DirectWorkflowStepIdentity {
  readonly workflowRunSpecId: string;
  readonly iteration: number;
}

function requireDirectExecutor() {
  const executor = getWorkflowRuntimeContext().directExecutor;
  if (executor === undefined) {
    throw new PiStepFailure("direct_executor.not_configured", "Direct Executor未配置");
  }
  return executor;
}

/**
 * 同一个耐久Step先校验冻结RunSpec，再创建唯一Direct Attempt。返回值只有产品引用和
 * Hash；用户消息正文即使被Application读取，也不会跨出该Step进入Workflow checkpoint。
 */
export async function prepareDirectAgentOperationStep(
  input: DirectWorkflowStepIdentity & { readonly workflowRunSpecId: string },
): Promise<PreparedDirectAgentOperationRef> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "prepare_direct_agent_operation",
    async () => {
      try {
        const { runSpec } = await getWorkflowRuntimeContext().api.loadWorkflowRunSpec({
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
        });
        const directRunner = runSpec.runner.runnerFamily === DIRECT_AGENT_RUNNER_FAMILY;
        const memoryDirectRunner = runSpec.runner.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY;
        const memoryAgentDirectRunner =
          runSpec.runner.runnerFamily === MEMORY_AGENT_DIRECT_RUNNER_FAMILY;
        const blueprintVersion = runSpec.definitionRef.blueprintVersion;
        const memoryAgentHasRetrieve = memoryAgentDirectRunner && [3, 4].includes(blueprintVersion);
        const memoryAgentHasWrite = memoryAgentDirectRunner && [3, 5].includes(blueprintVersion);
        if (
          runSpec.productRunId !== input.productRunId ||
          runSpec.workflowRunSpecId !== input.workflowRunSpecId ||
          (!directRunner && !memoryDirectRunner && !memoryAgentDirectRunner) ||
          (directRunner &&
            runSpec.runner.runnerBundleVersion !== DIRECT_AGENT_RUNNER_BUNDLE_VERSION) ||
          (memoryDirectRunner &&
            runSpec.runner.runnerBundleVersion !== MEMORY_DIRECT_RUNNER_BUNDLE_VERSION) ||
          (memoryAgentDirectRunner &&
            runSpec.runner.runnerBundleVersion !== MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION) ||
          runSpec.definitionRef.blueprintKey !== "direct" ||
          (memoryAgentDirectRunner
            ? ![3, 4, 5].includes(blueprintVersion)
            : blueprintVersion !== (memoryDirectRunner ? 2 : 1)) ||
          runSpec.businessInput?.kind !== "direct_agent_message"
        ) {
          throw new FatalError("run_spec.direct_agent_binding_incompatible");
        }
        const directNode = runSpec.nodeResolutions.find(
          (node) => node.nodeType === "agent.direct" && node.activation === "enabled",
        );
        const memoryRetrieveNode = runSpec.nodeResolutions.find(
          (node) => node.definitionNodeId === "memory-agent.retrieve",
        );
        const memoryWriteNode = runSpec.nodeResolutions.find(
          (node) => node.definitionNodeId === "memory-agent.write",
        );
        if (
          runSpec.nodeResolutions.length !==
            (memoryDirectRunner
              ? 3
              : memoryAgentDirectRunner
                ? blueprintVersion === 3
                  ? 3
                  : 2
                : 1) ||
          directNode === undefined ||
          directNode.definitionNodeId !== "direct.agent" ||
          !directAgentCapabilityModeSchema.safeParse(directNode.config["capabilityMode"]).success ||
          (directNode.config["promptReviewMode"] !== "manual" &&
            directNode.config["promptReviewMode"] !== "off") ||
          (memoryAgentHasRetrieve &&
            (memoryRetrieveNode?.nodeType !== "agent.memory_retrieve" ||
              memoryRetrieveNode.activation !== "enabled" ||
              memoryRetrieveNode.schemaVersion !== 1)) ||
          (memoryAgentHasWrite &&
            (memoryWriteNode?.nodeType !== "agent.memory_write" ||
              memoryWriteNode.activation !== "enabled" ||
              memoryWriteNode.schemaVersion !== 1))
        ) {
          throw new FatalError("run_spec.direct_agent_nodes_incompatible");
        }
        const begun = await getWorkflowRuntimeContext().api.beginDirectAgentAttempt({
          commandId: cmdId(
            "begin-direct-agent-attempt",
            input.productRunId,
            input.workflowAttemptId,
          ) as never,
          productRunId: input.productRunId as never,
          workflowAttemptId: input.workflowAttemptId as never,
        });
        return {
          directAgentAttemptId: begun.directAgentAttemptId,
          workflowRunSpecSha256: runSpec.sha256,
          inputManifestSha256: begun.inputManifestSha256,
        };
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

/** 首次创建并推进唯一Pi Direct Operation，直至第一处审核边界或终态。 */
export async function startDirectAgentOperationStep(
  input: DirectWorkflowStepIdentity &
    PreparedDirectAgentOperationRef & { readonly workflowRunSpecId: string },
): Promise<PiDirectExecutorClientOutcome> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "start_direct_agent_operation",
    async () =>
      requireDirectExecutor().start({
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        workflowRunSpecId: input.workflowRunSpecId,
        workflowRunSpecSha256: input.workflowRunSpecSha256,
        inputManifestSha256: input.inputManifestSha256,
        onEvent: (event) =>
          emitPiDirectExecutorActivity(
            {
              productRunId: input.productRunId,
              directAgentAttemptId: input.directAgentAttemptId,
            },
            event,
          ),
      }),
  );
}
startDirectAgentOperationStep.maxRetries = 0;

/**
 * Hook先由Workflow World耐久注册，随后本Step才写Runtime Binding。Binding仅保存
 * Request身份、revision、审核Hash与私有Hook映射，不保存Payload或可读提示词。
 */
export async function claimPromptReviewHookStep(
  input: DirectWorkflowStepIdentity & { readonly review: DirectPromptReviewRef },
): Promise<void> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "claim_prompt_review_hook",
    async () => {
      const ctx = getWorkflowRuntimeContext();
      const workflowBinding = ctx.bindings.getWorkflowBinding(input.productRunId as never);
      if (
        workflowBinding === undefined ||
        (workflowBinding.runnerFamily !== DIRECT_AGENT_RUNNER_FAMILY &&
          workflowBinding.runnerFamily !== MEMORY_DIRECT_RUNNER_FAMILY &&
          workflowBinding.runnerFamily !== MEMORY_AGENT_DIRECT_RUNNER_FAMILY)
      ) {
        throw new FatalError("direct_agent.workflow_binding_missing");
      }
      await ctx.bindings.claimPromptReviewHookBinding({
        promptReviewRequestId: input.review.promptReviewRequestId as never,
        productRunId: input.productRunId as never,
        startWorkflowRunId: workflowBinding.workflowRunId,
        requestRevision: input.review.requestRevision,
        reviewSha256: input.review.reviewSha256,
        hookToken: promptReviewHookToken(input.review.promptReviewRequestId),
        now: ctx.now(),
      });
    },
  );
}

/** Hook正文只是signal；这里重新读取Product Store中的权威Decision引用并校验全部Hash。 */
export async function loadPromptReviewDecisionStep(
  input: DirectWorkflowStepIdentity & {
    readonly review: DirectPromptReviewRef;
    readonly promptReviewDecisionId: string;
  },
): Promise<DirectAgentPromptReviewDecisionRef> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "load_prompt_review_decision",
    async () => {
      try {
        const loaded = await getWorkflowRuntimeContext().api.loadPromptReviewDecision({
          productRunId: input.productRunId as never,
          promptReviewRequestId: input.review.promptReviewRequestId as never,
          promptReviewDecisionId: input.promptReviewDecisionId as PromptReviewDecisionId,
          requestRevision: input.review.requestRevision,
          reviewSha256: input.review.reviewSha256,
          payloadSha256: input.review.payloadSha256,
        });
        return loaded.decision;
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

/**
 * 恢复同一个Executor Operation。approve时Executor自行从Application消费一次性permit；
 * Workflow只传Decision与审核引用，永远看不到实际Provider Payload。
 */
export async function submitPromptReviewDecisionStep(
  input: DirectWorkflowStepIdentity & {
    readonly operationId: string;
    readonly requestSha256: string;
    readonly directAgentAttemptId: string;
    readonly review: DirectPromptReviewRef;
    readonly promptReviewDecisionId: string;
  },
): Promise<PiDirectExecutorClientOutcome> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "submit_prompt_review_decision",
    async () =>
      requireDirectExecutor().submitDecision({
        operationId: input.operationId,
        requestSha256: input.requestSha256,
        review: input.review,
        promptReviewDecisionId: input.promptReviewDecisionId,
        onEvent: (event) =>
          emitPiDirectExecutorActivity(
            {
              productRunId: input.productRunId,
              directAgentAttemptId: input.directAgentAttemptId,
            },
            event,
          ),
      }),
  );
}
submitPromptReviewDecisionStep.maxRetries = 0;

/** Candidate已由Executor通过Application持久化；这里只做可安全重放的Product Commit。 */
export async function commitDirectAgentResultStep(
  input: DirectWorkflowStepIdentity & {
    readonly directAgentAttemptId: string;
    readonly directAgentCandidateId: string;
    readonly candidateSha256: string;
  },
): Promise<{ readonly messageId: string }> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "commit_direct_agent_result",
    async () => {
      try {
        const committed = await getWorkflowRuntimeContext().api.commitDirectAgentResult({
          commandId: cmdId(
            "commit-direct-agent-result",
            input.productRunId,
            input.directAgentCandidateId,
          ) as never,
          productRunId: input.productRunId as never,
          directAgentAttemptId: input.directAgentAttemptId as never,
          directAgentCandidateId: input.directAgentCandidateId as never,
          candidateSha256: input.candidateSha256,
        });
        return { messageId: committed.messageId };
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

/**
 * Direct节点投影使用冻结Definition身份与Loop iteration；稳定commandId覆盖全部终态
 * 证据，Workflow重放只能命中同一Transition，不能把失败改写成成功。
 */
export async function recordDirectAgentNodeStep(
  input: DirectNodeStepIdentity & {
    readonly toStatus:
      "running" | "waiting_human" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
    readonly outcomeCode?: "prompt_review_required" | "completed" | string;
    readonly publicSummary: string;
  },
): Promise<void> {
  "use step";
  return recordDirectNodeTransition({
    ...input,
    definitionNodeId: "direct.agent",
    stepKey: "record_direct_agent_node",
  });
}

async function recordDirectNodeTransition(
  input: DirectNodeStepIdentity & {
    readonly definitionNodeId: "direct.agent";
    readonly stepKey: string;
    readonly toStatus:
      "running" | "waiting_human" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";
    readonly outcomeCode?: string;
    readonly publicSummary: string;
  },
): Promise<void> {
  return runStep(input.productRunId, input.workflowAttemptId, input.stepKey, async () => {
    try {
      await getWorkflowRuntimeContext().api.transitionConfigurablePlanningNode({
        commandId: cmdId(
          "transition-direct-agent-node",
          input.productRunId,
          input.workflowRunSpecId,
          input.definitionNodeId,
          String(input.iteration),
          input.toStatus,
          input.outcomeCode ?? "",
          input.publicSummary,
        ) as never,
        productRunId: input.productRunId as never,
        workflowRunSpecId: input.workflowRunSpecId as never,
        definitionNodeId: input.definitionNodeId as never,
        executionPath: [],
        attemptNumber: 1,
        toStatus: input.toStatus,
        ...(input.outcomeCode === undefined ? {} : { outcomeCode: input.outcomeCode }),
        publicSummary: input.publicSummary,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}
