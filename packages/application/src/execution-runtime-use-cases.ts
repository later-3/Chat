import { computeExecutionInputManifestSha256, hashCanonical } from "@chat/domain";
import {
  CODING_EXECUTOR_MAX_TURNS_PER_STEP,
  CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
  CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  EXECUTION_CAPABILITIES,
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  type CommandId,
  type DecisionId,
  type ExecutionContextItemDto,
  type ExecutionContract,
  type ExecutionContractId,
  type ProductSnapshot,
  type ProductRunId,
  type RunAttemptId,
  type BeginRunAttemptResponse,
  type AuthorizeExecutorOperationRequest,
  type AuthorizeExecutorOperationResponse,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { synchronizePlanningWorkflowProjection } from "./planning-workflow-projection.js";
import { requirePlanningRun } from "./product-run-kind.js";
import { workflowNodePromptFor, workflowNodePromptRefFor } from "./prompt-assembly-use-cases.js";

/**
 * Workflow私有Application Command：执行合同、候选、验证与Product Commit。
 *
 * 不变量（任务书§9.2）：
 * - Execution Contract只从Approved Plan与已提交Decision生成，创建后不可修改。
 * - Provider或pi成功只产生候选，不能直接产生正式Message或成功终态。
 * - Product Commit同时提交Assistant Message、Run终态和Receipt；失败三者都不提交。
 * - Product Commit重试只能重用已验证候选，不再次调用已成功的付费Executor。
 */

export const EXECUTOR_LIMITS = {
  maxTurnsPerStep: CODING_EXECUTOR_MAX_TURNS_PER_STEP,
  timeoutMsPerStep: CODING_EXECUTOR_TIMEOUT_MS_PER_STEP,
  tokenBudgetPerStep: CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP,
} as const;

const ALLOWED_EXECUTION_CAPABILITIES = new Set<string>(EXECUTION_CAPABILITIES);

export interface BeginRunAttemptCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly kind: "execution";
  readonly executionContractId: ExecutionContractId;
  readonly stepId: string;
  readonly dependencyRefs: readonly {
    readonly stepId: string;
    readonly executionAttemptId: RunAttemptId;
    readonly sha256: string;
  }[];
  readonly promptTemplateVersion: string;
  readonly modelConfigVersion: string;
}

interface ResolvedExecutionStep {
  readonly inputRefs: ExecutionContract["steps"][number]["inputRefs"];
  readonly contextItems: readonly ExecutionContextItemDto[];
}

/**
 * 只沿Approved Plan的Planning Attempt所绑定Memory/Rules冻结事实解析当前Step。
 * 任何跨选择、缺失或版本/Hash偏差都在进入Executor前失败关闭。
 */
function resolveExecutionStepContext(
  snapshot: ProductSnapshot,
  contract: ExecutionContract,
  stepId: string,
): ResolvedExecutionStep {
  const step = contract.steps.find((candidate) => candidate.stepId === stepId);
  if (step === undefined) throw revisionConflict("Execution Step不在已批准合同中");
  const plan = Object.values(snapshot.entities.plans).find(
    (candidate) =>
      candidate.productRunId === contract.productRunId &&
      candidate.planId === contract.approvedPlanId &&
      candidate.planRevision === contract.approvedPlanRevision,
  );
  if (
    plan === undefined ||
    plan.status !== "approved" ||
    plan.sha256 !== contract.approvedPlanSha256
  ) {
    throw revisionConflict("Execution Contract缺少精确Approved Plan血缘");
  }
  const planStep = plan.content.steps.find((candidate) => candidate.stepId === stepId);
  if (
    planStep === undefined ||
    JSON.stringify(planStep.inputRefs) !== JSON.stringify(step.inputRefs)
  ) {
    throw revisionConflict("Execution Step与Approved Plan的上下文引用不一致");
  }
  if (step.inputRefs.length === 0) return { inputRefs: step.inputRefs, contextItems: [] };

  const planningAttempt = snapshot.entities.attempts[plan.planningAttemptId];
  if (
    planningAttempt === undefined ||
    planningAttempt.kind !== "planning" ||
    planningAttempt.productRunId !== contract.productRunId ||
    planningAttempt.planRevision !== plan.planRevision
  ) {
    throw revisionConflict("Approved Plan缺少冻结Planning Attempt血缘");
  }
  const contextPackage =
    planningAttempt.contextPackageId === undefined
      ? undefined
      : snapshot.entities.contextPackages[planningAttempt.contextPackageId];
  if (
    planningAttempt.contextPackageId !== undefined &&
    (contextPackage === undefined ||
      contextPackage.productRunId !== contract.productRunId ||
      contextPackage.sha256 !== planningAttempt.contextPackageSha256)
  ) {
    throw revisionConflict("Approved Plan绑定的ContextPackage不存在或Hash不一致");
  }
  const memorySelection =
    planningAttempt.planningMemorySelectionId === undefined
      ? undefined
      : snapshot.entities.planningMemorySelections[planningAttempt.planningMemorySelectionId];
  if (
    planningAttempt.planningMemorySelectionId !== undefined &&
    (memorySelection === undefined ||
      memorySelection.productRunId !== contract.productRunId ||
      memorySelection.sha256 !== planningAttempt.planningMemorySelectionSha256)
  ) {
    throw revisionConflict("Approved Plan绑定的Memory Selection不存在或Hash不一致");
  }
  const workflowMemoryContext =
    planningAttempt.workflowMemoryContextId === undefined
      ? undefined
      : snapshot.entities.workflowMemoryContexts[planningAttempt.workflowMemoryContextId];
  if (
    planningAttempt.workflowMemoryContextId !== undefined &&
    (workflowMemoryContext === undefined ||
      workflowMemoryContext.productRunId !== contract.productRunId ||
      workflowMemoryContext.sha256 !== planningAttempt.workflowMemoryContextSha256)
  ) {
    throw revisionConflict("Approved Plan绑定的Workflow Memory Context不存在或Hash不一致");
  }
  const ruleSelection =
    planningAttempt.ruleSelectionId === undefined
      ? undefined
      : snapshot.entities.ruleSelections[planningAttempt.ruleSelectionId];
  if (
    planningAttempt.ruleSelectionId !== undefined &&
    (ruleSelection === undefined ||
      ruleSelection.productRunId !== contract.productRunId ||
      ruleSelection.sha256 !== planningAttempt.ruleSelectionSha256 ||
      ruleSelection.status !== "ready")
  ) {
    throw revisionConflict("Approved Plan绑定的Rule Selection不存在、未就绪或Hash不一致");
  }

  const seen = new Set<string>();
  const contextItems = step.inputRefs.map((ref): ExecutionContextItemDto => {
    const key = `${ref.refId}:${String(ref.revision)}:${ref.sha256}`;
    if (seen.has(key)) throw revisionConflict("Execution Step不允许重复上下文引用");
    seen.add(key);
    const packageItem = contextPackage?.items.find(
      (candidate) =>
        candidate.memoryResultSnapshotId === ref.refId &&
        candidate.revision === ref.revision &&
        candidate.sha256 === ref.sha256,
    );
    if (packageItem !== undefined && contextPackage !== undefined) {
      const memory = snapshot.entities.memoryResultSnapshots[packageItem.memoryResultSnapshotId];
      if (
        memory === undefined ||
        memory.memoryQueryId !== contextPackage.memoryQueryId ||
        memory.revision !== ref.revision ||
        memory.sha256 !== ref.sha256
      ) {
        throw revisionConflict("Execution Step的Memory Snapshot缺失或版本证据不一致");
      }
      return {
        refId: memory.memoryResultSnapshotId,
        revision: memory.revision,
        sha256: memory.sha256,
        title: memory.title,
        kind: memory.kind,
        layer: memory.memoryLayer,
        tags: memory.tags,
        content: memory.content,
      };
    }
    const selectedMemory = memorySelection?.selected.find(
      (candidate) =>
        candidate.memoryResultSnapshotId === ref.refId &&
        candidate.revision === ref.revision &&
        candidate.sha256 === ref.sha256,
    );
    if (selectedMemory !== undefined) {
      const memory = snapshot.entities.memoryResultSnapshots[selectedMemory.memoryResultSnapshotId];
      if (
        memory === undefined ||
        memory.revision !== ref.revision ||
        memory.sha256 !== ref.sha256
      ) {
        throw revisionConflict("Execution Step的显式Memory Snapshot缺失或版本证据不一致");
      }
      return {
        refId: memory.memoryResultSnapshotId,
        revision: memory.revision,
        sha256: memory.sha256,
        title: memory.title,
        kind: memory.kind,
        layer: memory.memoryLayer,
        tags: memory.tags,
        content: memory.content,
      };
    }
    const selectedWorkflowMemory = workflowMemoryContext?.items.find(
      (candidate) =>
        candidate.workflowMemorySnapshotId === ref.refId &&
        candidate.revision === ref.revision &&
        candidate.sha256 === ref.sha256,
    );
    if (selectedWorkflowMemory !== undefined) {
      const memory =
        snapshot.entities.workflowMemorySnapshots[selectedWorkflowMemory.workflowMemorySnapshotId];
      if (
        memory === undefined ||
        memory.revision !== ref.revision ||
        memory.sha256 !== ref.sha256
      ) {
        throw revisionConflict("Execution Step的Workflow Memory Snapshot证据不一致");
      }
      return {
        contextKind: "memory",
        refId: memory.workflowMemorySnapshotId,
        revision: memory.revision,
        sha256: memory.sha256,
        providerId: memory.providerId,
        title: memory.title,
        category: memory.category,
        labels: memory.labels,
        content: memory.content,
      };
    }
    const selectedRule = ruleSelection?.selected.find(
      (candidate) =>
        candidate.ruleRevisionId === ref.refId && candidate.ruleRevisionSha256 === ref.sha256,
    );
    if (selectedRule !== undefined) {
      const revision = snapshot.entities.ruleRevisions[selectedRule.ruleRevisionId];
      if (
        revision === undefined ||
        revision.ruleId !== selectedRule.ruleId ||
        revision.revision !== ref.revision ||
        revision.sha256 !== ref.sha256
      ) {
        throw revisionConflict("Execution Step的Rule Revision缺失或版本证据不一致");
      }
      return {
        contextKind: "rule",
        refId: revision.ruleRevisionId,
        revision: revision.revision,
        sha256: revision.sha256,
        ruleId: selectedRule.ruleId,
        content: revision.body,
      };
    }
    throw revisionConflict("Execution Step引用了未被本轮冻结Context采用的条目");
  });
  return { inputRefs: step.inputRefs, contextItems };
}

export async function beginRunAttempt(
  deps: ApplicationDeps,
  input: BeginRunAttemptCommand,
): Promise<{
  attemptId: RunAttemptId;
  inputManifestSha256: string;
  contextItems: readonly ExecutionContextItemDto[];
  promptAssemblyRef?: NonNullable<BeginRunAttemptResponse["promptAssemblyRef"]>;
}> {
  const now = deps.now();
  const attemptId = deps.ids.attempt();
  const requestSha256 = hashCanonical("command.begin-run-attempt.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginRunAttempt",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const contract = draft.entities.executionContracts[input.executionContractId];
      if (contract === undefined || contract.productRunId !== input.productRunId) {
        throw notFound("Execution Contract不存在");
      }
      const step = contract.steps.find((candidate) => candidate.stepId === input.stepId);
      if (step === undefined) throw revisionConflict("Execution Step不在合同中");
      if (
        input.dependencyRefs.length !== step.dependsOn.length ||
        input.dependencyRefs.some((ref, index) => {
          const priorAttempt = draft.entities.attempts[ref.executionAttemptId];
          return (
            ref.stepId !== step.dependsOn[index] ||
            priorAttempt === undefined ||
            priorAttempt.productRunId !== input.productRunId ||
            priorAttempt.kind !== "execution" ||
            priorAttempt.stepId !== ref.stepId ||
            priorAttempt.outcome !== "success"
          );
        })
      ) {
        throw revisionConflict("Execution Step的依赖血缘不完整");
      }
      const resolved = resolveExecutionStepContext(draft, contract, input.stepId);
      const promptAssemblyRef = workflowNodePromptRefFor(draft, input.productRunId, "execute.plan");
      const inputManifestSha256 = computeExecutionInputManifestSha256({
        executionContractId: contract.executionContractId,
        approvedPlanSha256: contract.approvedPlanSha256,
        stepId: input.stepId,
        inputRefs: resolved.inputRefs,
        dependencyRefs: input.dependencyRefs,
        promptTemplateVersion: input.promptTemplateVersion,
        modelConfigVersion: input.modelConfigVersion,
        ...(promptAssemblyRef === undefined ? {} : { promptAssemblyRef }),
      });
      draft.entities.attempts[attemptId] = {
        schemaVersion: "run-attempt.v2",
        attemptId,
        productRunId: input.productRunId,
        kind: "execution",
        stepId: input.stepId,
        executionContractId: input.executionContractId,
        dependencyRefs: [...input.dependencyRefs],
        inputManifestSha256,
        promptTemplateVersion: input.promptTemplateVersion,
        modelConfigVersion: input.modelConfigVersion,
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { attemptId } };
    },
  });
  const committedAttemptId = result.resultRefs["attemptId"] as RunAttemptId;
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const attempt = snapshot.entities.attempts[committedAttemptId];
  const contract = snapshot.entities.executionContracts[input.executionContractId];
  if (
    attempt === undefined ||
    contract === undefined ||
    attempt.productRunId !== input.productRunId ||
    attempt.kind !== "execution" ||
    attempt.stepId !== input.stepId ||
    attempt.inputManifestSha256 === undefined ||
    attempt.promptTemplateVersion !== input.promptTemplateVersion ||
    attempt.modelConfigVersion !== input.modelConfigVersion
  ) {
    throw notFound("Execution Attempt或输入证据不存在");
  }
  const resolved = resolveExecutionStepContext(snapshot, contract, input.stepId);
  const promptAssemblyRef = workflowNodePromptRefFor(snapshot, input.productRunId, "execute.plan");
  const expectedManifestSha256 = computeExecutionInputManifestSha256({
    executionContractId: contract.executionContractId,
    approvedPlanSha256: contract.approvedPlanSha256,
    stepId: input.stepId,
    inputRefs: resolved.inputRefs,
    dependencyRefs: input.dependencyRefs,
    promptTemplateVersion: input.promptTemplateVersion,
    modelConfigVersion: input.modelConfigVersion,
    ...(promptAssemblyRef === undefined ? {} : { promptAssemblyRef }),
  });
  if (attempt.inputManifestSha256 !== expectedManifestSha256) {
    throw revisionConflict("Execution Attempt的输入Manifest与冻结上下文不一致");
  }
  return {
    attemptId: committedAttemptId,
    inputManifestSha256: expectedManifestSha256,
    contextItems: resolved.contextItems,
    ...(promptAssemblyRef === undefined ? {} : { promptAssemblyRef }),
  };
}

export interface CompleteRunAttemptCommand {
  readonly commandId: CommandId;
  readonly attemptId: RunAttemptId;
  readonly outcome: "success" | "failure";
  readonly errorCode?: string;
}

/**
 * 只读授权门：Executor Service不能把Runtime Key或Workflow请求正文当成产品授权。
 * 它按已提交Execution Attempt回查Contract、Step、Manifest和权威Context正文；任何
 * 偏差都在AgentSession和Workspace工具创建前失败关闭。
 */
export async function authorizeExecutorOperation(
  deps: ApplicationDeps,
  input: Omit<AuthorizeExecutorOperationRequest, "schemaVersion">,
): Promise<AuthorizeExecutorOperationResponse> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const attempt = snapshot.entities.attempts[input.executionAttemptId];
  if (attempt === undefined || attempt.kind !== "execution") {
    throw notFound("Execution Attempt不存在");
  }
  if (
    attempt.outcome !== "running" ||
    attempt.executionContractId !== input.executionContractId ||
    attempt.stepId !== input.stepId ||
    attempt.inputManifestSha256 !== input.inputManifestSha256
  ) {
    throw revisionConflict("Execution Attempt授权证据不一致或已终止");
  }
  const contract = snapshot.entities.executionContracts[input.executionContractId];
  if (
    contract === undefined ||
    contract.productRunId !== attempt.productRunId ||
    contract.sha256 !== input.executionContractSha256
  ) {
    throw revisionConflict("Execution Contract授权证据不一致");
  }
  const resolved = resolveExecutionStepContext(snapshot, contract, input.stepId);
  const nodePrompt = workflowNodePromptFor(snapshot, attempt.productRunId, "execute.plan");
  return {
    schemaVersion: "chat-internal-runtime.v1",
    productRunId: attempt.productRunId,
    executionAttemptId: attempt.attemptId,
    contract,
    contextItems: [...resolved.contextItems],
    dependencyRefs: [...(attempt.dependencyRefs ?? [])],
    ...(nodePrompt === undefined ? {} : { nodePrompt }),
  };
}

export async function completeRunAttempt(
  deps: ApplicationDeps,
  input: CompleteRunAttemptCommand,
): Promise<{ revision: number }> {
  const now = deps.now();
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const existingAttempt = snapshot.entities.attempts[input.attemptId];
  if (existingAttempt === undefined) throw notFound("Run Attempt不存在");
  const requestSha256 = hashCanonical("command.complete-run-attempt.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompleteRunAttempt",
    requestSha256,
    traceContext: { productRunId: existingAttempt.productRunId },
    mutate: (draft) => {
      const attempt = draft.entities.attempts[input.attemptId];
      if (attempt === undefined) throw notFound("Run Attempt不存在");
      if (attempt.outcome !== "running") return { resultRefs: {} };
      draft.entities.attempts[input.attemptId] = {
        ...attempt,
        outcome: input.outcome,
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        revision: attempt.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: {} };
    },
  });
  return { revision: result.storeRevision };
}

export interface CompileExecutionContractCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly approvalDecisionId: DecisionId;
}

export async function compileExecutionContract(
  deps: ApplicationDeps,
  input: CompileExecutionContractCommand,
): Promise<{ contract: ExecutionContract }> {
  const now = deps.now();
  const executionContractId = deps.ids.executionContract();
  const requestSha256 = hashCanonical("command.compile-execution-contract.v1", {
    productRunId: input.productRunId,
    approvalDecisionId: input.approvalDecisionId,
  });

  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompileExecutionContract",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const planningRun = requirePlanningRun(run);
      const decision = Object.values(draft.entities.decisions).find(
        (candidate) => candidate.decisionId === input.approvalDecisionId,
      );
      if (decision === undefined || decision.productRunId !== input.productRunId) {
        throw notFound("Decision不存在");
      }
      if (decision.kind !== "approve")
        throw revisionConflict("只有approve Decision能生成Execution Contract");

      const existing = Object.values(draft.entities.executionContracts).find(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      if (existing !== undefined) {
        if (existing.approvalDecisionId !== decision.decisionId) {
          throw revisionConflict("同一Product Run不允许第二个Execution Contract");
        }
        return { resultRefs: { executionContractId: existing.executionContractId } };
      }

      const plan = Object.values(draft.entities.plans).find(
        (candidate) =>
          candidate.planId === decision.planId &&
          candidate.planRevision === decision.planRevision &&
          candidate.productRunId === input.productRunId,
      );
      if (plan === undefined) throw notFound("Approved Plan不存在");
      if (plan.status !== "approved") throw revisionConflict("Plan不在approved状态");
      if (plan.sha256 !== decision.planSha256) throw revisionConflict("Plan Hash与Decision不一致");

      if (planningRun.workflowRunSpecId !== undefined) {
        const runSpec = draft.entities.workflowRunSpecs[planningRun.workflowRunSpecId];
        const executeNode = runSpec?.nodeResolutions.find(
          (node) => node.nodeType === "execute.plan",
        );
        const frozenMaxActions = executeNode?.config["maxActions"];
        if (
          runSpec === undefined ||
          executeNode === undefined ||
          typeof frozenMaxActions !== "number" ||
          !Number.isInteger(frozenMaxActions) ||
          frozenMaxActions < 1 ||
          plan.content.steps.length > frozenMaxActions
        ) {
          throw revisionConflict("Approved Plan超过RunSpec冻结的execute.plan maxActions");
        }
      }

      const steps = plan.content.steps.map((step) => ({
        stepId: step.stepId,
        title: step.title,
        purpose: step.purpose,
        dependsOn: step.dependsOn,
        inputRefs: step.inputRefs,
        expectedOutput: step.expectedOutput,
        successCriteria: step.successCriteria,
        capabilityRefs: step.requestedCapabilities,
      }));
      const capabilityRefs = [
        ...new Set(plan.content.steps.flatMap((step) => step.requestedCapabilities)),
      ];
      if (capabilityRefs.some((capability) => !ALLOWED_EXECUTION_CAPABILITIES.has(capability))) {
        throw revisionConflict("Approved Plan包含未允许的Capability");
      }
      const requiresWorkspace = capabilityRefs.some(
        (capability) => capability !== EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
      );
      let workspaceRef: ExecutionContract["workspaceRef"];
      if (requiresWorkspace) {
        const promptRef = workflowNodePromptFor(draft, input.productRunId, "agent.plan");
        const promptAssembly =
          promptRef === undefined
            ? undefined
            : draft.entities.promptAssemblies[promptRef.promptAssemblyId];
        if (promptAssembly?.workspaceRootId === undefined) {
          throw revisionConflict("Coding Capability必须绑定受管Workspace");
        }
        workspaceRef = { rootId: promptAssembly.workspaceRootId };
      }
      const contract: ExecutionContract = {
        schemaVersion: "execution-contract.v1",
        executionContractId,
        productRunId: input.productRunId,
        approvedPlanId: plan.planId,
        approvedPlanRevision: plan.planRevision,
        approvedPlanSha256: plan.sha256,
        approvalDecisionId: decision.decisionId,
        steps,
        completionCriteria: plan.content.completionCriteria,
        ...(workspaceRef !== undefined ? { workspaceRef } : {}),
        capabilityRefs,
        limits: { ...EXECUTOR_LIMITS },
        sha256: hashCanonical("execution-contract.v1", {
          productRunId: input.productRunId,
          approvedPlanId: plan.planId,
          approvedPlanRevision: plan.planRevision,
          approvedPlanSha256: plan.sha256,
          approvalDecisionId: decision.decisionId,
          steps,
          completionCriteria: plan.content.completionCriteria,
          ...(workspaceRef !== undefined ? { workspaceRef } : {}),
          capabilityRefs,
          limits: EXECUTOR_LIMITS,
        }),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.executionContracts[executionContractId] = contract;
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { executionContractId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const contract = Object.values(snapshot.entities.executionContracts).find(
    (candidate) => candidate.productRunId === input.productRunId,
  );
  if (contract === undefined) throw notFound("Execution Contract不存在");
  return { contract };
}
