import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXTERNAL_OPT_IN_ENV,
  PROVIDER_AND_CREDENTIAL_ENV,
  createCiSafeEnvironment,
} from "./safe-environment.mjs";
import { CORE_VERIFY_COMMANDS } from "./verify-core.mjs";

describe("verify:core safety", () => {
  it("only runs deterministic root gates", () => {
    assert.deepEqual(CORE_VERIFY_COMMANDS, [
      ["pnpm", "build"],
      ["pnpm", "lint"],
      ["pnpm", "format:check"],
      ["pnpm", "typecheck"],
      ["pnpm", "test"],
    ]);
    const plan = CORE_VERIFY_COMMANDS.flat().join(" ");
    for (const forbidden of ["e2e", "memory", "paid", "plane", "provider", "workbench"]) {
      assert.doesNotMatch(plan, new RegExp(forbidden, "iu"));
    }
  });

  it("clears Provider credentials and disables optional runtimes", () => {
    const input = {
      ...Object.fromEntries(PROVIDER_AND_CREDENTIAL_ENV.map((name) => [name, "sentinel"])),
      CHAT_PROJECT_MODEL_API_KEY_ENV: "CUSTOM_PROVIDER_API_KEY",
      CUSTOM_PROVIDER_API_KEY: "dynamic-sentinel",
    };
    const environment = createCiSafeEnvironment(input);
    for (const name of PROVIDER_AND_CREDENTIAL_ENV) assert.equal(environment[name], "");
    assert.equal(environment.CUSTOM_PROVIDER_API_KEY, "");
    for (const name of ["GEMINI_API_KEY", "GITHUB_TOKEN", "PLANE_API_TOKEN"]) {
      assert.equal(environment[name], "");
    }
    assert.equal(environment.CHAT_CODE_WORKBENCH_ENABLED, "0");
    assert.equal(environment.CHAT_MEMORY_ENABLED, "0");
    assert.equal(environment.CHAT_PLANE_CE_REAL_TEST, "0");
  });

  it("refuses every explicit paid or external-write opt-in", () => {
    for (const name of EXTERNAL_OPT_IN_ENV) {
      assert.throws(() => createCiSafeEnvironment({ [name]: "true" }), new RegExp(name, "u"));
    }
  });
});
