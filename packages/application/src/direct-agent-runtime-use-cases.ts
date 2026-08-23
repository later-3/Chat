import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
  DIRECT_AGENT_TOKEN_BUDGET,
  MODEL_CONFIG_VERSION,
  type CommandId,
  type DirectAgentCandidate,
  type DirectAgentCandidateOutput,
  type DirectAgentCandidateId,
  type Message,
  type PromptAssembly,
  type ProductRunId,
  type RunAttemptId,
  type WorkflowRunSpecId,
} from "@chat/contracts";
import {
  computeDirectAgentCandidateSha256,
  computeDirectAgentInputManifestSha256,
  computeMessageSha256,
  evaluateDirectAgentMemoryPromptBudget,
  hashCanonical,
  transitionDirectAgentRunLifecycle,
} from "@chat/domain";
import type { ApplicationDeps, DirectAgentIdFactory } from "./deps.js";
import { ApplicationError, notFound, revisionConflict } from "./errors.js";
import { requireDirectAgentRun } from "./product-run-kind.js";
import { toMessageDto, toRunDto } from "./dto.js";

function requireDirectAgentIds(deps: ApplicationDeps): DirectAgentIdFactory {
  if (deps.directAgentIds === undefined) {
    throw new Error("DirectAgentIdFactory未配置，不能执行Direct Agent用例");
  }
  return deps.directAgentIds;
}

function directNodeConfig(
  runSpec: Awaited<
    ReturnType<ApplicationDeps["store"]["read"]>
  >["snapshot"]["entities"]["workflowRunSpecs"][string],
): {
  readonly capabilityMode: "pi_cli_default" | "custom" | "read_only" | "project_bootstrap";
  readonly promptReviewMode: "manual" | "off";
} {
  const node = runSpec.nodeResolutions.find(
    (candidate) => candidate.nodeType === "agent.direct" && candidate.activation === "enabled",
  );
  if (
    node === undefined ||
    (node.config["capabilityMode"] !== "pi_cli_default" &&
      node.config["capabilityMode"] !== "custom" &&
      node.config["capabilityMode"] !== "read_only" &&
      node.config["capabilityMode"] !== "project_bootstrap") ||
    (node.config["promptReviewMode"] !== "manual" && node.config["promptReviewMode"] !== "off")
  ) {
    throw new ApplicationError({
      code: "revision_conflict",
      httpStatus: 409,
      message: "Direct Agent RunSpec缺少受支持的Agent能力或Prompt Gate配置",
      recoveryAction: "contact_support",
    });
  }
  return {
    capabilityMode: node.config["capabilityMode"],
    promptReviewMode: node.config["promptReviewMode"],
  };
}

function memoryContextForRun(
  entities: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"]["entities"],
  productRunId: ProductRunId,
  workflowRunSpecId: WorkflowRunSpecId,
) {
  const matches = Object.values(entities.workflowMemoryContexts).filter(
    (context) =>
      context.productRunId === productRunId && context.workflowRunSpecId === workflowRunSpecId,
  );
  if (matches.length > 1) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Direct Agent存在多个Workflow Memory Context",
      recoveryAction: "contact_support",
    });
  }
  return matches[0];
}

function isMemoryDirectRunner(runnerFamily: string): boolean {
  return runnerFamily === "memory-direct.v1";
}

function directPromptAssembly(
  entities: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"]["entities"],
  productRunId: ProductRunId,
): PromptAssembly {
  const matches = Object.values(entities.promptAssemblies).filter(
    (assembly) => assembly.productRunId === productRunId,
  );
  if (matches.length !== 1) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Direct Agent缺少唯一Prompt Assembly",
      recoveryAction: "contact_support",
    });
  }
  return matches[0]!;
}

export async function beginDirectAgentAttempt(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly productRunId: ProductRunId;
    readonly workflowAttemptId: RunAttemptId;
  },
): Promise<{
  readonly directAgentAttemptId: RunAttemptId;
  readonly inputManifestSha256: string;
  readonly runRevision: number;
}> {
  const now = deps.now();
  const directAgentAttemptId = deps.ids.attempt();
  const requestSha256 = hashCanonical("command.begin-direct-agent-attempt.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginDirectAgentAttempt",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      if (run.status !== "pending" || run.phase !== "queued") {
        throw revisionConflict("Direct Agent Run已经开始或终结");
      }
      const workflowAttempt = draft.entities.attempts[input.workflowAttemptId];
      if (
        workflowAttempt === undefined ||
        workflowAttempt.productRunId !== input.productRunId ||
        workflowAttempt.kind !== "workflow" ||
        workflowAttempt.outcome !== "running"
      ) {
        throw revisionConflict("Workflow Attempt不存在或已终结");
      }
      const sourceMessage = draft.entities.messages[run.sourceMessageId];
      const runSpec = draft.entities.workflowRunSpecs[run.workflowRunSpecId];
      const promptAssembly = directPromptAssembly(draft.entities, input.productRunId);
      if (sourceMessage === undefined || runSpec === undefined) {
        throw new ApplicationError({
          code: "store_corrupted",
          httpStatus: 500,
          message: "Direct Agent冻结输入引用缺失",
          recoveryAction: "contact_support",
        });
      }
      if (
        runSpec.productRunId !== input.productRunId ||
        (runSpec.runner.runnerFamily !== "direct-agent.v1" &&
          runSpec.runner.runnerFamily !== "memory-direct.v1") ||
        runSpec.businessInput?.kind !== "direct_agent_message"
      ) {
        throw revisionConflict("Direct Agent RunSpec身份或业务输入不匹配");
      }
      const config = directNodeConfig(runSpec);
      const memoryContext = memoryContextForRun(
        draft.entities,
        input.productRunId,
        runSpec.workflowRunSpecId,
      );
      if (isMemoryDirectRunner(runSpec.runner.runnerFamily) !== (memoryContext !== undefined)) {
        throw revisionConflict("Direct Agent Runner与Workflow Memory Context绑定不一致");
      }
      const sourceMessageSha256 = computeMessageSha256(sourceMessage);
      const inputManifestSha256 = computeDirectAgentInputManifestSha256({
        productRunId: input.productRunId,
        inputRunRevision: run.revision,
        sourceMessageId: sourceMessage.messageId,
        sourceMessageSha256,
        promptAssemblySha256: promptAssembly.sha256,
        ...(memoryContext === undefined
          ? {}
          : {
              workflowMemoryContext: {
                workflowMemoryContextId: memoryContext.workflowMemoryContextId,
                revision: memoryContext.revision,
                sha256: memoryContext.sha256,
              },
            }),
        workflowRunSpecId: runSpec.workflowRunSpecId,
        workflowRunSpecSha256: runSpec.sha256,
        capabilityMode: config.capabilityMode,
        promptTemplateVersion: DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
        limits: {
          maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
          activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
          tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
        },
      });
      draft.entities.attempts[directAgentAttemptId] = {
        schemaVersion: "run-attempt.v1",
        attemptId: directAgentAttemptId,
        productRunId: input.productRunId,
        kind: "direct_agent",
        inputRunRevision: run.revision,
        sourceMessageSha256,
        inputManifestSha256,
        ...(memoryContext === undefined
          ? {}
          : {
              workflowMemoryContextId: memoryContext.workflowMemoryContextId,
              workflowMemoryContextSha256: memoryContext.sha256,
            }),
        promptTemplateVersion: DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const lifecycle = transitionDirectAgentRunLifecycle(
        { status: run.status, phase: run.phase },
        { status: "running", phase: "executing" },
      );
      draft.entities.runs[input.productRunId] = {
        ...run,
        status: lifecycle.status,
        phase: lifecycle.phase,
        revision: run.revision + 1,
        updatedAt: now,
      };
      return {
        resultRefs: {
          attemptId: directAgentAttemptId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const attempt = snapshot.entities.attempts[result.resultRefs["attemptId"] ?? ""];
  const run = snapshot.entities.runs[input.productRunId];
  if (attempt === undefined || run === undefined || attempt.inputManifestSha256 === undefined) {
    throw notFound("Direct Agent Attempt不存在");
  }
  return {
    directAgentAttemptId: attempt.attemptId,
    inputManifestSha256: attempt.inputManifestSha256,
    runRevision: run.revision,
  };
}

/** Executor Service在创建Session前回查冻结RunSpec、Message和Attempt，不信任Workflow正文。 */
export async function authorizeDirectAgentOperation(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly directAgentAttemptId: RunAttemptId;
    readonly workflowRunSpecId: WorkflowRunSpecId;
    readonly workflowRunSpecSha256: string;
    readonly inputManifestSha256: string;
  },
): Promise<{
  readonly productRunId: ProductRunId;
  readonly directAgentAttemptId: RunAttemptId;
  readonly runRevision: number;
  readonly sourceMessage: {
    readonly messageId: Message["messageId"];
    readonly text: string;
    readonly sha256: string;
  };
  readonly promptAssembly: {
    readonly schemaVersion: "prompt-assembly.v1" | "prompt-assembly.v2";
    readonly promptAssemblyId: PromptAssembly["promptAssemblyId"];
    readonly sha256: string;
    readonly systemPromptAppend: string;
    readonly piSystemPrompt?: Extract<
      PromptAssembly,
      { schemaVersion: "prompt-assembly.v2" }
    >["piSystemPrompt"];
    readonly userPrompt?: string | undefined;
    readonly messages?: Extract<
      PromptAssembly,
      { schemaVersion: "prompt-assembly.v2" }
    >["messages"];
    readonly tools?: Extract<PromptAssembly, { schemaVersion: "prompt-assembly.v2" }>["tools"];
    readonly requestOptions?: Extract<
      PromptAssembly,
      { schemaVersion: "prompt-assembly.v2" }
    >["requestOptions"];
    readonly budget?: Extract<PromptAssembly, { schemaVersion: "prompt-assembly.v2" }>["budget"];
    readonly workspaceRootId?: string | undefined;
  };
  readonly capabilityMode: "pi_cli_default" | "custom" | "read_only" | "project_bootstrap";
  readonly projectBootstrapContext?: {
    readonly providerKind: "plane_ce";
    readonly providerVersion: string;
    readonly planeWorkspaceSlugs: readonly string[];
    readonly creationRoots: readonly { readonly rootId: string; readonly displayName: string }[];
  };
  readonly promptReviewMode: "manual" | "off";
  readonly memoryContext?: {
    readonly workflowMemoryContextId: string;
    readonly revision: 1;
    readonly sha256: string;
    readonly items: readonly {
      readonly workflowMemorySnapshotId: string;
      readonly providerId: string;
      readonly title: string;
      readonly category: "episode" | "fact" | "preference" | "procedure" | "skill" | "other";
      readonly content: string;
      readonly labels: readonly string[];
      readonly revision: 1;
      readonly sha256: string;
    }[];
  };
  readonly limits: {
    readonly maxProviderRequests: number;
    readonly activeTimeoutMs: number;
    readonly tokenBudget: number;
  };
}> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const found = snapshot.entities.runs[input.productRunId];
  if (found === undefined) throw notFound("Product Run不存在");
  const run = requireDirectAgentRun(found);
  if (!(
    (run.status === "running" && run.phase === "executing") ||
    (run.status === "waiting_human" && run.phase === "prompt_review")
  )) {
    throw revisionConflict("Direct Agent不在可授权执行状态");
  }
  const attempt = snapshot.entities.attempts[input.directAgentAttemptId];
  const runSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  const message = snapshot.entities.messages[run.sourceMessageId];
  const promptAssembly = directPromptAssembly(snapshot.entities, input.productRunId);
  if (promptAssembly.schemaVersion === "prompt-assembly.v3") {
    throw revisionConflict("Direct Agent不能使用Workflow Prompt计划");
  }
  if (
    attempt === undefined ||
    attempt.productRunId !== input.productRunId ||
    attempt.kind !== "direct_agent" ||
    attempt.outcome !== "running" ||
    attempt.inputRunRevision === undefined ||
    attempt.sourceMessageSha256 === undefined ||
    runSpec === undefined ||
    run.workflowRunSpecId !== runSpec.workflowRunSpecId ||
    run.runnerFamily !== runSpec.runner.runnerFamily ||
    run.runnerBundleVersion !== runSpec.runner.runnerBundleVersion ||
    message === undefined
  ) {
    throw revisionConflict("Direct Agent授权引用不完整");
  }
  if (
    runSpec.sha256 !== input.workflowRunSpecSha256 ||
    attempt.inputManifestSha256 !== input.inputManifestSha256
  ) {
    throw revisionConflict("Direct Agent授权Hash不匹配");
  }
  const config = directNodeConfig(runSpec);
  const memoryContext = memoryContextForRun(
    snapshot.entities,
    input.productRunId,
    runSpec.workflowRunSpecId,
  );
  const attemptHasMemoryContext =
    attempt.workflowMemoryContextId !== undefined ||
    attempt.workflowMemoryContextSha256 !== undefined;
  if (
    isMemoryDirectRunner(runSpec.runner.runnerFamily) !== attemptHasMemoryContext ||
    (memoryContext === undefined) !== !attemptHasMemoryContext ||
    (memoryContext !== undefined &&
      (attempt.workflowMemoryContextId !== memoryContext.workflowMemoryContextId ||
        attempt.workflowMemoryContextSha256 !== memoryContext.sha256))
  ) {
    throw revisionConflict("Direct Agent Memory Context引用不完整或已漂移");
  }
  const projectBootstrapContext =
    config.capabilityMode === "project_bootstrap"
      ? (() => {
          if (
            deps.projectManagementBootstrap === undefined ||
            deps.projectWorkspaceProvisioner === undefined
          ) {
            throw new ApplicationError({
              code: "revision_conflict",
              httpStatus: 409,
              message: "部署未配置Project Bootstrap能力",
              recoveryAction: "contact_support",
            });
          }
          const provider = deps.projectManagementBootstrap.describe();
          return {
            providerKind: provider.providerKind,
            providerVersion: provider.providerVersion,
            planeWorkspaceSlugs: [...provider.allowedWorkspaceSlugs],
            creationRoots: deps.projectWorkspaceProvisioner.listRoots().map((root) => ({
              rootId: root.rootId,
              displayName: root.displayName,
            })),
          };
        })()
      : undefined;
  const recomputedManifest = computeDirectAgentInputManifestSha256({
    productRunId: input.productRunId,
    inputRunRevision: attempt.inputRunRevision,
    sourceMessageId: message.messageId,
    sourceMessageSha256: computeMessageSha256(message),
    promptAssemblySha256: promptAssembly.sha256,
    ...(memoryContext === undefined
      ? {}
      : {
          workflowMemoryContext: {
            workflowMemoryContextId: memoryContext.workflowMemoryContextId,
            revision: memoryContext.revision,
            sha256: memoryContext.sha256,
          },
        }),
    workflowRunSpecId: runSpec.workflowRunSpecId,
    workflowRunSpecSha256: runSpec.sha256,
    capabilityMode: config.capabilityMode,
    promptTemplateVersion: DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
    limits: {
      maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
      activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
      tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
    },
  });
  if (recomputedManifest !== input.inputManifestSha256) {
    throw revisionConflict("Direct Agent Input Manifest已漂移");
  }
  const memoryContextDto =
    memoryContext === undefined
      ? undefined
      : {
          workflowMemoryContextId: memoryContext.workflowMemoryContextId,
          revision: memoryContext.revision,
          sha256: memoryContext.sha256,
          items: memoryContext.items.map((ref) => {
            const item = snapshot.entities.workflowMemorySnapshots[ref.workflowMemorySnapshotId];
            if (
              item === undefined ||
              item.revision !== ref.revision ||
              item.sha256 !== ref.sha256
            ) {
              throw revisionConflict("Direct Agent Memory Snapshot引用已漂移");
            }
            return {
              workflowMemorySnapshotId: item.workflowMemorySnapshotId,
              providerId: item.providerId,
              title: item.title,
              category: item.category,
              content: item.content,
              labels: item.labels,
              revision: item.revision,
              sha256: item.sha256,
            };
          }),
        };
  if (memoryContextDto !== undefined) {
    if (promptAssembly.schemaVersion !== "prompt-assembly.v2") {
      throw revisionConflict("Memory Direct只能使用带冻结预算的Prompt Assembly V2");
    }
    const budget = evaluateDirectAgentMemoryPromptBudget({
      baseEstimatedTokens: promptAssembly.budget.totalEstimatedTokens,
      inputTokenLimit: promptAssembly.budget.inputTokenLimit,
      memoryContext: memoryContextDto,
    });
    if (!budget.withinBudget) {
      throw revisionConflict(
        "Memory Context与Direct Prompt合计超过输入Token预算，请降低Memory上下文上限后重试",
      );
    }
  }
  return {
    productRunId: input.productRunId,
    directAgentAttemptId: attempt.attemptId,
    runRevision: run.revision,
    sourceMessage: {
      messageId: message.messageId,
      text: message.content.text,
      sha256: attempt.sourceMessageSha256,
    },
    promptAssembly: {
      schemaVersion: promptAssembly.schemaVersion,
      promptAssemblyId: promptAssembly.promptAssemblyId,
      sha256: promptAssembly.sha256,
      systemPromptAppend: promptAssembly.systemPromptAppend,
      ...(promptAssembly.schemaVersion === "prompt-assembly.v1"
        ? { userPrompt: promptAssembly.userPrompt }
        : {
            ...(promptAssembly.piSystemPrompt === undefined
              ? {}
              : { piSystemPrompt: promptAssembly.piSystemPrompt }),
            messages: promptAssembly.messages,
            tools: promptAssembly.tools,
            requestOptions: promptAssembly.requestOptions,
            budget: promptAssembly.budget,
          }),
      ...(promptAssembly.workspaceRootId === undefined
        ? {}
        : { workspaceRootId: promptAssembly.workspaceRootId }),
    },
    capabilityMode: config.capabilityMode,
    ...(memoryContextDto === undefined ? {} : { memoryContext: memoryContextDto }),
    ...(projectBootstrapContext === undefined ? {} : { projectBootstrapContext }),
    promptReviewMode: config.promptReviewMode,
    limits: {
      maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
      activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
      tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
    },
  };
}

export async function persistDirectAgentCandidate(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly productRunId: ProductRunId;
    readonly directAgentAttemptId: RunAttemptId;
    readonly output: DirectAgentCandidateOutput;
  },
): Promise<{ readonly directAgentCandidateId: DirectAgentCandidateId; readonly sha256: string }> {
  const ids = requireDirectAgentIds(deps);
  const now = deps.now();
  const directAgentCandidateId = ids.candidate();
  const sha256 = computeDirectAgentCandidateSha256({
    directAgentCandidateId,
    productRunId: input.productRunId,
    directAgentAttemptId: input.directAgentAttemptId,
    output: input.output,
  });
  const requestSha256 = hashCanonical("command.persist-direct-agent-candidate.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistDirectAgentCandidate",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      if (
        run.status !== "running" ||
        run.phase !== "executing" ||
        attempt === undefined ||
        attempt.productRunId !== input.productRunId ||
        attempt.kind !== "direct_agent" ||
        attempt.outcome !== "running"
      ) {
        throw revisionConflict("Direct Agent Candidate不能在当前状态提交");
      }
      if (
        Object.values(draft.entities.promptReviewRequests).some(
          (review) =>
            review.directAgentAttemptId === input.directAgentAttemptId &&
            ["open", "approved", "dispatching"].includes(review.status),
        )
      ) {
        throw revisionConflict("仍有未闭合Prompt Review，不能提交Direct Agent Candidate");
      }
      const candidate: DirectAgentCandidate = {
        schemaVersion: "direct-agent-candidate.v1",
        directAgentCandidateId,
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        output: input.output,
        sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.directAgentCandidates[directAgentCandidateId] = candidate;
      draft.entities.attempts[attempt.attemptId] = {
        ...attempt,
        outcome: "success",
        revision: attempt.revision + 1,
        updatedAt: now,
      };
      draft.entities.runs[input.productRunId] = {
        ...run,
        currentDirectAgentCandidateId: directAgentCandidateId,
        revision: run.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { directAgentCandidateId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate =
    snapshot.entities.directAgentCandidates[result.resultRefs["directAgentCandidateId"] ?? ""];
  if (candidate === undefined) throw notFound("Direct Agent Candidate不存在");
  return { directAgentCandidateId: candidate.directAgentCandidateId, sha256: candidate.sha256 };
}

export async function commitDirectAgentResult(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly productRunId: ProductRunId;
    readonly directAgentAttemptId: RunAttemptId;
    readonly directAgentCandidateId: DirectAgentCandidateId;
    readonly candidateSha256: string;
  },
): Promise<{
  readonly message: ReturnType<typeof toMessageDto>;
  readonly run: ReturnType<typeof toRunDto>;
}> {
  const now = deps.now();
  const messageId = deps.ids.message();
  const requestSha256 = hashCanonical("command.commit-direct-agent-result.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitDirectAgentResult",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      const candidate = draft.entities.directAgentCandidates[input.directAgentCandidateId];
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      if (
        run.status !== "running" ||
        run.phase !== "executing" ||
        run.currentDirectAgentCandidateId !== input.directAgentCandidateId ||
        candidate === undefined ||
        candidate.productRunId !== input.productRunId ||
        candidate.directAgentAttemptId !== input.directAgentAttemptId ||
        candidate.sha256 !== input.candidateSha256 ||
        attempt === undefined ||
        attempt.outcome !== "success"
      ) {
        throw revisionConflict("Direct Agent Product Commit绑定不完整或已变化");
      }
      const recomputed = computeDirectAgentCandidateSha256({
        directAgentCandidateId: candidate.directAgentCandidateId,
        productRunId: candidate.productRunId,
        directAgentAttemptId: candidate.directAgentAttemptId,
        output: candidate.output,
      });
      if (recomputed !== candidate.sha256) {
        throw new ApplicationError({
          code: "revision_conflict",
          httpStatus: 409,
          message: "Direct Agent Candidate Hash不一致",
        });
      }
      const session = draft.entities.sessions[run.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      const sessionSequence = session.lastMessageSequence + 1;
      draft.entities.messages[messageId] = {
        schemaVersion: "message.v1",
        messageId,
        sessionId: run.sessionId,
        sessionSequence,
        role: "assistant",
        content: candidate.output,
        sourceRunId: input.productRunId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.sessions[session.sessionId] = {
        ...session,
        lastMessageSequence: sessionSequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      const workflowAttempt = Object.values(draft.entities.attempts).find(
        (item) =>
          item.productRunId === input.productRunId &&
          item.kind === "workflow" &&
          item.outcome === "running",
      );
      if (workflowAttempt !== undefined) {
        draft.entities.attempts[workflowAttempt.attemptId] = {
          ...workflowAttempt,
          outcome: "success",
          revision: workflowAttempt.revision + 1,
          updatedAt: now,
        };
      }
      const lifecycle = transitionDirectAgentRunLifecycle(
        { status: run.status, phase: run.phase },
        { status: "succeeded", phase: "completed" },
      );
      draft.entities.runs[input.productRunId] = {
        ...run,
        status: lifecycle.status,
        phase: lifecycle.phase,
        finalDirectAgentCandidateId: candidate.directAgentCandidateId,
        finalMessageId: messageId,
        revision: run.revision + 1,
        updatedAt: now,
      };
      return {
        resultRefs: {
          productRunId: input.productRunId,
          directAgentCandidateId: candidate.directAgentCandidateId,
          messageId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const message = snapshot.entities.messages[result.resultRefs["messageId"] ?? ""];
  const run = snapshot.entities.runs[input.productRunId];
  if (message === undefined || run === undefined) throw notFound("Direct Agent提交结果不存在");
  return { message: toMessageDto(message), run: toRunDto(run, undefined, undefined) };
}
