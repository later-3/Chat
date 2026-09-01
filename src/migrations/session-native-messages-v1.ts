import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE,
} from "../workflows/session-conversation.js";
import {
  CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE,
  CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION,
  CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE,
  CHAT_WORKFLOW_STAGE_CUSTOM_TYPE,
} from "../workflows/workflow-stage.js";
import { CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE } from "../workflows/planning-execution/review-state.js";

export const SESSION_NATIVE_MESSAGES_MIGRATION_ID = "session-native-messages-v1";
export const CHAT_SESSION_MIGRATION_CUSTOM_TYPE = "chat.session_migration";

export interface SessionNativeMessagesMigrationResult {
  readonly migrated: boolean;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly backupPath?: string;
  readonly insertedMessageIds: readonly string[];
  readonly convertedMessageIds: readonly string[];
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => (
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []
  )).join("\n");
}

function nativeUserEntry(id: string, parentId: unknown, timestamp: unknown, text: string): JsonObject {
  return {
    type: "message",
    id,
    parentId: typeof parentId === "string" ? parentId : null,
    timestamp: typeof timestamp === "string" ? timestamp : new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))
        ? Date.parse(timestamp)
        : Date.now(),
    },
  };
}

function generateEntryId(ids: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      ids.add(id);
      return id;
    }
  }
  const id = randomUUID();
  ids.add(id);
  return id;
}

function insertBefore(entries: JsonObject[], index: number, entry: JsonObject): void {
  const target = entries[index];
  if (target === undefined) throw new Error("Session迁移插入目标不存在");
  entry.parentId = typeof target.parentId === "string" ? target.parentId : null;
  target.parentId = entry.id;
  entries.splice(index, 0, entry);
}

function isMigrationMarker(entry: JsonObject): boolean {
  return entry.type === "custom"
    && entry.customType === CHAT_SESSION_MIGRATION_CUSTOM_TYPE
    && isRecord(entry.data)
    && entry.data.migrationId === SESSION_NATIVE_MESSAGES_MIGRATION_ID;
}

function expandedSkillUserText(text: string): string | undefined {
  if (!text.startsWith("<skill name=")) return undefined;
  const closing = text.indexOf("</skill>");
  if (closing === -1) return undefined;
  const userText = text.slice(closing + "</skill>".length).replace(/^\s+/, "");
  return userText === "" ? undefined : userText;
}

function replaceUserMessageText(entry: JsonObject, text: string): void {
  if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return;
  entry.message = {
    ...entry.message,
    content: [{ type: "text", text }],
  };
}

function findNextUserEntry(entries: JsonObject[], start: number): JsonObject | undefined {
  for (let index = start + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (entry.type === "custom" && entry.customType === CHAT_WORKFLOW_STAGE_CUSTOM_TYPE) return undefined;
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") return entry;
  }
  return undefined;
}

function migrateEntries(entries: JsonObject[]): {
  changed: boolean;
  insertedMessageIds: string[];
  convertedMessageIds: string[];
} {
  const ids = new Set(entries.flatMap((entry) => (isNonEmptyString(entry.id) ? [entry.id] : [])));
  const insertedMessageIds: string[] = [];
  const convertedMessageIds: string[] = [];
  const originalUserByInvocation = new Map<string, string>();
  const latestPlanByInvocation = new Map<string, string>();
  const latestFeedbackByInvocation = new Map<string, string>();
  const legacyExecuteInputs = new Map<string, {
    userPrompt: string;
    plan: string;
    inputEntryIds: string[];
  }>();
  let changed = false;

  // Agent utterances keep their existing IDs so review references stay valid.
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CHAT_WORKFLOW_MESSAGE_CUSTOM_TYPE
      || !isRecord(entry.data) || !isRecord(entry.data.message)) continue;
    const message = entry.data.message;
    if (message.role !== "assistant") continue;
    entry.type = "message";
    entry.message = message;
    delete entry.customType;
    delete entry.data;
    if (isNonEmptyString(entry.id)) convertedMessageIds.push(entry.id);
    changed = true;
  }

  let scannedInvocation: string | undefined;
  let scannedStage: string | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;

    if (entry.type === "custom" && entry.customType === CHAT_WORKFLOW_STAGE_CUSTOM_TYPE
      && isRecord(entry.data)) {
      scannedInvocation = isNonEmptyString(entry.data.invocationId) ? entry.data.invocationId : undefined;
      scannedStage = isNonEmptyString(entry.data.stageId) ? entry.data.stageId : undefined;
      continue;
    }

    if (scannedInvocation !== undefined && scannedStage === "plan" && entry.type === "message"
      && isRecord(entry.message) && entry.message.role === "assistant" && isNonEmptyString(entry.id)) {
      latestPlanByInvocation.set(scannedInvocation, entry.id);
      continue;
    }

    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") {
      const exact = expandedSkillUserText(messageText(entry.message));
      if (exact !== undefined) {
        replaceUserMessageText(entry, exact);
        changed = true;
      }
      continue;
    }

    if (entry.type === "custom" && entry.customType === CHAT_PLAN_REVIEW_DECISION_CUSTOM_TYPE
      && isRecord(entry.data) && entry.data.kind === "request_revision"
      && typeof entry.data.feedback === "string" && !isNonEmptyString(entry.data.feedbackEntryId)) {
      const reviewData = entry.data;
      const feedbackEntryId = generateEntryId(ids);
      insertBefore(entries, index, nativeUserEntry(
        feedbackEntryId,
        entry.parentId,
        entry.timestamp,
        reviewData.feedback as string,
      ));
      insertedMessageIds.push(feedbackEntryId);
      entry.data = { ...reviewData, schemaVersion: 2, feedbackEntryId };
      if (isNonEmptyString(reviewData.workflowInvocationId)) {
        latestFeedbackByInvocation.set(reviewData.workflowInvocationId, feedbackEntryId);
      }
      changed = true;
      index += 1;
      continue;
    }

    if (entry.type !== "custom" || entry.customType !== CHAT_WORKFLOW_AGENT_INPUT_CUSTOM_TYPE
      || !isRecord(entry.data) || entry.data.schemaVersion !== 1
      || !isNonEmptyString(entry.data.invocationId) || !isNonEmptyString(entry.data.workflowId)
      || !isNonEmptyString(entry.data.stageId) || !isNonEmptyString(entry.data.agentId)
      || typeof entry.data.userPrompt !== "string") continue;

    const data = entry.data;
    const invocationId = data.invocationId as string;
    const workflowId = data.workflowId as string;
    const stageId = data.stageId as string;
    const agentId = data.agentId as string;
    const userPrompt = data.userPrompt as string;
    const inputEntryIds: string[] = [];
    if (workflowId === "planning-execution") {
      let originalUserEntryId = originalUserByInvocation.get(invocationId);
      if (originalUserEntryId === undefined && stageId === "plan") {
        originalUserEntryId = generateEntryId(ids);
        insertBefore(entries, index, nativeUserEntry(
          originalUserEntryId,
          entry.parentId,
          entry.timestamp,
          userPrompt,
        ));
        insertedMessageIds.push(originalUserEntryId);
        originalUserByInvocation.set(invocationId, originalUserEntryId);
        changed = true;
        index += 1;
      }
      if (originalUserEntryId !== undefined) inputEntryIds.push(originalUserEntryId);
      const feedbackEntryId = latestFeedbackByInvocation.get(invocationId);
      if (feedbackEntryId !== undefined) inputEntryIds.push(feedbackEntryId);
      const planEntryId = latestPlanByInvocation.get(invocationId);
      if (planEntryId !== undefined) inputEntryIds.push(planEntryId);
      if (stageId === "execute") {
        const upstream = isRecord(data.upstream) && typeof data.upstream.output === "string"
          ? data.upstream.output
          : "";
        legacyExecuteInputs.set(invocationId, {
          userPrompt,
          plan: upstream,
          inputEntryIds: [...inputEntryIds],
        });
      }
    } else {
      const nextUser = findNextUserEntry(entries, index);
      let userEntryId: string;
      if (nextUser !== undefined && isNonEmptyString(nextUser.id)) {
        userEntryId = nextUser.id;
        replaceUserMessageText(nextUser, userPrompt);
      } else {
        userEntryId = generateEntryId(ids);
        insertBefore(entries, index, nativeUserEntry(userEntryId, entry.parentId, entry.timestamp, userPrompt));
        insertedMessageIds.push(userEntryId);
        index += 1;
      }
      inputEntryIds.push(userEntryId);
    }
    if (inputEntryIds.length === 0) continue;
    entry.data = {
      schemaVersion: CHAT_WORKFLOW_AGENT_INPUT_SCHEMA_VERSION,
      invocationId,
      workflowId,
      stageId,
      agentId,
      inputEntryIds: [...new Set(inputEntryIds)],
    };
    changed = true;
  }

  // Old Executor turns persisted the original request a second time as user.
  let activeInvocation: string | undefined;
  let activeStage: string | undefined;
  const convertedExecuteInvocations = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === CHAT_WORKFLOW_STAGE_CUSTOM_TYPE && isRecord(entry.data)) {
      activeInvocation = isNonEmptyString(entry.data.invocationId) ? entry.data.invocationId : undefined;
      activeStage = isNonEmptyString(entry.data.stageId) ? entry.data.stageId : undefined;
      continue;
    }
    const legacy = activeInvocation === undefined ? undefined : legacyExecuteInputs.get(activeInvocation);
    if (activeStage !== "execute" || legacy === undefined || entry.type !== "message"
      || convertedExecuteInvocations.has(activeInvocation as string)
      || !isRecord(entry.message) || entry.message.role !== "user") continue;
    entry.type = "custom_message";
    entry.customType = CHAT_WORKFLOW_AGENT_HANDOFF_CUSTOM_TYPE;
    entry.content = [
      "<workflow_execution_input>",
      JSON.stringify({ userRequest: legacy.userPrompt, plannerOutput: legacy.plan }, null, 2),
      "</workflow_execution_input>",
    ].join("\n");
    entry.display = false;
    entry.details = {
      schemaVersion: 1,
      workflowId: "planning-execution",
      invocationId: activeInvocation,
      stageId: "execute",
      inputEntryIds: legacy.inputEntryIds,
    };
    delete entry.message;
    convertedExecuteInvocations.add(activeInvocation as string);
    changed = true;
  }

  return { changed, insertedMessageIds, convertedMessageIds };
}

const migrations = new Map<string, Promise<SessionNativeMessagesMigrationResult>>();

/**
 * Rewrites legacy value-copying Workflow entries into native Pi messages.
 * The original JSONL is retained under a named migration directory and the
 * rewritten file carries an idempotency marker, so retries are safe.
 */
export async function migrateSessionNativeMessagesV1(input: {
  readonly sessionFile: string;
  readonly projectDataDir: string;
}): Promise<SessionNativeMessagesMigrationResult> {
  const sessionFile = resolve(input.sessionFile);
  const previous = migrations.get(sessionFile);
  if (previous !== undefined) return previous;
  const current = (async () => {
    const source = await readFile(sessionFile, "utf8");
    const values = source.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
    if (values.length === 0 || !isRecord(values[0]) || values[0].type !== "session"
      || !isNonEmptyString(values[0].id)) throw new Error(`Session文件无效: ${sessionFile}`);
    const header = values[0];
    if (values.slice(1).some((value) => !isRecord(value))) {
      throw new Error(`Session文件包含非对象Entry: ${sessionFile}`);
    }
    const entries = values.slice(1) as JsonObject[];
    if (entries.some(isMigrationMarker)) {
      return {
        migrated: false,
        sessionId: header.id as string,
        sessionFile,
        insertedMessageIds: [],
        convertedMessageIds: [],
      };
    }
    const migrated = migrateEntries(entries);
    if (!migrated.changed) {
      return {
        migrated: false,
        sessionId: header.id as string,
        sessionFile,
        insertedMessageIds: [],
        convertedMessageIds: [],
      };
    }

    const migrationRoot = resolve(input.projectDataDir, "migrations", SESSION_NATIVE_MESSAGES_MIGRATION_ID);
    const backupPath = resolve(migrationRoot, "backups", `${basename(sessionFile)}.original`);
    await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 });
    try {
      await copyFile(sessionFile, backupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingBackup = await readFile(backupPath, "utf8");
      if (sha256(existingBackup) !== sha256(source)) {
        throw new Error(`Session迁移备份与当前源文件不一致: ${sessionFile}`);
      }
    }

    const parentId = entries.findLast((entry) => isNonEmptyString(entry.id))?.id ?? null;
    const ids = new Set(entries.flatMap((entry) => (isNonEmptyString(entry.id) ? [entry.id] : [])));
    entries.push({
      type: "custom",
      customType: CHAT_SESSION_MIGRATION_CUSTOM_TYPE,
      id: generateEntryId(ids),
      parentId,
      timestamp: new Date().toISOString(),
      data: {
        schemaVersion: 1,
        migrationId: SESSION_NATIVE_MESSAGES_MIGRATION_ID,
        sourceSha256: sha256(source),
        backupRelativePath: relative(input.projectDataDir, backupPath),
        insertedMessageIds: migrated.insertedMessageIds,
        convertedMessageIds: migrated.convertedMessageIds,
        completedAt: new Date().toISOString(),
      },
    });
    const output = `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const temporary = `${sessionFile}.${randomUUID()}.tmp`;
    const mode = (await stat(sessionFile)).mode;
    try {
      await writeFile(temporary, output, { encoding: "utf8", mode: mode & 0o777 });
      await rename(temporary, sessionFile);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    return {
      migrated: true,
      sessionId: header.id as string,
      sessionFile,
      backupPath,
      insertedMessageIds: migrated.insertedMessageIds,
      convertedMessageIds: migrated.convertedMessageIds,
    };
  })();
  migrations.set(sessionFile, current);
  try {
    return await current;
  } finally {
    migrations.delete(sessionFile);
  }
}

/** Restores the exact pre-migration JSONL retained by this named migration. */
export async function restoreSessionNativeMessagesV1(input: {
  readonly sessionFile: string;
  readonly backupPath: string;
}): Promise<void> {
  const sessionFile = resolve(input.sessionFile);
  const backupPath = resolve(input.backupPath);
  const [current, backup] = await Promise.all([
    readFile(sessionFile, "utf8"),
    readFile(backupPath, "utf8"),
  ]);
  const currentValues = current.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const backupValues = backup.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  const currentHeader = currentValues[0];
  const backupHeader = backupValues[0];
  if (!isRecord(currentHeader) || !isRecord(backupHeader)
    || currentHeader.type !== "session" || backupHeader.type !== "session"
    || currentHeader.id !== backupHeader.id) {
    throw new Error("Session迁移备份与目标Session不匹配");
  }
  const marker = currentValues.find((value) => isRecord(value) && isMigrationMarker(value));
  if (!isRecord(marker) || !isRecord(marker.data) || marker.data.sourceSha256 !== sha256(backup)) {
    throw new Error("Session迁移备份哈希与迁移标记不匹配");
  }
  const temporary = `${sessionFile}.${randomUUID()}.restore.tmp`;
  const mode = (await stat(sessionFile)).mode;
  try {
    await writeFile(temporary, backup, { encoding: "utf8", mode: mode & 0o777 });
    await rename(temporary, sessionFile);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
