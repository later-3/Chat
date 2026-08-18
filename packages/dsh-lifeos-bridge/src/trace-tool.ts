import { defineTool, type ToolCallKind } from "@deepseek-ai/dsh-tools";
import { dshSessionIdSchema, type ChatRun } from "./contracts.ts";
import { ChatProductClient } from "./chat-client.ts";
import { AtomicBridgeStateStore } from "./state-store.ts";

export const LIFEOS_TRACE_TOOL = "lifeos_trace";
const POLL_INTERVAL_MS = 350;
const TERMINAL_STATUSES = new Set<ChatRun["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

async function delay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, POLL_INTERVAL_MS);
  });
}

function inputObject(input: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(input) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolKind(toolName: string): ToolCallKind {
  if (toolName === "read" || toolName === "ls") return "read";
  if (toolName === "grep" || toolName === "find") return "search";
  if (toolName === "edit" || toolName === "write") return "edit";
  if (toolName === "bash") return "execute";
  return "other";
}

/**
 * Pi工具的DSH显示代理。它不再次执行命令，只等待Chat Trace中的匹配结果；因此
 * DSH原生Session会自然记录tool/call与tool/result，Trajectory可以实时显示运行态。
 */
export function createLifeosTraceTool(chat: ChatProductClient, state: AtomicBridgeStateStore) {
  return defineTool({
    name: LIFEOS_TRACE_TOOL,
    description:
      "Display one already-authorized remote Pi tool execution in the native trajectory. This tool never executes the command itself.",
    parameters: {
      productRunId: { type: "string", required: true },
      sourceSequence: { type: "integer", required: true },
      toolCallId: { type: "string", required: true },
      toolName: {
        type: "string",
        enum: ["read", "grep", "find", "ls", "edit", "write", "bash"],
        required: true,
      },
      input: { type: "string", required: true },
      inputTruncated: { type: "boolean", required: true },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          toolName: { type: "string", required: true },
          outcome: {
            type: "string",
            enum: ["success", "failure", "rejected", "unknown"],
            required: true,
          },
          output: { type: "string", required: true },
          outputTruncated: { type: "boolean", required: true },
          durationMs: { type: "number" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.output }],
    },
    async execute(args, exec) {
      const dshSessionId = dshSessionIdSchema.parse(String(exec.agent?.id ?? ""));
      await state.assertCurrentTraceBinding(dshSessionId, args.productRunId);
      let cursor = args.sourceSequence;
      while (true) {
        const page = await chat.getExecutionTrace(args.productRunId, cursor, exec.signal);
        const result = page.items.find(
          (item) => item.type === "tool_result" && item.toolCallId === args.toolCallId,
        );
        if (result?.type === "tool_result") {
          // 只越过当前intent；并行Pi调用中位于其后的intent仍需逐个投影。
          await state.advanceTraceCursor(dshSessionId, args.productRunId, args.sourceSequence);
          return {
            toolName: result.toolName,
            outcome: result.outcome,
            output: result.output,
            outputTruncated: result.outputTruncated,
            ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          };
        }
        cursor = page.nextCursor;
        const run = await chat.getRun(args.productRunId, exec.signal);
        if (TERMINAL_STATUSES.has(run.status) && !page.hasMore) {
          await state.advanceTraceCursor(dshSessionId, args.productRunId, args.sourceSequence);
          throw new Error("remote Pi tool settled without a matching observable result");
        }
        if (page.hasMore) continue;
        await delay(exec.signal);
      }
    },
    presentCall(args) {
      const parsed = inputObject(args.input);
      if (args.toolName === "bash") {
        const command = typeof parsed?.command === "string" ? parsed.command : args.input;
        const cwd = typeof parsed?.path === "string" ? parsed.path : undefined;
        return {
          card: "terminal",
          title: command,
          description: "Pi Agent · bash",
          ...(cwd !== undefined ? { cwd } : {}),
        };
      }
      const path = typeof parsed?.path === "string" ? parsed.path : undefined;
      return {
        card: "generic",
        title: `Pi Agent · ${args.toolName}`,
        kind: toolKind(args.toolName),
        rawInput: args.input,
        ...(path !== undefined ? { locations: [{ path }] } : {}),
      };
    },
    presentResult(args, result) {
      const content = result.content.find((block) => block.type === "text");
      const text = content?.type === "text" ? content.text : undefined;
      return args.toolName === "bash"
        ? { card: "terminal", ...(text !== undefined ? { output: text } : {}) }
        : {
            card: "generic",
            title: `Pi Agent · ${args.toolName}`,
            ...(text !== undefined ? { content: [{ type: "text", text }] } : {}),
          };
    },
  });
}
