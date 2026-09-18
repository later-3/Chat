import { randomUUID } from "node:crypto";
import { ChatApi } from "./api.js";
import { array, messageText, parseRun, parseTranscript, record, string, type HistoryEntry, type RunReference, type Transcript } from "./contract.js";

export interface TerminalView {
  history(entries: readonly HistoryEntry[]): void;
  status(text: string): void;
  notice(text: string): void;
  draft(text: string): void;
  select(title: string, choices: readonly { id: string; label: string }[]): Promise<string | undefined>;
  event(value: unknown): void;
}
const COMMANDS = ["project", "workflow", "new", "resume", "fork", "history", "tree", "approve", "revise", "cancel", "refresh", "web", "help", "quit"] as const;
export const HELP = "/project  /workflow  /new  /resume  /fork  /history  /tree\n/approve  /revise 修改意见  /cancel  /refresh  /web  /help  /quit\nEsc取消当前Run，Ctrl+D退出（Run继续），Ctrl+O展开工具；/tree只读浏览，/history返回完整历史。";
export const slashCommands = COMMANDS.map((name) => ({ name, description: name }));

export class WorkflowTerminal {
  readonly api: ChatApi;
  readonly view: TerminalView;
  projectId: string;
  sessionId: string | undefined;
  workflowId = "";
  snapshot: Transcript | undefined;
  private workflows: { id: string; label: string }[] = [];
  private active: RunReference | undefined;
  private stream: AbortController | undefined;
  private streamRunId: string | undefined;
  private closed = false;
  private refreshing = false;
  private submitting = false;
  private browsing = false;
  private generation = 0;
  private forkRequest: { entryId: string; requestId: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(api: ChatApi, view: TerminalView, projectId = "", sessionId?: string) {
    this.api = api; this.view = view; this.projectId = projectId; this.sessionId = sessionId;
  }
  async initialize(workflowId?: string): Promise<void> {
    const response = record(await this.api.json("/api/workflows"));
    this.workflows = array(response.workflows).map((value) => { const w = record(value); return { id: string(w.id), label: `${string(w.name)} (${string(w.id)})` }; });
    await this.loadDefaults();
    if (this.sessionId) await this.refresh();
    if (workflowId !== undefined) this.chooseWorkflow(workflowId);
    this.updateStatus();
  }
  private async loadDefaults(): Promise<void> {
    const projects = array(record(await this.api.json("/api/projects")).projects).map(record)
      .filter((p) => p.available === true && p.kind === "project")
      .sort((a, b) => string(b.lastOpenedAt).localeCompare(string(a.lastOpenedAt)));
    if (!this.projectId) {
      const recent = projects[0];
      if (!recent) throw new Error("请先在Web端打开或创建一个普通Project，再启动TUI");
      this.projectId = string(recent.projectId);
    }
    if (!projects.some((p) => p.projectId === this.projectId && p.available === true && (p.kind === "project" || p.kind === undefined))) {
      throw new Error(`Project ${this.projectId}不可用；请用 --project 指定后端的普通Project ID`);
    }
    const config = record(await this.api.json(`/api/chat-config?projectId=${encodeURIComponent(this.projectId)}`));
    this.chooseWorkflow(string(config.defaultWorkflowId));
  }
  private chooseWorkflow(id: string): void {
    if (!this.workflows.some((w) => w.id === id)) throw new Error(`Workflow不存在: ${id}`);
    this.workflowId = id;
  }
  startPolling(): void {
    const poll = async () => {
      if (this.closed) return;
      try { await this.refresh(); } catch (error) { this.view.status(`连接状态未知：${error instanceof Error ? error.message : String(error)}；自动重试，未重发任务`); }
      if (!this.closed) this.timer = setTimeout(poll, 2000);
    };
    this.timer = setTimeout(poll, 2000);
  }
  stop(): void { this.closed = true; this.generation++; clearTimeout(this.timer); this.stream?.abort(); }
  private updateStatus(): void {
    const state = this.snapshot?.activeRun?.phase ?? (this.active ? "running" : "idle");
    this.view.status(`${this.projectId} · ${this.workflowId} · ${state} · ${this.sessionId ?? "新会话"}`);
  }
  private path(sessionId = this.sessionId): string {
    if (!sessionId) throw new Error("请先创建或选择会话");
    return `/api/sessions/${encodeURIComponent(sessionId)}`;
  }
  async refresh(force = false): Promise<void> {
    if (!this.sessionId || this.refreshing || this.closed) return;
    this.refreshing = true;
    const generation = this.generation;
    const sessionId = this.sessionId;
    const projectId = this.projectId;
    try {
      let page = parseTranscript(await this.api.json(`${this.path(sessionId)}/transcript?projectId=${encodeURIComponent(projectId)}`));
      if (page.sessionId !== sessionId || page.projectId !== projectId) throw new Error("历史响应身份不匹配");
      const head = page;
      const changed = force || this.snapshot?.sessionId !== sessionId || this.snapshot.revision !== head.revision;
      if (changed) {
        const entries = [...page.entries];
        const cursors = new Set<string>();
        while (page.nextCursor !== null) {
          if (cursors.has(page.nextCursor)) throw new Error("服务器返回重复历史游标");
          cursors.add(page.nextCursor);
          page = parseTranscript(await this.api.json(`${this.path(sessionId)}/transcript?${new URLSearchParams({ projectId, cursor: page.nextCursor })}`));
          if (page.sessionId !== sessionId || page.projectId !== projectId || page.revision !== head.revision) return;
          entries.push(...page.entries);
        }
        head.entries = entries;
      } else head.entries = this.snapshot?.entries ?? head.entries;
      const previous = this.active;
      if (!head.activeRun && previous) {
        const state = record(await this.api.json(`/runs/${encodeURIComponent(previous.runId)}?${new URLSearchParams({ projectId, workflowInvocationId: previous.workflowInvocationId })}`));
        if (state.runId !== previous.runId || !["pending", "running", "completed", "failed", "cancelled"].includes(string(state.status))) throw new Error("Run状态响应无效");
        if (this.closed || generation !== this.generation) return;
        if (state.status === "failed") this.view.notice(`运行失败：${typeof state.error === "string" ? state.error : previous.runId}`);
        else if (state.status === "completed") this.view.notice("Workflow已完成");
        else if (state.status === "cancelled") this.view.notice("Workflow已取消");
        else head.activeRun = { ...previous, phase: string(state.status) };
      }
      if (this.closed || generation !== this.generation) return;
      const first = this.snapshot === undefined;
      this.snapshot = head;
      if (first && !previous && head.workflowId) this.chooseWorkflow(head.workflowId);
      if (changed && !this.browsing) this.view.history(head.entries);
      this.active = head.activeRun ?? undefined;
      if (this.active && this.streamRunId !== this.active.runId) this.attach(this.active);
      if (!this.active) { this.stream?.abort(); this.stream = undefined; this.streamRunId = undefined; }
      this.updateStatus();
    } finally { this.refreshing = false; }
  }
  private attach(run: RunReference): void {
    this.stream?.abort();
    const controller = new AbortController(); this.stream = controller; this.streamRunId = run.runId;
    void this.api.events(run.runId, controller.signal, (event) => { if (!this.browsing && !controller.signal.aborted) this.view.event(event); })
      .catch((error: unknown) => { if (!controller.signal.aborted) this.view.notice(`事件连接中断；正在从持久历史恢复：${error instanceof Error ? error.message : String(error)}`); })
      .finally(() => { if (this.stream === controller) { this.stream = undefined; this.streamRunId = undefined; } });
  }
  async submit(text: string): Promise<void> {
    if (!text.trim()) return;
    if (this.submitting) throw new Error("前一个操作尚未完成");
    this.submitting = true;
    try {
      if (text.startsWith("/")) {
        const [command, ...args] = text.slice(1).split(/\s+/);
        await this.command(command ?? "", args.join(" ").trim());
      } else {
        if (this.browsing) throw new Error("当前为只读历史浏览；用 /history 返回当前会话，或 /fork 新建分支");
        await this.refresh();
        if (this.active) throw new Error("当前Workflow仍在运行或等待审核；请先完成或 /cancel");
        const body = record(await this.api.json("/runs", { method: "POST", body: JSON.stringify({
          projectId: this.projectId, workflow: this.workflowId, prompt: text,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        }) }));
        const accepted = parseRun(body, this.projectId);
        this.sessionId = string(body.sessionId);
        this.active = accepted;
        this.view.notice(`已接受 · ${accepted.runId}`);
        this.attach(accepted); this.updateStatus();
      }
    } catch (error) { if (!text.startsWith("/")) this.view.draft(text); throw error; }
    finally { this.submitting = false; }
  }
  private navigate(sessionId?: string): void {
    this.generation++; this.sessionId = sessionId; this.snapshot = undefined; this.active = undefined;
    this.browsing = false; this.forkRequest = undefined; this.stream?.abort(); this.streamRunId = undefined;
    this.view.history([]);
  }
  private async command(command: string, args: string): Promise<void> {
    switch (command) {
      case "help": this.view.notice(HELP); break;
      case "quit": this.stop(); break;
      case "workflow": {
        const selected = args || await this.view.select("选择下一轮Workflow", this.workflows);
        if (selected) this.chooseWorkflow(selected); break;
      }
      case "new": this.navigate(); this.view.draft(""); break;
      case "project": {
        const projects = array(record(await this.api.json("/api/projects")).projects).map(record)
          .filter((p) => p.available === true && (p.kind === "project" || p.kind === undefined))
          .map((p) => ({ id: string(p.projectId), label: `${string(p.cachedName)} (${string(p.projectId)})` }));
        const selected = args || await this.view.select("选择Project", projects);
        if (selected) { if (!projects.some((p) => p.id === selected)) throw new Error("Project不可用"); this.navigate(); this.projectId = selected; await this.loadDefaults(); }
        break;
      }
      case "resume": {
        const sessions = array(record(await this.api.json(`/api/sessions?projectId=${encodeURIComponent(this.projectId)}`)).sessions).map(record)
          .filter((s) => record(s.owner).type === "ordinary")
          .sort((a, b) => string(b.modified).localeCompare(string(a.modified)))
          .map((s) => ({ id: string(s.id), label: `${string(s.name ?? s.firstMessage)} · ${string(s.id)}` }));
        const selected = args || await this.view.select("恢复Session", sessions);
        if (selected) { if (!sessions.some((s) => s.id === selected)) throw new Error("当前Project中没有该普通Session"); this.navigate(selected); await this.refresh(true); }
        break;
      }
      case "fork": {
        await this.refresh(); if (!this.snapshot) throw new Error("请先选择会话");
        if (this.active) throw new Error("请先完成或取消当前Run再Fork");
        const users = this.snapshot.entries.filter((e) => e.message?.role === "user");
        const selected = args || await this.view.select("从哪条用户消息之前Fork？", users.map((e) => ({ id: e.id, label: `${e.id} · ${messageText(e.message!).slice(0, 100)}` })));
        if (selected) {
          if (!users.some((e) => e.id === selected)) throw new Error("Fork目标必须为用户消息");
          if (this.forkRequest?.entryId !== selected) this.forkRequest = { entryId: selected, requestId: randomUUID() };
          const response = record(await this.api.json(`${this.path()}/fork`, { method: "POST", body: JSON.stringify({ projectId: this.projectId, ...this.forkRequest }) }));
          if (response.schemaVersion !== 1 || response.projectId !== this.projectId || response.parentSessionId !== this.sessionId) throw new Error("Fork响应身份无效");
          const draft = string(response.selectedText); this.navigate(string(response.sessionId)); await this.refresh(true); this.view.draft(draft);
        }
        break;
      }
      case "history": this.browsing = false; await this.refresh(true); break;
      case "tree": {
        await this.refresh(); if (!this.snapshot) throw new Error("请先选择会话");
        const entries = this.snapshot.entries;
        const selected = args || await this.view.select("只读浏览历史节点", entries.filter((e) => e.type === "message").map((e) => ({
          id: e.id, label: `${e.id} ← ${e.parentId ?? "root"} · ${e.message?.role} · ${e.message ? messageText(e.message).slice(0, 70) : ""}`,
        })));
        if (selected) {
          const byId = new Map(entries.map((e) => [e.id, e])); const branch: HistoryEntry[] = []; const seen = new Set<string>();
          let id: string | null = selected;
          while (id) { const entry = byId.get(id); if (!entry || seen.has(id)) throw new Error("历史节点不存在或存在循环"); seen.add(id); branch.push(entry); id = entry.parentId; }
          this.browsing = true; this.view.history(branch.reverse()); this.view.notice("只读浏览；/history 返回完整历史，/fork 创建新会话");
        }
        break;
      }
      case "approve": case "revise": {
        await this.refresh(); const review = this.snapshot?.activeRun?.review;
        if (!review || !this.active) throw new Error("没有等待审核的计划");
        if (command === "revise" && !args) throw new Error("用法：/revise 修改意见");
        if (command === "approve" && review.readiness !== "ready_for_review") throw new Error("计划需要澄清，请用 /revise 回答问题");
        const { plan: _plan, readiness: _readiness, sessionId: _sessionId, ...reference } = review;
        const response = record(await this.api.json(`/runs/${encodeURIComponent(this.active.runId)}/review`, { method: "POST", body: JSON.stringify({
          projectId: this.projectId, decision: { ...reference, kind: command === "approve" ? "approve" : "request_revision", ...(command === "revise" ? { feedback: args } : {}) },
        }) }));
        if (response.status !== "accepted" || response.runId !== this.active.runId) throw new Error("审核响应无效");
        this.view.notice("审核决定已提交"); break;
      }
      case "cancel": await this.cancel(); break;
      case "refresh": await this.refresh(true); break;
      case "web": this.view.notice(`${this.api.url}/?${new URLSearchParams({ projectId: this.projectId, ...(this.sessionId ? { session: this.sessionId } : {}) })}`); break;
      default: throw new Error(`不支持 /${command}；输入 /help 查看Workflow客户端命令`);
    }
    this.updateStatus();
  }
  async cancel(): Promise<void> {
    await this.refresh(); if (!this.active) { this.view.notice("没有活跃Run"); return; }
    const run = this.active;
    const response = record(await this.api.json(`/runs/${encodeURIComponent(run.runId)}?${new URLSearchParams({ projectId: this.projectId, workflowInvocationId: run.workflowInvocationId })}`, { method: "DELETE" }));
    if (response.status !== "cancelled" || response.runId !== run.runId) throw new Error("取消响应无效");
    this.view.notice("已请求取消"); await this.refresh(true);
  }
}
