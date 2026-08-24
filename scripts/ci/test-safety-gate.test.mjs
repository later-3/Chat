import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeTestSafetyGate, validateTestSafetyGate } from "./test-safety-gate.mjs";

describe("paid and external test safety gate", () => {
  it("a present API Key without paid opt-in loads no credential and starts no child", async () => {
    let loads = 0;
    let runs = 0;
    await assert.rejects(
      executeTestSafetyGate(
        {
          mode: "paid",
          commandName: "test:paid:provider:bailian",
          credentials: ["DASHSCOPE_API_KEY"],
          switches: [],
          environment: { DASHSCOPE_API_KEY: "present-but-forbidden" },
        },
        {
          loadEnvironment: async (environment) => {
            loads += 1;
            return environment;
          },
          run: () => {
            runs += 1;
            return 0;
          },
        },
      ),
      /CHAT_ALLOW_PAID_TESTS/u,
    );
    assert.equal(loads, 0);
    assert.equal(runs, 0);
  });

  it("rejects a paid command without :paid before credential loading", async () => {
    let loads = 0;
    await assert.rejects(
      validateTestSafetyGate(
        {
          mode: "paid",
          commandName: "test:provider:bailian",
          credentials: ["DASHSCOPE_API_KEY"],
          switches: [],
          environment: { CHAT_ALLOW_PAID_TESTS: "1", DASHSCOPE_API_KEY: "secret" },
        },
        async (environment) => {
          loads += 1;
          return environment;
        },
      ),
      /命令名必须包含:paid/u,
    );
    assert.equal(loads, 0);
  });

  it("requires the exact Provider credential after opt-in", async () => {
    await assert.rejects(
      validateTestSafetyGate(
        {
          mode: "paid",
          commandName: "test:paid:provider:bailian",
          credentials: ["DASHSCOPE_API_KEY"],
          switches: [],
          environment: { CHAT_ALLOW_PAID_TESTS: "1" },
        },
        async (environment) => environment,
      ),
      /DASHSCOPE_API_KEY/u,
    );
  });

  it("external writes require both the global and service-specific switches", async () => {
    const base = {
      mode: "external",
      commandName: "test:external:plane-ce",
      credentials: ["CHAT_PLANE_CE_API_TOKEN"],
      switches: ["CHAT_PLANE_CE_REAL_TEST"],
    };
    await assert.rejects(
      validateTestSafetyGate(
        {
          ...base,
          environment: {
            CHAT_PLANE_CE_REAL_TEST: "1",
            CHAT_PLANE_CE_API_TOKEN: "secret",
          },
        },
        async (environment) => environment,
      ),
      /CHAT_ALLOW_EXTERNAL_WRITES/u,
    );
    await assert.rejects(
      validateTestSafetyGate(
        {
          ...base,
          environment: {
            CHAT_ALLOW_EXTERNAL_WRITES: "1",
            CHAT_PLANE_CE_API_TOKEN: "secret",
          },
        },
        async (environment) => environment,
      ),
      /CHAT_PLANE_CE_REAL_TEST/u,
    );
  });
});
