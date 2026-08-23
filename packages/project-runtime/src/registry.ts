import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ProjectResourceRootDescriptor,
  ProjectResourceRootRegistryPort,
} from "@chat/application";
import {
  projectObservationDataSchema,
  projectResourceAdapterKindSchema,
  type ProjectObservationData,
} from "@chat/contracts";
import { computeWorkspaceGrantSha256 } from "@chat/domain";

const execFileAsync = promisify(execFile);
const MAX_DOCUMENTS = 100;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".vercel",
  ".data",
]);
const PRIVATE_FILE = /(^|\/)(\.env($|\.)|.*(?:secret|credential|token|private[-_.]?key).*)/iu;

const rootConfigSchema = z
  .object({
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    displayName: z.string().min(1).max(160),
    canonicalPath: z.string().min(1).max(2_000),
    enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
  })
  .strict();

const rootsConfigSchema = z.array(rootConfigSchema).max(20);

interface InternalRoot {
  readonly descriptor: ProjectResourceRootDescriptor;
  readonly canonicalPath: string;
}

export class ProjectResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectResourceError";
  }
}

/** 服务端Root Registry是读取本机资源的唯一入口；浏览器永远只提交rootId。 */
export async function createProjectResourceRegistry(
  env: NodeJS.ProcessEnv,
): Promise<ProjectResourceRootRegistryPort> {
  const raw = env.CHAT_PROJECT_ROOTS_JSON;
  if (raw === undefined || raw.trim() === "") return new Registry([]);
  let config: z.infer<typeof rootsConfigSchema>;
  try {
    config = rootsConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new ProjectResourceError(
      "project_root_config_invalid",
      "CHAT_PROJECT_ROOTS_JSON不符合合同",
    );
  }
  const ids = new Set<string>();
  const roots: InternalRoot[] = [];
  for (const item of config) {
    if (ids.has(item.rootId)) {
      throw new ProjectResourceError(
        "project_root_config_invalid",
        `Project Root重复:${item.rootId}`,
      );
    }
    ids.add(item.rootId);
    const canonicalPath = await realpath(item.canonicalPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) {
      throw new ProjectResourceError("project_root_config_invalid", `${item.rootId}不是目录`);
    }
    roots.push({
      canonicalPath,
      descriptor: {
        rootId: item.rootId,
        displayName: item.displayName,
        enabledAdapters: item.enabledAdapters,
        grantSha256: computeWorkspaceGrantSha256(canonicalPath),
      },
    });
  }
  return new Registry(roots);
}

class Registry implements ProjectResourceRootRegistryPort {
  constructor(private readonly roots: readonly InternalRoot[]) {}

  list(): readonly ProjectResourceRootDescriptor[] {
    return this.roots.map((root) => structuredClone(root.descriptor));
  }

  async observe(rootId: string): Promise<{
    readonly descriptor: ProjectResourceRootDescriptor;
    readonly data: ProjectObservationData;
  }> {
    const root = this.roots.find((candidate) => candidate.descriptor.rootId === rootId);
    if (root === undefined) {
      throw new ProjectResourceError("project_root_not_allowed", "项目资源根未配置或不允许访问");
    }
    const enabled = new Set(root.descriptor.enabledAdapters);
    if (!enabled.has("local-git-workspace.v1")) {
      throw new ProjectResourceError("project_adapter_not_allowed", "项目资源未启用Git观察Adapter");
    }
    const git = await observeGit(root.canonicalPath);
    const documents = enabled.has("project-document-manifest.v1")
      ? await observeDocuments(root.canonicalPath)
      : [];
    const scripts = enabled.has("package-script-catalog.v1")
      ? await observeScripts(root.canonicalPath)
      : [];
    return {
      descriptor: structuredClone(root.descriptor),
      data: projectObservationDataSchema.parse({ git, documents, scripts }),
    };
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new ProjectResourceError("project_git_observe_failed", "无法观察配置的Git工作区");
  }
}

async function observeGit(root: string): Promise<ProjectObservationData["git"]> {
  const [head, branch, statusOutput, tracked, recent] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(root, ["status", "--porcelain=v1", "-z"]),
    git(root, ["ls-files", "-z"]),
    git(root, ["rev-list", "--count", "--max-count=20", "HEAD"]),
  ]);
  return {
    headSha: head.trim(),
    branch: branch.trim() === "HEAD" ? "(detached)" : branch.trim(),
    dirty: statusOutput.length > 0,
    trackedFileCount: tracked === "" ? 0 : tracked.split("\0").filter(Boolean).length,
    recentCommitCount: Number.parseInt(recent.trim(), 10),
  };
}

async function observeDocuments(root: string): Promise<ProjectObservationData["documents"]> {
  const candidates: string[] = [];
  await walk(root, root, candidates);
  candidates.sort();
  const output: ProjectObservationData["documents"] = [];
  let totalBytes = 0;
  for (const path of candidates.slice(0, MAX_DOCUMENTS)) {
    const metadata = await stat(path);
    if (totalBytes + metadata.size > MAX_DOCUMENT_BYTES) break;
    const bytes = await readFile(path);
    totalBytes += metadata.size;
    output.push({
      relativePath: relative(root, path),
      sha256: createHash("sha256").update(bytes).digest("hex") as never,
      sizeBytes: metadata.size,
    });
  }
  return output;
}

async function walk(root: string, directory: string, output: string[]): Promise<void> {
  if (output.length >= MAX_DOCUMENTS) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= MAX_DOCUMENTS) return;
    const path = resolve(directory, entry.name);
    const relativePath = relative(root, path);
    if (PRIVATE_FILE.test(relativePath)) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, path, output);
      continue;
    }
    if (!entry.isFile() || !/\.md$/iu.test(entry.name)) continue;
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) continue;
    const canonical = await realpath(path);
    assertInsideRoot(root, canonical);
    output.push(canonical);
  }
}

async function observeScripts(root: string): Promise<ProjectObservationData["scripts"]> {
  const manifestPath = resolve(root, "package.json");
  try {
    assertInsideRoot(root, await realpath(manifestPath));
    const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (typeof raw !== "object" || raw === null || !("scripts" in raw)) return [];
    const scripts = (raw as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];
    return Object.entries(scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 100)
      .map(([name, command]) => ({ name, command }));
  } catch (error) {
    if (isMissing(error)) return [];
    throw new ProjectResourceError(
      "project_script_manifest_invalid",
      `${basename(manifestPath)}无法安全读取`,
    );
  }
}

function assertInsideRoot(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new ProjectResourceError("project_path_escape", "资源路径越过允许根");
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
