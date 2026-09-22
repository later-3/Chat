import { createError, defineEventHandler, getQuery, getRouterParam, getRequestHeader, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { ConversationError } from "../../../../../../long-agents/conversations/contract.js";
import { findConversation } from "../../../../../../long-agents/conversations/storage.js";
import {
  ownerConversationStreamViewer,
  readConversationStreamTick,
  type ConversationStreamEvent,
} from "../../../../../../long-agents/conversations/stream.js";

/** How often the public root is re-read. Each tick re-checks authorization before returning data. */
const TICK_MS = 300;

function sseFrame(event: ConversationStreamEvent): string {
  return `event: ${event.type}\nid: ${String(event.cursor)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Owner-facing real-time projection of one group's public order.
 *
 * This is the local owner entry, the same trust level as every other owner-facing route (local
 * Backend, no login). It takes **no identity from the request**: there is no viewer parameter, and
 * unknown query keys are rejected, so omitting or supplying an id cannot select the owner projection
 * or impersonate a member. A member/Agent never reaches this route: Friend-side reads go through the
 * service functions, where the viewer is built from the Backend-resolved conversation scope
 * (`memberConversationStreamViewerFromScope`), bound to that group and re-verified every tick.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  const query = getQuery(event);
  // Only the reconnect cursor is accepted. An identity parameter is not a supported contract and is
  // refused outright rather than ignored, so a spoof attempt is visible and testable.
  const unknown = Object.keys(query).filter((key) => key !== "after");
  if (unknown.length > 0) throw createError({ statusCode: 400, statusMessage: `不支持的身份/查询参数：${unknown.join(", ")}` });
  const afterParam = query.after;
  const lastEventId = getRequestHeader(event, "last-event-id");
  const rawCursor = afterParam !== undefined ? afterParam : lastEventId;
  if (rawCursor !== undefined && (typeof rawCursor !== "string" || !/^-?\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))))
    throw createError({ statusCode: 400, statusMessage: "无效的游标" });
  const afterCursor = rawCursor === undefined ? -1 : Number(rawCursor);

  const home = resolveChatHome();
  let located: Awaited<ReturnType<typeof findConversation>>;
  try {
    located = await findConversation(home, conversationId);
  } catch (error) {
    throw createError({
      statusCode: error instanceof ConversationError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : "读取群失败",
    });
  }
  const { conversation, storageProjectId } = located;
  // The URL namespace must be one of the group's members; it scopes the lookup, it is not an identity.
  if (!conversation.members.some((member) => member.longAgentId === namespace))
    throw createError({ statusCode: 404, statusMessage: "该 Friend 不属于这个群" });
  const viewer = ownerConversationStreamViewer();

  // The first authorization check runs before the streaming response is committed, so an archived
  // group is a normal HTTP status instead of an open connection.
  const first = await readConversationStreamTick({ chatHome: home, storageProjectId, conversationId, viewer, afterCursor });
  if (first.closed) {
    const reason = first.events.find((item) => item.type === "revoked")?.reason ?? "无权读取该群的公共消息";
    throw createError({ statusCode: 403, statusMessage: reason });
  }

  let cursor = first.nextCursor;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (events: readonly ConversationStreamEvent[]) => {
        for (const item of events) controller.enqueue(encoder.encode(sseFrame(item)));
      };
      send(first.events);
      const poll = async () => {
        if (stopped) return;
        try {
          const tick = await readConversationStreamTick({ chatHome: home, storageProjectId, conversationId, viewer, afterCursor: cursor });
          if (stopped) return;
          cursor = tick.nextCursor;
          send(tick.events);
          if (tick.closed) {
            // The group was archived while connected: end the response stream now.
            stopped = true;
            controller.close();
            return;
          }
          timer = setTimeout(() => void poll(), TICK_MS);
        } catch (error) {
          stopped = true;
          controller.error(error);
        }
      };
      timer = setTimeout(() => void poll(), TICK_MS);
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
