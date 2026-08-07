import { hashCanonical } from "@chat/domain";
import type {
  CreateSessionPayload,
  Message,
  PrincipalId,
  ProductRun,
  ProductSession,
  ProductSessionId,
  SessionDto,
  SubmitMessagePayload,
} from "@chat/contracts";
import { DEFAULT_MAX_PLAN_REVISIONS, type ApplicationDeps } from "./deps.js";
import { toMessageDto, toRunDto, toSessionDto } from "./dto.js";
import { forbidden, notFound } from "./errors.js";
import type { MessageDto, RunDto } from "@chat/contracts";

/**
 * CreateProductSession / SubmitUserMessage用例。
 *
 * 事务边界（任务书§8.1、§9.2）：
 * - 一次Message Command原子提交User Message + Product Run + Command Receipt +
 *   Workflow Start Outbox；任一步失败三者都不提交。
 * - 一个Message Command最多创建一个User Message和一个Product Run。
 * - Workflow Start在事务外由Outbox派发（M2接入）；M1只形成pending Outbox事实。
 */

export interface CreateProductSessionInput {
  readonly principalId: PrincipalId;
  readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
  readonly payload: CreateSessionPayload;
}

export async function createProductSession(
  deps: ApplicationDeps,
  input: CreateProductSessionInput,
): Promise<{ session: SessionDto }> {
  const now = deps.now();
  const sessionId = deps.ids.session();
  const requestSha256 = hashCanonical("command.create-product-session.v1", {
    principalId: input.principalId,
    payload: input.payload,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateProductSession",
    requestSha256,
    mutate: (draft) => {
      const session: ProductSession = {
        schemaVersion: "product-session.v1",
        sessionId,
        ownerPrincipalId: input.principalId,
        status: "active",
        ...(input.payload.title !== undefined ? { title: input.payload.title } : {}),
        lastMessageSequence: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.sessions[sessionId] = session;
      return { resultRefs: { sessionId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const session = snapshot.entities.sessions[result.resultRefs["sessionId"] ?? ""];
  if (session === undefined) throw notFound("Session不存在");
  return { session: toSessionDto(session) };
}

export interface SubmitUserMessageInput {
  readonly principalId: PrincipalId;
  readonly sessionId: ProductSessionId;
  readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
  readonly payload: SubmitMessagePayload;
}

export async function submitUserMessage(
  deps: ApplicationDeps,
  input: SubmitUserMessageInput,
): Promise<{ message: MessageDto; run: RunDto }> {
  const now = deps.now();
  const messageId = deps.ids.message();
  const productRunId = deps.ids.run();
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.submit-user-message.v1", {
    principalId: input.principalId,
    sessionId: input.sessionId,
    payload: input.payload,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SubmitUserMessage",
    requestSha256,
    mutate: (draft) => {
      const session = draft.entities.sessions[input.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      if (session.ownerPrincipalId !== input.principalId) {
        throw forbidden("无权向该Session发送消息");
      }
      const sessionSequence = session.lastMessageSequence + 1;
      const message: Message = {
        schemaVersion: "message.v1",
        messageId,
        sessionId: input.sessionId,
        sessionSequence,
        role: "user",
        content: { format: "markdown", text: input.payload.text },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const run: ProductRun = {
        schemaVersion: "product-run.v1",
        productRunId,
        sessionId: input.sessionId,
        sourceMessageId: messageId,
        status: "pending",
        phase: "queued",
        maxPlanRevisions: DEFAULT_MAX_PLAN_REVISIONS,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.messages[messageId] = message;
      draft.entities.runs[productRunId] = run;
      draft.entities.sessions[input.sessionId] = {
        ...session,
        lastMessageSequence: sessionSequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      // Workflow Start Outbox与产品事实同一次快照提交；不含任何Runtime私有身份
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "workflow_start",
        status: "pending",
        productRunId,
        dispatchAttempts: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { messageId, productRunId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const message = snapshot.entities.messages[result.resultRefs["messageId"] ?? ""];
  const run = snapshot.entities.runs[result.resultRefs["productRunId"] ?? ""];
  if (message === undefined || run === undefined) throw notFound("消息或运行不存在");
  return { message: toMessageDto(message), run: toRunDto(run, undefined, undefined) };
}
