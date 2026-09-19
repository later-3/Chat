import { readFile, realpath } from "node:fs/promises";
import type { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { assemblyRevision } from "./assembly-context.js";

const RESOURCE_SNAPSHOT = "chat.agent-assembly-resources.v1";

/** A settings/default change must not silently grant a recovered turn different tools. */
export function freezeAssemblyTools(manager: SessionManager, turnId: string, tools: readonly unknown[], persist: boolean): void {
  const customType = "chat.agent-assembly-tools.v1";
  const body = { schemaVersion: 1, turnId, tools };
  const revision = assemblyRevision(body);
  const saved = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === customType
    && typeof entry.data === "object" && entry.data !== null && "turnId" in entry.data && entry.data.turnId === turnId);
  if (saved?.type === "custom") {
    const value: unknown = saved.data;
    if (typeof value !== "object" || value === null || !("revision" in value)) throw new Error("工具快照损坏");
    const { revision: previousRevision, ...previous } = value;
    if (assemblyRevision(previous) !== previousRevision || revision !== previousRevision) {
      throw new Error("本轮工具选择或版本已变化，不能用新能力恢复旧任务");
    }
  } else if (persist) {
    manager.appendCustomEntry(customType, { ...body, revision });
    manager.flush();
  }
}

/** Check persisted source bodies before Pi imports extension code on recovery. */
export async function validateFrozenAssemblyResources(manager: SessionManager, turnId: string | undefined): Promise<string[] | undefined> {
  if (turnId === undefined) return undefined;
  const saved = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === RESOURCE_SNAPSHOT
    && typeof entry.data === "object" && entry.data !== null && "turnId" in entry.data && entry.data.turnId === turnId);
  if (saved?.type !== "custom") return undefined;
  const value: unknown = saved.data;
  if (typeof value !== "object" || value === null || !("revision" in value)) throw new Error("资源快照损坏");
  const { revision, ...body } = value;
  if (assemblyRevision(body) !== revision || !("files" in body) || !Array.isArray(body.files)
    || !("extensionPaths" in body) || !Array.isArray(body.extensionPaths)
    || !body.extensionPaths.every((path: unknown) => typeof path === "string")) throw new Error("资源快照内容无效");
  for (const file of body.files as unknown[]) {
    if (typeof file !== "object" || file === null || !("path" in file) || typeof file.path !== "string"
      || !("content" in file) || typeof file.content !== "string") throw new Error("资源快照文件无效");
    if (await realpath(file.path) !== file.path || await readFile(file.path, "utf8") !== file.content) {
      throw new Error("本轮冻结的资源版本已不可用，不能使用新版本恢复旧任务");
    }
  }
  if (body.extensionPaths.length > 0) {
    // Entry hashes cannot prove that arbitrary imported dependencies stayed unchanged.
    // The live turn keeps its loaded instance; a reconstructed turn must not reload new code.
    throw new Error("本轮扩展实例已不可恢复，入口文件快照不足以固定全部代码依赖；请发起新一轮任务，不自动重放旧任务");
  }
  return body.extensionPaths as string[];
}

/** Pin loaded resource revisions. Restart refuses changed/unavailable code instead of silently upgrading a turn. */
export async function freezeAssemblyResources(input: {
  readonly loader: DefaultResourceLoader;
  readonly manager: SessionManager;
  readonly turnId: string;
  readonly persist: boolean;
  readonly useLoadedSnapshot?: boolean;
}): Promise<ReadonlyMap<string, string>> {
  const { loader, manager, turnId } = input;
  if (input.useLoadedSnapshot) {
    const entry = manager.getEntries().findLast((item) => item.type === "custom" && item.customType === RESOURCE_SNAPSHOT
      && typeof item.data === "object" && item.data !== null && "turnId" in item.data && item.data.turnId === turnId);
    if (entry?.type !== "custom" || typeof entry.data !== "object" || entry.data === null || !("revision" in entry.data)) throw new Error("缺少已加载资源快照");
    const { revision, ...body } = entry.data;
    if (assemblyRevision(body) !== revision || !("files" in body) || !Array.isArray(body.files)) throw new Error("资源快照损坏");
    const files = new Map<string, string>();
    for (const file of body.files as unknown[]) {
      if (typeof file !== "object" || file === null || !("path" in file) || !("content" in file) || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("资源快照文件无效");
      files.set(file.path, file.content);
    }
    return files;
  }
  const paths = new Set([
    ...loader.getSkills().skills.map((skill) => skill.filePath),
    ...loader.getPrompts().prompts.map((prompt) => prompt.filePath),
    ...loader.getExtensions().extensions.map((extension) => extension.resolvedPath),
    ...loader.getAppendSystemPromptSources().map((source) => source.path),
    ...(loader.getSystemPromptSource() === undefined ? [] : [loader.getSystemPromptSource()!.path]),
  ]);
  const files = await Promise.all([...paths].sort().map(async (path) => ({
    path: await realpath(path), content: await readFile(path, "utf8"),
  })));
  const body = {
    schemaVersion: 1, turnId, files,
    extensionPaths: loader.getExtensions().extensions.map((extension) => extension.resolvedPath),
    skills: loader.getSkills().skills,
    prompts: loader.getPrompts().prompts,
    base: loader.getSystemPrompt() ?? null,
    append: loader.getAppendSystemPrompt(),
  };
  const revision = assemblyRevision(body);
  const saved = manager.getEntries().findLast((entry) => entry.type === "custom"
    && entry.customType === RESOURCE_SNAPSHOT && typeof entry.data === "object" && entry.data !== null
    && "turnId" in entry.data && entry.data.turnId === turnId);
  if (saved?.type === "custom") {
    const data: unknown = saved.data;
    if (typeof data !== "object" || data === null || !("revision" in data)) throw new Error("资源快照损坏");
    const { revision: previousRevision, ...previous } = data;
    if (assemblyRevision(previous) !== previousRevision || revision !== previousRevision) {
      throw new Error("本轮冻结的Skill、Prompt或Extension版本已不可用，不能使用新版本恢复旧任务");
    }
  } else if (input.persist) {
    manager.appendCustomEntry(RESOURCE_SNAPSHOT, { ...body, revision });
    manager.flush();
  }
  return new Map(files.map((file) => [file.path, file.content]));
}
