import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  ProjectGitEvidenceVerification,
  ProjectResourceRootDescriptor,
  ProjectResourceRootRegistryPort,
} from "@chat/application";
import {
  type ContentLabContextBundle,
  type ContentLabContextSelection,
  type ContentLabObservation,
  projectObservationDataSchema,
  projectResourceAdapterKindSchema,
  type ProjectObservationData,
} from "@chat/contracts";
import {
  compileContentLabResourceContext,
  observeContentLabResource,
} from "./content-lab-resource.js";
import { ProjectResourceError } from "./errors.js";

export { ProjectResourceError } from "./errors.js";

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
const GIT_EVIDENCE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;
const GIT_EVIDENCE_COMMIT = /^[0-9a-f]{40}$/u;
const GIT_IDENTITY_PIN = /^[0-9a-f]{64}$/u;

const rootConfigSchema = z
  .object({
    rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    displayName: z.string().min(1).max(160),
    canonicalPath: z.string().min(1).max(2_000),
    enabledAdapters: z.array(projectResourceAdapterKindSchema).min(1).max(3),
    // 安全默认值必须是关闭：只有同时配置了外置、耐久的Git身份Pin，Root才可提交证据。
    gitEvidenceEnabled: z.boolean().default(false),
  })
  .strict();

const rootsConfigSchema = z.array(rootConfigSchema).max(20);
const gitIdentityPinsConfigSchema = z
  .record(z.string().regex(/^root_[A-Za-z0-9]+$/u), z.string().regex(GIT_IDENTITY_PIN))
  .refine((value) => Object.keys(value).length <= 20);

interface InternalRoot {
  readonly descriptor: ProjectResourceRootDescriptor;
  readonly canonicalPath: string;
  readonly gitIdentity?: GitRepositoryIdentity | undefined;
  readonly gitIdentityPin?: string | undefined;
}

interface GitRepositoryIdentity {
  readonly topLevel: string;
  readonly commonDirectory: string;
  readonly gitDirectory: string;
  readonly rootRelativePath: string;
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
  let gitIdentityPins: z.infer<typeof gitIdentityPinsConfigSchema> = {};
  const rawGitIdentityPins = env.CHAT_PROJECT_GIT_IDENTITY_PINS_JSON?.trim();
  if (rawGitIdentityPins !== undefined && rawGitIdentityPins !== "") {
    try {
      gitIdentityPins = gitIdentityPinsConfigSchema.parse(JSON.parse(rawGitIdentityPins));
    } catch {
      throw new ProjectResourceError(
        "project_root_config_invalid",
        "CHAT_PROJECT_GIT_IDENTITY_PINS_JSON不符合合同",
      );
    }
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
    const gitIdentity = item.enabledAdapters.includes("local-git-workspace.v1")
      ? await captureGitRepositoryIdentity(canonicalPath)
      : undefined;
    const configuredGitIdentityPin = gitIdentityPins[item.rootId];
    if (item.gitEvidenceEnabled) {
      if (gitIdentity === undefined || configuredGitIdentityPin === undefined) {
        throw new ProjectResourceError(
          "project_git_identity_not_pinned",
          `${item.rootId}启用Git证据前必须配置耐久Git身份Pin`,
        );
      }
      if (hashGitRepositoryIdentity(gitIdentity) !== configuredGitIdentityPin) {
        throw new ProjectResourceError(
          "project_git_identity_drift",
          `${item.rootId}的Git身份与外置耐久Pin不一致`,
        );
      }
    } else if (configuredGitIdentityPin !== undefined) {
      throw new ProjectResourceError(
        "project_root_config_invalid",
        `${item.rootId}关闭Git证据时不能保留身份Pin`,
      );
    }
    roots.push({
      canonicalPath,
      ...(gitIdentity === undefined ? {} : { gitIdentity }),
      ...(configuredGitIdentityPin === undefined
        ? {}
        : { gitIdentityPin: configuredGitIdentityPin }),
      descriptor: {
        rootId: item.rootId,
        displayName: item.displayName,
        enabledAdapters: item.enabledAdapters,
        gitEvidenceEnabled: item.gitEvidenceEnabled,
      },
    });
  }
  for (const rootId of Object.keys(gitIdentityPins)) {
    if (!ids.has(rootId)) {
      throw new ProjectResourceError(
        "project_root_config_invalid",
        `Git身份Pin引用了未知Project Root:${rootId}`,
      );
    }
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
    const root = this.requireGitRoot(rootId);
    const enabled = new Set(root.descriptor.enabledAdapters);
    const git = await observeGit(root.canonicalPath);
    const documents = enabled.has("project-document-manifest.v1")
      ? await observeDocuments(root.canonicalPath)
      : [];
    const scripts = enabled.has("package-script-catalog.v1")
      ? await observeScripts(root.canonicalPath)
      : [];
    const contentLab = enabled.has("content-lab-resource.v1")
      ? await observeContentLabResource(root.canonicalPath)
      : undefined;
    return {
      descriptor: structuredClone(root.descriptor),
      data: projectObservationDataSchema.parse({
        git,
        documents,
        scripts,
        ...(contentLab === undefined ? {} : { contentLab }),
      }),
    };
  }

  async compileContentLabContext(input: {
    readonly rootId: string;
    readonly observationSha256: string;
    readonly observation: ContentLabObservation;
    readonly selection: ContentLabContextSelection;
  }): Promise<ContentLabContextBundle> {
    const root = this.requireGitRoot(input.rootId);
    if (!root.descriptor.enabledAdapters.includes("content-lab-resource.v1")) {
      throw new ProjectResourceError(
        "project_adapter_not_allowed",
        "项目资源未启用Content Lab上下文Adapter",
      );
    }
    return compileContentLabResourceContext(root.canonicalPath, input);
  }

  async verifyGitEvidence(input: {
    readonly rootId: string;
    readonly branch: string;
    readonly commitSha: string;
  }): Promise<ProjectGitEvidenceVerification> {
    const root = this.requireGitRoot(input.rootId);
    if (!root.descriptor.gitEvidenceEnabled) {
      throw new ProjectResourceError(
        "project_git_evidence_disabled",
        "该Root在独立Git基线决策前禁止提交审核证据",
      );
    }
    await assertGitRepositoryIdentityStable(root);
    if (
      !GIT_EVIDENCE_BRANCH.test(input.branch) ||
      !input.branch.startsWith("codex/") ||
      !GIT_EVIDENCE_COMMIT.test(input.commitSha)
    ) {
      throw new ProjectResourceError(
        "project_git_evidence_invalid",
        "Git证据必须来自codex/受管branch且commit格式有效",
      );
    }

    const branchRef = `refs/heads/${input.branch}`;
    if (!(await gitPredicate(root.canonicalPath, ["show-ref", "--verify", "--quiet", branchRef]))) {
      throw new ProjectResourceError(
        "project_git_evidence_branch_not_found",
        "Git证据branch在绑定仓库中不存在",
      );
    }
    if (
      !(await gitPredicate(root.canonicalPath, ["cat-file", "-e", `${input.commitSha}^{commit}`]))
    ) {
      throw new ProjectResourceError(
        "project_git_evidence_commit_not_found",
        "Git证据commit在绑定仓库中不存在",
      );
    }
    const branchTip = (
      await gitEvidenceOutput(root.canonicalPath, ["rev-parse", `${branchRef}^{commit}`])
    ).trim();
    if (branchTip !== input.commitSha) {
      throw new ProjectResourceError(
        "project_git_evidence_commit_not_branch_tip",
        "Git证据commit必须是声明codex/ branch的当前tip",
      );
    }
    if (
      !(await gitPredicate(root.canonicalPath, [
        "merge-base",
        "--is-ancestor",
        input.commitSha,
        branchRef,
      ]))
    ) {
      throw new ProjectResourceError(
        "project_git_evidence_commit_unreachable",
        "Git证据commit不能从声明branch到达",
      );
    }

    // `git -C <binding root> ... -- .`把pathspec固定在绑定Root。嵌套Root即使共享父仓，
    // 父仓其他目录的提交也不会产生changed path，避免零tracked目录借用任意父仓SHA。
    const changedPaths = (
      await gitEvidenceOutput(root.canonicalPath, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-m",
        input.commitSha,
        "--",
        ".",
      ])
    )
      .split("\n")
      .filter(Boolean);
    if (changedPaths.length === 0) {
      throw new ProjectResourceError(
        "project_git_evidence_root_untouched",
        "Git证据commit没有修改绑定Root下的tracked path",
      );
    }
    return {
      rootId: input.rootId,
      branch: input.branch,
      commitSha: input.commitSha,
      changedTrackedPathCount: new Set(changedPaths).size,
    };
  }

  private requireGitRoot(rootId: string): InternalRoot {
    const root = this.roots.find((candidate) => candidate.descriptor.rootId === rootId);
    if (root === undefined) {
      throw new ProjectResourceError("project_root_not_allowed", "项目资源根未配置或不允许访问");
    }
    if (!root.descriptor.enabledAdapters.includes("local-git-workspace.v1")) {
      throw new ProjectResourceError("project_adapter_not_allowed", "项目资源未启用Git观察Adapter");
    }
    return root;
  }
}

async function captureGitRepositoryIdentity(root: string): Promise<GitRepositoryIdentity> {
  const [topLevelOutput, commonOutput, gitDirectoryOutput] = await Promise.all([
    git(root, ["rev-parse", "--show-toplevel"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]),
  ]);
  const [topLevel, commonDirectory, gitDirectory] = await Promise.all([
    realpath(topLevelOutput.trim()),
    realpath(commonOutput.trim()),
    realpath(gitDirectoryOutput.trim()),
  ]);
  const rootRelativePath = relative(topLevel, root);
  if (
    rootRelativePath === ".." ||
    rootRelativePath.startsWith(`..${sep}`) ||
    resolve(topLevel, rootRelativePath) !== root
  ) {
    throw new ProjectResourceError(
      "project_root_config_invalid",
      "Project Root必须位于启动时冻结的Git top-level内",
    );
  }
  return { topLevel, commonDirectory, gitDirectory, rootRelativePath };
}

function hashGitRepositoryIdentity(identity: GitRepositoryIdentity): string {
  return createHash("sha256")
    .update(
      [
        "chat-project-git-identity.v1",
        identity.topLevel,
        identity.commonDirectory,
        identity.gitDirectory,
        identity.rootRelativePath,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

/** 安装/迁移时生成外置Pin；Application运行时只比较，不会把当前仓库重新当成权威。 */
export async function computeProjectGitIdentityPin(rootPath: string): Promise<string> {
  const canonicalPath = await realpath(rootPath);
  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new ProjectResourceError("project_root_config_invalid", "Git身份Pin目标不是目录");
  }
  return hashGitRepositoryIdentity(await captureGitRepositoryIdentity(canonicalPath));
}

async function assertGitRepositoryIdentityStable(root: InternalRoot): Promise<void> {
  const expected = root.gitIdentity;
  const expectedPin = root.gitIdentityPin;
  if (expected === undefined || expectedPin === undefined) {
    throw new ProjectResourceError(
      "project_git_identity_not_pinned",
      "Project Root缺少外置耐久Git身份Pin",
    );
  }
  let current: GitRepositoryIdentity;
  try {
    current = await captureGitRepositoryIdentity(root.canonicalPath);
  } catch {
    throw new ProjectResourceError(
      "project_git_identity_drift",
      "Project Root的Git身份在启动后不可验证",
    );
  }
  if (
    current.topLevel !== expected.topLevel ||
    current.commonDirectory !== expected.commonDirectory ||
    current.gitDirectory !== expected.gitDirectory ||
    current.rootRelativePath !== expected.rootRelativePath ||
    hashGitRepositoryIdentity(current) !== expectedPin
  ) {
    throw new ProjectResourceError(
      "project_git_identity_drift",
      "Project Root的Git top-level/common-dir/git-dir发生漂移",
    );
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

async function gitPredicate(root: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
    ) {
      return false;
    }
    throw new ProjectResourceError(
      "project_git_evidence_check_failed",
      "无法验证配置Root的Git证据",
    );
  }
}

async function gitEvidenceOutput(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new ProjectResourceError(
      "project_git_evidence_check_failed",
      "无法验证配置Root的Git证据",
    );
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
