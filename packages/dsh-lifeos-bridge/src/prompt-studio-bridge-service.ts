import {
  agentProfileAgentKeySchema,
  changePromptFragmentArchiveStatusPayloadSchema,
  commandIdSchema,
  copyPromptFragmentPayloadSchema,
  createAgentVersionPayloadSchema,
  createPromptFragmentPayloadSchema,
  previewPromptAssemblyPayloadSchema,
  previewPromptConfigurationPayloadSchema,
  reviseAgentPromptPayloadSchema,
  revisePromptFragmentPayloadSchema,
  restoreAgentPromptPayloadSchema,
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
export const promptStudioConfigurationPreviewRequestSchema =
  previewPromptConfigurationPayloadSchema;
export const agentPromptReviseRequestSchema = z
  .object({ commandId: commandIdSchema, payload: reviseAgentPromptPayloadSchema })
  .strict();
export const agentPromptRestoreRequestSchema = z
  .object({ commandId: commandIdSchema, payload: restoreAgentPromptPayloadSchema })
  .strict();
export const agentVersionCreateRequestSchema = z
  .object({ commandId: commandIdSchema, payload: createAgentVersionPayloadSchema })
  .strict();

/** DSH Host只做同源协议转换；Prompt Catalog、Revision和CAS仍由Chat公开API拥有。 */
export class PromptStudioBridgeService {
  constructor(private readonly chat: ChatProductClient) {}

  regions() {
    return this.chat.getPromptRegions();
  }

  workspaces() {
    return this.chat.getPromptWorkspaces();
  }

  agents({ workspaceRootId }: { readonly workspaceRootId?: string } = {}) {
    return this.chat.getAgentProfiles(workspaceRootId);
  }

  reviseAgent(agentKey: string, request: z.infer<typeof agentPromptReviseRequestSchema>) {
    return this.chat.reviseAgentPrompt(
      agentProfileAgentKeySchema.parse(agentKey),
      request.commandId,
      request.payload,
    );
  }

  restoreAgent(agentKey: string, request: z.infer<typeof agentPromptRestoreRequestSchema>) {
    return this.chat.restoreAgentPrompt(
      agentProfileAgentKeySchema.parse(agentKey),
      request.commandId,
      request.payload,
    );
  }

  createAgentVersion(agentKey: string, request: z.infer<typeof agentVersionCreateRequestSchema>) {
    return this.chat.createAgentVersion(
      agentProfileAgentKeySchema.parse(agentKey),
      request.commandId,
      request.payload,
    );
  }

  preview(request: z.infer<typeof promptStudioPreviewRequestSchema>) {
    return this.chat.previewPromptAssembly(request);
  }

  previewConfiguration(request: z.infer<typeof promptStudioConfigurationPreviewRequestSchema>) {
    return this.chat.previewPromptConfiguration(request);
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
