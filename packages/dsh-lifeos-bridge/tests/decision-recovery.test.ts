import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableCommandId } from "../src/adapter.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import type { ChatApproval, ChatNoteCandidate, ChatRun } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const dshSessionId = "dsh-decision-recovery";
const requestKey = "request-key";
const run = {
  productRunId: "run_recovery1",
  revision: 4,
  allowedActions: ["request_revision", "approve", "reject"],
} as ChatRun;
const approval = {
  approvalRequestId: "apr_recovery1",
  productRunId: run.productRunId,
  planId: "pln_recovery1",
  planRevision: 2,
  planSha256: "a".repeat(64),
  status: "open",
} as ChatApproval;
const binding = {
  productRunId: run.productRunId,
  runRevision: run.revision,
  approvalRequestId: approval.approvalRequestId,
  planId: approval.planId,
  planRevision: approval.planRevision,
  planSha256: approval.planSha256,
};
const noteRun = {
  ...run,
  productRunId: "run_noterecovery1",
  status: "waiting_human",
  phase: "note_review",
  revision: 2,
} as ChatRun;
const noteCandidate = {
  schemaVersion: "chat-note-api.v1",
  noteCandidateId: "ntc_recovery1",
  productRunId: noteRun.productRunId,
  candidateSequence: 1,
  proposed: {
    title: "候选笔记",
    kind: "general",
    contentMarkdown: "需要人工确认的正文。",
    tags: [{ key: "review", label: "审核" }],
  },
  sourceRefs: [
    {
      kind: "full_message",
      sourceMessageId: "msg_recovery1",
      sourceMessageSha256: "c".repeat(64),
    },
  ],
  sha256: "d".repeat(64),
  revision: 1,
  status: "under_review",
  allowedActions: ["confirm", "request_revision", "reject"],
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
} as ChatNoteCandidate;
const noteBinding = {
  productRunId: noteRun.productRunId,
  runRevision: noteRun.revision,
  noteCandidateId: noteCandidate.noteCandidateId,
  candidateRevision: noteCandidate.revision,
  candidateSha256: noteCandidate.sha256,
};

const toolRun = {
  ...run,
  productRunId: "run_toolrecovery1",
  status: "waiting_human",
  phase: "tool_review",
  revision: 7,
  allowedActions: [],
} as unknown as ChatRun;
const toolCapability = {
  ref: {
    capabilityId: "pi_direct:tool:builtin:write",
    descriptorSha256: "1".repeat(64),
    inputSchemaSha256: "2".repeat(64),
    resolvedImplementationSha256: "3".repeat(64),
    scopeRef: { kind: "workspace" as const, rootId: "root_chat" },
  },
  localName: "write",
  kind: "executable_tool" as const,
  runtimeOwner: "pi_direct" as const,
  sourceRef: {
    sourceKind: "builtin" as const,
    package: "@earendil-works/pi-coding-agent",
    revision: "4".repeat(40),
  },
  effect: "local_write" as const,
  scopePolicy: "workspace_required" as const,
  approvalPolicy: "product_decision_required" as const,
  evidencePolicy: "product_intent_result" as const,
};
const toolIntent = {
  schemaVersion: "chat-product-api.v1" as const,
  toolExecutionIntentId: "tei_toolrecovery1" as never,
  productRunId: toolRun.productRunId,
  capability: toolCapability,
  toolCallId: "call_toolrecovery1",
  inputDisplay: '{"path":"README.md"}',
  inputDisplayTruncated: false,
  inputSha256: "5".repeat(64),
  scopeRef: toolCapability.ref.scopeRef,
  effect: "local_write" as const,
  status: "waiting_decision" as const,
  revision: 1,
  allowedActions: ["approve", "reject"] as const,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};
const toolBinding = {
  productRunId: toolRun.productRunId,
  runRevision: toolRun.revision,
  toolExecutionIntentId: toolIntent.toolExecutionIntentId,
  intentRevision: toolIntent.revision,
  capabilityDescriptorSha256: toolCapability.ref.descriptorSha256,
  inputSha256: toolIntent.inputSha256,
  scopeRef: toolIntent.scopeRef,
};

async function seededStore(path: string): Promise<AtomicBridgeStateStore> {
  const state = new AtomicBridgeStateStore(path);
  await state.ready();
  await state.mutateSession(
    dshSessionId,
    stableCommandId("create-session", dshSessionId),
    (binding) => {
      binding.chatSessionId = "psn_recovery1";
      binding.currentRequestKey = requestKey;
      binding.requests[requestKey] = {
        userTextSha256: "b".repeat(64),
        messageCommandId: stableCommandId("message", dshSessionId),
        submissionTarget: "existing_session",
        submissionStatus: "bound",
        productRunId: run.productRunId,
      };
    },
  );
  return state;
}

async function seededNoteStore(path: string): Promise<AtomicBridgeStateStore> {
  const state = new AtomicBridgeStateStore(path);
  await state.ready();
  await state.mutateSession(
    dshSessionId,
    stableCommandId("create-session", dshSessionId),
    (binding) => {
      binding.chatSessionId = "psn_recovery1";
      binding.currentRequestKey = requestKey;
      binding.requests[requestKey] = {
        userTextSha256: "b".repeat(64),
        messageCommandId: stableCommandId("message", dshSessionId),
        submissionTarget: "existing_session",
        submissionStatus: "bound",
        productRunId: noteRun.productRunId,
      };
    },
  );
  return state;
}

async function seededToolStore(path: string): Promise<AtomicBridgeStateStore> {
  const state = new AtomicBridgeStateStore(path);
  await state.ready();
  await state.mutateSession(
    dshSessionId,
    stableCommandId("create-session", dshSessionId),
    (binding) => {
      binding.chatSessionId = "psn_recovery1";
      binding.currentRequestKey = requestKey;
      binding.requests[requestKey] = {
        userTextSha256: "b".repeat(64),
        messageCommandId: stableCommandId("message", dshSessionId),
        submissionTarget: "existing_session",
        submissionStatus: "bound",
        productRunId: toolRun.productRunId,
      };
    },
  );
  return state;
}

function rejectingChat(error: ChatProductApiError): ChatProductClient {
  return {
    getRun: async () => run,
    getApproval: async () => approval,
    submitDecision: async () => {
      throw error;
    },
  } as unknown as ChatProductClient;
}

test("a definite non-retryable Chat 4xx clears the pending decision binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-decision-4xx-"));
  try {
    const state = await seededStore(join(directory, "state.json"));
    const service = new LifeosBridgeService(
      rejectingChat(
        new ChatProductApiError(
          409,
          "revision_conflict",
          false,
          "refresh_run",
          "Run revision changed",
        ),
      ),
      state,
    );
    await assert.rejects(service.decide(dshSessionId, { kind: "approve", binding }), {
      name: "ChatProductApiError",
    });
    assert.equal(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingDecision,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a retryable or transport failure keeps the exact normalized decision for verbatim retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-decision-unknown-"));
  try {
    const state = await seededStore(join(directory, "state.json"));
    const service = new LifeosBridgeService(
      rejectingChat(
        new ChatProductApiError(
          503,
          "chat_api_unreachable",
          true,
          "retry_same_command",
          "Chat API is unreachable",
        ),
      ),
      state,
    );
    await assert.rejects(
      service.decide(dshSessionId, {
        kind: "request_revision",
        explanation: "  保留这段修订要求  ",
        binding,
      }),
      { name: "ChatProductApiError" },
    );
    assert.deepEqual(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingDecision?.request,
      { kind: "request_revision", explanation: "保留这段修订要求", binding },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Tool pending binds the full A identity; 5xx/damaged 2xx preserve bytes, B cannot replay it, exact 4xx clears it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-tool-decision-recovery-"));
  const requestA = { kind: "approve" as const, binding: toolBinding };
  const requestB = {
    kind: "approve" as const,
    binding: { ...toolBinding, toolExecutionIntentId: "tei_toolrecovery2" as never },
  };
  let submissions = 0;
  try {
    const state = await seededToolStore(join(directory, "state.json"));
    const base = {
      getRun: async () => toolRun,
      getToolExecutions: async () => ({ intents: [toolIntent], decisions: [], results: [] }),
    };
    const retryable = new LifeosBridgeService(
      {
        ...base,
        submitToolExecutionDecision: async () => {
          submissions += 1;
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "transport/5xx",
          );
        },
      } as unknown as ChatProductClient,
      state,
    );
    await assert.rejects(retryable.decideToolExecution(dshSessionId, requestA), {
      name: "ChatProductApiError",
    });
    const pendingA = (await state.readSession(dshSessionId))?.requests[requestKey]
      ?.pendingToolExecutionDecision;
    assert.ok(pendingA);
    assert.deepEqual(pendingA.request, requestA);
    assert.deepEqual(pendingA.capability, toolCapability);
    const frozenBytes = JSON.stringify(pendingA);

    await assert.rejects(retryable.decideToolExecution(dshSessionId, requestB), (error) => {
      return (
        error instanceof Error &&
        "code" in error &&
        error.code === "lifeos_tool_decision_outcome_unknown"
      );
    });
    assert.equal(submissions, 1);
    assert.equal(
      JSON.stringify(
        (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingToolExecutionDecision,
      ),
      frozenBytes,
    );

    const damaged2xx = new LifeosBridgeService(
      {
        ...base,
        submitToolExecutionDecision: async () => {
          submissions += 1;
          throw new Error("lifeos_tool_decision_response_binding_mismatch");
        },
      } as unknown as ChatProductClient,
      state,
    );
    await assert.rejects(damaged2xx.decideToolExecution(dshSessionId, requestA), {
      message: "lifeos_tool_decision_response_binding_mismatch",
    });
    assert.equal(
      JSON.stringify(
        (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingToolExecutionDecision,
      ),
      frozenBytes,
    );

    const stableReplay = new LifeosBridgeService(
      {
        ...base,
        submitToolExecutionDecision: async () => {
          submissions += 1;
        },
      } as unknown as ChatProductClient,
      state,
    );
    await stableReplay.decideToolExecution(dshSessionId, requestA);
    assert.equal(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingToolExecutionDecision,
      undefined,
    );

    await assert.rejects(retryable.decideToolExecution(dshSessionId, requestA), {
      name: "ChatProductApiError",
    });

    const deterministic4xx = new LifeosBridgeService(
      {
        ...base,
        submitToolExecutionDecision: async () => {
          submissions += 1;
          throw new ChatProductApiError(
            409,
            "revision_conflict",
            false,
            "refresh_run",
            "deterministic 4xx",
          );
        },
      } as unknown as ChatProductClient,
      state,
    );
    await assert.rejects(deterministic4xx.decideToolExecution(dshSessionId, requestA), {
      name: "ChatProductApiError",
    });
    assert.equal(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingToolExecutionDecision,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale observed binding cannot approve a newer unseen Run revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-decision-stale-"));
  let submissions = 0;
  try {
    const state = await seededStore(join(directory, "state.json"));
    const chat = {
      getRun: async () => ({ ...run, revision: run.revision + 1 }),
      getApproval: async () => approval,
      submitDecision: async () => {
        submissions += 1;
        return run;
      },
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state);
    await assert.rejects(
      service.decide(dshSessionId, { kind: "approve", binding }),
      (error) =>
        error instanceof Error && "code" in error && error.code === "lifeos_decision_stale",
    );
    assert.equal(submissions, 0);
    assert.equal(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingDecision,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an executing Direct Run never falls through to Planning queries after prompt approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-direct-projection-"));
  let planningQueries = 0;
  try {
    const state = await seededStore(join(directory, "state.json"));
    const directRun = {
      ...run,
      runKind: "direct_agent",
      status: "running",
      phase: "executing",
      currentPlan: undefined,
      currentApprovalRequestId: undefined,
      allowedActions: [],
    } as ChatRun;
    const chat = {
      getRun: async () => directRun,
      getPlans: async () => {
        planningQueries += 1;
        throw new Error("Direct Run must not query Plans");
      },
      getApproval: async () => {
        planningQueries += 1;
        throw new Error("Direct Run must not query Approval");
      },
    } as unknown as ChatProductClient;

    const projection = await new LifeosBridgeService(chat, state).projection(dshSessionId);
    assert.equal(projection.run?.phase, "executing");
    assert.equal(projection.plan, null);
    assert.equal(projection.approval, null);
    assert.equal(planningQueries, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a retryable Note failure keeps the normalized candidate decision for verbatim retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-note-decision-unknown-"));
  try {
    const state = await seededNoteStore(join(directory, "state.json"));
    const chat = {
      getRun: async () => noteRun,
      getNoteCandidate: async () => noteCandidate,
      submitNoteDecision: async () => {
        throw new ChatProductApiError(
          503,
          "chat_api_unreachable",
          true,
          "retry_same_command",
          "Chat API is unreachable",
        );
      },
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state);
    await assert.rejects(
      service.decideNote(dshSessionId, {
        kind: "request_revision",
        explanation: "  补充来源边界  ",
        binding: noteBinding,
      }),
      { name: "ChatProductApiError" },
    );
    assert.deepEqual(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingNoteDecision?.request,
      {
        kind: "request_revision",
        explanation: "补充来源边界",
        binding: noteBinding,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale observed candidate cannot confirm a newer unseen Note revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-note-decision-stale-"));
  let submissions = 0;
  try {
    const state = await seededNoteStore(join(directory, "state.json"));
    const chat = {
      getRun: async () => noteRun,
      getNoteCandidate: async () => ({ ...noteCandidate, revision: 2 }),
      submitNoteDecision: async () => {
        submissions += 1;
        return noteCandidate;
      },
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state);
    await assert.rejects(
      service.decideNote(dshSessionId, { kind: "confirm", binding: noteBinding }),
      (error) =>
        error instanceof Error && "code" in error && error.code === "lifeos_note_decision_stale",
    );
    assert.equal(submissions, 0);
    assert.equal(
      (await state.readSession(dshSessionId))?.requests[requestKey]?.pendingNoteDecision,
      undefined,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
