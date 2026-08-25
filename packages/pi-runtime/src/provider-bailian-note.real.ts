import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL } from "@chat/contracts";
import { isBailianReady, loadBailianConfig } from "./config.js";
import { NOTE_CAPTURE_TOKEN_BUDGET, runPiNoteCapture } from "./note-capture.js";
import { assertRealTestChildAuthorization } from "../../../scripts/ci/real-test-child-guard.mjs";

assertRealTestChildAuthorization({
  mode: "paid",
  commandName: "test:paid:provider:bailian:note",
  credentials: ["DASHSCOPE_API_KEY"],
});

/**
 * S5 Note真实Provider最小门：只进行一次百炼请求，只保存调用计数、usage与脱敏请求证据；
 * 来源、Prompt、工具参数、Candidate正文和Key均不得进入证据文件或控制台。
 */
const config = loadBailianConfig(process.env);
const repoRoot =
  process.env.CHAT_REPO_ROOT ?? resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function writeEvidence(call: Record<string, unknown>): void {
  const directory = resolve(repoRoot, ".data/provider-evidence");
  mkdirSync(directory, { recursive: true });
  const file = resolve(directory, `bailian-note-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        provider: "bailian",
        model: PROVIDER_MODEL,
        endpointHost: config.endpointHost,
        recordedAt: new Date().toISOString(),
        call,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`[provider-evidence] ${file}`);
}

describe("Note Capture真实百炼单调用门（付费，显式运行）", () => {
  it("缺少DASHSCOPE_API_KEY时明确失败且不Skip", () => {
    if (!isBailianReady(config)) {
      throw new Error(
        "缺少DASHSCOPE_API_KEY：请配置后重跑 CHAT_ALLOW_PAID_TESTS=1 pnpm test:paid:provider:bailian:note（本测试不Skip）",
      );
    }
  });

  it("单工具、单Provider请求产生合法Note Candidate且不保存正文", async () => {
    if (!isBailianReady(config)) throw new Error("缺少DASHSCOPE_API_KEY");
    const result = await runPiNoteCapture({
      config,
      captureInput: {
        sourceText: "候选经人工确认后才能成为正式Note。",
        defaultKind: "learning",
        suggestedTagLabels: ["Workflow"],
      },
    });
    const call = {
      node: "note_capture",
      kind: result.kind,
      candidateSchemaValid: result.kind === "candidate",
      ...(result.kind !== "candidate" ? { errorCode: result.errorCode } : {}),
      durationMs: result.durationMs,
      httpStatus: result.providerMeta.httpStatus,
      providerRequestId: result.providerMeta.providerRequestId,
      providerStopReason: result.providerMeta.providerStopReason,
      toolCallCount: result.providerMeta.toolCallCount,
      providerCallCount: result.providerCallCount,
      usage: result.usage,
      tokenBudget: NOTE_CAPTURE_TOKEN_BUDGET,
    };
    writeEvidence(call);
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.title.length).toBeGreaterThan(0);
      expect(result.candidate.contentMarkdown.length).toBeGreaterThan(0);
      expect(result.providerCallCount).toBe(1);
      expect(result.providerMeta.toolCallCount).toBe(1);
      expect(result.providerMeta.httpStatus).toBeGreaterThanOrEqual(200);
      expect(result.providerMeta.httpStatus).toBeLessThan(300);
      expect(result.providerMeta.providerRequestId).toMatch(/^[A-Za-z0-9-]{1,128}$/u);
      if (result.usage === undefined) throw new Error("Note Capture响应缺少真实usage");
      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    }
    expect(result.providerCallCount).toBe(1);
    console.log("[provider-evidence] Note Capture真实调用次数: 1（无自动重试）");
  }, 180_000);
});
