import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type {
  MemorySessionSourceDescriptor,
  MemorySessionSourcePort,
  MemorySessionSourceRegistryPort,
} from "@chat/application";
import { codexSessionIdSchema, type CodexSessionId } from "@chat/contracts";
import type { NormalizedMemorySessionSnapshot } from "@chat/domain";

const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_LINES = 250_000;
const MAX_VISIBLE_CHARACTERS = 5_000_000;
const MAX_DISCOVERED_FILES = 10_000;

const indexEntrySchema = z
  .object({
    id: codexSessionIdSchema,
    thread_name: z.string().max(500),
    updated_at: z.iso.datetime(),
  })
  .strict();

const lineSchema = z
  .object({
    type: z.string(),
    timestamp: z.iso.datetime().optional(),
    ordinal: z.number().int().nonnegative().optional(),
    payload: z.unknown(),
  })
  .loose();

const sessionMetaPayloadSchema = z
  .object({
    id: codexSessionIdSchema,
    timestamp: z.iso.datetime(),
  })
  .loose();

const visibleContentSchema = z
  .object({
    type: z.enum(["input_text", "output_text"]),
    text: z.string().max(MAX_VISIBLE_CHARACTERS),
  })
  .loose();

const visibleMessagePayloadSchema = z
  .object({
    type: z.literal("message"),
    id: z.string().min(1).max(200).optional(),
    role: z.enum(["user", "assistant"]),
    content: z.array(z.unknown()).max(1_000),
    internal_chat_message_metadata_passthrough: z
      .object({ turn_id: z.string().min(1).max(200).optional() })
      .loose()
      .optional(),
  })
  .loose();

export class CodexSessionSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexSessionSourceError";
    this.code = code;
  }
}

interface DiscoveredSession {
  readonly id: CodexSessionId;
  readonly path: string;
  readonly fallbackUpdatedAt: string;
}

function sessionIdFromFilename(name: string): CodexSessionId | undefined {
  const match = name.match(/([0-9a-f]{8}-[0-9a-f-]{27,71})\.jsonl$/u);
  const parsed = codexSessionIdSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : undefined;
}

function timestampFromFilename(name: string): string {
  const match = name.match(/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/u);
  const parsed = match?.[1]?.replace(
    /T(\d{2})-(\d{2})-(\d{2})$/u,
    (_all, hour, minute, second) => `T${hour}:${minute}:${second}.000Z`,
  );
  return z.iso.datetime().safeParse(parsed).success ? parsed! : "1970-01-01T00:00:00.000Z";
}

function stableTurnKey(value: string): string {
  return value.length <= 160
    ? value
    : `turn-${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}

async function walkSessionFiles(root: string, output: DiscoveredSession[]): Promise<void> {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new CodexSessionSourceError(
      "memory.session_source.root_invalid",
      "Codex Session目录不是受支持的普通目录",
    );
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkSessionFiles(path, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const id = sessionIdFromFilename(entry.name);
    if (id === undefined) continue;
    output.push({ id, path, fallbackUpdatedAt: timestampFromFilename(entry.name) });
    if (output.length > MAX_DISCOVERED_FILES) {
      throw new CodexSessionSourceError(
        "memory.session_source.too_many_files",
        "Codex Session文件数量超过安全上限",
      );
    }
  }
}

export class CodexSessionSourceAdapter implements MemorySessionSourcePort {
  readonly kind = "codex" as const;
  readonly #codexHome: string;

  constructor(input: { readonly codexHome: string }) {
    if (!isAbsolute(input.codexHome)) {
      throw new CodexSessionSourceError(
        "memory.session_source.config_invalid",
        "Codex Home必须是绝对路径",
      );
    }
    this.#codexHome = resolve(input.codexHome);
  }

  async #discover(): Promise<readonly DiscoveredSession[]> {
    const output: DiscoveredSession[] = [];
    await walkSessionFiles(join(this.#codexHome, "sessions"), output);
    await walkSessionFiles(join(this.#codexHome, "archived_sessions"), output);
    const byId = new Map<string, DiscoveredSession>();
    for (const entry of output) {
      const current = byId.get(entry.id);
      if (current === undefined || entry.fallbackUpdatedAt > current.fallbackUpdatedAt) {
        byId.set(entry.id, entry);
      }
    }
    return [...byId.values()];
  }

  async #readIndex(): Promise<ReadonlyMap<string, MemorySessionSourceDescriptor>> {
    const path = join(this.#codexHome, "session_index.jsonl");
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_INDEX_BYTES) {
      throw new CodexSessionSourceError(
        "memory.session_source.index_invalid",
        "Codex Session索引不是受支持的普通文件",
      );
    }
    const raw = await readFile(path, "utf8");
    const byId = new Map<string, MemorySessionSourceDescriptor>();
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch {
        throw new CodexSessionSourceError(
          "memory.session_source.index_invalid",
          "Codex Session索引包含非法JSON",
        );
      }
      const parsed = indexEntrySchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new CodexSessionSourceError(
          "memory.session_source.index_contract_invalid",
          "Codex Session索引合同无法识别",
        );
      }
      byId.set(parsed.data.id, {
        sourceSessionId: parsed.data.id,
        title: parsed.data.thread_name.trim().slice(0, 200) || "Codex Session",
        updatedAt: parsed.data.updated_at,
      });
    }
    return byId;
  }

  async list(input: { readonly limit: number }): Promise<readonly MemorySessionSourceDescriptor[]> {
    const [discovered, indexed] = await Promise.all([this.#discover(), this.#readIndex()]);
    return discovered
      .map(
        (entry) =>
          indexed.get(entry.id) ?? {
            sourceSessionId: entry.id,
            title: "Codex Session",
            updatedAt: entry.fallbackUpdatedAt,
          },
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, input.limit);
  }

  async load(
    sourceSessionId: CodexSessionId,
  ): Promise<NormalizedMemorySessionSnapshot | undefined> {
    const discovered = (await this.#discover()).find((entry) => entry.id === sourceSessionId);
    if (discovered === undefined) return undefined;
    const stats = await lstat(discovered.path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SESSION_BYTES) {
      throw new CodexSessionSourceError(
        "memory.session_source.file_invalid",
        "Codex Session不是受支持的普通文件或超过大小上限",
      );
    }
    const indexed = await this.#readIndex();
    let sessionMetaTimestamp = discovered.fallbackUpdatedAt;
    let updatedAt = discovered.fallbackUpdatedAt;
    let visibleCharacters = 0;
    let lineCount = 0;
    const groups = new Map<
      string,
      { order: number; createdAt: string; user: string[]; assistant: string[] }
    >();
    const stream = createReadStream(discovered.path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const rawLine of lines) {
        lineCount += 1;
        if (lineCount > MAX_SESSION_LINES) {
          throw new CodexSessionSourceError(
            "memory.session_source.too_many_lines",
            "Codex Session行数超过安全上限",
          );
        }
        let raw: unknown;
        try {
          raw = JSON.parse(rawLine);
        } catch {
          throw new CodexSessionSourceError(
            "memory.session_source.file_invalid",
            "Codex Session包含非法JSONL",
          );
        }
        const line = lineSchema.safeParse(raw);
        if (!line.success) {
          throw new CodexSessionSourceError(
            "memory.session_source.file_contract_invalid",
            "Codex Session顶层合同无法识别",
          );
        }
        if (line.data.type === "session_meta") {
          const meta = sessionMetaPayloadSchema.safeParse(line.data.payload);
          if (meta.success && meta.data.id === sourceSessionId) {
            sessionMetaTimestamp = meta.data.timestamp;
          }
          continue;
        }
        if (line.data.type !== "response_item") continue;
        const message = visibleMessagePayloadSchema.safeParse(line.data.payload);
        if (!message.success) continue;
        const texts = message.data.content.flatMap((candidate) => {
          const content = visibleContentSchema.safeParse(candidate);
          return content.success && content.data.text.trim().length > 0 ? [content.data.text] : [];
        });
        if (texts.length === 0) continue;
        const text = texts.join("\n\n");
        visibleCharacters += text.length;
        if (visibleCharacters > MAX_VISIBLE_CHARACTERS) {
          throw new CodexSessionSourceError(
            "memory.session_source.visible_content_too_large",
            "Codex Session可见正文超过安全上限",
          );
        }
        const createdAt = line.data.timestamp ?? sessionMetaTimestamp;
        if (createdAt > updatedAt) updatedAt = createdAt;
        const turnId =
          message.data.internal_chat_message_metadata_passthrough?.turn_id ??
          message.data.id ??
          `ordinal-${String(line.data.ordinal ?? lineCount)}`;
        const group = groups.get(turnId) ?? {
          order: line.data.ordinal ?? lineCount,
          createdAt,
          user: [],
          assistant: [],
        };
        group[message.data.role].push(text);
        groups.set(turnId, group);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    const messages = [...groups.entries()]
      .sort((left, right) => left[1].order - right[1].order)
      .flatMap(([rawTurnId, group]) => {
        const turnId = stableTurnKey(rawTurnId);
        return [
          ...(group.user.length === 0
            ? []
            : [
                {
                  sourceMessageKey: `${turnId}:user`,
                  role: "user" as const,
                  text: group.user.join("\n\n"),
                  createdAt: group.createdAt,
                },
              ]),
          ...(group.assistant.length === 0
            ? []
            : [
                {
                  sourceMessageKey: `${turnId}:assistant`,
                  role: "assistant" as const,
                  text: group.assistant.join("\n\n"),
                  createdAt: group.createdAt,
                },
              ]),
        ];
      });
    return {
      sourceKind: "codex",
      sourceSessionId,
      title: indexed.get(sourceSessionId)?.title ?? "Codex Session",
      updatedAt,
      messages,
    };
  }
}

export function createCodexSessionSourceRegistry(
  codexHome: string,
): MemorySessionSourceRegistryPort {
  const adapter = new CodexSessionSourceAdapter({ codexHome });
  return { get: (kind) => (kind === "codex" ? adapter : undefined) };
}
