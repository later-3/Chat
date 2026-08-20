import {
  commandIdSchema,
  projectBootstrapCandidateSchema,
  projectBootstrapDecisionSchema,
  projectBootstrapOperationSchema,
  projectBootstrapProposalSchema,
  projectWorkspaceBindingSchema,
  type CommandId,
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
} from "./project-bootstrap-ports.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";

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
  const capability = requireBootstrapDeps(deps);
  const proposal = projectBootstrapProposalSchema.parse(input.proposal);
  const before = await deps.store.read({ kind: "committedSnapshot" });
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
  const requestSha256 = hashCanonical("command.prepare-project-bootstrap.v1", input);
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
  const capability = requireBootstrapDeps(deps);
  const decisionId = capability.ids.decision();
  const operationId = capability.ids.operation();
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
      }
      return {
        resultRefs: {
          projectBootstrapCandidateId: current.projectBootstrapCandidateId,
          projectBootstrapDecisionId: decisionId,
          ...(input.kind === "confirm" ? { projectBootstrapOperationId: operationId } : {}),
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

export async function executeProjectBootstrapOperation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectBootstrapOperationId: ProjectBootstrapOperationId;
  },
): Promise<ProjectBootstrapOperation> {
  const capability = requireBootstrapDeps(deps);
  const claimAt = deps.now();
  const claim = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ClaimProjectBootstrapOperation",
    requestSha256: hashCanonical("command.claim-project-bootstrap-operation.v1", input),
    mutate: (draft) => {
      const current = draft.entities.projectBootstrapOperations[input.projectBootstrapOperationId];
      if (current === undefined) throw notFound("Project Bootstrap Operation不存在");
      if (current.ownerPrincipalId !== input.principalId) throw forbidden("无权执行该建项操作");
      if (current.status === "ready") throw revisionConflict("项目已经初始化完成");
      const candidate =
        draft.entities.projectBootstrapCandidates[current.projectBootstrapCandidateId];
      if (candidate === undefined || candidate.sha256 !== current.candidateSha256) {
        throw revisionConflict("建项操作绑定的Candidate无效");
      }
      const at = strictlyAfter(current.updatedAt, claimAt);
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
          revision: current.revision + 1,
          updatedAt: at,
        });
      return { resultRefs: { projectBootstrapOperationId: current.projectBootstrapOperationId } };
    },
  });
  const afterClaim = await deps.store.read({ kind: "committedSnapshot" });
  const operation = requireOperation(afterClaim.snapshot, input.projectBootstrapOperationId);
  if (claim.replayed) return operation;
  const candidate =
    afterClaim.snapshot.entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId];
  if (candidate === undefined) throw notFound("Project Bootstrap Candidate不存在");

  const workspaceResult = await runWorkspaceStep(capability.workspace, operation, candidate);
  const planeResult =
    workspaceResult.status === "completed"
      ? await runPlaneStep(capability.plane, operation, candidate)
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
      if (
        current === undefined ||
        currentCandidate === undefined ||
        current.status !== "dispatching" ||
        current.revision !== operation.revision ||
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
      if (outcome === "ready" && planeResult.status === "completed") {
        const existing = Object.values(draft.entities.projectWorkspaceBindings).find(
          (binding) => binding.projectBootstrapOperationId === current.projectBootstrapOperationId,
        );
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
          ...(outcome === "ready" ? { projectWorkspaceBindingId: bindingId } : {}),
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
    .filter(
      (item) =>
        item.sourceProductSessionId === input.productSessionId && item.status !== "rejected",
    )
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
  return {
    candidate,
    ...(decision === undefined ? {} : { decision }),
    ...(operation === undefined ? {} : { operation }),
    ...(binding === undefined ? {} : { binding }),
  };
}

async function runWorkspaceStep(
  port: NonNullable<ApplicationDeps["projectWorkspaceProvisioner"]>,
  operation: ProjectBootstrapOperation,
  candidate: ProjectBootstrapCandidate,
): Promise<ProjectWorkspaceProvisionResult> {
  const input = {
    operationId: operation.projectBootstrapOperationId,
    candidateSha256: candidate.sha256,
    proposal: candidate.proposal,
  };
  if (operation.workspaceStep === "completed" || operation.workspaceStep === "outcome_unknown") {
    const reconciled = await port.reconcile(input);
    if (reconciled.status !== "failed" || reconciled.errorCode !== "project_workspace_not_found") {
      return reconciled;
    }
  }
  return port.provision(input);
}

async function runPlaneStep(
  port: NonNullable<ApplicationDeps["projectManagementBootstrap"]>,
  operation: ProjectBootstrapOperation,
  candidate: ProjectBootstrapCandidate,
): Promise<ProjectManagementProvisionResult> {
  const input = {
    operationId: operation.projectBootstrapOperationId,
    candidateSha256: candidate.sha256,
    proposal: candidate.proposal,
  };
  if (operation.planeStep === "completed" || operation.planeStep === "outcome_unknown") {
    const reconciled = await port.reconcile(input);
    if (reconciled.status !== "failed" || reconciled.errorCode !== "plane_project_not_found") {
      return reconciled;
    }
  }
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
