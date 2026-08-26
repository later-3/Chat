import { describe, expect, it } from "vitest";
import { createEmptySnapshot, type CommandId, type ProductSnapshot } from "@chat/contracts";
import { computeMemoryAgentOperationInputSha256 } from "@chat/domain";
import type { ApplicationDeps, IdFactory } from "./deps.js";
import type {
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
} from "./product-store-port.js";
import {
  beginMemoryAgentOperation,
  completeMemoryAgentOperation,
  markMemoryAgentOperationOutcomeUnknown,
} from "./memory-agent-operation-use-cases.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";
import { compileWorkflowRunSpec } from "./workflow-run-spec-compiler.js";
import {
  createSystemMemoryAgentDirectDefinition,
  MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
} from "./workflow-system-definitions.js";

const NOW = "2026-08-24T12:00:00.000Z";

class Store implements ProductStorePort {
  #snapshot: ProductSnapshot;
  readonly #receipts = new Map<
    string,
    { readonly requestSha256: string; readonly result: ProductTransactionResult }
  >();
  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = snapshot;
  }
  async read() {
    return { snapshot: structuredClone(this.#snapshot) };
  }
  async transact(tx: ProductTransaction): Promise<ProductTransactionResult> {
    const previous = this.#receipts.get(tx.commandId);
    if (previous !== undefined) {
      if (previous.requestSha256 !== tx.requestSha256) throw new Error("command reuse");
      return { ...previous.result, replayed: true };
    }
    const draft = structuredClone(this.#snapshot);
    const mutation = tx.mutate(draft);
    draft.storeRevision += 1;
    const result = {
      storeRevision: draft.storeRevision,
      resultRefs: { ...mutation.resultRefs },
      replayed: false,
    };
    this.#snapshot = draft;
    this.#receipts.set(tx.commandId, { requestSha256: tx.requestSha256, result });
    return result;
  }
}

function fixture() {
  const system = createSystemMemoryAgentDirectDefinition(NOW);
  const compiled = compileWorkflowRunSpec({
    workflowRunSpecId: "wrs_operation1" as never,
    productRunId: "run_operation1" as never,
    createdAt: NOW,
    definition: {
      schemaVersion: "workflow-definition-revision-input.v3",
      workflowDefinitionRevisionId: system.revision.workflowDefinitionRevisionId,
      definitionRevision: system.revision.definitionRevision,
      blueprintKey: "direct",
      blueprintVersion: 3,
      semanticRoot: system.revision.semanticRoot,
      expectedSha256: system.revision.definitionSha256,
    },
    runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    principal: { principalId: "usr_operation1" as never, capabilities: [] },
    availableResources: [],
    executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
    runner: {
      runnerFamily: MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
      runnerBundleVersion: MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
    },
    businessInput: { kind: "direct_agent_message" },
  });
  if (!compiled.success) throw new Error("fixture runspec failed");
  const snapshot = createEmptySnapshot(NOW);
  const sessionId = "psn_operation1" as never,
    messageId = "msg_operation1" as never,
    runId = "run_operation1" as never;
  snapshot.entities.sessions[sessionId] = {
    schemaVersion: "product-session.v1",
    sessionId,
    ownerPrincipalId: "usr_operation1" as never,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages[messageId] = {
    schemaVersion: "message.v1",
    messageId,
    sessionId,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "检索历史偏好" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.workflowRunSpecs[compiled.runSpec.workflowRunSpecId] = compiled.runSpec;
  snapshot.entities.runs[runId] = {
    schemaVersion: "product-run.v3",
    runKind: "direct_agent",
    productRunId: runId,
    sessionId,
    sourceMessageId: messageId,
    workflowViewDefinitionId: system.view.workflowViewDefinitionId,
    workflowRunSpecId: compiled.runSpec.workflowRunSpecId,
    runnerFamily: MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
    runnerBundleVersion: MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
    status: "running",
    phase: "executing",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = new Store(snapshot);
  const deps = { store, now: () => NOW, ids: {} as IdFactory } as ApplicationDeps;
  const input = {
    productRunId: runId,
    workflowRunSpecId: compiled.runSpec.workflowRunSpecId,
    definitionNodeId: "memory-agent.retrieve",
    operationKind: "retrieval" as const,
    sourceSha256: "a".repeat(64) as never,
  };
  return { deps, input: { ...input, inputSha256: computeMemoryAgentOperationInputSha256(input) } };
}
const command = (suffix: string) => `cmd_operation${suffix}` as CommandId;

describe("Memory Agent Operation耐久栅栏", () => {
  it("首派发、恢复、未知、完成复用与漂移拒绝", async () => {
    const f = fixture();
    const first = await beginMemoryAgentOperation(f.deps, { commandId: command("1"), ...f.input });
    expect(first).toMatchObject({
      status: "dispatch_required",
      operation: { status: "dispatching", revision: 1 },
    });
    const recovery = await beginMemoryAgentOperation(f.deps, {
      commandId: command("2"),
      ...f.input,
    });
    expect(recovery.status).toBe("recovery_required");
    const unknown = await markMemoryAgentOperationOutcomeUnknown(f.deps, {
      commandId: command("3"),
      memoryAgentOperationId: first.operation.memoryAgentOperationId,
      expectedRevision: 1,
      inputSha256: f.input.inputSha256,
      errorCode: "memory_agent.provider_unknown",
      providerRequestCount: 1,
    });
    expect(unknown.operation.status).toBe("outcome_unknown");
    expect(
      (await beginMemoryAgentOperation(f.deps, { commandId: command("4"), ...f.input })).status,
    ).toBe("outcome_unknown");
    await expect(
      beginMemoryAgentOperation(f.deps, {
        commandId: command("5"),
        ...f.input,
        sourceSha256: "b".repeat(64) as never,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const completedFixture = fixture();
    const begun = await beginMemoryAgentOperation(completedFixture.deps, {
      commandId: command("6"),
      ...completedFixture.input,
    });
    const completed = await completeMemoryAgentOperation(completedFixture.deps, {
      commandId: command("7"),
      memoryAgentOperationId: begun.operation.memoryAgentOperationId,
      expectedRevision: 1,
      inputSha256: completedFixture.input.inputSha256,
      outcome: {
        kind: "succeeded",
        result: { kind: "retrieval", externalQueryId: "q1", hitCount: 0, sections: [] },
        providerRequestCount: 1,
      },
    });
    expect(completed.operation.status).toBe("succeeded");
    expect(
      (
        await beginMemoryAgentOperation(completedFixture.deps, {
          commandId: command("8"),
          ...completedFixture.input,
        })
      ).operation,
    ).toEqual(completed.operation);
    const wrong = fixture();
    const wrongBegun = await beginMemoryAgentOperation(wrong.deps, {
      commandId: command("9"),
      ...wrong.input,
    });
    await expect(
      completeMemoryAgentOperation(wrong.deps, {
        commandId: command("a"),
        memoryAgentOperationId: wrongBegun.operation.memoryAgentOperationId,
        expectedRevision: 1,
        inputSha256: wrong.input.inputSha256,
        outcome: {
          kind: "succeeded",
          result: { kind: "write", proposal: { items: [] } },
          providerRequestCount: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("并发首次begin只有一个调用方获得派发权", async () => {
    const f = fixture();
    const [left, right] = await Promise.all([
      beginMemoryAgentOperation(f.deps, { commandId: command("b"), ...f.input }),
      beginMemoryAgentOperation(f.deps, { commandId: command("c"), ...f.input }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["dispatch_required", "recovery_required"]);
    expect(left.operation.memoryAgentOperationId).toBe(right.operation.memoryAgentOperationId);
  });
});
