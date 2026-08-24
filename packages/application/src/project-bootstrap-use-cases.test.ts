import { describe, expect, it, vi } from "vitest";
import {
  createEmptySnapshot,
  type ProductSnapshot,
  type ProjectBootstrapProposal,
} from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import type {
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
} from "./product-store-port.js";
import {
  decideProjectBootstrapCandidate,
  executeProjectBootstrapOperationFromOutbox,
  getCurrentProjectBootstrapForSession,
  prepareProjectBootstrapCandidate,
  prepareProjectBootstrapCandidateForRuntime,
  requestProjectBootstrapOperationRetry,
} from "./project-bootstrap-use-cases.js";
import { createInProcessProjectBootstrapExecutionCoordinator } from "./project-bootstrap-ports.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";
import { compileWorkflowRunSpec } from "./workflow-run-spec-compiler.js";
import {
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  createSystemDirectAgentDefinition,
} from "./workflow-system-definitions.js";

const NOW = "2026-08-20T16:00:00.000Z";
const PRINCIPAL = "usr_bootstrap" as const;
const SESSION = "psn_bootstrap" as const;
const RUN = "run_bootstrap" as const;
const MESSAGE = "msg_bootstrap" as const;
const RUN_SPEC = "wrs_bootstrap" as const;
const PLANE_PROJECT_ID = "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as const;

class InMemoryProductStore implements ProductStorePort {
  #snapshot: ProductSnapshot;

  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  async read() {
    return { snapshot: structuredClone(this.#snapshot) };
  }

  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const prior = this.#snapshot.commandReceipts[transaction.commandId];
    if (prior !== undefined) {
      if (
        prior.requestSha256 !== transaction.requestSha256 ||
        prior.commandType !== transaction.commandType
      ) {
        throw new Error("command reused");
      }
      return {
        storeRevision: this.#snapshot.storeRevision,
        resultRefs: prior.resultRefs,
        replayed: true,
      };
    }
    const draft = structuredClone(this.#snapshot);
    const mutation = transaction.mutate(draft);
    draft.storeRevision += 1;
    draft.committedAt = NOW;
    draft.commandReceipts[transaction.commandId] = {
      commandId: transaction.commandId,
      commandType: transaction.commandType,
      requestSha256: transaction.requestSha256,
      resultRefs: mutation.resultRefs,
      committedStoreRevision: draft.storeRevision,
      createdAt: NOW,
    };
    this.#snapshot = draft;
    const result = {
      storeRevision: draft.storeRevision,
      resultRefs: mutation.resultRefs,
      replayed: false,
    };
    return result;
  }

  inspect(): ProductSnapshot {
    return structuredClone(this.#snapshot);
  }

  mutateForTest(mutate: (snapshot: ProductSnapshot) => void): void {
    const next = structuredClone(this.#snapshot);
    mutate(next);
    this.#snapshot = next;
  }
}

function proposal(): ProjectBootstrapProposal {
  return {
    name: "AI 学习",
    objective: "学习公开课程、论文和开源项目，并形成自己的实践项目。",
    planeWorkspaceSlug: "learning",
    planeProjectIdentifier: "AI2026",
    workspaceRootId: "root_code",
    directoryName: "ai-learning",
    initializerProfile: "ai_learning",
    initialModules: ["公开课", "论文", "开源项目", "实践项目"],
  };
}

function fixture(options?: { readonly planeOutcomeUnknown?: boolean }) {
  const system = createSystemDirectAgentDefinition(NOW);
  const compiled = compileWorkflowRunSpec({
    workflowRunSpecId: RUN_SPEC,
    productRunId: RUN,
    createdAt: NOW,
    definition: {
      schemaVersion: "workflow-definition-revision-input.v1",
      workflowDefinitionRevisionId: system.revision.workflowDefinitionRevisionId,
      definitionRevision: system.revision.definitionRevision,
      blueprintKey: system.revision.blueprintKey,
      blueprintVersion: system.revision.blueprintVersion,
      semanticRoot: system.revision.semanticRoot,
      expectedSha256: system.revision.definitionSha256,
    },
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [
        {
          kind: "node_config",
          definitionNodeId: "direct.agent",
          field: "capabilityMode",
          value: "project_bootstrap",
        },
      ],
    },
    principal: { principalId: PRINCIPAL, capabilities: [] },
    availableResources: [],
    executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
    runner: {
      runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
      runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
    },
    businessInput: { kind: "direct_agent_message" },
  });
  if (!compiled.success) throw new Error(JSON.stringify(compiled.diagnostics));
  const snapshot = createEmptySnapshot(NOW);
  snapshot.entities.sessions[SESSION] = {
    schemaVersion: "product-session.v1",
    sessionId: SESSION as never,
    ownerPrincipalId: PRINCIPAL as never,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages[MESSAGE] = {
    schemaVersion: "message.v1",
    messageId: MESSAGE as never,
    sessionId: SESSION as never,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "创建AI学习项目" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.workflowDefinitions[system.definition.workflowDefinitionId] = system.definition;
  snapshot.entities.workflowDefinitionRevisions[system.revision.workflowDefinitionRevisionId] =
    system.revision;
  snapshot.entities.workflowViewDefinitions[system.view.workflowViewDefinitionId] = system.view;
  snapshot.entities.workflowRunSpecs[RUN_SPEC] = compiled.runSpec;
  snapshot.entities.runs[RUN] = {
    schemaVersion: "product-run.v3",
    runKind: "direct_agent",
    productRunId: RUN as never,
    sessionId: SESSION as never,
    sourceMessageId: MESSAGE as never,
    workflowViewDefinitionId: system.view.workflowViewDefinitionId,
    workflowRunSpecId: RUN_SPEC as never,
    runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
    runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
    status: "running",
    phase: "executing",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = new InMemoryProductStore(snapshot);
  const workspace = {
    listRoots: () => [{ rootId: "root_code" as never, displayName: "Code" }],
    preflight: vi.fn(async () => ({
      root: { rootId: "root_code" as never, displayName: "Code" },
      directoryName: "ai-learning",
      workspaceLabel: "Code/ai-learning",
    })),
    provision: vi.fn(async () => ({
      status: "completed" as const,
      workspaceLabel: "Code/ai-learning",
    })),
    reconcile: vi.fn(async () => ({
      status: "completed" as const,
      workspaceLabel: "Code/ai-learning",
    })),
  };
  const plane = {
    describe: () => ({
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1",
      providerWebBaseUrl: "http://127.0.0.1:8080",
      allowedWorkspaceSlugs: ["learning"],
    }),
    preflight: vi.fn(async () => ({ planeProjectLabel: "Learning/AI2026" })),
    provision: vi.fn(async () =>
      options?.planeOutcomeUnknown === true
        ? { status: "outcome_unknown" as const, errorCode: "plane_ce_write_outcome_unknown" }
        : { status: "completed" as const, planeProjectId: PLANE_PROJECT_ID as never },
    ),
    reconcile: vi.fn(async () => ({
      status: "completed" as const,
      planeProjectId: PLANE_PROJECT_ID as never,
    })),
  };
  const ids = {
    candidate: () => "pbc_candidate1" as never,
    decision: () => "pbd_decision1" as never,
    operation: () => "pbo_operation1" as never,
    binding: () => "pwb_binding1" as never,
  };
  const deps: ApplicationDeps = {
    store,
    now: () => NOW,
    ids: new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "outbox"
            ? () => `obx_bootstrap${String(store.inspect().storeRevision + 1)}`
            : () => "unused",
      },
    ) as ApplicationDeps["ids"],
    projectBootstrapIds: ids,
    projectBootstrapExecutionCoordinator: createInProcessProjectBootstrapExecutionCoordinator(),
    projectWorkspaceProvisioner: workspace,
    projectManagementBootstrap: plane,
  };
  return { deps, store, workspace, plane };
}

describe("受控Plane CE建项纵向", () => {
  it("只在显式确认后创建Workspace与Plane，并提交唯一稳定绑定", async () => {
    const f = fixture();
    const candidate = await prepareProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
      productRunId: RUN as never,
      commandId: "cmd_prepare1" as never,
      proposal: proposal(),
    });
    expect(candidate.status).toBe("prepared");
    expect(f.workspace.provision).not.toHaveBeenCalled();
    expect(f.plane.provision).not.toHaveBeenCalled();
    await expect(
      prepareProjectBootstrapCandidate(f.deps, {
        principalId: PRINCIPAL as never,
        productSessionId: SESSION as never,
        productRunId: RUN as never,
        commandId: "cmd_prepare_duplicate" as never,
        proposal: proposal(),
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const decided = await decideProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_decide1" as never,
      projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
      candidateRevision: candidate.revision,
      candidateSha256: candidate.sha256,
      kind: "confirm",
    });
    expect(decided.operation?.status).toBe("queued");
    const outbox = Object.values(f.store.inspect().outbox).find(
      (entry) => entry.kind === "project_bootstrap_execute",
    );
    expect(outbox).toMatchObject({ mode: "execute", status: "pending" });
    const completed = await executeProjectBootstrapOperationFromOutbox(f.deps, {
      commandId: "cmd_claim1" as never,
      executionInvocationId: "cmd_invoke1" as never,
      outboxId: outbox!.outboxId,
      projectBootstrapOperationId: decided.operation!.projectBootstrapOperationId,
      expectedOperationRevision: 1,
      mode: "execute",
      leaseDurationMs: 600_000,
    });
    expect(completed).toMatchObject({
      status: "ready",
      workspaceStep: "completed",
      planeStep: "completed",
      bindingStep: "completed",
      planeProjectId: PLANE_PROJECT_ID,
    });
    const bindings = Object.values(f.store.inspect().entities.projectWorkspaceBindings);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      productSessionId: SESSION,
      planeProjectIdentifier: "AI2026",
      workspaceRootId: "root_code",
      directoryName: "ai-learning",
    });
  });

  it("Provider配置移除后仍可拒绝已准备Candidate并退出一次性生命周期", async () => {
    const f = fixture();
    const candidate = await prepareProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
      productRunId: RUN as never,
      commandId: "cmd_prepare_reject_without_provider" as never,
      proposal: proposal(),
    });
    const disabledDeps = { ...f.deps };
    delete disabledDeps.projectWorkspaceProvisioner;
    delete disabledDeps.projectManagementBootstrap;

    const rejected = await decideProjectBootstrapCandidate(disabledDeps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_reject_without_provider" as never,
      projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
      candidateRevision: candidate.revision,
      candidateSha256: candidate.sha256,
      kind: "reject",
    });

    expect(rejected.candidate.status).toBe("rejected");
    expect(rejected.operation).toBeUndefined();
    const snapshot = f.store.inspect();
    expect(Object.values(snapshot.entities.projectBootstrapDecisions)).toEqual([
      expect.objectContaining({ kind: "reject" }),
    ]);
    expect(Object.values(snapshot.entities.projectBootstrapOperations)).toHaveLength(0);
    expect(Object.values(snapshot.outbox)).toHaveLength(0);
    expect(f.workspace.provision).not.toHaveBeenCalled();
    expect(f.plane.provision).not.toHaveBeenCalled();
  });

  it("Candidate Receipt在现有Candidate和Provider移除前完成前置重放", async () => {
    const f = fixture();
    const command = {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
      productRunId: RUN as never,
      commandId: "cmd_prepare_receipt_replay" as never,
      proposal: proposal(),
    };
    const prepared = await prepareProjectBootstrapCandidate(f.deps, command);
    const disabledDeps = { ...f.deps };
    delete disabledDeps.projectWorkspaceProvisioner;
    delete disabledDeps.projectManagementBootstrap;

    const replayed = await prepareProjectBootstrapCandidate(disabledDeps, command);
    const runtimeReplayed = await prepareProjectBootstrapCandidateForRuntime(disabledDeps, {
      productRunId: command.productRunId,
      commandId: command.commandId,
      proposal: command.proposal,
    });

    expect(replayed.projectBootstrapCandidateId).toBe(prepared.projectBootstrapCandidateId);
    expect(runtimeReplayed.projectBootstrapCandidateId).toBe(prepared.projectBootstrapCandidateId);
    expect(f.workspace.preflight).toHaveBeenCalledTimes(1);
    expect(f.plane.preflight).toHaveBeenCalledTimes(1);
    expect(Object.values(f.store.inspect().entities.projectBootstrapCandidates)).toHaveLength(1);
  });

  it("确认Receipt重放不依赖随后仍存在的Provider配置", async () => {
    const f = fixture();
    const candidate = await prepareProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
      productRunId: RUN as never,
      commandId: "cmd_prepare_confirm_replay" as never,
      proposal: proposal(),
    });
    const command = {
      principalId: PRINCIPAL as never,
      commandId: "cmd_confirm_provider_replay" as never,
      projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
      candidateRevision: candidate.revision,
      candidateSha256: candidate.sha256,
      kind: "confirm" as const,
    };
    const confirmed = await decideProjectBootstrapCandidate(f.deps, command);
    const disabledDeps = { ...f.deps };
    delete disabledDeps.projectWorkspaceProvisioner;
    delete disabledDeps.projectManagementBootstrap;

    const replayed = await decideProjectBootstrapCandidate(disabledDeps, command);
    expect(replayed.operation?.projectBootstrapOperationId).toBe(
      confirmed.operation?.projectBootstrapOperationId,
    );
    expect(Object.values(f.store.inspect().entities.projectBootstrapOperations)).toHaveLength(1);
    expect(Object.values(f.store.inspect().outbox)).toHaveLength(1);
  });

  it("Plane写入断线不会产生假ready或绑定，而是保留可对账操作", async () => {
    const f = fixture({ planeOutcomeUnknown: true });
    const candidate = await prepareProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
      productRunId: RUN as never,
      commandId: "cmd_prepare2" as never,
      proposal: proposal(),
    });
    const decided = await decideProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_decide2" as never,
      projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
      candidateRevision: candidate.revision,
      candidateSha256: candidate.sha256,
      kind: "confirm",
    });
    const executeOutbox = Object.values(f.store.inspect().outbox).find(
      (entry) => entry.kind === "project_bootstrap_execute",
    );
    const result = await executeProjectBootstrapOperationFromOutbox(f.deps, {
      commandId: "cmd_claim2" as never,
      executionInvocationId: "cmd_invoke2" as never,
      outboxId: executeOutbox!.outboxId,
      projectBootstrapOperationId: decided.operation!.projectBootstrapOperationId,
      expectedOperationRevision: 1,
      mode: "execute",
      leaseDurationMs: 600_000,
    });
    expect(result).toMatchObject({
      status: "outcome_unknown",
      workspaceStep: "completed",
      planeStep: "outcome_unknown",
      bindingStep: "pending",
      errorCode: "plane_ce_write_outcome_unknown",
    });
    expect(Object.values(f.store.inspect().entities.projectWorkspaceBindings)).toHaveLength(0);

    const activeProjection = await getCurrentProjectBootstrapForSession(f.deps, {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
    });
    if (activeProjection === null) throw new Error("结果未知Operation缺少建项投影");
    expect(activeProjection.recovery).toEqual({
      canRecover: false,
      reason: "background_dispatch_pending",
    });
    await requestProjectBootstrapOperationRetry(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_retry_while_execute_outbox_active" as never,
      projectBootstrapOperationId: result.projectBootstrapOperationId,
      expectedOperationRevision: result.revision,
    });
    expect(
      Object.values(f.store.inspect().outbox).filter(
        (entry) =>
          entry.kind === "project_bootstrap_execute" &&
          ["pending", "dispatched", "outcome_unknown"].includes(entry.status),
      ),
    ).toEqual([expect.objectContaining({ mode: "execute" })]);
    f.store.mutateForTest((snapshot) => {
      const execute = Object.values(snapshot.outbox).find(
        (entry) => entry.kind === "project_bootstrap_execute",
      );
      if (execute === undefined) throw new Error("结果未知Operation缺少execute Outbox");
      execute.status = "acknowledged";
    });

    const retry = await requestProjectBootstrapOperationRetry(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_retry2" as never,
      projectBootstrapOperationId: result.projectBootstrapOperationId,
      expectedOperationRevision: result.revision,
    });
    const disabledDeps = { ...f.deps };
    delete disabledDeps.projectWorkspaceProvisioner;
    delete disabledDeps.projectManagementBootstrap;
    const replayedRetry = await requestProjectBootstrapOperationRetry(disabledDeps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_retry2" as never,
      projectBootstrapOperationId: result.projectBootstrapOperationId,
      expectedOperationRevision: result.revision,
    });
    expect(replayedRetry.projectBootstrapOperationId).toBe(retry.projectBootstrapOperationId);
    const retryOutbox = Object.values(f.store.inspect().outbox)
      .filter(
        (entry) =>
          entry.kind === "project_bootstrap_execute" &&
          entry.projectBootstrapOperationId === result.projectBootstrapOperationId,
      )
      .at(-1);
    expect(retryOutbox).toMatchObject({ mode: "reconcile" });
    const reconciled = await executeProjectBootstrapOperationFromOutbox(f.deps, {
      commandId: "cmd_claim_retry2" as never,
      executionInvocationId: "cmd_invoke_retry2" as never,
      outboxId: retryOutbox!.outboxId,
      projectBootstrapOperationId: retry.projectBootstrapOperationId,
      expectedOperationRevision: retry.revision,
      mode: "reconcile",
      leaseDurationMs: 600_000,
    });
    expect(reconciled.status).toBe("ready");
    expect(f.workspace.provision).toHaveBeenCalledTimes(1);
    expect(f.plane.provision).toHaveBeenCalledTimes(1);
    expect(f.workspace.reconcile).toHaveBeenCalledTimes(1);
    expect(f.plane.reconcile).toHaveBeenCalledTimes(1);
  });

  for (const legacyStatus of ["queued", "dispatching"] as const) {
    it(`v18 ${legacyStatus} Operation只能由用户显式触发对账恢复`, async () => {
      const f = fixture();
      const candidate = await prepareProjectBootstrapCandidate(f.deps, {
        principalId: PRINCIPAL as never,
        productSessionId: SESSION as never,
        productRunId: RUN as never,
        commandId: `cmd_prepare_legacy_${legacyStatus}` as never,
        proposal: proposal(),
      });
      const decided = await decideProjectBootstrapCandidate(f.deps, {
        principalId: PRINCIPAL as never,
        commandId: `cmd_decide_legacy_${legacyStatus}` as never,
        projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
        candidateRevision: candidate.revision,
        candidateSha256: candidate.sha256,
        kind: "confirm",
      });
      const operationId = decided.operation!.projectBootstrapOperationId;
      f.store.mutateForTest((snapshot) => {
        snapshot.outbox = {};
        if (legacyStatus === "dispatching") {
          const operation = snapshot.entities.projectBootstrapOperations[operationId]!;
          snapshot.entities.projectBootstrapOperations[operationId] = {
            ...operation,
            status: "dispatching",
            revision: operation.revision + 1,
          };
          const currentCandidate =
            snapshot.entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId]!;
          snapshot.entities.projectBootstrapCandidates[operation.projectBootstrapCandidateId] = {
            ...currentCandidate,
            status: "executing",
            revision: currentCandidate.revision + 1,
          };
        }
      });

      const legacyOperation = f.store.inspect().entities.projectBootstrapOperations[operationId]!;
      const projection = await getCurrentProjectBootstrapForSession(f.deps, {
        principalId: PRINCIPAL as never,
        productSessionId: SESSION as never,
      });
      if (projection === null) throw new Error("遗留Operation缺少建项投影");
      expect(projection.recovery).toEqual({
        canRecover: true,
        reason: "legacy_dispatch_missing",
      });
      const requested = await requestProjectBootstrapOperationRetry(f.deps, {
        principalId: PRINCIPAL as never,
        commandId: `cmd_recover_legacy_${legacyStatus}` as never,
        projectBootstrapOperationId: operationId,
        expectedOperationRevision: legacyOperation.revision,
      });
      const recoveryOutbox = Object.values(f.store.inspect().outbox).find(
        (entry) => entry.kind === "project_bootstrap_execute",
      );
      expect(recoveryOutbox).toMatchObject({ mode: "reconcile", status: "pending" });

      const recovered = await executeProjectBootstrapOperationFromOutbox(f.deps, {
        commandId: `cmd_claim_legacy_${legacyStatus}` as never,
        executionInvocationId: `cmd_invoke_legacy_${legacyStatus}` as never,
        outboxId: recoveryOutbox!.outboxId,
        projectBootstrapOperationId: requested.projectBootstrapOperationId,
        expectedOperationRevision: requested.revision,
        mode: "reconcile",
        leaseDurationMs: 600_000,
      });
      expect(recovered.status).toBe("ready");
      expect(f.workspace.reconcile).toHaveBeenCalledTimes(1);
      expect(f.plane.reconcile).toHaveBeenCalledTimes(1);
      expect(f.workspace.provision).not.toHaveBeenCalled();
      expect(f.plane.provision).not.toHaveBeenCalled();
    });
  }

  it("其他Principal不能读取、决定或重试会话内建项事实", async () => {
    const f = fixture();
    const candidate = await prepareProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      productSessionId: SESSION as never,
      productRunId: RUN as never,
      commandId: "cmd_prepare_idor" as never,
      proposal: proposal(),
    });
    const otherPrincipal = "usr_other" as never;

    await expect(
      getCurrentProjectBootstrapForSession(f.deps, {
        principalId: otherPrincipal,
        productSessionId: SESSION as never,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      decideProjectBootstrapCandidate(f.deps, {
        principalId: otherPrincipal,
        commandId: "cmd_decide_idor" as never,
        projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
        candidateRevision: candidate.revision,
        candidateSha256: candidate.sha256,
        kind: "confirm",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const decided = await decideProjectBootstrapCandidate(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_decide_owner" as never,
      projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
      candidateRevision: candidate.revision,
      candidateSha256: candidate.sha256,
      kind: "confirm",
    });
    await expect(
      requestProjectBootstrapOperationRetry(f.deps, {
        principalId: otherPrincipal,
        commandId: "cmd_retry_idor" as never,
        projectBootstrapOperationId: decided.operation!.projectBootstrapOperationId,
        expectedOperationRevision: decided.operation!.revision,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
