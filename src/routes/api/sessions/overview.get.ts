import { createHash } from "node:crypto";
import { defineEventHandler, getHeader, setResponseHeader, setResponseStatus } from "nitro/h3";
import { listProjects } from "../../../projects/registry.js";
import { listChatSessions } from "../../../session-read-model.js";
import { readSessionOwnershipFacts } from "../../../session-owner.js";

/** One browser roster read, one authority snapshot; native metadata is revalidated on every request. */
export default defineEventHandler(async event => {
  const [projects, ownership] = await Promise.all([listProjects(), readSessionOwnershipFacts()]);
  const pages = await Promise.all(projects.filter(project => project.available)
    .map(project => listChatSessions(project.projectId, undefined, ownership)));
  const body = { projects, sessions: pages.flat(), runningSessionIds: ownership.state.turns
    .filter(turn => turn.status === "queued" || turn.status === "running").map(turn => turn.sessionId) };
  const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex")}"`;
  setResponseHeader(event, "Cache-Control", "private, no-cache");
  setResponseHeader(event, "ETag", etag);
  if (getHeader(event, "if-none-match") === etag) { setResponseStatus(event, 304); return null; }
  return body;
});
