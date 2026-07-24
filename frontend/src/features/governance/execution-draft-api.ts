import { checkedJson } from "../../api-client.js";

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

export const EXECUTION_DRAFT_SECTION_ORDER = [
  "identity_lineage",
  "intent_goal",
  "project_work_binding",
  "background",
  "accepted_decisions",
  "scope",
  "plan",
  "context_binding",
  "resource_manifest",
  "runtime_target",
  "capability_grant",
  "model_envelope",
  "prompt_assembly_plan",
  "hitl_plan",
  "validation_plan",
  "output_commit_contract",
  "stop_escalation",
] as const;

export type ExecutionDraftSectionKey = (typeof EXECUTION_DRAFT_SECTION_ORDER)[number];

export interface ExecutionDraftView {
  id: string;
  session_id?: string;
  interaction_id?: string;
  workflow_definition_id?: string;
  workflow_version?: string;
  status: string;
  row_version: number;
  revision_id: string;
  revision: number;
  revision_status: string;
  draft_hash: string;
  context_hash: string;
  execution_brief: string;
  payload: Record<ExecutionDraftSectionKey, unknown>;
}

async function checkedExecutionDraft(response: Response): Promise<ExecutionDraftView> {
  return checkedJson<ExecutionDraftView>(response, "ExecutionDraft请求失败");
}

export async function getExecutionDraft(draftId: string): Promise<ExecutionDraftView> {
  return checkedExecutionDraft(await fetch(`${API_BASE_URL}/api/execution-drafts/${draftId}`));
}

export async function reviseExecutionDraft(
  draft: ExecutionDraftView,
  executionBrief: string,
  payload: Record<ExecutionDraftSectionKey, unknown>,
): Promise<ExecutionDraftView> {
  return checkedExecutionDraft(
    await fetch(`${API_BASE_URL}/api/execution-drafts/${draft.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision_id: draft.revision_id,
        expected_draft_hash: draft.draft_hash,
        expected_row_version: draft.row_version,
        execution_brief: executionBrief,
        payload,
      }),
    }),
  );
}
