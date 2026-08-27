import { createHash } from "node:crypto";
import {
  bridgeChatDispatchPlanSchema,
  type BridgeChatDispatchPlan,
  type WorkflowSelection,
} from "./contracts.ts";
import type { PromptTurnSelectionInput } from "@chat/contracts/public";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function httpCommand(path: string, body: unknown) {
  const bodyJson = JSON.stringify(body);
  return { method: "POST" as const, path, bodyJson, bodySha256: sha256(bodyJson) };
}

export function bridgeChatSubmitPayload(input: {
  readonly text: string;
  readonly workflowSelection?: WorkflowSelection;
  readonly promptSelection?: PromptTurnSelectionInput;
}) {
  return {
    text: input.text,
    ...(input.workflowSelection === undefined
      ? {}
      : {
          workflowSelection: {
            kind: "published_revision" as const,
            workflowDefinitionRevisionId: input.workflowSelection.workflowDefinitionRevisionId,
            definitionSha256: input.workflowSelection.definitionSha256,
            runConfiguration: input.workflowSelection.runConfiguration,
          },
        }),
    // Prompt Selection是跨Workflow的用户意图。Bridge只冻结并透明转发Revision/Hash；
    // 具体节点、Profile和安全层由Chat Application按已发布Definition编译。
    ...(input.promptSelection === undefined ? {} : { promptSelection: input.promptSelection }),
  };
}

/**
 * Bridge出口唯一组装器。预览、审核和真正fetch都消费这里冻结的同一bodyJson，
 * 避免“预览只显示payload、Client发送时又在别处补commandId”的双组装漂移。
 */
export function prepareBridgeChatDispatch(input: {
  readonly requestKey: string;
  readonly productSessionId?: string;
  readonly messageCommandId: string;
  readonly text: string;
  readonly workflowSelection?: WorkflowSelection;
  readonly promptSelection?: PromptTurnSelectionInput;
}): BridgeChatDispatchPlan {
  const payload = bridgeChatSubmitPayload(input);
  const submitMessageBody = { commandId: input.messageCommandId, payload };
  const submitMessage = {
    ...httpCommand(
      input.productSessionId === undefined
        ? "/api/messages"
        : `/api/sessions/${encodeURIComponent(input.productSessionId)}/messages`,
      submitMessageBody,
    ),
    commandId: input.messageCommandId,
    payload,
  };
  const core = {
    schemaVersion: "chat-bridge-chat-dispatch-plan.v2" as const,
    requestKey: input.requestKey,
    productSessionId: input.productSessionId ?? null,
    submitMessage,
  };
  return bridgeChatDispatchPlanSchema.parse({
    ...core,
    planSha256: sha256(JSON.stringify(core)),
  });
}
