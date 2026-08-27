import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  CapabilityDescriptor,
  CapabilityDescriptorHashInput,
  CapabilityEffect,
  CapabilityScopeRef,
  ResolvedCapabilitySnapshot,
} from "@chat/contracts";
import { capabilityDescriptorHashInputSchema, capabilityDescriptorSchema } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import { hashExecutorValue } from "./executor-operation-store.js";

const BUILTIN_SOURCE: Readonly<Record<string, string>> = {
  read: "pi/packages/coding-agent/src/core/tools/read.ts",
  grep: "pi/packages/coding-agent/src/core/tools/grep.ts",
  find: "pi/packages/coding-agent/src/core/tools/find.ts",
  ls: "pi/packages/coding-agent/src/core/tools/ls.ts",
  edit: "pi/packages/coding-agent/src/core/tools/edit.ts",
  write: "pi/packages/coding-agent/src/core/tools/write.ts",
  bash: "pi/packages/coding-agent/src/core/tools/bash.ts",
};

const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_SOURCE));
const TREE_HASH_MAX_FILES = 10_000;
const TREE_HASH_MAX_BYTES = 64 * 1024 * 1024;

export interface CapabilityCatalogDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly sourcePath?: string | undefined;
}

export interface CapabilityCatalogResult {
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly diagnostics: readonly CapabilityCatalogDiagnostic[];
}

function createCapabilityDescriptor(input: CapabilityDescriptorHashInput): CapabilityDescriptor {
  const normalized = capabilityDescriptorHashInputSchema.parse(input);
  return capabilityDescriptorSchema.parse({
    ...normalized,
    descriptorSha256: hashCanonical("capability-descriptor.v1", normalized),
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function portableCapabilityResourcePath(
  path: string,
  cwd: string,
  agentDir: string,
): string {
  if (!isAbsolute(path)) return path.replaceAll("\\", "/");
  const normalized = resolve(path);
  const agentRelative = relative(agentDir, normalized);
  if (agentRelative !== "" && !agentRelative.startsWith("..")) {
    return `<AGENT_DIR>/${agentRelative.replaceAll("\\", "/")}`;
  }
  const cwdRelative = relative(cwd, normalized);
  if (cwdRelative !== "" && !cwdRelative.startsWith("..")) {
    return `<WORKSPACE_ROOT>/${cwdRelative.replaceAll("\\", "/")}`;
  }
  return `<EXTERNAL_RESOURCE>/${path.split(/[\\/]/u).at(-1) ?? "unknown"}`;
}

/**
 * Extension身份冻结其本地实现树，而不是只冻结入口文件。目录遍历排序后把相对路径、
 * 文件长度与正文共同Hash；symlink、超限或不可读一律失败关闭，避免依赖闭包漂移。
 */
export async function hashCapabilityImplementationTree(root: string): Promise<string> {
  const normalizedRoot = resolve(root);
  const entries: Array<{ readonly path: string; readonly bytes: Uint8Array }> = [];
  let totalBytes = 0;
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("capability.extension_symlink_forbidden");
    if (info.isDirectory()) {
      const children = (await readdir(path)).sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        if (child === ".git" || child === "node_modules") continue;
        await visit(resolve(path, child));
      }
      return;
    }
    if (!info.isFile()) throw new Error("capability.extension_non_file_forbidden");
    if (entries.length >= TREE_HASH_MAX_FILES)
      throw new Error("capability.extension_tree_too_large");
    const bytes = await readFile(path);
    totalBytes += bytes.byteLength;
    if (totalBytes > TREE_HASH_MAX_BYTES) throw new Error("capability.extension_tree_too_large");
    entries.push({ path: relative(normalizedRoot, path).replaceAll("\\", "/"), bytes });
  }
  await visit(normalizedRoot);
  if (entries.length === 0) throw new Error("capability.extension_tree_empty");
  const digest = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(`${entry.path}\0${entry.bytes.byteLength}\0`, "utf8");
    digest.update(entry.bytes);
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

async function sourceTreeSha256(source: SourceInfo): Promise<string | undefined> {
  if (!isAbsolute(source.path)) return undefined;
  try {
    return await hashCapabilityImplementationTree(source.baseDir ?? dirname(source.path));
  } catch {
    return undefined;
  }
}

function effectForTool(localName: string): CapabilityEffect {
  if (["read", "grep", "find", "ls"].includes(localName)) return "read";
  if (["edit", "write"].includes(localName)) return "local_write";
  if (localName === "bash") return "shell";
  // Extension Tool没有可验证的声明时保守按外部写处理，绝不因陌生名字自动放权。
  return "external_write";
}

function capabilityId(input: {
  readonly sourceKind: "builtin" | "managed_extension" | "workspace_extension";
  readonly localName: string;
  readonly stableSourcePath: string;
}): string {
  const local = input.localName.toLowerCase().replace(/[^a-z0-9_.:-]/gu, "-");
  if (input.sourceKind === "builtin") return `pi_direct:tool:builtin:${local}`;
  const sourceKey = sha256(`${input.sourceKind}\n${input.stableSourcePath}`).slice(0, 20);
  return `pi_direct:tool:${input.sourceKind}:${sourceKey}:${local}`;
}

/**
 * Pi最终目录已经应用Runtime覆盖顺序。v1明确禁止Extension覆盖built-in本地名；
 * 其余Extension用SourceInfo生成qualified ID，并把源码正文Hash钉进描述符。
 */
export async function buildPiDirectCapabilityCatalog(input: {
  readonly tools: readonly ToolInfo[];
  /** ResourceLoader中尚未被最终Map覆盖的原始Extension注册，用于碰撞证明。 */
  readonly extensionTools?: readonly ToolInfo[];
  readonly cwd: string;
  readonly agentDir: string;
  readonly managedPiRevision: string;
}): Promise<CapabilityCatalogResult> {
  const descriptors: CapabilityDescriptor[] = [];
  const diagnostics: CapabilityCatalogDiagnostic[] = [];
  const duplicateLocalNames = new Set<string>();
  const extensionTools = input.extensionTools ?? [];
  const registrationsByName = new Map<string, ToolInfo[]>();
  for (const registration of extensionTools) {
    const registrations = registrationsByName.get(registration.name) ?? [];
    registrations.push(registration);
    registrationsByName.set(registration.name, registrations);
  }
  for (const [name, registrations] of registrationsByName) {
    if (registrations.length < 2) continue;
    duplicateLocalNames.add(name);
    diagnostics.push({
      code: "capability.duplicate_executable_local_name",
      message: `多个Extension注册了同一可执行Tool:${name}`,
    });
  }
  const finalToolsByName = new Map<string, number>();
  for (const finalTool of input.tools) {
    finalToolsByName.set(finalTool.name, (finalToolsByName.get(finalTool.name) ?? 0) + 1);
  }
  for (const [name, count] of finalToolsByName) {
    if (count < 2 || duplicateLocalNames.has(name)) continue;
    duplicateLocalNames.add(name);
    diagnostics.push({
      code: "capability.duplicate_executable_local_name",
      message: `最终运行目录含重复可执行Tool:${name}`,
    });
  }
  for (const tool of input.tools) {
    if (duplicateLocalNames.has(tool.name)) continue;
    const inputSchemaSha256 = hashExecutorValue(tool.parameters ?? {});
    const source = tool.sourceInfo;
    const builtin = source.source === "builtin" && source.path === `<builtin:${tool.name}>`;
    if (BUILTIN_NAMES.has(tool.name) && !builtin) {
      diagnostics.push({
        code: "capability.builtin_override_forbidden",
        message: `Extension不得覆盖Pi built-in Tool:${tool.name}`,
        sourcePath: portableCapabilityResourcePath(source.path, input.cwd, input.agentDir),
      });
      continue;
    }
    if (builtin) {
      const resourcePath = BUILTIN_SOURCE[tool.name];
      if (resourcePath === undefined) {
        diagnostics.push({
          code: "capability.builtin_source_unknown",
          message: `Pi built-in Tool缺少受管源码映射:${tool.name}`,
        });
        continue;
      }
      const effect = effectForTool(tool.name);
      descriptors.push(
        createCapabilityDescriptor({
          schemaVersion: "capability-descriptor.v1",
          capabilityId: capabilityId({
            sourceKind: "builtin",
            localName: tool.name,
            stableSourcePath: resourcePath,
          }),
          kind: "executable_tool",
          runtimeOwner: "pi_direct",
          localName: tool.name,
          sourceRef: {
            sourceKind: "builtin",
            package: "@earendil-works/pi-coding-agent",
            repository: "later-3/pi",
            revision: input.managedPiRevision,
            resourcePath,
          },
          inputSchemaSha256,
          effect,
          scopePolicy: "workspace_required",
          approvalPolicy: effect === "read" ? "run_policy" : "product_decision_required",
          evidencePolicy: effect === "read" ? "runtime_journal" : "product_intent_result",
          readiness: "available",
        }),
      );
      continue;
    }
    const resourcePath = portableCapabilityResourcePath(source.path, input.cwd, input.agentDir);
    const workspace = source.scope === "project" || resourcePath.startsWith("<WORKSPACE_ROOT>/");
    const contentSha256 = await sourceTreeSha256(source);
    if (contentSha256 === undefined) {
      diagnostics.push({
        code: "capability.extension_artifact_unreadable",
        message: `Extension Tool无法绑定源码工件:${tool.name}`,
        sourcePath: resourcePath,
      });
      continue;
    }
    const sourceKind = workspace ? "workspace_extension" : "managed_extension";
    const effect = effectForTool(tool.name);
    descriptors.push(
      createCapabilityDescriptor({
        schemaVersion: "capability-descriptor.v1",
        capabilityId: capabilityId({
          sourceKind,
          localName: tool.name,
          stableSourcePath: resourcePath,
        }),
        kind: "executable_tool",
        runtimeOwner: "pi_direct",
        localName: tool.name,
        sourceRef: {
          sourceKind,
          package: source.source,
          resourcePath,
          contentSha256,
        },
        inputSchemaSha256,
        effect,
        scopePolicy: workspace ? "workspace_required" : "global",
        approvalPolicy: "product_decision_required",
        evidencePolicy: "product_intent_result",
        readiness: "available",
      }),
    );
  }
  const descriptorsById = new Map<string, CapabilityDescriptor>();
  for (const descriptor of descriptors) {
    const existing = descriptorsById.get(descriptor.capabilityId);
    if (existing === undefined) {
      descriptorsById.set(descriptor.capabilityId, descriptor);
      continue;
    }
    if (existing.descriptorSha256 !== descriptor.descriptorSha256) {
      diagnostics.push({
        code: "capability.duplicate_id_conflict",
        message: `Capability ID映射到不同描述符:${descriptor.capabilityId}`,
      });
    }
  }
  if (diagnostics.some((item) => item.code === "capability.duplicate_id_conflict")) {
    return { descriptors: [], diagnostics };
  }
  return { descriptors, diagnostics };
}

export function resolveCapabilitySnapshots(input: {
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly activeToolNames: readonly string[];
  readonly workspaceRootId?: string | undefined;
  readonly providerScopes?: ReadonlyMap<string, Extract<CapabilityScopeRef, { kind: "provider" }>>;
}): ResolvedCapabilitySnapshot[] {
  const byName = new Map<string, CapabilityDescriptor>();
  for (const descriptor of input.descriptors) {
    if (byName.has(descriptor.localName)) {
      throw new Error(`Capability目录含重复活动Tool:${descriptor.localName}`);
    }
    byName.set(descriptor.localName, descriptor);
  }
  return input.activeToolNames.map((name) => {
    const descriptor = byName.get(name);
    if (descriptor === undefined) throw new Error(`Capability目录缺少活动Tool:${name}`);
    const { descriptorSha256, ...descriptorInput } = descriptor;
    if (descriptorSha256 !== hashCanonical("capability-descriptor.v1", descriptorInput)) {
      throw new Error(`Capability Descriptor Hash与字段不一致:${descriptor.capabilityId}`);
    }
    const scopeRef: CapabilityScopeRef =
      descriptor.scopePolicy === "global"
        ? { kind: "global" }
        : descriptor.scopePolicy === "workspace_required"
          ? input.workspaceRootId === undefined
            ? (() => {
                throw new Error(`Capability要求受权Workspace:${descriptor.capabilityId}`);
              })()
            : { kind: "workspace", rootId: input.workspaceRootId as `root_${string}` }
          : (input.providerScopes?.get(descriptor.capabilityId) ??
            (() => {
              throw new Error(`Capability要求Provider精确Scope:${descriptor.capabilityId}`);
            })());
    const implementationSource = {
      sourceRef: descriptor.sourceRef,
      descriptorSha256: descriptor.descriptorSha256,
    };
    return {
      ref: {
        capabilityId: descriptor.capabilityId,
        descriptorSha256: descriptor.descriptorSha256,
        inputSchemaSha256: descriptor.inputSchemaSha256,
        resolvedImplementationSha256: hashExecutorValue(implementationSource),
        scopeRef,
      },
      localName: descriptor.localName,
      kind: descriptor.kind,
      runtimeOwner: descriptor.runtimeOwner,
      sourceRef: descriptor.sourceRef,
      effect: descriptor.effect,
      scopePolicy: descriptor.scopePolicy,
      approvalPolicy: descriptor.approvalPolicy,
      evidencePolicy: descriptor.evidencePolicy,
    };
  });
}
