import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensureChatHome, resolveChatHome } from "./chat-home.js";

export interface ChatModelsConfig {
  readonly providers: Readonly<Record<string, unknown>>;
}

export interface ChatModelsConfigDocument {
  readonly schemaVersion: 1;
  readonly source: {
    readonly kind: "chat-home";
    readonly path: string;
  };
  readonly config: ChatModelsConfig;
}

export class InvalidChatModelsConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidChatModelsConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches Pi's supported models.json syntax without consulting Pi's default agent directory. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => (
      tail ?? (match[0] === '"' ? match : "")
    ));
}

function parseConfig(value: unknown, source: string): ChatModelsConfig {
  if (!isRecord(value) || !isRecord(value.providers)) {
    throw new InvalidChatModelsConfigError(`Chat模型配置必须包含providers对象: ${source}`);
  }
  return value as unknown as ChatModelsConfig;
}

async function validateConfigFile(modelsPath: string, authPath: string): Promise<void> {
  const runtime = await ModelRuntime.create({
    authPath,
    modelsPath,
    refreshOnCreate: false,
  });
  const error = runtime.getError();
  if (error !== undefined) throw new InvalidChatModelsConfigError(error);
}

function document(path: string, config: ChatModelsConfig): ChatModelsConfigDocument {
  return {
    schemaVersion: 1,
    source: { kind: "chat-home", path },
    config,
  };
}

export async function readChatModelsConfig(
  chatHome = resolveChatHome(),
): Promise<ChatModelsConfigDocument> {
  const home = await ensureChatHome(chatHome);
  const path = join(home.agentDir, "models.json");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return document(path, { providers: {} });
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content));
  } catch (error) {
    throw new InvalidChatModelsConfigError(
      `Chat模型配置不是有效JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const config = parseConfig(parsed, path);
  await validateConfigFile(path, join(home.agentDir, "auth.json"));
  return document(path, config);
}

const writes = new Map<string, Promise<void>>();

async function serializeWrite(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writes.set(path, current);
  try {
    await current;
  } finally {
    if (writes.get(path) === current) writes.delete(path);
  }
}

export async function writeChatModelsConfig(
  value: unknown,
  chatHome = resolveChatHome(),
): Promise<ChatModelsConfigDocument> {
  const home = await ensureChatHome(chatHome);
  const path = join(home.agentDir, "models.json");
  const config = parseConfig(value, path);

  await serializeWrite(path, async () => {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        await validateConfigFile(temporaryPath, join(home.agentDir, "auth.json"));
      } catch (error) {
        if (error instanceof InvalidChatModelsConfigError) {
          throw new InvalidChatModelsConfigError(error.message.replaceAll(temporaryPath, path), { cause: error });
        }
        throw error;
      }
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  });

  return document(path, config);
}
