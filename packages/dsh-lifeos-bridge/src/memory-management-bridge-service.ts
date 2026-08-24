import {
  commandEnvelopeSchema,
  createMemorySessionImportPayloadSchema,
  decideMemoryAgentWriteCandidatePayloadSchema,
  memoryAgentWriteCandidateIdSchema,
  previewMemoryProviderComparisonPayloadSchema,
  previewMemorySessionImportPayloadSchema,
} from "@chat/contracts/public";
import { z } from "zod";
import type { ChatProductClient } from "./chat-client.ts";

export const memoryCandidateDecisionRequestSchema = commandEnvelopeSchema.extend({
  payload: decideMemoryAgentWriteCandidatePayloadSchema,
});
export const memoryProviderComparisonPreviewRequestSchema =
  previewMemoryProviderComparisonPayloadSchema;
export const memorySessionImportPreviewRequestSchema = previewMemorySessionImportPayloadSchema;
export const memorySessionImportCreateRequestSchema = commandEnvelopeSchema.extend({
  payload: createMemorySessionImportPayloadSchema,
});

/**
 * DSH Host只终止同源协议：候选、比较、导入的所有权、权限、CAS和外部写语义
 * 仍由Chat公开API与Application拥有。这里没有产品状态或Provider结果缓存。
 */
export class MemoryManagementBridgeService {
  constructor(private readonly chat: ChatProductClient) {}

  candidates(query: {
    readonly status?: "pending_review" | "approved" | "rejected" | undefined;
    readonly limit?: number | undefined;
  }) {
    return this.chat.listMemoryAgentWriteCandidates(query);
  }

  candidate(candidateId: string) {
    return this.chat.getMemoryAgentWriteCandidate(
      memoryAgentWriteCandidateIdSchema.parse(candidateId),
    );
  }

  decide(candidateId: string, request: z.infer<typeof memoryCandidateDecisionRequestSchema>) {
    return this.chat.decideMemoryAgentWriteCandidate(
      memoryAgentWriteCandidateIdSchema.parse(candidateId),
      request.commandId,
      request.payload,
    );
  }

  providers() {
    return this.chat.listMemoryProviders();
  }

  sources(kind: "chat" | "codex", limit?: number) {
    return this.chat.listMemorySessionSources(kind, limit);
  }

  previewImport(request: z.infer<typeof memorySessionImportPreviewRequestSchema>) {
    return this.chat.previewMemorySessionImport(request);
  }

  createImport(request: z.infer<typeof memorySessionImportCreateRequestSchema>) {
    return this.chat.createMemorySessionImport(request.commandId, request.payload);
  }

  imports(limit?: number) {
    return this.chat.listMemorySessionImports(limit);
  }

  compare(request: z.infer<typeof memoryProviderComparisonPreviewRequestSchema>) {
    return this.chat.previewMemoryProviderComparison(request);
  }
}
