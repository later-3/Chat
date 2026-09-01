import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { ensureChatHome, resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { BUILT_IN_PERSONAL_PROMPT_RESOURCES } from "./builtins.js";
import {
  PROMPT_RESOURCE_SCHEMA_VERSION,
  parsePromptResourceDocument,
  parsePromptResourceDraft,
  parsePromptResourceDraftInput,
  parsePromptResourceDraftPatch,
  parsePromptResourceId,
  parsePromptResourceTarget,
  promptResourceTargetKey,
  type AddressedPromptResourceDraft,
  type AddressedPromptResourceRevision,
  type PromptResourceDocument,
  type PromptResourceDraft,
  type PromptResourceDraftInput,
  type PromptResourceDraftPatch,
  type PromptResourceKind,
  type PromptResourceRevision,
  type PromptResourceStatus,
  type PromptResourceTarget,
} from "./types.js";

export interface ListPromptResourcesOptions {
  readonly query?: string;
  readonly kind?: PromptResourceKind;
  readonly status?: PromptResourceStatus | "all";
  readonly tags?: readonly string[];
}

interface StorePaths {
  readonly root: string;
  readonly resources: string;
  readonly drafts: string;
  readonly lock: string;
}

export class PromptResourceNotFoundError extends Error {}
export class PromptResourceConflictError extends Error {}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${path}不是有效JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

function currentRevision(document: PromptResourceDocument): PromptResourceRevision {
  return document.revisions[document.revisions.length - 1] as PromptResourceRevision;
}

function includesQuery(resource: PromptResourceRevision, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return true;
  return [
    resource.title,
    resource.purpose,
    resource.content,
    ...resource.tags,
    ...resource.sources.flatMap((source) => [
      source.context,
      source.projectId ?? "",
      source.sessionId ?? "",
      source.workflowInvocationId ?? "",
    ]),
  ].some((value) => value.toLocaleLowerCase().includes(normalized));
}

async function acquireFileLock(paths: StorePaths): Promise<() => Promise<void>> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      return async () => rm(paths.lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    try {
      const lockInfo = await stat(paths.lock);
      if (Date.now() - lockInfo.mtimeMs > 120_000) {
        const stalePath = `${paths.lock}.stale.${randomUUID()}`;
        try {
          await rename(paths.lock, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    if (Date.now() >= deadline) throw new PromptResourceConflictError("Prompt资源库正在被其他进程修改，请重试");
    await delay(25);
  }
}

function sameCommittedDraft(resource: PromptResourceRevision, draft: PromptResourceDraft): boolean {
  return resource.id === (draft.baseResourceId ?? draft.id)
    && resource.revision === (draft.baseRevision ?? 0) + 1
    && resource.kind === draft.kind
    && resource.title === draft.title
    && resource.purpose === draft.purpose
    && resource.content === draft.content
    && resource.status === draft.status
    && JSON.stringify(resource.tags) === JSON.stringify(draft.tags)
    && JSON.stringify(resource.sources) === JSON.stringify(draft.sources)
    && JSON.stringify(resource.author) === JSON.stringify(draft.author);
}

export class PromptResourceStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly seededDocumentSets = new Set<string>();
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = resolve(storageRoot);
  }

  private async paths(): Promise<StorePaths> {
    const paths = {
      root: this.storageRoot,
      resources: join(this.storageRoot, "resources"),
      drafts: join(this.storageRoot, "drafts"),
      lock: join(this.storageRoot, ".write-lock"),
    };
    await Promise.all([
      mkdir(paths.resources, { recursive: true, mode: 0o700 }),
      mkdir(paths.drafts, { recursive: true, mode: 0o700 }),
    ]);
    return paths;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.catch(() => undefined).then(async () => {
      const paths = await this.paths();
      const release = await acquireFileLock(paths);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readDocument(id: string): Promise<PromptResourceDocument | undefined> {
    const paths = await this.paths();
    try {
      return parsePromptResourceDocument(await readJson(join(paths.resources, `${id}.json`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Seeds and safely upgrades product-owned resources without overwriting user-managed revisions. */
  async ensureDocuments(documents: readonly PromptResourceDocument[]): Promise<void> {
    const parsed = documents.map(parsePromptResourceDocument);
    const key = parsed.map((document) => (
      `${document.id}:${document.revisions[document.revisions.length - 1]?.revision ?? 0}`
    )).join("|");
    if (this.seededDocumentSets.has(key)) return;
    await this.runExclusive(async () => {
      const paths = await this.paths();
      for (const document of parsed) {
        const existing = await this.readDocument(document.id);
        if (existing === undefined) {
          await writeJsonAtomically(join(paths.resources, `${document.id}.json`), document);
          continue;
        }
        const stillProductOwned = existing.revisions.every((revision, index) => (
          JSON.stringify(revision) === JSON.stringify(document.revisions[index])
        ));
        if (!stillProductOwned || existing.revisions.length >= document.revisions.length) continue;
        await writeJsonAtomically(join(paths.resources, `${document.id}.json`), {
          ...existing,
          revisions: document.revisions,
        });
      }
    });
    this.seededDocumentSets.add(key);
  }

  async get(id: string): Promise<PromptResourceRevision | undefined> {
    const document = await this.readDocument(parsePromptResourceId(id));
    return document === undefined ? undefined : currentRevision(document);
  }

  async getRevision(id: string, revision: number): Promise<PromptResourceRevision | undefined> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision必须是正整数");
    const document = await this.readDocument(parsePromptResourceId(id));
    return document?.revisions[revision - 1];
  }

  async list(options: ListPromptResourcesOptions = {}): Promise<PromptResourceRevision[]> {
    const paths = await this.paths();
    const files = (await readdir(paths.resources)).filter((file) => file.endsWith(".json")).sort();
    const resources = await Promise.all(files.map(async (file) => (
      currentRevision(parsePromptResourceDocument(await readJson(join(paths.resources, file))))
    )));
    const requestedTags = new Set(options.tags ?? []);
    const requestedStatus = options.status ?? "active";
    return resources.filter((resource) => (
      (options.kind === undefined || resource.kind === options.kind)
      && (requestedStatus === "all" || resource.status === requestedStatus)
      && [...requestedTags].every((tag) => resource.tags.includes(tag))
      && (options.query === undefined || includesQuery(resource, options.query))
    )).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getDraft(id: string): Promise<PromptResourceDraft | undefined> {
    const paths = await this.paths();
    try {
      return parsePromptResourceDraft(await readJson(join(paths.drafts, `${parsePromptResourceId(id)}.json`)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listDrafts(): Promise<PromptResourceDraft[]> {
    const paths = await this.paths();
    const files = (await readdir(paths.drafts)).filter((file) => file.endsWith(".json")).sort();
    const drafts = await Promise.all(
      files.map(async (file) => parsePromptResourceDraft(await readJson(join(paths.drafts, file)))),
    );
    return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createDraft(input: PromptResourceDraftInput): Promise<PromptResourceDraft> {
    const parsed = parsePromptResourceDraftInput(input);
    return this.runExclusive(async () => {
      const paths = await this.paths();
      const base = parsed.baseResourceId === undefined ? undefined : await this.readDocument(parsed.baseResourceId);
      if (parsed.baseResourceId !== undefined && base === undefined) {
        throw new PromptResourceNotFoundError(`找不到Prompt资源: ${parsed.baseResourceId}`);
      }
      const now = new Date().toISOString();
      const draft: PromptResourceDraft = {
        schemaVersion: PROMPT_RESOURCE_SCHEMA_VERSION,
        id: randomUUID(),
        ...(base === undefined
          ? {}
          : { baseResourceId: base.id, baseRevision: currentRevision(base).revision }),
        kind: parsed.kind,
        title: parsed.title,
        purpose: parsed.purpose,
        content: parsed.content,
        tags: parsed.tags ?? [],
        status: parsed.status ?? "active",
        sources: parsed.sources ?? [],
        author: parsed.author,
        createdAt: now,
        updatedAt: now,
      };
      await writeJsonAtomically(join(paths.drafts, `${draft.id}.json`), draft);
      return draft;
    });
  }

  async updateDraft(id: string, patch: PromptResourceDraftPatch): Promise<PromptResourceDraft> {
    const parsedId = parsePromptResourceId(id);
    const parsedPatch = parsePromptResourceDraftPatch(patch);
    return this.runExclusive(async () => {
      const paths = await this.paths();
      const existing = await this.getDraft(parsedId);
      if (existing === undefined) throw new PromptResourceNotFoundError(`找不到Prompt资源草稿: ${parsedId}`);
      if (existing.updatedAt !== parsedPatch.expectedUpdatedAt) {
        throw new PromptResourceConflictError(`Prompt资源草稿 ${parsedId} 已被修改，请重新读取后再更新`);
      }
      const { expectedUpdatedAt: _expectedUpdatedAt, ...changes } = parsedPatch;
      const nextUpdatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
      const updated = parsePromptResourceDraft({
        ...existing,
        ...changes,
        updatedAt: nextUpdatedAt,
      });
      await writeJsonAtomically(join(paths.drafts, `${parsedId}.json`), updated);
      return updated;
    });
  }

  async commitDraft(id: string): Promise<PromptResourceRevision> {
    const parsedId = parsePromptResourceId(id);
    return this.runExclusive(async () => {
      const paths = await this.paths();
      const draft = await this.getDraft(parsedId);
      if (draft === undefined) throw new PromptResourceNotFoundError(`找不到Prompt资源草稿: ${parsedId}`);
      const resourceId = draft.baseResourceId ?? draft.id;
      const existing = await this.readDocument(resourceId);
      if (draft.baseResourceId !== undefined && existing === undefined) {
        throw new PromptResourceNotFoundError(`找不到Prompt资源: ${draft.baseResourceId}`);
      }
      if (draft.baseResourceId === undefined && existing !== undefined) {
        const committed = currentRevision(existing);
        if (!sameCommittedDraft(committed, draft)) {
          throw new PromptResourceConflictError(`Prompt资源ID冲突: ${resourceId}`);
        }
        await unlink(join(paths.drafts, `${parsedId}.json`));
        return committed;
      }
      if (draft.baseResourceId !== undefined && existing !== undefined) {
        const committed = currentRevision(existing);
        if (sameCommittedDraft(committed, draft)) {
          await unlink(join(paths.drafts, `${parsedId}.json`));
          return committed;
        }
      }
      if (existing !== undefined && currentRevision(existing).revision !== draft.baseRevision) {
        throw new PromptResourceConflictError(`Prompt资源 ${existing.id} 已被修改，请基于最新版本重新创建草稿`);
      }
      const revision: PromptResourceRevision = {
        schemaVersion: PROMPT_RESOURCE_SCHEMA_VERSION,
        id: resourceId,
        revision: (existing?.revisions.length ?? 0) + 1,
        kind: draft.kind,
        title: draft.title,
        purpose: draft.purpose,
        content: draft.content,
        tags: draft.tags,
        status: draft.status,
        sources: draft.sources,
        author: draft.author,
        createdAt: new Date().toISOString(),
      };
      const document: PromptResourceDocument = {
        schemaVersion: PROMPT_RESOURCE_SCHEMA_VERSION,
        id: resourceId,
        revisions: [...(existing?.revisions ?? []), revision],
      };
      await writeJsonAtomically(join(paths.resources, `${resourceId}.json`), document);
      await unlink(join(paths.drafts, `${parsedId}.json`));
      return revision;
    });
  }

  async history(id: string): Promise<readonly PromptResourceRevision[]> {
    const parsedId = parsePromptResourceId(id);
    const document = await this.readDocument(parsedId);
    if (document === undefined) throw new PromptResourceNotFoundError(`找不到Prompt资源: ${parsedId}`);
    return document.revisions;
  }
}

const stores = new Map<string, PromptResourceStore>();

function storeForPath(path: string): PromptResourceStore {
  const root = resolve(path);
  const existing = stores.get(root);
  if (existing !== undefined) return existing;
  const store = new PromptResourceStore(root);
  stores.set(root, store);
  return store;
}

export async function getPromptResourceStore(
  target: PromptResourceTarget,
  chatHome = resolveChatHome(),
): Promise<PromptResourceStore> {
  const parsedTarget = parsePromptResourceTarget(target);
  if (parsedTarget.type === "personal") {
    const store = storeForPath((await ensureChatHome(chatHome)).personalPromptResourceDir);
    await store.ensureDocuments(BUILT_IN_PERSONAL_PROMPT_RESOURCES);
    return store;
  }
  return storeForPath((await resolveProjectContext(parsedTarget.projectId, chatHome)).promptResourceDir);
}

export function addressPromptResourceRevision(
  target: PromptResourceTarget,
  resource: PromptResourceRevision,
): AddressedPromptResourceRevision {
  return { ...resource, target };
}

export function addressPromptResourceDraft(
  target: PromptResourceTarget,
  draft: PromptResourceDraft,
): AddressedPromptResourceDraft {
  return { ...draft, target };
}

export async function listPromptResources(
  targets: readonly PromptResourceTarget[],
  options: ListPromptResourcesOptions = {},
  chatHome = resolveChatHome(),
): Promise<AddressedPromptResourceRevision[]> {
  const unique = new Map(targets.map((target) => [promptResourceTargetKey(target), parsePromptResourceTarget(target)]));
  const resources = await Promise.all([...unique.values()].map(async (target) => (
    (await (await getPromptResourceStore(target, chatHome)).list(options))
      .map((resource) => addressPromptResourceRevision(target, resource))
  )));
  return resources.flat().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listPromptResourceDrafts(
  targets: readonly PromptResourceTarget[],
  chatHome = resolveChatHome(),
): Promise<AddressedPromptResourceDraft[]> {
  const unique = new Map(targets.map((target) => [promptResourceTargetKey(target), parsePromptResourceTarget(target)]));
  const drafts = await Promise.all([...unique.values()].map(async (target) => (
    (await (await getPromptResourceStore(target, chatHome)).listDrafts())
      .map((draft) => addressPromptResourceDraft(target, draft))
  )));
  return drafts.flat().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
