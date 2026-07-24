import type {
  ModelCapabilities,
  ModelOption,
  ModelProviderOption,
  ParameterCapability,
} from "./use-chat-agent";

const REQUEST_CORE_FIELDS = new Set(["model", "instructions", "input", "messages", "tools"]);
export const CONTINUATION_FIELDS = [
  "previous_response_id",
  "conversation",
  "conversation_id",
  "continuation_token",
];

export const ROLE_LABELS: Record<string, string> = {
  user: "用户消息",
  assistant: "模型历史回答",
  developer: "开发者约束",
  system: "系统约束",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function otherParameters(request: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !REQUEST_CORE_FIELDS.has(key)),
  );
}

export function withOtherParameters(
  request: Record<string, unknown>,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const core: Record<string, unknown> = { model: request.model, tools: request.tools };
  if ("instructions" in request) core.instructions = request.instructions;
  if ("input" in request) core.input = request.input;
  if ("messages" in request) core.messages = request.messages;
  return { ...core, ...parameters };
}

export function requestMessages(request: Record<string, unknown>): unknown {
  return request.input ?? request.messages;
}

export function withRequestMessages(
  request: Record<string, unknown>,
  messages: unknown,
): Record<string, unknown> {
  return "messages" in request ? { ...request, messages } : { ...request, input: messages };
}

export function contextSourceIndexForMessage(
  messageIndex: number,
  messageCount: number,
  sourceCount: number,
  instructionIndex: number,
): number {
  const sourcesAlreadyIncludeInstructions = sourceCount === messageCount;
  return !sourcesAlreadyIncludeInstructions &&
    instructionIndex >= 0 &&
    messageIndex > instructionIndex
    ? messageIndex - 1
    : messageIndex;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

export function requestInstructions(request: Record<string, unknown>): string {
  if (typeof request.instructions === "string") return request.instructions;
  if (!Array.isArray(request.messages)) return "";
  const system = request.messages.find((message) => isRecord(message) && message.role === "system");
  return isRecord(system) ? textFromContent(system.content) : "";
}

export function withRequestInstructions(
  request: Record<string, unknown>,
  instructions: string,
): Record<string, unknown> {
  if ("input" in request || "instructions" in request) return { ...request, instructions };
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const systemIndex = messages.findIndex(
    (message) => isRecord(message) && message.role === "system",
  );
  if (systemIndex < 0)
    return { ...request, messages: [{ role: "system", content: instructions }, ...messages] };
  return {
    ...request,
    messages: messages.map((message, index) =>
      index === systemIndex
        ? { ...(isRecord(message) ? message : {}), role: "system", content: instructions }
        : message,
    ),
  };
}

function responsesPartToChat(part: unknown): unknown {
  if (!isRecord(part)) return part;
  if (["input_text", "output_text"].includes(String(part.type)))
    return { type: "text", text: part.text };
  if (part.type === "input_image") return { type: "image_url", image_url: { url: part.image_url } };
  return part;
}

function chatPartToResponses(part: unknown, role: string): unknown {
  if (!isRecord(part)) return part;
  if (part.type === "text")
    return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
  if (part.type === "image_url") {
    const imageUrl = isRecord(part.image_url) ? part.image_url.url : part.image_url;
    return { type: "input_image", image_url: imageUrl };
  }
  return part;
}

export function convertRequestForProvider(
  request: Record<string, unknown>,
  provider: ModelProviderOption,
): Record<string, unknown> {
  const selectedModel = provider.models[0];
  const model = selectedModel?.id ?? "";
  const supportedParameters = new Map(
    (selectedModel?.capabilities.parameters ?? []).map((parameter) => [parameter.key, parameter]),
  );
  const parameters = Object.fromEntries(
    Object.entries(otherParameters(request)).filter(
      ([key]) =>
        selectedModel?.capabilities.allow_unknown_parameters || supportedParameters.has(key),
    ),
  );
  supportedParameters.forEach((parameter, key) => {
    if (parameter.locked) parameters[key] = parameter.default;
  });
  if (provider.protocol === "openai_chat_completions") {
    const source = Array.isArray(request.input)
      ? request.input
      : Array.isArray(request.messages)
        ? request.messages
        : [];
    const messages = source.map((message) => {
      if (!isRecord(message)) return message;
      const content = message.content;
      if (Array.isArray(content)) {
        const parts = content.map(responsesPartToChat);
        const textOnly = parts.every((part) => isRecord(part) && part.type === "text");
        return {
          ...message,
          content: textOnly
            ? parts.map((part) => String((part as Record<string, unknown>).text ?? "")).join("\n")
            : parts,
        };
      }
      return message;
    });
    const instructions = requestInstructions(request);
    const withoutExistingSystem = messages.filter(
      (message) => !isRecord(message) || message.role !== "system",
    );
    return {
      model,
      messages: instructions
        ? [{ role: "system", content: instructions }, ...withoutExistingSystem]
        : withoutExistingSystem,
      tools: request.tools ?? [],
      ...parameters,
      store: false,
    };
  }

  const source = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input)
      ? request.input
      : [];
  const instructions = requestInstructions(request);
  const input = source
    .filter((message) => !isRecord(message) || message.role !== "system")
    .map((message) => {
      if (!isRecord(message)) return message;
      const role = typeof message.role === "string" ? message.role : "user";
      const content =
        typeof message.content === "string"
          ? [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }]
          : Array.isArray(message.content)
            ? message.content.map((part) => chatPartToResponses(part, role))
            : [];
      return { ...message, content };
    });
  return {
    model,
    instructions,
    input,
    tools: request.tools ?? [],
    ...parameters,
    store: false,
  };
}

export function providerFor(
  catalog: ModelProviderOption[],
  providerId: string,
): ModelProviderOption | undefined {
  return catalog.find((provider) => provider.id === providerId);
}

export function modelFor(
  catalog: ModelProviderOption[],
  providerId: string,
  modelId: unknown,
): ModelOption | undefined {
  if (typeof modelId !== "string") return undefined;
  return providerFor(catalog, providerId)?.models.find((model) => model.id === modelId);
}

function validateParameter(parameter: ParameterCapability, value: unknown): string[] {
  const issues: string[] = [];
  if (parameter.value_type === "boolean" && typeof value !== "boolean") {
    issues.push(`${parameter.key}必须是布尔值`);
  }
  if (
    parameter.value_type === "integer" &&
    (!Number.isInteger(value) || typeof value !== "number")
  ) {
    issues.push(`${parameter.key}必须是整数`);
  }
  if (parameter.value_type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    issues.push(`${parameter.key}必须是数值`);
  }
  if (typeof value === "number") {
    if (parameter.minimum !== null && value < parameter.minimum) {
      issues.push(`${parameter.key}不能小于${parameter.minimum}`);
    }
    if (parameter.maximum !== null && value > parameter.maximum) {
      issues.push(`${parameter.key}不能大于${parameter.maximum}`);
    }
  }
  if (parameter.value_type === "enum" && !parameter.choices.includes(String(value))) {
    issues.push(`${parameter.key}不是当前模型支持的选项`);
  }
  if (parameter.value_type === "object_enum") {
    const child = parameter.child_key;
    if (!child || !isRecord(value) || !parameter.choices.includes(String(value[child]))) {
      issues.push(`${parameter.key}不是当前模型支持的对象选项`);
    }
  }
  return issues;
}

function validateInput(
  input: unknown,
  capabilities: ModelCapabilities,
  allowedToolNames: Set<string> = new Set(),
): string[] {
  if (typeof input === "string") return input.trim() ? [] : ["input文字不能为空"];
  if (!Array.isArray(input) || input.length === 0) return ["input必须至少包含一条消息"];
  const issues: string[] = [];
  input.forEach((message, messageIndex) => {
    if (!isRecord(message)) {
      issues.push(`消息${messageIndex + 1}必须是对象`);
      return;
    }
    const itemType = typeof message.type === "string" ? message.type : "";
    if (["function_call", "function_call_output", "reasoning"].includes(itemType)) {
      if (itemType === "function_call") {
        const name = typeof message.name === "string" ? message.name : "";
        if (!name || !allowedToolNames.has(name)) {
          issues.push(`Provider上下文项${messageIndex + 1}引用了未授权Tool`);
        }
      }
      if (itemType === "function_call_output" && !("output" in message)) {
        issues.push(`Provider上下文项${messageIndex + 1}缺少output`);
      }
      return;
    }
    const role = typeof message.role === "string" ? message.role : "";
    if (!capabilities.roles.includes(role)) {
      issues.push(`消息${messageIndex + 1}的role不受当前模型支持`);
      return;
    }
    if (typeof message.content === "string") {
      if (!message.content.trim()) issues.push(`消息${messageIndex + 1}的文字不能为空`);
      return;
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      issues.push(`消息${messageIndex + 1}必须至少包含一项内容`);
      return;
    }
    const allowed = capabilities.content_types_by_role[role] ?? [];
    message.content.forEach((part, contentIndex) => {
      if (!isRecord(part) || typeof part.type !== "string" || !allowed.includes(part.type)) {
        issues.push(`消息${messageIndex + 1}第${contentIndex + 1}项内容与role不兼容`);
        return;
      }
      if (["input_text", "output_text", "refusal"].includes(part.type)) {
        if (typeof part.text !== "string" || !part.text.trim()) {
          issues.push(`消息${messageIndex + 1}第${contentIndex + 1}项文字不能为空`);
        }
      }
      if (
        part.type === "input_image" &&
        (typeof part.image_url !== "string" || !part.image_url.trim())
      ) {
        issues.push(`消息${messageIndex + 1}第${contentIndex + 1}项图片地址不能为空`);
      }
    });
  });
  return issues;
}

export function policyIssues(
  providerId: string,
  catalog: ModelProviderOption[],
  request: Record<string, unknown>,
  options?: {
    capabilities?: ModelCapabilities;
    allowedToolNames?: string[];
  },
): string[] {
  const issues: string[] = [];
  const provider = providerFor(catalog, providerId);
  if (!provider) return ["请选择有效的Provider"];
  const model = modelFor(catalog, providerId, request.model);
  if (!model) return ["请选择当前Provider支持的模型"];
  const capabilities = options?.capabilities ?? model.capabilities;
  const allowedToolNames = new Set(options?.allowedToolNames ?? []);

  issues.push(...validateInput(requestMessages(request), capabilities, allowedToolNames));
  if (provider.protocol === "openai_chat_completions" && "input" in request) {
    issues.push("Chat Completions协议必须使用messages字段");
  }
  if (provider.protocol === "openai_responses" && "messages" in request) {
    issues.push("Responses协议必须使用input字段");
  }
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    issues.push("tools必须是列表");
  } else if (Array.isArray(request.tools) && request.tools.length > 0) {
    const names = request.tools.map((tool) => {
      if (!isRecord(tool)) return "";
      const definition = isRecord(tool.function) ? tool.function : tool;
      return typeof definition.name === "string" ? definition.name : "";
    });
    if (allowedToolNames.size === 0) {
      issues.push("当前没有已注册且可执行的Tool，请移除自定义Tool定义");
    } else {
      names.forEach((name, index) => {
        if (!name || !allowedToolNames.has(name)) {
          issues.push(`Tool ${index + 1}没有绑定当前执行器`);
        }
      });
      if (new Set(names).size !== names.length) issues.push("Tool名称不能重复");
    }
  }
  if (request.store !== false) issues.push("当前已批准策略要求store=false");
  const continuation = CONTINUATION_FIELDS.filter(
    (field) => request[field] !== undefined && request[field] !== null,
  );
  if (continuation.length > 0)
    issues.push(`当前策略禁止Continuation字段：${continuation.join("、")}`);

  const parameterMap = new Map(
    capabilities.parameters.map((parameter) => [parameter.key, parameter]),
  );
  Object.entries(otherParameters(request)).forEach(([key, value]) => {
    if (CONTINUATION_FIELDS.includes(key)) return;
    const parameter = parameterMap.get(key);
    if (!parameter) {
      if (!capabilities.allow_unknown_parameters) {
        issues.push(`当前模型没有声明参数能力：${key}`);
      }
      return;
    }
    issues.push(...validateParameter(parameter, value));
  });
  return issues;
}

export function contentTypesForRole(capabilities: ModelCapabilities, role: string): string[] {
  return capabilities.content_types_by_role[role] ?? [];
}

export function changeMessageRole(
  message: Record<string, unknown>,
  role: string,
  capabilities: ModelCapabilities,
): Record<string, unknown> {
  const allowed = contentTypesForRole(capabilities, role);
  const fallback = allowed[0] ?? (role === "assistant" ? "output_text" : "input_text");
  if (typeof message.content === "string") {
    return { role, content: message.content };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const nextContent = content.map((part) => {
    const record = isRecord(part) ? part : {};
    const type =
      typeof record.type === "string" && allowed.includes(record.type) ? record.type : fallback;
    if (type === "input_image") {
      return { type, image_url: typeof record.image_url === "string" ? record.image_url : "" };
    }
    return { type, text: typeof record.text === "string" ? record.text : "" };
  });
  return {
    role,
    content: nextContent.length > 0 ? nextContent : [{ type: fallback, text: "" }],
  };
}
