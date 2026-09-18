import {
  AssistantMessageComponent, getSelectListTheme, initTheme,
  ToolExecutionComponent, UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider, Container, Editor, Image, KeybindingsManager, ProcessTerminal, ScrollView, SelectList, setKeybindings, TUI_KEYBINDINGS,
  Text, TuiAltScreen, VStack, type Terminal, type Keybinding,
} from "@earendil-works/pi-tui";
import { assistantMessage, messageText, parseMessage, record, string, type HistoryEntry, type NativeMessage } from "./contract.js";
import { slashCommands, type TerminalView } from "./controller.js";

/** UI-only composition of the same public components used by Pi InteractiveMode. */
class TerminalEditor extends Editor {
  onEscape: (() => void) | undefined;
  onCtrlD: (() => void) | undefined;
  actions = new Map<Keybinding, () => void>();
  keys = new KeybindingsManager({ ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape" }, "app.exit": { defaultKeys: "ctrl+d" },
    "app.clear": { defaultKeys: "ctrl+c" }, "app.tools.expand": { defaultKeys: "ctrl+o" },
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
  });
  onAction(action: Keybinding, handler: () => void): void { this.actions.set(action, handler); }
  override handleInput(data: string): void {
    if (this.keys.matches(data, "app.interrupt") && !this.isShowingAutocomplete()) { this.onEscape?.(); return; }
    if (this.keys.matches(data, "app.exit") && !this.getText()) { this.onCtrlD?.(); return; }
    for (const [key, action] of this.actions) if (this.keys.matches(data, key)) { action(); return; }
    super.handleInput(data);
  }
}

export class ChatTerminalView implements TerminalView {
  readonly ui: TuiAltScreen;
  readonly editor: TerminalEditor;
  private transcript = new Container();
  private dock = new Container();
  private statusLine = new Text("连接Chat…", 1, 0);
  private noticeLine = new Text("/help 查看命令", 1, 0);
  private tools = new Map<string, ToolExecutionComponent>();
  private expanded = false;
  private streaming: { component: AssistantMessageComponent; message: NativeMessage } | undefined;
  private hideThinking = false;
  private assistants: AssistantMessageComponent[] = [];
  private cancelSelector: (() => void) | undefined;

  constructor(terminal: Terminal = new ProcessTerminal(), theme = "dark") {
    initTheme(theme, false);
    this.ui = new TuiAltScreen(terminal);
    this.editor = new TerminalEditor(this.ui, { borderColor: (text) => text, selectList: getSelectListTheme() }, { paddingX: 1 });
    setKeybindings(this.editor.keys);
    // No file completion: files belong to the remote Project, not to this terminal's cwd.
    const autocomplete = new CombinedAutocompleteProvider(slashCommands, "/");
    this.editor.setAutocompleteProvider({
      getSuggestions: (lines, row, column, options) => /^\/[^\s]*$/.test(lines[row] ?? "")
        ? autocomplete.getSuggestions(lines, row, column, options) : Promise.resolve(null),
      applyCompletion: (lines, row, column, item, prefix) => autocomplete.applyCompletion(lines, row, column, item, prefix),
    });
    this.dock.addChild(this.editor);
    this.editor.onAction("app.tools.expand", () => {
      this.expanded = !this.expanded;
      for (const tool of this.tools.values()) tool.setExpanded(this.expanded);
      this.ui.requestRender();
    });
    this.editor.onAction("app.thinking.toggle", () => {
      this.hideThinking = !this.hideThinking;
      for (const assistant of this.assistants) assistant.setHideThinkingBlock(this.hideThinking);
      this.ui.requestRender();
    });
    const scroll = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
    const layout = new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: this.noticeLine, maxSize: 5, shrink: 1 },
      { component: this.dock, minSize: 3, maxSize: 15, shrink: 1 },
      { component: this.statusLine, minSize: 1, maxSize: 2 },
    ]);
    this.ui.addChild(this.transcript); this.ui.addChild(this.noticeLine); this.ui.addChild(this.dock); this.ui.addChild(this.statusLine);
    this.ui.setLayoutRoot(layout); this.ui.setFocus(this.editor);
  }
  start(): void { this.ui.start(); }
  stop(): void { this.cancelSelector?.(); this.ui.stop(); }
  draft(text: string): void { this.editor.setText(text); this.ui.requestRender(); }
  status(text: string): void { this.statusLine.setText(text); this.ui.requestRender(); }
  notice(text: string): void { this.noticeLine.setText(text); this.ui.requestRender(); }
  async select(title: string, choices: readonly { id: string; label: string }[]): Promise<string | undefined> {
    if (!choices.length) { this.notice("没有可选项"); return undefined; }
    this.cancelSelector?.();
    return new Promise((resolve) => {
      const finish = (value?: string) => {
        this.cancelSelector = undefined; this.dock.clear(); this.dock.addChild(this.editor); this.ui.setFocus(this.editor); this.ui.requestRender(); resolve(value);
      };
      const list = new SelectList(choices.map((c) => ({ value: c.id, label: c.label })), 10, getSelectListTheme());
      list.onSelect = (item) => finish(item.value); list.onCancel = () => finish(); this.cancelSelector = () => finish();
      this.dock.clear(); this.dock.addChild(new Text(title, 1, 0)); this.dock.addChild(list); this.ui.setFocus(list); this.ui.requestRender();
    });
  }
  history(entries: readonly HistoryEntry[]): void {
    this.transcript.clear(); this.tools.clear(); this.assistants = []; this.streaming = undefined;
    this.transcript.addChild(new Text("Chat · Workflow Terminal", 1, 1));
    for (const entry of entries) {
      if (entry.message) this.message(entry.message);
      else if (entry.label) this.transcript.addChild(new Text(entry.label, 1, 1));
    }
    this.ui.requestRender();
  }
  private tool(id: string, name: string, args: Record<string, unknown>): ToolExecutionComponent {
    let tool = this.tools.get(id);
    if (!tool) {
      tool = new ToolExecutionComponent(name, id, args, { showImages: true }, undefined, this.ui, "/");
      tool.setExpanded(this.expanded); this.tools.set(id, tool); this.transcript.addChild(tool);
    } else tool.updateArgs(args);
    return tool;
  }
  private message(message: NativeMessage): void {
    if (message.role === "user") {
      this.transcript.addChild(new UserMessageComponent(messageText(message)));
      if (Array.isArray(message.content)) for (const part of message.content) {
        if (part.type === "image" && part.data && part.mimeType) this.transcript.addChild(
          new Image(part.data, part.mimeType, { fallbackColor: (text) => text }, { maxWidthCells: 60 }),
        );
      }
    }
    else if (message.role === "assistant") {
      const component = new AssistantMessageComponent(assistantMessage(message), this.hideThinking);
      this.assistants.push(component); this.transcript.addChild(component);
      if (Array.isArray(message.content)) for (const part of message.content) {
        if (part.type === "toolCall" && part.id && part.name) {
          const tool = this.tool(part.id, part.name, part.arguments ?? {});
          // Pi's edit preview reads cwd. Remote calls must only render the server's result diff.
          if (part.name !== "edit") tool.setArgsComplete();
        }
      }
    } else if (message.role === "toolResult" && message.toolCallId && message.toolName) {
      const tool = this.tools.get(message.toolCallId) ?? this.tool(message.toolCallId, message.toolName, {});
      tool.updateResult({ content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content, isError: message.isError ?? false, details: message.details });
    } else this.transcript.addChild(new Text(messageText(message), 1, 1));
  }
  event(value: unknown): void {
    const envelope = record(value);
    if (envelope.type === "stage_start") { const stage = record(envelope.stage); this.notice(`${string(stage.workflowId)} · ${string(stage.stageId)}`); return; }
    if (envelope.type === "review_required") { this.notice("等待计划审核：/approve 批准，/revise 提出修改"); return; }
    if (envelope.type !== "agent_event") throw new Error("未知Run事件类型");
    const event = record(envelope.event);
    if (event.type === "message_start") {
      const message = parseMessage(event.message);
      if (message.role === "assistant") {
        const component = new AssistantMessageComponent(assistantMessage(message), this.hideThinking);
        this.streaming = { component, message }; this.assistants.push(component); this.transcript.addChild(component);
      }
    } else if (event.type === "message_update" && this.streaming) {
      const update = record(event.assistantMessageEvent);
      const content = this.streaming.message.content;
      const index = update.contentIndex;
      if (!Array.isArray(content) || !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > 10000) return;
      const i = Number(index);
      if (update.type === "text_start") content[i] = { type: "text", text: "" };
      if (update.type === "thinking_start") content[i] = { type: "thinking", thinking: "" };
      if (update.type === "text_delta") content[i] = { type: "text", text: (content[i]?.text ?? "") + string(update.delta) };
      if (update.type === "thinking_delta") content[i] = { type: "thinking", thinking: (content[i]?.thinking ?? "") + string(update.delta) };
      this.streaming.component.updateContent(assistantMessage({ ...this.streaming.message, content: content.filter(Boolean) }), true);
    } else if (event.type === "message_end") {
      const message = parseMessage(event.message);
      if (message.role === "assistant" && this.streaming) {
        this.streaming.component.updateContent(assistantMessage(message), false); this.streaming = undefined;
      } else if (message.role === "assistant" || message.role === "toolResult") this.message(message);
    } else if (event.type === "tool_execution_start") {
      const name = string(event.toolName);
      const tool = this.tool(string(event.toolCallId), name, record(event.args));
      if (name !== "edit") tool.setArgsComplete();
      tool.markExecutionStarted();
    } else if (event.type === "tool_execution_update") {
      const tool = this.tools.get(string(event.toolCallId)); const result = record(event.partialResult);
      if (tool) {
        const projected = parseMessage({ role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName, isError: false, content: result.content });
        tool.updateResult({ content: typeof projected.content === "string" ? [{ type: "text", text: projected.content }] : projected.content, isError: false }, true);
      }
    }
    this.ui.requestRender();
  }
}
