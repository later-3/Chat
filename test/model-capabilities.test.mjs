import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_MODEL_APIS, CHAT_MODEL_CAPABILITIES, CHAT_THINKING_LEVELS } from "../src/model-capabilities.ts";
import { parseThinkingLevel } from "../src/workflows/agent-config.ts";

test("Chat model capabilities are the single Thinking Level and API source", () => {
  // agent-config 校验必须接受且只接受统一清单中的 Thinking Level。
  for (const level of CHAT_THINKING_LEVELS) {
    assert.equal(parseThinkingLevel(level), level);
  }
  assert.throws(() => parseThinkingLevel("auto"), /thinkingLevel无效/);
  assert.throws(() => parseThinkingLevel("ultra"), /thinkingLevel无效/);

  // 清单稳定、无重复，并随 /api/models 与 /api/models-config 原样下发。
  assert.deepEqual(CHAT_THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(new Set(CHAT_THINKING_LEVELS).size, CHAT_THINKING_LEVELS.length);
  assert.equal(new Set(CHAT_MODEL_APIS).size, CHAT_MODEL_APIS.length);
  assert.ok(CHAT_MODEL_APIS.length >= 4, "model API options must not silently shrink");
  assert.deepEqual(CHAT_MODEL_CAPABILITIES.thinkingLevels, CHAT_THINKING_LEVELS);
  assert.deepEqual(CHAT_MODEL_CAPABILITIES.modelApis, CHAT_MODEL_APIS);
});
