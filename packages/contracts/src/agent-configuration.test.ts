import { describe, expect, it } from "vitest";
import {
  AGENT_VERSION_SCHEMA_VERSION,
  LEGACY_AGENT_VERSION_SCHEMA_VERSION,
  PI_BUILTIN_TOOL_NAMES,
  agentEnabledToolNamesSchema,
  agentVersionIdSchema,
  agentVersionSchema,
  inspectDirectAgentConfigurationSource,
  toAgentVersionHashInput,
} from "./index.js";

const NOW = "2026-08-22T08:00:00.000Z";

function validAgentVersion() {
  return {
    schemaVersion: AGENT_VERSION_SCHEMA_VERSION,
    agentVersionId: "avn_directdefault1",
    agentKey: "direct",
    ownerPrincipalId: "usr_agentowner1",
    scope: { kind: "global" },
    version: 1,
    title: "Pi Coding Agent · 默认",
    description: "继承受管Pi运行时默认能力。",
    runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
    baselineRef: {
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.84.2",
      managedSource: "later-3/pi@codex/later-custom",
      managedSourceRevision: "1".repeat(40),
      variantKey: "pi_cli_default",
      capabilityCatalogSha256: "2".repeat(64),
    },
    systemPrompt: { mode: "inherit_runtime" },
    enabledToolNames: ["read", "bash", "edit", "write"],
    enabledCapabilityRefs: [
      {
        localName: "read",
        capabilityId: "later.pi.builtin.read.v1",
        descriptorSha256: "3".repeat(64),
      },
      {
        localName: "bash",
        capabilityId: "later.pi.builtin.bash.v1",
        descriptorSha256: "4".repeat(64),
      },
      {
        localName: "edit",
        capabilityId: "later.pi.builtin.edit.v1",
        descriptorSha256: "5".repeat(64),
      },
      {
        localName: "write",
        capabilityId: "later.pi.builtin.write.v1",
        descriptorSha256: "6".repeat(64),
      },
    ],
    resources: {
      contextFiles: "inherit_runtime_default",
      skills: "inherit_runtime_default",
      promptTemplates: "inherit_runtime_default",
      extensions: "inherit_runtime_default",
    },
    sha256: "a".repeat(64),
    createdAt: NOW,
  } as const;
}

describe("Agent Version合同", () => {
  it.each([
    ["runtime_default", {}, true, "runtime_default"],
    ["legacy_prompt_override", { agentPromptOverride: "旧Prompt" }, true, "legacy_prompt_override"],
    ["temporary", { agentTemporaryConfiguration: {} }, true, "temporary"],
    [
      "agent_version",
      { agentVersionId: "avn_source1", agentVersionSha256: "a".repeat(64) },
      true,
      "agent_version",
    ],
    [
      "version_temporary",
      {
        agentVersionId: "avn_source1",
        agentVersionSha256: "a".repeat(64),
        agentTemporaryConfiguration: {},
      },
      false,
      "agent.configuration.sources_conflict",
    ],
    [
      "version_prompt",
      {
        agentVersionId: "avn_source1",
        agentVersionSha256: "a".repeat(64),
        agentPromptOverride: "旁路Prompt",
      },
      false,
      "agent.configuration.sources_conflict",
    ],
    [
      "temporary_prompt",
      { agentTemporaryConfiguration: {}, agentPromptOverride: "旁路Prompt" },
      false,
      "agent.configuration.sources_conflict",
    ],
    [
      "three_sources",
      {
        agentVersionId: "avn_source1",
        agentVersionSha256: "a".repeat(64),
        agentTemporaryConfiguration: {},
        agentPromptOverride: "旁路Prompt",
      },
      false,
      "agent.configuration.sources_conflict",
    ],
    [
      "version_id_only",
      { agentVersionId: "avn_source1" },
      false,
      "agent.configuration.version_reference_incomplete",
    ],
    [
      "version_hash_only",
      { agentVersionSha256: "a".repeat(64) },
      false,
      "agent.configuration.version_reference_incomplete",
    ],
  ] as const)("唯一配置来源矩阵：%s", (_case, config, valid, expected) => {
    const inspected = inspectDirectAgentConfigurationSource(config);
    expect(inspected.valid).toBe(valid);
    expect(inspected.valid ? inspected.source : inspected.reason).toBe(expected);
  });

  it("接受Pi有序工具子集并生成不包含自身Hash的唯一输入投影", () => {
    expect(PI_BUILTIN_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const version = agentVersionSchema.parse(validAgentVersion());
    const hashInput = toAgentVersionHashInput(version);
    expect(hashInput).not.toHaveProperty("sha256");
    expect(hashInput.agentVersionId).toBe("avn_directdefault1");
    expect(agentVersionIdSchema.parse("avn_directdefault1")).toBe("avn_directdefault1");
  });

  it("v1严格保持旧合同，v2不可删除qualified refs且显式零Tool合法", () => {
    const current = validAgentVersion();
    const { enabledCapabilityRefs: _refs, ...withoutRefs } = current;
    void _refs;
    expect(agentVersionSchema.safeParse(withoutRefs).success).toBe(false);
    expect(
      agentVersionSchema.safeParse({
        ...withoutRefs,
        schemaVersion: LEGACY_AGENT_VERSION_SCHEMA_VERSION,
      }).success,
    ).toBe(true);
    expect(
      agentVersionSchema.safeParse({
        ...withoutRefs,
        schemaVersion: LEGACY_AGENT_VERSION_SCHEMA_VERSION,
        enabledCapabilityRefs: [],
      }).success,
    ).toBe(false);
    expect(
      agentVersionSchema.safeParse({
        ...current,
        enabledToolNames: [],
        enabledCapabilityRefs: [],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["names非空refs为空", { enabledCapabilityRefs: [] }],
    ["数量不等", { enabledCapabilityRefs: validAgentVersion().enabledCapabilityRefs.slice(0, 3) }],
    [
      "localName错配",
      {
        enabledCapabilityRefs: validAgentVersion().enabledCapabilityRefs.map((ref, index) =>
          index === 1 ? { ...ref, localName: "write" } : ref,
        ),
      },
    ],
    [
      "重复Ref/localName",
      {
        enabledCapabilityRefs: [
          validAgentVersion().enabledCapabilityRefs[0],
          validAgentVersion().enabledCapabilityRefs[0],
          ...validAgentVersion().enabledCapabilityRefs.slice(2),
        ],
      },
    ],
  ] as const)("v2拒绝不完整Capability集合：%s", (_label, mutation) => {
    expect(agentVersionSchema.safeParse({ ...validAgentVersion(), ...mutation }).success).toBe(
      false,
    );
  });

  it("v2拒绝相同capabilityId绑定两个不同Descriptor和localName", () => {
    const current = validAgentVersion();
    expect(
      agentVersionSchema.safeParse({
        ...current,
        enabledCapabilityRefs: current.enabledCapabilityRefs.map((ref, index) =>
          index === 1
            ? { ...ref, capabilityId: current.enabledCapabilityRefs[0].capabilityId }
            : ref,
        ),
      }).success,
    ).toBe(false);
  });

  it("叶子合同接受Runtime扩展Tool并拒绝重复或非法能力键", () => {
    expect(agentEnabledToolNamesSchema.safeParse(["read", "read"]).success).toBe(false);
    expect(agentEnabledToolNamesSchema.safeParse(["bash", "read"]).success).toBe(true);
    expect(agentEnabledToolNamesSchema.safeParse(["read", "extension_clock.now"]).success).toBe(
      true,
    );
    expect(agentEnabledToolNamesSchema.safeParse(["read", "bad tool"]).success).toBe(false);
  });

  it("严格拒绝自身派生、未知字段和不完整资源策略", () => {
    const selfDerived = {
      ...validAgentVersion(),
      basedOnVersionId: validAgentVersion().agentVersionId,
    };
    expect(agentVersionSchema.safeParse(selfDerived).success).toBe(false);
    expect(agentVersionSchema.safeParse({ ...validAgentVersion(), mutable: true }).success).toBe(
      false,
    );
    expect(
      agentVersionSchema.safeParse({
        ...validAgentVersion(),
        resources: { contextFiles: "disabled", skills: "disabled" },
      }).success,
    ).toBe(false);
  });

  it("replace System Prompt必须同时冻结正文和严格SHA-256形状", () => {
    expect(
      agentVersionSchema.safeParse({
        ...validAgentVersion(),
        systemPrompt: { mode: "replace", bodyMarkdown: "你是只读Agent。", sha256: "bad" },
      }).success,
    ).toBe(false);
  });
});
