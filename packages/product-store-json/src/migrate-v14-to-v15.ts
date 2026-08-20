import {
  DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  DIRECT_AGENT_TOKEN_BUDGET,
  LEGACY_DIRECT_PROMPT_COMPILER_VERSION,
  LEGACY_DIRECT_PROMPT_PROFILE_VERSION,
  PROMPT_ASSEMBLY_SCHEMA_VERSION,
  promptAssemblyIdSchema,
  type PromptAssembly,
  type PromptAssemblyV1,
} from "@chat/contracts";
import {
  computeDirectAgentInputManifestSha256,
  computePromptAssemblySha256,
  hashCanonical,
} from "@chat/domain";
import type { ProductSnapshotV14 } from "./legacy-v14.js";
import { productSnapshotV15Schema, type ProductSnapshotV15 } from "./legacy-v15.js";

/**
 * v14→v15为已有用户Prompt补全global scope，并增加一次发送的Prompt Assembly表。
 * 历史Direct Run以legacy-v0快照准确表达“当时没有Chat自定义区域组装”，同时只重算
 * Direct Attempt的输入Manifest Hash以纳入该新快照；其他状态、版本和时间证据不变。
 */
export function migrateProductSnapshotV14ToV15(snapshot: ProductSnapshotV14): ProductSnapshotV15 {
  const promptAssemblies = Object.fromEntries(
    Object.values(snapshot.entities.runs)
      .filter((run) => run.runKind === "direct_agent")
      .map((run) => {
        const sourceMessage = snapshot.entities.messages[run.sourceMessageId];
        const runSpec = snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
        if (
          sourceMessage === undefined ||
          sourceMessage.role !== "user" ||
          sourceMessage.sessionId !== run.sessionId ||
          runSpec === undefined ||
          runSpec.productRunId !== run.productRunId ||
          runSpec.definitionRef.blueprintKey !== "direct"
        ) {
          throw new Error(
            `v15无法为历史Direct Run ${run.productRunId} 回填Prompt Assembly：Message或RunSpec绑定非法`,
          );
        }
        const promptAssemblyId = promptAssemblyIdSchema.parse(
          `pma_${hashCanonical("id.prompt-assembly.v1", { productRunId: run.productRunId }).slice(0, 32)}`,
        );
        const body: Omit<PromptAssemblyV1, "schemaVersion" | "sha256" | "createdAt"> = {
          promptAssemblyId,
          productSessionId: run.sessionId,
          productRunId: run.productRunId,
          sourceMessageId: sourceMessage.messageId,
          workflowDefinitionRevisionId: runSpec.definitionRef.workflowDefinitionRevisionId,
          profileVersion: LEGACY_DIRECT_PROMPT_PROFILE_VERSION,
          compilerVersion: LEGACY_DIRECT_PROMPT_COMPILER_VERSION,
          regions: [],
          systemPromptAppend: "",
          userPrompt: sourceMessage.content.text,
        };
        const assembly: PromptAssembly = {
          schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
          ...body,
          sha256: computePromptAssemblySha256(body),
          createdAt: run.createdAt,
        };
        return [promptAssemblyId, assembly];
      }),
  );
  const attempts = Object.fromEntries(
    Object.entries(snapshot.entities.attempts).map(([attemptId, attempt]) => {
      if (attempt.kind !== "direct_agent") return [attemptId, attempt];
      const run = snapshot.entities.runs[attempt.productRunId];
      const sourceMessage =
        run === undefined ? undefined : snapshot.entities.messages[run.sourceMessageId];
      const runSpec =
        run?.runKind === "direct_agent"
          ? snapshot.entities.workflowRunSpecs[run.workflowRunSpecId]
          : undefined;
      const assembly = Object.values(promptAssemblies).find(
        (candidate) => candidate.productRunId === attempt.productRunId,
      );
      if (
        run?.runKind !== "direct_agent" ||
        sourceMessage === undefined ||
        runSpec === undefined ||
        assembly === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.promptTemplateVersion === undefined ||
        attempt.modelConfigVersion === undefined
      ) {
        throw new Error(`v15无法升级历史Direct Attempt ${attempt.attemptId}：输入版本证据不完整`);
      }
      const sourceMessageSha256 = hashCanonical("message.v1", {
        messageId: sourceMessage.messageId,
        sessionId: sourceMessage.sessionId,
        sessionSequence: sourceMessage.sessionSequence,
        role: sourceMessage.role,
        content: sourceMessage.content,
      });
      return [
        attemptId,
        {
          ...attempt,
          sourceMessageSha256,
          inputManifestSha256: computeDirectAgentInputManifestSha256({
            productRunId: attempt.productRunId,
            inputRunRevision: attempt.inputRunRevision,
            workflowRunSpecId: runSpec.workflowRunSpecId,
            workflowRunSpecSha256: runSpec.sha256,
            sourceMessageId: sourceMessage.messageId,
            sourceMessageSha256,
            promptAssemblySha256: assembly.sha256,
            capabilityMode: "read_only",
            promptTemplateVersion: attempt.promptTemplateVersion,
            modelConfigVersion: attempt.modelConfigVersion,
            limits: {
              maxProviderRequests: DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
              activeTimeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
              tokenBudget: DIRECT_AGENT_TOKEN_BUDGET,
            },
          }),
        },
      ];
    }),
  );
  return productSnapshotV15Schema.parse({
    ...snapshot,
    schemaVersion: "chat-product-store.v15",
    entities: {
      ...snapshot.entities,
      promptFragments: Object.fromEntries(
        Object.entries(snapshot.entities.promptFragments).map(([id, fragment]) => [
          id,
          { ...fragment, scope: { kind: "global" } },
        ]),
      ),
      attempts,
      promptAssemblies,
    },
  });
}
