import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
} from "@chat/domain";
import type { ProductSnapshotV4 } from "./legacy-v4.js";

/**
 * v4→v5只把PS1的简化Method/Stage扩展成语义等价的完整结构。
 * 迁移来源被显式标记，不能伪造用户Decision；新集合保持为空。
 */
export function migrateProductSnapshotV4ToV5(snapshot: ProductSnapshotV4): ProductSnapshot {
  const methods = Object.fromEntries(
    Object.entries(snapshot.entities.projectMethodSnapshots).map(([id, method]) => {
      const policies = compileProjectMethodSnapshotPolicies(method.profileId);
      return [
        id,
        {
          ...method,
          schemaVersion: "project-method-snapshot.v2" as const,
          policies,
          source: "migrated_v1" as const,
          sha256: computeProjectMethodSnapshotSha256({
            profileId: method.profileId,
            rationale: method.rationale,
            policies,
            source: "migrated_v1",
          }),
        },
      ];
    }),
  );
  const projects = Object.fromEntries(
    Object.entries(snapshot.entities.projects).map(([id, project]) => [
      id,
      { ...project, schemaVersion: "project.v2" as const },
    ]),
  );
  const stages = Object.fromEntries(
    Object.entries(snapshot.entities.projectStages).map(([id, stage]) => {
      const project = snapshot.entities.projects[stage.projectId];
      if (project === undefined) throw new Error(`v4 Stage ${id}引用未知Project`);
      const status =
        stage.status === "cancelled"
          ? "skipped"
          : stage.status === "completed"
            ? "completed"
            : "active";
      return [
        id,
        {
          ...stage,
          schemaVersion: "project-stage.v2" as const,
          methodSnapshotId: project.methodSnapshotId,
          key: `stage-${String(stage.sequence)}`,
          successCriteria: project.successCriteria.slice(0, 20),
          status,
          ...(status === "active" || status === "completed" ? { startedAt: stage.createdAt } : {}),
          ...(status === "completed" || status === "skipped"
            ? { completedAt: stage.updatedAt }
            : {}),
          completionEvidenceIds: [],
        },
      ];
    }),
  );
  return productSnapshotSchema.parse({
    schemaVersion: "chat-product-store.v5",
    storeRevision: snapshot.storeRevision,
    committedAt: snapshot.committedAt,
    entities: {
      ...snapshot.entities,
      projects,
      projectMethodSnapshots: methods,
      projectStages: stages,
      projectMilestones: {},
      projectUpdates: {},
      projectStateTransitions: {},
    },
    commandReceipts: snapshot.commandReceipts,
    outbox: snapshot.outbox,
  });
}
