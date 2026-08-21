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
  executeProjectBootstrapOperation,
  prepareProjectBootstrapCandidate,
} from "./project-bootstrap-use-cases.js";
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
  readonly #receipts = new Map<
    string,
    { readonly requestSha256: string; readonly result: ProductTransactionResult }
  >();

  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  async read() {
    return { snapshot: structuredClone(this.#snapshot) };
  }

  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const prior = this.#receipts.get(transaction.commandId);
    if (prior !== undefined) {
      if (prior.requestSha256 !== transaction.requestSha256) throw new Error("command reused");
      return { ...prior.result, replayed: true };
    }
    const draft = structuredClone(this.#snapshot);
    const mutation = transaction.mutate(draft);
    draft.storeRevision += 1;
    draft.committedAt = NOW;
    this.#snapshot = draft;
    const result = {
      storeRevision: draft.storeRevision,
      resultRefs: mutation.resultRefs,
      replayed: false,
    };
    this.#receipts.set(transaction.commandId, { requestSha256: transaction.requestSha256, result });
    return result;
  }

  inspect(): ProductSnapshot {
    return structuredClone(this.#snapshot);
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
    ids: new Proxy({}, { get: () => () => "unused" }) as ApplicationDeps["ids"],
    projectBootstrapIds: ids,
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
    const completed = await executeProjectBootstrapOperation(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_execute1" as never,
      projectBootstrapOperationId: decided.operation!.projectBootstrapOperationId,
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
    const result = await executeProjectBootstrapOperation(f.deps, {
      principalId: PRINCIPAL as never,
      commandId: "cmd_execute2" as never,
      projectBootstrapOperationId: decided.operation!.projectBootstrapOperationId,
    });
    expect(result).toMatchObject({
      status: "outcome_unknown",
      workspaceStep: "completed",
      planeStep: "outcome_unknown",
      bindingStep: "pending",
      errorCode: "plane_ce_write_outcome_unknown",
    });
    expect(Object.values(f.store.inspect().entities.projectWorkspaceBindings)).toHaveLength(0);
  });
});
