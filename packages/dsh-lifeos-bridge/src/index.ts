import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session-query";
import { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-workspace";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { LifeosLlmAdapter, LIFEOS_PROVIDER } from "./adapter.ts";
import { LifeosBridgeService } from "./bridge-service.ts";
import { ChatProductClient, parseChatApiBaseUrl } from "./chat-client.ts";
import { assertSameOriginRequest, createLifeosRouteHandler, sendRouteError } from "./http-route.ts";
import { createPwaAssetHandler, createPwaIndexTap } from "./pwa.ts";
import { AtomicBridgeStateStore } from "./state-store.ts";
import { DshSessionQueryHistory } from "./dsh-session-history.ts";
import { MemoryManagementBridgeService } from "./memory-management-bridge-service.ts";
import { DshContextInjectionReader } from "./context-injection-reader.ts";
import { PromptStudioBridgeService } from "./prompt-studio-bridge-service.ts";
import { PromptSourceFileOpener } from "./prompt-source-file-opener.ts";
import { createPromptWorkspaceResolver } from "./prompt-workspace-resolver.ts";
import { DshSendReviewCoordinator } from "./dsh-send-review.ts";
import { BridgeDispatchReviewCoordinator } from "./bridge-dispatch-review.ts";
import { createDshBridgeTraceEmitter, type DshBridgeTraceEventInput } from "./debug-trace.ts";

export const name = "chat-dsh-lifeos-bridge";
export const inject = ["llm", "webServer", "workspaceRegistry", "sessionQuery", "sessions"];

function requiredStatePath(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CHAT_DSH_STATE_PATH is required for @chat/dsh-lifeos-bridge");
  }
  return raw;
}

function requiredPublicWebPort(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("CHAT_PUBLIC_WEB_PORT must be an integer from 1 to 65535");
  }
  return value;
}

/**
 * 公开主机名（服务器部署模式）。仅接受小写主机名，不带 scheme/端口/路径；
 * 未设置时所有路由只接受 loopback，与本地开发姿态一致。
 */
function optionalPublicHostname(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) || value.includes("..")) {
    throw new Error("CHAT_PUBLIC_WEB_HOSTNAME must be a bare lowercase hostname");
  }
  return value;
}

function requiredRepoRoot(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CHAT_REPO_ROOT is required for @chat/dsh-lifeos-bridge");
  }
  if (!isAbsolute(raw)) {
    throw new Error("CHAT_REPO_ROOT must be an absolute path");
  }
  return resolve(raw);
}

/** Register the lifeos/workflow LLM route and the same-origin browser projection. */
export async function apply(ctx: Context): Promise<void> {
  const repoRoot = requiredRepoRoot(process.env.CHAT_REPO_ROOT);
  const statePath = requiredStatePath(process.env.CHAT_DSH_STATE_PATH);
  const apiBaseUrl = parseChatApiBaseUrl(process.env.CHAT_API_BASE_URL);
  const webPort = requiredPublicWebPort(process.env.CHAT_PUBLIC_WEB_PORT);
  const publicHostname = optionalPublicHostname(process.env.CHAT_PUBLIC_WEB_HOSTNAME);
  const workspace = await ctx.workspaceRegistry.create(repoRoot, "Chat");
  const state = new AtomicBridgeStateStore(statePath);
  await state.ready();
  const chat = new ChatProductClient(apiBaseUrl);
  const dshHistory = new DshSessionQueryHistory(ctx.sessionQuery, workspace.path, () =>
    ctx.workspaceRegistry.archivedSessionIds.map(String),
  );
  const contextInjectionReader = new DshContextInjectionReader({
    get: (dshSessionId) => ctx.sessions.get(SessionId(dshSessionId)),
  });
  const promptWorkspaceResolver = await createPromptWorkspaceResolver(
    ctx.workspaceRegistry,
    process.env,
  );
  const bridgeRef: { current?: LifeosBridgeService } = {};
  const dshSendReview = new DshSendReviewCoordinator(
    state,
    async (dshSessionId, text, adapterRequest) => {
      if (bridgeRef.current === undefined) {
        throw new Error("LifeOS Bridge 尚未完成初始化，不能生成 DSH 发送预览");
      }
      return await bridgeRef.current.bridgeSendPreview(dshSessionId, text, adapterRequest);
    },
  );
  const bridgeDispatchReview = new BridgeDispatchReviewCoordinator(state);
  const dshTraceEmitter = createDshBridgeTraceEmitter({ scope: "dsh", repoRoot });
  const bridgeTraceEmitter = createDshBridgeTraceEmitter({ scope: "bridge", repoRoot });
  let traceFailures = 0;
  const safeTrace = (
    owner: "dsh" | "bridge",
    emit: ((event: DshBridgeTraceEventInput) => void) | undefined,
  ) =>
    emit === undefined
      ? undefined
      : (event: DshBridgeTraceEventInput) => {
          try {
            emit(event);
          } catch {
            traceFailures += 1;
            ctx.logger.warn(`[trace] emit_failed owner=${owner} total=${String(traceFailures)}`);
          }
        };
  const dshTrace = safeTrace("dsh", dshTraceEmitter);
  const bridgeTrace = safeTrace("bridge", bridgeTraceEmitter);
  const bridge = new LifeosBridgeService(
    chat,
    state,
    dshHistory,
    contextInjectionReader,
    promptWorkspaceResolver,
    dshSendReview,
    bridgeDispatchReview,
  );
  bridgeRef.current = bridge;
  const promptStudio = new PromptStudioBridgeService(chat);
  const memoryManagement = new MemoryManagementBridgeService(chat);
  // 来源文件属于Chat代码Catalog，不跟随未来可切换的工作对象Workspace。能力可以与
  // 公开服务同进程装配，但HTTP边界只向loopback请求投影，公网浏览器永远不可调用。
  const promptSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const promptSourceFiles = await PromptSourceFileOpener.create({
    repoRoot: promptSourceRoot,
    env: process.env,
  });
  const lifetime = new AbortController();
  ctx.effect(
    () => () => {
      dshSendReview.close();
      bridgeDispatchReview.close();
      lifetime.abort(new DOMException("lifeos bridge unloaded", "AbortError"));
    },
    "lifeos bridge: stream lifetime",
  );
  ctx.llm.registerAdapter(
    [LIFEOS_PROVIDER],
    new LifeosLlmAdapter(
      chat,
      state,
      lifetime.signal,
      promptWorkspaceResolver,
      dshSendReview,
      bridgeDispatchReview,
      dshTrace,
      bridgeTrace,
    ),
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/lifeos",
        handler: createLifeosRouteHandler(
          bridge,
          webPort,
          (error) => {
            ctx.logger.warn("lifeos bridge route failed", error);
          },
          publicHostname,
          promptStudio,
          promptSourceFiles,
          memoryManagement,
        ),
      }),
    "lifeos bridge: same-origin routes",
  );
  // PWA：具名路由优先于 DSH fallback dist 服务，因此 /manifest.webmanifest 与
  // /sw.js 在不修改上游 dist 的前提下被 Chat 版本覆盖；tapIndex 是上游公开的
  // index 转换接缝。历史 apps/web PWA 的 workbox 缓存由新 SW 的 activate 清理。
  const pwaHandler = createPwaAssetHandler();
  const guardedPwaHandler: typeof pwaHandler = (req, res) => {
    try {
      assertSameOriginRequest(req, webPort, publicHostname);
    } catch (error) {
      if (!res.headersSent) sendRouteError(res, error);
      else res.destroy();
      return;
    }
    try {
      pwaHandler(req, res);
    } catch (error) {
      if (!res.headersSent) sendRouteError(res, error);
      else res.destroy();
    }
  };
  ctx.effect(() => ctx.webServer.tapIndex(createPwaIndexTap()), "lifeos bridge: pwa index tags");
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/manifest.webmanifest",
        handler: guardedPwaHandler,
      }),
    "lifeos bridge: pwa manifest",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/sw.js", handler: guardedPwaHandler }),
    "lifeos bridge: pwa service worker",
  );
  ctx.effect(
    () => ctx.webServer.register({ kind: "prefix", path: "/pwa", handler: guardedPwaHandler }),
    "lifeos bridge: pwa assets",
  );
}
