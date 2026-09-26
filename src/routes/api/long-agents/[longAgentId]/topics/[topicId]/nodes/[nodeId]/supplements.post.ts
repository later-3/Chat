import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader, setResponseStatus } from "nitro/h3";
import { resolveChatHome } from "../../../../../../../../chat-home.js";
import { authorizeTopicSession, readTopicGraph, supplementTopicChildIntegration } from "../../../../../../../../long-agents/topics.js";

/**
 * Owner-confirmed R4 supplemental integration for one existing node: write the product (session-memory
 * entry or relay intent) and add the parent edge at a settled anchor. The owner entry is the trusted
 * confirmation (`confirmedBy: "user"`); an Agent cannot call this route. Every step is idempotent under
 * `requestId`, so a retry after a cross-file interruption completes the missing steps.
 */
export default defineEventHandler(async (event) => {
  const longAgentId = getRouterParam(event, "longAgentId");
  const topicId = getRouterParam(event, "topicId", { decode: true });
  const nodeId = getRouterParam(event, "nodeId", { decode: true });
  if (!longAgentId || !topicId || !nodeId) throw createError({ statusCode: 400, statusMessage: "缺少 Friend、主题或节点标识" });
  setResponseHeader(event, "Cache-Control", "no-store");
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw createError({ statusCode: 400, statusMessage: "请求必须是对象" });
  const value = body as Record<string, unknown>;
  const product = value.product;
  const productValid = typeof product === "object" && product !== null && !Array.isArray(product)
    && ((product as Record<string, unknown>).kind === "memory" && typeof (product as Record<string, unknown>).content === "string"
      || (product as Record<string, unknown>).kind === "relay" && typeof (product as Record<string, unknown>).text === "string");
  if (Object.keys(value).some((key) => !["schemaVersion", "requestId", "parentNodeId", "anchorEntryId", "anchorSequence", "product", "source"].includes(key))
    || value.schemaVersion !== 1 || typeof value.requestId !== "string" || value.requestId.trim() === ""
    || typeof value.parentNodeId !== "string" || value.parentNodeId.trim() === ""
    || typeof value.anchorEntryId !== "string" || value.anchorEntryId.trim() === ""
    || !Number.isSafeInteger(value.anchorSequence) || Number(value.anchorSequence) < 1 || !productValid)
    throw createError({ statusCode: 400, statusMessage: "无效补充整合合同" });
  const home = resolveChatHome();
  const graph = await readTopicGraph(home, longAgentId);
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.topicId === topicId);
  if (node === undefined) throw createError({ statusCode: 404, statusMessage: "找不到主题节点" });
  const decision = authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: node.sessionId, capability: "write" });
  if (decision.applicable && !decision.allowed) throw createError({ statusCode: 403, statusMessage: decision.reason ?? "没有写入该节点的权限" });
  try {
    const outcome = await supplementTopicChildIntegration({
      chatHome: home, longAgentId, childNodeId: nodeId, parentNodeId: value.parentNodeId,
      anchorEntryId: value.anchorEntryId, anchorSequence: Number(value.anchorSequence),
      requestId: value.requestId, product: product as never,
      ...(value.source === undefined ? {} : { source: value.source }),
      confirmedBy: "user",
    });
    setResponseStatus(event, 201);
    return { schemaVersion: 1, created: outcome.created, edge: outcome.edge, product: outcome.product, revision: outcome.graph.revision };
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
