import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { readTopicGraph } from "../../../../../long-agents/topics.js";

/** Owner-facing read of one topic tree (nodes plus parent edges). */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const topicId = getRouterParam(event, "topicId", { decode: true });
  if (!longAgentId || !topicId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend 或主题标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const graph = await readTopicGraph(resolveChatHome(), longAgentId);
  const topic = graph.topics.find((candidate) => candidate.topicId === topicId);
  if (topic === undefined) throw createError({ statusCode: 404, statusMessage: "找不到主题" });
  const nodes = graph.nodes.filter((node) => node.topicId === topicId);
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  return {
    schemaVersion: 1,
    revision: graph.revision,
    topic,
    nodes,
    // Only this topic's edges: an edge to another tree would leak another topic's structure.
    edges: graph.edges.filter((edge) => nodeIds.has(edge.parentNodeId) && nodeIds.has(edge.childNodeId)),
  };
});
