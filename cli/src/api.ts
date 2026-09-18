import { record, string } from "./contract.js";

export function serverUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--url必须为不含凭据和路径的Chat实例根地址");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("远程Chat请使用HTTPS；本机可以使用HTTP");
  return url.origin;
}
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export class ChatApi {
  readonly url: string;
  cookie: string;
  constructor(url: string, cookie = "") { this.url = serverUrl(url); this.cookie = cookie; }
  async response(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("无效API路径");
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("Cookie", this.cookie);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.url}${path}`, {
      ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      let detail = `HTTP ${response.status}`;
      if (typeof body === "object" && body !== null) {
        const item = record(body);
        if (typeof item.statusMessage === "string") detail = item.statusMessage;
        else if (typeof item.error === "string") detail = item.error;
      }
      throw new HttpError(response.status, response.status === 401 ? "登录已过期，请执行 chat login" : detail);
    }
    return response;
  }
  async json(path: string, init: RequestInit = {}): Promise<unknown> { return (await this.response(path, init)).json(); }
  async login(username: string, password: string): Promise<{ cookie: string; expiresAt: string }> {
    const response = await this.response("/api/auth/session", { method: "POST", body: JSON.stringify({ username, password, persistent: true }) });
    const body = record(await response.json());
    if (body.ok !== true) throw new Error("登录响应无效");
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("chat-session="))?.split(";")[0];
    if (!cookie) throw new Error("服务器没有返回登录Cookie");
    this.cookie = cookie;
    return { cookie, expiresAt: string(body.expiresAt) };
  }
  async events(runId: string, signal: AbortSignal, receive: (value: unknown) => void): Promise<void> {
    const response = await this.response(`/runs/${encodeURIComponent(runId)}/events?startIndex=-1`, { signal });
    if (!response.headers.get("content-type")?.includes("application/x-ndjson") || !response.body) throw new Error("Run事件流格式无效");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        if (buffered.length > 32 * 1024 * 1024) throw new Error("Run事件超过客户端大小限制");
        let newline;
        while ((newline = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1);
          if (line) receive(JSON.parse(line));
        }
        if (done) break;
      }
      if (buffered.trim()) receive(JSON.parse(buffered));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
