import { defineHook } from "workflow";
import { z } from "zod";
import type { WorkflowRunSpec } from "@chat/contracts";
import {
  loadNoteCaptureRunSpecStep,
  recordConfigurablePlanningNodeStep,
  type ConfigurablePlanningNodeTransition,
} from "./configurable-planning-steps.js";
import {
  claimNoteDecisionHookStep,
  commitConfirmedNoteStep,
  generateAndPublishNoteCandidateStep,
  loadNoteDecisionStep,
  type NoteCandidateCheckpointRef,
  type NoteReviewCheckpoint,
} from "./note-capture-steps.js";
import { interpretRestrictedRunSpec } from "./restricted-run-spec-interpreter.js";
import { commitRunFailureStep } from "./workflow-result-steps.js";
import { PiStepFailure } from "./workflow-error.js";

export const noteCaptureWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("note-capture-workflow-input.v1"),
    productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
    attemptId: z.string().regex(/^att_[A-Za-z0-9]+$/),
    workflowRunSpecId: z.string().regex(/^wrs_[A-Za-z0-9]+$/),
  })
  .strict();

export type NoteCaptureWorkflowInput = z.infer<typeof noteCaptureWorkflowInputSchema>;

export interface NoteCaptureWorkflowResult {
  readonly outcome: "note_committed" | "rejected" | "failed";
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly errorCode?: string;
}

const noteDecisionHook = defineHook({
  schema: z
    .object({
      schemaVersion: z.literal("note-decision-hook-payload.v1"),
      productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
      hookNoteCandidateId: z.string().regex(/^ntc_[A-Za-z0-9]+$/),
      noteCandidateId: z.string().regex(/^ntc_[A-Za-z0-9]+$/),
      noteDecisionId: z.string().regex(/^ntd_[A-Za-z0-9]+$/),
    })
    .strict(),
});

type NoteNodeIdentity = Pick<
  ConfigurablePlanningNodeTransition,
  "productRunId" | "workflowRunSpecId" | "definitionNodeId" | "executionPath" | "attemptNumber"
>;

interface NoteInterpreterState {
  candidate?: NoteCandidateCheckpointRef;
  review?: NoteReviewCheckpoint;
  autoContinuePolicyRef?: {
    readonly workflowPolicyResolutionId: string;
    readonly revision: 1;
    readonly sha256: string;
  };
  decision?: { readonly noteDecisionId: string; readonly kind: "confirm" };
  committed: boolean;
}

/**
 * Note与Planning共用interpretRestrictedRunSpec控制内核和静态Executor Registry。
 * 本文件只实现Note业务Adapter：来源准备、单次pi候选、Decision-first Hook和正式Note提交。
 */
export async function noteCaptureWorkflow(
  rawInput: NoteCaptureWorkflowInput,
): Promise<NoteCaptureWorkflowResult> {
  "use workflow";
  const input = noteCaptureWorkflowInputSchema.parse(rawInput);
  try {
    const runSpec = await loadNoteCaptureRunSpecStep({
      productRunId: input.productRunId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
    return await interpretNoteRunSpec(input, runSpec);
  } catch (error) {
    const failure = failureSummary(error);
    await commitRunFailureStep({
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      errorCode: failure.code,
      summary: failure.summary,
    });
    return workflowResult(input, "failed", failure.code);
  }
}

async function interpretNoteRunSpec(
  input: NoteCaptureWorkflowInput,
  runSpec: WorkflowRunSpec,
): Promise<NoteCaptureWorkflowResult> {
  const state: NoteInterpreterState = { committed: false };
  const interpreted = await interpretRestrictedRunSpec<NoteCaptureWorkflowResult>({
    runSpec,
    onLoopLimitExceeded: async () =>
      failRun(input, "note_revision_limit_reached", "笔记候选修订已达上限，请调整来源后重新开始"),
    executeNode: async ({ element, resolution, registration, executionPath }) => {
      const identity: NoteNodeIdentity = {
        productRunId: input.productRunId,
        workflowRunSpecId: input.workflowRunSpecId,
        definitionNodeId: element.definitionNodeId,
        executionPath,
        attemptNumber: 1,
      };
      if (resolution.activation === "skipped") {
        if (resolution.skipOutcome === undefined) {
          throw new Error("note_capture.skip_outcome_missing");
        }
        await recordConfigurablePlanningNodeStep({
          ...identity,
          toStatus: "skipped",
          outcomeCode: resolution.skipOutcome,
          publicSummary: "本次冻结配置明确跳过该可选节点",
        });
        return { outcome: resolution.skipOutcome };
      }
      switch (registration.operation) {
        case "extract_note":
        case "classify_note": {
          // 只有没有独立产品事务的计算节点由通用transition拥有状态。
          // Review/Commit由Application在Candidate、Decision、Revision事务内原子投影，
          // 再补写不同summary/outcome会把合法重放变成409。
          try {
            return registration.operation === "extract_note"
              ? {
                  outcome: await extractCandidate(
                    input,
                    runSpec,
                    resolution.config,
                    identity,
                    state,
                  ),
                }
              : { outcome: await classifyCandidate(identity, state) };
          } catch (error) {
            await recordConfigurablePlanningNodeStep({
              ...identity,
              toStatus: "failed",
              outcomeCode: nodeFailureCode(error),
              publicSummary: "Note节点未完成，已安全停止",
            });
            throw error;
          }
        }
        case "review_note": {
          const outcome = await reviewCandidate(input, runSpec, state);
          return outcome === "rejected"
            ? { outcome, terminal: workflowResult(input, "rejected") }
            : { outcome };
        }
        case "commit_note":
          await commitCandidate(input, state);
          return { outcome: "committed" };
        default:
          throw new Error(`note_capture.planning_node_not_allowed.${registration.operation}`);
      }
    },
  });
  if (interpreted.kind === "terminal") return interpreted.value;
  if (!state.committed) {
    return failRun(
      input,
      "note_capture.terminal_commit_missing",
      "工作流没有提交正式Note，已安全停止",
    );
  }
  return workflowResult(input, "note_committed");
}

async function extractCandidate(
  input: NoteCaptureWorkflowInput,
  runSpec: WorkflowRunSpec,
  config: Readonly<Record<string, unknown>>,
  identity: NoteNodeIdentity,
  state: NoteInterpreterState,
): Promise<"extracted"> {
  await recordConfigurablePlanningNodeStep({
    ...identity,
    toStatus: "running",
    publicSummary: "正在从冻结来源生成Note候选",
  });
  const maxCharacters = config["maxCharacters"];
  if (typeof maxCharacters !== "number") {
    throw new Error("note_capture.source_exceeds_node_limit");
  }
  const allowCustomTags = runSpec.nodeResolutions.find(
    (resolution) => resolution.nodeType === "note.classify",
  )?.config["allowCustomTags"];
  if (typeof allowCustomTags !== "boolean") {
    throw new Error("note_capture.classify_config_invalid");
  }
  const generated = await generateAndPublishNoteCandidateStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    workflowRunSpecId: input.workflowRunSpecId,
    maxCharacters,
    allowCustomTags,
  });
  if (generated.status === "failed") {
    throw new PiStepFailure(generated.errorCode, "Note候选模型节点失败");
  }
  state.candidate = generated.candidate;
  state.review = generated.review;
  if (generated.review.outcome === "auto_continued") {
    state.autoContinuePolicyRef = generated.review.policyResolutionRef;
  } else {
    delete state.autoContinuePolicyRef;
  }
  delete state.decision;
  await recordConfigurablePlanningNodeStep({
    ...identity,
    toStatus: "succeeded",
    outcomeCode: "extracted",
    publicSummary: "Note候选已发布，尚未成为正式笔记",
  });
  return "extracted";
}

async function classifyCandidate(
  identity: NoteNodeIdentity,
  state: NoteInterpreterState,
): Promise<"classified"> {
  if (state.candidate === undefined) throw new Error("note_capture.classify_without_candidate");
  await recordConfigurablePlanningNodeStep({
    ...identity,
    toStatus: "running",
    publicSummary: "正在核对候选分类",
  });
  // runPiNoteCapture已在同一个strict工具调用里返回kind/tag；没有独立分类产品提交边界，
  // 因此这里复用已发布Candidate证据，不重复调用模型、不伪造第二份候选。
  await recordConfigurablePlanningNodeStep({
    ...identity,
    toStatus: "succeeded",
    outcomeCode: "classified",
    publicSummary: "分类与标签已包含在同一候选证据中，未重复调用模型",
  });
  return "classified";
}

async function reviewCandidate(
  input: NoteCaptureWorkflowInput,
  runSpec: WorkflowRunSpec,
  state: NoteInterpreterState,
): Promise<"approved" | "request_revision" | "rejected"> {
  const candidate = state.candidate;
  if (candidate === undefined) throw new Error("note_capture.review_without_candidate");
  const resolution = runSpec.reviewResolutions.find(
    (item) => item.definitionNodeId === "note.review",
  );
  const review = state.review;
  if (review === undefined) throw new Error("note_capture.review_resolution_missing");
  if (resolution?.mode === "auto_continue_if_policy_allows") {
    if (review.outcome === "auto_continued") {
      // Candidate发布事务已经把Candidate确认为confirmed并原子投影Review成功；这里不建
      // Hook、不伪造Decision，只把权威Policy Resolution ref带到后续commit前置检查。
      state.autoContinuePolicyRef = review.policyResolutionRef;
      delete state.decision;
      return "approved";
    }
    if (review.outcome !== "policy_denied_waiting_human") {
      throw new Error("note_capture.auto_review_resolution_mismatch");
    }
  } else if (resolution?.mode === "manual") {
    if (review.outcome !== "waiting_human") {
      throw new Error("note_capture.manual_review_resolution_mismatch");
    }
  } else {
    throw new Error("note_capture.review_mode_invalid");
  }
  // manual或系统策略denied都复用同一人工Decision-first Hook；Policy denied本身不能
  // 被Workflow提升为批准，只有后续产品Decision能继续或发起修订。
  using hook = noteDecisionHook.create({ token: candidate.noteCandidateId });
  if ((await hook.getConflict()) !== null) throw new Error("workflow.hook_conflict");
  await claimNoteDecisionHookStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    noteCandidateId: candidate.noteCandidateId,
    candidateSequence: candidate.candidateSequence,
  });
  const resumeSignal = await hook;
  if (resumeSignal.hookNoteCandidateId !== candidate.noteCandidateId) {
    throw new Error("note_capture.hook_candidate_mismatch");
  }
  const loaded = await loadNoteDecisionStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    workflowRunSpecId: input.workflowRunSpecId,
    noteCandidateId: resumeSignal.noteCandidateId,
    noteDecisionId: resumeSignal.noteDecisionId,
  });
  state.candidate = loaded.candidate;
  const outcome =
    loaded.decision.kind === "confirm"
      ? ("approved" as const)
      : loaded.decision.kind === "request_revision"
        ? ("request_revision" as const)
        : ("rejected" as const);
  if (loaded.decision.kind === "confirm") {
    delete state.autoContinuePolicyRef;
    state.decision = {
      noteDecisionId: loaded.decision.noteDecisionId,
      kind: "confirm",
    };
  } else {
    delete state.autoContinuePolicyRef;
    delete state.decision;
  }
  return outcome;
}

async function commitCandidate(
  input: NoteCaptureWorkflowInput,
  state: NoteInterpreterState,
): Promise<void> {
  if (
    state.candidate === undefined ||
    (state.decision?.kind !== "confirm" && state.autoContinuePolicyRef === undefined)
  ) {
    throw new Error("note_capture.commit_without_confirmed_candidate");
  }
  await commitConfirmedNoteStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    noteCandidateId: state.candidate.noteCandidateId,
  });
  state.committed = true;
}

async function failRun(
  input: NoteCaptureWorkflowInput,
  code: string,
  summary: string,
): Promise<NoteCaptureWorkflowResult> {
  await commitRunFailureStep({
    productRunId: input.productRunId,
    attemptId: input.attemptId,
    errorCode: code,
    summary,
  });
  return workflowResult(input, "failed", code);
}

function nodeFailureCode(error: unknown): string {
  const code = failureSummary(error).code;
  return code.length <= 64 ? code : "note_capture.node_failed";
}

function failureSummary(error: unknown): { readonly code: string; readonly summary: string } {
  if (error instanceof PiStepFailure) {
    return { code: error.stableCode, summary: "Note候选生成失败，请稍后重试" };
  }
  if (error instanceof Error && STABLE_ERROR_CODE.test(error.message)) {
    return { code: error.message, summary: "Note工作流遇到不可恢复的合同错误" };
  }
  return { code: "note_capture.runner_failed", summary: "Note工作流遇到内部错误" };
}

function workflowResult(
  input: NoteCaptureWorkflowInput,
  outcome: NoteCaptureWorkflowResult["outcome"],
  errorCode?: string,
): NoteCaptureWorkflowResult {
  return {
    outcome,
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
