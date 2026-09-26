import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../../chat-home.js";
import { authorizeTopicSession, readTopicGraph, setTopicNodeSessionMemory } from "../../../../../../../long-agents/topics.js";

/**
 * Owner-facing node setting: the per-node session-memory switch. Turning it off makes the next rounds
 * ordinary agent turns (no read capability, no writer stage). CAS via `expectedRevision`.
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
  if (Object.keys(value).some((key) => !["schemaVersion", "expectedRevision", "sessionMemory"].includes(key))
    || value.schemaVersion !== 1 || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0
    || (value.sessionMemory !== "on" && value.sessionMemory !== "off"))
    throw createError({ statusCode: 400, statusMessage: "无效节点设置合同" });
  const home = resolveChatHome();
  const graph = await readTopicGraph(home, longAgentId);
  const node = graph.nodes.find((candidate: { nodeId: string; topicId: string }) => candidate.nodeId === nodeId && candidate.topicId === topicId);
  if (node === undefined) throw createError({ statusCode: 404, statusMessage: "找不到主题节点" });
  const decision = authorizeTopicSession({ graph, requester: { kind: "user" }, sessionId: node.sessionId, capability: "write" });
  if (decision.applicable && !decision.allowed) throw createError({ statusCode: 403, statusMessage: decision.reason ?? "没有写入该节点的权限" });
  try {
    const updated = await setTopicNodeSessionMemory({ chatHome: home, longAgentId, nodeId,
      enabled: value.sessionMemory === "on", expectedRevision: Number(value.expectedRevision) });
    return { schemaVersion: 1, node: updated, revision: (await readTopicGraph(home, longAgentId)).revision };
  } catch (error) {
    throw createError({
      statusCode: error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
