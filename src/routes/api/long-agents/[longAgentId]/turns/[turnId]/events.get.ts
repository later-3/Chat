import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import { resolveChatHome } from "../../../../../../chat-home.js";
import { findFriendTurn, friendExecution, readFriendFeedback } from "../../../../../../long-agents/turn-feedback.js";
import { getLiveTurn } from "../../../../../../long-agents/live-turn.js";
export default defineEventHandler(async (event) => {
  const agent = getRouterParam(event, "longAgentId"),
    id = getRouterParam(event, "turnId", { decode: true });
  const after = getQuery(event).after;
  if (!agent || !id || typeof after !== "string" || !/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))
    throw createError({ statusCode: 400, statusMessage: "无效执行身份或事件序号" });
  const home = resolveChatHome();
  try { await findFriendTurn(home, agent, id); }
  catch { throw createError({ statusCode: 404, statusMessage: "找不到此 Friend 的执行请求" }); }
  let seq = Number(after),
    cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      const poll = async () => {
        try {
          const turn = await findFriendTurn(home, agent, id);
          if (cancelled) return;
          const live = getLiveTurn(home, id);
          if (live && (seq > live.seq || (live.events[0]?.seq ?? 1) > seq + 1)) {
            const feedback = await readFriendFeedback(home, agent, id);
            seq = feedback.snapshot.seq;
            send({ type: "reset", ...feedback });
          } else if (live) {
            for (const item of live.events)
              if (item.seq > seq) {
                send(item);
                seq = item.seq;
              }
          }
          send({ type: "status", execution: friendExecution(home, turn) });
          if (!["queued", "running"].includes(turn.status)) {
            controller.close();
            cancelled = true;
            return;
          }
          if (!cancelled) timer = setTimeout(poll, 150);
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
            cancelled = true;
          }
        }
      };
      void poll();
    },
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
