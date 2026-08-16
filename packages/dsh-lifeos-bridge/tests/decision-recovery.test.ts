import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableCommandId } from "../src/adapter.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import type { ChatApproval, ChatRun } from "../src/contracts.ts";
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
        productRunId: run.productRunId,
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
