import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-workspace";
import { isAbsolute, resolve } from "node:path";
import { LifeosLlmAdapter, LIFEOS_PROVIDER } from "./adapter.ts";
import { LifeosBridgeService } from "./bridge-service.ts";
import { ChatProductClient, parseChatApiBaseUrl } from "./chat-client.ts";
import { createLifeosRouteHandler, createServiceWorkerRetirementHandler } from "./http-route.ts";
import { AtomicBridgeStateStore } from "./state-store.ts";

export const name = "chat-dsh-lifeos-bridge";
export const inject = ["llm", "webServer", "workspaceRegistry"];

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
  await ctx.workspaceRegistry.create(repoRoot, "Chat");
  const state = new AtomicBridgeStateStore(statePath);
  await state.ready();
  const chat = new ChatProductClient(apiBaseUrl);
  const bridge = new LifeosBridgeService(chat, state);
  const lifetime = new AbortController();
  ctx.effect(
    () => () => {
      lifetime.abort(new DOMException("lifeos bridge unloaded", "AbortError"));
    },
    "lifeos bridge: stream lifetime",
  );
  ctx.llm.registerAdapter([LIFEOS_PROVIDER], new LifeosLlmAdapter(chat, state, lifetime.signal));
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/lifeos",
        handler: createLifeosRouteHandler(bridge, webPort, (error) => {
          ctx.logger.warn("lifeos bridge route failed", error);
        }),
      }),
    "lifeos bridge: same-origin routes",
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/sw.js",
        handler: createServiceWorkerRetirementHandler(webPort),
      }),
    "lifeos bridge: retire legacy service worker",
  );
}
