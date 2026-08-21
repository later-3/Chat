import { MODEL_CONFIG_VERSION } from "@chat/contracts";
import { hashCanonical, normalizeNoteTagLabel } from "@chat/domain";
import { NOTE_CAPTURE_PROMPT_TEMPLATE_VERSION } from "@chat/pi-runtime";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";
import {
  cmdId,
  emitCompletedProviderCall,
  emitPiNodeTrace,
  emitProviderTrace,
  providerResultTraceDetails,
  runStep,
  wrapApiError,
} from "./workflow-step-support.js";

interface NoteStepIdentity {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly workflowRunSpecId: string;
}

export interface NoteCandidateCheckpointRef {
  readonly noteCandidateId: string;
  readonly candidateSequence: number;
  readonly sha256: string;
}

export type NoteReviewCheckpoint =
  | { readonly outcome: "waiting_human" }
  | {
      readonly outcome: "policy_denied_waiting_human" | "auto_continued";
      readonly policyResolutionRef: {
        readonly workflowPolicyResolutionId: string;
        readonly revision: 1;
        readonly sha256: string;
      };
    };

/**
 * 正文读取、单次pi调用与Candidate提交必须位于同一Step；Workflow checkpoint只得到
 * Candidate ref或稳定失败码，不得到sourceText、prior content或模型Candidate正文。
 */
export async function generateAndPublishNoteCandidateStep(
  input: NoteStepIdentity & {
    readonly maxCharacters: number;
    readonly allowCustomTags: boolean;
  },
): Promise<
  | {
      readonly status: "published";
      readonly candidate: NoteCandidateCheckpointRef;
      readonly review: NoteReviewCheckpoint;
    }
  | { readonly status: "failed"; readonly errorCode: string }
> {
  "use step";
  return runStep(
    input.productRunId,
    input.attemptId,
    "generate_publish_note_candidate",
    async () => {
      const ctx = getWorkflowRuntimeContext();
      const startedAt = performance.now();
      let prepared;
      try {
        prepared = await ctx.api.prepareNoteCaptureInput({
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
        });
      } catch (error) {
        wrapApiError(error);
      }
      if (prepared.sourceText.length > input.maxCharacters) {
        return { status: "failed", errorCode: "note_capture.source_exceeds_node_limit" };
      }
      const scope = {
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        promptTemplateVersion: NOTE_CAPTURE_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
      };
      const captureInput = {
        sourceText: prepared.sourceText,
        defaultKind: prepared.defaultKind,
        suggestedTagLabels: prepared.suggestedTagLabels,
        ...(prepared.priorCandidate === undefined
          ? {}
          : {
              priorCandidate: {
                title: prepared.priorCandidate.proposed.title,
                kind: prepared.priorCandidate.proposed.kind,
                contentMarkdown: prepared.priorCandidate.proposed.contentMarkdown,
                tagLabels: prepared.priorCandidate.proposed.tags.map((tag) => tag.label),
              },
            }),
        ...(prepared.revisionInstruction === undefined
          ? {}
          : { revisionInstruction: prepared.revisionInstruction }),
      };
      // Trace只保存冻结ref与配置摘要Hash，不保存来源正文或候选正文。
      const inputManifestSha256 = hashCanonical("note-capture-model-input.v1", {
        source: prepared.source,
        defaultKind: captureInput.defaultKind,
        suggestedTagLabels: captureInput.suggestedTagLabels,
        priorCandidateSha256: prepared.priorCandidate?.sha256 ?? null,
        revisionInstructionPresent: prepared.revisionInstruction !== undefined,
        promptAssemblyRef:
          prepared.nodePrompt === undefined
            ? null
            : {
                promptAssemblyId: prepared.nodePrompt.promptAssemblyId,
                sha256: prepared.nodePrompt.promptAssemblySha256,
                definitionNodeId: prepared.nodePrompt.definitionNodeId,
                nodeAssemblySha256: prepared.nodePrompt.nodeAssemblySha256,
              },
      });
      if (ctx.bailian.apiKey === undefined) {
        const code = "provider.pre_request.no_api_key";
        emitProviderTrace(scope, "provider.request.failed", {
          durationMs: 0,
          errorCode: code,
          preRequest: true,
        });
        emitPiNodeTrace(scope, "pi.node.failed", "note_capture", { errorCode: code });
        return { status: "failed", errorCode: code };
      }
      emitPiNodeTrace(scope, "pi.node.started", "note_capture");
      try {
        const result = await ctx.noteCapture({
          config: ctx.bailian,
          captureInput,
          ...(prepared.nodePrompt === undefined
            ? {}
            : { systemPromptAppend: prepared.nodePrompt.systemPromptAppend }),
          onProviderRequestStart: () =>
            emitProviderTrace(scope, "provider.request.started", { inputManifestSha256 }),
        });
        if (result.kind === "candidate") {
          if (!emitCompletedProviderCall(scope, inputManifestSha256, result)) {
            return { status: "failed", errorCode: "provider.evidence_missing" };
          }
          emitPiNodeTrace(scope, "pi.node.completed", "note_capture", {
            durationMs: result.durationMs,
          });
          if (!input.allowCustomTags) {
            const allowedKeys = new Set(
              prepared.suggestedTagLabels.map((label) => normalizeNoteTagLabel(label).key),
            );
            if (
              result.candidate.tagLabels.some(
                (label) => !allowedKeys.has(normalizeNoteTagLabel(label).key),
              )
            ) {
              return { status: "failed", errorCode: "model.candidate.capability_violation" };
            }
          }
          const candidateSha256 = hashCanonical("note-revision-input.v1", result.candidate);
          try {
            const published = await ctx.api.publishNoteCandidate({
              commandId: cmdId(
                "generate-publish-note-candidate",
                input.productRunId,
                String((prepared.priorCandidate?.candidateSequence ?? 0) + 1),
              ) as never,
              productRunId: input.productRunId as never,
              proposed: result.candidate,
            });
            ctx.trace({
              level: "info",
              eventName: "note.candidate.received",
              outcome: "unknown",
              traceId: workflowRunTraceId(input.productRunId),
              spanId: workflowSpanId(),
              productRunId: input.productRunId as never,
              attemptId: input.attemptId as never,
              candidateSha256: published.candidate.sha256,
            } as never);
            return {
              status: "published",
              candidate: {
                noteCandidateId: published.candidate.noteCandidateId,
                candidateSequence: published.candidate.candidateSequence,
                sha256: published.candidate.sha256,
              },
              // Application在Candidate事务内生成并持久化Policy Resolution；Workflow只消费
              // outcome和不可变ref，不在耐久作用域重算低风险策略。
              review: published.review,
            };
          } catch (error) {
            ctx.trace({
              level: "warn",
              eventName: "note.candidate.rejected",
              outcome: "rejected",
              traceId: workflowRunTraceId(input.productRunId),
              spanId: workflowSpanId(),
              productRunId: input.productRunId as never,
              attemptId: input.attemptId as never,
              candidateSha256,
              error: { code: "note.candidate_rejected", type: "NoteCandidateError" },
            } as never);
            wrapApiError(error);
          }
        }
        if (result.kind === "invalid_candidate") {
          if (!emitCompletedProviderCall(scope, inputManifestSha256, result)) {
            return { status: "failed", errorCode: "provider.evidence_missing" };
          }
          const errorCode = `model.candidate.${result.errorCode}`;
          emitPiNodeTrace(scope, "pi.node.failed", "note_capture", {
            durationMs: result.durationMs,
            errorCode,
            ...(result.diagnostics === undefined
              ? {}
              : { candidateValidation: result.diagnostics }),
          });
          return { status: "failed", errorCode };
        }
        emitProviderTrace(scope, "provider.request.failed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          errorCode: result.errorCode,
          ...(result.providerMeta.httpStatus === undefined
            ? {}
            : { httpStatus: result.providerMeta.httpStatus }),
          ...(result.providerMeta.providerRequestId === undefined
            ? {}
            : { providerRequestId: result.providerMeta.providerRequestId }),
          ...providerResultTraceDetails(result.providerMeta),
          ...(result.providerCallCount === 0 ? { preRequest: true } : {}),
        });
        return { status: "failed", errorCode: result.errorCode };
      } catch (error) {
        void error;
        const code = "provider.pre_request.note_capture_failed";
        emitProviderTrace(scope, "provider.request.failed", {
          durationMs: Math.round(performance.now() - startedAt),
          errorCode: code,
          preRequest: true,
        });
        emitPiNodeTrace(scope, "pi.node.failed", "note_capture", { errorCode: code });
        return { status: "failed", errorCode: code };
      }
    },
  );
}
generateAndPublishNoteCandidateStep.maxRetries = 0;

export async function claimNoteDecisionHookStep(input: {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly noteCandidateId: string;
  readonly candidateSequence: number;
}): Promise<void> {
  "use step";
  await runStep(input.productRunId, input.attemptId, "claim_note_decision_hook", async () => {
    await getWorkflowRuntimeContext().bindings.claimNoteHookBinding({
      noteCandidateId: input.noteCandidateId as never,
      productRunId: input.productRunId as never,
      candidateSequence: input.candidateSequence,
      // Hook token等于稳定Product Candidate身份；Workflow不再构造或checkpoint第二个私有token。
      hookToken: input.noteCandidateId,
      now: getWorkflowRuntimeContext().now(),
    });
  });
}

export async function loadNoteDecisionStep(input: {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly workflowRunSpecId: string;
  readonly noteCandidateId: string;
  readonly noteDecisionId: string;
}): Promise<{
  readonly candidate: NoteCandidateCheckpointRef;
  readonly decision: {
    readonly noteDecisionId: string;
    readonly kind: "confirm" | "request_revision" | "reject";
  };
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "load_note_decision", async () => {
    try {
      const loaded = await getWorkflowRuntimeContext().api.loadNoteDecision({
        productRunId: input.productRunId as never,
        workflowRunSpecId: input.workflowRunSpecId as never,
        noteCandidateId: input.noteCandidateId as never,
        noteDecisionId: input.noteDecisionId as never,
      });
      return {
        candidate: {
          noteCandidateId: loaded.candidate.noteCandidateId,
          candidateSequence: loaded.candidate.candidateSequence,
          sha256: loaded.candidate.sha256,
        },
        decision: {
          noteDecisionId: loaded.decision.noteDecisionId,
          kind: loaded.decision.kind,
        },
      };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitConfirmedNoteStep(input: {
  readonly productRunId: string;
  readonly attemptId: string;
  readonly noteCandidateId: string;
}): Promise<void> {
  "use step";
  await runStep(input.productRunId, input.attemptId, "commit_confirmed_note", async () => {
    try {
      await getWorkflowRuntimeContext().api.commitConfirmedNote({
        commandId: cmdId(
          "commit-confirmed-note",
          input.productRunId,
          input.noteCandidateId,
        ) as never,
        productRunId: input.productRunId as never,
        noteCandidateId: input.noteCandidateId as never,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}
