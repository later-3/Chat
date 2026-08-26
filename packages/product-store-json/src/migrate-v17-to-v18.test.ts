import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_AGENT_VERSION_SCHEMA_VERSION,
  agentVersionHashInputSchema,
  agentVersionSchema,
  createEmptySnapshot,
  type AgentVersion,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV17Schema } from "./legacy-v17.js";
import { migrateProductSnapshotV17ToV18 } from "./migrate-v17-to-v18.js";
import { migrateProductSnapshotV18ToV19 } from "./migrate-v18-to-v19.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";
import { migrateProductSnapshotV21ToV22 } from "./migrate-v21-to-v22.js";
import { migrateProductSnapshotV22ToV23 } from "./migrate-v22-to-v23.js";
import { migrateProductSnapshotV23ToV24 } from "./migrate-v23-to-v24.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const NOW = "2026-08-22T08:00:00.000Z";

const migrateProductSnapshotV20ToCurrent = (
  snapshot: Parameters<typeof migrateProductSnapshotV20ToV21>[0],
) =>
  migrateProductSnapshotV23ToV24(
    migrateProductSnapshotV22ToV23(
      migrateProductSnapshotV21ToV22(migrateProductSnapshotV20ToV21(snapshot)),
    ),
  );

async function seededV17() {
  const directory = await mkdtemp(join(tmpdir(), "chat-agent-v17-seed-"));
  const store = await JsonProductStore.open({
    filePath: join(directory, "product-store.json"),
    now: () => NOW,
  });
  const { snapshot } = await store.read({ kind: "committedSnapshot" });
  const entities = structuredClone(snapshot.entities) as Record<string, unknown>;
  delete entities["agentVersions"];
  delete entities["projectWorkBlocks"];
  delete entities["projectWorkClaims"];
  delete entities["projectWorkHandoffs"];
  delete entities["projectPracticeRevisions"];
  delete entities["projectWorkOutcomes"];
  delete entities["projectContextMaps"];
  delete entities["projectProviderBindings"];
  delete entities["projectProviderProjections"];
  delete entities["projectCoordinationOperations"];
  delete entities["projectInboundChanges"];
  delete entities["toolExecutionIntents"];
  delete entities["toolExecutionDecisions"];
  delete entities["toolExecutionResults"];
  delete entities["projectProfileRevisions"];
  delete entities["projectConfigurationRevisions"];
  delete entities["projectEvents"];
  delete entities["projectNeeds"];
  delete entities["projectRequirements"];
  delete entities["projectArtifactRefs"];
  delete entities["projectMetricObservations"];
  for (const key of [
    "supervisedPlanningEpochs",
    "supervisedCarryForwards",
    "supervisedStepStates",
    "supervisedAgentAttempts",
    "supervisedStepEvidence",
    "supervisedStepCandidates",
    "supervisedPlannerVerdicts",
    "supervisedStepReviewRequests",
    "supervisedStepHumanDecisions",
    "supervisedAgentOutcomeObservations",
    "supervisedExecutionResults",
  ]) {
    delete entities[key];
  }
  return productSnapshotV17Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v17",
    entities,
  });
}

function agentVersion(input: {
  readonly id: string;
  readonly version: number;
  readonly basedOnVersionId?: string | undefined;
  readonly systemPromptBody?: string | undefined;
}): AgentVersion {
  const body = agentVersionHashInputSchema.parse({
    schemaVersion: LEGACY_AGENT_VERSION_SCHEMA_VERSION,
    agentVersionId: input.id,
    agentKey: "direct",
    ownerPrincipalId: "usr_agentstore1",
    scope: { kind: "global" },
    version: input.version,
    title: `Pi Coding Agent v${String(input.version)}`,
    description: "Agent Version Store合同测试。",
    runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
    baselineRef: {
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.84.2",
      managedSource: "later-3/pi@codex/later-custom",
      managedSourceRevision: "1".repeat(40),
      variantKey: "pi_cli_default",
      capabilityCatalogSha256: "2".repeat(64),
    },
    systemPrompt:
      input.systemPromptBody === undefined
        ? { mode: "inherit_runtime" }
        : {
            mode: "replace",
            bodyMarkdown: input.systemPromptBody,
            sha256: hashCanonical("agent-system-prompt.v1", {
              bodyMarkdown: input.systemPromptBody,
            }),
          },
    enabledToolNames: ["read", "bash", "edit", "write"],
    resources: {
      contextFiles: "inherit_runtime_default",
      skills: "inherit_runtime_default",
      promptTemplates: "inherit_runtime_default",
      extensions: "inherit_runtime_default",
    },
    ...(input.basedOnVersionId === undefined ? {} : { basedOnVersionId: input.basedOnVersionId }),
    createdAt: NOW,
  });
  return agentVersionSchema.parse({
    ...body,
    sha256: hashCanonical("agent-version.v1", body),
  });
}

describe("Product Store v17到v18 Agent Version迁移", () => {
  it("无损保留v17事实并只补空Agent Version集合", async () => {
    const legacy = await seededV17();
    const migrated = migrateProductSnapshotV17ToV18(legacy);
    expect(migrated.schemaVersion).toBe("chat-product-store.v18");
    expect(migrated.entities.agentVersions).toEqual({});
    expect(migrated.storeRevision).toBe(legacy.storeRevision);
    const { agentVersions: _agentVersions, ...migratedEntities } = migrated.entities;
    void _agentVersions;
    expect(migratedEntities).toEqual(legacy.entities);
    expect(() =>
      assertSnapshotIntegrity(
        migrateProductSnapshotV20ToCurrent(
          migrateProductSnapshotV19ToV20(migrateProductSnapshotV18ToV19(migrated)),
        ),
      ),
    ).not.toThrow();
  });

  it("首次原子迁移后重启不再改写", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-agent-v17-open-"));
    const filePath = join(directory, "product-store.json");
    await writeFile(filePath, JSON.stringify(await seededV17(), null, 2));
    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("迁移在atomic rename前失败时保留v17原字节", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-agent-v17-rename-"));
    const filePath = join(directory, "product-store.json");
    const before = JSON.stringify(await seededV17(), null, 2);
    await writeFile(filePath, before);
    await expect(
      JsonProductStore.open({
        filePath,
        now: () => NOW,
        io: { renameTempFile: async () => Promise.reject(new Error("rename failed")) },
      }),
    ).rejects.toThrow("Product Store提交在atomic rename前失败");
    expect(await readFile(filePath, "utf8")).toBe(before);
  });

  it("校验派生引用、版本Hash并禁止覆盖或删除既有Version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-agent-version-immutable-"));
    const store = await JsonProductStore.open({
      filePath: join(directory, "product-store.json"),
      now: () => NOW,
    });
    const first = agentVersion({ id: "avn_storebase1", version: 1 });
    await store.transact({
      commandId: "cmd_agentversionappend1" as never,
      commandType: "CreateAgentVersion",
      requestSha256: "1".repeat(64),
      mutate: (draft) => {
        draft.entities.agentVersions[first.agentVersionId] = first;
        return { resultRefs: { agentVersionId: first.agentVersionId } };
      },
    });

    const second = agentVersion({
      id: "avn_storederived2",
      version: 2,
      basedOnVersionId: first.agentVersionId,
    });
    await store.transact({
      commandId: "cmd_agentversionappend2" as never,
      commandType: "CreateAgentVersion",
      requestSha256: "2".repeat(64),
      mutate: (draft) => {
        draft.entities.agentVersions[second.agentVersionId] = second;
        return { resultRefs: { agentVersionId: second.agentVersionId } };
      },
    });
    const committed = (await store.read({ kind: "committedSnapshot" })).snapshot;
    expect(() => assertSnapshotIntegrity(committed)).not.toThrow();

    const duplicateVersionNumber = structuredClone(committed);
    const duplicate = agentVersion({ id: "avn_storeduplicate1", version: 1 });
    duplicateVersionNumber.entities.agentVersions[duplicate.agentVersionId] = duplicate;
    expect(() => assertSnapshotIntegrity(duplicateVersionNumber)).toThrow("重复占用");

    await expect(
      store.transact({
        commandId: "cmd_agentversionoverwrite1" as never,
        commandType: "OverwriteAgentVersion",
        requestSha256: "3".repeat(64),
        mutate: (draft) => {
          draft.entities.agentVersions[first.agentVersionId] = {
            ...first,
            title: "被非法覆盖",
          };
          return { resultRefs: {} };
        },
      }),
    ).rejects.toThrow("Agent Version是不可变事实");

    await expect(
      store.transact({
        commandId: "cmd_agentversiondelete1" as never,
        commandType: "DeleteAgentVersion",
        requestSha256: "4".repeat(64),
        mutate: (draft) => {
          delete draft.entities.agentVersions[first.agentVersionId];
          return { resultRefs: {} };
        },
      }),
    ).rejects.toThrow("Agent Version是不可变事实");

    const broken = createEmptySnapshot(NOW);
    broken.entities.agentVersions[second.agentVersionId] = second;
    expect(() => assertSnapshotIntegrity(broken)).toThrow("派生来源不存在");
  });

  it("replace System Prompt正文和外层Version Hash都必须逐层一致", async () => {
    const version = agentVersion({
      id: "avn_replacesystem1",
      version: 1,
      systemPromptBody: "你是可配置的 Pi Coding Agent。",
    });
    const valid = migrateProductSnapshotV20ToCurrent(
      migrateProductSnapshotV19ToV20(
        migrateProductSnapshotV18ToV19(migrateProductSnapshotV17ToV18(await seededV17())),
      ),
    );
    valid.entities.agentVersions[version.agentVersionId] = version;
    expect(() => assertSnapshotIntegrity(valid)).not.toThrow();

    const promptBroken = structuredClone(valid);
    const prompt = promptBroken.entities.agentVersions[version.agentVersionId]!.systemPrompt;
    if (prompt.mode !== "replace") throw new Error("fixture必须是replace System Prompt");
    prompt.sha256 = "0".repeat(64) as never;
    expect(() => assertSnapshotIntegrity(promptBroken)).toThrow("System Prompt Hash不一致");

    const outerBroken = structuredClone(valid);
    outerBroken.entities.agentVersions[version.agentVersionId]!.sha256 = "0".repeat(64) as never;
    expect(() => assertSnapshotIntegrity(outerBroken)).toThrow("Hash不一致");
  });
});
