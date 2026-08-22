import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_DIRECT_AGENT_RUNTIME_PROMPT,
  createPiAgentRuntimeProfileReader,
  inspectPiCliDefaultRuntimeVariant,
} from "./coding-agent-runtime-profile.js";
import { bindAndRecordDirectRuntime } from "./direct-agent-executor.js";

function hashTools(
  tools: Awaited<ReturnType<typeof inspectPiCliDefaultRuntimeVariant>>["variant"]["tools"],
): string {
  return createHash("sha256").update(JSON.stringify(tools), "utf8").digest("hex");
}

describe("Pi CLI default Agent runtime profile", () => {
  it("直接继承Pi SDK默认工具且不注入Chat只读身份", async () => {
    const inspection = await inspectPiCliDefaultRuntimeVariant();

    expect(inspection.variant.enabledToolNames).toEqual(["read", "bash", "edit", "write"]);
    expect(inspection.variant.tools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
    expect(inspection.variant.piSystemPrompt.bodyMarkdown).not.toContain(
      CHAT_DIRECT_AGENT_RUNTIME_PROMPT,
    );
    expect(inspection.resources.extensionPaths).toEqual(expect.any(Array));
    expect(inspection.resources.skillPaths).toEqual(expect.any(Array));
    expect(inspection.resources.promptTemplatePaths).toEqual(expect.any(Array));
    expect(inspection.resources.contextFilePaths).toEqual(expect.any(Array));
  }, 20_000);

  it("同一Pi公共SDK helper重复投影的System Prompt与Tool Schema哈希一致", async () => {
    const first = await inspectPiCliDefaultRuntimeVariant();
    const second = await inspectPiCliDefaultRuntimeVariant();

    expect(second.variant.piSystemPrompt.sha256).toBe(first.variant.piSystemPrompt.sha256);
    expect(hashTools(second.variant.tools)).toBe(hashTools(first.variant.tools));
  }, 20_000);

  it("Workspace配置与Extension只进入scoped目录，且后续读取可观察变化", async () => {
    const root = mkdtempSync(join(tmpdir(), "chat-pi-profile-scope-"));
    const emptyWorkspace = join(root, "empty");
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const projectPiDir = join(workspace, ".pi");
    const extensionDir = join(projectPiDir, "extensions");
    mkdirSync(emptyWorkspace, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(projectPiDir, "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));
    writeFileSync(
      join(extensionDir, "workspace-probe.ts"),
      [
        "export default function (pi) {",
        '  pi.registerTool({ name: "workspace_probe", label: "Workspace probe", description: "Workspace-only tool", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });',
        "}",
      ].join("\n"),
    );
    const reader = createPiAgentRuntimeProfileReader({
      previewCwd: emptyWorkspace,
      agentDir,
      workspaceRoots: new Map([["root_chat", { canonicalPath: workspace }]]),
    });

    try {
      const globalProfile = await reader.read("direct");
      const scopedProfile = await reader.read("direct", "root_chat");
      const globalVariant = globalProfile?.variants.find(
        (variant) => variant.variantKey === "pi_cli_default",
      );
      const scopedVariant = scopedProfile?.variants.find(
        (variant) => variant.variantKey === "pi_cli_default",
      );
      expect(globalVariant?.tools.map((tool) => tool.name)).not.toContain("workspace_probe");
      expect(scopedVariant?.tools.map((tool) => tool.name)).toContain("workspace_probe");
      expect(scopedVariant?.enabledToolNames).toEqual(["grep", "workspace_probe"]);

      writeFileSync(
        join(projectPiDir, "settings.json"),
        JSON.stringify({ defaultTools: ["find"] }),
      );
      const refreshed = await reader.read("direct", "root_chat");
      const refreshedVariant = refreshed?.variants.find(
        (variant) => variant.variantKey === "pi_cli_default",
      );
      expect(refreshedVariant?.enabledToolNames).toEqual(["find", "workspace_probe"]);
      expect(refreshedVariant?.capabilityCatalogSha256).not.toBe(
        scopedVariant?.capabilityCatalogSha256,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("默认Agent通过真实Pi AgentSession loop调用bash取得时间，显式受限版本才移除bash", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "chat-pi-cli-default-loop-"));
    const agentDir = join(workspace, "agent");
    mkdirSync(agentDir);

    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const services = await createAgentSessionServices({
      cwd: workspace,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      modelRuntime,
    });
    const { session: defaultSession } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(workspace),
      model: faux.getModel(),
      thinkingLevel: "off",
    });
    const { session: restrictedSession } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(workspace),
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: ["read"],
    });

    const fixedTime = "2026-08-22 16:00:00 +0800";
    let observedToolOutput: string | undefined;
    const executedTools: string[] = [];
    const unsubscribe = defaultSession.subscribe((event) => {
      if (event.type === "tool_execution_end" && !event.isError) {
        executedTools.push(event.toolName);
      }
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: `printf '${fixedTime}\\n'` }, { id: "fixed-time-call" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const result = [...context.messages]
          .reverse()
          .find(
            (message) => message.role === "toolResult" && message.toolCallId === "fixed-time-call",
          );
        if (result?.role === "toolResult") {
          observedToolOutput = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        }
        return fauxAssistantMessage(`当前时间是 ${observedToolOutput ?? "工具没有返回时间"}`);
      },
    ]);

    try {
      expect(defaultSession.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
      expect(defaultSession.systemPrompt).not.toContain(CHAT_DIRECT_AGENT_RUNTIME_PROMPT);
      expect(restrictedSession.getActiveToolNames()).toEqual(["read"]);
      expect(restrictedSession.getActiveToolNames()).not.toContain("bash");

      await defaultSession.prompt("现在几点了？");

      expect(faux.state.callCount).toBe(2);
      expect(executedTools).toEqual(["bash"]);
      expect(observedToolOutput).toContain(fixedTime);
      const finalAssistantMessage = [...defaultSession.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (finalAssistantMessage?.role !== "assistant") {
        throw new Error("Pi AgentSession没有产生最终Assistant消息");
      }
      expect(
        finalAssistantMessage.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ).toContain(fixedTime);
    } finally {
      unsubscribe();
      defaultSession.dispose();
      restrictedSession.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  it("真实Settings与Extension绑定后统一驱动Profile、Direct Journal和显式失败关闭", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "chat-pi-runtime-parity-"));
    const agentDir = join(workspace, "agent");
    const extensionDir = join(agentDir, "extensions", "runtime-probe");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));
    writeFileSync(
      join(extensionDir, "SKILL.md"),
      [
        "---",
        "name: runtime-probe",
        "description: Runtime parity resource",
        "---",
        "",
        "# Runtime probe",
      ].join("\n"),
    );
    writeFileSync(
      join(extensionDir, "index.ts"),
      [
        'import { join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        "export default function (pi) {",
        '  pi.registerTool({ name: "runtime_probe", label: "Runtime probe", description: "Runtime parity tool", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });',
        '  pi.on("resources_discover", () => ({ skillPaths: [join(fileURLToPath(new URL(".", import.meta.url)), "SKILL.md")] }));',
        "}",
      ].join("\n"),
    );

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const createBoundServices = () =>
      createAgentSessionServices({
        cwd: workspace,
        agentDir,
        settingsManager: SettingsManager.create(workspace, agentDir),
        modelRuntime,
      });

    try {
      const profile = await createPiAgentRuntimeProfileReader({
        previewCwd: workspace,
        agentDir,
      }).read("direct");
      const runtimeDefault = profile?.variants.find(
        (variant) => variant.variantKey === "pi_cli_default",
      );
      expect(runtimeDefault?.enabledToolNames).toEqual(["grep", "runtime_probe"]);
      expect(runtimeDefault?.tools.map((tool) => tool.name)).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "runtime_probe",
      ]);
      expect(runtimeDefault?.resourceInventory?.extensions).toEqual(
        expect.arrayContaining([expect.stringContaining("<AGENT_DIR>/extensions/runtime-probe")]),
      );
      expect(runtimeDefault?.resourceInventory?.skills).toEqual(
        expect.arrayContaining([
          expect.stringContaining("<AGENT_DIR>/extensions/runtime-probe/SKILL.md"),
        ]),
      );
      expect(
        Object.values(runtimeDefault?.resourceInventory ?? {})
          .flat()
          .every((path) => path.startsWith("<")),
      ).toBe(true);
      expect(runtimeDefault?.capabilityCatalogSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(profile?.managedSourceRevision).toMatch(/^[0-9a-f]{40}$/u);

      const services = await createBoundServices();
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(workspace),
      });
      const setSession = vi.fn(async () => undefined);
      const journalAllowedTools: string[] = [];
      try {
        const resolved = await bindAndRecordDirectRuntime({
          session,
          resourceLoader: services.resourceLoader,
          cwd: workspace,
          agentDir,
          tools: {
            capabilityMode: "pi_cli_default",
            selectionMode: "inherit_runtime_default",
            names: [],
            estimatedTokens: 8_000,
          },
          journalAllowedTools,
          operationId: "pio_runtimeparity",
          store: { setSession },
        });
        expect(resolved.enabledToolNames).toEqual(["grep", "runtime_probe"]);
        expect(resolved.activeTools.map((tool) => tool.name)).toEqual(["grep", "runtime_probe"]);
        expect(resolved.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(journalAllowedTools).toEqual(["grep", "runtime_probe"]);
        expect(setSession).toHaveBeenCalledWith(
          expect.objectContaining({
            enabledTools: ["grep", "runtime_probe"],
            resolvedRuntimeManifestSha256: resolved.sha256,
          }),
        );
      } finally {
        session.dispose();
      }

      const explicitServices = await createBoundServices();
      const { session: explicitSession } = await createAgentSessionFromServices({
        services: explicitServices,
        sessionManager: SessionManager.inMemory(workspace),
        tools: ["grep", "runtime_probe"],
      });
      try {
        const explicitAllowedTools = ["grep", "runtime_probe"];
        const explicitResolved = await bindAndRecordDirectRuntime({
          session: explicitSession,
          resourceLoader: explicitServices.resourceLoader,
          cwd: workspace,
          agentDir,
          tools: {
            capabilityMode: "custom",
            selectionMode: "explicit",
            names: explicitAllowedTools,
            estimatedTokens: 8_000,
          },
          journalAllowedTools: explicitAllowedTools,
          operationId: "pio_runtimeparityexplicit",
          store: { setSession: vi.fn(async () => undefined) },
        });
        expect(explicitResolved.enabledToolNames).toEqual(["grep", "runtime_probe"]);
        expect(explicitAllowedTools).toEqual(["grep", "runtime_probe"]);
      } finally {
        explicitSession.dispose();
      }

      const restrictedServices = await createBoundServices();
      const { session: restrictedSession } = await createAgentSessionFromServices({
        services: restrictedServices,
        sessionManager: SessionManager.inMemory(workspace),
        tools: ["missing_extension_tool"],
      });
      try {
        await expect(
          bindAndRecordDirectRuntime({
            session: restrictedSession,
            resourceLoader: restrictedServices.resourceLoader,
            cwd: workspace,
            agentDir,
            tools: {
              capabilityMode: "custom",
              selectionMode: "explicit",
              names: ["missing_extension_tool"],
              estimatedTokens: 8_000,
            },
            journalAllowedTools: ["missing_extension_tool"],
            operationId: "pio_runtimeparitymissing",
            store: { setSession: vi.fn(async () => undefined) },
          }),
        ).rejects.toMatchObject({
          code: "direct_executor.active_tool_manifest_mismatch",
        });
      } finally {
        restrictedSession.dispose();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
