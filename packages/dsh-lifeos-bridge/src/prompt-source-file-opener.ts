import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const sourceRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((value) => !value.split("/").includes(".."));

const promptCatalogSourcesSchema = z
  .object({
    regionSource: z.object({ relativePath: sourceRelativePathSchema }).passthrough(),
    fragments: z
      .array(z.object({ relativePath: sourceRelativePathSchema }).passthrough())
      .max(10_000),
  })
  .passthrough();

const promptWorkspaceRootsSchema = z
  .array(
    z
      .object({
        rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
        displayName: z.string().min(1).max(160),
        canonicalPath: z.string().min(1).max(2_000),
        enabledAdapters: z.array(z.string()),
      })
      .strict(),
  )
  .max(20);

export const promptSourceOpenerIdSchema = z.enum([
  "vscode",
  "trae-cn",
  "cursor",
  "sublime-text",
  "textedit",
  "system-default",
]);

export const promptSourceOpenRequestSchema = z
  .object({
    relativePath: sourceRelativePathSchema,
    openerId: promptSourceOpenerIdSchema,
  })
  .strict();

export interface PromptSourceOpenerDto {
  readonly id: z.infer<typeof promptSourceOpenerIdSchema>;
  readonly label: string;
}

interface PromptSourceOpenerDefinition extends PromptSourceOpenerDto {
  readonly applicationPath?: string;
  readonly applicationName?: string;
}

const MAC_OPENERS: readonly PromptSourceOpenerDefinition[] = [
  {
    id: "vscode",
    label: "Visual Studio Code",
    applicationPath: "/Applications/Visual Studio Code.app",
    applicationName: "Visual Studio Code",
  },
  {
    id: "trae-cn",
    label: "TRAE CN",
    applicationPath: "/Applications/Trae CN.app",
    applicationName: "Trae CN",
  },
  {
    id: "cursor",
    label: "Cursor",
    applicationPath: "/Applications/Cursor.app",
    applicationName: "Cursor",
  },
  {
    id: "sublime-text",
    label: "Sublime Text",
    applicationPath: "/Applications/Sublime Text.app",
    applicationName: "Sublime Text",
  },
  {
    id: "textedit",
    label: "文本编辑",
    applicationPath: "/System/Applications/TextEdit.app",
    applicationName: "TextEdit",
  },
  { id: "system-default", label: "系统默认应用" },
] as const;

export class PromptSourceFileOpenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PromptSourceFileOpenerOptions {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly applicationExists?: (path: string) => Promise<boolean>;
  readonly launch?: (opener: PromptSourceOpenerDefinition, absolutePath: string) => Promise<void>;
}

async function applicationExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function launchOnMac(
  opener: PromptSourceOpenerDefinition,
  absolutePath: string,
): Promise<void> {
  const args =
    opener.applicationName === undefined
      ? [absolutePath]
      : ["-a", opener.applicationName, absolutePath];
  await execFileAsync("/usr/bin/open", args, { timeout: 10_000, maxBuffer: 64 * 1024 });
}

/**
 * 本机编辑器只是DSH Host能力：浏览器只提交Catalog中的相对路径和白名单应用ID，
 * Host再次按真实路径、symlink和文件类型校验后才调用macOS open。公网部署不会装配本服务。
 */
export class PromptSourceFileOpener {
  private constructor(
    private readonly repoRoot: string,
    private readonly allowedRelativePaths: ReadonlySet<string>,
    private readonly workspaceRoots: ReadonlyMap<string, string>,
    private readonly available: readonly PromptSourceOpenerDefinition[],
    private readonly launch: (
      opener: PromptSourceOpenerDefinition,
      absolutePath: string,
    ) => Promise<void>,
  ) {}

  static async create(options: PromptSourceFileOpenerOptions): Promise<PromptSourceFileOpener> {
    if (!isAbsolute(options.repoRoot)) {
      throw new Error("Prompt source opener requires an absolute repo root");
    }
    const repoRoot = await realpath(options.repoRoot);
    const manifestPath = resolve(repoRoot, "prompts/catalog.json");
    const parsed = promptCatalogSourcesSchema.safeParse(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    );
    if (!parsed.success) throw new Error("Prompt Catalog source manifest is invalid");
    const allowedRelativePaths = new Set([
      parsed.data.regionSource.relativePath,
      ...parsed.data.fragments.map((fragment) => fragment.relativePath),
    ]);
    const workspaceRoots = new Map<string, string>();
    const rootsRaw = options.env?.CHAT_PROJECT_ROOTS_JSON?.trim();
    for (const root of rootsRaw ? promptWorkspaceRootsSchema.parse(JSON.parse(rootsRaw)) : []) {
      workspaceRoots.set(root.rootId, await realpath(root.canonicalPath));
    }
    const platform = options.platform ?? process.platform;
    const exists = options.applicationExists ?? applicationExists;
    const available: PromptSourceOpenerDefinition[] = [];
    if (platform === "darwin") {
      for (const opener of MAC_OPENERS) {
        if (opener.applicationPath === undefined || (await exists(opener.applicationPath))) {
          available.push(opener);
        }
      }
    }
    return new PromptSourceFileOpener(
      repoRoot,
      allowedRelativePaths,
      workspaceRoots,
      available,
      options.launch ?? launchOnMac,
    );
  }

  openers(): { schemaVersion: "chat-prompt-source-openers.v1"; items: PromptSourceOpenerDto[] } {
    return {
      schemaVersion: "chat-prompt-source-openers.v1",
      items: this.available.map(({ id, label }) => ({ id, label })),
    };
  }

  async open(request: z.infer<typeof promptSourceOpenRequestSchema>): Promise<{
    schemaVersion: "chat-prompt-source-open.v1";
    status: "launched";
    relativePath: string;
    openerId: z.infer<typeof promptSourceOpenerIdSchema>;
  }> {
    const resolveAllowedTarget = (): { root: string; candidate: string } | undefined => {
      if (this.allowedRelativePaths.has(request.relativePath)) {
        return { root: this.repoRoot, candidate: resolve(this.repoRoot, request.relativePath) };
      }
      if (request.relativePath.startsWith(".data/prompts/global/")) {
        const managedRoot = resolve(this.repoRoot, ".data/prompts/global");
        return { root: managedRoot, candidate: resolve(this.repoRoot, request.relativePath) };
      }
      const slash = request.relativePath.indexOf("/");
      if (slash <= 0) return undefined;
      const rootId = request.relativePath.slice(0, slash);
      const child = request.relativePath.slice(slash + 1);
      const workspaceRoot = this.workspaceRoots.get(rootId);
      if (
        workspaceRoot === undefined ||
        (child !== "AGENTS.md" && !child.startsWith(".chat/prompts/")) ||
        !child.endsWith(".md")
      ) {
        return undefined;
      }
      return { root: workspaceRoot, candidate: resolve(workspaceRoot, child) };
    };
    const target = resolveAllowedTarget();
    if (target === undefined) {
      throw new PromptSourceFileOpenError(
        404,
        "lifeos_prompt_source_not_found",
        "该文件不是Prompt Catalog登记的来源文件",
      );
    }
    const opener = this.available.find((item) => item.id === request.openerId);
    if (opener === undefined) {
      throw new PromptSourceFileOpenError(
        409,
        "lifeos_prompt_opener_unavailable",
        "所选本机应用当前不可用",
      );
    }
    const absolutePath = await realpath(target.candidate).catch(() => {
      throw new PromptSourceFileOpenError(
        404,
        "lifeos_prompt_source_not_found",
        "Prompt来源文件不存在",
      );
    });
    const relativeToRoot = relative(target.root, absolutePath);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
      throw new PromptSourceFileOpenError(
        403,
        "lifeos_prompt_source_forbidden",
        "Prompt来源文件越过Chat仓库边界",
      );
    }
    if (!(await stat(absolutePath)).isFile()) {
      throw new PromptSourceFileOpenError(
        404,
        "lifeos_prompt_source_not_found",
        "Prompt来源不是普通文件",
      );
    }
    try {
      await this.launch(opener, absolutePath);
    } catch {
      throw new PromptSourceFileOpenError(
        502,
        "lifeos_prompt_open_failed",
        "本机应用未能打开Prompt来源文件",
      );
    }
    return {
      schemaVersion: "chat-prompt-source-open.v1",
      status: "launched",
      relativePath: request.relativePath,
      openerId: request.openerId,
    };
  }
}
