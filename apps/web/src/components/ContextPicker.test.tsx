import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryBackendProfileDto, SubmitMessagePayload } from "@chat/contracts/public";
import { ContextPicker } from "./ContextPicker.js";

const readyMemmy: MemoryBackendProfileDto = {
  schemaVersion: "chat-product-api.v1",
  backendId: "mbk_memmy" as never,
  displayName: "memmy",
  kind: "memmy",
  configured: true,
  health: "ready",
  capabilities: {
    query: true,
    tags: true,
    layers: ["L1", "L2"],
    maxLimit: 10,
    maxContextBudget: 4_096,
  },
};

afterEach(cleanup);

function PickerHarness({ backend = readyMemmy }: { backend?: MemoryBackendProfileDto }) {
  const [value, setValue] = useState<SubmitMessagePayload["context"]>();
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <ContextPicker
        backends={[backend]}
        loading={false}
        disabled={false}
        value={value}
        onChange={setValue}
        expanded={expanded}
        onExpandedChange={setExpanded}
      />
      <output aria-label="选择结果">{JSON.stringify(value)}</output>
    </>
  );
}

describe("ContextPicker", () => {
  it("启用后生成受后端能力约束的可选查询默认值", async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);
    await user.click(screen.getByRole("button", { name: /上下文/ }));
    await user.click(screen.getByRole("checkbox", { name: /使用 Memory 上下文/ }));
    expect(screen.getByLabelText("选择结果").textContent).toContain('"requirement":"optional"');
    expect(screen.getByLabelText("选择结果").textContent).toContain('"layers":["L1","L2"]');
    expect(screen.getByLabelText("选择结果").textContent).toContain('"limit":8');
    expect(screen.getByLabelText("选择结果").textContent).toContain('"contextBudget":1800');
  });

  it("后端未就绪时不允许启用且解释原因", async () => {
    const user = userEvent.setup();
    render(<PickerHarness backend={{ ...readyMemmy, health: "unavailable" }} />);
    await user.click(screen.getByRole("button", { name: /上下文/ }));
    expect(screen.getAllByText("memmy 尚未就绪")).toHaveLength(2);
    expect(
      (screen.getByRole("checkbox", { name: /使用 Memory 上下文/ }) as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
