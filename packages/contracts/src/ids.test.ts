import { describe, expect, it } from "vitest";
import {
  approvalRequestIdSchema,
  commandIdSchema,
  messageIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  runAttemptIdSchema,
  workflowDefinitionIdSchema,
} from "./ids.js";
import { WORKFLOW_DEFINITION_ID } from "./versions.js";

describe("id contracts", () => {
  it("接受带正确前缀的ID", () => {
    expect(productSessionIdSchema.parse("psn_01ABC")).toBe("psn_01ABC");
    expect(productRunIdSchema.parse("run_x9")).toBe("run_x9");
    expect(messageIdSchema.parse("msg_1")).toBe("msg_1");
    expect(commandIdSchema.parse("cmd_abc123")).toBe("cmd_abc123");
    expect(runAttemptIdSchema.parse("att_9")).toBe("att_9");
    expect(approvalRequestIdSchema.parse("apr_7")).toBe("apr_7");
    expect(workflowDefinitionIdSchema.parse(WORKFLOW_DEFINITION_ID)).toBe(WORKFLOW_DEFINITION_ID);
  });

  it("拒绝错误前缀、空串和非法字符", () => {
    expect(() => productSessionIdSchema.parse("run_01ABC")).toThrow();
    expect(() => productRunIdSchema.parse("")).toThrow();
    expect(() => messageIdSchema.parse("msg_含中文")).toThrow();
    expect(() => commandIdSchema.parse("cmd_")).toThrow();
  });
});
