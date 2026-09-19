#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ChatApi } from "./api.js";
import { WorkflowTerminal } from "./controller.js";

const USAGE = `Chat Workflow CLI 0.3.1\n\nchat tui [--url URL] [--project ID] [--session ID] [--workflow ID] [--theme dark|light]\n\n默认地址 http://127.0.0.1:43110；可用 CHAT_SERVER_URL 覆盖。\nProject ID属于后端；/workflow 切换，/resume 恢复，/fork 分叉，/help 查看命令。\n退出TUI不会取消任务。`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: "string" }, project: { type: "string" }, session: { type: "string" }, workflow: { type: "string" },
    theme: { type: "string", default: "dark" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  } });
  if (values.help) { console.log(USAGE); return; }
  if (values.version) { console.log("0.3.1"); return; }
  const command = positionals[0] ?? "tui";
  if (positionals.length > 1 || command !== "tui") throw new Error(USAGE);
  const api = new ChatApi(values.url ?? process.env.CHAT_SERVER_URL ?? "http://127.0.0.1:43110");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("chat tui需要交互终端；请通过终端或SSH启动");
  if (!["dark", "light"].includes(values.theme ?? "")) throw new Error("--theme支持dark或light");
  // Loading native UI is deferred so --help and packaging checks do not initialize a terminal.
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
