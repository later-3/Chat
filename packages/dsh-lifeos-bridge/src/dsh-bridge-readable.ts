export type ExactJsonSectionKind = "field" | "system" | "message" | "tool";

export interface ExactJsonSection {
  readonly sectionId: string;
  readonly kind: ExactJsonSectionKind;
  readonly title: string;
  readonly jsonPointer: string;
  /** 该Pointer所指JSON值的完整格式化结果；不混入任何UI说明。 */
  readonly valueJson: string;
  readonly messageSource?: {
    readonly role?: string;
    readonly kind?: string;
    readonly plugin?: string;
    readonly name?: string;
    readonly form?: string;
  };
}

export interface DshUserInputMapping {
  readonly messageJsonPointer: string;
  readonly textJsonPointers: readonly string[];
  readonly text: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function valueJson(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  if (rendered === undefined) throw new Error("请求区域不是可序列化JSON值");
  return rendered;
}

function messageTitle(index: number, message: unknown): string {
  const record = recordOf(message);
  const source = recordOf(record?.["source"]);
  const role = typeof record?.["role"] === "string" ? record["role"] : "unknown";
  const producer =
    (typeof source?.["plugin"] === "string" && source["plugin"]) ||
    (typeof source?.["name"] === "string" && source["name"]) ||
    (typeof source?.["kind"] === "string" && source["kind"]) ||
    "unknown";
  return `Message ${String(index)} · ${role} · ${producer}`;
}

function messageSource(message: unknown): NonNullable<ExactJsonSection["messageSource"]> {
  const record = recordOf(message);
  const source = recordOf(record?.["source"]);
  const text = (key: string): string | undefined =>
    typeof source?.[key] === "string" ? source[key] : undefined;
  const kind = text("kind");
  const plugin = text("plugin");
  const name = text("name");
  const form = text("form");
  return {
    ...(typeof record?.["role"] === "string" ? { role: record["role"] } : {}),
    ...(kind === undefined ? {} : { kind }),
    ...(plugin === undefined ? {} : { plugin }),
    ...(name === undefined ? {} : { name }),
    ...(form === undefined ? {} : { form }),
  };
}

function fieldTitle(field: string): string {
  return (
    {
      provider: "Provider 路由",
      model: "模型",
      reasoningEffort: "推理强度",
      system: "System Prompt",
      messages: "Messages",
      tools: "Tools",
      temperature: "Temperature",
      maxTokens: "最大输出 Token",
      stop: "停止序列",
      sessionId: "DSH Session 路由身份",
      purpose: "请求用途",
    }[field] ?? field
  );
}

/**
 * 易读视图的唯一正文输入是原始JSON。每个区域只对应一个JSON Pointer；调用方
 * 可以改变标题与来源注释，但不得替换valueJson或从Session重新读取另一份正文。
 */
export function exactSectionsFromJson(requestJson: string): ExactJsonSection[] {
  const parsed: unknown = JSON.parse(requestJson);
  const request = recordOf(parsed);
  if (request === undefined) throw new Error("发送边界原始请求必须是JSON对象");
  const sections: ExactJsonSection[] = [];
  for (const [field, value] of Object.entries(request)) {
    const fieldPointer = `/${jsonPointerToken(field)}`;
    if (field === "messages" && Array.isArray(value) && value.length > 0) {
      value.forEach((message, index) => {
        sections.push({
          sectionId: `messages-${String(index)}`,
          kind: "message",
          title: messageTitle(index, message),
          jsonPointer: `${fieldPointer}/${String(index)}`,
          valueJson: valueJson(message),
          messageSource: messageSource(message),
        });
      });
      continue;
    }
    if (field === "tools" && Array.isArray(value) && value.length > 0) {
      value.forEach((tool, index) => {
        const name = recordOf(tool)?.["name"];
        sections.push({
          sectionId: `tools-${String(index)}`,
          kind: "tool",
          title: `Tool ${String(index)}${typeof name === "string" ? ` · ${name}` : ""}`,
          jsonPointer: `${fieldPointer}/${String(index)}`,
          valueJson: valueJson(tool),
        });
      });
      continue;
    }
    sections.push({
      sectionId: `field-${field}`,
      kind: field === "system" ? "system" : "field",
      title: fieldTitle(field),
      jsonPointer: fieldPointer,
      valueJson: valueJson(value),
    });
  }
  return sections;
}

/** 与Adapter的lastUserPrompt保持同一规则，并返回原始请求中的精确来源Pointer。 */
export function lastDshUserInputMapping(requestJson: string): DshUserInputMapping | null {
  const request = recordOf(JSON.parse(requestJson));
  const messages = request?.["messages"];
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = recordOf(messages[index]);
    if (message?.["role"] !== "user" || recordOf(message["source"])?.["kind"] !== "user") {
      continue;
    }
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    const textBlocks = content.flatMap((block, blockIndex) => {
      const value = recordOf(block);
      return value?.["type"] === "text" && typeof value["text"] === "string"
        ? [
            {
              text: value["text"],
              pointer: `/messages/${String(index)}/content/${String(blockIndex)}/text`,
            },
          ]
        : [];
    });
    const text = textBlocks
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text === "") continue;
    return {
      messageJsonPointer: `/messages/${String(index)}`,
      textJsonPointers: textBlocks.map((block) => block.pointer),
      text,
    };
  }
  return null;
}

/** 测试与Trace使用：严格按JSON Pointer取回友好区域对应的原始值。 */
export function valueAtJsonPointer(requestJson: string, pointer: string): unknown {
  if (pointer === "") return JSON.parse(requestJson) as unknown;
  let current: unknown = JSON.parse(requestJson);
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`JSON Pointer不存在：${pointer}`);
      }
      current = current[index];
      continue;
    }
    const record = recordOf(current);
    if (record === undefined || !Object.hasOwn(record, token)) {
      throw new Error(`JSON Pointer不存在：${pointer}`);
    }
    current = record[token];
  }
  return current;
}
