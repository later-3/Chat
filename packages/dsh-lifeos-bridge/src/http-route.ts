import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decisionRequestSchema,
  dshBridgeSendPreviewRequestSchema,
  dshSendReviewDecisionRequestSchema,
  dshSendReviewSettingRequestSchema,
  bridgeChatDispatchReviewDecisionRequestSchema,
  bridgeChatDispatchReviewSettingRequestSchema,
  dshSessionIdSchema,
  noteDecisionRequestSchema,
  promptSelectionRequestSchema,
  promptReviewDecisionRequestSchema,
  projectBootstrapDecisionRequestSchema,
  workflowSelectionRequestSchema,
  saveWorkflowAgentNodeConfigurationRequestSchema,
} from "./contracts.ts";
import { BridgeRequestError, LifeosBridgeService } from "./bridge-service.ts";
import { ChatProductApiError } from "./chat-client.ts";
import { DshSessionHistoryAccessError } from "./dsh-session-history.ts";
import {
  PromptStudioBridgeService,
  agentVersionCreateRequestSchema,
  agentPromptRestoreRequestSchema,
  agentPromptReviseRequestSchema,
  promptStudioArchiveRequestSchema,
  promptStudioCopyRequestSchema,
  promptStudioConfigurationPreviewRequestSchema,
  promptStudioCreateRequestSchema,
  promptStudioPreviewRequestSchema,
  promptStudioReviseRequestSchema,
} from "./prompt-studio-bridge-service.ts";
import {
  PromptSourceFileOpenError,
  PromptSourceFileOpener,
  promptSourceOpenRequestSchema,
} from "./prompt-source-file-opener.ts";

const MAX_REQUEST_BODY_BYTES = 16 * 1024;
// Agent Version允许131072个UTF-16字符的完整System Prompt；按UTF-8最坏4字节/字符，
// 再为命令信封、标题与资源合同保留边界开销，避免Bridge拒绝Chat公开合同内的合法正文。
const MAX_PROMPT_REQUEST_BODY_BYTES = 640 * 1024;
const SESSION_PATH = /^\/lifeos\/sessions\/([^/]+)$/;
const CONTEXT_INJECTIONS_PATH = /^\/lifeos\/sessions\/([^/]+)\/context-injections$/;
const BRIDGE_SEND_PREVIEWS_PATH = /^\/lifeos\/sessions\/([^/]+)\/bridge-send-previews$/;
const DSH_SEND_REVIEW_SETTING_PATH = /^\/lifeos\/sessions\/([^/]+)\/dsh-send-review-setting$/;
const DSH_SEND_REVIEW_DECISIONS_PATH = /^\/lifeos\/sessions\/([^/]+)\/dsh-send-review-decisions$/;
const BRIDGE_DISPATCH_REVIEW_SETTING_PATH =
  /^\/lifeos\/sessions\/([^/]+)\/bridge-dispatch-review-setting$/;
const BRIDGE_DISPATCH_REVIEW_DECISIONS_PATH =
  /^\/lifeos\/sessions\/([^/]+)\/bridge-dispatch-review-decisions$/;
const DECISION_PATH = /^\/lifeos\/sessions\/([^/]+)\/decisions$/;
const NOTE_DECISION_PATH = /^\/lifeos\/sessions\/([^/]+)\/note-decisions$/;
const PROMPT_REVIEW_DECISION_PATH = /^\/lifeos\/sessions\/([^/]+)\/prompt-review-decisions$/;
const PROJECT_BOOTSTRAP_DECISION_PATH =
  /^\/lifeos\/sessions\/([^/]+)\/project-bootstrap-decisions$/;
const WORKFLOW_SELECTION_PATH = /^\/lifeos\/sessions\/([^/]+)\/workflow-selection$/;
const PROMPT_SELECTION_PATH = /^\/lifeos\/sessions\/([^/]+)\/prompt-selection$/;
const SESSION_RECORDS_PATH = /^\/lifeos\/sessions\/([^/]+)\/records$/;
const SESSION_RECORDS_CHAT_PATH = /^\/lifeos\/sessions\/([^/]+)\/records\/chat$/;
const SESSION_RECORDS_DSH_PATH = /^\/lifeos\/sessions\/([^/]+)\/records\/dsh$/;
const WORKFLOWS_PATH = /^\/lifeos\/workflows$/;
const WORKFLOW_AGENT_NODE_CONFIGURATIONS_PATH = /^\/lifeos\/workflow\/agent-node-configurations$/;
const PROJECT_BOOTSTRAP_PRESET_PATH = /^\/lifeos\/project-bootstrap\/preset$/;
const PROJECT_BOOTSTRAP_INITIALIZE_PATH =
  /^\/lifeos\/project-bootstrap\/sessions\/([^/]+)\/initialize$/;
const PROMPT_REGIONS_PATH = /^\/lifeos\/prompts\/regions$/;
const AGENT_PROFILES_PATH = /^\/lifeos\/agents$/;
const AGENT_VERSIONS_PATH = /^\/lifeos\/agents\/([^/]+)\/versions$/;
const AGENT_PROMPT_REVISIONS_PATH = /^\/lifeos\/agents\/([^/]+)\/prompt-revisions$/;
const AGENT_RESTORE_DEFAULT_PATH = /^\/lifeos\/agents\/([^/]+)\/restore-default$/;
const PROMPT_WORKSPACES_PATH = /^\/lifeos\/prompts\/workspaces$/;
const PROMPT_ASSEMBLY_PREVIEWS_PATH = /^\/lifeos\/prompts\/assembly-previews$/;
const PROMPT_CONFIGURATION_PREVIEWS_PATH = /^\/lifeos\/prompts\/configuration-previews$/;
const PROMPT_FRAGMENTS_PATH = /^\/lifeos\/prompts\/fragments$/;
const PROMPT_COPIES_PATH = /^\/lifeos\/prompts\/copies$/;
const PROMPT_FRAGMENT_PATH = /^\/lifeos\/prompts\/fragments\/([^/]+)$/;
const PROMPT_REVISION_PATH = /^\/lifeos\/prompts\/revisions\/([^/]+)$/;
const PROMPT_FRAGMENT_REVISIONS_PATH = /^\/lifeos\/prompts\/fragments\/([^/]+)\/revisions$/;
const PROMPT_FRAGMENT_ARCHIVE_PATH = /^\/lifeos\/prompts\/fragments\/([^/]+)\/archive-status$/;
const PROMPT_SOURCE_OPENERS_PATH = /^\/lifeos\/prompts\/source-openers$/;
const PROMPT_SOURCE_OPEN_PATH = /^\/lifeos\/prompts\/source-files\/open$/;
const SESSION_RECORDS_DEFAULT_LIMIT = 50;
const SESSION_RECORDS_MAX_LIMIT = 100;
const WORKSPACE_ROOT_ID = /^root_[A-Za-z0-9]+$/u;

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

function isLoopbackAuthority(host: string, expectedPort: number): boolean {
  const authority = new URL(`http://${host}`);
  return (
    authority.port === String(expectedPort) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname)
  );
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

/** Agent Profile只允许显式的单一Chat Workspace Root，缺省即全局配置。 */
export function parseAgentProfilesQuery(url: URL): { workspaceRootId?: string } {
  for (const key of url.searchParams.keys()) {
    if (key !== "workspaceRootId") {
      throw new BridgeRequestError(
        400,
        "lifeos_agent_profiles_query_invalid",
        `未知Query参数：${key}`,
      );
    }
  }
  const values = url.searchParams.getAll("workspaceRootId");
  if (values.length > 1) {
    throw new BridgeRequestError(
      400,
      "lifeos_agent_profiles_query_invalid",
      "workspaceRootId不得重复",
    );
  }
  const workspaceRootId = values[0];
  if (workspaceRootId !== undefined && !WORKSPACE_ROOT_ID.test(workspaceRootId)) {
    throw new BridgeRequestError(400, "lifeos_agent_profiles_query_invalid", "workspaceRootId非法");
  }
  return workspaceRootId === undefined ? {} : { workspaceRootId };
}

async function readJson(
  req: IncomingMessage,
  maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
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
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new BridgeRequestError(413, "lifeos_body_too_large", "Request body is too large");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
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
  if (error instanceof PromptSourceFileOpenError) {
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
  promptStudio?: PromptStudioBridgeService,
  promptSourceFiles?: PromptSourceFileOpener,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const host = assertSameOriginRequest(req, expectedPort, publicHostname);
      const url = new URL(req.url ?? "", `http://${host}`);
      // 同一生产进程可以同时服务公开域名与本机loopback。编辑器启动能力只投影给
      // loopback请求；公开域名即使通过产品认证也不能借浏览器启动服务器本机应用。
      const localPromptSourceFiles = isLoopbackAuthority(host, expectedPort)
        ? promptSourceFiles
        : undefined;
      if (req.method === "GET" && PROMPT_SOURCE_OPENERS_PATH.test(url.pathname)) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        sendJson(
          res,
          200,
          localPromptSourceFiles?.openers() ?? {
            schemaVersion: "chat-prompt-source-openers.v1",
            items: [],
          },
        );
        return;
      }
      if (req.method === "POST" && PROMPT_SOURCE_OPEN_PATH.test(url.pathname)) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        if (localPromptSourceFiles === undefined) {
          throw new BridgeRequestError(
            409,
            "lifeos_prompt_opener_unavailable",
            "当前部署不支持打开本机应用",
          );
        }
        const parsed = promptSourceOpenRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_prompt_source_open_invalid",
            "Prompt来源文件打开请求非法",
          );
        }
        sendJson(res, 202, await localPromptSourceFiles.open(parsed.data));
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "GET" &&
        PROMPT_REGIONS_PATH.test(url.pathname)
      ) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        sendJson(res, 200, await promptStudio.regions());
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "GET" &&
        AGENT_PROFILES_PATH.test(url.pathname)
      ) {
        sendJson(res, 200, await promptStudio.agents(parseAgentProfilesQuery(url)));
        return;
      }
      const agentReviseMatch = AGENT_PROMPT_REVISIONS_PATH.exec(url.pathname);
      const agentVersionCreateMatch = AGENT_VERSIONS_PATH.exec(url.pathname);
      if (promptStudio !== undefined && req.method === "POST" && agentVersionCreateMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = agentVersionCreateRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_agent_version_invalid",
            "Agent Version创建请求非法",
          );
        }
        sendJson(
          res,
          201,
          await promptStudio.createAgentVersion(
            decodeURIComponent(agentVersionCreateMatch[1] ?? ""),
            parsed.data,
          ),
        );
        return;
      }
      if (promptStudio !== undefined && req.method === "POST" && agentReviseMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = agentPromptReviseRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_agent_prompt_invalid", "Agent Prompt请求非法");
        }
        sendJson(
          res,
          200,
          await promptStudio.reviseAgent(
            decodeURIComponent(agentReviseMatch[1] ?? ""),
            parsed.data,
          ),
        );
        return;
      }
      const agentRestoreMatch = AGENT_RESTORE_DEFAULT_PATH.exec(url.pathname);
      if (promptStudio !== undefined && req.method === "POST" && agentRestoreMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = agentPromptRestoreRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_agent_restore_invalid", "Agent恢复请求非法");
        }
        sendJson(
          res,
          200,
          await promptStudio.restoreAgent(
            decodeURIComponent(agentRestoreMatch[1] ?? ""),
            parsed.data,
          ),
        );
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "GET" &&
        PROMPT_WORKSPACES_PATH.test(url.pathname)
      ) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        sendJson(res, 200, await promptStudio.workspaces());
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "POST" &&
        PROMPT_ASSEMBLY_PREVIEWS_PATH.test(url.pathname)
      ) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = promptStudioPreviewRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_prompt_preview_invalid", "Prompt预览请求非法");
        }
        sendJson(res, 200, await promptStudio.preview(parsed.data));
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "POST" &&
        PROMPT_CONFIGURATION_PREVIEWS_PATH.test(url.pathname)
      ) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = promptStudioConfigurationPreviewRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_prompt_configuration_preview_invalid",
            "Prompt配置预览请求非法",
          );
        }
        sendJson(res, 200, await promptStudio.previewConfiguration(parsed.data));
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "GET" &&
        PROMPT_FRAGMENTS_PATH.test(url.pathname)
      ) {
        assertOnlyQueryKeys(
          url.searchParams,
          new Set([
            "cursor",
            "limit",
            "regionKey",
            "ownerKind",
            "status",
            "scopeKind",
            "workspaceRootId",
          ]),
        );
        const rawLimit = singleQueryValue(url.searchParams, "limit");
        const limit = rawLimit === undefined ? undefined : Number(rawLimit);
        if (
          limit !== undefined &&
          (!/^[1-9][0-9]*$/u.test(rawLimit ?? "") || !Number.isSafeInteger(limit) || limit > 100)
        ) {
          throw new BridgeRequestError(
            400,
            "lifeos_prompt_query_invalid",
            "limit必须是1到100的整数",
          );
        }
        const cursor = singleQueryValue(url.searchParams, "cursor");
        const regionKey = singleQueryValue(url.searchParams, "regionKey");
        const ownerKind = singleQueryValue(url.searchParams, "ownerKind");
        const status = singleQueryValue(url.searchParams, "status");
        const scopeKind = singleQueryValue(url.searchParams, "scopeKind");
        const workspaceRootId = singleQueryValue(url.searchParams, "workspaceRootId");
        sendJson(
          res,
          200,
          await promptStudio.fragments({
            ...(cursor !== undefined ? { cursor } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(regionKey !== undefined ? { regionKey } : {}),
            ...(ownerKind !== undefined ? { ownerKind } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(scopeKind !== undefined ? { scopeKind } : {}),
            ...(workspaceRootId !== undefined ? { workspaceRootId } : {}),
          }),
        );
        return;
      }
      const promptFragmentMatch = PROMPT_FRAGMENT_PATH.exec(url.pathname);
      if (promptStudio !== undefined && req.method === "GET" && promptFragmentMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        sendJson(
          res,
          200,
          await promptStudio.fragment(decodeURIComponent(promptFragmentMatch[1] ?? "")),
        );
        return;
      }
      const promptRevisionMatch = PROMPT_REVISION_PATH.exec(url.pathname);
      if (promptStudio !== undefined && req.method === "GET" && promptRevisionMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        sendJson(
          res,
          200,
          await promptStudio.revision(decodeURIComponent(promptRevisionMatch[1] ?? "")),
        );
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "POST" &&
        PROMPT_FRAGMENTS_PATH.test(url.pathname)
      ) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = promptStudioCreateRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_prompt_create_invalid", "Prompt创建请求非法");
        }
        sendJson(res, 201, await promptStudio.create(parsed.data));
        return;
      }
      if (
        promptStudio !== undefined &&
        req.method === "POST" &&
        PROMPT_COPIES_PATH.test(url.pathname)
      ) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = promptStudioCopyRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_prompt_copy_invalid", "Prompt复制请求非法");
        }
        sendJson(res, 201, await promptStudio.copy(parsed.data));
        return;
      }
      const promptReviseMatch = PROMPT_FRAGMENT_REVISIONS_PATH.exec(url.pathname);
      if (promptStudio !== undefined && req.method === "POST" && promptReviseMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = promptStudioReviseRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_prompt_revise_invalid", "Prompt修订请求非法");
        }
        sendJson(
          res,
          201,
          await promptStudio.revise(decodeURIComponent(promptReviseMatch[1] ?? ""), parsed.data),
        );
        return;
      }
      const promptArchiveMatch = PROMPT_FRAGMENT_ARCHIVE_PATH.exec(url.pathname);
      if (promptStudio !== undefined && req.method === "POST" && promptArchiveMatch !== null) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = promptStudioArchiveRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(400, "lifeos_prompt_archive_invalid", "Prompt归档请求非法");
        }
        sendJson(
          res,
          200,
          await promptStudio.archive(decodeURIComponent(promptArchiveMatch[1] ?? ""), parsed.data),
        );
        return;
      }
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
      const bridgeSendPreviewMatch = BRIDGE_SEND_PREVIEWS_PATH.exec(url.pathname);
      if (req.method === "POST" && bridgeSendPreviewMatch !== null) {
        const parsed = dshBridgeSendPreviewRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_bridge_send_preview_invalid",
            "DSH Bridge发送预览请求无效",
          );
        }
        sendJson(
          res,
          200,
          await service.bridgeSendPreview(sessionIdFrom(bridgeSendPreviewMatch), parsed.data.text),
        );
        return;
      }
      const dshSendReviewSettingMatch = DSH_SEND_REVIEW_SETTING_PATH.exec(url.pathname);
      if (req.method === "PUT" && dshSendReviewSettingMatch !== null) {
        const parsed = dshSendReviewSettingRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_dsh_send_review_setting_invalid",
            "DSH发送审核开关请求无效",
          );
        }
        sendJson(
          res,
          200,
          await service.setDshSendReviewEnabled(
            sessionIdFrom(dshSendReviewSettingMatch),
            parsed.data.enabled,
          ),
        );
        return;
      }
      const dshSendReviewDecisionMatch = DSH_SEND_REVIEW_DECISIONS_PATH.exec(url.pathname);
      if (req.method === "POST" && dshSendReviewDecisionMatch !== null) {
        const parsed = dshSendReviewDecisionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_dsh_send_review_decision_invalid",
            "DSH发送审核决定无效",
          );
        }
        sendJson(
          res,
          200,
          await service.decideDshSendReview(sessionIdFrom(dshSendReviewDecisionMatch), parsed.data),
        );
        return;
      }
      const bridgeDispatchReviewSettingMatch = BRIDGE_DISPATCH_REVIEW_SETTING_PATH.exec(
        url.pathname,
      );
      if (req.method === "POST" && bridgeDispatchReviewSettingMatch !== null) {
        const parsed = bridgeChatDispatchReviewSettingRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_bridge_dispatch_review_setting_invalid",
            "Bridge出口审核开关请求无效",
          );
        }
        sendJson(
          res,
          200,
          await service.setBridgeDispatchReviewEnabled(
            sessionIdFrom(bridgeDispatchReviewSettingMatch),
            parsed.data.enabled,
          ),
        );
        return;
      }
      const bridgeDispatchReviewDecisionMatch = BRIDGE_DISPATCH_REVIEW_DECISIONS_PATH.exec(
        url.pathname,
      );
      if (req.method === "POST" && bridgeDispatchReviewDecisionMatch !== null) {
        const parsed = bridgeChatDispatchReviewDecisionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_bridge_dispatch_review_decision_invalid",
            "Bridge出口审核决定无效",
          );
        }
        sendJson(
          res,
          200,
          await service.decideBridgeDispatchReview(
            sessionIdFrom(bridgeDispatchReviewDecisionMatch),
            parsed.data,
          ),
        );
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
      const projectBootstrapDecisionMatch = PROJECT_BOOTSTRAP_DECISION_PATH.exec(url.pathname);
      if (req.method === "POST" && projectBootstrapDecisionMatch !== null) {
        const parsed = projectBootstrapDecisionRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_project_bootstrap_decision_invalid",
            "Project Bootstrap Decision body is invalid",
          );
        }
        sendJson(
          res,
          200,
          await service.decideProjectBootstrap(
            sessionIdFrom(projectBootstrapDecisionMatch),
            parsed.data,
          ),
        );
        return;
      }
      const workflowsMatch = WORKFLOWS_PATH.exec(url.pathname);
      if (req.method === "GET" && workflowsMatch !== null) {
        sendJson(res, 200, await service.workflows());
        return;
      }
      if (req.method === "POST" && WORKFLOW_AGENT_NODE_CONFIGURATIONS_PATH.test(url.pathname)) {
        if (url.search !== "") {
          throw new BridgeRequestError(
            400,
            "lifeos_query_forbidden",
            "Query parameters are not accepted",
          );
        }
        const parsed = saveWorkflowAgentNodeConfigurationRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_workflow_agent_configuration_invalid",
            "Workflow Agent配置请求非法",
          );
        }
        sendJson(res, 201, await service.saveWorkflowAgentNodeConfiguration(parsed.data));
        return;
      }
      if (req.method === "GET" && PROJECT_BOOTSTRAP_PRESET_PATH.test(url.pathname)) {
        sendJson(res, 200, await service.projectBootstrapPreset());
        return;
      }
      const projectBootstrapInitializeMatch = PROJECT_BOOTSTRAP_INITIALIZE_PATH.exec(url.pathname);
      if (req.method === "POST" && projectBootstrapInitializeMatch !== null) {
        sendJson(
          res,
          200,
          await service.initializeProjectBootstrapSession(
            sessionIdFrom(projectBootstrapInitializeMatch),
          ),
        );
        return;
      }
      const promptSelectionMatch = PROMPT_SELECTION_PATH.exec(url.pathname);
      if (req.method === "GET" && promptSelectionMatch !== null) {
        sendJson(res, 200, await service.promptSelection(sessionIdFrom(promptSelectionMatch)));
        return;
      }
      if (req.method === "PUT" && promptSelectionMatch !== null) {
        const parsed = promptSelectionRequestSchema.safeParse(
          await readJson(req, MAX_PROMPT_REQUEST_BODY_BYTES),
        );
        if (!parsed.success) {
          throw new BridgeRequestError(
            400,
            "lifeos_prompt_selection_invalid",
            "Prompt selection body is invalid",
          );
        }
        sendJson(
          res,
          200,
          await service.selectPrompt(
            sessionIdFrom(promptSelectionMatch),
            parsed.data.promptSelection,
          ),
        );
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
        !(error instanceof DshSessionHistoryAccessError) &&
        !(error instanceof PromptSourceFileOpenError)
      ) {
        reportError(error);
      }
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    }
  };
}
