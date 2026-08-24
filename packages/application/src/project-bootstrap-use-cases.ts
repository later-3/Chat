import {
  commandIdSchema,
  projectBootstrapCandidateSchema,
  projectBootstrapDecisionSchema,
  projectBootstrapOperationSchema,
  projectBootstrapProposalSchema,
  projectWorkspaceBindingSchema,
  type CommandId,
  type OutboxEntryId,
  type PrincipalId,
  type ProductRunId,
  type ProductSessionId,
  type ProjectBootstrapCandidate,
  type ProjectBootstrapCandidateId,
  type ProjectBootstrapOperation,
  type ProjectBootstrapOperationId,
  type ProjectBootstrapProposal,
} from "@chat/contracts";
import {
  assertProjectBootstrapCandidateTransition,
  assertProjectBootstrapDecisionBinding,
  computeProjectBootstrapCandidateSha256,
  deriveProjectBootstrapOutcome,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import type {
  ProjectManagementProvisionResult,
  ProjectWorkspaceProvisionResult,
  ProjectBootstrapWriteFence,
} from "./project-bootstrap-ports.js";
import { CommandIdReusedError, forbidden, notFound, revisionConflict } from "./errors.js";

export const MAX_PROJECT_BOOTSTRAP_EXECUTION_LEASE_MS = 10 * 60_000;

/** 活跃执行租约属于正常竞争，不是Provider失败；Dispatcher应保留pending等待下一轮。 */
export class ProjectBootstrapExecutionLeaseBusyError extends Error {
  constructor() {
    super("Project Bootstrap Operation已有活跃执行租约");
    this.name = "ProjectBootstrapExecutionLeaseBusyError";
  }
}

function activeExecutionLease(
  outbox: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"]["outbox"],
  operationId: ProjectBootstrapOperationId,
  at: string,
) {
  for (const entry of Object.values(outbox)) {
    if (
      entry.kind === "project_bootstrap_execute" &&
      entry.projectBootstrapOperationId === operationId &&
      entry.executionLease !== undefined &&
      Date.parse(entry.executionLease.expiresAt) > Date.parse(at) &&
      (entry.status === "pending" ||
        entry.status === "dispatched" ||
        entry.status === "outcome_unknown")
    ) {
      return entry.executionLease;
    }
  }
  return undefined;
}

function requireBootstrapDeps(deps: ApplicationDeps) {
  if (
    deps.projectBootstrapIds === undefined ||
    deps.projectManagementBootstrap === undefined ||
    deps.projectWorkspaceProvisioner === undefined
  ) {
    throw new Error("Project Bootstrap能力未配置");
  }
  return {
    ids: deps.projectBootstrapIds,
    plane: deps.projectManagementBootstrap,
    workspace: deps.projectWorkspaceProvisioner,
  };
}

function requireBootstrapIds(deps: ApplicationDeps) {
  if (deps.projectBootstrapIds === undefined) {
    throw new Error("Project Bootstrap产品ID能力未配置");
  }
  return deps.projectBootstrapIds;
}

function assertDirectAgentBootstrapSource(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  input: {
    readonly principalId: PrincipalId;
    readonly productSessionId: ProductSessionId;
    readonly productRunId: ProductRunId;
  },
) {
  const session = snapshot.entities.sessions[input.productSessionId];
  const run = snapshot.entities.runs[input.productRunId];
  if (session === undefined || run === undefined)
    throw notFound("建项会话或Direct Agent Run不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权在该会话创建项目");
  if (
    run.runKind !== "direct_agent" ||
    run.sessionId !== session.sessionId ||
    run.status !== "running" ||
    run.phase !== "executing"
  ) {
    throw revisionConflict("只有正在执行的Direct Agent建项会话可以准备项目");
  }
  const runSpec = snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
  const node = runSpec?.nodeResolutions.find(
    (candidate) => candidate.nodeType === "agent.direct" && candidate.activation === "enabled",
  );
  if (node?.config["capabilityMode"] !== "project_bootstrap") {
    throw forbidden("该Direct Agent没有受控项目初始化能力");
  }
  return { session, run };
}

function strictlyAfter(base: string, candidate: string): string {
  return Date.parse(candidate) > Date.parse(base)
    ? candidate
    : new Date(Date.parse(base) + 1).toISOString();
}

export async function prepareProjectBootstrapCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly productSessionId: ProductSessionId;
    readonly productRunId: ProductRunId;
    readonly commandId: CommandId;
    readonly proposal: ProjectBootstrapProposal;
  },
): Promise<ProjectBootstrapCandidate> {
  const proposal = projectBootstrapProposalSchema.parse(input.proposal);
  const requestSha256 = hashCanonical("command.prepare-project-bootstrap.v1", input);
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const priorReceipt = before.snapshot.commandReceipts[input.commandId];
  if (priorReceipt !== undefined) {
    if (
      priorReceipt.commandType !== "PrepareProjectBootstrapCandidate" ||
      priorReceipt.requestSha256 !== requestSha256
    ) {
      throw new CommandIdReusedError(input.commandId);
    }
    return readCandidate(before, priorReceipt.resultRefs);
  }
  const capability = requireBootstrapDeps(deps);
  assertDirectAgentBootstrapSource(before.snapshot, input);
  if (
    Object.values(before.snapshot.entities.projectBootstrapCandidates).some(
      (candidate) =>
        candidate.sourceProductSessionId === input.productSessionId &&
        candidate.status !== "rejected",
    )
  ) {
    throw revisionConflict("该会话已有建项候选；请先完成或拒绝当前候选");
  }
  const [workspacePreview, planePreview] = await Promise.all([
    capability.workspace.preflight({
      rootId: proposal.workspaceRootId,
      directoryName: proposal.directoryName,
    }),
    capability.plane.preflight({
      workspaceSlug: proposal.planeWorkspaceSlug,
      projectIdentifier: proposal.planeProjectIdentifier,
      projectName: proposal.name,
    }),
  ]);
  const preview = {
    planeProjectLabel: planePreview.planeProjectLabel,
    workspaceLabel: workspacePreview.workspaceLabel,
    gitAction: "initialize" as const,
    initialModules: [...proposal.initialModules],
  };
  const candidateId = capability.ids.candidate();
  const now = deps.now();
  const sha256 = computeProjectBootstrapCandidateSha256({
    ownerPrincipalId: input.principalId,
    sourceProductSessionId: input.productSessionId,
    sourceProductRunId: input.productRunId,
    proposal,
    preview,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PrepareProjectBootstrapCandidate",
    requestSha256,
    traceContext: {
      productSessionId: input.productSessionId,
      productRunId: input.productRunId,
    },
    mutate: (draft) => {
      assertDirectAgentBootstrapSource(draft, input);
      if (
        Object.values(draft.entities.projectBootstrapCandidates).some(
          (candidate) =>
            candidate.sourceProductSessionId === input.productSessionId &&
            candidate.status !== "rejected",
        )
      ) {
        throw revisionConflict("该会话已有建项候选；请先完成或拒绝当前候选");
      }
      const candidate = projectBootstrapCandidateSchema.parse({
        schemaVersion: "project-bootstrap.v1",
        projectBootstrapCandidateId: candidateId,
        ownerPrincipalId: input.principalId,
        sourceProductSessionId: input.productSessionId,
        sourceProductRunId: input.productRunId,
        proposal,
        preview,
        status: "prepared",
        sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.projectBootstrapCandidates[candidateId] = candidate;
      return { resultRefs: { projectBootstrapCandidateId: candidateId } };
    },
  });
  return readCandidate(await deps.store.read({ kind: "committedSnapshot" }), result.resultRefs);
}

/** Pi Executor只持有Product Run身份；Principal与Session必须由Product Store反查。 */
export async function prepareProjectBootstrapCandidateForRuntime(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly commandId: CommandId;
    readonly proposal: ProjectBootstrapProposal;
  },
): Promise<ProjectBootstrapCandidate> {
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  const priorReceipt = committed.snapshot.commandReceipts[input.commandId];
  if (priorReceipt !== undefined) {
    if (priorReceipt.commandType !== "PrepareProjectBootstrapCandidate") {
      throw new CommandIdReusedError(input.commandId);
    }
    const candidate = readCandidate(committed, priorReceipt.resultRefs);
    const replayRequestSha256 = hashCanonical("command.prepare-project-bootstrap.v1", {
      principalId: candidate.ownerPrincipalId,
      productSessionId: candidate.sourceProductSessionId,
      productRunId: input.productRunId,
      commandId: input.commandId,
      proposal: input.proposal,
    });
    if (
      priorReceipt.requestSha256 !== replayRequestSha256 ||
      candidate.sourceProductRunId !== input.productRunId
    ) {
      throw new CommandIdReusedError(input.commandId);
    }
    return candidate;
  }
  const run = committed.snapshot.entities.runs[input.productRunId];
  if (run?.runKind !== "direct_agent") throw notFound("Direct Agent Run不存在");
  const session = committed.snapshot.entities.sessions[run.sessionId];
  if (session === undefined) throw notFound("Direct Agent Session不存在");
  return prepareProjectBootstrapCandidate(deps, {
    principalId: session.ownerPrincipalId,
    productSessionId: session.sessionId,
    productRunId: run.productRunId,
    commandId: input.commandId,
    proposal: input.proposal,
  });
}

export async function decideProjectBootstrapCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectBootstrapCandidateId: ProjectBootstrapCandidateId;
    readonly candidateRevision: number;
    readonly candidateSha256: string;
    readonly kind: "confirm" | "reject";
    readonly reason?: string;
  },
): Promise<{
  readonly candidate: ProjectBootstrapCandidate;
  readonly operation?: ProjectBootstrapOperation;
}> {
  const ids = requireBootstrapIds(deps);
  const decisionId = ids.decision();
  const operationId = input.kind === "confirm" ? ids.operation() : undefined;
  const outboxId = input.kind === "confirm" ? deps.ids.outbox() : undefined;
  const decidedAt = deps.now();
  const requestSha256 = hashCanonical("command.decide-project-bootstrap.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "DecideProjectBootstrapCandidate",
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.projectBootstrapCandidates[input.projectBootstrapCandidateId];
      if (current === undefined) throw notFound("Project Bootstrap Candidate不存在");
      if (current.ownerPrincipalId !== input.principalId) throw forbidden("无权决定该建项候选");
      if (
        current.status !== "prepared" ||
        current.revision !== input.candidateRevision ||
        current.sha256 !== input.candidateSha256
      ) {
        throw revisionConflict("建项候选已变化，请刷新后重试");
      }
      const at = strictlyAfter(current.updatedAt, decidedAt);
      const decision = projectBootstrapDecisionSchema.parse({
        schemaVersion: "project-bootstrap.v1",
        projectBootstrapDecisionId: decisionId,
        projectBootstrapCandidateId: current.projectBootstrapCandidateId,
        candidateRevision: current.revision,
        candidateSha256: current.sha256,
        decidedByPrincipalId: input.principalId,
        kind: input.kind,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        decidedAt: at,
      });
      assertProjectBootstrapDecisionBinding({ candidate: current, decision });
      const candidate = projectBootstrapCandidateSchema.parse({
        ...current,
        status: input.kind === "confirm" ? "confirmed" : "rejected",
        revision: current.revision + 1,
        updatedAt: at,
      });
      assertProjectBootstrapCandidateTransition({ current, next: candidate });
      draft.entities.projectBootstrapDecisions[decisionId] = decision;
      draft.entities.projectBootstrapCandidates[current.projectBootstrapCandidateId] = candidate;
      if (input.kind === "confirm") {
        // Provider配置只约束首次确认；Receipt重放会在Store进入mutate前短路，
        // 因而已提交确认不会因为部署随后关闭Provider而失去恢复能力。
        requireBootstrapDeps(deps);
        if (operationId === undefined || outboxId === undefined) {
          throw new Error("Project Bootstrap确认缺少Operation或Outbox身份");
        }
        draft.entities.projectBootstrapOperations[operationId] =
          projectBootstrapOperationSchema.parse({
            schemaVersion: "project-bootstrap.v1",
            projectBootstrapOperationId: operationId,
            projectBootstrapCandidateId: current.projectBootstrapCandidateId,
            projectBootstrapDecisionId: decisionId,
            candidateSha256: current.sha256,
            ownerPrincipalId: current.ownerPrincipalId,
            status: "queued",
            workspaceStep: "pending",
            planeStep: "pending",
            bindingStep: "pending",
            revision: 1,
            createdAt: at,
            updatedAt: at,
          });
        // 确认、Operation与后台认领意图必须同一事务提交。Bridge收到201后无需再记住
        // 第二个命令；API进程退出后Dispatcher仍会从这条耐久事实继续同一Operation。
        draft.outbox[outboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId,
          kind: "project_bootstrap_execute",
          projectBootstrapOperationId: operationId,
          expectedOperationRevision: 1,
          mode: "execute",
          status: "pending",
          dispatchAttempts: 0,
          revision: 1,
          createdAt: at,
          updatedAt: at,
        };
      }
      return {
        resultRefs: {
          projectBootstrapCandidateId: current.projectBootstrapCandidateId,
          projectBootstrapDecisionId: decisionId,
          ...(input.kind === "confirm"
            ? {
                projectBootstrapOperationId: operationId!,
                outboxId: outboxId!,
              }
            : {}),
        },
      };
    },
  });
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = readCandidate(committed, result.resultRefs);
  const operationIdRef = result.resultRefs["projectBootstrapOperationId"];
  return {
    candidate,
    ...(operationIdRef === undefined
      ? {}
      : { operation: requireOperation(committed.snapshot, operationIdRef) }),
  };
}

/**
 * 用户retry只创建同一Operation的reconcile Outbox，不直接越过Provider边界。
 * 相同Operation已有活动Outbox时返回其身份，不制造第二条外部动作意图。
 */
export async function requestProjectBootstrapOperationRetry(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
    readonly expectedOperationRevision: number;
  },
): Promise<ProjectBootstrapOperation> {
  const requestSha256 = hashCanonical("command.request-project-bootstrap-retry.v1", input);
  const before = await deps.store.read({ kind: "committedSnapshot" });
  const priorReceipt = before.snapshot.commandReceipts[input.commandId];
  if (priorReceipt !== undefined) {
    if (
      priorReceipt.commandType !== "RequestProjectBootstrapOperationRetry" ||
      priorReceipt.requestSha256 !== requestSha256
    ) {
      throw new CommandIdReusedError(input.commandId);
    }
    return requireOperation(
      before.snapshot,
      priorReceipt.resultRefs["projectBootstrapOperationId"] ?? input.projectBootstrapOperationId,
    );
  }
  requireBootstrapDeps(deps);
  const outboxId = deps.ids.outbox();
  const requestedAt = deps.now();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RequestProjectBootstrapOperationRetry",
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.projectBootstrapOperations[input.projectBootstrapOperationId];
      if (current === undefined) throw notFound("Project Bootstrap Operation不存在");
      if (current.ownerPrincipalId !== input.principalId) throw forbidden("无权重试该建项操作");
      if (current.revision !== input.expectedOperationRevision) {
        throw revisionConflict("建项操作已变化，请刷新后重试");
      }
      if (current.status === "ready") throw revisionConflict("项目已经初始化完成");
      if (
        activeExecutionLease(draft.outbox, current.projectBootstrapOperationId, requestedAt) !==
        undefined
      ) {
        throw revisionConflict("建项操作仍在后台执行");
      }
      const existing = Object.values(draft.outbox).find(
        (entry) =>
          entry.kind === "project_bootstrap_execute" &&
          entry.projectBootstrapOperationId === current.projectBootstrapOperationId &&
          (entry.status === "pending" ||
            entry.status === "dispatched" ||
            entry.status === "outcome_unknown"),
      );
      if (existing !== undefined) {
        return {
          resultRefs: {
            projectBootstrapOperationId: current.projectBootstrapOperationId,
            outboxId: existing.outboxId,
          },
        };
      }
      const at = strictlyAfter(current.updatedAt, requestedAt);
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "project_bootstrap_execute",
        projectBootstrapOperationId: current.projectBootstrapOperationId,
        expectedOperationRevision: current.revision,
        mode: "reconcile",
        status: "pending",
        dispatchAttempts: 0,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      return {
        resultRefs: {
          projectBootstrapOperationId: current.projectBootstrapOperationId,
          outboxId,
        },
      };
    },
  });
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  return requireOperation(
    committed.snapshot,
    result.resultRefs["projectBootstrapOperationId"] ?? input.projectBootstrapOperationId,
  );
}

/**
 * Dispatcher拥有的后台执行入口。认领事务同时冻结Operation和私有Outbox lease；
 * Workspace/Plane调用全部发生在事务外。只有租约过期才把dispatching视为崩溃恢复，
 * 且接管者必须先对账；正在活跃的另一Dispatcher不得重复Provider写入。
 */
export async function executeProjectBootstrapOperationFromOutbox(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    /** 每次Worker调用唯一；用于让写前续租每次都重新执行而不重放旧Receipt。 */
    readonly executionInvocationId: CommandId;
    readonly outboxId: OutboxEntryId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
    readonly expectedOperationRevision: number;
    readonly mode: "execute" | "reconcile";
    readonly leaseDurationMs: number;
  },
): Promise<ProjectBootstrapOperation> {
  const coordinator = deps.projectBootstrapExecutionCoordinator;
  if (coordinator === undefined) {
    throw new Error("Project Bootstrap执行协调器未配置");
  }
  return coordinator.runExclusive(input.projectBootstrapOperationId, () =>
    executeProjectBootstrapOperationExclusive(deps, input),
  );
}

async function executeProjectBootstrapOperationExclusive(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly executionInvocationId: CommandId;
    readonly outboxId: OutboxEntryId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
    readonly expectedOperationRevision: number;
    readonly mode: "execute" | "reconcile";
    readonly leaseDurationMs: number;
  },
): Promise<ProjectBootstrapOperation> {
  const capability = requireBootstrapDeps(deps);
  const claimAt = deps.now();
  if (
    !Number.isInteger(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0 ||
    input.leaseDurationMs > MAX_PROJECT_BOOTSTRAP_EXECUTION_LEASE_MS
  ) {
    throw new Error("Project Bootstrap执行租约时长无效");
  }
  const claim = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ClaimProjectBootstrapOperation",
    requestSha256: hashCanonical("command.claim-project-bootstrap-operation.v2", {
      commandId: input.commandId,
      outboxId: input.outboxId,
      projectBootstrapOperationId: input.projectBootstrapOperationId,
      expectedOperationRevision: input.expectedOperationRevision,
      mode: input.mode,
      leaseDurationMs: input.leaseDurationMs,
    }),
    mutate: (draft) => {
      const current = draft.entities.projectBootstrapOperations[input.projectBootstrapOperationId];
      if (current === undefined) throw notFound("Project Bootstrap Operation不存在");
      const outbox = draft.outbox[input.outboxId];
      if (
        outbox?.kind !== "project_bootstrap_execute" ||
        outbox.projectBootstrapOperationId !== current.projectBootstrapOperationId ||
        !["pending", "dispatched", "outcome_unknown"].includes(outbox.status)
      ) {
        throw revisionConflict("建项Outbox不存在或已终结");
      }
      if (current.status === "ready") throw revisionConflict("项目已经初始化完成");

      const activeLease = activeExecutionLease(
        draft.outbox,
        current.projectBootstrapOperationId,
        claimAt,
      );
      if (activeLease !== undefined && activeLease.attemptCommandId !== input.commandId) {
        throw new ProjectBootstrapExecutionLeaseBusyError();
      }

      const staleDispatch = current.status === "dispatching" && activeLease === undefined;
      if (
        !staleDispatch &&
        (current.revision !== input.expectedOperationRevision ||
          outbox.expectedOperationRevision !== input.expectedOperationRevision)
      ) {
        throw revisionConflict("建项Outbox绑定的Operation revision已经变化");
      }
      if (
        !staleDispatch &&
        ((input.mode === "execute" && current.status !== "queued") ||
          (input.mode === "reconcile" &&
            !["queued", "failed", "needs_attention", "outcome_unknown"].includes(current.status)))
      ) {
        throw revisionConflict("建项Outbox与Operation状态不一致");
      }
      const candidate =
        draft.entities.projectBootstrapCandidates[current.projectBootstrapCandidateId];
      if (candidate === undefined || candidate.sha256 !== current.candidateSha256) {
        throw revisionConflict("建项操作绑定的Candidate无效");
      }
      const at = strictlyAfter(current.updatedAt, claimAt);
      const leaseMode = staleDispatch ? "reconcile" : input.mode;
      const fencingToken = current.revision + 1;
      // 同一Operation最多保留一个lease。新认领只能清理已过期lease；活跃lease
      // 已在上方失败关闭。每条Outbox修改都递增revision，避免隐式改写持久事实。
      for (const related of Object.values(draft.outbox)) {
        if (
          related.kind === "project_bootstrap_execute" &&
          related.projectBootstrapOperationId === current.projectBootstrapOperationId &&
          related.executionLease !== undefined
        ) {
          delete related.executionLease;
          related.revision += 1;
          related.updatedAt = at;
        }
      }
      if (candidate.status !== "executing") {
        const executing = projectBootstrapCandidateSchema.parse({
          ...candidate,
          status: "executing",
          revision: candidate.revision + 1,
          updatedAt: at,
        });
        assertProjectBootstrapCandidateTransition({ current: candidate, next: executing });
        draft.entities.projectBootstrapCandidates[candidate.projectBootstrapCandidateId] =
          executing;
      }
      const { errorCode: _previousErrorCode, ...operationWithoutError } = current;
      void _previousErrorCode;
      draft.entities.projectBootstrapOperations[current.projectBootstrapOperationId] =
        projectBootstrapOperationSchema.parse({
          ...operationWithoutError,
          status: "dispatching",
          revision: fencingToken,
          updatedAt: at,
        });
      outbox.executionLease = {
        schemaVersion: "project-bootstrap-execution-lease.v1",
        attemptCommandId: input.commandId,
        fencingToken,
        mode: leaseMode,
        claimedAt: claimAt,
        expiresAt: new Date(Date.parse(claimAt) + input.leaseDurationMs).toISOString(),
      };
      outbox.revision += 1;
      outbox.updatedAt = at;
      return {
        resultRefs: {
          projectBootstrapOperationId: current.projectBootstrapOperationId,
          outboxId: outbox.outboxId,
          executionMode: leaseMode,
          fencingToken: String(fencingToken),
        },
      };
    },
  });
  const afterClaim = await deps.store.read({ kind: "committedSnapshot" });
  const operation = requireOperation(afterClaim.snapshot, input.projectBootstrapOperationId);
  if (claim.replayed && operation.status !== "dispatching") return operation;
  const candidate =
    afterClaim.snapshot.entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId];
  if (candidate === undefined) throw notFound("Project Bootstrap Candidate不存在");

  const executionMode = claim.resultRefs["executionMode"];
  if (executionMode !== "execute" && executionMode !== "reconcile") {
    throw revisionConflict("建项认领缺少执行模式");
  }
  const fencingToken = Number.parseInt(claim.resultRefs["fencingToken"] ?? "", 10);
  if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
    throw revisionConflict("建项认领缺少有效fencing token");
  }
  const reconcileBeforeWrite = claim.replayed || executionMode === "reconcile";
  let writeSequence = 0;
  const writeFence: ProjectBootstrapWriteFence = {
    attemptCommandId: input.commandId,
    fencingToken,
    assertCurrent: async (writeKey) => {
      writeSequence += 1;
      await renewProjectBootstrapExecutionLease(deps, {
        executionInvocationId: input.executionInvocationId,
        claimCommandId: input.commandId,
        outboxId: input.outboxId,
        projectBootstrapOperationId: input.projectBootstrapOperationId,
        fencingToken,
        leaseDurationMs: input.leaseDurationMs,
        writeSequence,
        writeKey,
      });
    },
  };
  const workspaceResult = await runWorkspaceStep(
    capability.workspace,
    operation,
    candidate,
    reconcileBeforeWrite,
    writeFence,
  );
  const planeResult =
    workspaceResult.status === "completed"
      ? await runPlaneStep(capability.plane, operation, candidate, reconcileBeforeWrite, writeFence)
      : ({ status: "failed", errorCode: "plane_skipped_workspace_incomplete" } as const);
  const outcome = deriveProjectBootstrapOutcome({
    workspace: workspaceResult.status,
    plane: planeResult.status,
  });
  const bindingId = capability.ids.binding();
  const finalizeCommandId = commandIdSchema.parse(
    `cmd_${hashCanonical("project-bootstrap-finalize-command.v1", {
      projectBootstrapOperationId: operation.projectBootstrapOperationId,
      operationRevision: operation.revision,
      workspaceResult,
      planeResult,
    }).slice(0, 48)}`,
  );
  const finalizedAt = deps.now();
  const finalizeResult = await deps.store.transact({
    commandId: finalizeCommandId,
    commandType: "FinalizeProjectBootstrapOperation",
    requestSha256: hashCanonical("command.finalize-project-bootstrap-operation.v1", {
      operationId: operation.projectBootstrapOperationId,
      operationRevision: operation.revision,
      workspaceResult,
      planeResult,
    }),
    mutate: (draft) => {
      const current =
        draft.entities.projectBootstrapOperations[operation.projectBootstrapOperationId];
      const currentCandidate =
        draft.entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId];
      const currentOutbox = draft.outbox[input.outboxId];
      if (
        current === undefined ||
        currentCandidate === undefined ||
        currentOutbox?.kind !== "project_bootstrap_execute" ||
        currentOutbox.executionLease?.attemptCommandId !== input.commandId ||
        currentOutbox.executionLease.fencingToken !== fencingToken ||
        Date.parse(currentOutbox.executionLease.expiresAt) <= Date.parse(finalizedAt) ||
        current.status !== "dispatching" ||
        current.revision !== fencingToken ||
        currentCandidate.status !== "executing"
      ) {
        throw revisionConflict("建项操作在外部执行期间发生变化，必须对账");
      }
      const at = strictlyAfter(current.updatedAt, finalizedAt);
      const errorCode =
        outcome === "ready"
          ? undefined
          : workspaceResult.status === "completed"
            ? planeResult.status === "completed"
              ? "project_bootstrap_incomplete"
              : planeResult.errorCode
            : workspaceResult.errorCode;
      const nextOperation = projectBootstrapOperationSchema.parse({
        ...current,
        status: outcome,
        workspaceStep: toWorkspaceStep(workspaceResult),
        planeStep: toPlaneStep(planeResult),
        bindingStep: outcome === "ready" ? "completed" : "pending",
        ...(planeResult.status === "completed"
          ? { planeProjectId: planeResult.planeProjectId }
          : {}),
        ...(errorCode === undefined ? {} : { errorCode }),
        revision: current.revision + 1,
        updatedAt: at,
      });
      const nextCandidate = projectBootstrapCandidateSchema.parse({
        ...currentCandidate,
        status: outcome === "failed" ? "needs_attention" : outcome,
        revision: currentCandidate.revision + 1,
        updatedAt: at,
      });
      assertProjectBootstrapCandidateTransition({ current: currentCandidate, next: nextCandidate });
      draft.entities.projectBootstrapOperations[current.projectBootstrapOperationId] =
        nextOperation;
      draft.entities.projectBootstrapCandidates[currentCandidate.projectBootstrapCandidateId] =
        nextCandidate;
      delete currentOutbox.executionLease;
      currentOutbox.revision += 1;
      currentOutbox.updatedAt = at;
      let committedBindingId: string | undefined;
      if (outcome === "ready" && planeResult.status === "completed") {
        const existing = Object.values(draft.entities.projectWorkspaceBindings).find(
          (binding) => binding.projectBootstrapOperationId === current.projectBootstrapOperationId,
        );
        committedBindingId = existing?.projectWorkspaceBindingId ?? bindingId;
        if (existing === undefined) {
          draft.entities.projectWorkspaceBindings[bindingId] = projectWorkspaceBindingSchema.parse({
            schemaVersion: "project-bootstrap.v1",
            projectWorkspaceBindingId: bindingId,
            ownerPrincipalId: current.ownerPrincipalId,
            productSessionId: currentCandidate.sourceProductSessionId,
            projectBootstrapOperationId: current.projectBootstrapOperationId,
            providerKind: "plane_ce",
            planeWorkspaceSlug: currentCandidate.proposal.planeWorkspaceSlug,
            planeProjectId: planeResult.planeProjectId,
            planeProjectIdentifier: currentCandidate.proposal.planeProjectIdentifier,
            workspaceRootId: currentCandidate.proposal.workspaceRootId,
            directoryName: currentCandidate.proposal.directoryName,
            status: "active",
            revision: 1,
            createdAt: at,
            updatedAt: at,
          });
        }
      }
      return {
        resultRefs: {
          projectBootstrapOperationId: current.projectBootstrapOperationId,
          ...(committedBindingId === undefined
            ? {}
            : { projectWorkspaceBindingId: committedBindingId }),
        },
      };
    },
  });
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  return requireOperation(
    committed.snapshot,
    finalizeResult.resultRefs["projectBootstrapOperationId"] ??
      operation.projectBootstrapOperationId,
  );
}

export async function getProjectBootstrapOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
  },
): Promise<ProjectBootstrapOperation> {
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  const operation = requireOperation(committed.snapshot, input.projectBootstrapOperationId);
  if (operation.ownerPrincipalId !== input.principalId) throw forbidden("无权读取该建项操作");
  return operation;
}

export function getProjectBootstrapConfiguration(deps: ApplicationDeps) {
  if (
    deps.projectManagementBootstrap === undefined ||
    deps.projectWorkspaceProvisioner === undefined ||
    deps.projectBootstrapIds === undefined
  ) {
    return { enabled: false as const };
  }
  const provider = deps.projectManagementBootstrap.describe();
  return {
    enabled: true as const,
    providerKind: provider.providerKind,
    providerVersion: provider.providerVersion,
    providerWebBaseUrl: provider.providerWebBaseUrl,
    planeWorkspaceSlugs: [...provider.allowedWorkspaceSlugs],
    creationRoots: deps.projectWorkspaceProvisioner.listRoots().map((root) => ({ ...root })),
  };
}

export async function getProjectBootstrapReview(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
  },
) {
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  const operation = requireOperation(committed.snapshot, input.projectBootstrapOperationId);
  if (operation.ownerPrincipalId !== input.principalId) throw forbidden("无权读取该建项操作");
  const candidate =
    committed.snapshot.entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId];
  const decision =
    committed.snapshot.entities.projectBootstrapDecisions[operation.projectBootstrapDecisionId];
  if (candidate === undefined || decision === undefined) {
    throw revisionConflict("建项操作的审核事实不完整");
  }
  const binding = Object.values(committed.snapshot.entities.projectWorkspaceBindings).find(
    (item) => item.projectBootstrapOperationId === operation.projectBootstrapOperationId,
  );
  return {
    candidate,
    decision,
    operation,
    ...(binding === undefined ? {} : { binding }),
  };
}

export async function getCurrentProjectBootstrapForSession(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productSessionId: ProductSessionId },
) {
  const committed = await deps.store.read({ kind: "committedSnapshot" });
  const session = committed.snapshot.entities.sessions[input.productSessionId];
  if (session === undefined) throw notFound("Product Session不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权读取该建项会话");
  const candidate = Object.values(committed.snapshot.entities.projectBootstrapCandidates)
    .filter((item) => item.sourceProductSessionId === input.productSessionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (candidate === undefined) return null;
  const operation = Object.values(committed.snapshot.entities.projectBootstrapOperations).find(
    (item) => item.projectBootstrapCandidateId === candidate.projectBootstrapCandidateId,
  );
  const decision =
    operation === undefined
      ? Object.values(committed.snapshot.entities.projectBootstrapDecisions).find(
          (item) => item.projectBootstrapCandidateId === candidate.projectBootstrapCandidateId,
        )
      : committed.snapshot.entities.projectBootstrapDecisions[operation.projectBootstrapDecisionId];
  const binding =
    operation === undefined
      ? undefined
      : Object.values(committed.snapshot.entities.projectWorkspaceBindings).find(
          (item) => item.projectBootstrapOperationId === operation.projectBootstrapOperationId,
        );
  const recovery = projectBootstrapRecoveryProjection(
    committed.snapshot.outbox,
    operation,
    deps.now(),
  );
  return {
    candidate,
    ...(decision === undefined ? {} : { decision }),
    ...(operation === undefined ? {} : { operation }),
    ...(binding === undefined ? {} : { binding }),
    recovery,
  };
}

function projectBootstrapRecoveryProjection(
  outbox: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"]["outbox"],
  operation: ProjectBootstrapOperation | undefined,
  at: string,
) {
  if (operation === undefined) {
    return { canRecover: false, reason: "not_applicable" as const };
  }
  if (operation.status === "ready") {
    return { canRecover: false, reason: "terminal" as const };
  }
  if (activeExecutionLease(outbox, operation.projectBootstrapOperationId, at) !== undefined) {
    return { canRecover: false, reason: "active_execution" as const };
  }
  const activeOutbox = Object.values(outbox).find(
    (entry) =>
      entry.kind === "project_bootstrap_execute" &&
      entry.projectBootstrapOperationId === operation.projectBootstrapOperationId &&
      (entry.status === "pending" ||
        entry.status === "dispatched" ||
        entry.status === "outcome_unknown"),
  );
  if (activeOutbox?.kind === "project_bootstrap_execute") {
    return {
      canRecover: false,
      reason:
        activeOutbox.mode === "reconcile"
          ? ("recovery_pending" as const)
          : ("background_dispatch_pending" as const),
    };
  }
  if (operation.status === "queued" || operation.status === "dispatching") {
    return { canRecover: true, reason: "legacy_dispatch_missing" as const };
  }
  return { canRecover: true, reason: "retryable_failure" as const };
}

/**
 * Provider写边界前的fence。它使用每次Worker调用唯一的Command，因此旧Claim
 * Receipt重放不能重放旧续租Receipt。续租与所有权校验在同一Product事务内完成。
 */
async function renewProjectBootstrapExecutionLease(
  deps: ApplicationDeps,
  input: {
    readonly executionInvocationId: CommandId;
    readonly claimCommandId: CommandId;
    readonly outboxId: OutboxEntryId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
    readonly fencingToken: number;
    readonly leaseDurationMs: number;
    readonly writeSequence: number;
    readonly writeKey: string;
  },
): Promise<void> {
  const renewedAt = deps.now();
  const commandId = commandIdSchema.parse(
    `cmd_${hashCanonical("project-bootstrap-renew-lease-command.v1", {
      executionInvocationId: input.executionInvocationId,
      projectBootstrapOperationId: input.projectBootstrapOperationId,
      fencingToken: input.fencingToken,
      writeSequence: input.writeSequence,
      writeKey: input.writeKey,
    }).slice(0, 48)}`,
  );
  await deps.store.transact({
    commandId,
    commandType: "RenewProjectBootstrapExecutionLease",
    requestSha256: hashCanonical("command.renew-project-bootstrap-execution-lease.v1", input),
    mutate: (draft) => {
      const operation =
        draft.entities.projectBootstrapOperations[input.projectBootstrapOperationId];
      const outbox = draft.outbox[input.outboxId];
      const lease =
        outbox?.kind === "project_bootstrap_execute" ? outbox.executionLease : undefined;
      if (
        operation?.status !== "dispatching" ||
        operation.revision !== input.fencingToken ||
        outbox?.kind !== "project_bootstrap_execute" ||
        outbox.projectBootstrapOperationId !== input.projectBootstrapOperationId ||
        lease?.attemptCommandId !== input.claimCommandId ||
        lease.fencingToken !== input.fencingToken ||
        Date.parse(lease.expiresAt) <= Date.parse(renewedAt)
      ) {
        throw revisionConflict("Project Bootstrap执行fence已失效，必须由当前attempt对账");
      }
      const at = strictlyAfter(outbox.updatedAt, renewedAt);
      outbox.executionLease = {
        ...lease,
        expiresAt: new Date(Date.parse(renewedAt) + input.leaseDurationMs).toISOString(),
      };
      outbox.revision += 1;
      outbox.updatedAt = at;
      return { resultRefs: {} };
    },
  });
}

async function runWorkspaceStep(
  port: NonNullable<ApplicationDeps["projectWorkspaceProvisioner"]>,
  operation: ProjectBootstrapOperation,
  candidate: ProjectBootstrapCandidate,
  reconcileBeforeWrite: boolean,
  writeFence: ProjectBootstrapWriteFence,
): Promise<ProjectWorkspaceProvisionResult> {
  const input = {
    operationId: operation.projectBootstrapOperationId,
    candidateSha256: candidate.sha256,
    proposal: candidate.proposal,
    writeFence,
  };
  if (
    reconcileBeforeWrite ||
    operation.workspaceStep === "completed" ||
    operation.workspaceStep === "outcome_unknown"
  ) {
    const reconciled = await port.reconcile(input);
    if (reconciled.status !== "failed" || reconciled.errorCode !== "project_workspace_not_found") {
      return reconciled;
    }
  }
  await writeFence.assertCurrent("workspace.provision");
  return port.provision(input);
}

async function runPlaneStep(
  port: NonNullable<ApplicationDeps["projectManagementBootstrap"]>,
  operation: ProjectBootstrapOperation,
  candidate: ProjectBootstrapCandidate,
  reconcileBeforeWrite: boolean,
  writeFence: ProjectBootstrapWriteFence,
): Promise<ProjectManagementProvisionResult> {
  const input = {
    operationId: operation.projectBootstrapOperationId,
    candidateSha256: candidate.sha256,
    proposal: candidate.proposal,
    writeFence,
  };
  if (
    reconcileBeforeWrite ||
    operation.planeStep === "completed" ||
    operation.planeStep === "outcome_unknown"
  ) {
    const reconciled = await port.reconcile(input);
    if (reconciled.status !== "failed" || reconciled.errorCode !== "plane_project_not_found") {
      return reconciled;
    }
  }
  await writeFence.assertCurrent("plane.provision");
  return port.provision(input);
}

function toWorkspaceStep(
  result: ProjectWorkspaceProvisionResult,
): ProjectBootstrapOperation["workspaceStep"] {
  return result.status === "completed"
    ? "completed"
    : result.status === "outcome_unknown"
      ? "outcome_unknown"
      : "failed";
}

function toPlaneStep(
  result: ProjectManagementProvisionResult,
): ProjectBootstrapOperation["planeStep"] {
  return result.status === "completed"
    ? "completed"
    : result.status === "outcome_unknown"
      ? "outcome_unknown"
      : "failed";
}

function readCandidate(
  committed: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>,
  resultRefs: Record<string, string>,
): ProjectBootstrapCandidate {
  const candidate =
    committed.snapshot.entities.projectBootstrapCandidates[
      resultRefs["projectBootstrapCandidateId"] ?? ""
    ];
  if (candidate === undefined) throw notFound("Project Bootstrap Candidate不存在");
  return candidate;
}

function requireOperation(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  operationId: string,
): ProjectBootstrapOperation {
  const operation = snapshot.entities.projectBootstrapOperations[operationId];
  if (operation === undefined) throw notFound("Project Bootstrap Operation不存在");
  return operation;
}
