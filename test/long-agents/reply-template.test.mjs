import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RESPONSE_TEMPLATE, localDate, renderResponseTemplate } from "../../src/long-agents/reply-template.ts";

const vars = { project: "Chat", agentName: "Nexus", date: "2026-09-11" };

test("default reply template appends the current project", () => {
  assert.equal(DEFAULT_RESPONSE_TEMPLATE, "\n\nproject：{{project}}");
  assert.equal(renderResponseTemplate(undefined, vars), "\n\nproject：Chat");
  assert.equal(renderResponseTemplate("", vars), "", "empty template appends nothing");
});

test("template variables are substituted and unknown text is preserved", () => {
  assert.equal(
    renderResponseTemplate("{{agentName}} @ {{date}} · 项目 {{project}}", vars),
    "\n\nNexus @ 2026-09-11 · 项目 Chat",
  );
  assert.equal(renderResponseTemplate("签名不变", vars), "\n\n签名不变");
  assert.equal(localDate(new Date("2026-09-11T13:00:00Z")).length, 10);
});
