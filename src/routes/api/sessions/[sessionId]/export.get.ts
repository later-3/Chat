import {
  createError,
  defineEventHandler,
  getQuery,
  getRouterParam,
} from "nitro/h3";
import { exportChatSessionHtml } from "../../../../session-export.js";
import { requireChatSession } from "../../../../session-read-model.js";
import { SessionLifecycleError } from "../../../../session-errors.js";
import { toSessionLifecycleHttpError } from "../../../../session-removal-http.js";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "pi-session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export default defineEventHandler(async (event) => {
  const sessionId = getRouterParam(event, "sessionId");
  if (!sessionId) throw createError({ statusCode: 400, statusMessage: "缺少sessionId" });
  const query = getQuery(event);
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;

  let session;
  try {
    session = await requireChatSession(sessionId, projectId);
  } catch (error) {
    if (error instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(error);
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const exported = await exportChatSessionHtml(session.path);
    const inline = query.inline === "1";
    return new Response(exported.html, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": contentDisposition(exported.fileName, inline),
        "Content-Security-Policy": "frame-ancestors 'self'",
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
      },
    });
  } catch (error) {
    try {
      await requireChatSession(sessionId, projectId);
    } catch (stateError) {
      if (stateError instanceof SessionLifecycleError) throw toSessionLifecycleHttpError(stateError);
    }
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
