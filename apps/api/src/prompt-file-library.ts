import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  PromptFileLibraryPort,
  PromptFileRevisionInput,
  PromptFileRevisionProjection,
} from "@chat/application";
import { promptFragmentContentSchema, promptWorkspaceRootIdSchema } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { z } from "zod";

const rootsSchema = z
  .array(
    z
      .object({
        rootId: promptWorkspaceRootIdSchema,
        displayName: z.string().min(1).max(160),
        canonicalPath: z.string().min(1).max(2_000),
        enabledAdapters: z.array(z.string()),
      })
      .strict(),
  )
  .max(20);

const metadataSchema = z
  .object({
    schemaVersion: z.literal("chat-prompt-markdown.v1"),
    promptFragmentId: z.string(),
    promptFragmentRevisionId: z.string(),
    revision: z.number().int().positive(),
    regionKey: z.string(),
    title: z.string(),
    description: z.string().optional(),
    contentKind: z.enum(["markdown", "key_value"]),
    key: z.string().optional(),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.iso.datetime(),
  })
  .strict();

const START = "<!-- chat-prompt-metadata\n";
const END = "\n-->\n\n";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contentSha256(content: PromptFileRevisionInput["content"]): string {
  return hashCanonical("prompt-file-content.v1", content);
}

function render(input: PromptFileRevisionInput): string {
  const metadata = metadataSchema.parse({
    schemaVersion: "chat-prompt-markdown.v1",
    promptFragmentId: input.promptFragmentId,
    promptFragmentRevisionId: input.promptFragmentRevisionId,
    revision: input.revision,
    regionKey: input.regionKey,
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    contentKind: input.content.kind,
    ...(input.content.kind === "key_value" ? { key: input.content.key } : {}),
    contentSha256: input.contentSha256,
    createdAt: input.createdAt,
  });
  const body =
    input.content.kind === "markdown" ? input.content.bodyMarkdown : input.content.valueMarkdown;
  return `${START}${JSON.stringify(metadata, null, 2)}${END}${body.trim()}\n`;
}

function parse(raw: string): {
  readonly metadata: z.infer<typeof metadataSchema>;
  readonly content: z.infer<typeof promptFragmentContentSchema>;
} {
  if (!raw.startsWith(START)) throw new Error("Prompt Markdown缺少受管元数据");
  const end = raw.indexOf(END, START.length);
  if (end < 0) throw new Error("Prompt Markdown元数据未闭合");
  const metadata = metadataSchema.parse(JSON.parse(raw.slice(START.length, end)));
  const body = raw.slice(end + END.length).trim();
  const content = promptFragmentContentSchema.parse(
    metadata.contentKind === "markdown"
      ? { kind: "markdown", bodyMarkdown: body }
      : { kind: "key_value", key: metadata.key, valueMarkdown: body },
  );
  if (contentSha256(content) !== metadata.contentSha256) {
    throw new Error("Prompt Markdown正文与元数据Hash不一致");
  }
  return { metadata, content };
}

interface ResolvedFile {
  readonly absolutePath: string;
  readonly sourceRelativePath: string;
}

export async function createPromptFileLibrary(options: {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<PromptFileLibraryPort> {
  const repoRoot = await realpath(options.repoRoot);
  const configured = options.env.CHAT_PROJECT_ROOTS_JSON?.trim();
  const roots = new Map<string, string>();
  for (const root of configured ? rootsSchema.parse(JSON.parse(configured)) : []) {
    roots.set(root.rootId, await realpath(root.canonicalPath));
  }
  const globalRoot = resolve(repoRoot, ".data", "prompts", "global");

  const resolvedFile = async (input: {
    readonly scope: PromptFileRevisionInput["scope"];
    readonly regionKey: string;
    readonly promptFragmentId: string;
    readonly promptFragmentRevisionId: string;
  }): Promise<ResolvedFile> => {
    const fileName = `${input.promptFragmentRevisionId}.md`;
    if (input.scope.kind === "global") {
      const absolutePath = join(globalRoot, input.regionKey, input.promptFragmentId, fileName);
      return {
        absolutePath,
        sourceRelativePath: relative(repoRoot, absolutePath).replaceAll(sep, "/"),
      };
    }
    const workspaceRoot = roots.get(input.scope.rootId);
    if (workspaceRoot === undefined) throw new Error("Prompt Workspace未配置或不允许写入");
    const relativePath = join(
      ".chat",
      "prompts",
      input.regionKey,
      input.promptFragmentId,
      fileName,
    );
    return {
      absolutePath: join(workspaceRoot, relativePath),
      sourceRelativePath: `${input.scope.rootId}/${relativePath.replaceAll(sep, "/")}`,
    };
  };

  const readProjection = async (
    file: ResolvedFile,
    expected: {
      readonly promptFragmentId: string;
      readonly promptFragmentRevisionId: string;
      readonly expectedContentSha256: string;
    },
  ): Promise<PromptFileRevisionProjection> => {
    const raw = await readFile(file.absolutePath, "utf8");
    const parsed = parse(raw);
    if (
      parsed.metadata.promptFragmentId !== expected.promptFragmentId ||
      parsed.metadata.promptFragmentRevisionId !== expected.promptFragmentRevisionId ||
      parsed.metadata.contentSha256 !== expected.expectedContentSha256
    ) {
      throw new Error("Prompt Markdown身份或正文Hash已漂移");
    }
    return {
      sourceRelativePath: file.sourceRelativePath,
      sourceSha256: sha256(raw),
      content: parsed.content,
    };
  };

  return {
    async publishRevision(input) {
      if (contentSha256(input.content) !== input.contentSha256) {
        throw new Error("Prompt Revision正文Hash与发布输入不一致");
      }
      const file = await resolvedFile(input);
      const raw = render(input);
      await mkdir(dirname(file.absolutePath), { recursive: true });
      try {
        await writeFile(file.absolutePath, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readFile(file.absolutePath, "utf8");
        if (existing !== raw) throw new Error("Prompt Revision文件已存在但正文不同");
      }
      return readProjection(file, {
        promptFragmentId: input.promptFragmentId,
        promptFragmentRevisionId: input.promptFragmentRevisionId,
        expectedContentSha256: input.contentSha256,
      });
    },
    async readRevision(input) {
      const file = await resolvedFile(input);
      return readProjection(file, input);
    },
  };
}
