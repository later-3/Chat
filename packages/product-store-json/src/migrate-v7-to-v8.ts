import {
  createSystemNoteDefinition,
  SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
  SYSTEM_NOTE_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import type { ProductSnapshotV7 } from "./legacy-v7.js";
import { productSnapshotV8Schema, type ProductSnapshotV8 } from "./legacy-v8.js";

/**
 * v7→v8只引入Note正式产品集合，不从历史Message、Assistant回复或Trace推断笔记。
 * 这是故意的失败关闭：模型候选必须经过Note Decision后才可成为Note Revision。
 */
export function migrateProductSnapshotV7ToV8(snapshot: ProductSnapshotV7): ProductSnapshotV8 {
  const noteSeed = createSystemNoteDefinition(snapshot.committedAt);
  assertNoConflictingSeed(
    snapshot.entities.workflowDefinitions[SYSTEM_NOTE_WORKFLOW_DEFINITION_ID],
    noteSeed.definition,
    "system Note Definition",
  );
  assertNoConflictingSeed(
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID],
    noteSeed.revision,
    "system Note Revision",
  );
  assertNoConflictingSeed(
    snapshot.entities.workflowViewDefinitions[SYSTEM_NOTE_WORKFLOW_VIEW_ID],
    noteSeed.view,
    "system Note View",
  );
  return productSnapshotV8Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v8",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: {
        ...snapshot.entities.workflowDefinitions,
        [SYSTEM_NOTE_WORKFLOW_DEFINITION_ID]: noteSeed.definition,
      },
      workflowDefinitionRevisions: {
        ...snapshot.entities.workflowDefinitionRevisions,
        [SYSTEM_NOTE_WORKFLOW_REVISION_ID]: noteSeed.revision,
      },
      workflowViewDefinitions: {
        ...snapshot.entities.workflowViewDefinitions,
        [SYSTEM_NOTE_WORKFLOW_VIEW_ID]: noteSeed.view,
      },
      notes: {},
      noteRevisions: {},
      noteCandidates: {},
      noteDecisions: {},
    },
  });
}

function assertNoConflictingSeed(existing: unknown, expected: unknown, label: string): void {
  if (existing === undefined) return;
  if (JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error(`${label}固定ID已被异语义对象占用`);
  }
}
