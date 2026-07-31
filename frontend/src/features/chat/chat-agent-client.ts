import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";

import { authenticatedFetch } from "../../authentication-recovery.js";
import { createClientId } from "../../client-id.js";
import { AG_UI_URL, apiUrl } from "../../runtime-config.js";
import type { DispatchRecovery, ModelCallReviewCard } from "./chat-agent-contracts.js";

export function createChatHttpAgent(): HttpAgent {
  return new HttpAgent({
    url: AG_UI_URL,
    threadId: createClientId(),
    description: "独立 AI 协作 Chat 产品",
    fetch: authenticatedFetch,
  });
}

export function cloneAgentMessages(messages: ReadonlyArray<Readonly<Message>>): Message[] {
  return messages.map((message) => ({ ...message })) as Message[];
}

/** Read the durable Attempt after a failed dispatch; never retries the Provider request. */
export async function modelCallDispatchRecovery(
  review: Pick<ModelCallReviewCard, "draft_id" | "origin_prompt">,
  message: string,
): Promise<DispatchRecovery> {
  let status: DispatchRecovery["status"] = "outcome_unknown";
  let errorCode: string | null = null;
  try {
    const response = await authenticatedFetch(apiUrl(`/api/model-call-drafts/${review.draft_id}`));
    if (response.ok) {
      const card = (await response.json()) as ModelCallReviewCard;
      status = card.attempt?.status === "failed" ? "failed" : "outcome_unknown";
      errorCode = card.attempt?.error_code ?? null;
    }
  } catch {
    status = "outcome_unknown";
  }
  return {
    draftId: review.draft_id,
    status,
    errorCode,
    message,
    originPrompt: review.origin_prompt,
  };
}
