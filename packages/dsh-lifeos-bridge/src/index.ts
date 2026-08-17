import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-workspace";
import { isAbsolute, resolve } from "node:path";
import { LifeosLlmAdapter, LIFEOS_PROVIDER } from "./adapter.ts";
import { LifeosBridgeService } from "./bridge-service.ts";
import { ChatProductClient, parseChatApiBaseUrl } from "./chat-client.ts";
import { assertSameOriginRequest, createLifeosRouteHandler, sendRouteError } from "./http-route.ts";
import { createPwaAssetHandler, createPwaIndexTap } from "./pwa.ts";
import { AtomicBridgeStateStore } from "./state-store.ts";
import { ExecutionTraceRecorder } from "./execution-trace-recorder.ts";

export const name = "chat-dsh-lifeos-bridge";
export const inject = ["llm", "webServer", "workspaceRegistry", "sessions"];

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
  await ctx.workspaceRegistry.create(repoRoot, "Chat");
  const state = new AtomicBridgeStateStore(statePath);
  await state.ready();
  const chat = new ChatProductClient(apiBaseUrl);
  const executionTrace = new ExecutionTraceRecorder(chat, ctx.sessions);
  let executionTraceFailures = 0;
  const recordExecutionTrace = async (
    dshSessionId: string,
    productRunId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    try {
      await executionTrace.record(dshSessionId, productRunId, signal);
      executionTraceFailures = 0;
    } catch (error) {
      executionTraceFailures += 1;
      if (executionTraceFailures === 1 || executionTraceFailures % 20 === 0) {
        ctx.logger.warn(
          `lifeos execution trace projection failed count=${String(executionTraceFailures)}`,
        );
      }
      throw error;
    }
  };
  const bridge = new LifeosBridgeService(chat, state);
  const lifetime = new AbortController();
  ctx.effect(
    () => () => {
      lifetime.abort(new DOMException("lifeos bridge unloaded", "AbortError"));
    },
    "lifeos bridge: stream lifetime",
  );
  ctx.llm.registerAdapter(
    [LIFEOS_PROVIDER],
    new LifeosLlmAdapter(chat, state, lifetime.signal, recordExecutionTrace),
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
