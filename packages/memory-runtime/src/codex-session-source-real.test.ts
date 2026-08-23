import { convertMemorySessionToItems } from "@chat/domain";
import { expect, it } from "vitest";
import { CodexSessionSourceAdapter } from "./codex-session-source-adapter.js";

const realTest = process.env["CHAT_REAL_CODEX_SESSION_SOURCE"] === "1" ? it : it.skip;

realTest(
  "读取真实Codex Session并完成确定性转换",
  async () => {
    const codexHome = process.env["CODEX_HOME"];
    expect(codexHome, "真实门要求显式提供CODEX_HOME").toBeTruthy();
    const adapter = new CodexSessionSourceAdapter({ codexHome: codexHome! });
    const sources = await adapter.list({ limit: 50 });
    expect(sources.length).toBeGreaterThan(0);

    let sampledMessages = 0;
    let sampledItems = 0;
    for (const source of [...sources].reverse()) {
      const snapshot = await adapter.load(source.sourceSessionId);
      if (snapshot === undefined || snapshot.messages.length === 0) continue;
      const items = convertMemorySessionToItems({
        snapshot,
        maxContentCharacters: 50_000,
      });
      if (items.length === 0) continue;
      sampledMessages = snapshot.messages.length;
      sampledItems = items.length;
      break;
    }

    expect(sampledMessages).toBeGreaterThan(0);
    expect(sampledItems).toBeGreaterThan(0);
    // 真实门只输出数量，不泄露Session标题、正文、ID或Hash。
    console.info(
      JSON.stringify({ discoveredSessions: sources.length, sampledMessages, sampledItems }),
    );
  },
  30_000,
);
