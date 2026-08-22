/**
 * registerNoteRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  productRunIdSchema,
  noteIdSchema,
  listNotesQuerySchema,
  getNoteHistoryQuerySchema,
  reviseNotePayloadSchema,
  archiveNotePayloadSchema,
  restoreNotePayloadSchema,
  submitNoteDecisionPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  notFound,
  listNotes,
  getNote,
  getNoteHistory,
  getCurrentNoteCandidate,
  reviseNote,
  archiveNote,
  restoreNote,
  submitNoteDecision,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  strictQueryParams,
  parseOptionalPositiveInteger,
  privateEtagJson,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerNoteRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
  router.get("/notes", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["cursor", "limit", "kind", "tagKey", "status"],
        "Note列表查询",
      );
      const limit = parseOptionalPositiveInteger(params, "limit", "Note列表limit");
      const query = listNotesQuerySchema.parse({
        ...(params.get("cursor") !== null ? { cursor: params.get("cursor") } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(params.get("kind") !== null ? { kind: params.get("kind") } : {}),
        ...(params.get("tagKey") !== null ? { tagKey: params.get("tagKey") } : {}),
        ...(params.get("status") !== null ? { status: params.get("status") } : {}),
      });
      const result = await listNotes(ctx.deps, { principalId: ctx.principalId, query });
      return privateEtagJson(c, "notes-list", result.notes);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/notes/:noteId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const noteId = noteIdSchema.parse(c.req.param("noteId"));
      const result = await getNote(ctx.deps, { principalId: ctx.principalId, noteId });
      return privateEtagJson(c, "note-detail", result.note);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/notes/:noteId/history", async (c) => {
    try {
      const noteId = noteIdSchema.parse(c.req.param("noteId"));
      const params = strictQueryParams(c.req.url, ["cursor", "limit"], "Note历史查询");
      const limit = parseOptionalPositiveInteger(params, "limit", "Note历史limit");
      const query = getNoteHistoryQuerySchema.parse({
        ...(params.get("cursor") !== null ? { cursor: params.get("cursor") } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const result = await getNoteHistory(ctx.deps, {
        principalId: ctx.principalId,
        noteId,
        query,
      });
      return privateEtagJson(c, "note-history", result.history);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/notes/:noteId/revisions", async (c) => {
    try {
      const noteId = noteIdSchema.parse(c.req.param("noteId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Note Revision Command必须携带expectedRevision",
        });
      }
      const payload = reviseNotePayloadSchema.parse(envelope.payload);
      const result = await reviseNote(ctx.deps, {
        principalId: ctx.principalId,
        noteId,
        commandId: envelope.commandId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/notes/:noteId/revisions",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/notes/:noteId/archive", async (c) => {
    try {
      const noteId = noteIdSchema.parse(c.req.param("noteId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Archive Note Command必须携带expectedRevision",
        });
      }
      const payload = archiveNotePayloadSchema.parse(envelope.payload);
      const result = await archiveNote(ctx.deps, {
        principalId: ctx.principalId,
        noteId,
        commandId: envelope.commandId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/notes/:noteId/restore", async (c) => {
    try {
      const noteId = noteIdSchema.parse(c.req.param("noteId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Restore Note Command必须携带expectedRevision",
        });
      }
      const payload = restoreNotePayloadSchema.parse(envelope.payload);
      const result = await restoreNote(ctx.deps, {
        principalId: ctx.principalId,
        noteId,
        commandId: envelope.commandId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/note-candidates/current", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getCurrentNoteCandidate(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
      });
      if (result.candidate === null) throw notFound("当前Note Candidate不存在");
      return privateEtagJson(c, "note-candidate", result.candidate);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/runs/:productRunId/note-decisions", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "提交Note Decision必须携带expectedRevision",
        });
      }
      const payload = submitNoteDecisionPayloadSchema.parse(envelope.payload);
      if (payload.productRunId !== productRunId) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "URL中的Product Run与payload不一致",
        });
      }
      const result = await submitNoteDecision(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        expectedRunRevision: envelope.expectedRevision,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/runs/:productRunId/note-decisions",
        statusCode: 201,
        productRunId: payload.productRunId,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });
}
