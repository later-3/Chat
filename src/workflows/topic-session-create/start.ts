import { resolveChatHome } from "../../chat-home.js";
import { ensureChatSessionWithId } from "../../chat-session.js";
import { startChatWorkflow } from "../start-chat-workflow.js";
import { TOPIC_SESSION_CREATE_WORKFLOW_ID } from "./steps.js";
import { resolveProjectContext } from "../../projects/registry.js";
import { withFileLock } from "../../persistence/versioned-file.js";
import { listChatSessionRunBindings } from "../session-run-registry.js";
import { topicCreationBinding } from "./request.js";
import { resolve } from "node:path";

export interface StartTopicSessionCreationInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  /** Trusted request identity; derived by the caller (never a model argument). */
  readonly requestId: string;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string | null;
  readonly prompt: string;
  readonly parents?: readonly { readonly nodeId: string; readonly anchorEntryId: string; readonly anchorSequence: number }[];
}

// Pi Session ids allow only alphanumerics, '-', '_', '.' (and must start/end alphanumeric).
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}[A-Za-z0-9]$/;

/**
 * The SINGLE trusted startup entry for review-gated topic creation. Every caller (the Long Agent tool,
 * the new-topic button, the fork action, legacy integrations) resolves down to this: it reserves the
 * PREPARE session in the initiating Long Agent's home, binds the trusted creation context, and starts
 * the real `topic-session-create` Workflow Run. It never creates the target topic Session — only the
 * approved create step does that.
 */
export { topicCreationRequestForTurn } from "./topic-request-id.js";

export async function startTopicSessionCreation(input: StartTopicSessionCreationInput) {
  const chatHome = resolveChatHome(input.chatHome);
  const requestId = input.requestId.trim();
  if (requestId === "") throw new Error("主题创建缺少请求身份");
  const prepareSessionId = `topic-create-${requestId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  if (!SESSION_ID_PATTERN.test(prepareSessionId)) throw new Error("主题创建请求身份格式无效");
  const project = await resolveProjectContext(input.longAgentId, chatHome);
  const target = { longAgentId: input.longAgentId, requestId, sourceSessionId: input.sourceSessionId,
    sourceTurnId: input.sourceTurnId, parents: input.parents ?? [] };
  const identity = topicCreationBinding(input.prompt, target);
  return withFileLock(resolve(project.projectDataDir, "workflows", `${prepareSessionId}.lock`), async () => {
    const prior = (await listChatSessionRunBindings(project.projectDataDir))
      .find(binding => binding.topicCreation?.requestId === requestId);
    if (prior !== undefined) {
      if (prior.topicCreation?.requestFingerprint !== identity.requestFingerprint) {
        throw Object.assign(new Error("同一请求不能更改主题创建内容或来源"), { statusCode: 409 });
      }
      return { prepareSessionId: prior.sessionId, requestId, workflowInvocationId: prior.workflowInvocationId,
        run: { runId: prior.runId } };
    }
    // The prepare Session belongs to the initiating Long Agent's home and is recoverable across refresh.
    const { session } = await ensureChatSessionWithId(
      { projectId: input.longAgentId, chatHome },
      prepareSessionId,
      "主题创建",
    );
    const started = await startChatWorkflow({
      workflow: TOPIC_SESSION_CREATE_WORKFLOW_ID,
      projectId: input.longAgentId,
      chatHome,
      cwd: session.cwd,
      prompt: input.prompt,
      sessionId: prepareSessionId,
      topicCreation: target,
    });
    return { ...started, prepareSessionId, requestId };
  });
}
