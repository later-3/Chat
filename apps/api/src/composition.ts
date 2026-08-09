import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  approvalRequestIdSchema,
  artifactIdSchema,
  decisionIdSchema,
  executionCandidateIdSchema,
  executionContractIdSchema,
  messageIdSchema,
  outboxEntryIdSchema,
  planIdSchema,
  planRevisionIdSchema,
  principalIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  revisionInputIdSchema,
  runAttemptIdSchema,
  validationResultIdSchema,
  projectIdSchema,
  projectMethodSnapshotIdSchema,
  projectStageIdSchema,
  projectResourceIdSchema,
  projectParticipantIdSchema,
  projectWorkIdSchema,
  projectActionIdSchema,
  projectContributionIdSchema,
  projectEvidenceIdSchema,
  projectDecisionIdSchema,
  projectObservationIdSchema,
  projectCandidateIdSchema,
  type PrincipalId,
} from "@chat/contracts";
import type {
  ApplicationDeps,
  IdFactory,
  ProductStorePort,
  ProjectIdFactory,
} from "@chat/application";
import { JsonProductStore } from "@chat/product-store-json";
import { createMemoryBackendRegistry } from "@chat/memory-runtime";
import { createProjectResourceRegistry } from "@chat/project-runtime";
import { loadProjectModelProfile, PiProjectIntakeUnderstandingAdapter } from "@chat/pi-runtime";

/**
 * API组合根。
 *
 * 边界：
 * - API进程是JSON Product Store的唯一Owner和唯一写者；只有这里允许
 *   实例化JsonProductStore。
 * - 本阶段是单调试用户部署：所有请求映射到固定DEBUG_PRINCIPAL_ID。
 *   真实Identity Provider属于后续阶段，不在此冒充认证。
 */

export const DEBUG_PRINCIPAL_ID: PrincipalId = principalIdSchema.parse("usr_debug");

const randomSuffix = (): string => randomUUID().replaceAll("-", "");

export function createIdFactory(): IdFactory {
  return {
    session: () => productSessionIdSchema.parse(`psn_${randomSuffix()}`),
    message: () => messageIdSchema.parse(`msg_${randomSuffix()}`),
    run: () => productRunIdSchema.parse(`run_${randomSuffix()}`),
    attempt: () => runAttemptIdSchema.parse(`att_${randomSuffix()}`),
    plan: () => planIdSchema.parse(`pln_${randomSuffix()}`),
    planRevision: () => planRevisionIdSchema.parse(`plr_${randomSuffix()}`),
    revisionInput: () => revisionInputIdSchema.parse(`rin_${randomSuffix()}`),
    approval: () => approvalRequestIdSchema.parse(`apr_${randomSuffix()}`),
    decision: () => decisionIdSchema.parse(`dec_${randomSuffix()}`),
    executionContract: () => executionContractIdSchema.parse(`exc_${randomSuffix()}`),
    executionCandidate: () => executionCandidateIdSchema.parse(`xcd_${randomSuffix()}`),
    validationResult: () => validationResultIdSchema.parse(`val_${randomSuffix()}`),
    artifact: () => artifactIdSchema.parse(`art_${randomSuffix()}`),
    outbox: () => outboxEntryIdSchema.parse(`obx_${randomSuffix()}`),
  };
}

export function createProjectIdFactory(): ProjectIdFactory {
  return {
    project: () => projectIdSchema.parse(`prj_${randomSuffix()}`),
    methodSnapshot: () => projectMethodSnapshotIdSchema.parse(`pms_${randomSuffix()}`),
    stage: () => projectStageIdSchema.parse(`pst_${randomSuffix()}`),
    resource: () => projectResourceIdSchema.parse(`prs_${randomSuffix()}`),
    participant: () => projectParticipantIdSchema.parse(`ppt_${randomSuffix()}`),
    work: () => projectWorkIdSchema.parse(`pwk_${randomSuffix()}`),
    action: () => projectActionIdSchema.parse(`pac_${randomSuffix()}`),
    contribution: () => projectContributionIdSchema.parse(`pct_${randomSuffix()}`),
    evidence: () => projectEvidenceIdSchema.parse(`pev_${randomSuffix()}`),
    decision: () => projectDecisionIdSchema.parse(`pdc_${randomSuffix()}`),
    observation: () => projectObservationIdSchema.parse(`pob_${randomSuffix()}`),
    candidate: () => projectCandidateIdSchema.parse(`pca_${randomSuffix()}`),
  };
}

export function defaultProductStorePath(): string {
  return (
    process.env.CHAT_PRODUCT_STORE_PATH ??
    resolve(process.cwd(), "../../.data/product/chat-product-store.v1.json")
  );
}

export async function openProductStore(
  filePath?: string,
  trace?: ApplicationDeps["trace"],
): Promise<ProductStorePort> {
  const path = filePath ?? defaultProductStorePath();
  await mkdir(dirname(path), { recursive: true });
  return JsonProductStore.open({
    filePath: path,
    now: () => new Date().toISOString(),
    ...(trace !== undefined ? { trace } : {}),
  });
}

export async function createApplicationDeps(
  filePath?: string,
  trace?: ApplicationDeps["trace"],
): Promise<ApplicationDeps> {
  const store = await openProductStore(filePath, trace);
  const memoryRegistry = createMemoryBackendRegistry(process.env);
  const projectRoots = await createProjectResourceRegistry(process.env);
  const projectUnderstanding = new PiProjectIntakeUnderstandingAdapter(
    loadProjectModelProfile(process.env),
  );
  return {
    store,
    now: () => new Date().toISOString(),
    ids: createIdFactory(),
    memoryBackends: memoryRegistry,
    memoryImportBackends: memoryRegistry,
    projectRoots,
    projectIntakeUnderstanding: projectUnderstanding,
    projectIds: createProjectIdFactory(),
    ...(trace !== undefined ? { trace } : {}),
  };
}
