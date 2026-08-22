import { describe, expect, it } from "vitest";
import {
  AGENT_VERSION_SCHEMA_VERSION,
  PI_BUILTIN_TOOL_NAMES,
  agentEnabledToolNamesSchema,
  agentVersionIdSchema,
  agentVersionSchema,
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
  it("接受Pi有序工具子集并生成不包含自身Hash的唯一输入投影", () => {
    expect(PI_BUILTIN_TOOL_NAMES).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const version = agentVersionSchema.parse(validAgentVersion());
    const hashInput = toAgentVersionHashInput(version);
    expect(hashInput).not.toHaveProperty("sha256");
    expect(hashInput.agentVersionId).toBe("avn_directdefault1");
    expect(agentVersionIdSchema.parse("avn_directdefault1")).toBe("avn_directdefault1");
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
