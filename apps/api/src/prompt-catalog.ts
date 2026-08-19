import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMPT_STUDIO_API_SCHEMA_VERSION,
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

const manifestSchema = z
  .object({
    schemaVersion: z.literal("chat-prompt-catalog.v1"),
    catalogRevision: z.number().int().positive(),
    publishedAt: z.iso.datetime(),
    regionSource: z
      .object({ relativePath: relativePathSchema, sourceSha256: sha256Schema })
      .strict(),
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
export async function createFilePromptCatalog(repoRoot?: string): Promise<PromptCatalogPort> {
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
    if (region === undefined || !region.userManageable || region.contentKind !== "markdown") {
      throw new Error(`Builtin Prompt引用不可管理或非Markdown Region:${fragment.regionKey}`);
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
      sha256: hashCanonical("builtin-prompt-fragment-revision.v1", {
        ...fragment,
        content: bodyMarkdown,
      }),
      sourceRelativePath: fragment.relativePath,
      createdAt: manifest.publishedAt,
    });
  }
  builtinFragments.sort((left, right) =>
    left.regionKey === right.regionKey
      ? left.title.localeCompare(right.title)
      : left.regionKey.localeCompare(right.regionKey),
  );
  const snapshot: PromptCatalogSnapshot = {
    catalogSha256: hashCanonical("prompt-catalog.v1", {
      catalogRevision: manifest.catalogRevision,
      regions,
      builtinFragments: builtinFragments.map(({ content: _content, ...item }) => item),
    }),
    regions,
    builtinFragments,
  };
  return { load: async () => structuredClone(snapshot) };
}
