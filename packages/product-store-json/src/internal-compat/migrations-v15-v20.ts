import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
  createSystemDirectAgentDefinition,
} from "@chat/application/workflow-system-definitions";
import { migrateProductSnapshotV19ToV20 as migratePublishedProductSnapshotV19ToV20 } from "../migrate-v19-to-v20.js";
import type { ProductSnapshotV20 } from "../legacy-v20.js";
import { type ProductSnapshotV15 } from "./legacy-v15-reader.js";
import {
  productSnapshotV16MainSchema,
  type ProductSnapshotV16,
  type ProductSnapshotV16Main,
} from "./legacy-v16-reader.js";
import { productSnapshotV17Schema, type ProductSnapshotV17 } from "./legacy-v17-reader.js";
import { productSnapshotV18Schema, type ProductSnapshotV18 } from "./legacy-v18-reader.js";
import { productSnapshotV19Schema, type ProductSnapshotV19 } from "./legacy-v19-base.js";

export function migrateProductSnapshotV15ToV16(
  snapshot: ProductSnapshotV15,
): ProductSnapshotV16Main {
  return productSnapshotV16MainSchema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v16",
  });
}

export function migrateProductSnapshotV16ToV17(snapshot: ProductSnapshotV16): ProductSnapshotV17 {
  return productSnapshotV17Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v17",
    entities: snapshot.entities,
  });
}

export function migrateProductSnapshotV17ToV18(snapshot: ProductSnapshotV17): ProductSnapshotV18 {
  const definitions = { ...snapshot.entities.workflowDefinitions };
  const revisions = { ...snapshot.entities.workflowDefinitionRevisions };
  const views = { ...snapshot.entities.workflowViewDefinitions };
  const prior = definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID];
  const seed = createSystemDirectAgentDefinition(prior?.createdAt ?? snapshot.committedAt);
  for (const [label, current, expected] of [
    ["Revision", revisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID], seed.revision],
    ["View", views[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID], seed.view],
  ] as const) {
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(`v18系统Direct Agent ${label}固定ID已被异语义对象占用`);
    }
  }
  definitions[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID] = {
    ...seed.definition,
    createdAt: prior?.createdAt ?? seed.definition.createdAt,
  };
  revisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID] = seed.revision;
  views[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID] = seed.view;
  return productSnapshotV18Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v18",
    entities: {
      ...snapshot.entities,
      workflowDefinitions: definitions,
      workflowDefinitionRevisions: revisions,
      workflowViewDefinitions: views,
      agentVersions: {},
    },
  });
}

export function migrateProductSnapshotV18ToV19(snapshot: ProductSnapshotV18): ProductSnapshotV19 {
  return productSnapshotV19Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v19",
  });
}

export function migrateProductSnapshotV19ToV20(snapshot: ProductSnapshotV19): ProductSnapshotV20 {
  const migrated = migratePublishedProductSnapshotV19ToV20(snapshot as never);
  if (migrated.schemaVersion !== "chat-product-store.v20") {
    throw new Error("v19→v20迁移没有产生已发布目标代际");
  }
  return migrated;
}
