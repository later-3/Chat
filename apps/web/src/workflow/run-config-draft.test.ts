import { describe, expect, it } from "vitest";
import {
  clearWorkflowConfigDraft,
  readWorkflowConfigDraft,
  workflowConfigDraftStorageKey,
  writeWorkflowConfigDraft,
} from "./run-config-draft.js";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const selection = {
  kind: "published_revision" as const,
  workflowDefinitionRevisionId: "wfr_example1" as never,
  definitionSha256: "a".repeat(64) as never,
  runConfiguration: {
    schemaVersion: "workflow-run-configuration.v1" as const,
    overrides: [
      { kind: "node_enabled" as const, definitionNodeId: "memory", enabled: false },
      { kind: "review_mode" as const, definitionNodeId: "review", reviewMode: "manual" as const },
    ],
  },
};

describe("Workflow配置草稿", () => {
  it("按Session隔离并只恢复公开有限选择", () => {
    const local = storage();
    writeWorkflowConfigDraft(local, "psn_a", selection);
    expect(workflowConfigDraftStorageKey("psn_a")).toBe("chat:workflow-config-draft:v1:psn_a");
    expect(readWorkflowConfigDraft(local, "psn_a")).toEqual(selection);
    expect(readWorkflowConfigDraft(local, "psn_b")).toBeNull();
  });

  it("未知字段或secret形态草稿安全失效", () => {
    const local = storage();
    local.setItem(
      workflowConfigDraftStorageKey("psn_a"),
      JSON.stringify({
        version: 1,
        workflowSelection: { ...selection, runtimeSecret: "forbidden" },
      }),
    );
    expect(readWorkflowConfigDraft(local, "psn_a")).toBeNull();
  });

  it("清理只影响当前Session", () => {
    const local = storage();
    writeWorkflowConfigDraft(local, "psn_a", selection);
    writeWorkflowConfigDraft(local, "psn_b", selection);
    clearWorkflowConfigDraft(local, "psn_a");
    expect(readWorkflowConfigDraft(local, "psn_a")).toBeNull();
    expect(readWorkflowConfigDraft(local, "psn_b")).toEqual(selection);
  });

  it("Note业务输入随Session草稿恢复且仍受公开strict合同约束", () => {
    const local = storage();
    const noteSelection = {
      ...selection,
      workflowDefinitionRevisionId: "wfr_note1" as never,
      businessInput: {
        kind: "note_capture" as const,
        source: { kind: "full_message" as const },
        defaultKind: "project_idea" as const,
        suggestedTagLabels: ["项目", "路线"],
      },
    };
    writeWorkflowConfigDraft(local, "psn_note", noteSelection);
    expect(readWorkflowConfigDraft(local, "psn_note")).toEqual(noteSelection);
  });
});
