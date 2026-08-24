import {
  DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
  PRODUCT_API_SCHEMA_VERSION,
  toolExecutionDecisionDtoSchema,
  toolExecutionIntentDtoSchema,
  toolExecutionResultDtoSchema,
  toolExecutionIntentIdSchema,
  toolExecutionDecisionIdSchema,
  toolExecutionResultIdSchema,
  type ClaimToolExecutionDecisionRuntimeRequest,
  type ClaimToolExecutionDecisionRuntimeResponse,
  type CommandId,
  type CommitToolExecutionResultRuntimeRequest,
  type PrincipalId,
  type ProductRunId,
  type PublishToolExecutionIntentRuntimeRequest,
  type SubmitToolExecutionDecisionPayload,
  type ToolExecutionDecision,
  type ToolExecutionIntent,
  type ToolExecutionIntentDto,
  type ToolExecutionResult,
} from "@chat/contracts";
import {
  assertToolExecutionIntentTransition,
  computeDirectRuntimeOperationRefSha256,
  computeToolExecutionDecisionSha256,
  hashCanonical,
  transitionDirectAgentRunLifecycle,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";
import { readExactCommandReceipt } from "./product-store-port.js";
import { requireDirectAgentRun } from "./product-run-kind.js";
import { settleRunWithoutSuccess } from "./run-settlement.js";

function derivedId(prefix: "tei" | "ted" | "ter", domain: string, value: unknown): string {
  return `${prefix}_${hashCanonical(domain, value).slice(0, 40)}`;
}

function toIntentDto(
  intent: ToolExecutionIntent,
  frozen?: {
    readonly status: ToolExecutionIntent["status"];
    readonly revision: number;
    readonly updatedAt: string;
  },
): ToolExecutionIntentDto {
  const status = frozen?.status ?? intent.status;
  return toolExecutionIntentDtoSchema.parse({
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    toolExecutionIntentId: intent.toolExecutionIntentId,
    productRunId: intent.productRunId,
    capability: intent.capability,
    toolCallId: intent.toolCallId,
    inputDisplay: intent.inputDisplay,
    inputDisplayTruncated: intent.inputDisplayTruncated,
    inputSha256: intent.inputSha256,
    scopeRef: intent.scopeRef,
    effect: intent.effect,
    status,
    revision: frozen?.revision ?? intent.revision,
    allowedActions: status === "waiting_decision" ? ["approve", "reject"] : [],
    createdAt: intent.createdAt,
    updatedAt: frozen?.updatedAt ?? intent.updatedAt,
  });
}

function assertPublishedIntentIdentity(
  intent: ToolExecutionIntent,
  input: PublishToolExecutionIntentRuntimeRequest,
  expectedIntentId: string,
): void {
  if (
    intent.toolExecutionIntentId !== expectedIntentId ||
    intent.productRunId !== input.productRunId ||
    intent.attemptId !== input.directAgentAttemptId ||
    intent.runtimeOperationRefSha256 !== input.runtimeOperationRefSha256 ||
    intent.toolCallId !== input.toolCallId ||
    intent.inputDisplay !== input.inputDisplay ||
    intent.inputDisplayTruncated !== input.inputDisplayTruncated ||
    intent.inputSha256 !== input.inputSha256 ||
    intent.effect !== input.effect ||
    JSON.stringify(intent.capability) !== JSON.stringify(input.capability) ||
    JSON.stringify(intent.scopeRef) !== JSON.stringify(input.scopeRef)
  ) {
    throw revisionConflict("Tool Intent Receipt与原始Runtime请求绑定不一致");
  }
}

function toolDecisionResponse(
  decision: ToolExecutionDecision,
  intent: ToolExecutionIntent,
): {
  readonly decision: ReturnType<typeof toolExecutionDecisionDtoSchema.parse>;
  readonly intent: ToolExecutionIntentDto;
} {
  if (
    decision.toolExecutionIntentId !== intent.toolExecutionIntentId ||
    decision.productRunId !== intent.productRunId ||
    decision.capabilityDescriptorSha256 !== intent.capability.ref.descriptorSha256 ||
    decision.inputSha256 !== intent.inputSha256 ||
    JSON.stringify(decision.scopeRef) !== JSON.stringify(intent.scopeRef)
  ) {
    throw revisionConflict("Tool Decision Receipt与Intent绑定不一致");
  }
  return {
    decision: toolExecutionDecisionDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      toolExecutionDecisionId: decision.toolExecutionDecisionId,
      toolExecutionIntentId: decision.toolExecutionIntentId,
      productRunId: decision.productRunId,
      intentRevision: decision.intentRevision,
      capabilityDescriptorSha256: decision.capabilityDescriptorSha256,
      inputSha256: decision.inputSha256,
      scopeRef: decision.scopeRef,
      kind: decision.kind,
      ...(decision.explanation === undefined ? {} : { explanation: decision.explanation }),
      createdAt: decision.createdAt,
    }),
    intent: toIntentDto(intent, {
      status: decision.kind === "approve" ? "approved" : "rejected",
      revision: decision.intentRevision + 1,
      updatedAt: decision.createdAt,
    }),
  };
}

function assertRuntimeBinding(
  intent: ToolExecutionIntent,
  input: {
    readonly productRunId: ProductRunId;
    readonly directAgentAttemptId: string;
    readonly intentRevision: number;
    readonly capabilityDescriptorSha256: string;
    readonly inputSha256: string;
    readonly scopeRef: ToolExecutionIntent["scopeRef"];
  },
): void {
  if (
    intent.productRunId !== input.productRunId ||
    intent.attemptId !== input.directAgentAttemptId ||
    intent.revision !== input.intentRevision ||
    intent.capability.ref.descriptorSha256 !== input.capabilityDescriptorSha256 ||
    intent.inputSha256 !== input.inputSha256 ||
    JSON.stringify(intent.scopeRef) !== JSON.stringify(input.scopeRef)
  ) {
    throw revisionConflict("Tool Execution Intent的revision、Capability、参数或Scope已变化");
  }
}

function assertClaimBinding(
  intent: ToolExecutionIntent,
  input: ClaimToolExecutionDecisionRuntimeRequest,
): void {
  if (
    intent.productRunId !== input.productRunId ||
    intent.attemptId !== input.directAgentAttemptId ||
    (intent.status === "waiting_decision" && intent.revision !== input.intentRevision) ||
    intent.capability.ref.descriptorSha256 !== input.capabilityDescriptorSha256 ||
    intent.inputSha256 !== input.inputSha256 ||
    JSON.stringify(intent.scopeRef) !== JSON.stringify(input.scopeRef)
  ) {
    throw revisionConflict("Tool Execution Intent的原始revision、Capability、参数或Scope已变化");
  }
}

export async function publishToolExecutionIntent(
  deps: ApplicationDeps,
  input: PublishToolExecutionIntentRuntimeRequest,
): Promise<ToolExecutionIntentDto> {
  const requestSha256 = hashCanonical("command.publish-tool-execution-intent.v1", input);
  const exact = await readExactCommandReceipt(deps.store, () => ({
    commandId: input.commandId,
    commandType: "PublishToolExecutionIntent",
    requestSha256,
  }));
  const toolExecutionIntentId = toolExecutionIntentIdSchema.parse(
    derivedId("tei", "id.tool-execution-intent.v1", {
      productRunId: input.productRunId,
      directAgentAttemptId: input.directAgentAttemptId,
      toolCallId: input.toolCallId,
      capabilityId: input.capability.ref.capabilityId,
      inputSha256: input.inputSha256,
    }),
  );
  if (exact.receipt !== undefined) {
    const receiptIntentId = exact.receipt.resultRefs["toolExecutionIntentId"];
    const intent = exact.snapshot.entities.toolExecutionIntents[receiptIntentId ?? ""];
    if (receiptIntentId !== toolExecutionIntentId || intent === undefined) {
      throw revisionConflict("Tool Intent Receipt缺少不可变命令结果");
    }
    assertPublishedIntentIdentity(intent, input, toolExecutionIntentId);
    return toIntentDto(intent, {
      status: "waiting_decision",
      revision: 1,
      updatedAt: intent.createdAt,
    });
  }
  if (
    input.effect !== input.capability.effect ||
    input.capability.approvalPolicy !== "product_decision_required" ||
    input.capability.evidencePolicy !== "product_intent_result" ||
    JSON.stringify(input.scopeRef) !== JSON.stringify(input.capability.ref.scopeRef)
  ) {
    throw revisionConflict("Tool Capability不是可审核的高影响动作或Scope不一致");
  }
  const now = deps.now();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PublishToolExecutionIntent",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      if (!(
        (run.status === "running" && run.phase === "executing") ||
        (run.status === "waiting_human" && run.phase === "tool_review")
      )) {
        throw revisionConflict("Direct Agent当前不能发布Tool动作审核");
      }
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== input.productRunId ||
        attempt.kind !== "direct_agent" ||
        attempt.outcome !== "running"
      ) {
        throw revisionConflict("Direct Agent Attempt不存在或已终结");
      }
      const assemblies = Object.values(draft.entities.promptAssemblies).filter(
        (assembly) => assembly.productRunId === input.productRunId,
      );
      const assembly = assemblies.length === 1 ? assemblies[0] : undefined;
      if (
        assembly?.schemaVersion !== "prompt-assembly.v4" ||
        attempt.inputManifestSha256 === undefined
      ) {
        throw revisionConflict("历史Run没有qualified Capability冻结事实，不能发布新Tool Intent");
      }
      const expectedOperationRef = computeDirectRuntimeOperationRefSha256({
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        inputManifestSha256: attempt.inputManifestSha256,
      });
      const frozenCapability = assembly.tools.capabilities.find(
        (candidate) => candidate.ref.capabilityId === input.capability.ref.capabilityId,
      );
      const scopePolicyValid =
        (input.capability.scopePolicy === "global" && input.scopeRef.kind === "global") ||
        (input.capability.scopePolicy === "workspace_required" &&
          input.scopeRef.kind === "workspace" &&
          input.scopeRef.rootId === assembly.workspaceRootId) ||
        (input.capability.scopePolicy === "provider_defined" && input.scopeRef.kind === "provider");
      if (
        input.runtimeOperationRefSha256 !== expectedOperationRef ||
        frozenCapability === undefined ||
        JSON.stringify(frozenCapability) !== JSON.stringify(input.capability) ||
        !scopePolicyValid
      ) {
        throw revisionConflict("Tool Intent不属于该Attempt冻结的Capability Manifest或Scope");
      }
      const existing = draft.entities.toolExecutionIntents[toolExecutionIntentId];
      if (existing !== undefined) throw revisionConflict("Tool Call身份已被不同命令占用");
      const intent: ToolExecutionIntent = {
        schemaVersion: "tool-execution-intent.v1",
        toolExecutionIntentId,
        productRunId: input.productRunId,
        attemptId: input.directAgentAttemptId,
        runtimeOperationRefSha256: input.runtimeOperationRefSha256,
        capability: input.capability,
        toolCallId: input.toolCallId,
        inputDisplay: input.inputDisplay,
        inputDisplayTruncated: input.inputDisplayTruncated,
        inputSha256: input.inputSha256,
        scopeRef: input.scopeRef,
        effect: input.effect,
        revision: 1,
        status: "waiting_decision",
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.toolExecutionIntents[toolExecutionIntentId] = intent;
      if (run.status === "running" && run.phase === "executing") {
        const lifecycle = transitionDirectAgentRunLifecycle(
          { status: run.status, phase: run.phase },
          { status: "waiting_human", phase: "tool_review" },
        );
        draft.entities.runs[input.productRunId] = {
          ...run,
          ...lifecycle,
          revision: run.revision + 1,
          updatedAt: now,
        };
      }
      return { resultRefs: { toolExecutionIntentId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent =
    snapshot.entities.toolExecutionIntents[result.resultRefs["toolExecutionIntentId"] ?? ""];
  if (intent === undefined) throw notFound("Tool Execution Intent不存在");
  assertPublishedIntentIdentity(intent, input, toolExecutionIntentId);
  return toIntentDto(intent, {
    status: "waiting_decision",
    revision: 1,
    updatedAt: intent.createdAt,
  });
}

export async function getToolExecutions(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const found = snapshot.entities.runs[input.productRunId];
  if (found === undefined) throw notFound("Product Run不存在");
  const session = snapshot.entities.sessions[found.sessionId];
  if (session === undefined) throw notFound("Session不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权访问Tool审核");
  const intents = Object.values(snapshot.entities.toolExecutionIntents)
    .filter((intent) => intent.productRunId === input.productRunId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const intentIds = new Set(intents.map((intent) => intent.toolExecutionIntentId));
  return {
    intents: intents.map((intent) => toIntentDto(intent)),
    decisions: Object.values(snapshot.entities.toolExecutionDecisions)
      .filter((decision) => intentIds.has(decision.toolExecutionIntentId))
      .map((decision) =>
        toolExecutionDecisionDtoSchema.parse({
          schemaVersion: PRODUCT_API_SCHEMA_VERSION,
          toolExecutionDecisionId: decision.toolExecutionDecisionId,
          toolExecutionIntentId: decision.toolExecutionIntentId,
          productRunId: decision.productRunId,
          intentRevision: decision.intentRevision,
          capabilityDescriptorSha256: decision.capabilityDescriptorSha256,
          inputSha256: decision.inputSha256,
          scopeRef: decision.scopeRef,
          kind: decision.kind,
          ...(decision.explanation === undefined ? {} : { explanation: decision.explanation }),
          createdAt: decision.createdAt,
        }),
      ),
    results: Object.values(snapshot.entities.toolExecutionResults)
      .filter((result) => intentIds.has(result.toolExecutionIntentId))
      .map((result) =>
        toolExecutionResultDtoSchema.parse({
          schemaVersion: PRODUCT_API_SCHEMA_VERSION,
          toolExecutionResultId: result.toolExecutionResultId,
          toolExecutionIntentId: result.toolExecutionIntentId,
          productRunId: result.productRunId,
          outcome: result.outcome,
          ...(result.resultSha256 === undefined ? {} : { resultSha256: result.resultSha256 }),
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          createdAt: result.createdAt,
        }),
      ),
  };
}

export async function submitToolExecutionDecision(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly productRunId: ProductRunId;
    readonly commandId: CommandId;
    readonly expectedIntentRevision: number;
    readonly payload: SubmitToolExecutionDecisionPayload;
  },
) {
  const toolExecutionDecisionId = toolExecutionDecisionIdSchema.parse(
    derivedId("ted", "id.tool-execution-decision.v1", { commandId: input.commandId }),
  );
  const requestSha256 = hashCanonical("command.submit-tool-execution-decision.v1", input);
  const exact = await readExactCommandReceipt(deps.store, () => ({
    commandId: input.commandId,
    commandType: "SubmitToolExecutionDecision",
    requestSha256,
  }));
  if (exact.receipt !== undefined) {
    const decisionId = exact.receipt.resultRefs["toolExecutionDecisionId"];
    const intentId = exact.receipt.resultRefs["toolExecutionIntentId"];
    const decision = exact.snapshot.entities.toolExecutionDecisions[decisionId ?? ""];
    const intent = exact.snapshot.entities.toolExecutionIntents[intentId ?? ""];
    if (
      decisionId !== toolExecutionDecisionId ||
      intentId !== input.payload.toolExecutionIntentId ||
      decision === undefined ||
      intent === undefined ||
      decision.principalId !== input.principalId ||
      decision.commandId !== input.commandId ||
      decision.intentRevision !== input.expectedIntentRevision ||
      decision.kind !== input.payload.kind ||
      decision.capabilityDescriptorSha256 !== input.payload.capabilityDescriptorSha256 ||
      decision.inputSha256 !== input.payload.inputSha256 ||
      JSON.stringify(decision.scopeRef) !== JSON.stringify(input.payload.scopeRef)
    ) {
      throw revisionConflict("Tool Decision Receipt缺少不可变命令结果或绑定已经损坏");
    }
    return toolDecisionResponse(decision, intent);
  }
  const now = deps.now();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SubmitToolExecutionDecision",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      const session = draft.entities.sessions[run.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权决定该Tool动作");
      if (!(run.status === "waiting_human" && run.phase === "tool_review")) {
        throw revisionConflict("终态或非Tool审核Run不能再提交Decision");
      }
      const intent = draft.entities.toolExecutionIntents[input.payload.toolExecutionIntentId];
      if (intent === undefined) throw notFound("Tool Execution Intent不存在");
      assertRuntimeBinding(intent, {
        productRunId: input.productRunId,
        directAgentAttemptId: intent.attemptId,
        intentRevision: input.expectedIntentRevision,
        capabilityDescriptorSha256: input.payload.capabilityDescriptorSha256,
        inputSha256: input.payload.inputSha256,
        scopeRef: input.payload.scopeRef,
      });
      if (
        input.payload.intentRevision !== input.expectedIntentRevision ||
        intent.status !== "waiting_decision"
      ) {
        throw revisionConflict("Tool Execution Intent已被决定或版本已过期");
      }
      assertToolExecutionIntentTransition(
        intent.status,
        input.payload.kind === "approve" ? "approved" : "rejected",
      );
      const decision: ToolExecutionDecision = {
        schemaVersion: "tool-execution-decision.v1",
        toolExecutionDecisionId,
        toolExecutionIntentId: intent.toolExecutionIntentId,
        productRunId: input.productRunId,
        intentRevision: intent.revision,
        capabilityDescriptorSha256: intent.capability.ref.descriptorSha256,
        inputSha256: intent.inputSha256,
        scopeRef: intent.scopeRef,
        kind: input.payload.kind,
        principalId: input.principalId,
        ...(input.payload.explanation === undefined
          ? {}
          : { explanation: input.payload.explanation }),
        commandId: input.commandId,
        sha256: "",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      decision.sha256 = computeToolExecutionDecisionSha256({
        toolExecutionDecisionId,
        toolExecutionIntentId: intent.toolExecutionIntentId,
        productRunId: input.productRunId,
        intentRevision: intent.revision,
        capabilityDescriptorSha256: intent.capability.ref.descriptorSha256,
        inputSha256: intent.inputSha256,
        scopeRef: intent.scopeRef,
        kind: input.payload.kind,
        principalId: input.principalId,
        ...(input.payload.explanation === undefined
          ? {}
          : { explanation: input.payload.explanation }),
        commandId: input.commandId,
      });
      draft.entities.toolExecutionDecisions[toolExecutionDecisionId] = decision;
      draft.entities.toolExecutionIntents[intent.toolExecutionIntentId] = {
        ...intent,
        status: input.payload.kind === "approve" ? "approved" : "rejected",
        decidedByToolExecutionDecisionId: toolExecutionDecisionId,
        revision: intent.revision + 1,
        updatedAt: now,
      };
      const otherWaiting = Object.values(draft.entities.toolExecutionIntents).some(
        (candidate) =>
          candidate.productRunId === input.productRunId &&
          candidate.toolExecutionIntentId !== intent.toolExecutionIntentId &&
          candidate.status === "waiting_decision",
      );
      if (!otherWaiting && run.status === "waiting_human" && run.phase === "tool_review") {
        const lifecycle = transitionDirectAgentRunLifecycle(
          { status: run.status, phase: run.phase },
          { status: "running", phase: "executing" },
        );
        draft.entities.runs[input.productRunId] = {
          ...run,
          ...lifecycle,
          revision: run.revision + 1,
          updatedAt: now,
        };
      }
      return {
        resultRefs: {
          toolExecutionDecisionId,
          toolExecutionIntentId: intent.toolExecutionIntentId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const decision =
    snapshot.entities.toolExecutionDecisions[result.resultRefs["toolExecutionDecisionId"] ?? ""];
  const intent =
    snapshot.entities.toolExecutionIntents[result.resultRefs["toolExecutionIntentId"] ?? ""];
  if (decision === undefined || intent === undefined) throw notFound("Tool Decision不存在");
  return toolDecisionResponse(decision, intent);
}

export async function claimToolExecutionDecision(
  deps: ApplicationDeps,
  input: ClaimToolExecutionDecisionRuntimeRequest,
): Promise<ClaimToolExecutionDecisionRuntimeResponse> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent = snapshot.entities.toolExecutionIntents[input.toolExecutionIntentId];
  if (intent === undefined) throw notFound("Tool Execution Intent不存在");
  const decisionId = intent.decidedByToolExecutionDecisionId;
  const decision =
    decisionId === undefined ? undefined : snapshot.entities.toolExecutionDecisions[decisionId];
  if (intent.status === "waiting_decision") {
    assertClaimBinding(intent, input);
  } else {
    if (decision === undefined) throw revisionConflict("Tool Decision引用缺失");
    if (decision.intentRevision !== input.intentRevision) {
      throw revisionConflict("Tool Execution Decision没有绑定Runtime看到的原始Intent revision");
    }
    assertClaimBinding(intent, input);
  }
  if (intent.status === "waiting_decision") {
    return {
      schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "waiting_decision",
      toolExecutionIntentId: intent.toolExecutionIntentId,
      revision: intent.revision,
    };
  }
  if (decision === undefined) throw revisionConflict("Tool Decision引用缺失");
  if (intent.status === "rejected") {
    return {
      schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "rejected",
      toolExecutionIntentId: intent.toolExecutionIntentId,
      toolExecutionDecisionId: decision.toolExecutionDecisionId,
      decisionIntentRevision: decision.intentRevision,
      capabilityDescriptorSha256: decision.capabilityDescriptorSha256,
      inputSha256: decision.inputSha256,
      scopeRef: decision.scopeRef,
      revision: intent.revision,
      ...(decision.explanation === undefined ? {} : { explanation: decision.explanation }),
    };
  }
  if (intent.status !== "approved") {
    const found = snapshot.entities.runs[input.productRunId];
    const run = found === undefined ? undefined : requireDirectAgentRun(found);
    const attempt = snapshot.entities.attempts[input.directAgentAttemptId];
    if (
      run === undefined ||
      !(
        (run.status === "running" && run.phase === "executing") ||
        (run.status === "waiting_human" && run.phase === "tool_review")
      ) ||
      attempt === undefined ||
      attempt.outcome !== "running"
    ) {
      throw revisionConflict("Run或Attempt已经终结，不能返回旧Tool许可状态");
    }
    return {
      schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "already_claimed",
      toolExecutionIntentId: intent.toolExecutionIntentId,
      revision: intent.revision,
    };
  }
  const requestSha256 = hashCanonical("command.claim-tool-execution-decision.v1", input);
  const claimed = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ClaimToolExecutionDecision",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const current = draft.entities.toolExecutionIntents[input.toolExecutionIntentId];
      if (current === undefined) throw notFound("Tool Execution Intent不存在");
      const found = draft.entities.runs[input.productRunId];
      const run = found === undefined ? undefined : requireDirectAgentRun(found);
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      const session = run === undefined ? undefined : draft.entities.sessions[run.sessionId];
      if (
        run === undefined ||
        !(
          (run.status === "running" && run.phase === "executing") ||
          (run.status === "waiting_human" && run.phase === "tool_review")
        ) ||
        attempt === undefined ||
        attempt.productRunId !== input.productRunId ||
        attempt.kind !== "direct_agent" ||
        attempt.outcome !== "running" ||
        attempt.inputManifestSha256 === undefined ||
        session === undefined ||
        current.runtimeOperationRefSha256 !==
          computeDirectRuntimeOperationRefSha256({
            productRunId: input.productRunId,
            directAgentAttemptId: input.directAgentAttemptId,
            inputManifestSha256: attempt.inputManifestSha256,
          })
      ) {
        throw revisionConflict("Run、Attempt或Runtime Operation已终结/变化，旧许可不可执行");
      }
      if (current.status !== "approved") throw revisionConflict("Tool执行许可已被消费");
      const currentDecision =
        current.decidedByToolExecutionDecisionId === undefined
          ? undefined
          : draft.entities.toolExecutionDecisions[current.decidedByToolExecutionDecisionId];
      if (
        currentDecision === undefined ||
        currentDecision.kind !== "approve" ||
        currentDecision.principalId !== session.ownerPrincipalId ||
        currentDecision.intentRevision !== input.intentRevision ||
        currentDecision.toolExecutionIntentId !== current.toolExecutionIntentId ||
        currentDecision.productRunId !== current.productRunId ||
        currentDecision.capabilityDescriptorSha256 !== current.capability.ref.descriptorSha256 ||
        currentDecision.inputSha256 !== current.inputSha256 ||
        JSON.stringify(currentDecision.scopeRef) !== JSON.stringify(current.scopeRef)
      ) {
        throw revisionConflict("Tool执行许可绑定已变化");
      }
      assertClaimBinding(current, input);
      assertToolExecutionIntentTransition(current.status, "dispatching");
      draft.entities.toolExecutionIntents[current.toolExecutionIntentId] = {
        ...current,
        status: "dispatching",
        revision: current.revision + 1,
        updatedAt: deps.now(),
      };
      return {
        resultRefs: {
          toolExecutionIntentId: current.toolExecutionIntentId,
          toolExecutionDecisionId: decision.toolExecutionDecisionId,
        },
      };
    },
  });
  return {
    schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
    status: claimed.replayed ? "already_claimed" : "authorized",
    toolExecutionIntentId: intent.toolExecutionIntentId,
    ...(claimed.replayed ? {} : { toolExecutionDecisionId: decision.toolExecutionDecisionId }),
    ...(claimed.replayed
      ? {}
      : {
          decisionIntentRevision: decision.intentRevision,
          capabilityDescriptorSha256: decision.capabilityDescriptorSha256,
          inputSha256: decision.inputSha256,
          scopeRef: decision.scopeRef,
        }),
    revision: intent.revision + 1,
  } as ClaimToolExecutionDecisionRuntimeResponse;
}

export async function commitToolExecutionResult(
  deps: ApplicationDeps,
  input: CommitToolExecutionResultRuntimeRequest,
) {
  const toolExecutionResultId = toolExecutionResultIdSchema.parse(
    derivedId("ter", "id.tool-execution-result.v1", {
      toolExecutionIntentId: input.toolExecutionIntentId,
    }),
  );
  const now = deps.now();
  const requestSha256 = hashCanonical("command.commit-tool-execution-result.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitToolExecutionResult",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const intent = draft.entities.toolExecutionIntents[input.toolExecutionIntentId];
      if (intent === undefined) throw notFound("Tool Execution Intent不存在");
      if (
        intent.productRunId !== input.productRunId ||
        intent.attemptId !== input.directAgentAttemptId ||
        intent.status !== "dispatching"
      ) {
        throw revisionConflict("Tool Execution Intent未处于本次执行的dispatching状态");
      }
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      const decision =
        intent.decidedByToolExecutionDecisionId === undefined
          ? undefined
          : draft.entities.toolExecutionDecisions[intent.decidedByToolExecutionDecisionId];
      if (
        attempt === undefined ||
        attempt.inputManifestSha256 === undefined ||
        intent.runtimeOperationRefSha256 !==
          computeDirectRuntimeOperationRefSha256({
            productRunId: input.productRunId,
            directAgentAttemptId: input.directAgentAttemptId,
            inputManifestSha256: attempt.inputManifestSha256,
          }) ||
        decision?.kind !== "approve"
      ) {
        throw revisionConflict("Tool Result不属于有效批准的Run/Attempt/Runtime Operation");
      }
      if (input.outcome === "completed" && input.resultSha256 === undefined) {
        throw revisionConflict("成功Tool结果缺少结果Hash");
      }
      if (input.outcome !== "outcome_unknown" && input.journalResultSha256 === undefined) {
        throw revisionConflict("Tool完成事实必须晚于且引用已落盘的Pi Journal Result");
      }
      assertToolExecutionIntentTransition(intent.status, input.outcome);
      const toolResult: ToolExecutionResult = {
        schemaVersion: "tool-execution-result.v1",
        toolExecutionResultId,
        toolExecutionIntentId: intent.toolExecutionIntentId,
        productRunId: input.productRunId,
        outcome: input.outcome,
        ...(input.resultSha256 === undefined ? {} : { resultSha256: input.resultSha256 }),
        evidenceRefs:
          input.journalResultSha256 === undefined
            ? []
            : [{ kind: "pi_journal_result", refSha256: input.journalResultSha256 }],
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.toolExecutionResults[toolExecutionResultId] = toolResult;
      draft.entities.toolExecutionIntents[intent.toolExecutionIntentId] = {
        ...intent,
        status: input.outcome,
        resultId: toolExecutionResultId,
        revision: intent.revision + 1,
        updatedAt: now,
      };
      if (input.outcome === "outcome_unknown") {
        settleRunWithoutSuccess(
          draft,
          input.productRunId,
          "outcome_unknown",
          input.errorCode ?? "tool_execution.outcome_unknown",
          "Tool动作结果未知，需要人工处置",
          now,
        );
      }
      return {
        resultRefs: { toolExecutionIntentId: intent.toolExecutionIntentId, toolExecutionResultId },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent =
    snapshot.entities.toolExecutionIntents[result.resultRefs["toolExecutionIntentId"] ?? ""];
  if (intent === undefined) throw notFound("Tool Execution Intent不存在");
  return {
    toolExecutionIntentId: intent.toolExecutionIntentId,
    status: intent.status,
    revision: intent.revision,
  };
}
