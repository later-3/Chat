import { pathToFileURL } from "node:url";

/** Verify the served production page and its entry assets, not merely process liveness. */
export async function checkChatWeb(baseUrl) {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password) throw new Error("Web检查仅允许本机HTTP地址");
  const response = await fetch(base, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chat Web首页 HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("Chat Web首页没有返回HTML");
  const html = await response.text();
  if (!/\bid=["']root["']/.test(html)) throw new Error("Chat Web页面缺少应用入口");
  const assets = new Map();
  for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const path = tag[0].match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    if (!path) continue;
    const url = new URL(path, base);
    const extension = url.pathname.match(/\.(js|css)$/)?.[1];
    if (!extension) continue;
    if (url.origin !== base.origin) throw new Error("Chat Web入口资源不属于当前实例");
    assets.set(url.href, extension);
  }
  if (![...assets.values()].includes("js")) throw new Error("Chat Web页面缺少JS入口");
  for (const [url, extension] of assets) {
    const asset = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(5000) });
    const type = asset.headers.get("content-type") ?? "";
    if (!asset.ok || !(extension === "css" ? type.includes("text/css") : /(?:java|ecma)script/.test(type))) {
      throw new Error(`Chat Web资源不可用：${new URL(url).pathname}（HTTP ${asset.status}）`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkChatWeb(process.argv[2]).catch(error => {
    console.error(`[失败] ${error.message}；请检查运行进程与构建是否同一版本，按平台更新流程停止、构建、再启动`);
    process.exitCode = 1;
  });
}
