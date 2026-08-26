import type { ProductSnapshotV20 } from "./legacy-v20.js";
import { productSnapshotV21Schema, type ProductSnapshotV21 } from "./legacy-v21.js";

/**
 * v21只升级Chat本地Provider Binding合同并增加Operation/Inbound集合。
 * 旧Binding缺少projectKey、Agent与P3静态映射，迁移后必须needs_attention；
 * 迁移绝不访问Plane、创建投影或猜测Content Lab业务事实。
 */
export function migrateProductSnapshotV20ToV21(snapshot: ProductSnapshotV20): ProductSnapshotV21 {
  const projectProviderBindings = Object.fromEntries(
    Object.entries(snapshot.entities.projectProviderBindings).map(([id, binding]) => {
      const roots = Object.values(snapshot.entities.projectResources).filter(
        (resource) => resource.projectId === binding.projectId,
      );
      const reconciledRoot =
        binding.reconciledWorkspaceBindingId === undefined
          ? undefined
          : snapshot.entities.projectWorkspaceBindings[binding.reconciledWorkspaceBindingId]
              ?.workspaceRootId;
      const workspaceRootId =
        roots.length === 1
          ? roots[0]!.rootId
          : roots.find((root) => root.rootId === reconciledRoot)?.rootId;
      const migrated = {
        ...binding,
        schemaVersion: "project-provider-binding.v2" as const,
        projectKey: `legacy-${binding.projectProviderBindingId.slice(4, 20).toLowerCase()}`,
        ...(workspaceRootId === undefined ? {} : { workspaceRootId }),
        humanActorExternalIds: [],
        stateMappings: [],
        moduleMappings: [],
        labelMappings: [],
        status:
          binding.status === "archived" ? ("archived" as const) : ("needs_attention" as const),
        revision: binding.revision + 1,
      };
      return [id, migrated];
    }),
  );

  const projectProviderProjections = Object.fromEntries(
    Object.entries(snapshot.entities.projectProviderProjections).map(([id, projection]) => [
      id,
      {
        ...projection,
        schemaVersion: "project-provider-projection.v2" as const,
        syncStatus: "needs_attention" as const,
        revision: projection.revision + 1,
      },
    ]),
  );

  return productSnapshotV21Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v21",
    entities: {
      ...snapshot.entities,
      projectProviderBindings,
      projectProviderProjections,
      projectCoordinationOperations: {},
      projectInboundChanges: {},
    },
  });
}
