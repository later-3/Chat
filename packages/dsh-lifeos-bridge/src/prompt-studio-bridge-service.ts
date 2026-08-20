import {
  changePromptFragmentArchiveStatusPayloadSchema,
  commandIdSchema,
  copyPromptFragmentPayloadSchema,
  createPromptFragmentPayloadSchema,
  previewPromptAssemblyPayloadSchema,
  revisePromptFragmentPayloadSchema,
} from "@chat/contracts/public";
import { z } from "zod";
import type { ChatProductClient } from "./chat-client.ts";

export const promptStudioCreateRequestSchema = z
  .object({ commandId: commandIdSchema, payload: createPromptFragmentPayloadSchema })
  .strict();
export const promptStudioCopyRequestSchema = z
  .object({ commandId: commandIdSchema, payload: copyPromptFragmentPayloadSchema })
  .strict();
export const promptStudioReviseRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedRevision: z.number().int().positive(),
    payload: revisePromptFragmentPayloadSchema,
  })
  .strict();
export const promptStudioArchiveRequestSchema = z
  .object({
    commandId: commandIdSchema,
    expectedRevision: z.number().int().positive(),
    payload: changePromptFragmentArchiveStatusPayloadSchema,
  })
  .strict();
export const promptStudioPreviewRequestSchema = previewPromptAssemblyPayloadSchema;

/** DSH Host只做同源协议转换；Prompt Catalog、Revision和CAS仍由Chat公开API拥有。 */
export class PromptStudioBridgeService {
  constructor(private readonly chat: ChatProductClient) {}

  regions() {
    return this.chat.getPromptRegions();
  }

  workspaces() {
    return this.chat.getPromptWorkspaces();
  }

  preview(request: z.infer<typeof promptStudioPreviewRequestSchema>) {
    return this.chat.previewPromptAssembly(request);
  }

  fragments(query: {
    cursor?: string;
    limit?: number;
    regionKey?: string;
    ownerKind?: string;
    status?: string;
    scopeKind?: string;
    workspaceRootId?: string;
  }) {
    return this.chat.listPromptFragments(query);
  }

  fragment(promptFragmentId: string) {
    return this.chat.getPromptFragment(promptFragmentId);
  }

  revision(promptFragmentRevisionId: string) {
    return this.chat.getPromptFragmentRevision(promptFragmentRevisionId);
  }

  create(request: z.infer<typeof promptStudioCreateRequestSchema>) {
    return this.chat.createPromptFragment(request.commandId, request.payload);
  }

  copy(request: z.infer<typeof promptStudioCopyRequestSchema>) {
    return this.chat.copyPromptFragment(request.commandId, request.payload);
  }

  revise(promptFragmentId: string, request: z.infer<typeof promptStudioReviseRequestSchema>) {
    return this.chat.revisePromptFragment(
      promptFragmentId,
      request.commandId,
      request.expectedRevision,
      request.payload,
    );
  }

  archive(promptFragmentId: string, request: z.infer<typeof promptStudioArchiveRequestSchema>) {
    return this.chat.changePromptFragmentArchiveStatus(
      promptFragmentId,
      request.commandId,
      request.expectedRevision,
      request.payload,
    );
  }
}
