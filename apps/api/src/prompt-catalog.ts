import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_STUDIO_API_SCHEMA_VERSION,
  agentKeySchema,
  promptFragmentIdSchema,
  promptFragmentRevisionIdSchema,
  promptRegionDefinitionDtoSchema,
} from "@chat/contracts";
import type {
  BuiltinPromptFragmentRevision,
  PromptCatalogPort,
  PromptCatalogSnapshot,
} from "@chat/application";
import { hashCanonical } from "@chat/domain";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/u).includes(".."));

const promptWorkspaceConfigSchema = z
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

const manifestSchema = z
  .object({
    schemaVersion: z.literal("chat-prompt-catalog.v1"),
    catalogRevision: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
    regionSource: z
      .object({ relativePath: relativePathSchema, sourceSha256: sha256Schema })
      .strict(),
    sharedSelectionProfile: z
      .object({
        profileId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,79}$/u),
        defaultRevisionIds: z
          .array(promptFragmentRevisionIdSchema)
          .max(100)
          .refine((items) => new Set(items).size === items.length, "默认Prompt Revision不能重复"),
      })
      .strict(),
    agents: z.array(
      z
        .object({
          agentKey: agentKeySchema,
          title: z.string().min(1).max(160),
          description: z.string().min(1).max(1_000),
          profileVersion: z.string().min(1).max(80),
          supportedNodeTypes: z.array(z.string().min(1).max(80)).min(1).max(16),
          defaultPrompt: z.discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("catalog_fragment"),
                promptFragmentRevisionId: promptFragmentRevisionIdSchema,
              })
              .strict(),
            z
              .object({
                kind: z.literal("pi_coding_agent"),
                defaultVariantKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/u),
                promptFragmentRevisionId: promptFragmentRevisionIdSchema.optional(),
              })
              .strict(),
          ]),
          tools: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(80),
                  description: z.string().min(1).max(500),
                })
                .strict(),
            )
            .max(32),
        })
        .strict(),
    ),
    regions: z.array(
      z
        .object({
          regionKey: z.string(),
          title: z.string(),
          description: z.string(),
          category: z.enum(["identity", "context", "runtime"]),
          plannedPlacement: z.enum(["system", "messages", "tools", "request_options"]),
          contentKind: z.enum(["markdown", "key_value", "runtime"]),
          cardinality: z.enum(["single", "multiple", "automatic"]),
          userManageable: z.boolean(),
          availability: z.enum(["active", "planned"]),
          stableOrder: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    fragments: z.array(
      z
        .object({
          promptFragmentId: promptFragmentIdSchema,
          promptFragmentRevisionId: promptFragmentRevisionIdSchema,
          revision: z.number().int().positive(),
          regionKey: z.string(),
          title: z.string(),
          description: z.string().optional(),
          relativePath: relativePathSchema,
          sourceSha256: sha256Schema,
        })
        .strict(),
    ),
  })
  .strict();

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

async function readCatalogFile(repoRoot: string, relativePath: string): Promise<string> {
  const root = await realpath(repoRoot);
  const candidate = resolve(root, relativePath);
  const resolved = await realpath(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Prompt Catalog路径越界:${relativePath}`);
  }
  return readFile(resolved, "utf8");
}

/**
 * Git Prompt Catalog Adapter。启动时一次性加载并校验全部文件，任何路径越界、缺失、
 * 重复身份或Hash漂移都失败关闭；运行期只返回不可变内存投影。
 */
export async function createFilePromptCatalog(
  repoRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PromptCatalogPort> {
  const inferredRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const root = repoRoot === undefined ? inferredRoot : resolve(repoRoot);
  const manifestRaw = await readCatalogFile(root, "prompts/catalog.json");
  const manifest = manifestSchema.parse(JSON.parse(manifestRaw));
  const regionSource = await readCatalogFile(root, manifest.regionSource.relativePath);
  if (sha256(regionSource) !== manifest.regionSource.sourceSha256) {
    throw new Error("Prompt Region Catalog正文Hash漂移");
  }

  const regionKeys = new Set<string>();
  const stableOrders = new Set<number>();
  const regions = manifest.regions
    .map((region) => {
      if (regionKeys.has(region.regionKey) || stableOrders.has(region.stableOrder)) {
        throw new Error(`Prompt Region重复:${region.regionKey}`);
      }
      regionKeys.add(region.regionKey);
      stableOrders.add(region.stableOrder);
      const sha = hashCanonical("prompt-region-definition.v1", {
        ...region,
        catalogRevision: manifest.catalogRevision,
        sourceRelativePath: manifest.regionSource.relativePath,
        sourceSha256: manifest.regionSource.sourceSha256,
      });
      return promptRegionDefinitionDtoSchema.parse({
        schemaVersion: PROMPT_STUDIO_API_SCHEMA_VERSION,
        ...region,
        catalogRevision: manifest.catalogRevision,
        sha256: sha,
        sourceRelativePath: manifest.regionSource.relativePath,
      });
    })
    .sort((left, right) => left.stableOrder - right.stableOrder);

  const fragmentIds = new Set<string>();
  const revisionIds = new Set<string>();
  const builtinFragments: BuiltinPromptFragmentRevision[] = [];
  for (const fragment of manifest.fragments) {
    if (
      fragmentIds.has(fragment.promptFragmentId) ||
      revisionIds.has(fragment.promptFragmentRevisionId)
    ) {
      throw new Error(`Builtin Prompt身份重复:${fragment.promptFragmentId}`);
    }
    fragmentIds.add(fragment.promptFragmentId);
    revisionIds.add(fragment.promptFragmentRevisionId);
    const region = regions.find((item) => item.regionKey === fragment.regionKey);
    if (region === undefined || region.contentKind !== "markdown") {
      throw new Error(`Builtin Prompt引用不存在或非Markdown Region:${fragment.regionKey}`);
    }
    const bodyMarkdown = await readCatalogFile(root, fragment.relativePath);
    if (sha256(bodyMarkdown) !== fragment.sourceSha256) {
      throw new Error(`Builtin Prompt正文Hash漂移:${fragment.relativePath}`);
    }
    builtinFragments.push({
      promptFragmentId: fragment.promptFragmentId,
      promptFragmentRevisionId: fragment.promptFragmentRevisionId,
      revision: fragment.revision,
      regionKey: fragment.regionKey,
      title: fragment.title,
      ...(fragment.description !== undefined ? { description: fragment.description } : {}),
      content: { kind: "markdown", bodyMarkdown },
      scope: { kind: "global" },
      sha256: hashCanonical("builtin-prompt-fragment-revision.v1", {
        ...fragment,
        content: bodyMarkdown,
      }),
      sourceRelativePath: fragment.relativePath,
      createdAt: manifest.publishedAt,
    });
  }

  const workspaceInstructionsRegion = regions.find(
    (item) => item.regionKey === "workspace_instructions",
  );
  if (workspaceInstructionsRegion !== undefined) {
    let roots: z.infer<typeof promptWorkspaceConfigSchema> = [];
    if (env.CHAT_PROJECT_ROOTS_JSON?.trim()) {
      roots = promptWorkspaceConfigSchema.parse(JSON.parse(env.CHAT_PROJECT_ROOTS_JSON));
    }
    const platformRootId = env.CHAT_PLATFORM_WORKSPACE_ROOT_ID?.trim() || "root_chat";
    for (const workspace of roots) {
      const canonicalRoot = await realpath(workspace.canonicalPath);
      const agentsPath = join(canonicalRoot, "AGENTS.md");
      let bodyMarkdown: string;
      try {
        const metadata = await stat(agentsPath);
        if (!metadata.isFile()) continue;
        bodyMarkdown = await readFile(agentsPath, "utf8");
      } catch {
        continue;
      }
      if (bodyMarkdown.trim() === "") continue;
      const identity = sha256(`${workspace.rootId}\u0000AGENTS.md`).slice(0, 24);
      const promptFragmentId = promptFragmentIdSchema.parse(`pfg_workspaceagents${identity}`);
      const promptFragmentRevisionId = promptFragmentRevisionIdSchema.parse(
        `pfr_workspaceagents${identity}${sha256(bodyMarkdown).slice(0, 12)}`,
      );
      builtinFragments.push({
        promptFragmentId,
        promptFragmentRevisionId,
        revision: 1,
        regionKey: "workspace_instructions",
        title:
          workspace.rootId === platformRootId
            ? `${workspace.displayName} · 基础AGENTS.md`
            : `${workspace.displayName} · AGENTS.md`,
        description: "仅在用户本轮显式选择后进入System；Chat不会递归发现其他指令文件。",
        content: { kind: "markdown", bodyMarkdown },
        scope:
          workspace.rootId === platformRootId
            ? { kind: "global" as const }
            : { kind: "workspace" as const, rootId: workspace.rootId as never },
        sha256: hashCanonical("workspace-prompt-fragment-revision.v1", {
          rootId: workspace.rootId,
          relativePath: "AGENTS.md",
          content: bodyMarkdown,
        }),
        sourceRelativePath: `${workspace.rootId}/AGENTS.md`,
        sourceWorkspaceRootId: workspace.rootId,
        createdAt: manifest.publishedAt,
      });
    }
  }
  builtinFragments.sort((left, right) =>
    left.regionKey === right.regionKey
      ? left.title.localeCompare(right.title)
      : left.regionKey.localeCompare(right.regionKey),
  );
  const builtinRevisionIds = new Set(
    builtinFragments.map((fragment) => fragment.promptFragmentRevisionId),
  );
  for (const revisionId of manifest.sharedSelectionProfile.defaultRevisionIds) {
    if (!builtinRevisionIds.has(revisionId)) {
      throw new Error(`默认Prompt Profile引用不存在的Builtin Revision:${revisionId}`);
    }
  }
  const agentKeys = new Set<string>();
  for (const agent of manifest.agents) {
    if (agentKeys.has(agent.agentKey)) throw new Error(`Agent定义重复:${agent.agentKey}`);
    agentKeys.add(agent.agentKey);
    const promptFragmentRevisionId = agent.defaultPrompt.promptFragmentRevisionId;
    if (promptFragmentRevisionId !== undefined) {
      const prompt = builtinFragments.find(
        (fragment) => fragment.promptFragmentRevisionId === promptFragmentRevisionId,
      );
      if (prompt === undefined || prompt.regionKey !== "agent_identity") {
        throw new Error(`Agent默认Prompt不存在或不属于Agent身份区域:${agent.agentKey}`);
      }
    }
    if (
      agent.defaultPrompt.kind === "pi_coding_agent" &&
      agent.agentKey !== "direct" &&
      agent.agentKey !== "project_bootstrap" &&
      agent.agentKey !== "coding_executor"
    ) {
      throw new Error(`只有Pi-backed Agent可以引用Pi运行时默认Prompt:${agent.agentKey}`);
    }
    if (new Set(agent.tools.map((tool) => tool.name)).size !== agent.tools.length) {
      throw new Error(`Agent工具重复:${agent.agentKey}`);
    }
  }
  const planeEnabled = env.CHAT_PLANE_ENABLED === "1";
  const hiddenAgentKeys = new Set(planeEnabled ? [] : ["project_bootstrap"]);
  const hiddenBuiltinRevisionIds = new Set(
    manifest.agents
      .filter((agent) => hiddenAgentKeys.has(agent.agentKey))
      .flatMap((agent) =>
        agent.defaultPrompt.promptFragmentRevisionId === undefined
          ? []
          : [agent.defaultPrompt.promptFragmentRevisionId],
      ),
  );
  const agents = manifest.agents.filter((agent) => !hiddenAgentKeys.has(agent.agentKey));
  const discoverableBuiltinFragments = builtinFragments.filter(
    (fragment) => !hiddenBuiltinRevisionIds.has(fragment.promptFragmentRevisionId),
  );
  const snapshot: PromptCatalogSnapshot = {
    catalogSha256: hashCanonical("prompt-catalog.v1", {
      catalogRevision: manifest.catalogRevision,
      sharedSelectionProfile: manifest.sharedSelectionProfile,
      agents,
      regions,
      builtinFragments: discoverableBuiltinFragments.map(({ content: _content, ...item }) => item),
    }),
    sharedSelectionProfile: manifest.sharedSelectionProfile,
    regions,
    builtinFragments: discoverableBuiltinFragments,
    agents,
  };
  return {
    load: async () => structuredClone(snapshot),
    resolveBuiltinRevision: async (input) => {
      const revision = builtinFragments.find(
        (candidate) => candidate.promptFragmentRevisionId === input.promptFragmentRevisionId,
      );
      return revision?.sha256 === input.sha256 ? structuredClone(revision) : undefined;
    },
  };
}
