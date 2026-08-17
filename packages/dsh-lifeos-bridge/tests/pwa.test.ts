import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import test from "node:test";

import {
  createPwaAssetHandler,
  createPwaIndexTap,
  pwaManifestBody,
  PWA_CACHE_VERSION,
  PWA_SERVICE_WORKER_SCRIPT,
  resolvePwaAsset,
} from "../src/pwa.ts";

async function getPwaAsset(path: string): Promise<{
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}> {
  const server = createServer(createPwaAssetHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  try {
    return await new Promise((resolve, reject) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port: address.port, path, method: "GET" },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

test("manifest carries Chat identity and installable PNG icons", () => {
  const manifest = JSON.parse(pwaManifestBody()) as {
    name: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  assert.equal(manifest.name, "Chat");
  assert.equal(manifest.display, "standalone");
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192"));
  assert.ok(sizes.includes("512x512"));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    assert.ok(
      resolvePwaAsset(icon.src) !== undefined,
      `manifest icon must be served by the bridge: ${icon.src}`,
    );
  }
});

test("/sw.js is a versioned shell-cache worker that never caches api or lifeos", async () => {
  const response = await getPwaAsset("/sw.js");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/javascript; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-cache");
  assert.equal(response.headers["service-worker-allowed"], "/");
  const body = response.body.toString("utf8");
  assert.match(body, /chat-pwa-shell-/u);
  // activate 清理所有非当前缓存，保留旧 apps/web workbox 的退役语义。
  assert.match(body, /caches\.keys/u);
  assert.match(body, /caches\.delete/u);
  assert.match(body, /clients\.claim/u);
  // 产品 API、bridge 路由与凭据永不进入 Service Worker。
  assert.match(body, /startsWith\("\/api"\)/u);
  assert.match(body, /startsWith\("\/lifeos"\)/u);
  assert.doesNotMatch(body, /indexedDB|localStorage|sessionStorage|cookie/iu);
});

test("/manifest.webmanifest revalidates every load with the correct MIME", async () => {
  const response = await getPwaAsset("/manifest.webmanifest");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/manifest+json; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-cache");
});

test("icons are immutable long-cache assets with real bytes", async () => {
  for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    const response = await getPwaAsset(`/pwa/icons/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers["content-type"], "image/png");
    assert.match(String(response.headers["cache-control"]), /immutable/u);
    assert.ok(response.body.byteLength > 500, `${name} must not be empty`);
    // PNG magic bytes
    assert.equal(response.body.subarray(0, 4).toString("hex"), "89504e47");
  }
});

test("unknown pwa paths are rejected and traversal is impossible", () => {
  assert.equal(resolvePwaAsset("/pwa/icons/../secrets"), undefined);
  assert.equal(resolvePwaAsset("/pwa/icons/%2e%2e"), undefined);
  assert.equal(resolvePwaAsset("/pwa/icons/unknown.png"), undefined);
  assert.equal(resolvePwaAsset("/api/sessions"), undefined);
});

test("index tap upgrades viewport and injects PWA+mobile tags exactly once", () => {
  const tap = createPwaIndexTap();
  const html =
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /><link rel="manifest" href="/manifest.webmanifest" /></head><body></body></html>';
  const injected = tap(html);
  assert.match(injected, /apple-mobile-web-app-capable/u);
  assert.match(injected, /apple-touch-icon/u);
  assert.match(injected, /\/pwa\/register\.js/u);
  assert.match(injected, /\/pwa\/mobile\.css/u);
  assert.match(injected, /\/pwa\/mobile\.js/u);
  // 视口合同升级：刘海安全区 + 软键盘缩放。
  assert.match(injected, /viewport-fit=cover/u);
  assert.match(injected, /interactive-widget=resizes-content/u);
  assert.doesNotMatch(injected, /content="width=device-width, initial-scale=1"/u);
  assert.ok(injected.indexOf("/pwa/register.js") < injected.indexOf("</head>"));
  assert.throws(() => tap(injected), /already injected/u);
  assert.throws(() => tap("<html><body></body></html>"), /missing <\/head>/u);
});

test("mobile assets are served with revalidation and enter the offline shell set", () => {
  const css = resolvePwaAsset("/pwa/mobile.css");
  const script = resolvePwaAsset("/pwa/mobile.js");
  assert.ok(css !== undefined && script !== undefined);
  assert.equal(css.contentType, "text/css; charset=utf-8");
  assert.equal(script.contentType, "application/javascript; charset=utf-8");
  assert.equal(css.immutable, false);
  // 移动端样式/脚本属于离线外壳的一部分。
  assert.match(PWA_SERVICE_WORKER_SCRIPT, /\/pwa\/mobile\.css/u);
  assert.match(PWA_SERVICE_WORKER_SCRIPT, /\/pwa\/mobile\.js/u);
  // 移动端 CSS 只在小视口生效，不影响桌面布局。
  assert.match(String(css.body), /@media \(max-width: 768px\)/u);
});

test("register script only registers /sw.js after load", () => {
  const register = resolvePwaAsset("/pwa/register.js");
  assert.ok(register !== undefined);
  assert.match(String(register.body), /serviceWorker/);
  assert.match(String(register.body), /register\("\/sw\.js"\)/);
});

test("service worker version is part of the cache name", () => {
  assert.match(PWA_SERVICE_WORKER_SCRIPT, new RegExp(PWA_CACHE_VERSION, "u"));
});
