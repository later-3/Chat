import { mkdir, mkdtemp, link, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveProjectContext } from "./projects/registry.js";
import { requireChatSession } from "./session-read-model.js";
import { assertChatSessionIsIdle } from "./session-activity.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "./session-operation-lock.js";
import { CHAT_SESSION_FORK } from "./session-fork-boundary.js";
import { SessionInputError, SessionLifecycleError } from "./session-errors.js";
import { atomicWriteJson } from "./persistence/versioned-file.js";
import { findInactiveChatSessionState } from "./removed-session-index.js";

export interface ForkSessionInput {
  projectId: string;
  entryId: string;
  requestId: string;
}

export function parseForkSessionInput(value: unknown): ForkSessionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some((key) => !["projectId", "entryId", "requestId"].includes(key))
    || !("projectId" in value) || typeof value.projectId !== "string" || !value.projectId.trim()
    || !("entryId" in value) || typeof value.entryId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.entryId)
    || !("requestId" in value) || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId)) {
    throw new SessionInputError("Fork需要projectId、entryId和UUID requestId，且不能包含其他字段");
  }
  return { projectId: value.projectId, entryId: value.entryId, requestId: value.requestId };
}

export async function forkChatSession(sessionId: string, input: ForkSessionInput, chatHome?: string) {
  const project = await resolveProjectContext(input.projectId, chatHome);
  return withChatSessionOperationLock(`fork:${project.projectId}:${input.requestId}`, () =>
    withChatSessionOperationLock(chatSessionOperationKey(project.projectId, sessionId), async () => {
    const source = await requireChatSession(sessionId, project.projectId, chatHome);
    if (source.owner.type !== "ordinary") throw new SessionInputError("本期只支持普通Workflow Session分叉");
    const destination = join(project.sessionDir, `fork-${input.requestId}.jsonl`);
    const receipt = { schemaVersion: 1, sourceSessionId: sessionId, entryId: input.entryId, requestId: input.requestId };
    const stagingRoot = join(project.projectDataDir, "session-operations");
    const operationPath = join(stagingRoot, `fork-${input.requestId}.json`);
    const result = (manager: SessionManager, selectedText: string) => ({
      schemaVersion: 1 as const, projectId: project.projectId, sessionId: manager.getSessionId(),
      parentSessionId: sessionId, selectedText,
    });
    // Keep the identity receipt after publication/removal. A late retry must not resurrect a deleted child.
    let operation: unknown;
    try { operation = JSON.parse(await readFile(operationPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (operation !== undefined) {
      if (typeof operation !== "object" || operation === null || !("receipt" in operation)
        || JSON.stringify(operation.receipt) !== JSON.stringify(receipt)
        || !("sessionId" in operation) || typeof operation.sessionId !== "string"
        || !("directory" in operation) || typeof operation.directory !== "string" || !/^fork-[a-zA-Z0-9]+$/.test(operation.directory)
        || !("file" in operation) || typeof operation.file !== "string" || basename(operation.file) !== operation.file || !operation.file.endsWith(".jsonl")) {
        throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "Fork requestId已被使用或记录损坏");
      }
      const inactive = await findInactiveChatSessionState(project, operation.sessionId);
      if (inactive === "removed" || inactive === "purged") {
        throw new SessionLifecycleError(inactive === "removed" ? "SESSION_REMOVED" : "SESSION_PURGED", "Fork子会话已移除；旧请求不会重新创建会话");
      }
      const stagedDirectory = join(stagingRoot, operation.directory);
      try { await stat(destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A crash between receipt and publication resumes the already prepared native Session.
        const stagedFile = join(stagedDirectory, operation.file);
        const child = SessionManager.open(stagedFile, stagedDirectory);
        if (child.getSessionId() !== operation.sessionId) throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "Fork准备文件丢失或身份不匹配");
        await link(stagedFile, destination);
      }
      await rm(stagedDirectory, { recursive: true, force: true });
    }
    try {
      await stat(destination);
      const existing = SessionManager.open(destination, project.sessionDir);
      if (typeof operation === "object" && operation !== null && "sessionId" in operation && operation.sessionId !== existing.getSessionId()) {
        throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "Fork子会话身份与请求记录不匹配");
      }
      const marker = existing.getEntries().find((entry) => entry.type === "custom" && entry.customType === CHAT_SESSION_FORK
        && typeof entry.data === "object" && entry.data !== null && "requestId" in entry.data
        && entry.data.requestId === input.requestId);
      if (marker?.type !== "custom" || JSON.stringify(marker.data) !== JSON.stringify(receipt)) {
        throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "Fork requestId已用于其他分叉请求");
      }
      const original = SessionManager.open(source.path, project.sessionDir).getEntry(input.entryId);
      return result(existing, original?.type === "message" && original.message.role === "user"
        ? userText(original.message.content) : "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (operation !== undefined) throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "已接受的Fork文件不可用，请检查会话生命周期状态");
    }
    await assertChatSessionIsIdle(project, sessionId);
    const sourceManager = SessionManager.open(source.path, project.sessionDir);
    const selected = sourceManager.getEntry(input.entryId);
    if (selected?.type !== "message" || selected.message.role !== "user") {
      throw new SessionInputError("请选择一条用户消息；Fork从该消息之前创建新会话");
    }
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(stagingRoot, "fork-"));
    let prepared = false;
    let published = false;
    try {
      const child = SessionManager.open(source.path, staging);
      if (selected.parentId === null) child.newSession({ parentSession: source.path });
      else child.createBranchedSession(selected.parentId);
      child.appendCustomEntry(CHAT_SESSION_FORK, receipt);
      child.appendSessionInfo(`${source.name ?? source.firstMessage ?? "Session"} (fork)`);
      child.flush();
      const file = child.getSessionFile();
      if (file === undefined) throw new Error("Fork未生成Session文件");
      await atomicWriteJson(operationPath, { receipt, sessionId: child.getSessionId(), directory: basename(staging), file: basename(file) });
      prepared = true;
      // Exclusive publication: readers never see a half-written JSONL; source is never mutated.
      await link(file, destination);
      published = true;
      return result(child, userText(selected.message.content));
    } finally {
      if (!prepared || published) await rm(staging, { recursive: true, force: true });
    }
  }));
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");
}
