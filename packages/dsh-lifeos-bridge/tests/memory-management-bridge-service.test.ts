import assert from "node:assert/strict";
import test from "node:test";
import type { ChatProductClient } from "../src/chat-client.ts";
import {
  MemoryManagementBridgeService,
  memoryCandidateDecisionRequestSchema,
  memoryProviderComparisonPreviewRequestSchema,
  memorySessionImportCreateRequestSchema,
  memorySessionImportPreviewRequestSchema,
} from "../src/memory-management-bridge-service.ts";

const SHA = "a".repeat(64);

test("Memory management bridge只把严格的候选、比较和导入意图转给Chat", async () => {
  const calls: unknown[] = [];
  const chat = {
    listMemoryAgentWriteCandidates: async (query: unknown) => {
      calls.push({ kind: "candidates", query });
      return { candidates: [] };
    },
    getMemoryAgentWriteCandidate: async (candidateId: string) => {
      calls.push({ kind: "candidate", candidateId });
      return { candidate: { memoryAgentWriteCandidateId: candidateId } };
    },
    decideMemoryAgentWriteCandidate: async (
      candidateId: string,
      commandId: string,
      payload: unknown,
    ) => {
      calls.push({ kind: "decision", candidateId, commandId, payload });
      return { candidate: {}, decision: {} };
    },
    listMemoryProviders: async () => {
      calls.push({ kind: "providers" });
      return { providers: [] };
    },
    listMemorySessionSources: async (kind: string, limit?: number) => {
      calls.push({ kind: "sources", sourceKind: kind, limit });
      return { sources: [] };
    },
    previewMemorySessionImport: async (payload: unknown) => {
      calls.push({ kind: "previewImport", payload });
      return { preview: {} };
    },
    createMemorySessionImport: async (commandId: string, payload: unknown) => {
      calls.push({ kind: "createImport", commandId, payload });
      return { memorySessionImport: {} };
    },
    listMemorySessionImports: async (limit?: number) => {
      calls.push({ kind: "imports", limit });
      return { memorySessionImports: [] };
    },
    previewMemoryProviderComparison: async (payload: unknown) => {
      calls.push({ kind: "compare", payload });
      return { comparison: {} };
    },
  } as unknown as ChatProductClient;
  const service = new MemoryManagementBridgeService(chat);
  const source = { kind: "chat" as const, productSessionId: "psn_1" };
  const decision = memoryCandidateDecisionRequestSchema.parse({
    commandId: "cmd_1",
    payload: {
      kind: "approve",
      expectedCandidateRevision: 1,
      expectedCandidateSha256: SHA,
    },
  });
  const importPreview = memorySessionImportPreviewRequestSchema.parse({
    source,
    providerId: "mbk_1",
  });
  const createImport = memorySessionImportCreateRequestSchema.parse({
    commandId: "cmd_2",
    payload: {
      source,
      providerId: "mbk_1",
      sourceSnapshotSha256: SHA,
      previewSha256: "b".repeat(64),
    },
  });
  const comparison = memoryProviderComparisonPreviewRequestSchema.parse({
    source,
    query: "发布前需要完成什么？",
    providerIds: ["mbk_1", "mbk_2"],
  });

  await service.candidates({ status: "pending_review", limit: 20 });
  await service.candidate("mwc_1");
  await service.decide("mwc_1", decision);
  await service.providers();
  await service.sources("chat", 20);
  await service.previewImport(importPreview);
  await service.createImport(createImport);
  await service.imports(20);
  await service.compare(comparison);

  assert.deepEqual(calls, [
    { kind: "candidates", query: { status: "pending_review", limit: 20 } },
    { kind: "candidate", candidateId: "mwc_1" },
    { kind: "decision", candidateId: "mwc_1", commandId: "cmd_1", payload: decision.payload },
    { kind: "providers" },
    { kind: "sources", sourceKind: "chat", limit: 20 },
    { kind: "previewImport", payload: importPreview },
    { kind: "createImport", commandId: "cmd_2", payload: createImport.payload },
    { kind: "imports", limit: 20 },
    { kind: "compare", payload: comparison },
  ]);
});
