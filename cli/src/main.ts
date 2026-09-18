#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { ChatApi, HttpError } from "./api.js";
import { record } from "./contract.js";
import { clientHome, readCookie, removeCookie, saveCookie } from "./credentials.js";
import { WorkflowTerminal } from "./controller.js";

const USAGE = `Chat Workflow CLI 0.3.1\n\nchat tui [--url URL] [--project ID] [--session ID] [--workflow ID] [--theme dark|light]\nchat login [--url URL] [--username NAME]\nchat logout [--url URL]\n\n默认地址 http://127.0.0.1:43110；可用 CHAT_SERVER_URL 覆盖。\nProject ID属于后端；/workflow 切换，/resume 恢复，/fork 分叉，/help 查看命令。\n退出TUI不会取消任务。登录凭据保存在独立客户端目录，可用 CHAT_CLI_HOME 覆盖。`;

class PasswordOutput extends Writable {
  muted = false;
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk); callback();
  }
}
async function login(api: ChatApi, suppliedUsername?: string): Promise<void> {
  let username = suppliedUsername ?? process.env.CHAT_CLI_USERNAME;
  let password = process.env.CHAT_CLI_PASSWORD;
  if (!username || !password) {
    if (!process.stdin.isTTY) throw new Error("请在终端执行 chat login，或为自动化设置 CHAT_CLI_USERNAME/CHAT_CLI_PASSWORD");
    const output = new PasswordOutput();
    const reader = createInterface({ input: process.stdin, output, terminal: true });
    try {
      username ||= await reader.question("Chat用户名: ");
      if (!password) { process.stdout.write("Chat密码: "); output.muted = true; password = await reader.question(""); output.muted = false; process.stdout.write("\n"); }
    } finally { reader.close(); }
  }
  await saveCookie(api.url, await api.login(username, password));
  console.log(`已登录 ${api.url}；凭据目录 ${clientHome()}`);
}
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: "string" }, project: { type: "string" }, session: { type: "string" }, workflow: { type: "string" },
    username: { type: "string" }, theme: { type: "string", default: "dark" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  } });
  if (values.help) { console.log(USAGE); return; }
  if (values.version) { console.log("0.3.1"); return; }
  const command = positionals[0] ?? "tui";
  if (positionals.length > 1 || !["tui", "login", "logout"].includes(command)) throw new Error(USAGE);
  const api = new ChatApi(values.url ?? process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:43110");
  if (command === "login") { await login(api, values.username); return; }
  if (command === "logout") {
    await removeCookie(api.url); api.cookie = ""; console.log("已移除本机登录凭据"); return;
  }
  api.cookie = await readCookie(api.url);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("chat tui需要交互终端；请通过终端或SSH启动");
  if (!["dark", "light"].includes(values.theme ?? "")) throw new Error("--theme支持dark或light");
  try {
    if (record(await api.json("/api/auth/session")).authenticated !== true) throw new Error("未登录");
  } catch (error) { if (error instanceof HttpError && error.status === 401) await login(api, values.username); else throw error; }
  // Loading native UI is deferred so --help/login and packaging checks do not initialize a terminal.
  const { ChatTerminalView } = await import("./tui.js");
  const view = new ChatTerminalView(undefined, values.theme);
  const controller = new WorkflowTerminal(api, view, values.project, values.session);
  try { await controller.initialize(values.workflow); }
  catch (error) { controller.stop(); throw error; }
  await new Promise<void>((resolve) => {
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; controller.stop(); view.stop(); process.off("SIGTERM", stop); process.off("SIGINT", stop); resolve(); };
    const showError = (error: unknown) => view.notice(error instanceof Error ? error.message : String(error));
    view.editor.onSubmit = (text) => {
      view.editor.addToHistory(text);
      if (text.trim() === "/quit") { stop(); return; }
      void controller.submit(text).catch(showError);
    };
    view.editor.onEscape = () => { void controller.cancel().catch(showError); };
    view.editor.onCtrlD = stop;
    view.editor.onAction("app.clear", () => { if (view.editor.getText()) view.draft(""); else stop(); });
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    view.start(); controller.startPolling();
  });
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
