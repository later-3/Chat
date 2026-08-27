import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_API_SCHEMA_VERSION,
  LEGACY_AGENT_PROFILE_API_SCHEMA_VERSION,
  agentProfilesDtoSchema,
  agentProfilesV2DtoSchema,
  promptEnvelopeToolsSchema,
  promptEnvelopeToolsV4Schema,
} from "./index.js";

const SHA = "a".repeat(64);

function v2Fixture() {
  return {
    schemaVersion: LEGACY_AGENT_PROFILE_API_SCHEMA_VERSION,
    items: [
      {
        schemaVersion: LEGACY_AGENT_PROFILE_API_SCHEMA_VERSION,
        agentKey: "direct",
        title: "Direct",
        description: "历史Agent Profile v2 Fixture",
        profileVersion: "fixture.v2",
        supportedNodeTypes: ["direct"],
        systemPrompt: {
          source: "runtime_default",
          mode: "inherit",
          aggregateRevision: 0,
          sha256: SHA,
          bodyMarkdown: "历史默认Prompt",
          runtimeVariantKey: "pi_cli_default",
          sourceRelativePaths: ["packages/pi-runtime/src/runtime.ts"],
        },
        runtimeBaseline: {
          kind: "pi_coding_agent",
          title: "Pi Coding Agent",
          packageName: "@earendil-works/pi-coding-agent",
          packageVersion: "0.84.2",
          managedSource: "later-3/pi@codex/later-custom",
          managedSourceRevision: "b".repeat(40),
          compositionStrategy: "pi_default_or_custom_then_chat_runtime_then_context",
          chatRuntimeAppend: {
            bodyMarkdown: "Chat Runtime",
            sha256: SHA,
            sourceRelativePath: "packages/pi-runtime/src/runtime.ts",
            appliesToVariantKeys: [],
          },
          variants: [
            {
              variantKey: "pi_cli_default",
              title: "默认",
              description: "历史v2 Variant",
              capabilityCatalogSha256: SHA,
              enabledToolNames: ["read"],
              piSystemPrompt: {
                bodyMarkdown: "Pi Prompt",
                sha256: SHA,
                dynamicPlaceholders: [],
                sourceRelativePaths: ["src/system-prompt.ts"],
              },
              tools: [
                {
                  name: "read",
                  description: "Read file",
                  parametersJson: "{}",
                  sourceRelativePath: "src/tools/read.ts",
                },
              ],
              resourceInventory: {
                extensions: [],
                skills: [],
                promptTemplates: [],
                contextFiles: [],
              },
            },
          ],
          finalReviewNote: "历史Fixture",
        },
        tools: [],
        versions: [],
        allowedActions: ["create_version"],
      },
    ],
  } as const;
}

describe("Agent Profile API代际合同", () => {
  it("严格读取真实v2字段集，拒绝在v2 literal下注入v3安全语义", () => {
    const fixture = v2Fixture();
    expect(agentProfilesV2DtoSchema.parse(fixture)).toEqual(fixture);
    const variant = fixture.items[0].runtimeBaseline.variants[0];
    expect(
      agentProfilesV2DtoSchema.safeParse({
        ...fixture,
        items: [
          {
            ...fixture.items[0],
            runtimeBaseline: {
              ...fixture.items[0].runtimeBaseline,
              variants: [{ ...variant, readiness: "available", diagnostics: [] }],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("当前服务端响应只接受v3 literal", () => {
    const current = {
      ...v2Fixture(),
      schemaVersion: AGENT_PROFILE_API_SCHEMA_VERSION,
      items: [],
    };
    expect(agentProfilesDtoSchema.parse(current)).toEqual(current);
    expect(agentProfilesDtoSchema.safeParse(v2Fixture()).success).toBe(false);
  });
});

describe("Prompt Assembly Tool代际合同", () => {
  const historicalBase = { estimatedTokens: 8_000 as const };
  const currentBase = {
    ...historicalBase,
    selectionMode: "explicit" as const,
    resources: {
      contextFiles: "disabled" as const,
      skills: "disabled" as const,
      promptTemplates: "disabled" as const,
      extensions: "disabled" as const,
    },
  };

  it("v4显式零Tool Agent合法", () => {
    expect(
      promptEnvelopeToolsV4Schema.safeParse({
        ...currentBase,
        capabilityMode: "custom",
        names: [],
        capabilities: [],
      }).success,
    ).toBe(true);
  });

  it("历史v2字面量保留真实资源策略但拒绝v4-only的Capability字段", () => {
    const historical = {
      ...historicalBase,
      capabilityMode: "read_only" as const,
      names: ["read", "grep", "find", "ls"],
    };
    expect(promptEnvelopeToolsSchema.safeParse(historical).success).toBe(true);
    expect(promptEnvelopeToolsSchema.safeParse({ ...historical, capabilities: [] }).success).toBe(
      false,
    );
    expect(
      promptEnvelopeToolsSchema.safeParse({
        ...historical,
        resources: currentBase.resources,
      }).success,
    ).toBe(true);
  });
});
