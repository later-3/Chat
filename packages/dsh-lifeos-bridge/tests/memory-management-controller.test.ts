import assert from "node:assert/strict";
import test from "node:test";
import { MemoryManagementController } from "../src/client/memory-management-controller.ts";

const SHA = "a".repeat(64);
const NOW = "2026-08-24T09:00:00.000Z";

const pendingCandidate = {
  schemaVersion: "memory-agent-write-candidate.v1",
  memoryAgentWriteCandidateId: "mwc_1",
  memoryAgentOperationId: "mao_1",
  operationResultSha256: SHA,
  productRunId: "run_1",
  productSessionId: "psn_1",
  providerId: "mbk_1",
  evidenceSha256: SHA,
  evidenceManifest: [{ kind: "message", messageId: "msg_1", messageSha256: SHA, role: "user" }],
  status: "pending_review",
  items: [
    {
      itemKey: "item-1",
      title: "发布前检查",
      category: "procedure",
      content: "发布前执行合同测试。",
      labels: ["release"],
      evidenceRefs: [{ kind: "message", messageId: "msg_1", messageSha256: SHA, role: "user" }],
      sha256: SHA,
    },
  ],
  sha256: SHA,
  revision: 1,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

const approvedCandidate = {
  ...pendingCandidate,
  status: "approved" as const,
  decisionId: "mwd_1",
  memoryWriteIntentIds: ["mwi_1"],
};

const provider = {
  schemaVersion: "memory-provider-descriptor.v1",
  providerId: "mbk_1",
  displayName: "Memory Test",
  providerKind: "memmy",
  transport: "http",
  adapterContractVersion: "memmy-http-import.v1",
  configured: true,
  configurationFingerprint: SHA,
  authMode: "none",
  credentialRevision: "none",
  capabilities: {
    query: { maxResults: 20, maxContextCharacters: 50_000 },
    write: {
      maxContentCharacters: 50_000,
      materialization: "synchronous",
      idempotency: "provider_key",
    },
    reconcile: true,
    management: { list: false, get: false, update: false, delete: false, history: false },
  },
} as const;

const preview = {
  schemaVersion: "memory-session-import-preview.v1",
  source: { kind: "chat", productSessionId: "psn_1" },
  sourceTitle: "导入测试会话",
  sourceUpdatedAt: NOW,
  sourceSnapshotSha256: SHA,
  conversionVersion: "conversation-turns.v1",
  previewSha256: "b".repeat(64),
  providerId: "mbk_1",
  providerDisplayName: "Memory Test",
  items: [
    {
      sourceItemKey: "turn-1",
      sourceItemSha256: SHA,
      title: "发布前检查",
      contentPreview: "发布前执行合同测试。",
      contentCharacters: 10,
      alreadyImported: false,
    },
  ],
  newItemCount: 1,
  existingItemCount: 0,
} as const;

const imported = {
  memorySessionImportId: "msi_1",
  source: preview.source,
  sourceTitle: preview.sourceTitle,
  sourceUpdatedAt: NOW,
  sourceSnapshotSha256: SHA,
  conversionVersion: "conversation-turns.v1",
  previewSha256: preview.previewSha256,
  providerId: "mbk_1",
  providerDisplayName: "Memory Test",
  status: "processing",
  createdItemCount: 1,
  existingItemCount: 0,
  resultCounts: {
    queued: 1,
    dispatching: 0,
    accepted: 0,
    materialized: 0,
    failed: 0,
    outcomeUnknown: 0,
  },
  items: [
    {
      memoryWriteIntentId: "mwi_1",
      disposition: "created",
      sourceItemKey: "turn-1",
      sourceItemSha256: SHA,
      title: "发布前检查",
      contentCharacters: 10,
      result: {
        schemaVersion: "memory-write-result.v1",
        memoryWriteResultId: "mwr_1",
        memoryWriteIntentId: "mwi_1",
        status: "queued",
        dispatchAttempts: 0,
        reconcileAttempts: 0,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      canReconcile: false,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readOnlyResponse(candidates = [pendingCandidate]) {
  return (url: string): Response | undefined => {
    if (url === "/lifeos/memory/write-candidates?status=pending_review&limit=100") {
      return json({ candidates });
    }
    if (url === "/lifeos/memory/providers") return json({ providers: [provider] });
    if (url === "/lifeos/memory/session-imports?limit=100")
      return json({ memorySessionImports: [] });
    return undefined;
  };
}

test("Memory候选决定用观察到的CAS，并在响应丢失后只原样重试", async () => {
  const writeBodies: string[] = [];
  let lost = true;
  const readonly = readOnlyResponse();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const base = readonly(url);
    if (base !== undefined) return base;
    if (url === "/lifeos/memory/write-candidates/mwc_1")
      return json({ candidate: pendingCandidate });
    if (url === "/lifeos/memory/write-candidates/mwc_1/decisions" && init?.method === "POST") {
      writeBodies.push(String(init.body));
      if (lost) {
        lost = false;
        throw new TypeError("response lost");
      }
      return json({
        candidate: approvedCandidate,
        decision: {
          schemaVersion: "memory-agent-write-decision.v1",
          memoryAgentWriteDecisionId: "mwd_1",
          memoryAgentWriteCandidateId: "mwc_1",
          candidateRevision: 1,
          candidateSha256: SHA,
          kind: "approve",
          principalId: "usr_1",
          commandId: "cmd_1",
          revision: 1,
          createdAt: NOW,
        },
      });
    }
    return json({ title: "not found", code: "not_found" }, 404);
  };
  const controller = new MemoryManagementController(fetchImpl);
  await controller.refresh();
  await controller.selectCandidate("mwc_1");
  assert.equal(controller.getSnapshot().selectedCandidate?.status, "pending_review");
  await assert.rejects(controller.decideCandidate("approve"), /response lost/u);
  await controller.decideCandidate("approve");
  assert.equal(writeBodies.length, 2);
  const first = JSON.parse(writeBodies[0]!) as {
    commandId: string;
    payload: Record<string, unknown>;
  };
  const replay = JSON.parse(writeBodies[1]!) as {
    commandId: string;
    payload: Record<string, unknown>;
  };
  assert.equal(replay.commandId, first.commandId);
  assert.deepEqual(first.payload, {
    kind: "approve",
    expectedCandidateRevision: 1,
    expectedCandidateSha256: SHA,
  });
  controller.dispose();
});

test("Memory候选决定响应丢失后，刷新只原样重放待确认命令并解除写锁", async () => {
  const writeBodies: string[] = [];
  let lost = true;
  const readonly = readOnlyResponse();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const base = readonly(url);
    if (base !== undefined) return base;
    if (url === "/lifeos/memory/write-candidates/mwc_1") {
      return json({ candidate: pendingCandidate });
    }
    if (url === "/lifeos/memory/write-candidates/mwc_1/decisions" && init?.method === "POST") {
      writeBodies.push(String(init.body));
      if (lost) {
        lost = false;
        throw new TypeError("response lost after commit");
      }
      return json({
        candidate: approvedCandidate,
        decision: {
          schemaVersion: "memory-agent-write-decision.v1",
          memoryAgentWriteDecisionId: "mwd_1",
          memoryAgentWriteCandidateId: "mwc_1",
          candidateRevision: 1,
          candidateSha256: SHA,
          kind: "approve",
          principalId: "usr_1",
          commandId: "cmd_1",
          revision: 1,
          createdAt: NOW,
        },
      });
    }
    return json({ title: "not found", code: "not_found" }, 404);
  };
  const controller = new MemoryManagementController(fetchImpl);
  await controller.refresh();
  await controller.selectCandidate("mwc_1");
  await assert.rejects(controller.decideCandidate("approve"), /response lost after commit/u);
  await controller.refresh();
  assert.equal(writeBodies.length, 2);
  const first = JSON.parse(writeBodies[0]!) as { commandId: string; payload: unknown };
  const replay = JSON.parse(writeBodies[1]!) as { commandId: string; payload: unknown };
  assert.deepEqual(replay, first);
  assert.equal(controller.getSnapshot().selectedCandidate?.status, "approved");
  assert.equal(controller.getSnapshot().error, null);
  controller.dispose();
});

test("Session导入先读取来源和Preview，创建命令只采用Preview冻结的Hash", async () => {
  const writeBodies: string[] = [];
  const readonly = readOnlyResponse([]);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const base = readonly(url);
    if (base !== undefined) return base;
    if (url === "/lifeos/memory/session-sources?kind=chat&limit=100") {
      return json({
        sources: [{ source: preview.source, title: preview.sourceTitle, updatedAt: NOW }],
      });
    }
    if (url === "/lifeos/memory/session-import-previews" && init?.method === "POST") {
      return json({ preview });
    }
    if (url === "/lifeos/memory/session-imports" && init?.method === "POST") {
      writeBodies.push(String(init.body));
      return json({ memorySessionImport: imported }, 201);
    }
    return json({ title: "not found", code: "not_found" }, 404);
  };
  const controller = new MemoryManagementController(fetchImpl);
  await controller.refresh();
  await controller.loadSources("chat");
  await controller.previewImport("mbk_1");
  await controller.createImport();
  const command = JSON.parse(writeBodies[0]!) as {
    commandId: string;
    payload: Record<string, unknown>;
  };
  assert.match(command.commandId, /^cmd_[a-f0-9]+$/u);
  assert.deepEqual(command.payload, {
    source: preview.source,
    providerId: preview.providerId,
    sourceSnapshotSha256: preview.sourceSnapshotSha256,
    previewSha256: preview.previewSha256,
  });
  controller.dispose();
});
