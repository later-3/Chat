import { beforeEach, describe, expect, it } from "vitest";
import { pendingSendPayload, readPendingSend, writePendingSend } from "./real-storage.js";

const sessionId = "psn_storage";

beforeEach(() => window.localStorage.clear());

describe("PendingSend版本恢复", () => {
  it("读取v1记录时恢复为无上下文的原Message payload", () => {
    window.localStorage.setItem(
      `chat:pending-send:v1:${sessionId}`,
      JSON.stringify({ version: 1, text: "旧发送", commandId: "cmd_legacy" }),
    );
    const pending = readPendingSend(window.localStorage, sessionId);
    expect(pending).not.toBeNull();
    expect(pendingSendPayload(pending!)).toEqual({ text: "旧发送" });
  });

  it("v2逐字冻结包含Memory选择的完整payload", () => {
    writePendingSend(window.localStorage, sessionId, {
      version: 2,
      commandId: "cmd_context" as never,
      payload: {
        text: "带上下文发送",
        context: {
          memory: {
            backendId: "mbk_memmy" as never,
            requirement: "required",
            tags: ["项目", "决策"],
            layers: ["L1", "L2"],
            limit: 8,
            contextBudget: 1_800,
          },
        },
      },
    });
    const pending = readPendingSend(window.localStorage, sessionId);
    expect(pending?.version).toBe(2);
    expect(pendingSendPayload(pending!).context?.memory).toMatchObject({
      requirement: "required",
      tags: ["项目", "决策"],
      layers: ["L1", "L2"],
      limit: 8,
      contextBudget: 1_800,
    });
  });
});
