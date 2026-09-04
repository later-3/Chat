import { openChatSession } from "../chat-session.js";
import { collectChatWorkflowCallProjection } from "./workflow-call-statistics.js";

export interface ReadChatWorkflowCallProjectionInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly chatHome?: string;
}

/** Reads the persisted Workflow-call tree without projecting the full chat history. */
export async function readChatWorkflowCallProjection(
  input: ReadChatWorkflowCallProjectionInput,
) {
  const session = await openChatSession({
    projectId: input.projectId,
    sessionId: input.sessionId,
    ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
  });
  return collectChatWorkflowCallProjection({
    rootSessionId: session.manager.getSessionId(),
    rootEntries: session.manager.getEntries(),
    sessionDir: session.sessionDir,
  });
}
