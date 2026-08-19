import type { PromptReviewReadableSection, PromptReviewReadableSource } from "@chat/contracts";
import { parseCanonicalPromptReviewPayload } from "@chat/domain";

const CHAT_DIRECT_EXECUTOR = "packages/pi-runtime/src/direct-agent-executor.ts";
const CHAT_BRIDGE_ADAPTER = "packages/dsh-lifeos-bridge/src/adapter.ts";
const CHAT_MESSAGE_USE_CASE = "packages/application/src/session-message-use-cases.ts";
const PI_SYSTEM_PROMPT = "pi/packages/coding-agent/src/core/system-prompt.ts";
const PI_AGENT_SESSION = "pi/packages/coding-agent/src/core/agent-session.ts";
const PI_PROVIDER_GATE = "pi/packages/coding-agent/src/core/sdk.ts";
const PI_OPENAI_ADAPTER = "pi/packages/ai/src/api/openai-completions.ts";

function source(
  addedBy: string,
  sourceFiles: readonly string[],
  explanation: string,
): PromptReviewReadableSource {
  return { addedBy, sourceFiles: [...sourceFiles], explanation };
}

const SYSTEM_SOURCES: readonly PromptReviewReadableSource[] = [
  source(
    "Pi Agent Core · buildSystemPrompt",
    [PI_SYSTEM_PROMPT],
    "生成Pi基础系统指令、工具摘要、使用准则、文档路径和当前工作目录。",
  ),
  source(
    "Chat · Direct Agent执行节点",
    [CHAT_DIRECT_EXECUTOR],
    "通过appendSystemPrompt追加Direct节点的只读、逐次审核和产品提交边界。",
  ),
  source(
    "Chat维护的Pi分支 · Provider Gate",
    [PI_PROVIDER_GATE],
    "扩展处理完成后、Provider发送前冻结最终Payload；此Gate不向正文添加审核界面文案。",
  ),
];

const USER_SOURCES: readonly PromptReviewReadableSource[] = [
  source(
    "用户输入 → DSH Bridge → Chat Product Message",
    [CHAT_BRIDGE_ADAPTER, CHAT_MESSAGE_USE_CASE, CHAT_DIRECT_EXECUTOR],
    "来自当前DSH用户消息；Application先提交正式User Message，Direct Executor再把同一文本交给Pi AgentSession。",
  ),
];

const SESSION_SOURCES: readonly PromptReviewReadableSource[] = [
  source(
    "Pi AgentSession历史",
    [PI_AGENT_SESSION, PI_PROVIDER_GATE],
    "来自同一Pi会话内已经发生的模型回复或工具结果，并在下一次Provider请求前重新进入最终Payload。",
  ),
];

function format(value: unknown): {
  readonly content: string;
  readonly contentFormat: "text" | "json";
} {
  return typeof value === "string"
    ? { content: value, contentFormat: "text" }
    : { content: JSON.stringify(value, null, 2), contentFormat: "json" };
}

function messageKind(role: string): PromptReviewReadableSection["kind"] {
  if (role === "system") return "system_prompt";
  if (role === "user") return "user_message";
  if (role === "assistant") return "assistant_message";
  if (role === "tool") return "tool_message";
  return "other_message";
}

function messageTitle(role: string, index: number): string {
  const label =
    role === "system"
      ? "系统提示词"
      : role === "user"
        ? "用户输入"
        : role === "assistant"
          ? "模型历史回复"
          : role === "tool"
            ? "工具执行结果"
            : `${role || "未知角色"}消息`;
  return `${String(index + 1)} · ${label}`;
}

function messageSources(role: string): readonly PromptReviewReadableSource[] {
  if (role === "system") return SYSTEM_SOURCES;
  if (role === "user") return USER_SOURCES;
  return SESSION_SOURCES;
}

function toolSourceFiles(tools: unknown): string[] {
  const names = Array.isArray(tools)
    ? tools.flatMap((tool) => {
        if (typeof tool !== "object" || tool === null || Array.isArray(tool)) return [];
        const fn = (tool as { readonly function?: unknown }).function;
        if (typeof fn !== "object" || fn === null || Array.isArray(fn)) return [];
        const name = (fn as { readonly name?: unknown }).name;
        return typeof name === "string" && /^(?:read|grep|find|ls)$/u.test(name) ? [name] : [];
      })
    : [];
  return [
    CHAT_DIRECT_EXECUTOR,
    ...new Set(names.map((name) => `pi/packages/coding-agent/src/core/tools/${name}.ts`)),
    PI_OPENAI_ADAPTER,
  ];
}

/**
 * 只把canonical Payload拆成UI区块。sources是明确标记为“不发送”的来源注释；
 * content/otherFieldsJson逐字段来自原始Payload，不插入标题或解释性正文。
 */
export function projectPromptReviewReadableSections(
  canonicalPayloadJson: string,
): readonly PromptReviewReadableSection[] {
  const payload = parseCanonicalPromptReviewPayload(canonicalPayloadJson) as Record<
    string,
    unknown
  >;
  const sections: PromptReviewReadableSection[] = [];
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    messages.forEach((message, index) => {
      const record: Record<string, unknown> =
        typeof message === "object" && message !== null && !Array.isArray(message)
          ? (message as Record<string, unknown>)
          : { content: message };
      const role = typeof record["role"] === "string" ? record["role"].toLowerCase() : "";
      const fields = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "content"),
      );
      sections.push({
        sectionId: `message-${String(index + 1)}`,
        kind: messageKind(role),
        title: messageTitle(role, index),
        payloadJsonPointer: `/messages/${String(index)}`,
        ...format(record["content"]),
        otherFieldsJson: JSON.stringify(fields, null, 2),
        sources: [...messageSources(role)],
      });
    });
  }
  if (payload["tools"] !== undefined) {
    sections.push({
      sectionId: "tool-definitions",
      kind: "tool_definitions",
      title: "工具定义",
      payloadJsonPointer: "/tools",
      ...format(payload["tools"]),
      sources: [
        source(
          "Chat Direct Profile + Pi工具实现 + Pi Provider Adapter",
          toolSourceFiles(payload["tools"]),
          "Chat选择允许的只读工具；Pi提供真实Tool Schema；Pi AI把这些Schema序列化进最终Provider请求。",
        ),
      ],
    });
  }
  const parameters = Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== "messages" && key !== "tools"),
  );
  if (Object.keys(parameters).length > 0) {
    sections.push({
      sectionId: "request-parameters",
      kind: "request_parameters",
      title: "模型与请求参数",
      payloadJsonPointer: "/",
      ...format(parameters),
      sources: [
        source(
          "Chat Direct Profile + Pi AI Provider Adapter",
          [CHAT_DIRECT_EXECUTOR, PI_OPENAI_ADAPTER, PI_PROVIDER_GATE],
          "Chat冻结Provider、模型、thinking与预算；Pi AI按模型兼容配置生成stream、token和thinking等HTTP正文参数；Gate捕获生成后的结果。",
        ),
      ],
    });
  }
  if (sections.length === 0) {
    sections.push({
      sectionId: "request-parameters",
      kind: "request_parameters",
      title: "完整请求对象",
      payloadJsonPointer: "/",
      ...format(payload),
      sources: [
        source("Pi Provider Gate", [PI_PROVIDER_GATE], "Provider发送前捕获的完整JSON对象。"),
      ],
    });
  }
  return sections;
}
