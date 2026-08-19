import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decisionRequestSchema,
  dshSessionIdSchema,
  noteDecisionRequestSchema,
  promptReviewDecisionRequestSchema,
  workflowSelectionRequestSchema,
} from "./contracts.ts";
import { BridgeRequestError, LifeosBridgeService } from "./bridge-service.ts";
import { ChatProductApiError } from "./chat-client.ts";
import { DshSessionHistoryAccessError } from "./dsh-session-history.ts";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const SESSION_PATH = /^\/lifeos\/sessions\/([^/]+)$/;
const CONTEXT_INJECTIONS_PATH = /^\/lifeos\/sessions\/([^/]+)\/context-injections$/;
const DECISION_PATH = /^\/lifeos\/sessions\/([^/]+)\/decisions$/;
const NOTE_DECISION_PATH = /^\/lifeos\/sessions\/([^/]+)\/note-decisions$/;
const PROMPT_REVIEW_DECISION_PATH = /^\/lifeos\/sessions\/([^/]+)\/prompt-review-decisions$/;
const WORKFLOW_SELECTION_PATH = /^\/lifeos\/sessions\/([^/]+)\/workflow-selection$/;
const SESSION_RECORDS_PATH = /^\/lifeos\/sessions\/([^/]+)\/records$/;
const SESSION_RECORDS_CHAT_PATH = /^\/lifeos\/sessions\/([^/]+)\/records\/chat$/;
const SESSION_RECORDS_DSH_PATH = /^\/lifeos\/sessions\/([^/]+)\/records\/dsh$/;
const WORKFLOWS_PATH = /^\/lifeos\/workflows$/;
const SESSION_RECORDS_DEFAULT_LIMIT = 50;
const SESSION_RECORDS_MAX_LIMIT = 100;

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 同源守卫。默认只接受受管 loopback 端口；服务器部署模式下额外接受配置的
 * 公开主机名（Cloudflare→Nginx 终结 TLS 后以 `Host: <publicHostname>` 到达，
 * Origin 必须是 `https://<publicHostname>`）。公开主机名绝不来自请求或上行
 * 头，只能来自组合期环境变量。
 */
export function assertSameOriginRequest(
  req: IncomingMessage,
  expectedPort: number,
  publicHostname?: string,
): string {
  const host = headerValue(req.headers.host);
  if (host === undefined) {
    throw new BridgeRequestError(400, "lifeos_host_required", "Host header is required");
  }
  let authority: URL;
  try {
    authority = new URL(`http://${host}`);
  } catch {
    throw new BridgeRequestError(400, "lifeos_host_invalid", "Host header is invalid");
  }
  if (
    authority.username !== "" ||
    authority.password !== "" ||
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== ""
  ) {
    throw new BridgeRequestError(400, "lifeos_host_invalid", "Host header is invalid");
  }
  const isLoopback =
    authority.port === String(expectedPort) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname);
  const isPublic =
    publicHostname !== undefined &&
    authority.hostname === publicHostname &&
    (authority.port === "" || authority.port === "443");
  if (!isLoopback && !isPublic) {
    throw new BridgeRequestError(403, "lifeos_host_forbidden", "LifeOS route is loopback-only");
  }
  const fetchSite = headerValue(req.headers["sec-fetch-site"]);
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new BridgeRequestError(403, "lifeos_cross_site_forbidden", "Cross-site request rejected");
  }
  const origin = headerValue(req.headers.origin);
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new BridgeRequestError(403, "lifeos_origin_forbidden", "Origin header is invalid");
    }
    // 公网主机名以 HTTPS 到达，Origin 使用 https scheme；loopback 保持 http。
    const expectedOrigin = isPublic
      ? `https://${authority.hostname}${authority.port === "" ? "" : `:${authority.port}`}`
      : authority.origin;
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.origin !== expectedOrigin
    ) {
      throw new BridgeRequestError(403, "lifeos_origin_forbidden", "Origin must match Host");
    }
  }
  return host;
}

function sessionIdFrom(match: RegExpExecArray): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1] ?? "");
  } catch {
    throw new BridgeRequestError(400, "lifeos_session_invalid", "Session id is invalid");
  }
  if (!dshSessionIdSchema.safeParse(decoded).success) {
    throw new BridgeRequestError(400, "lifeos_session_invalid", "Session id is invalid");
  }
  return decoded;
}

function singleQueryValue(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) {
    throw new BridgeRequestError(
      400,
      "lifeos_session_records_query_invalid",
      `Query参数${key}不得重复`,
    );
  }
  return values[0];
}

function recordsLimit(params: URLSearchParams): number {
  const raw = singleQueryValue(params, "limit");
  if (raw === undefined) return SESSION_RECORDS_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new BridgeRequestError(
      400,
      "lifeos_session_records_query_invalid",
      `limit必须是1到${String(SESSION_RECORDS_MAX_LIMIT)}的整数`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > SESSION_RECORDS_MAX_LIMIT) {
    throw new BridgeRequestError(
      400,
      "lifeos_session_records_query_invalid",
      `limit必须是1到${String(SESSION_RECORDS_MAX_LIMIT)}的整数`,
    );
  }
  return value;
}

function assertOnlyQueryKeys(params: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const key of params.keys()) {
    if (!allowed.has(key)) {
      throw new BridgeRequestError(
        400,
        "lifeos_session_records_query_invalid",
        `未知Query参数：${key}`,
      );
    }
  }
}

export function parseSessionRecordsChatQuery(url: URL): {
  cursor?: string;
  limit: number;
} {
  assertOnlyQueryKeys(url.searchParams, new Set(["cursor", "limit"]));
  const cursor = singleQueryValue(url.searchParams, "cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 512)) {
    throw new BridgeRequestError(
      400,
      "lifeos_session_records_query_invalid",
      "cursor必须是非空的不透明分页标记",
    );
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit: recordsLimit(url.searchParams),
  };
}

export function parseSessionRecordsDshQuery(url: URL): {
  afterSeq?: number;
  limit: number;
} {
  assertOnlyQueryKeys(url.searchParams, new Set(["afterSeq", "limit"]));
  const raw = singleQueryValue(url.searchParams, "afterSeq");
  if (raw !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new BridgeRequestError(
      400,
      "lifeos_session_records_query_invalid",
      "afterSeq必须是非负安全整数",
    );
  }
  const afterSeq = raw === undefined ? undefined : Number(raw);
  if (afterSeq !== undefined && !Number.isSafeInteger(afterSeq)) {
    throw new BridgeRequestError(
      400,
      "lifeos_session_records_query_invalid",
      "afterSeq必须是非负安全整数",
    );
  }
  return {
    ...(afterSeq === undefined ? {} : { afterSeq }),
    limit: recordsLimit(url.searchParams),
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = headerValue(req.headers["content-type"]);
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new BridgeRequestError(
      415,
      "lifeos_content_type_invalid",
      "Content-Type must be application/json",
    );
  }
  const length = headerValue(req.headers["content-length"]);
  if (length !== undefined) {
    const parsed = Number(length);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_REQUEST_BODY_BYTES) {
      throw new BridgeRequestError(413, "lifeos_body_too_large", "Request body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new BridgeRequestError(413, "lifeos_body_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BridgeRequestError(400, "lifeos_json_invalid", "Request body must be valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

export function sendRouteError(res: ServerResponse, error: unknown): void {
  sendError(res, error);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof BridgeRequestError) {
    sendJson(res, error.status, {
      type: "about:blank",
      title: error.message,
      status: error.status,
      code: error.code,
      retryable: false,
    });
    return;
  }
  if (error instanceof ChatProductApiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    sendJson(res, status, {
      type: "about:blank",
      title: error.message,
      status,
      code: error.code,
      retryable: error.retryable,
      ...(error.recoveryAction === undefined ? {} : { recoveryAction: error.recoveryAction }),
    });
    return;
  }
  if (error instanceof DshSessionHistoryAccessError) {
    sendJson(res, error.status, {
      type: "about:blank",
      title: error.message,
      status: error.status,
      code: error.code,
      retryable: false,
    });
    return;
  }
  sendJson(res, 502, {
    type: "about:blank",
    title: "LifeOS bridge request failed",
    status: 502,
    code: "lifeos_bridge_failed",
    retryable: true,
  });
}

export function createLifeosRouteHandler(
  service: LifeosBridgeService,
  expectedPort: number,
  reportError: (error: unknown) => void = () => undefined,
  publicHostname?: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const host = assertSameOriginRequest(req, expectedPort, publicHostname);
      const url = new URL(req.url ?? "", `http://${host}`);
      const recordsMatch = SESSION_RECORDS_PATH.exec(url.pathname);
      if (req.method === "GET" && recordsMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        sendJson(res, 200, await service.sessionRecordsOverview(sessionIdFrom(recordsMatch)));
        return;
      }
      const chatRecordsMatch = SESSION_RECORDS_CHAT_PATH.exec(url.pathname);
      if (req.method === "GET" && chatRecordsMatch !== null) {
        const query = parseSessionRecordsChatQuery(url);
        sendJson(
          res,
          200,
          await service.sessionRecordsChatPage(
            sessionIdFrom(chatRecordsMatch),
            query.cursor,
            query.limit,
          ),
        );
        return;
      }
      const dshRecordsMatch = SESSION_RECORDS_DSH_PATH.exec(url.pathname);
      if (req.method === "GET" && dshRecordsMatch !== null) {
        const query = parseSessionRecordsDshQuery(url);
        sendJson(
          res,
          200,
          await service.sessionRecordsDshPage(
            sessionIdFrom(dshRecordsMatch),
            query.afterSeq,
            query.limit,
          ),
        );
        return;
      }
      if (url.search !== "") {
        throw new BridgeRequestError(
          400,
          "lifeos_query_forbidden",
          "Query parameters are not accepted",
        );
      }
      const getMatch = SESSION_PATH.exec(url.pathname);
      if (req.method === "GET" && getMatch !== null) {
        sendJson(res, 200, await service.projection(sessionIdFrom(getMatch)));
        return;
      }
      const contextInjectionsMatch = CONTEXT_INJECTIONS_PATH.exec(url.pathname);
      if (req.method === "GET" && contextInjectionsMatch !== null) {
        sendJson(res, 200, service.contextInjections(sessionIdFrom(contextInjectionsMatch)));
        return;
      }
      const decisionMatch = DECISION_PATH.exec(url.pathname);
      if (req.method === "POST" && decisionMatch !== null) {
        const parsed = decisionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_decision_invalid", "Decision body is invalid");
        }
        sendJson(res, 200, await service.decide(sessionIdFrom(decisionMatch), parsed.data));
        return;
      }
      const noteDecisionMatch = NOTE_DECISION_PATH.exec(url.pathname);
      if (req.method === "POST" && noteDecisionMatch !== null) {
        const parsed = noteDecisionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_note_decision_invalid",
            "Note Decision body is invalid",
          );
        }
        sendJson(res, 200, await service.decideNote(sessionIdFrom(noteDecisionMatch), parsed.data));
        return;
      }
      const promptReviewDecisionMatch = PROMPT_REVIEW_DECISION_PATH.exec(url.pathname);
      if (req.method === "POST" && promptReviewDecisionMatch !== null) {
        const parsed = promptReviewDecisionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_prompt_review_decision_invalid",
            "Prompt Review Decision body is invalid",
          );
        }
        sendJson(
          res,
          200,
          await service.decidePromptReview(sessionIdFrom(promptReviewDecisionMatch), parsed.data),
        );
        return;
      }
      const workflowsMatch = WORKFLOWS_PATH.exec(url.pathname);
      if (req.method === "GET" && workflowsMatch !== null) {
        sendJson(res, 200, await service.workflows());
        return;
      }
      const workflowSelectionMatch = WORKFLOW_SELECTION_PATH.exec(url.pathname);
      if (req.method === "PUT" && workflowSelectionMatch !== null) {
        const parsed = workflowSelectionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_workflow_selection_invalid",
            "Workflow selection body is invalid",
          );
        }
        sendJson(
          res,
          200,
          await service.selectWorkflow(
            sessionIdFrom(workflowSelectionMatch),
            parsed.data.workflowSelection,
          ),
        );
        return;
      }
      throw new BridgeRequestError(404, "lifeos_route_not_found", "LifeOS route not found");
    } catch (error) {
      if (
        !(error instanceof BridgeRequestError) &&
        !(error instanceof ChatProductApiError) &&
        !(error instanceof DshSessionHistoryAccessError)
      ) {
        reportError(error);
      }
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    }
  };
}
