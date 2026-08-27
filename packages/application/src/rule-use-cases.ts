import {
  RULES_API_SCHEMA_VERSION,
  ruleCommandResultDtoSchema,
  ruleDecisionDtoSchema,
  ruleDetailDtoSchema,
  ruleDetailResponseDtoSchema,
  rulePageDtoSchema,
  ruleRevisionDetailDtoSchema,
  ruleRevisionSchema,
  ruleSchema,
  ruleTagCommandResultDtoSchema,
  ruleTagDtoSchema,
  ruleTagSchema,
  ruleTagIdSchema,
  ruleIdSchema,
  ruleTagsDtoSchema,
  type CreateRulePayload,
  type CreateRuleTagPayload,
  type ListRulesQuery,
  type PrincipalId,
  type ReviseRulePayload,
  type Rule,
  type RuleDecision,
  type RuleDetailDto,
  type RuleId,
  type RuleRevision,
  type RuleRevisionDraftPayload,
  type RuleSummaryDto,
  type RuleTag,
  type RuleTagId,
  type TransitionRulePayload,
  type UpdateRuleTagPayload,
} from "@chat/contracts";
import {
  assertRuleLifecycleTransition,
  assertRuleRevisionAppend,
  computeRuleRevisionSha256,
  getAllowedRuleLifecycleTransitions,
  hashCanonical,
  RuleDomainError,
} from "@chat/domain";
import type { ApplicationDeps, RuleIdFactory } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";

type CommandId = Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];

function requireRuleIds(deps: ApplicationDeps): RuleIdFactory {
  if (deps.ruleIds === undefined) throw new Error("RuleIdFactory未配置，不能执行Rule用例");
  return deps.ruleIds;
}

function ownedRule(
  entities: { readonly rules: Record<string, Rule> },
  ruleId: RuleId,
  principalId: PrincipalId,
): Rule {
  const rule = entities.rules[ruleId];
  if (rule === undefined) throw notFound("Rule不存在");
  if (rule.ownerPrincipalId !== principalId) throw forbidden("无权访问该Rule");
  return rule;
}

function ownedTag(
  entities: { readonly ruleTags: Record<string, RuleTag> },
  ruleTagId: RuleTagId,
  principalId: PrincipalId,
): RuleTag {
  const tag = entities.ruleTags[ruleTagId];
  if (tag === undefined) throw notFound("Rule Tag不存在");
  if (tag.ownerPrincipalId !== principalId) throw forbidden("无权访问该Rule Tag");
  return tag;
}

function normalizeTagKey(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("und").replaceAll(/\s+/gu, "-");
}

function assertTagKeyAvailable(
  tags: Record<string, RuleTag>,
  principalId: PrincipalId,
  normalizedKey: string,
  except?: RuleTagId,
): void {
  if (
    Object.values(tags).some(
      (tag) =>
        tag.ownerPrincipalId === principalId &&
        tag.normalizedKey === normalizedKey &&
        tag.ruleTagId !== except,
    )
  ) {
    throw revisionConflict("同名Rule Tag已存在");
  }
}

function currentRevision(
  entities: { readonly ruleRevisions: Record<string, RuleRevision> },
  rule: Rule,
): RuleRevision {
  const revision = entities.ruleRevisions[rule.currentRevisionId];
  if (revision === undefined) throw notFound("Rule Revision不存在");
  return revision;
}

function allowedActions(rule: Rule): RuleSummaryDto["allowedActions"] {
  return [
    ...getAllowedRuleLifecycleTransitions(rule.lifecycle).map((target) => {
      if (target === "trial") return "start_trial" as const;
      if (target === "active") return "activate" as const;
      if (target === "weakened") return "weaken" as const;
      if (target === "disabled") return "disable" as const;
      return "reject" as const;
    }),
    "revise" as const,
  ];
}

function toRevisionDetail(revision: RuleRevision) {
  return ruleRevisionDetailDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleRevisionId: revision.ruleRevisionId,
    ruleId: revision.ruleId,
    revision: revision.revision,
    supersedesRevisionId: revision.supersedesRevisionId,
    supersedesRevisionSha256: revision.supersedesRevisionSha256,
    body: revision.body,
    rationale: revision.rationale,
    appliesWhen: revision.appliesWhen,
    doesNotApplyWhen: revision.doesNotApplyWhen,
    positiveExamples: revision.positiveExamples,
    negativeExamples: revision.negativeExamples,
    scopes: revision.scopes,
    tagIds: revision.tagIds,
    conflictsWithRuleIds: revision.conflictsWithRuleIds,
    risk: revision.risk,
    origin: revision.origin,
    sourceCases: revision.sourceCases,
    sha256: revision.sha256,
    createdAt: revision.createdAt,
  });
}

function toDetail(rule: Rule, revision: RuleRevision): RuleDetailDto {
  return ruleDetailDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleId: rule.ruleId,
    title: rule.title,
    lifecycle: rule.lifecycle,
    enforcement: rule.enforcement,
    priority: rule.priority,
    currentRevision: toRevisionDetail(revision),
    allowedActions: allowedActions(rule),
    revision: rule.revision,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  });
}

function toSummary(rule: Rule, revision: RuleRevision): RuleSummaryDto {
  return {
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleId: rule.ruleId,
    title: rule.title,
    lifecycle: rule.lifecycle,
    enforcement: rule.enforcement,
    priority: rule.priority,
    currentRevision: {
      schemaVersion: RULES_API_SCHEMA_VERSION,
      ruleRevisionId: revision.ruleRevisionId,
      revision: revision.revision,
      sha256: revision.sha256,
      risk: revision.risk,
      scopes: revision.scopes,
      tagIds: revision.tagIds,
      conflictsWithRuleIds: revision.conflictsWithRuleIds,
      createdAt: revision.createdAt,
    },
    allowedActions: allowedActions(rule),
    revision: rule.revision,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function toTagDto(tag: RuleTag) {
  return ruleTagDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleTagId: tag.ruleTagId,
    name: tag.name,
    normalizedKey: tag.normalizedKey,
    description: tag.description,
    status: tag.status,
    revision: tag.revision,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  });
}

function buildRevision(input: {
  readonly ids: RuleIdFactory;
  readonly ruleId: RuleId;
  readonly revisionNumber: number;
  readonly payload: RuleRevisionDraftPayload;
  readonly principalId: PrincipalId;
  readonly createdAt: string;
  readonly supersedesRevisionId?: RuleRevision["ruleRevisionId"];
  readonly supersedesRevisionSha256?: string;
}): RuleRevision {
  const draft = {
    ruleId: input.ruleId,
    revision: input.revisionNumber,
    ...(input.supersedesRevisionId !== undefined
      ? { supersedesRevisionId: input.supersedesRevisionId }
      : {}),
    ...(input.supersedesRevisionSha256 !== undefined
      ? { supersedesRevisionSha256: input.supersedesRevisionSha256 }
      : {}),
    body: input.payload.body,
    rationale: input.payload.rationale,
    appliesWhen: input.payload.appliesWhen,
    doesNotApplyWhen: input.payload.doesNotApplyWhen,
    positiveExamples: input.payload.positiveExamples,
    negativeExamples: input.payload.negativeExamples,
    scopes: input.payload.scopes.map((scope) => ({
      schemaVersion: "rule-scope.v1" as const,
      ruleScopeId: input.ids.scope(),
      ...scope,
    })),
    tagIds: [...new Set(input.payload.tagIds)].sort(),
    conflictsWithRuleIds: [...new Set(input.payload.conflictsWithRuleIds)].sort(),
    risk: input.payload.risk,
    origin: { kind: "user_authored" as const, principalId: input.principalId },
    sourceCases: input.payload.sourceCases,
  };
  return ruleRevisionSchema.parse({
    schemaVersion: "rule-revision.v1",
    ruleRevisionId: input.ids.revision(),
    ...draft,
    sha256: computeRuleRevisionSha256(draft),
    createdAt: input.createdAt,
  });
}

function assertRevisionRefsAuthorized(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  principalId: PrincipalId,
  payload: RuleRevisionDraftPayload,
): void {
  if (
    new Set(payload.tagIds).size !== payload.tagIds.length ||
    new Set(payload.conflictsWithRuleIds).size !== payload.conflictsWithRuleIds.length
  ) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Rule Revision不能包含重复Tag或冲突Rule",
    });
  }
  for (const tagId of payload.tagIds) {
    const tag = snapshot.entities.ruleTags[tagId];
    if (tag === undefined) throw notFound("Rule Tag不存在");
    if (tag.ownerPrincipalId !== principalId) throw forbidden("Rule Tag越权");
    if (tag.status !== "active") throw revisionConflict("Rule Tag已归档");
  }
  for (const conflictId of payload.conflictsWithRuleIds) {
    ownedRule(snapshot.entities, conflictId, principalId);
  }
  for (const source of payload.sourceCases) {
    const owner =
      source.kind === "message"
        ? snapshot.entities.sessions[snapshot.entities.messages[source.messageId]?.sessionId ?? ""]
            ?.ownerPrincipalId
        : snapshot.entities.sessions[snapshot.entities.runs[source.productRunId]?.sessionId ?? ""]
            ?.ownerPrincipalId;
    if (owner === undefined) throw notFound("Rule Source Case不存在");
    if (owner !== principalId) throw forbidden("Rule Source Case越权");
  }
}

export async function listRules(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly query: ListRulesQuery },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const rows = Object.values(snapshot.entities.rules)
    .filter((rule) => rule.ownerPrincipalId === input.principalId)
    .map((rule) => ({ rule, revision: currentRevision(snapshot.entities, rule) }))
    .filter(({ rule }) =>
      input.query.lifecycle === undefined ? true : rule.lifecycle === input.query.lifecycle,
    )
    .filter(({ revision }) =>
      input.query.tagId === undefined ? true : revision.tagIds.includes(input.query.tagId),
    )
    .filter(({ revision }) =>
      input.query.scenario === undefined
        ? true
        : revision.scopes.some(
            (scope) => scope.kind === "global" || scope.scenario === input.query.scenario,
          ),
    )
    .sort((left, right) =>
      right.rule.updatedAt === left.rule.updatedAt
        ? left.rule.ruleId.localeCompare(right.rule.ruleId)
        : right.rule.updatedAt.localeCompare(left.rule.updatedAt),
    );
  const cursorIndex =
    input.query.cursor === undefined
      ? undefined
      : rows.findIndex(({ rule }) => `${rule.updatedAt}|${rule.ruleId}` === input.query.cursor);
  if (cursorIndex === -1) throw revisionConflict("Rule列表cursor已过期");
  const start = cursorIndex === undefined ? 0 : cursorIndex + 1;
  const items = rows.slice(start, start + input.query.limit);
  const next = rows[start + input.query.limit];
  return rulePageDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    items: items.map(({ rule, revision }) => toSummary(rule, revision)),
    ...(next !== undefined
      ? { nextCursor: `${items.at(-1)!.rule.updatedAt}|${items.at(-1)!.rule.ruleId}` }
      : {}),
  });
}

export async function getRule(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly ruleId: RuleId },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const rule = ownedRule(snapshot.entities, input.ruleId, input.principalId);
  const decisions = Object.values(snapshot.entities.ruleDecisions)
    .filter((decision) => decision.ruleId === rule.ruleId)
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  return ruleDetailResponseDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    rule: toDetail(rule, currentRevision(snapshot.entities, rule)),
    decisions: decisions.map((decision) => toDecisionDto(decision)),
  });
}

function toDecisionDto(decision: RuleDecision) {
  return ruleDecisionDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    ruleDecisionId: decision.ruleDecisionId,
    ruleId: decision.ruleId,
    boundRevisionId: decision.boundRevisionId,
    boundRevisionSha256: decision.boundRevisionSha256,
    fromLifecycle: decision.fromLifecycle,
    toLifecycle: decision.toLifecycle,
    actor: decision.actor,
    reason: decision.reason,
    decidedAt: decision.decidedAt,
  });
}

export async function createRule(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreateRulePayload;
  },
) {
  const ids = requireRuleIds(deps);
  const now = deps.now();
  const ruleId = ids.rule();
  const revision = buildRevision({
    ids,
    ruleId,
    revisionNumber: 1,
    payload: input.payload.revision,
    principalId: input.principalId,
    createdAt: now,
  });
  const requestSha256 = hashCanonical("command.create-rule.v1", input.payload);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateRule",
    requestSha256,
    mutate: (draft) => {
      assertRevisionRefsAuthorized(draft, input.principalId, input.payload.revision);
      draft.entities.ruleRevisions[revision.ruleRevisionId] = revision;
      draft.entities.rules[ruleId] = ruleSchema.parse({
        schemaVersion: "rule.v1",
        ruleId,
        ownerPrincipalId: input.principalId,
        title: input.payload.title,
        lifecycle: "candidate",
        enforcement: "user_selectable",
        priority: input.payload.priority,
        currentRevisionId: revision.ruleRevisionId,
        currentRevisionNumber: 1,
        currentRevisionSha256: revision.sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      return { resultRefs: { ruleId, ruleRevisionId: revision.ruleRevisionId } };
    },
  });
  return readRuleCommandResult(deps, result, input.principalId);
}

export async function reviseRule(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly ruleId: RuleId;
    readonly expectedRevision: number;
    readonly payload: ReviseRulePayload;
  },
) {
  const ids = requireRuleIds(deps);
  const preflight = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const currentRule = ownedRule(preflight.entities, input.ruleId, input.principalId);
  const previous = currentRevision(preflight.entities, currentRule);
  const now = deps.now();
  const next = buildRevision({
    ids,
    ruleId: input.ruleId,
    revisionNumber: previous.revision + 1,
    payload: input.payload.revision,
    principalId: input.principalId,
    createdAt: now,
    supersedesRevisionId: previous.ruleRevisionId,
    supersedesRevisionSha256: previous.sha256,
  });
  const requestSha256 = hashCanonical("command.revise-rule.v1", {
    ruleId: input.ruleId,
    expectedRevision: input.expectedRevision,
    payload: input.payload,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ReviseRule",
    requestSha256,
    mutate: (draft) => {
      const rule = ownedRule(draft.entities, input.ruleId, input.principalId);
      const current = currentRevision(draft.entities, rule);
      if (rule.revision !== input.expectedRevision) throw revisionConflict("Rule已被更新");
      if (
        current.ruleRevisionId !== input.payload.currentRevisionId ||
        current.sha256 !== input.payload.currentRevisionSha256
      ) {
        throw revisionConflict("Rule Revision已变化");
      }
      assertRevisionRefsAuthorized(draft, input.principalId, input.payload.revision);
      assertRuleRevisionAppend({ current, next });
      draft.entities.ruleRevisions[next.ruleRevisionId] = next;
      draft.entities.rules[rule.ruleId] = {
        ...rule,
        title: input.payload.title ?? rule.title,
        currentRevisionId: next.ruleRevisionId,
        currentRevisionNumber: next.revision,
        currentRevisionSha256: next.sha256,
        revision: rule.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { ruleId: rule.ruleId, ruleRevisionId: next.ruleRevisionId } };
    },
  });
  return readRuleCommandResult(deps, result, input.principalId);
}

export async function transitionRuleLifecycle(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly ruleId: RuleId;
    readonly expectedRevision: number;
    readonly payload: TransitionRulePayload;
  },
) {
  const ids = requireRuleIds(deps);
  const decisionId = ids.decision();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.transition-rule-lifecycle.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionRuleLifecycle",
    requestSha256,
    mutate: (draft) => {
      const rule = ownedRule(draft.entities, input.ruleId, input.principalId);
      const revision = currentRevision(draft.entities, rule);
      if (rule.revision !== input.expectedRevision) throw revisionConflict("Rule已被更新");
      if (
        revision.ruleRevisionId !== input.payload.boundRevisionId ||
        revision.sha256 !== input.payload.boundRevisionSha256
      ) {
        throw revisionConflict("Rule Revision已变化");
      }
      const actor = { kind: "principal" as const, principalId: input.principalId };
      try {
        assertRuleLifecycleTransition({
          from: rule.lifecycle,
          to: input.payload.toLifecycle,
          enforcement: rule.enforcement,
          actor,
          reason: input.payload.reason,
        });
      } catch (error) {
        if (error instanceof RuleDomainError) {
          throw new ApplicationError({
            code: "policy_denied",
            httpStatus: 422,
            message: error.message,
          });
        }
        throw error;
      }
      draft.entities.ruleDecisions[decisionId] = {
        schemaVersion: "rule-decision.v1",
        ruleDecisionId: decisionId,
        ruleId: rule.ruleId,
        boundRevisionId: revision.ruleRevisionId,
        boundRevisionSha256: revision.sha256,
        expectedRuleRevision: input.expectedRevision,
        fromLifecycle: rule.lifecycle,
        toLifecycle: input.payload.toLifecycle,
        actor,
        reason: input.payload.reason,
        commandId: input.commandId,
        decidedAt: now,
      };
      draft.entities.rules[rule.ruleId] = {
        ...rule,
        lifecycle: input.payload.toLifecycle,
        latestDecisionId: decisionId,
        revision: rule.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { ruleId: rule.ruleId, ruleDecisionId: decisionId } };
    },
  });
  return readRuleCommandResult(deps, result, input.principalId);
}

async function readRuleCommandResult(
  deps: ApplicationDeps,
  result: Awaited<ReturnType<ApplicationDeps["store"]["transact"]>>,
  principalId: PrincipalId,
) {
  const detail = await getRule(deps, {
    principalId,
    ruleId: ruleIdSchema.parse(result.resultRefs["ruleId"]),
  });
  return ruleCommandResultDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    rule: detail.rule,
    replayed: result.replayed,
  });
}

export async function listRuleTags(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return ruleTagsDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    items: Object.values(snapshot.entities.ruleTags)
      .filter((tag) => tag.ownerPrincipalId === input.principalId)
      .sort((left, right) => left.normalizedKey.localeCompare(right.normalizedKey))
      .map(toTagDto),
  });
}

export async function createRuleTag(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreateRuleTagPayload;
  },
) {
  const ids = requireRuleIds(deps);
  const ruleTagId = ids.tag();
  return mutateTag(deps, {
    commandId: input.commandId,
    commandType: "CreateRuleTag",
    requestSha256: hashCanonical("command.create-rule-tag.v1", input.payload),
    principalId: input.principalId,
    ruleTagId,
    mutate: (draft, now) => {
      const normalizedKey = normalizeTagKey(input.payload.name);
      assertTagKeyAvailable(draft.entities.ruleTags, input.principalId, normalizedKey);
      draft.entities.ruleTags[ruleTagId] = ruleTagSchema.parse({
        schemaVersion: "rule-tag.v1",
        ruleTagId,
        ownerPrincipalId: input.principalId,
        name: input.payload.name,
        normalizedKey,
        ...(input.payload.description !== undefined
          ? { description: input.payload.description }
          : {}),
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    },
  });
}

export async function updateRuleTag(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly ruleTagId: RuleTagId;
    readonly expectedRevision: number;
    readonly payload: UpdateRuleTagPayload;
  },
) {
  return mutateTag(deps, {
    commandId: input.commandId,
    commandType: "UpdateRuleTag",
    requestSha256: hashCanonical("command.update-rule-tag.v1", input),
    principalId: input.principalId,
    ruleTagId: input.ruleTagId,
    mutate: (draft, now) => {
      const tag = ownedTag(draft.entities, input.ruleTagId, input.principalId);
      if (tag.revision !== input.expectedRevision) throw revisionConflict("Rule Tag已被更新");
      if (tag.status !== "active") throw revisionConflict("已归档Rule Tag不能修改");
      const normalizedKey = normalizeTagKey(input.payload.name);
      assertTagKeyAvailable(
        draft.entities.ruleTags,
        input.principalId,
        normalizedKey,
        tag.ruleTagId,
      );
      const nextTag = {
        ...tag,
        name: input.payload.name,
        normalizedKey,
        revision: tag.revision + 1,
        updatedAt: now,
      };
      if (input.payload.description === undefined) delete nextTag.description;
      else nextTag.description = input.payload.description;
      draft.entities.ruleTags[tag.ruleTagId] = nextTag;
    },
  });
}

export async function archiveRuleTag(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly ruleTagId: RuleTagId;
    readonly expectedRevision: number;
  },
) {
  return mutateTag(deps, {
    commandId: input.commandId,
    commandType: "ArchiveRuleTag",
    requestSha256: hashCanonical("command.archive-rule-tag.v1", input),
    principalId: input.principalId,
    ruleTagId: input.ruleTagId,
    mutate: (draft, now) => {
      const tag = ownedTag(draft.entities, input.ruleTagId, input.principalId);
      if (tag.revision !== input.expectedRevision) throw revisionConflict("Rule Tag已被更新");
      draft.entities.ruleTags[tag.ruleTagId] = {
        ...tag,
        status: "archived",
        revision: tag.revision + 1,
        updatedAt: now,
      };
    },
  });
}

async function mutateTag(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly commandType: "CreateRuleTag" | "UpdateRuleTag" | "ArchiveRuleTag";
    readonly requestSha256: string;
    readonly principalId: PrincipalId;
    readonly ruleTagId: RuleTagId;
    readonly mutate: (
      draft: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
      now: string,
    ) => void;
  },
) {
  const now = deps.now();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: input.commandType,
    requestSha256: input.requestSha256,
    mutate: (draft) => {
      input.mutate(draft, now);
      return { resultRefs: { ruleTagId: input.ruleTagId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const persistedTagId = result.resultRefs["ruleTagId"];
  if (persistedTagId === undefined) throw notFound("Rule Tag命令结果不存在");
  const tag = ownedTag(snapshot.entities, ruleTagIdSchema.parse(persistedTagId), input.principalId);
  return ruleTagCommandResultDtoSchema.parse({
    schemaVersion: RULES_API_SCHEMA_VERSION,
    tag: toTagDto(tag),
    replayed: result.replayed,
  });
}
