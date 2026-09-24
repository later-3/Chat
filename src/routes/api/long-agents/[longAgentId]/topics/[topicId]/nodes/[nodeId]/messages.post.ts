import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../../../../chat-home.js";
import { authorizeTopicSession, readTopicGraph } from "../../../../../../../../long-agents/topics.js";
import { acceptLongAgentTurn, drainLongAgentTurns } from "../../../../../../../../long-agents/turn-queue.js";
import { friendExecution } from "../../../../../../../../long-agents/turn-feedback.js";

/**
 * Owner-facing user turn in one topic node.
 *
 * The Session id and the topic/node target come from the graph (never from the body): the turn is
 * accepted with a `topicNode` target, so the binding and the turn land in the same durable write and
 * the node's own session executes it on restart.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const topicId = getRouterParam(event, "topicId", { decode: true });
  const nodeId = getRouterParam(event, "nodeId", { decode: true });
  if (!longAgentId || !topicId || !nodeId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend、主题或节点标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["schemaVersion", "requestId", "text"].includes(key))
    || value.schemaVersion !== 1 || typeof value.requestId !== "string" || value.requestId.trim() === ""
    || typeof value.text !== "string" || value.text.trim() === "")
    throw createError({ statusCode: 400, statusMessage: "无效节点消息合同" });
  const home = resolveChatHome();
  const graph = await readTopicGraph(home, longAgentId);
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.topicId === topicId);
  if (node === undefined) throw createError({ statusCode: 404, statusMessage: "找不到主题节点" });
  const decision = authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: node.sessionId, capability: "write" });
  if (decision.applicable && !decision.allowed) throw createError({ statusCode: 403, statusMessage: decision.reason ?? "没有写入该节点的权限" });
  try {
    const accepted = await acceptLongAgentTurn({
      chatHome: home, longAgentId, requireInteractionRevision: false, projectId: longAgentId,
      turnId: String(value.requestId), text: value.text, source: "chat-web",
      topicNode: { topicId, nodeId },
    });
    // Acceptance only queues the round. The durable "round started" marker is written by the queue
    // BEFORE the work segment runs, under the same turnId as the completed marker, so no crash can leave
    // work running while the Session still looks like plain Long Agent history.
    setResponseStatus(event, 202);
    void drainLongAgentTurns(home, longAgentId).catch((error: unknown) => console.error("Friend队列执行失败", error));
    return friendExecution(home, accepted);
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && error.statusCode === 409 ? 409 : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
