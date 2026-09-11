import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLongAgentHandoff,
  listLongAgentSummaries,
  readLongAgentSummary,
  searchLongAgentSummaries,
  writeLongAgentSummary,
} from "../../src/long-agents/summaries.ts";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-summaries-"));
  const chatHome = path.join(base, ".chat");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { chatHome };
}

test("summary write/read/list/search keep the JSON fact and a readable Markdown copy", async (t) => {
  const { chatHome } = fixture(t);
  await writeLongAgentSummary({
    chatHome, longAgentId: "nexus", date: "2026-09-09",
    did: ["完成了 A"], reflections: ["B 做得不好，下次提前评审"], handoff: "明天先做 C",
  });
  await writeLongAgentSummary({
    chatHome, longAgentId: "nexus", date: "2026-09-10",
    did: ["推进了 D"], reflections: [], handoff: "D 还差验证",
  });

  const read = await readLongAgentSummary(chatHome, "nexus", "2026-09-10");
  assert.equal(read?.did[0], "推进了 D");
  assert.equal((await readLongAgentSummary(chatHome, "nexus", "2026-09-01")), undefined);

  const md = fs.readFileSync(path.join(chatHome, "long-agents", "nexus", "summaries", "2026-09-09.md"), "utf8");
  assert.match(md, /## 做了什么/);
  assert.match(md, /B 做得不好/);

  const listed = await listLongAgentSummaries({ chatHome, longAgentId: "nexus" });
  assert.deepEqual(listed.map((item) => item.date), ["2026-09-10", "2026-09-09"]);

  assert.deepEqual((await searchLongAgentSummaries({ chatHome, longAgentId: "nexus", query: "提前评审" })).map((s) => s.date), ["2026-09-09"]);
  assert.deepEqual((await searchLongAgentSummaries({ chatHome, longAgentId: "nexus", query: "" })).map((s) => s.date), ["2026-09-10", "2026-09-09"]);
});

test("handoff injects the previous days' summaries for the new day and excludes today", async (t) => {
  const { chatHome } = fixture(t);
  for (const date of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"]) {
    await writeLongAgentSummary({ chatHome, longAgentId: "nexus", date, did: [`${date} 的工作`], handoff: `${date} 交接` });
  }
  const handoff = await buildLongAgentHandoff({ chatHome, longAgentId: "nexus", today: "2026-09-10", days: 3 });
  assert.ok(handoff);
  assert.match(handoff, /<recent_daily_summaries days="3">/);
  assert.match(handoff, /2026-09-09 的工作/);
  assert.match(handoff, /2026-09-07 的工作/);
  assert.equal(handoff.includes("2026-09-10 的工作"), false, "today's own summary must not be injected as history");

  // 没有任何历史 → 不注入
  assert.equal(await buildLongAgentHandoff({ chatHome, longAgentId: "ghost", today: "2026-09-10" }), null);
});
