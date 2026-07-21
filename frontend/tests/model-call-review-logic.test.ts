import assert from "node:assert/strict";
import test from "node:test";

import {
  changeMessageRole,
  contextSourceIndexForMessage,
  convertRequestForProvider,
  policyIssues,
  requestInstructions,
  requestMessages,
  stableStringify,
} from "../src/model-call-review-logic.js";
import type {
  ModelCapabilities,
  ModelProviderOption,
} from "../src/use-chat-agent.js";

const capabilities: ModelCapabilities = {
  roles: ["user", "assistant", "developer", "system"],
  content_types_by_role: {
    user: ["input_text", "input_image"],
    assistant: ["output_text"],
    developer: ["input_text"],
    system: ["input_text"],
  },
  parameters: [
    {
      key: "store",
      label: "Provider保存响应",
      value_type: "boolean",
      default: false,
      choices: [],
      minimum: null,
      maximum: null,
      child_key: null,
      locked: true,
    },
    {
      key: "stream",
      label: "流式返回",
      value_type: "boolean",
      default: true,
      choices: [],
      minimum: null,
      maximum: null,
      child_key: null,
      locked: false,
    },
    {
      key: "temperature",
      label: "随机性",
      value_type: "number",
      default: 1,
      choices: [],
      minimum: 0,
      maximum: 2,
      child_key: null,
      locked: false,
    },
  ],
  token_estimator: "unicode_heuristic_v1",
  allow_unknown_parameters: false,
};

const catalog: ModelProviderOption[] = [
  {
    id: "provider-a",
    label: "Provider A",
    protocol: "openai_responses",
    models: [{ id: "model-a", label: "Model A", capabilities }],
  },
];

const chatCapabilities: ModelCapabilities = {
  ...capabilities,
  roles: ["user", "assistant", "system"],
  content_types_by_role: {
    user: ["text", "image_url"],
    assistant: ["text"],
    system: ["text"],
  },
};

const chatProvider: ModelProviderOption = {
  id: "chat-provider",
  label: "Chat Provider",
  protocol: "openai_chat_completions",
  models: [{ id: "chat-model", label: "Chat Model", capabilities: chatCapabilities }],
};

function validRequest(): Record<string, unknown> {
  return {
    model: "model-a",
    instructions: "回答用户",
    input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }],
    tools: [],
    store: false,
    stream: true,
  };
}

test("有效请求通过Provider和模型能力校验", () => {
  assert.deepEqual(policyIssues("provider-a", catalog, validRequest()), []);
});

test("role、内容类型、空文字和未知参数都在保存前被发现", () => {
  const request = validRequest();
  request.input = [
    { role: "tool", content: [{ type: "input_text", text: "伪Tool结果" }] },
    { role: "assistant", content: [{ type: "input_text", text: "不兼容" }] },
    { role: "user", content: [{ type: "input_text", text: " " }] },
  ];
  request.unknown_parameter = true;

  const issues = policyIssues("provider-a", catalog, request).join("；");
  assert.match(issues, /role不受当前模型支持/);
  assert.match(issues, /内容与role不兼容/);
  assert.match(issues, /文字不能为空/);
  assert.match(issues, /没有声明参数能力/);
});

test("切换role会同步修正内容类型而不产生tool角色", () => {
  const changed = changeMessageRole(
    { role: "user", content: [{ type: "input_text", text: "历史回答" }] },
    "assistant",
    capabilities,
  );
  assert.deepEqual(changed, {
    role: "assistant",
    content: [{ type: "output_text", text: "历史回答" }],
  });
  assert.equal(capabilities.roles.includes("tool"), false);
});

test("模型参数数值范围会阻止发送", () => {
  const request = validRequest();
  request.temperature = 3;
  assert.match(policyIssues("provider-a", catalog, request).join("；"), /不能大于2/);
});

test("运行时草稿允许Provider扩展参数和已绑定的真实Tool", () => {
  const request = validRequest();
  request.tools = [{
    type: "function",
    name: "read",
    description: "读取文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  }];
  request.input = [
    ...(request.input as unknown[]),
    { type: "function_call", call_id: "call-1", name: "read", arguments: "{\"path\":\"README.md\"}" },
    { type: "function_call_output", call_id: "call-1", output: "README内容" },
  ];
  request.prompt_cache_key = "runtime-cache-key";
  const runtimeCapabilities = { ...capabilities, allow_unknown_parameters: true };

  assert.deepEqual(policyIssues("provider-a", catalog, request, {
    capabilities: runtimeCapabilities,
    allowedToolNames: ["read"],
  }), []);

  const issues = policyIssues("provider-a", catalog, {
    ...request,
    tools: [{ type: "function", name: "new_tool" }],
  }, {
    capabilities: runtimeCapabilities,
    allowedToolNames: ["read"],
  });
  assert.match(issues.join("；"), /没有绑定当前执行器/);
});

test("同一语义对象不受key顺序影响", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
});

test("切换到Chat Completions会转换字段并保留同一指令与消息语义", () => {
  const request = validRequest();
  request.temperature = 0.5;
  request.unsupported_reasoning = { effort: "high" };

  const converted = convertRequestForProvider(request, chatProvider);

  assert.equal(converted.model, "chat-model");
  assert.equal("input" in converted, false);
  assert.equal("instructions" in converted, false);
  assert.equal(requestInstructions(converted), "回答用户");
  assert.deepEqual(requestMessages(converted), [
    { role: "system", content: "回答用户" },
    { role: "user", content: "你好" },
  ]);
  assert.equal("unsupported_reasoning" in converted, false);
  assert.deepEqual(policyIssues(chatProvider.id, [chatProvider], converted), []);
});

test("Chat Completions字符串消息可编辑并能转换回Responses结构", () => {
  const chatRequest = convertRequestForProvider(validRequest(), chatProvider);
  const responsesRequest = convertRequestForProvider(chatRequest, catalog[0]);

  assert.equal(requestInstructions(responsesRequest), "回答用户");
  assert.deepEqual(requestMessages(responsesRequest), [
    { role: "user", content: [{ type: "input_text", text: "你好" }] },
  ]);
  assert.deepEqual(policyIssues("provider-a", catalog, responsesRequest), []);
  assert.deepEqual(
    changeMessageRole({ role: "user", content: "历史回答" }, "assistant", chatCapabilities),
    { role: "assistant", content: "历史回答" },
  );
});

test("跨协议切换前后都不会把用户消息来源错标为Instructions", () => {
  assert.equal(contextSourceIndexForMessage(1, 2, 1, 0), 0);
  assert.equal(contextSourceIndexForMessage(1, 2, 2, 0), 1);
});
