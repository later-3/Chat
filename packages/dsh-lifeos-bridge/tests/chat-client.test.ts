import assert from "node:assert/strict";
import test from "node:test";
import { ChatProductClient } from "../src/chat-client.ts";
import {
  agentProfileDtoSchema,
  agentProfilesDtoSchema,
  agentVersionSchema,
  createAgentVersionPayloadSchema,
  productSessionIdSchema,
} from "@chat/contracts/public";
import { promptSelectionRequestSchema, workflowSelectionSchema } from "../src/contracts.ts";
import { promptTurnPreviewFixture } from "./prompt-turn-preview-fixture.ts";

const finalMessage = {
  schemaVersion: "chat-product-api.v1",
  messageId: "msg_final1",
  sessionId: "psn_history1",
  sessionSequence: 20_001,
  role: "assistant",
  content: { format: "markdown", text: "长会话中的正式回复" },
  sourceRunId: "run_history1",
  sha256: "a".repeat(64),
  createdAt: "2026-08-16T00:00:00.000Z",
} as const;

const agentVersion = agentVersionSchema.parse({
  schemaVersion: "agent-version.v1",
  agentVersionId: "avn_chatclientv1",
  agentKey: "direct",
  ownerPrincipalId: "usr_debug",
  scope: { kind: "global" },
  version: 1,
  title: "执行 Agent · 版本 1",
  description: "用于客户端版本合同测试。",
  sha256: "c".repeat(64),
  runtime: { kind: "pi_coding_agent", baseVariantKey: "read_only" },
  baselineRef: {
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    managedSourceRevision: "a".repeat(40),
    variantKey: "read_only",
    capabilityCatalogSha256: "e".repeat(64),
  },
  systemPrompt: {
    mode: "replace",
    bodyMarkdown: "你是执行 Agent。",
    sha256: "c".repeat(64),
  },
  enabledToolNames: ["read"],
  resources: {
    contextFiles: "inherit_runtime_default",
    skills: "inherit_runtime_default",
    promptTemplates: "inherit_runtime_default",
    extensions: "inherit_runtime_default",
  },
  createdAt: "2026-08-22T00:00:00.000Z",
});

const agentProfile = agentProfileDtoSchema.parse({
  schemaVersion: "chat-agent-profile-api.v2",
  agentKey: "direct",
  title: "执行 Agent",
  description: "用于客户端版本合同测试。",
  profileVersion: "direct-agent-prompt-profile.v1",
  supportedNodeTypes: ["agent.direct"],
  systemPrompt: {
    source: "builtin",
    mode: "replace",
    promptFragmentId: "pfg_chatclientv1",
    promptFragmentRevisionId: "pfr_chatclientv1",
    revision: 1,
    aggregateRevision: 3,
    sha256: "b".repeat(64),
    bodyMarkdown: "你是执行 Agent。",
    sourceRelativePath: "prompts/fragments/agent-identity/direct-agent.md",
  },
  runtimeBaseline: {
    kind: "pi_coding_agent",
    title: "Pi Coding Agent",
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    managedSourceRevision: "a".repeat(40),
    compositionStrategy: "pi_default_or_custom_then_chat_runtime_then_context",
    chatRuntimeAppend: {
      bodyMarkdown: "Chat runtime append",
      sha256: "d".repeat(64),
      sourceRelativePath: "packages/pi-runtime/src/coding-agent-runtime-profile.ts",
    },
    variants: [
      {
        variantKey: "read_only",
        capabilityCatalogSha256: "e".repeat(64),
        title: "Read only",
        description: "只读",
        enabledToolNames: ["read"],
        piSystemPrompt: {
          bodyMarkdown: "You are an expert coding assistant operating inside pi.",
          sha256: "e".repeat(64),
          dynamicPlaceholders: ["WORKSPACE_ROOT"],
          sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
        },
        tools: [
          {
            name: "read",
            description: "读取文件",
            parametersJson: "{}",
            sourceRelativePath: "pi/packages/coding-agent/src/core/tools/read.ts",
          },
        ],
      },
    ],
    finalReviewNote: "最终内容以发送前审核为准。",
  },
  tools: [
    {
      name: "read",
      description: "读取文件",
      policy: "runtime_locked",
    },
  ],
  versions: [agentVersion],
  allowedActions: ["revise_prompt", "create_version"],
});

const createdAgentVersion = agentVersionSchema.parse({
  ...agentVersion,
  agentVersionId: "avn_chatclientv2",
  version: 2,
  title: "执行 Agent · 版本 2",
  description: "创建 Agent Version 后返回的最新不可变版本。",
  sha256: "d".repeat(64),
  basedOnVersionId: agentVersion.agentVersionId,
});

const createdAgentProfile = agentProfileDtoSchema.parse({
  ...agentProfile,
  versions: [agentVersion, createdAgentVersion],
});

test("final message lookup uses the public exact query without scanning history", async () => {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify({ message: finalMessage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), fetchImpl);
  assert.deepEqual(
    await client.getMessage(finalMessage.sessionId, finalMessage.messageId),
    finalMessage,
  );
  assert.equal(urls.length, 1);
  assert.equal(
    urls[0]?.pathname,
    `/api/sessions/${finalMessage.sessionId}/messages/${finalMessage.messageId}`,
  );
  assert.equal(urls[0]?.search, "");
});

test("session records consume the public Product Session and opaque Message cursor queries", async () => {
  const urls: URL[] = [];
  const session = {
    schemaVersion: "chat-product-api.v1",
    sessionId: finalMessage.sessionId,
    status: "active",
    title: "历史记录",
    revision: 2,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  } as const;
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return url.pathname.endsWith("/messages")
      ? new Response(JSON.stringify({ items: [finalMessage], nextCursor: "opaque-next" }), {
          status: 200,
        })
      : new Response(JSON.stringify({ session }), { status: 200 });
  });
  assert.deepEqual(await client.getSession(session.sessionId), session);
  assert.deepEqual(await client.getMessages(session.sessionId, "opaque-current", 50), {
    items: [finalMessage],
    nextCursor: "opaque-next",
  });
  assert.equal(urls[0]?.pathname, `/api/sessions/${session.sessionId}`);
  assert.equal(urls[0]?.search, "");
  assert.equal(urls[1]?.pathname, `/api/sessions/${session.sessionId}/messages`);
  assert.equal(urls[1]?.searchParams.get("cursor"), "opaque-current");
  assert.equal(urls[1]?.searchParams.get("limit"), "50");
});

test("Agent profile queries and version creation preserve the immutable versions contract", async () => {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = [];
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    });
    if (url.pathname === "/api/agent-profiles") {
      return new Response(
        JSON.stringify(
          agentProfilesDtoSchema.parse({
            schemaVersion: "chat-agent-profile-api.v2",
            items: [agentProfile],
          }),
        ),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/agent-profiles/direct/versions") {
      return new Response(JSON.stringify(createdAgentProfile), { status: 201 });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  });

  assert.deepEqual((await client.getAgentProfiles("root_chat")).items[0]?.versions, [agentVersion]);

  const payload = createAgentVersionPayloadSchema.parse({
    title: "执行 Agent · 版本 2",
    description: "客户端版本化测试。",
    scope: { kind: "global" },
    runtime: { kind: "pi_coding_agent", baseVariantKey: "read_only" },
    systemPrompt: {
      mode: "replace",
      bodyMarkdown: "你是执行 Agent。",
    },
    enabledToolNames: ["read"],
    resources: {
      contextFiles: "inherit_runtime_default",
      skills: "inherit_runtime_default",
      promptTemplates: "inherit_runtime_default",
      extensions: "inherit_runtime_default",
    },
    basedOnVersionId: agentVersion.agentVersionId,
    basedOnVersionSha256: agentVersion.sha256,
  });

  const created = await client.createAgentVersion("direct", "cmd_chatclientv1", payload);
  assert.deepEqual(created.versions, [agentVersion, createdAgentVersion]);
  assert.equal(requests[0]?.url.pathname, "/api/agent-profiles");
  assert.equal(requests[0]?.url.search, "?workspaceRootId=root_chat");
  assert.equal(requests[1]?.url.pathname, "/api/agent-profiles/direct/versions");
  assert.equal(requests[1]?.method, "POST");
  assert.deepEqual(requests[1]?.body, {
    commandId: "cmd_chatclientv1",
    payload,
  });
});

test("Prompt Studio forwards workspace, scope filters, and semantic preview contracts", async () => {
  const requests: Array<{ url: URL; method: string; body?: unknown }> = [];
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    });
    if (url.pathname === "/api/prompt-workspaces") {
      return new Response(
        JSON.stringify({
          schemaVersion: "chat-prompt-studio-api.v1",
          items: [
            { schemaVersion: "chat-prompt-studio-api.v1", rootId: "root_chat", title: "Chat" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/prompt-fragments") {
      return new Response(
        JSON.stringify({ schemaVersion: "chat-prompt-studio-api.v1", items: [] }),
        { status: 200 },
      );
    }
    if (url.pathname === "/api/prompt-configuration-previews") {
      return new Response(
        JSON.stringify({
          schemaVersion: "chat-prompt-studio-api.v1",
          profileVersion: "direct-agent-prompt-profile.v1",
          compilerVersion: "direct-agent-prompt-compiler.v1",
          regions: [],
          systemPromptAppend: "",
          messageContext: "配置正文",
          sha256: "a".repeat(64),
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        schemaVersion: "chat-prompt-studio-api.v1",
        profileVersion: "direct-agent-prompt-profile.v1",
        compilerVersion: "direct-agent-prompt-compiler.v1",
        regions: [],
        systemPromptAppend: "",
        userPrompt: "# 当前输入\n测试",
        sha256: "a".repeat(64),
      }),
      { status: 200 },
    );
  });

  assert.equal((await client.getPromptWorkspaces()).items[0]?.rootId, "root_chat");
  await client.listPromptFragments({
    limit: 100,
    scopeKind: "workspace",
    workspaceRootId: "root_chat",
  });
  const selection = {
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    workspaceRootId: "root_chat",
    regions: [],
  };
  assert.equal(
    (await client.previewPromptAssembly({ text: "测试", selection })).userPrompt,
    "# 当前输入\n测试",
  );
  assert.equal((await client.previewPromptConfiguration({ selection })).messageContext, "配置正文");

  assert.equal(requests[1]?.url.searchParams.get("scopeKind"), "workspace");
  assert.equal(requests[1]?.url.searchParams.get("workspaceRootId"), "root_chat");
  assert.deepEqual(requests[2], {
    url: new URL("http://127.0.0.1:1/api/prompt-assembly-previews"),
    method: "POST",
    body: { text: "测试", selection },
  });
  assert.deepEqual(requests[3], {
    url: new URL("http://127.0.0.1:1/api/prompt-configuration-previews"),
    method: "POST",
    body: { selection },
  });
});

test("发送前完整Prompt预览使用专用只读Chat Query", async () => {
  const requests: Array<{ url: URL; method: string; body: unknown }> = [];
  const responseBody = promptTurnPreviewFixture("检查当前项目");
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (input, init) => {
    requests.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  });
  const payload = {
    sessionId: productSessionIdSchema.parse("psn_promptpreview"),
    message: {
      text: "检查当前项目",
      promptSelection: {
        schemaVersion: "prompt-turn-selection-input.v1" as const,
        regions: [],
      },
    },
  };
  assert.deepEqual(await client.previewPromptTurn(payload), responseBody);
  assert.deepEqual(requests, [
    {
      url: new URL("http://127.0.0.1:1/api/prompt-turn-previews"),
      method: "POST",
      body: payload,
    },
  ]);
});

test("submitMessage sends the frozen Prompt selection for every workflow", async () => {
  const bodies: unknown[] = [];
  const submittedMessage = {
    schemaVersion: "chat-product-api.v1",
    messageId: "msg_promptuser1",
    sessionId: "psn_prompt1",
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "测试" },
    sha256: "b".repeat(64),
    createdAt: "2026-08-20T00:00:00.000Z",
  } as const;
  const submittedRun = {
    schemaVersion: "chat-product-api.v1",
    productRunId: "run_prompt1",
    sessionId: "psn_prompt1",
    sourceMessageId: "msg_promptuser1",
    runKind: "direct_agent",
    status: "running",
    phase: "executing",
    allowedActions: [],
    revision: 1,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  } as const;
  const client = new ChatProductClient(new URL("http://127.0.0.1:1"), async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message: submittedMessage, run: submittedRun }), {
      status: 201,
    });
  });
  const direct = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "c".repeat(64),
    title: "执行 Agent",
    blueprintKey: "direct",
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [
        {
          kind: "node_config",
          definitionNodeId: "direct.agent",
          field: "promptReviewMode",
          value: "off",
        },
        {
          kind: "agent_configuration",
          definitionNodeId: "direct.agent",
          configurationMode: "version",
          agentVersionId: "avn_chatclientv1",
          agentVersionSha256: "f".repeat(64),
        },
      ],
    },
  });
  const planning = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemplanningv2",
    definitionSha256: "d".repeat(64),
    title: "默认规划",
    blueprintKey: "planning",
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1",
      overrides: [
        {
          kind: "agent_configuration",
          definitionNodeId: "planning.execute",
          configurationMode: "temporary",
          runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
          systemPrompt: { mode: "inherit_runtime" },
          enabledToolNames: ["read", "bash", "edit", "write"],
          resources: {
            contextFiles: "inherit_runtime_default",
            skills: "inherit_runtime_default",
            promptTemplates: "inherit_runtime_default",
            extensions: "inherit_runtime_default",
          },
        },
      ],
    },
  });
  const selection = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1",
    workspaceRootId: "root_chat",
    regions: [],
  });

  await client.submitMessage(
    "psn_prompt1",
    `cmd_${"a".repeat(48)}`,
    "测试",
    undefined,
    direct,
    selection,
  );
  await client.submitMessage(
    "psn_prompt1",
    `cmd_${"e".repeat(48)}`,
    "测试",
    undefined,
    planning,
    selection,
  );
  assert.deepEqual(
    (bodies[0] as { payload?: { promptSelection?: unknown } }).payload?.promptSelection,
    selection,
  );
  assert.deepEqual(
    (bodies[0] as { payload?: { workflowSelection?: { runConfiguration?: unknown } } }).payload
      ?.workflowSelection?.runConfiguration,
    direct.runConfiguration,
  );
  assert.deepEqual(
    (bodies[1] as { payload?: { promptSelection?: unknown } }).payload?.promptSelection,
    selection,
  );
  assert.deepEqual(
    (bodies[1] as { payload?: { workflowSelection?: { runConfiguration?: unknown } } }).payload
      ?.workflowSelection?.runConfiguration,
    planning.runConfiguration,
  );
});
