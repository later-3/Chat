import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import { getRun } from "workflow/api";
import { localTimestamp } from "../../runtime-log.js";

/** 取消指定Workflow Run；Pi Web的停止按钮调用这个接口。 */
export default defineEventHandler(async (event) => {
  const runId = getRouterParam(event, "runId");
  if (!runId) throw createError({ statusCode: 400, statusMessage: "缺少runId" });

  try {
    await getRun(runId).cancel();
    console.log(`${localTimestamp()} [workflow] cancelled runId=${runId}`);
    return { runId, status: "cancelled" as const };
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
