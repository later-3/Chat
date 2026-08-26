import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
  hashCanonical,
} from "@chat/domain";
import type { ProductSnapshotV19 } from "./legacy-v19.js";
import { productSnapshotV20Schema, type ProductSnapshotV20 } from "./legacy-v20.js";

/**
 * v20把Project内核演进到内容生产合同。迁移只转换既有本地事实和增加空集合：
 * 不创建Content Work、Provider Binding、Plane对象、Claim、Outcome或外部副作用。
 */
export function migrateProductSnapshotV19ToV20(snapshot: ProductSnapshotV19): ProductSnapshotV20 {
  const projectMethodSnapshots = Object.fromEntries(
    Object.entries(snapshot.entities.projectMethodSnapshots).map(([id, method]) => {
      const policies = compileProjectMethodSnapshotPolicies(method.profileId);
      const migrated = {
        ...method,
        schemaVersion: "project-method-snapshot.v3" as const,
        policies,
        sha256: computeProjectMethodSnapshotSha256({
          profileId: method.profileId,
          rationale: method.rationale,
          policies,
          source: method.source,
        }),
        revision: method.revision + 1,
      };
      return [id, migrated];
    }),
  );

  const projectWorks = Object.fromEntries(
    Object.entries(snapshot.entities.projectWorks).map(([id, work]) => [
      id,
      {
        ...work,
        schemaVersion: "project-work.v2" as const,
        workKey: `legacy:${work.projectWorkId}`,
        kind: "generic" as const,
        practiceRevisionIds: [],
        resourceRefs: [],
        revision: work.revision + 1,
      },
    ]),
  );

  const projectEvidence = Object.fromEntries(
    Object.entries(snapshot.entities.projectEvidence).map(([id, evidence]) => {
      const { kind, ...rest } = evidence;
      return [
        id,
        {
          ...rest,
          schemaVersion: "project-evidence.v2" as const,
          role: kind,
          verification:
            evidence.resourceId === undefined ? ("reported" as const) : ("observed" as const),
          sourceKind:
            evidence.resourceId !== undefined
              ? ("project_resource" as const)
              : kind === "commit" || kind === "pull_request" || kind === "test"
                ? ("git" as const)
                : kind === "trace"
                  ? ("runtime" as const)
                  : ("runtime" as const),
          revision: evidence.revision + 1,
        },
      ];
    }),
  );

  const projectDecisions = Object.fromEntries(
    Object.entries(snapshot.entities.projectDecisions).map(([id, decision]) => {
      const payloadSha256 = hashCanonical("project-decision-payload.v1", {
        projectId: decision.projectId,
        boundProjectRevision: decision.boundProjectRevision,
        question: decision.question,
        options: decision.options,
        choice: decision.choice,
        rationale: decision.rationale,
      });
      return [
        id,
        {
          ...decision,
          schemaVersion: "project-decision.v2" as const,
          payloadSha256,
          revision: decision.revision + 1,
        },
      ];
    }),
  );

  return productSnapshotV20Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v20",
    entities: {
      ...snapshot.entities,
      projectMethodSnapshots,
      projectWorks,
      projectEvidence,
      projectDecisions,
      projectWorkBlocks: {},
      projectWorkClaims: {},
      projectWorkHandoffs: {},
      projectPracticeRevisions: {},
      projectWorkOutcomes: {},
      projectContextMaps: {},
      projectProviderBindings: {},
      projectProviderProjections: {},
    },
  });
}
