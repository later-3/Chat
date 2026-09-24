import { createError, defineEventHandler, getQuery, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../../../chat-home.js";
import { authorizeTopicSession, readTopicGraph } from "../../../../../../../../long-agents/topics.js";
import { readChatSession } from "../../../../../../../../session-read-model.js";
import { toSessionLifecycleHttpError } from "../../../../../../../../session-removal-http.js";
import { SessionLifecycleError } from "../../../../../../../../session-errors.js";

/**
 * Owner-facing messages of one topic node. The node's Session id is resolved from the graph, so a client
 * never supplies a Session id and cannot point this route at an arbitrary Session. The shared topic
 * decision (read) plus the shared Session read entry both apply.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const topicId = getRouterParam(event, "topicId", { decode: true });
  const nodeId = getRouterParam(event, "nodeId", { decode: true });
  if (!longAgentId || !topicId || !nodeId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend、主题或节点标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const query = getQuery(event);
  const home = resolveChatHome();
  const graph = await readTopicGraph(home, longAgentId);
  // The URL must describe ONE consistent path: a node id from another topic is not reachable through
  // this topic's route.
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.topicId === topicId);
  if (node === undefined) throw createError({ statusCode: 404, statusMessage: "找不到主题节点" });
  const decision = authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: node.sessionId, capability: "read" });
  if (decision.applicable && !decision.allowed) throw createError({ statusCode: 403, statusMessage: decision.reason ?? "没有读取该节点的权限" });
  try {
    return await readChatSession(node.sessionId, undefined, {
      deferThinking: "deferThinking" in query,
      deferToolResultImages: "deferMedia" in query,
    }, longAgentId, home, { kind: "owner" });
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({ statusCode: 404, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
