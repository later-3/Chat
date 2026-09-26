import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../../../chat-home.js";
import { authorizeTopicSession, readTopicGraph } from "../../../../../../../../long-agents/topics.js";
import { readTopicSettledAnchors } from "../../../../../../../../long-agents/topic-anchor.js";
import { openChatSession } from "../../../../../../../../chat-session.js";

/**
 * Owner-facing forkable anchors of one topic node: the settled rounds of its CURRENT branch. The frontend
 * uses this to offer "fork from this round"; the anchor is re-verified inside the parent lock when the
 * child node is actually created.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const topicId = getRouterParam(event, "topicId", { decode: true });
  const nodeId = getRouterParam(event, "nodeId", { decode: true });
  if (!longAgentId || !topicId || !nodeId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend、主题或节点标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const home = resolveChatHome();
  const graph = await readTopicGraph(home, longAgentId);
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.topicId === topicId);
  if (node === undefined) throw createError({ statusCode: 404, statusMessage: "找不到主题节点" });
  const decision = authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: node.sessionId, capability: "read" });
  if (decision.applicable && !decision.allowed) throw createError({ statusCode: 403, statusMessage: decision.reason ?? "没有读取该节点的权限" });
  const session = await openChatSession({ chatHome: home, projectId: longAgentId, sessionId: node.sessionId });
  return {
    schemaVersion: 1, nodeId, sessionId: node.sessionId,
    anchors: readTopicSettledAnchors(session.manager).map((anchor) => ({
      anchorEntryId: anchor.anchorEntryId, anchorSequence: anchor.anchorSequence, turnId: anchor.turnId, settledAt: anchor.settledAt,
    })),
  };
});
