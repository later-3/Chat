import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DIRECT_AGENT_MAX_PROVIDER_REQUESTS,
  capabilityDescriptorHashInputSchema,
  resolvedCapabilitySnapshotSchema,
  type ResolvedCapabilitySnapshot,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { z } from "zod";
import { hashExecutorValue } from "./executor-operation-store.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  authorizedDirectAgentProfileSchema,
  directAgentResultRefSchema,
  directResolvedRuntimeManifestHashInputSchema,
  directPromptReviewCheckpointSchema,
  directPromptReviewDecisionRefSchema,
  directPromptReviewRefSchema,
  directAgentRuntimeToolNameSchema,
  piDirectExecutorEventSchema,
  piDirectExecutorOperationSnapshotSchema,
  piDirectExecutorOperationStatusSchema,
  startPiDirectExecutorOperationRequestSchema,
  type DirectAgentResultRef,
  type DirectResolvedRuntimeManifestHashInput,
  type AuthorizedDirectAgentProfile,
  type DirectPromptReviewCheckpoint,
  type DirectPromptReviewDecisionRef,
  type DirectPromptReviewRef,
  type PiDirectExecutorEvent,
  type PiDirectExecutorOperationSnapshot,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import { piOperationIdSchema, piRuntimeSessionIdSchema } from "./executor-service-contract.js";

const STORE_SCHEMA_VERSION = "pi-direct-executor-operation-store.v2";
const LEGACY_STORE_SCHEMA_VERSION = "pi-direct-executor-operation-store.v1";
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
  .max(80);

const activePromptReviewSchema = z
  .object({
    requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    publishCommandId: z.string().regex(/^cmd_[A-Za-z0-9]+$/u),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    payloadEnvelopeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    providerId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    endpointHost: z.string().min(1).max(253),
    checkpoint: directPromptReviewCheckpointSchema,
    review: directPromptReviewRefSchema.optional(),
    decision: directPromptReviewDecisionRefSchema.optional(),
    permitConsumedAt: z.iso.datetime().optional(),
    providerCompletion: z
      .object({
        completionTokens: z.number().int().nonnegative().max(100_000_000),
        stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DirectActivePromptReview = z.infer<typeof activePromptReviewSchema>;

const operationRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    operationId: piOperationIdSchema,
    requestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    request: startPiDirectExecutorOperationRequestSchema,
    profile: authorizedDirectAgentProfileSchema,
    productRunRevision: z.number().int().positive(),
    status: piDirectExecutorOperationStatusSchema,
    sessionId: piRuntimeSessionIdSchema.optional(),
    activePromptReview: activePromptReviewSchema.optional(),
    providerRequestCount: z.number().int().nonnegative().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    /** pre-session Record可缺失；v2一旦出现session事件，语义Validator要求三项完整。 */
    resolvedRuntimeManifestSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .optional(),
    resolvedRuntimeManifest: directResolvedRuntimeManifestHashInputSchema.optional(),
    resolvedCapabilities: z.array(resolvedCapabilitySnapshotSchema).max(64).optional(),
    events: z.array(piDirectExecutorEventSchema).max(100_000),
    result: directAgentResultRefSchema.optional(),
    errorCode: stableErrorCodeSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const eventHashes = record.events.flatMap((event) =>
      (event.type === "session.started" || event.type === "session.resumed") &&
      event.resolvedRuntimeManifestSha256 !== undefined
        ? [event.resolvedRuntimeManifestSha256]
        : [],
    );
    const hashes = new Set([
      ...(record.resolvedRuntimeManifestSha256 === undefined
        ? []
        : [record.resolvedRuntimeManifestSha256]),
      ...eventHashes,
    ]);
    if (hashes.size > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedRuntimeManifestSha256"],
        message: "Direct Operation的resolved runtime manifest发生漂移",
      });
    }
  });

type OperationRecord = z.infer<typeof operationRecordSchema>;
export type PiDirectExecutorEventPayload = PiDirectExecutorEvent extends infer Event
  ? Event extends PiDirectExecutorEvent
    ? Omit<Event, "sequence" | "timestamp">
    : never
  : never;

export class PiDirectExecutorOperationConflictError extends Error {
  readonly code = "direct_executor.operation_conflict";

  constructor(message = "Direct Agent Operation状态或幂等身份冲突") {
    super(message);
    this.name = "PiDirectExecutorOperationConflictError";
  }
}

export class PiDirectExecutorOperationNotFoundError extends Error {
  readonly code = "direct_executor.operation_not_found";

  constructor() {
    super("Direct Agent Operation不存在");
    this.name = "PiDirectExecutorOperationNotFoundError";
  }
}

export class PiDirectExecutorRuntimeManifestMismatchError extends Error {
  readonly code = "direct_executor.runtime_manifest_mismatch";

  constructor() {
    super("Direct Agent恢复后的运行清单与首次绑定不一致");
    this.name = "PiDirectExecutorRuntimeManifestMismatchError";
  }
}

export class PiDirectExecutorJournalIntegrityError extends Error {
  readonly code = "direct_executor.journal_integrity_invalid";

  constructor() {
    super("Pi Direct Executor Journal语义完整性校验失败");
    this.name = "PiDirectExecutorJournalIntegrityError";
  }
}

function validateResolvedRuntimeManifest(input: {
  readonly sha256: string;
  readonly hashInput: DirectResolvedRuntimeManifestHashInput;
  readonly capabilities: readonly ResolvedCapabilitySnapshot[];
  readonly enabledTools: readonly string[];
}): void {
  const capabilityIds = new Set<string>();
  const qualifiedRefs = new Set<string>();
  const localNames = new Set<string>();
  if (
    input.capabilities.length !== input.enabledTools.length ||
    input.capabilities.some(
      (capability, index) => capability.localName !== input.enabledTools[index],
    )
  ) {
    throw new PiDirectExecutorJournalIntegrityError();
  }
  for (const capability of input.capabilities) {
    const descriptorInput = capabilityDescriptorHashInputSchema.parse({
      schemaVersion: "capability-descriptor.v1",
      capabilityId: capability.ref.capabilityId,
      kind: capability.kind,
      runtimeOwner: capability.runtimeOwner,
      localName: capability.localName,
      sourceRef: capability.sourceRef,
      inputSchemaSha256: capability.ref.inputSchemaSha256,
      effect: capability.effect,
      scopePolicy: capability.scopePolicy,
      approvalPolicy: capability.approvalPolicy,
      evidencePolicy: capability.evidencePolicy,
      readiness: "available",
    });
    if (
      capability.ref.descriptorSha256 !==
        hashCanonical("capability-descriptor.v1", descriptorInput) ||
      capability.ref.resolvedImplementationSha256 !==
        hashExecutorValue({
          sourceRef: capability.sourceRef,
          descriptorSha256: capability.ref.descriptorSha256,
        }) ||
      (capability.scopePolicy === "global" && capability.ref.scopeRef.kind !== "global") ||
      (capability.scopePolicy === "workspace_required" &&
        capability.ref.scopeRef.kind !== "workspace") ||
      (capability.scopePolicy === "provider_defined" && capability.ref.scopeRef.kind !== "provider")
    ) {
      throw new PiDirectExecutorJournalIntegrityError();
    }
    const qualifiedRef = `${capability.ref.capabilityId}:${capability.ref.descriptorSha256}`;
    if (
      capabilityIds.has(capability.ref.capabilityId) ||
      qualifiedRefs.has(qualifiedRef) ||
      localNames.has(capability.localName)
    ) {
      throw new PiDirectExecutorJournalIntegrityError();
    }
    capabilityIds.add(capability.ref.capabilityId);
    qualifiedRefs.add(qualifiedRef);
    localNames.add(capability.localName);
  }
  const expectedManifestSha256 = hashExecutorValue({
    systemPromptSha256: input.hashInput.systemPromptSha256,
    capabilities: input.capabilities,
    resourceInventorySha256: input.hashInput.resourceInventorySha256,
  });
  if (input.sha256 !== expectedManifestSha256) {
    throw new PiDirectExecutorJournalIntegrityError();
  }
}

export interface PiDirectExecutorJournalInput {
  readonly request?: StartPiDirectExecutorOperationRequest | undefined;
  readonly snapshot: PiDirectExecutorOperationSnapshot;
  readonly events: readonly PiDirectExecutorEvent[];
  readonly expectedOperationId?: string | undefined;
  readonly expectedRequestSha256?: string | undefined;
  readonly requireCapabilitySnapshot: boolean;
}

/**
 * Direct Store、恢复、Snapshot与Client共用的完整Journal状态机。协议层optional只为
 * 真正v1只读文件保留；当前v2创建Session后必须冻结完整Manifest，成功态必须保留唯一
 * session.started，所有恢复和Tool事件继续绑定同一Session与Capability快照。
 */
export function validatePiDirectExecutorOperationJournal(
  input: PiDirectExecutorJournalInput,
): void {
  const request =
    input.request === undefined
      ? undefined
      : startPiDirectExecutorOperationRequestSchema.parse(input.request);
  const snapshot = piDirectExecutorOperationSnapshotSchema.parse(input.snapshot);
  const events = z.array(piDirectExecutorEventSchema).max(100_000).parse(input.events);
  const fail = (): never => {
    throw new PiDirectExecutorJournalIntegrityError();
  };
  const operationId = input.expectedOperationId ?? snapshot.operationId;
  const requestSha256 = input.expectedRequestSha256 ?? snapshot.requestSha256;
  if (
    snapshot.operationId !== operationId ||
    snapshot.requestSha256 !== requestSha256 ||
    (request !== undefined &&
      (request.operationId !== operationId || hashExecutorValue(request) !== requestSha256)) ||
    snapshot.lastEventSequence !== events.length
  ) {
    fail();
  }

  const sessionEvents = events.filter(
    (
      event,
    ): event is Extract<PiDirectExecutorEvent, { type: "session.started" | "session.resumed" }> =>
      event.type === "session.started" || event.type === "session.resumed",
  );
  const sessionStartedEvents = sessionEvents.filter((event) => event.type === "session.started");
  if (
    input.requireCapabilitySnapshot &&
    (sessionStartedEvents.length > 1 ||
      (sessionEvents.length > 0 && sessionEvents[0]?.type !== "session.started"))
  ) {
    fail();
  }
  if (input.requireCapabilitySnapshot && sessionEvents.length > 0) {
    const manifestSha256 = snapshot.resolvedRuntimeManifestSha256;
    const manifestHashInput = snapshot.resolvedRuntimeManifest;
    const manifestCapabilities = snapshot.resolvedCapabilities;
    if (
      manifestSha256 === undefined ||
      manifestHashInput === undefined ||
      manifestCapabilities === undefined
    ) {
      throw new PiDirectExecutorJournalIntegrityError();
    }
    for (const event of sessionEvents) {
      if (
        event.resolvedRuntimeManifestSha256 === undefined ||
        event.resolvedRuntimeManifest === undefined ||
        event.resolvedCapabilities === undefined ||
        event.enabledTools === undefined ||
        event.resolvedRuntimeManifestSha256 !== manifestSha256 ||
        JSON.stringify(event.resolvedRuntimeManifest) !== JSON.stringify(manifestHashInput) ||
        JSON.stringify(event.resolvedCapabilities) !== JSON.stringify(manifestCapabilities)
      ) {
        fail();
      }
    }
    try {
      for (const event of sessionEvents) {
        validateResolvedRuntimeManifest({
          sha256: manifestSha256,
          hashInput: manifestHashInput,
          capabilities: manifestCapabilities,
          enabledTools: event.enabledTools ?? [],
        });
      }
    } catch {
      fail();
    }
  }

  let previousTimestamp = snapshot.createdAt;
  let terminalIndex: number | undefined;
  let sessionId: string | undefined;
  const intents = new Map<
    string,
    Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }>
  >();
  const closed = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (
      event.sequence !== index + 1 ||
      event.operationId !== operationId ||
      event.timestamp < previousTimestamp
    ) {
      fail();
    }
    previousTimestamp = event.timestamp;
    if (
      (event.type === "operation.accepted" || event.type === "operation.started") &&
      event.requestSha256 !== requestSha256
    ) {
      fail();
    }
    if (terminalIndex !== undefined) fail();
    const terminal =
      event.type === "operation.completed" ||
      event.type === "operation.cancelled" ||
      event.type === "operation.failed" ||
      event.type === "operation.outcome_unknown";
    if (terminal) terminalIndex = index;

    if (event.type === "session.started" || event.type === "session.resumed") {
      if (sessionId !== undefined && sessionId !== event.sessionId) fail();
      sessionId = event.sessionId;
    } else if ("sessionId" in event) {
      if (sessionId === undefined || event.sessionId !== sessionId) fail();
    }

    if (event.type === "tool.intent_persisted") {
      if (
        intents.has(event.toolCallId) ||
        (input.requireCapabilitySnapshot && event.capability === undefined) ||
        (event.capability !== undefined && event.capability.localName !== event.toolName) ||
        (input.requireCapabilitySnapshot &&
          snapshot.resolvedCapabilities?.filter(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(event.capability),
          ).length !== 1)
      ) {
        fail();
      }
      intents.set(event.toolCallId, event);
      continue;
    }
    if (
      event.type !== "tool.completed" &&
      event.type !== "tool.failed" &&
      event.type !== "tool.blocked" &&
      event.type !== "tool.outcome_unknown"
    ) {
      continue;
    }
    const intent = intents.get(event.toolCallId);
    if (
      intent === undefined ||
      closed.has(event.toolCallId) ||
      event.toolName !== intent.toolName ||
      event.sessionId !== intent.sessionId ||
      (input.requireCapabilitySnapshot && event.inputSha256 === undefined) ||
      (event.inputSha256 !== undefined && event.inputSha256 !== intent.inputSha256) ||
      (input.requireCapabilitySnapshot && event.capability === undefined) ||
      JSON.stringify(event.capability) !== JSON.stringify(intent.capability) ||
      ((event.type === "tool.completed" || event.type === "tool.failed") &&
        event.resultSha256 === undefined)
    ) {
      fail();
    }
    closed.add(event.toolCallId);
  }

  const accepted = events.filter((event) => event.type === "operation.accepted");
  const started = events.filter((event) => event.type === "operation.started");
  const expectedTerminal =
    snapshot.status === "succeeded"
      ? "operation.completed"
      : snapshot.status === "cancelled"
        ? "operation.cancelled"
        : snapshot.status === "failed"
          ? "operation.failed"
          : snapshot.status === "outcome_unknown"
            ? "operation.outcome_unknown"
            : undefined;
  const terminalEvent = terminalIndex === undefined ? undefined : events[terminalIndex];
  if (
    accepted.length !== 1 ||
    events[0]?.type !== "operation.accepted" ||
    started.length > 1 ||
    (started.length === 1 && events.indexOf(started[0]!) <= 0) ||
    snapshot.sessionId !== sessionId ||
    (terminalIndex !== undefined && terminalIndex !== events.length - 1) ||
    (expectedTerminal === undefined
      ? terminalIndex !== undefined
      : terminalEvent?.type !== expectedTerminal)
  ) {
    fail();
  }
  const open = [...intents.keys()].filter((toolCallId) => !closed.has(toolCallId));
  if (snapshot.status === "queued") {
    if (events.length !== 1 || started.length !== 0 || snapshot.result !== undefined) fail();
  } else if (
    snapshot.status === "running" ||
    snapshot.status === "preparing_prompt_review" ||
    snapshot.status === "waiting_prompt_review" ||
    snapshot.status === "dispatching"
  ) {
    if (started.length !== 1 || terminalIndex !== undefined || snapshot.result !== undefined)
      fail();
  } else if (snapshot.status === "succeeded") {
    if (
      started.length !== 1 ||
      (input.requireCapabilitySnapshot && sessionStartedEvents.length !== 1) ||
      open.length !== 0 ||
      snapshot.result === undefined ||
      terminalEvent?.type !== "operation.completed" ||
      JSON.stringify(terminalEvent.result) !== JSON.stringify(snapshot.result) ||
      snapshot.errorCode !== undefined
    ) {
      fail();
    }
  } else if (
    open.length !== 0 ||
    snapshot.result !== undefined ||
    snapshot.errorCode === undefined
  ) {
    fail();
  }
  if (
    events.length === 0 ||
    snapshot.createdAt > events[0]!.timestamp ||
    snapshot.updatedAt < events.at(-1)!.timestamp
  ) {
    fail();
  }
}

function validateOperationRecord(record: OperationRecord, legacy: boolean): void {
  if (
    record.operationId !== record.request.operationId ||
    (!legacy && record.requestSha256 !== hashExecutorValue(record.request))
  ) {
    throw new PiDirectExecutorJournalIntegrityError();
  }
  const snapshot = piDirectExecutorOperationSnapshotSchema.parse({
    schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
    operationId: record.operationId,
    requestSha256: record.requestSha256,
    status: record.status,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.activePromptReview?.review === undefined
      ? {}
      : { activeReview: record.activePromptReview.review }),
    ...(record.activePromptReview?.decision === undefined
      ? {}
      : { decision: record.activePromptReview.decision }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(record.resolvedRuntimeManifestSha256 === undefined
      ? {}
      : { resolvedRuntimeManifestSha256: record.resolvedRuntimeManifestSha256 }),
    ...(record.resolvedRuntimeManifest === undefined
      ? {}
      : { resolvedRuntimeManifest: record.resolvedRuntimeManifest }),
    ...(record.resolvedCapabilities === undefined
      ? {}
      : { resolvedCapabilities: record.resolvedCapabilities }),
    lastEventSequence: record.events.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  validatePiDirectExecutorOperationJournal({
    ...(legacy ? {} : { request: record.request }),
    snapshot,
    events: record.events,
    expectedOperationId: record.operationId,
    expectedRequestSha256: record.requestSha256,
    requireCapabilitySnapshot: !legacy,
  });
}

/**
 * Direct Operation正文外置：此Store只持久化引用、Hash、预算、一次性permit和安全事件。
 * preparing/waiting没有越过Provider边界，可跨进程恢复；dispatching无法证明是否已fetch，
 * 打开Store时必须保守收敛为outcome_unknown。
 */
export class PiDirectExecutorOperationStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly legacyReadOnlyOperationIds = new Set<string>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly directory: string,
    private readonly now: () => Date,
  ) {}

  static async open(
    directory: string,
    options: { readonly now?: () => Date } = {},
  ): Promise<PiDirectExecutorOperationStore> {
    const store = new PiDirectExecutorOperationStore(directory, options.now ?? (() => new Date()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await readFile(join(directory, entry.name), "utf8");
      const decoded = JSON.parse(raw) as Record<string, unknown>;
      const legacy = decoded["schemaVersion"] === LEGACY_STORE_SCHEMA_VERSION;
      const request = decoded["request"];
      const normalized = legacy
        ? {
            ...decoded,
            schemaVersion: STORE_SCHEMA_VERSION,
            request:
              typeof request === "object" && request !== null
                ? { ...request, schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION }
                : request,
          }
        : decoded;
      const record = operationRecordSchema.parse(normalized);
      if (`${record.operationId}.json` !== entry.name) {
        throw new PiDirectExecutorJournalIntegrityError();
      }
      validateOperationRecord(record, legacy);
      store.records.set(record.operationId, record);
      if (legacy) store.legacyReadOnlyOperationIds.add(record.operationId);
    }
    await store.reconcileInterruptedOperations();
    return store;
  }

  async createOrGet(
    rawRequest: StartPiDirectExecutorOperationRequest,
    rawProfile?: AuthorizedDirectAgentProfile,
  ): Promise<{ readonly snapshot: PiDirectExecutorOperationSnapshot; readonly created: boolean }> {
    const request = startPiDirectExecutorOperationRequestSchema.parse(rawRequest);
    const requestSha256 = hashExecutorValue(request);
    return this.mutate<{
      readonly snapshot: PiDirectExecutorOperationSnapshot;
      readonly created: boolean;
    }>(request.operationId, async (existing) => {
      if (existing !== undefined) {
        if (existing.requestSha256 !== requestSha256) {
          throw new PiDirectExecutorOperationConflictError("Operation ID已绑定不同请求");
        }
        return {
          record: existing,
          value: { snapshot: this.snapshot(existing), created: false as boolean },
        };
      }
      const profile = authorizedDirectAgentProfileSchema.parse(rawProfile);
      const timestamp = this.now().toISOString();
      const record = operationRecordSchema.parse({
        schemaVersion: STORE_SCHEMA_VERSION,
        operationId: request.operationId,
        requestSha256,
        request,
        profile,
        productRunRevision: profile.runRevision,
        status: "queued",
        providerRequestCount: 0,
        completionTokens: 0,
        events: [
          piDirectExecutorEventSchema.parse({
            sequence: 1,
            timestamp,
            operationId: request.operationId,
            type: "operation.accepted",
            requestSha256,
          }),
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return {
        record,
        value: { snapshot: this.snapshot(record), created: true as boolean },
      };
    });
  }

  getRequest(operationId: string): StartPiDirectExecutorOperationRequest {
    return structuredClone(this.requireRecord(operationId).request);
  }

  getExistingSnapshotForRequest(
    rawRequest: StartPiDirectExecutorOperationRequest,
  ): PiDirectExecutorOperationSnapshot | undefined {
    const request = startPiDirectExecutorOperationRequestSchema.parse(rawRequest);
    const existing = this.records.get(request.operationId);
    if (existing === undefined) return undefined;
    if (existing.requestSha256 !== hashExecutorValue(request)) {
      throw new PiDirectExecutorOperationConflictError("Operation ID已绑定不同请求");
    }
    return this.snapshot(existing);
  }

  getOperationIds(): readonly string[] {
    return [...this.records.keys()].sort();
  }

  getProfile(operationId: string): AuthorizedDirectAgentProfile {
    return structuredClone(this.requireRecord(operationId).profile);
  }

  getProductRunRevision(operationId: string): number {
    return this.requireRecord(operationId).productRunRevision;
  }

  getSnapshot(operationId: string): PiDirectExecutorOperationSnapshot {
    const record = this.requireRecord(operationId);
    validateOperationRecord(record, this.legacyReadOnlyOperationIds.has(operationId));
    return this.snapshot(record);
  }

  getEvents(operationId: string, afterSequence = 0): readonly PiDirectExecutorEvent[] {
    const record = this.requireRecord(operationId);
    validateOperationRecord(record, this.legacyReadOnlyOperationIds.has(operationId));
    return structuredClone(record.events.filter((event) => event.sequence > afterSequence));
  }

  getToolOutcomeUnknownRecoveries(): readonly {
    readonly request: StartPiDirectExecutorOperationRequest;
    readonly intent: Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }>;
  }[] {
    return [...this.records.values()].flatMap((record) => {
      const unknownIds = new Set(
        record.events.flatMap((event) =>
          event.type === "tool.outcome_unknown" && "toolCallId" in event ? [event.toolCallId] : [],
        ),
      );
      return record.events.flatMap((event) =>
        event.type === "tool.intent_persisted" &&
        unknownIds.has(event.toolCallId) &&
        event.capability !== undefined &&
        event.inputDisplay !== undefined &&
        event.inputDisplayTruncated !== undefined
          ? [{ request: structuredClone(record.request), intent: structuredClone(event) }]
          : [],
      );
    });
  }

  /**
   * Journal Result已先于Product提交落盘。进程若在Product响应未知后退出，重启只重放
   * 同一幂等Product Result命令；这里绝不重新claim许可或调用handler。
   */
  getToolResultCommitRecoveries(): readonly {
    readonly request: StartPiDirectExecutorOperationRequest;
    readonly intent: Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }>;
    readonly result: PiDirectExecutorEvent & {
      readonly type: "tool.completed" | "tool.failed";
      readonly resultSha256: string;
    };
    readonly journalResultSha256: string;
  }[] {
    return [...this.records.values()].flatMap((record) => {
      const intents = new Map(
        record.events.flatMap((event) =>
          event.type === "tool.intent_persisted" ? [[event.toolCallId, event] as const] : [],
        ),
      );
      return record.events.flatMap((event) => {
        if (
          (event.type !== "tool.completed" && event.type !== "tool.failed") ||
          event.resultSha256 === undefined
        )
          return [];
        const intent = intents.get(event.toolCallId);
        return intent === undefined || intent.capability === undefined
          ? []
          : [
              {
                request: structuredClone(record.request),
                intent: structuredClone(intent),
                result: {
                  ...structuredClone(event),
                  type: event.type,
                  resultSha256: event.resultSha256,
                },
                journalResultSha256: hashExecutorValue(event),
              },
            ];
      });
    });
  }

  getRecoverableOperationIds(): readonly string[] {
    return [...this.records.values()]
      .filter((record) => record.status === "preparing_prompt_review")
      .map((record) => record.operationId);
  }

  getActivePromptReview(operationId: string): DirectActivePromptReview | undefined {
    const review = this.requireRecord(operationId).activePromptReview;
    return review === undefined ? undefined : structuredClone(review);
  }

  hasProviderCompletion(operationId: string): boolean {
    return this.requireRecord(operationId).activePromptReview?.providerCompletion !== undefined;
  }

  getNextPromptReviewIndex(operationId: string): number {
    const record = this.requireRecord(operationId);
    if (record.status === "preparing_prompt_review") {
      return this.requireActiveReview(record).requestIndex;
    }
    if (record.status !== "running") {
      throw new PiDirectExecutorOperationConflictError("当前状态不能计算下一次Prompt Review");
    }
    return record.providerRequestCount + 1;
  }

  async markRunning(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status === "running") return { record: current, value: undefined };
      if (current.status !== "queued") {
        throw new PiDirectExecutorOperationConflictError("只有queued Operation可以开始");
      }
      const next = this.appendToRecord(current, {
        operationId,
        type: "operation.started",
        requestSha256: current.requestSha256,
      });
      return { record: { ...next, status: "running" }, value: undefined };
    });
  }

  async setSession(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly enabledTools: readonly string[];
    readonly resolvedRuntimeManifestSha256: string;
    readonly resolvedRuntimeManifest: DirectResolvedRuntimeManifestHashInput;
    readonly resolvedCapabilities: readonly ResolvedCapabilitySnapshot[];
    readonly resumedFromCheckpointSha256?: string;
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (
        current.status !== "running" &&
        current.status !== "preparing_prompt_review" &&
        current.status !== "waiting_prompt_review"
      ) {
        throw new PiDirectExecutorOperationConflictError("当前状态不能绑定Pi Session");
      }
      const sessionId = piRuntimeSessionIdSchema.parse(input.sessionId);
      const pinnedSessionEvent = current.events.find(
        (
          event,
        ): event is Extract<
          PiDirectExecutorEvent,
          { type: "session.started" | "session.resumed" }
        > =>
          (event.type === "session.started" || event.type === "session.resumed") &&
          event.resolvedRuntimeManifestSha256 !== undefined,
      );
      const pinnedRuntimeManifestSha256 =
        current.resolvedRuntimeManifestSha256 ?? pinnedSessionEvent?.resolvedRuntimeManifestSha256;
      if (
        pinnedRuntimeManifestSha256 !== undefined &&
        pinnedRuntimeManifestSha256 !== input.resolvedRuntimeManifestSha256
      ) {
        throw new PiDirectExecutorRuntimeManifestMismatchError();
      }
      const next = this.appendToRecord(
        current,
        input.resumedFromCheckpointSha256 === undefined
          ? {
              operationId: input.operationId,
              type: "session.started",
              sessionId,
              enabledTools: input.enabledTools as never,
              resolvedRuntimeManifestSha256: input.resolvedRuntimeManifestSha256,
              resolvedRuntimeManifest: input.resolvedRuntimeManifest,
              resolvedCapabilities: [...input.resolvedCapabilities],
            }
          : {
              operationId: input.operationId,
              type: "session.resumed",
              sessionId,
              checkpointSha256: input.resumedFromCheckpointSha256,
              enabledTools: input.enabledTools as never,
              resolvedRuntimeManifestSha256: input.resolvedRuntimeManifestSha256,
              resolvedRuntimeManifest: input.resolvedRuntimeManifest,
              resolvedCapabilities: [...input.resolvedCapabilities],
            },
      );
      return {
        record: {
          ...next,
          sessionId,
          resolvedRuntimeManifestSha256:
            pinnedRuntimeManifestSha256 ?? input.resolvedRuntimeManifestSha256,
          resolvedRuntimeManifest: input.resolvedRuntimeManifest,
          resolvedCapabilities: [...input.resolvedCapabilities],
        },
        value: undefined,
      };
    });
  }

  async beginPromptReview(input: {
    readonly operationId: string;
    readonly publishCommandId: string;
    readonly payloadSha256: string;
    readonly payloadEnvelopeSha256: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly endpointHost: string;
    readonly checkpoint: DirectPromptReviewCheckpoint;
  }): Promise<DirectActivePromptReview> {
    return this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status === "preparing_prompt_review") {
        const existing = current.activePromptReview;
        if (
          existing === undefined ||
          existing.payloadSha256 !== input.payloadSha256 ||
          existing.payloadEnvelopeSha256 !== input.payloadEnvelopeSha256 ||
          existing.publishCommandId !== input.publishCommandId
        ) {
          throw new PiDirectExecutorOperationConflictError("恢复时Provider Payload发生漂移");
        }
        return { record: current, value: structuredClone(existing) };
      }
      if (current.status !== "running") {
        throw new PiDirectExecutorOperationConflictError("当前状态不能创建Prompt Review");
      }
      this.assertNoOpenToolIntentsInRecord(current);
      if (current.providerRequestCount >= current.profile.limits.maxProviderRequests) {
        throw new PiDirectExecutorOperationConflictError("Direct Agent已达到最大Provider请求数");
      }
      if (current.completionTokens >= current.profile.limits.tokenBudget) {
        throw new PiDirectExecutorOperationConflictError("Direct Agent已达到Completion Token预算");
      }
      const activePromptReview = activePromptReviewSchema.parse({
        requestIndex: current.providerRequestCount + 1,
        publishCommandId: input.publishCommandId,
        payloadSha256: input.payloadSha256,
        payloadEnvelopeSha256: input.payloadEnvelopeSha256,
        providerId: input.providerId,
        modelId: input.modelId,
        endpointHost: input.endpointHost,
        checkpoint: input.checkpoint,
      });
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "prompt_review.preparing",
        requestIndex: activePromptReview.requestIndex,
        payloadSha256: activePromptReview.payloadSha256,
        payloadEnvelopeSha256: activePromptReview.payloadEnvelopeSha256,
        checkpointSha256: activePromptReview.checkpoint.fileSha256,
      });
      return {
        record: { ...next, status: "preparing_prompt_review", activePromptReview },
        value: structuredClone(activePromptReview),
      };
    });
  }

  async markPromptReviewWaiting(
    operationId: string,
    review: DirectPromptReviewRef,
    productRunRevision: number,
  ): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      const parsed = directPromptReviewRefSchema.parse(review);
      if (
        active.requestIndex !== parsed.requestIndex ||
        active.payloadSha256 !== parsed.payloadSha256
      ) {
        throw new PiDirectExecutorOperationConflictError("Product Review与准备中的Payload不一致");
      }
      if (current.status === "waiting_prompt_review" && active.review !== undefined) {
        if (
          JSON.stringify(active.review) !== JSON.stringify(parsed) ||
          current.productRunRevision !== productRunRevision
        ) {
          throw new PiDirectExecutorOperationConflictError("Prompt Review引用发生冲突");
        }
        return { record: current, value: undefined };
      }
      if (current.status !== "preparing_prompt_review") {
        throw new PiDirectExecutorOperationConflictError("当前状态不能进入Prompt Review等待");
      }
      if (productRunRevision <= current.productRunRevision) {
        throw new PiDirectExecutorOperationConflictError(
          "Prompt Review没有推进Product Run revision",
        );
      }
      const next = this.appendToRecord(current, {
        operationId,
        type: "prompt_review.waiting",
        review: parsed,
      });
      return {
        record: {
          ...next,
          status: "waiting_prompt_review",
          productRunRevision,
          activePromptReview: { ...active, review: parsed },
        },
        value: undefined,
      };
    });
  }

  async bindPromptReviewDecision(
    operationId: string,
    decision: DirectPromptReviewDecisionRef,
    productRunRevision: number,
  ): Promise<PiDirectExecutorOperationSnapshot> {
    return this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      if (current.status !== "waiting_prompt_review" || active.review === undefined) {
        if (
          active.decision !== undefined &&
          JSON.stringify(active.decision) === JSON.stringify(decision) &&
          current.productRunRevision === productRunRevision
        ) {
          return { record: current, value: this.snapshot(current) };
        }
        throw new PiDirectExecutorOperationConflictError(
          "Operation当前不在对应Prompt Review等待态",
        );
      }
      const parsed = directPromptReviewDecisionRefSchema.parse(decision);
      if (active.decision !== undefined) {
        if (JSON.stringify(active.decision) !== JSON.stringify(parsed)) {
          throw new PiDirectExecutorOperationConflictError("Prompt Review已绑定不同Decision");
        }
        return { record: current, value: this.snapshot(current) };
      }
      if (productRunRevision < current.productRunRevision) {
        throw new PiDirectExecutorOperationConflictError(
          "Prompt Review Decision的Run revision发生回退",
        );
      }
      let next = this.appendToRecord(current, {
        operationId,
        type: "prompt_review.decided",
        review: active.review,
        decision: parsed,
      });
      if (parsed.kind === "reject") {
        next = this.appendToRecord(next, {
          operationId,
          type: "operation.cancelled",
          errorCode: "prompt_review.rejected",
        });
        const cancelled = operationRecordSchema.parse({
          ...next,
          status: "cancelled",
          productRunRevision,
          activePromptReview: { ...active, decision: parsed },
          errorCode: "prompt_review.rejected",
        });
        return { record: cancelled, value: this.snapshot(cancelled) };
      }
      const decided = operationRecordSchema.parse({
        ...next,
        productRunRevision,
        activePromptReview: { ...active, decision: parsed },
      });
      return { record: decided, value: this.snapshot(decided) };
    });
  }

  async markProviderDispatching(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      if (
        current.status !== "waiting_prompt_review" ||
        active.review === undefined ||
        active.decision?.kind !== "approve" ||
        active.permitConsumedAt !== undefined
      ) {
        throw new PiDirectExecutorOperationConflictError("Prompt Review没有可消费的批准permit");
      }
      const permitConsumedAt = this.now().toISOString();
      const next = this.appendToRecord(current, {
        operationId,
        type: "provider.started",
        requestIndex: active.requestIndex,
        payloadSha256: active.payloadSha256,
        endpointHost: active.endpointHost,
      });
      return {
        record: {
          ...next,
          status: "dispatching",
          providerRequestCount: current.providerRequestCount + 1,
          activePromptReview: { ...active, permitConsumedAt },
        },
        value: undefined,
      };
    });
  }

  /** 审核关闭时直接越过人工等待，但仍先耐久写入Provider dispatching栅栏。 */
  async markProviderDispatchingWithoutReview(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      if (
        current.status !== "preparing_prompt_review" ||
        active.review !== undefined ||
        active.decision !== undefined ||
        active.permitConsumedAt !== undefined
      ) {
        throw new PiDirectExecutorOperationConflictError("当前Provider请求不能免审派发");
      }
      const permitConsumedAt = this.now().toISOString();
      const next = this.appendToRecord(current, {
        operationId,
        type: "provider.started",
        requestIndex: active.requestIndex,
        payloadSha256: active.payloadSha256,
        endpointHost: active.endpointHost,
      });
      return {
        record: {
          ...next,
          status: "dispatching",
          providerRequestCount: current.providerRequestCount + 1,
          activePromptReview: { ...active, permitConsumedAt },
        },
        value: undefined,
      };
    });
  }

  async recordProviderCompleted(input: {
    readonly operationId: string;
    readonly completionTokens: number;
    readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "dispatching") {
        throw new PiDirectExecutorOperationConflictError("只有dispatching Provider能闭合");
      }
      const active = this.requireActiveReview(current);
      const providerCompletion = {
        completionTokens: input.completionTokens,
        stopReason: input.stopReason,
      };
      if (active.providerCompletion !== undefined) {
        if (JSON.stringify(active.providerCompletion) !== JSON.stringify(providerCompletion)) {
          throw new PiDirectExecutorOperationConflictError("Provider完成证据发生冲突");
        }
        return { record: current, value: undefined };
      }
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "provider.completed",
        requestIndex: active.requestIndex,
        payloadSha256: active.payloadSha256,
        completionTokens: input.completionTokens,
        stopReason: input.stopReason,
      });
      return {
        record: {
          ...next,
          activePromptReview: { ...active, providerCompletion },
        },
        value: undefined,
      };
    });
  }

  async finalizeProviderSettled(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "dispatching") {
        throw new PiDirectExecutorOperationConflictError("只有dispatching Provider能完成结算");
      }
      const active = this.requireActiveReview(current);
      if (active.providerCompletion === undefined) {
        throw new PiDirectExecutorOperationConflictError("Provider完成结算缺少持久证据");
      }
      return {
        record: operationRecordSchema.parse({
          ...current,
          status: "running",
          activePromptReview: undefined,
          completionTokens: current.completionTokens + active.providerCompletion.completionTokens,
        }),
        value: undefined,
      };
    });
  }

  async appendToolIntent(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputSha256: string;
    readonly inputDisplay: string;
    readonly inputDisplayTruncated: boolean;
    readonly capability?: ResolvedCapabilitySnapshot;
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "running") {
        throw new PiDirectExecutorOperationConflictError("只有running Operation能执行Tool");
      }
      if (
        current.events.some(
          (event) =>
            event.type === "tool.intent_persisted" && event.toolCallId === input.toolCallId,
        )
      ) {
        throw new PiDirectExecutorOperationConflictError("Provider重复使用Tool Call ID");
      }
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "tool.intent_persisted",
        sessionId: piRuntimeSessionIdSchema.parse(input.sessionId),
        toolCallId: input.toolCallId,
        toolName: directAgentRuntimeToolNameSchema.parse(input.toolName),
        inputSha256: input.inputSha256,
        inputDisplay: input.inputDisplay,
        inputDisplayTruncated: input.inputDisplayTruncated,
        ...(input.capability === undefined ? {} : { capability: input.capability }),
      });
      return { record: next, value: undefined };
    });
  }

  async closeToolIntent(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly resultSha256: string;
    readonly outcome: "completed" | "failed" | "blocked";
  }): Promise<string> {
    return this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const open = this.openToolIntents(current).find(
        (event) => event.toolCallId === input.toolCallId,
      );
      if (
        open === undefined ||
        open.toolName !== input.toolName ||
        open.sessionId !== input.sessionId
      ) {
        throw new PiDirectExecutorOperationConflictError("Tool Result缺少已持久化Intent");
      }
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type:
          input.outcome === "completed"
            ? "tool.completed"
            : input.outcome === "blocked"
              ? "tool.blocked"
              : "tool.failed",
        sessionId: piRuntimeSessionIdSchema.parse(input.sessionId),
        toolCallId: input.toolCallId,
        toolName: directAgentRuntimeToolNameSchema.parse(input.toolName),
        inputSha256: open.inputSha256,
        resultSha256: input.resultSha256,
        ...(open.capability === undefined ? {} : { capability: open.capability }),
      });
      const journalEvent = next.events.at(-1);
      if (journalEvent === undefined) throw new Error("Tool Journal Result事件缺失");
      return { record: next, value: hashExecutorValue(journalEvent) };
    });
  }

  async markToolOutcomeUnknown(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly errorCode: string;
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const open = this.openToolIntents(current).find(
        (event) => event.toolCallId === input.toolCallId,
      );
      if (open === undefined) return { record: current, value: undefined };
      let next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "tool.outcome_unknown",
        sessionId: piRuntimeSessionIdSchema.parse(input.sessionId),
        toolCallId: input.toolCallId,
        toolName: directAgentRuntimeToolNameSchema.parse(input.toolName),
        inputSha256: open.inputSha256,
        ...(open.capability === undefined ? {} : { capability: open.capability }),
      });
      next = this.appendToRecord(next, {
        operationId: input.operationId,
        type: "operation.outcome_unknown",
        errorCode: input.errorCode,
      });
      return {
        record: { ...next, status: "outcome_unknown", errorCode: input.errorCode },
        value: undefined,
      };
    });
  }

  assertNoOpenSideEffects(operationId: string): void {
    const record = this.requireRecord(operationId);
    if (record.status === "dispatching") {
      throw new PiDirectExecutorOperationConflictError("Provider请求尚未闭合");
    }
    this.assertNoOpenToolIntentsInRecord(record);
  }

  async complete(operationId: string, result: DirectAgentResultRef): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "running" || current.activePromptReview !== undefined) {
        throw new PiDirectExecutorOperationConflictError(
          "Operation仍有未闭合Prompt Review或Provider",
        );
      }
      this.assertNoOpenToolIntentsInRecord(current);
      const parsed = directAgentResultRefSchema.parse(result);
      const next = this.appendToRecord(current, {
        operationId,
        type: "operation.completed",
        result: parsed,
      });
      return {
        record: { ...next, status: "succeeded", result: parsed, errorCode: undefined },
        value: undefined,
      };
    });
  }

  async fail(operationId: string, errorCode: string): Promise<void> {
    await this.setTerminal(operationId, "failed", errorCode, "operation.failed");
  }

  async markOutcomeUnknown(operationId: string, errorCode: string): Promise<void> {
    await this.setTerminal(operationId, "outcome_unknown", errorCode, "operation.outcome_unknown");
  }

  private async reconcileInterruptedOperations(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (this.legacyReadOnlyOperationIds.has(record.operationId)) continue;
      if (
        record.status === "preparing_prompt_review" ||
        record.status === "waiting_prompt_review" ||
        record.status === "succeeded" ||
        record.status === "cancelled" ||
        record.status === "outcome_unknown"
      ) {
        continue;
      }
      if (record.status === "dispatching") {
        await this.markOutcomeUnknown(
          record.operationId,
          record.activePromptReview?.providerCompletion === undefined
            ? "direct_executor.provider_outcome_unknown"
            : "direct_executor.session_continuation_outcome_unknown",
        );
        continue;
      }
      const openTools = this.openToolIntents(record);
      if (openTools.length > 0) {
        await this.mutate(record.operationId, async (loaded) => {
          let current = this.requireMutableRecord(loaded);
          for (const tool of this.openToolIntents(current)) {
            current = this.appendToRecord(current, {
              operationId: current.operationId,
              type: "tool.outcome_unknown",
              sessionId: tool.sessionId,
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              inputSha256: tool.inputSha256,
              ...(tool.capability === undefined ? {} : { capability: tool.capability }),
            });
          }
          current = this.appendToRecord(current, {
            operationId: current.operationId,
            type: "operation.outcome_unknown",
            errorCode: "direct_executor.tool_outcome_unknown",
          });
          return {
            record: {
              ...current,
              status: "outcome_unknown",
              errorCode: "direct_executor.tool_outcome_unknown",
            },
            value: undefined,
          };
        });
        continue;
      }
      if (record.status === "failed") continue;
      await this.markOutcomeUnknown(record.operationId, "direct_executor.operation_interrupted");
    }
  }

  private async setTerminal(
    operationId: string,
    status: "failed" | "outcome_unknown",
    rawErrorCode: string,
    eventType: "operation.failed" | "operation.outcome_unknown",
  ): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (["succeeded", "cancelled", "failed", "outcome_unknown"].includes(current.status)) {
        return { record: current, value: undefined };
      }
      const errorCode = stableErrorCodeSchema.parse(rawErrorCode);
      const next = this.appendToRecord(current, {
        operationId,
        type: eventType,
        errorCode,
      });
      return { record: { ...next, status, errorCode }, value: undefined };
    });
  }

  private openToolIntents(
    record: OperationRecord,
  ): Array<Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }>> {
    const closed = new Set(
      record.events.flatMap((event) =>
        event.type === "tool.completed" ||
        event.type === "tool.failed" ||
        event.type === "tool.blocked" ||
        event.type === "tool.outcome_unknown"
          ? [event.toolCallId]
          : [],
      ),
    );
    return record.events.filter(
      (event): event is Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }> =>
        event.type === "tool.intent_persisted" && !closed.has(event.toolCallId),
    );
  }

  private assertNoOpenToolIntentsInRecord(record: OperationRecord): void {
    if (this.openToolIntents(record).length > 0) {
      throw new PiDirectExecutorOperationConflictError(
        "存在未闭合Tool Intent，禁止下一次Provider请求",
      );
    }
  }

  private requireActiveReview(record: OperationRecord): DirectActivePromptReview {
    if (record.activePromptReview === undefined) {
      throw new PiDirectExecutorOperationConflictError("Operation缺少活动Prompt Review");
    }
    return record.activePromptReview;
  }

  private appendToRecord(
    record: OperationRecord,
    payload: PiDirectExecutorEventPayload,
  ): OperationRecord {
    const timestamp = this.now().toISOString();
    const event = piDirectExecutorEventSchema.parse({
      ...payload,
      sequence: record.events.length + 1,
      timestamp,
    });
    return operationRecordSchema.parse({
      ...record,
      events: [...record.events, event],
      updatedAt: timestamp,
    });
  }

  private snapshot(record: OperationRecord): PiDirectExecutorOperationSnapshot {
    validateOperationRecord(record, this.legacyReadOnlyOperationIds.has(record.operationId));
    return piDirectExecutorOperationSnapshotSchema.parse({
      schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
      operationId: record.operationId,
      requestSha256: record.requestSha256,
      status: record.status,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.activePromptReview?.review !== undefined
        ? { activeReview: record.activePromptReview.review }
        : {}),
      ...(record.activePromptReview?.decision !== undefined
        ? { decision: record.activePromptReview.decision }
        : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      ...(record.resolvedRuntimeManifestSha256 === undefined
        ? {}
        : { resolvedRuntimeManifestSha256: record.resolvedRuntimeManifestSha256 }),
      ...(record.resolvedRuntimeManifest === undefined
        ? {}
        : { resolvedRuntimeManifest: record.resolvedRuntimeManifest }),
      ...(record.resolvedCapabilities === undefined
        ? {}
        : { resolvedCapabilities: record.resolvedCapabilities }),
      lastEventSequence: record.events.at(-1)?.sequence ?? 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private requireRecord(operationId: string): OperationRecord {
    piOperationIdSchema.parse(operationId);
    const record = this.records.get(operationId);
    if (record === undefined) throw new PiDirectExecutorOperationNotFoundError();
    return record;
  }

  private requireMutableRecord(record: OperationRecord | undefined): OperationRecord {
    if (record === undefined) throw new PiDirectExecutorOperationNotFoundError();
    if (this.legacyReadOnlyOperationIds.has(record.operationId)) {
      throw new PiDirectExecutorOperationConflictError(
        "Direct Operation v1仅只读兼容，不能以v2语义恢复或写入",
      );
    }
    return record;
  }

  private async persist(record: OperationRecord): Promise<void> {
    if (this.legacyReadOnlyOperationIds.has(record.operationId)) {
      throw new PiDirectExecutorOperationConflictError("Direct Operation v1禁止写入");
    }
    const parsed = operationRecordSchema.parse(record);
    validateOperationRecord(parsed, false);
    const target = join(this.directory, `${parsed.operationId}.json`);
    const temporary = join(this.directory, `.${parsed.operationId}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    this.records.set(parsed.operationId, parsed);
  }

  private async mutate<T>(
    operationId: string,
    mutation: (
      record: OperationRecord | undefined,
    ) => Promise<{ readonly record: OperationRecord; readonly value: T }>,
  ): Promise<T> {
    const previous = this.mutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.mutationTails.set(operationId, queued);
    await previous;
    try {
      const output = await mutation(this.records.get(operationId));
      await this.persist(output.record);
      return output.value;
    } finally {
      release();
      if (this.mutationTails.get(operationId) === queued) this.mutationTails.delete(operationId);
    }
  }
}
