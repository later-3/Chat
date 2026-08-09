import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowCatalogDto } from "@chat/contracts/public";
import { useState } from "react";
import { NodeConfigFieldRenderer, isSupportedDesignerField } from "./NodeConfigFieldRenderer.js";

type Field = WorkflowCatalogDto["nodes"][number]["publicConfigFields"][number];

const fields: readonly Field[] = [
  { type: "boolean", name: "strict", label: "严格模式", defaultValue: true },
  {
    type: "enum_select",
    name: "kind",
    label: "默认类型",
    defaultValue: "general",
    options: ["general", "idea"],
  },
  {
    type: "review_mode",
    name: "reviewMode",
    label: "审核方式",
    defaultValue: "manual",
    options: ["manual", "always_auto"],
  },
  {
    type: "bounded_integer",
    name: "limit",
    label: "最多数量",
    defaultValue: 8,
    minimum: 1,
    maximum: 20,
  },
  {
    type: "short_text",
    name: "prompt",
    label: "补充说明",
    defaultValue: "",
    maximumLength: 80,
  },
  {
    type: "tag_list",
    name: "tags",
    label: "建议标签",
    maxItems: 3,
    maxLabelLength: 20,
  },
  {
    type: "resource_selector",
    name: "resource",
    label: "资源",
    multiple: true,
    required: false,
  },
  {
    type: "rule_selector",
    name: "rule",
    label: "规则",
    multiple: true,
    required: false,
  },
  {
    type: "skill_selector",
    name: "skill",
    label: "Skill",
    multiple: false,
    required: false,
  },
  {
    type: "note_source_selector",
    name: "source",
    label: "笔记来源",
    multiple: false,
    required: true,
  },
];

function Harness() {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return (
    <>
      {fields.map((field) => (
        <NodeConfigFieldRenderer
          key={field.name}
          field={field}
          value={values[field.name]}
          disabled={false}
          inputId={`field-${field.name}`}
          onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
        />
      ))}
      <output aria-label="字段值">{JSON.stringify(values)}</output>
    </>
  );
}

afterEach(cleanup);

describe("NodeConfigFieldRenderer", () => {
  it("穷尽渲染当前公开字段且只产生有限表单值", async () => {
    expect(fields.every(isSupportedDesignerField)).toBe(true);
    expect(isSupportedDesignerField({ type: "arbitrary_json" })).toBe(false);
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("严格模式"));
    await user.selectOptions(screen.getByLabelText("默认类型"), "idea");
    await user.selectOptions(screen.getByLabelText("审核方式"), "always_auto");
    const limitInput = screen.getByRole("spinbutton", { name: /最多数量/u });
    await user.clear(limitInput);
    await user.type(limitInput, "12");
    await user.type(screen.getByLabelText("补充说明"), "只保留证据");
    await user.type(screen.getByLabelText("建议标签"), "alpha,beta");

    const value = screen.getByLabelText("字段值").textContent ?? "";
    expect(value).toContain('"strict":false');
    expect(value).toContain('"kind":"idea"');
    expect(value).toContain('"reviewMode":"always_auto"');
    expect(value).toContain('"limit":12');
    expect(value).toContain('"tags":["alpha","beta"]');
    expect(screen.getByText(/资源在发起 Run 时/u)).toBeTruthy();
    expect(screen.getByText(/笔记来源在发起 Run 时/u)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /JSON/u })).toBeNull();
  });
});
