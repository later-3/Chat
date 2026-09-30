import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Prompt capture: the durable record of every request actually sent to a model.
 *
 * The one code-level chokepoint is Pi's shared provider-request boundary
 * (`streamFn` → `onPayload`); Chat reaches it through the single assembly entry
 * (`createChatPiAgentSession`), so recording there covers every agent, every
 * workflow stage and every model call (work turns, tool continuations and
 * compaction summaries) without touching any caller.
 *
 * A capture is the FINAL provider payload (ground truth of what was sent) plus a
 * provider-neutral region decomposition, so history can show and filter regions
 * (system prompt, injected instructions, current user message, history, tools)
 * instead of one opaque blob. Payloads are gzip sidecars next to the session —
 * never inside the session file (CustomEntry must not hold the only copy of
 * large bodies). Retention has no per-round or size limit by product decision:
 * everything is kept until the session itself is purged.
 */

export const PROMPT_CAPTURE_SCHEMA_VERSION = 1;

export interface PromptCaptureAgentIdentity {
  readonly agentId: string;
  readonly agentName?: string;
  readonly longAgentId?: string;
}

export interface PromptCaptureTurn {
  readonly source: "workflow" | "direct";
  readonly workflowId?: string;
  readonly workflowInvocationId?: string;
  readonly stageId?: string;
  readonly turnKey?: string;
}

export interface PromptCaptureSystemSection {
  readonly kind: "chat-project" | "chat-collaboration" | "chat-custom-instructions" | "pi-project-context" | "pi-base" | "other";
  readonly label: string;
  readonly text: string;
}

export interface PromptCaptureMessageRegion {
  readonly index: number;
  readonly role: "system" | "user" | "assistant" | "tool";
  /** Region classification; "unclassified" when no neutral list aligned. */
  readonly region: "injected-instruction" | "current-user-message" | "history-user" | "assistant" | "tool-result" | "system" | "unclassified";
  /** chat.customType for injected instructions, when aligned. */
  readonly customType?: string;
  readonly timestamp?: number;
  readonly chars: number;
  readonly text: string;
}

export interface PromptCaptureToolRegion {
  readonly name: string;
  readonly description?: string;
  readonly parametersChars: number;
}

export interface PromptCaptureRegions {
  readonly parsed: boolean;
  readonly api?: string;
  readonly systemPrompt?: {
    readonly chars: number;
    readonly text: string;
    readonly sections: readonly PromptCaptureSystemSection[];
  };
  readonly messages?: readonly PromptCaptureMessageRegion[];
  readonly tools?: readonly PromptCaptureToolRegion[];
  /** Set when the payload shape did not match a known provider API. */
  readonly parseError?: string;
}

export interface PromptCaptureRecord {
  readonly schemaVersion: typeof PROMPT_CAPTURE_SCHEMA_VERSION;
  readonly requestId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly storageProjectId: string;
  readonly sessionId: string;
  readonly turn: PromptCaptureTurn;
  readonly agent: PromptCaptureAgentIdentity;
  readonly model: { readonly provider: string; readonly modelId: string; readonly api?: string };
  /** "agent" = a normal agent-loop request with a neutral context snapshot; "direct" = a stream caller without one (e.g. compaction summaries). */
  readonly kind: "agent" | "direct";
  readonly payloadChars: number;
  readonly payloadSha256: string;
  readonly file: string;
  readonly regions: PromptCaptureRegions;
}

const CAPTURE_DIR_NAME = "prompt-captures";

export function promptCaptureDir(sessionDir: string, sessionId: string): string {
  return resolve(sessionDir, CAPTURE_DIR_NAME, sessionId);
}

function captureFilePath(directory: string, requestId: string): string {
  return join(directory, `${requestId}.json.gz`);
}

// ---------------------------------------------------------------------------
// Region parsing
// ---------------------------------------------------------------------------

const CHAT_SECTION_TAGS: readonly { readonly kind: PromptCaptureSystemSection["kind"]; readonly tag: string; readonly label: string }[] = [
  { kind: "chat-project", tag: "chat_current_project", label: "当前项目指令" },
  { kind: "chat-collaboration", tag: "chat_project_collaboration", label: "协作上下文" },
  { kind: "chat-custom-instructions", tag: "chat_agent_custom_instructions", label: "自定义指令（含规则）" },
];

function splitSystemSections(text: string): PromptCaptureSystemSection[] {
  const sections: PromptCaptureSystemSection[] = [];
  const pattern = new RegExp(
    String.raw`<(${CHAT_SECTION_TAGS.map((section) => section.tag).join("|")})>([\s\S]*?)<\/\1>`,
    "g",
  );
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const tag = match[1];
    const section = CHAT_SECTION_TAGS.find((candidate) => candidate.tag === tag);
    if (section === undefined) continue;
    if (match.index !== undefined && match.index > cursor) {
      const before = text.slice(cursor, match.index).trim();
      if (before !== "") sections.push({ kind: "pi-base", label: "系统基础与资源", text: before });
    }
    sections.push({ kind: section.kind, label: section.label, text: match[0].trim() });
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (cursor < text.length) {
    const rest = text.slice(cursor).trim();
    if (rest !== "") sections.push({ kind: "pi-base", label: "系统基础与资源", text: rest });
  }
  if (sections.length === 0 && text.trim() !== "") {
    sections.push({ kind: "pi-base", label: "系统基础与资源", text: text.trim() });
  }
  return sections;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (block !== null && typeof block === "object" && "text" in (block as Record<string, unknown>)) {
      return String((block as Record<string, unknown>).text ?? "");
    }
    return "";
  }).join("\n");
}

/** Projects the neutral agent message list into convertible order (Pi convertToLlm semantics). */
function convertibleNeutralMessages(messages: readonly AgentMessage[]): readonly { role: string; customType?: string; timestamp?: number }[] {
  const projected: { role: string; customType?: string; timestamp?: number }[] = [];
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    const timestamp = (message as { timestamp?: number }).timestamp;
    if (role === "custom") {
      const customType = (message as { customType?: string }).customType;
      projected.push({ role: "user", ...(customType === undefined ? {} : { customType }), ...(timestamp === undefined ? {} : { timestamp }) });
    } else if (role === "bashExecution") {
      if ((message as { excludeFromContext?: boolean }).excludeFromContext === true) continue;
      projected.push({ role: "user", ...(timestamp === undefined ? {} : { timestamp }) });
    } else if (role === "branchSummary" || role === "compactionSummary") {
      projected.push({ role: "user", ...(timestamp === undefined ? {} : { timestamp }) });
    } else if (role === "user" || role === "assistant" || role === "toolResult") {
      projected.push({ role, ...(timestamp === undefined ? {} : { timestamp }) });
    }
  }
  return projected;
}

function classifyRegions(
  payloadMessages: readonly { role: string; content: unknown }[],
  neutral: readonly { role: string; customType?: string; timestamp?: number }[] | undefined,
): PromptCaptureMessageRegion[] {
  const body = payloadMessages;
  const aligned = neutral !== undefined && neutral.length === body.length;
  let lastUserIndex = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (body[index]?.role === "user") { lastUserIndex = index; break; }
  }
  return body.map((message, index) => {
    const neutralMessage = aligned ? neutral[index] : undefined;
    let region: PromptCaptureMessageRegion["region"] = "unclassified";
    if (neutralMessage?.customType !== undefined) region = "injected-instruction";
    else if (message.role === "tool") region = "tool-result";
    else if (message.role === "assistant") region = "assistant";
    else if (message.role === "user") region = index === lastUserIndex ? "current-user-message" : "history-user";
    return {
      index,
      role: message.role as PromptCaptureMessageRegion["role"],
      region,
      ...(neutralMessage?.customType === undefined ? {} : { customType: neutralMessage.customType }),
      ...(neutralMessage?.timestamp === undefined ? {} : { timestamp: neutralMessage.timestamp }),
      chars: messageText(message.content).length,
      text: messageText(message.content),
    };
  });
}

interface OpenAiChatPayload {
  messages?: { role?: string; content?: unknown }[];
  tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[];
}

function parseOpenAiRegions(payload: OpenAiChatPayload, neutral: readonly { role: string; customType?: string; timestamp?: number }[] | undefined): PromptCaptureRegions {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemIndex = messages.findIndex((message) => message?.role === "system");
  const systemText = systemIndex >= 0 ? messageText(messages[systemIndex]?.content) : "";
  const body = messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => index !== systemIndex)
    .map(({ message }) => ({ role: String(message?.role ?? ""), content: message?.content }));
  return {
    parsed: true,
    ...(systemIndex >= 0 ? { systemPrompt: {
      chars: systemText.length,
      text: systemText,
      sections: splitSystemSections(systemText),
    } } : {}),
    messages: classifyRegions(body, neutral),
    ...(Array.isArray(payload.tools) ? { tools: payload.tools.map((tool) => ({
      name: String(tool?.function?.name ?? ""),
      ...(tool?.function?.description === undefined ? {} : { description: String(tool.function.description) }),
      parametersChars: JSON.stringify(tool?.function?.parameters ?? {}).length,
    })) } : {}),
  };
}

interface AnthropicPayload {
  system?: unknown;
  messages?: { role?: string; content?: unknown }[];
  tools?: { name?: string; description?: string; input_schema?: unknown }[];
}

function parseAnthropicRegions(payload: AnthropicPayload, neutral: readonly { role: string; customType?: string; timestamp?: number }[] | undefined): PromptCaptureRegions {
  const systemText = typeof payload.system === "string" ? payload.system : Array.isArray(payload.system) ? messageText(payload.system) : "";
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const body = messages.map((message) => ({ role: String(message?.role ?? ""), content: message?.content }));
  const mappedBody = body.map((message) => ({ ...message, role: message.role === "toolResult" ? "tool" : message.role }));
  return {
    parsed: true,
    ...(systemText === "" ? {} : { systemPrompt: { chars: systemText.length, text: systemText, sections: splitSystemSections(systemText) } }),
    messages: classifyRegions(mappedBody, neutral),
    ...(Array.isArray(payload.tools) ? { tools: payload.tools.map((tool) => ({
      name: String(tool?.name ?? ""),
      ...(tool?.description === undefined ? {} : { description: String(tool.description) }),
      parametersChars: JSON.stringify(tool?.input_schema ?? {}).length,
    })) } : {}),
  };
}

/**
 * Decomposes one final provider payload into regions. Unknown API shapes fail
 * open: the capture still stores the payload verbatim with parsed=false.
 */
export function parseProviderPayloadRegions(
  payload: unknown,
  api: string | undefined,
  neutralMessages: readonly AgentMessage[] | undefined,
): PromptCaptureRegions {
  const neutral = neutralMessages === undefined ? undefined : convertibleNeutralMessages(neutralMessages);
  try {
    if (api === "openai-completions") return parseOpenAiRegions(payload as OpenAiChatPayload, neutral);
    if (api === "anthropic-messages") return parseAnthropicRegions(payload as AnthropicPayload, neutral);
    if (payload !== null && typeof payload === "object") {
      const candidate = payload as OpenAiChatPayload & AnthropicPayload;
      if (Array.isArray(candidate.messages) && candidate.messages.some((message) => message?.role === "system")) {
        return parseOpenAiRegions(candidate, neutral);
      }
      if (Array.isArray(candidate.messages) && candidate.system !== undefined) {
        return parseAnthropicRegions(candidate, neutral);
      }
    }
    return { parsed: false, ...(api === undefined ? {} : { api }), parseError: `未知的Provider API形态: ${api ?? "unknown"}` };
  } catch (error) {
    return { parsed: false, ...(api === undefined ? {} : { api }), parseError: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Recorder (one per assembled agent session)
// ---------------------------------------------------------------------------

export interface PromptCaptureRecorder {
  readonly turn: PromptCaptureTurn;
  /** Snapshots the final neutral context list for the NEXT provider request. */
  pushNeutralContext: (messages: readonly AgentMessage[]) => void;
  record: (payload: unknown, model: { provider: string; modelId: string; api?: string }) => Promise<void>;
}

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(directory: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(directory) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueues.set(directory, next);
  void next.catch(() => undefined);
  return next;
}

/** Creates the capture sink for one assembled agent session. */
export function createPromptCaptureRecorder(input: {
  readonly sessionDir: string;
  readonly storageProjectId: string;
  readonly sessionId: string;
  readonly turn: PromptCaptureTurn;
  readonly agent: PromptCaptureAgentIdentity;
}): PromptCaptureRecorder {
  const directory = promptCaptureDir(input.sessionDir, input.sessionId);
  const neutralQueue: (readonly AgentMessage[] | undefined)[] = [];
  let seq = 0;
  return {
    turn: input.turn,
    pushNeutralContext(messages) {
      neutralQueue.push(messages);
    },
    async record(payload, model) {
      seq += 1;
      const neutral = neutralQueue.shift();
      const serialized = JSON.stringify(payload);
      const requestId = randomUUID();
      const record: PromptCaptureRecord = {
        schemaVersion: PROMPT_CAPTURE_SCHEMA_VERSION,
        requestId,
        seq,
        timestamp: new Date().toISOString(),
        storageProjectId: input.storageProjectId,
        sessionId: input.sessionId,
        turn: input.turn,
        agent: input.agent,
        model,
        kind: neutral === undefined ? "direct" : "agent",
        payloadChars: serialized.length,
        payloadSha256: createHash("sha256").update(serialized).digest("hex"),
        file: `${requestId}.json.gz`,
        regions: parseProviderPayloadRegions(payload, model.api, neutral),
      };
      await enqueueWrite(directory, async () => {
        await mkdir(directory, { recursive: true });
        const gz = gzipSync(Buffer.from(serialized, "utf8"));
        await appendFile(captureFilePath(directory, requestId), gz);
        await appendFile(join(directory, "index.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Read model + lifecycle
// ---------------------------------------------------------------------------

export async function readPromptCaptureIndex(sessionDir: string, sessionId: string): Promise<readonly PromptCaptureRecord[]> {
  const records: PromptCaptureRecord[] = [];
  let raw: string;
  try {
    raw = await readFile(join(promptCaptureDir(sessionDir, sessionId), "index.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === "object" && (value as PromptCaptureRecord).schemaVersion === PROMPT_CAPTURE_SCHEMA_VERSION) {
        records.push(value as PromptCaptureRecord);
      }
    } catch {
      // A torn trailing line (crash mid-append) must not hide the earlier records.
    }
  }
  return records;
}

export async function readPromptCapturePayload(sessionDir: string, sessionId: string, record: PromptCaptureRecord): Promise<unknown> {
  const gz = await readFile(join(promptCaptureDir(sessionDir, sessionId), record.file));
  return JSON.parse(gunzipSync(gz).toString("utf8")) as unknown;
}

/** True when the session still has capture artifacts on disk. */
export async function hasPromptCaptures(sessionDir: string, sessionId: string): Promise<boolean> {
  try {
    const entries = await readdir(promptCaptureDir(sessionDir, sessionId));
    return entries.length > 0;
  } catch {
    return false;
  }
}

/** Irreversible delete, tied to the session purge decision (never called on remove/restore). */
export async function purgePromptCaptures(sessionDir: string, sessionId: string): Promise<void> {
  await rm(promptCaptureDir(sessionDir, sessionId), { recursive: true, force: true });
}
