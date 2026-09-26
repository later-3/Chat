import { resolveProjectContext } from "../../projects/registry.js";
import { resolveDailySource } from "../../long-agents/topic-integration.js";
import { listChatSessionRunBindings } from "../session-run-registry.js";
import { startTopicCreation } from "../topic-creation-runtime.js";
import type { StartTopicSessionCreationInput } from "./start.js";

/** New and compatibility HTTP entries resolve the same trusted daily source and launch contract. */
export async function startOwnerTopicCreation(input: Omit<StartTopicSessionCreationInput, "sourceSessionId" | "sourceTurnId"> & { sourceSessionId?: string }) {
  const project = await resolveProjectContext(input.longAgentId, input.chatHome);
  const prior = (await listChatSessionRunBindings(project.projectDataDir)).find(binding => binding.topicCreation?.requestId === input.requestId);
  const frozenSource = prior?.topicCreation?.sourceSessionId;
  if (frozenSource !== undefined && input.sourceSessionId !== undefined && frozenSource !== input.sourceSessionId) {
    throw Object.assign(new Error("同一请求不能更改来源会话"), { statusCode: 409 });
  }
  const sourceSessionId = await resolveDailySource(input.chatHome, input.longAgentId, frozenSource ?? input.sourceSessionId);
  const started = await startTopicCreation({ ...input, sourceSessionId, sourceTurnId: null });
  return { schemaVersion: 1 as const, requestId: started.requestId, prepareSessionId: started.prepareSessionId,
    runId: started.run.runId, workflowInvocationId: started.workflowInvocationId };
}
