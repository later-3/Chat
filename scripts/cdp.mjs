// Minimal Chrome DevTools Protocol client: launches headless Chrome and runs JS in a page.
// No Playwright/Puppeteer dependency; Node's global WebSocket is used.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export function chromeExecutable() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    `${process.env.HOME ?? ""}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${process.env.HOME ?? ""}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${process.env.HOME ?? ""}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  ];
  return candidates.find((candidate) => candidate !== "" && fs.existsSync(candidate)) ?? null;
}

function requestJson(url, method) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(new Error(`${String(method)} ${url} 返回非 JSON: ${body.slice(0, 120)}`, { cause: error })); } });
    });
    request.on("error", reject);
    request.end();
  });
}

function getJson(url) {
  return requestJson(url, "GET");
}

export async function launchBrowser() {
  const executable = chromeExecutable();
  if (executable === null) throw new Error("找不到可用的 Chrome/Chromium 可执行文件");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-cdp-"));
  const child = spawn(executable, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-sync", "--disable-extensions", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Chrome DevTools 未就绪: ${buffer}`)), 20_000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome 提前退出: ${String(code)}`)); });
  });
  const browserWs = new URL(wsUrl);
  const port = browserWs.port;
  return {
    child,
    userDataDir,
    async close() {
      try { child.kill("SIGKILL"); } catch {}
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
    async newPage(url) {
      const target = await requestJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, "PUT");
      return openPage(target.webSocketDebuggerUrl);
    },
  };
}

function openPage(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: done, reject: fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      } else if (message.method) {
        events.push(message);
      }
    });
    socket.addEventListener("error", (event) => reject(new Error(`CDP socket error: ${String(event)}`)));
    socket.addEventListener("open", () => {
      const send = (method, params = {}) => new Promise((done, fail) => {
        const id = nextId++;
        pending.set(id, { resolve: done, reject: fail });
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本错误");
        return result.result?.value;
      };
      const waitFor = async (expression, { timeoutMs = 20_000, label = expression } = {}) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const value = await evaluate(expression);
          if (value) return value;
          if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      void (async () => {
        await send("Page.enable");
        await send("Runtime.enable");
        resolve({ send, evaluate, waitFor, events, close: () => socket.close() });
      })();
    });
  });
}
