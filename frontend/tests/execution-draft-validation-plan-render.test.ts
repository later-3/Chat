import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The frozen Validation Contract must render read-only: no input/textarea/
// select/add/remove controls inside the frozen section, editable fields stay
// editable, and contract:null shows the explicit no-subject note (P2-7).

async function renderSection(value: unknown): Promise<string> {
  const module = await import("../src/execution-draft-workbench.js");
  return renderToStaticMarkup(
    createElement(module.ValidationPlanSection, { value, onChange: () => {} }),
  );
}

test("frozen contract renders without any editable or add/remove controls", async () => {
  const html = await renderSection({
    checks: ["structured intent"],
    contract: { plan_revision_id: "rev-1", rules: [{ ordinal: 1 }] },
  });
  assert.match(html, /机器冻结的 Validation Contract（只读）/);
  assert.match(html, /回Plan修订/);
  const frozen = html.slice(html.indexOf("execution-draft-frozen-contract"));
  assert.ok(!frozen.includes("<input"), frozen);
  assert.ok(!frozen.includes("<textarea"), frozen);
  assert.ok(!frozen.includes("<select"), frozen);
  assert.ok(!frozen.includes("添加一项"), frozen);
  assert.ok(!frozen.includes("删除"), frozen);
});

test("normal validation_plan fields keep their editable controls", async () => {
  const html = await renderSection({
    checks: ["structured intent"],
    contract: { plan_revision_id: "rev-1" },
  });
  const editable = html.slice(0, html.indexOf("execution-draft-frozen-contract"));
  assert.ok(editable.includes("<input") || editable.includes("<textarea"), editable);
});

test("contract:null shows the explicit no-subject note; absent key shows nothing", async () => {
  const withNull = await renderSection({ checks: ["a"], contract: null });
  assert.match(withNull, /本轮未绑定完成主体/);
  assert.ok(!withNull.includes('execution-draft-frozen-contract"\u003e'));
  const absent = await renderSection({ checks: ["a"] });
  assert.ok(!absent.includes("本轮未绑定完成主体"), absent);
});
