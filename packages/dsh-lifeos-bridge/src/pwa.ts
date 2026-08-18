import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { BridgeRequestError } from "./bridge-service.ts";

/**
 * Chat PWA 模块。
 *
 * 是什么：为固定版本 DSH Web 提供可安装 PWA 能力——覆盖上游占位 manifest、
 * 服务 Chat 品牌图标、注入 apple/mobile meta 与 Service Worker 注册脚本，
 * 并用真正的版本化 Service Worker 取代旧的“退役脚本”。
 *
 * 为什么：DSH 上游 dist 自带占位 manifest（fullscreen、仅 SVG 图标、无 SW），
 * 不满足可安装性与离线外壳要求；webserver 的 tapIndex 与具名路由是上游公开
 * 接缝，具名 exact 路由优先于 fallback dist 服务，因此可以在不修改上游 dist
 * 的前提下覆盖 /manifest.webmanifest 与 /sw.js。
 *
 * 怎样失败：图标目录缺失时路由返回 500 而不是静默 octet-stream；SW 只缓存
 * 同源版本化静态外壳，/api、/lifeos 与 WebSocket 永不进入缓存，离线时导航
 * 回退到缓存外壳或内置离线页，绝不伪造在线状态。
 */

export const PWA_CACHE_VERSION = "chat-pwa-v1";

/** Service Worker 脚本。activate 只清理Chat拥有的当前/历史PWA缓存命名空间。 */
export const PWA_SERVICE_WORKER_SCRIPT = `
const CACHE = ${JSON.stringify(`chat-pwa-shell-${PWA_CACHE_VERSION}`)};
const OWNED_CACHE_PREFIXES = ["chat-pwa-shell-", "workbox-precache-"];
const RUNTIME_PREFIXES = ["/assets/", "/pwa/icons/"];
const RUNTIME_EXACT = new Set(["/favicon.svg", "/manifest.webmanifest", "/pwa/register.js"]);
const OFFLINE_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chat - 离线</title></head><body style="font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><main style="text-align:center"><h1>当前离线</h1><p>Chat 需要连接才能继续。恢复网络后请刷新。</p></main></body></html>';

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await self.caches.keys();
    // 只清理Chat当前/历史PWA拥有的命名空间。DSH或未来插件的同源Cache
    // 不属于本Service Worker，不能因Chat版本升级被越界删除。
    await Promise.all(keys
      .filter((key) => key !== CACHE && OWNED_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
      .map((key) => self.caches.delete(key)));
    await self.clients.claim();
  })());
});

function isRuntimeAsset(url) {
  return RUNTIME_EXACT.has(url.pathname) || RUNTIME_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // /api、/lifeos 与升级请求永不进入缓存：离线必须表现为明确失败，不是假在线。
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/lifeos")) return;

  if (isRuntimeAsset(url)) {
    event.respondWith((async () => {
      const cache = await self.caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await self.caches.open(CACHE);
      try {
        const response = await fetch(request);
        // 只缓存真正的应用外壳；登录页与重定向不进入外壳缓存。
        const finalUrl = new URL(response.url || request.url);
        if (response.ok && !response.redirected && !finalUrl.pathname.startsWith("/login")) {
          await cache.put("/", response.clone());
        }
        return response;
      } catch (error) {
        const shell = await cache.match("/");
        if (shell) return shell;
        return new Response(OFFLINE_PAGE, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    })());
  }
});
`.trimStart();

/** 注入到 DSH index.html 的 PWA 标签；registration 走外部脚本，不依赖内联 CSP 放行。 */
export const PWA_INDEX_TAGS = [
  '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF" />',
  '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000" />',
  '<meta name="mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
  '<meta name="apple-mobile-web-app-title" content="Chat" />',
  '<link rel="icon" href="/pwa/icons/icon.svg" type="image/svg+xml" />',
  '<link rel="icon" href="/pwa/icons/favicon-32.png" sizes="32x32" type="image/png" />',
  '<link rel="apple-touch-icon" href="/pwa/icons/apple-touch-icon.png" />',
  '<script defer src="/pwa/register.js"></script>',
].join("\n    ");

export const PWA_REGISTER_SCRIPT = `
window.addEventListener("load", () => {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
});
`.trimStart();

export function pwaManifestBody(): string {
  return JSON.stringify({
    id: "/",
    name: "Chat",
    short_name: "Chat",
    description: "以对话为入口、由用户持续看护、能够长期推进工作的 AI 协作产品。",
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#FFFFFF",
    background_color: "#1D1D1F",
    icons: [
      { src: "/pwa/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/pwa/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  });
}

/**
 * 视口合同：viewport-fit=cover 让布局延伸到刘海区（配合 safe-area-inset），
 * interactive-widget=resizes-content 让软键盘弹出时缩小可视区域而不是推走 Composer。
 */
export const MOBILE_VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";

/**
 * webserver tapIndex 转换：先升级视口合同，再在 </head> 前注入一次 PWA 标签；
 * 重复注入直接抛错防呆。
 * 事故教训（2026-08-17）：closing 必须在 viewport 替换之后的结果串上计算——
 * 替换改变字符串长度，用替换前下标切割会把注入点插进主样式表标签内部，
 * 导致上游 CSS 整体丢失。单元测试必须校验 HTML 完整性，不能只断言标签存在。
 */
export function createPwaIndexTap(): (html: string) => string {
  return (html) => {
    if (html.includes("/pwa/register.js")) {
      throw new Error("PWA index tags already injected");
    }
    if (html.indexOf("</head>") === -1) {
      throw new Error("index.html is missing </head>");
    }
    // 上游 viewport 只有 width/initial-scale；移动端需要 viewport-fit 与键盘合同。
    const result = html.replace(
      /<meta name="viewport" content="[^"]*" \/>/u,
      `<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}" />`,
    );
    if (!result.includes(MOBILE_VIEWPORT_CONTENT)) {
      throw new Error("index.html viewport meta not upgraded");
    }
    const closing = result.indexOf("</head>");
    if (closing === -1) {
      throw new Error("index.html is missing </head>");
    }
    return `${result.slice(0, closing)}    ${PWA_INDEX_TAGS}\n  ${result.slice(closing)}`;
  };
}

const ICON_CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

const ICON_FILES = new Set([
  "icon.svg",
  "icon-maskable.svg",
  "favicon-32.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
]);

function assetsDir(): string {
  // 构建产物在 dist/、测试直跑 src/，两者相对包根的 assets/ 都是同一位置。
  const here = dirname(fileURLToPath(import.meta.url));
  return normalize(join(here, "..", "assets", "icons"));
}

interface PwaResponse {
  body: string | Buffer;
  contentType: string;
  etag: string;
  immutable: boolean;
}

/** 解析 /pwa/* 静态响应；未知路径返回 undefined 由调用方回答 404。 */
export function resolvePwaAsset(pathname: string): PwaResponse | undefined {
  if (pathname === "/manifest.webmanifest") {
    const body = pwaManifestBody();
    return {
      body,
      contentType: "application/manifest+json; charset=utf-8",
      etag: etagOf(body),
      immutable: false,
    };
  }
  if (pathname === "/sw.js") {
    return {
      body: PWA_SERVICE_WORKER_SCRIPT,
      contentType: "application/javascript; charset=utf-8",
      etag: etagOf(PWA_SERVICE_WORKER_SCRIPT),
      immutable: false,
    };
  }
  if (pathname === "/pwa/register.js") {
    return {
      body: PWA_REGISTER_SCRIPT,
      contentType: "application/javascript; charset=utf-8",
      etag: etagOf(PWA_REGISTER_SCRIPT),
      immutable: false,
    };
  }
  const iconMatch = /^\/pwa\/icons\/([a-z0-9.-]+)$/u.exec(pathname);
  if (iconMatch !== null) {
    const name = iconMatch[1] ?? "";
    if (!ICON_FILES.has(name)) return undefined;
    const extension = name.slice(name.lastIndexOf("."));
    const contentType = ICON_CONTENT_TYPES.get(extension);
    if (contentType === undefined) return undefined;
    const body = readFileSync(join(assetsDir(), name));
    return { body, contentType, etag: etagOf(body), immutable: true };
  }
  return undefined;
}

function etagOf(body: string | Buffer): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
}

/**
 * 创建 PWA 静态路由处理函数。调用方必须先完成同源守卫；
 * manifest 与 SW 每次重验证（no-cache），带版本指纹的图标长缓存。
 */
export function createPwaAssetHandler(): (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void {
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      res.statusCode = 405;
      res.end();
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://pwa.invalid").pathname;
    let asset: PwaResponse | undefined;
    try {
      asset = resolvePwaAsset(pathname);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(`PWA asset unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    if (asset === undefined) {
      throw new BridgeRequestError(404, "pwa_asset_not_found", "PWA asset is not found");
    }
    const body = typeof asset.body === "string" ? Buffer.from(asset.body) : asset.body;
    res.statusCode = 200;
    res.setHeader("content-type", asset.contentType);
    res.setHeader(
      "cache-control",
      asset.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
    res.setHeader("etag", asset.etag);
    res.setHeader("x-content-type-options", "nosniff");
    if (pathname === "/sw.js") {
      // SW 作用域必须覆盖整个 Origin；缺少该头时注册会被浏览器限制在脚本所在目录。
      res.setHeader("service-worker-allowed", "/");
    }
    res.setHeader("content-length", body.byteLength);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  };
}
