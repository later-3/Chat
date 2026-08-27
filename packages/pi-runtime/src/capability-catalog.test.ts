import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildPiDirectCapabilityCatalog,
  resolveCapabilitySnapshots,
} from "./capability-catalog.js";

function tool(name: string, sourceInfo: ToolInfo["sourceInfo"]): ToolInfo {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    promptGuidelines: [],
    sourceInfo,
  };
}

describe("Pi Direct Capability Catalog", () => {
  it("禁止Extension用read覆盖built-in来源", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-capability-collision-"));
    const extension = join(root, "read-extension.ts");
    await writeFile(extension, "export const read = () => 'override';\n", "utf8");
    const catalog = await buildPiDirectCapabilityCatalog({
      cwd: root,
      agentDir: join(root, ".pi"),
      managedPiRevision: "1".repeat(40),
      tools: [
        tool("read", {
          path: extension,
          source: "read-extension.ts",
          scope: "project",
          origin: "top-level",
        }),
      ],
    });
    expect(catalog.descriptors).toEqual([]);
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ code: "capability.builtin_override_forbidden" }),
    ]);
  });

  it("为built-in与命名空间Extension生成不同qualified identity并冻结实现Hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-capability-qualified-"));
    const extension = join(root, "acme-probe.ts");
    await writeFile(extension, "export const probe = () => 'v1';\n", "utf8");
    const catalog = await buildPiDirectCapabilityCatalog({
      cwd: root,
      agentDir: join(root, ".pi"),
      managedPiRevision: "2".repeat(40),
      tools: [
        tool("read", {
          path: "<builtin:read>",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        }),
        tool("acme:probe", {
          path: extension,
          source: "acme-probe.ts",
          scope: "project",
          origin: "top-level",
        }),
      ],
    });
    expect(catalog.diagnostics).toEqual([]);
    expect(catalog.descriptors.map((descriptor) => descriptor.capabilityId)).toEqual([
      "pi_direct:tool:builtin:read",
      expect.stringMatching(/^pi_direct:tool:workspace_extension:[a-f0-9]{20}:acme:probe$/u),
    ]);
    const resolved = resolveCapabilitySnapshots({
      descriptors: catalog.descriptors,
      activeToolNames: ["read", "acme:probe"],
      workspaceRootId: "root_test",
    });
    expect(resolved.map((capability) => capability.localName)).toEqual(["read", "acme:probe"]);
    expect(resolved[1]?.sourceRef.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolved[1]?.effect).toBe("external_write");
  });

  it("Extension实现Hash覆盖排序后的依赖树而不只覆盖入口文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-capability-tree-"));
    const extensionDir = join(root, "extension");
    await mkdir(extensionDir);
    const entry = join(extensionDir, "index.ts");
    const dependency = join(extensionDir, "handler.ts");
    await writeFile(entry, "export { handler } from './handler.js';\n", "utf8");
    await writeFile(dependency, "export const handler = () => 'v1';\n", "utf8");
    const build = () =>
      buildPiDirectCapabilityCatalog({
        cwd: root,
        agentDir: join(root, ".pi"),
        managedPiRevision: "3".repeat(40),
        tools: [
          tool("acme:tree", {
            path: entry,
            baseDir: extensionDir,
            source: "acme-tree",
            scope: "project",
            origin: "top-level",
          }),
        ],
      });
    const before = await build();
    await writeFile(dependency, "export const handler = () => 'v2';\n", "utf8");
    const after = await build();
    expect(before.descriptors[0]?.sourceRef.contentSha256).not.toBe(
      after.descriptors[0]?.sourceRef.contentSha256,
    );
    expect(before.descriptors[0]?.descriptorSha256).not.toBe(
      after.descriptors[0]?.descriptorSha256,
    );
  });

  it("普通Extension重复localName在最终Map覆盖前失败关闭", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-capability-duplicate-"));
    const first = join(root, "first.ts");
    const second = join(root, "second.ts");
    await writeFile(first, "export const probe = 1;\n", "utf8");
    await writeFile(second, "export const probe = 2;\n", "utf8");
    const firstTool = tool("acme:probe", {
      path: first,
      source: "first.ts",
      scope: "project",
      origin: "top-level",
    });
    const secondTool = tool("acme:probe", {
      path: second,
      source: "second.ts",
      scope: "project",
      origin: "top-level",
    });
    const catalog = await buildPiDirectCapabilityCatalog({
      cwd: root,
      agentDir: join(root, ".pi"),
      managedPiRevision: "4".repeat(40),
      tools: [secondTool],
      extensionTools: [firstTool, secondTool],
    });
    expect(catalog.descriptors).toEqual([]);
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({ code: "capability.duplicate_executable_local_name" }),
    );
  });

  it("workspace/global/provider_defined各自解析精确Scope且缺失时失败关闭", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-capability-scope-"));
    const managedRoot = await mkdtemp(join(tmpdir(), "chat-managed-capability-"));
    const managed = join(managedRoot, "global.ts");
    await writeFile(managed, "export const globalTool = () => true;\n", "utf8");
    const catalog = await buildPiDirectCapabilityCatalog({
      cwd: root,
      agentDir: join(root, ".pi"),
      managedPiRevision: "6".repeat(40),
      tools: [
        tool("read", {
          path: "<builtin:read>",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        }),
        tool("acme:global", {
          path: managed,
          baseDir: managedRoot,
          source: "acme-global",
          scope: "user",
          origin: "top-level",
        }),
      ],
    });
    expect(() =>
      resolveCapabilitySnapshots({
        descriptors: catalog.descriptors,
        activeToolNames: ["read"],
      }),
    ).toThrow("Capability要求受权Workspace");
    const resolved = resolveCapabilitySnapshots({
      descriptors: catalog.descriptors,
      activeToolNames: ["read", "acme:global"],
      workspaceRootId: "root_scope",
    });
    expect(resolved.map((item) => item.ref.scopeRef)).toEqual([
      { kind: "workspace", rootId: "root_scope" },
      { kind: "global" },
    ]);
  });
});
