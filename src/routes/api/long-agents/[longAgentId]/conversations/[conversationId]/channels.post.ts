import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { locateConversationForHttp, readConversationBody } from "../../../../../../long-agents/conversations/http.js";
import {
  bindConversationChannel,
  deliverConversationPublication,
  drainConversationDeliveries,
  unbindConversationChannel,
} from "../../../../../../long-agents/conversations/channel.js";
import { ConversationError } from "../../../../../../long-agents/conversations/contract.js";
import { readConversationPublicMessages } from "../../../../../../long-agents/conversations/publication.js";
import { syncConversationChannels } from "../../../../../../long-agents/conversations/channel-sync.js";

/**
 * Owner-facing channel management: `bind`/`unbind` a destination, or `retry` a definitive delivery
 * failure. Binding validates membership and the NanoClaw instance; delivery retries reuse the stable
 * delivery id and never call the model.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const body = await readConversationBody(event, ["action", "longAgentId", "instanceId", "expectedRevision", "destination", "botPlatformId", "bindingId", "publicationId"]);
  const home = resolveChatHome();
  try {
    const located = await locateConversationForHttp(home, conversationId, namespace);
    const storageProjectId = located.storageProjectId;
    if (body.action === "bind") {
      if (typeof body.longAgentId !== "string" || typeof body.instanceId !== "string" || typeof body.expectedRevision !== "number")
        throw createError({ statusCode: 400, statusMessage: "bind 需要 longAgentId/instanceId/expectedRevision" });
      const binding = await bindConversationChannel({
        chatHome: home, storageProjectId, conversationId, longAgentId: body.longAgentId, instanceId: body.instanceId,
        expectedRevision: body.expectedRevision, destination: body.destination as never,
        ...(body.botPlatformId === undefined || body.botPlatformId === null ? {} : { botPlatformId: String(body.botPlatformId) }),
      });
      return { schemaVersion: 1, binding, ...(await syncConversationChannels({ chatHome: home, storageProjectId, conversationId })) };
    }
    if (body.action === "unbind") {
      if (typeof body.bindingId !== "string" || typeof body.expectedRevision !== "number")
        throw createError({ statusCode: 400, statusMessage: "unbind 需要 bindingId/expectedRevision" });
      const binding = await unbindConversationChannel({ chatHome: home, storageProjectId, conversationId, bindingId: body.bindingId, expectedRevision: body.expectedRevision });
      return { schemaVersion: 1, binding, ...(await syncConversationChannels({ chatHome: home, storageProjectId, conversationId })) };
    }
    if (body.action === "retry") {
      if (typeof body.bindingId !== "string" || typeof body.publicationId !== "string")
        throw createError({ statusCode: 400, statusMessage: "retry 需要 bindingId/publicationId" });
      // Re-read the authorized public reference: private content is never delivered.
      const published = (await readConversationPublicMessages({
        chatHome: home, storageProjectId, conversationId, viewerLongAgentId: null,
      })).find((message) => message.publicationId === body.publicationId);
      if (published?.text == null) throw new ConversationError(409, "公开引用不可用，拒绝投递");
      const deliveries = await deliverConversationPublication({
        chatHome: home, storageProjectId, conversationId, publicationId: body.publicationId,
      });
      // A retry is also the recovery entry for a mirror that failed after an earlier bind.
      return { schemaVersion: 1, deliveries, ...(await syncConversationChannels({ chatHome: home, storageProjectId, conversationId })) };
    }
    if (body.action === "sync") {
      return { schemaVersion: 1, ...(await syncConversationChannels({ chatHome: home, storageProjectId, conversationId })) };
    }
    if (body.action === "drain") {
      return { schemaVersion: 1, deliveries: await drainConversationDeliveries({ chatHome: home, storageProjectId, conversationId }) };
    }
    throw createError({ statusCode: 400, statusMessage: "action 必须是 bind/unbind/retry/sync/drain" });
  } catch (error) {
    if (error instanceof ConversationError) throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    throw error;
  }
});
