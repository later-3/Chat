import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { authorizeTopicSession, readTopicGraph } from "../../../../../long-agents/topics.js";

/**
 * Owner-facing topic graph of one Long Agent.
 *
 * The local owner is the requester, so the shared topic decision is the single gate (and a Session that
 * is not a topic node is simply not listed here). No identity comes from the request.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  if (!longAgentId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend ID" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const home = resolveChatHome();
  const graph = await readTopicGraph(home, longAgentId);
  return {
    schemaVersion: 1,
    longAgentId,
    revision: graph.revision,
    topics: graph.topics.map((topic) => ({
      topicId: topic.topicId, title: topic.title, purpose: topic.purpose, status: topic.status,
      rootSessionId: topic.rootSessionId, createdAt: topic.createdAt,
      nodes: graph.nodes.filter((node) => node.topicId === topic.topicId).map((node) => {
        // Every listed node passes the shared read decision for this requester.
        const decision = authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: node.sessionId, capability: "read" });
        return { nodeId: node.nodeId, sessionId: node.sessionId, title: node.title, status: node.status,
          readable: decision.allowed, frozenProjectContext: node.frozenProjectContext,
          initialMemoryRefs: node.initialMemoryRefs,
          parents: graph.edges.filter((edge) => edge.childNodeId === node.nodeId)
            .map((edge) => ({ edgeId: edge.edgeId, parentNodeId: edge.parentNodeId, anchorEntryId: edge.anchorEntryId,
              anchorSequence: edge.anchorSequence, memoryRefs: edge.memoryRefs })) };
      }),
    })),
  };
});
