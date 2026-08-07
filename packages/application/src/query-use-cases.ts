import type {
  ApprovalDto,
  CursorPage,
  MessageDto,
  PlanDto,
  PrincipalId,
  ProductRunId,
  ProductSessionId,
  RunDto,
  SessionDto,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { toApprovalDto, toMessageDto, toPlanDto, toRunDto, toSessionDto } from "./dto.js";
import { ApplicationError, forbidden, notFound } from "./errors.js";

/**
 * 查询用例。
 *
 * 规则（任务书§12.3）：
 * - Message列表按服务端cursor分页，顺序只由sessionSequence决定。
 * - Query返回revision、updatedAt和允许的动作；不返回Runtime私有身份。
 * - cursor不透明：客户端不得解析或构造；非法cursor以validation_failed拒绝。
 */

function assertSessionAccess(
  deps: ApplicationDeps,
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  sessionId: ProductSessionId,
  principalId: PrincipalId,
) {
  const session = snapshot.entities.sessions[sessionId];
  if (session === undefined) throw notFound("Session不存在");
  if (session.ownerPrincipalId !== principalId) throw forbidden("无权访问该Session");
  return session;
}

export async function getSession(
  deps: ApplicationDeps,
  input: { principalId: PrincipalId; sessionId: ProductSessionId },
): Promise<{ session: SessionDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const session = assertSessionAccess(deps, snapshot, input.sessionId, input.principalId);
  return { session: toSessionDto(session) };
}

const CURSOR_PREFIX = "seq:";

function encodeCursor(sessionSequence: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${String(sessionSequence)}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "非法分页cursor",
    });
  }
  let text: string;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical cursor");
    text = bytes.toString("utf8");
  } catch {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "非法分页cursor",
    });
  }
  const match = /^seq:(0|[1-9][0-9]*)$/u.exec(text);
  if (match === null) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "非法分页cursor",
    });
  }
  const seq = Number(match[1]);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "非法分页cursor",
    });
  }
  return seq;
}

export async function getSessionMessages(
  deps: ApplicationDeps,
  input: {
    principalId: PrincipalId;
    sessionId: ProductSessionId;
    cursor?: string | undefined;
    limit?: number | undefined;
  },
): Promise<{ messages: CursorPage<MessageDto> }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  assertSessionAccess(deps, snapshot, input.sessionId, input.principalId);
  const afterSeq = input.cursor !== undefined ? decodeCursor(input.cursor) : 0;
  const limit = input.limit ?? 50;
  const ordered = Object.values(snapshot.entities.messages)
    .filter((message) => message.sessionId === input.sessionId)
    .sort((a, b) => a.sessionSequence - b.sessionSequence);
  const page = ordered.filter((message) => message.sessionSequence > afterSeq).slice(0, limit + 1);
  const items = page.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = page.length > limit;
  return {
    messages: {
      items: items.map(toMessageDto),
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last.sessionSequence) } : {}),
    },
  };
}

function loadRunContext(
  deps: ApplicationDeps,
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  productRunId: ProductRunId,
  principalId: PrincipalId,
) {
  const run = snapshot.entities.runs[productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  assertSessionAccess(deps, snapshot, run.sessionId, principalId);
  const currentPlan = Object.values(snapshot.entities.plans).find(
    (plan) =>
      run.currentPlanId !== undefined &&
      plan.planId === run.currentPlanId &&
      plan.planRevision === run.currentPlanRevision,
  );
  const persistedApproval =
    run.currentApprovalRequestId !== undefined
      ? snapshot.entities.approvalRequests[run.currentApprovalRequestId]
      : undefined;
  // Query不改写产品事实，但必须按当前时间明确投影过期状态，防止浏览器继续呈现可操作按钮。
  const currentApproval =
    persistedApproval?.status === "open" &&
    Date.parse(deps.now()) >= Date.parse(persistedApproval.expiresAt)
      ? { ...persistedApproval, status: "expired" as const }
      : persistedApproval;
  return { run, currentPlan, currentApproval };
}

export async function getProductRun(
  deps: ApplicationDeps,
  input: { principalId: PrincipalId; productRunId: ProductRunId },
): Promise<{ run: RunDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const { run, currentPlan, currentApproval } = loadRunContext(
    deps,
    snapshot,
    input.productRunId,
    input.principalId,
  );
  return { run: toRunDto(run, currentPlan, currentApproval) };
}

export async function getRunPlans(
  deps: ApplicationDeps,
  input: { principalId: PrincipalId; productRunId: ProductRunId },
): Promise<{ plans: PlanDto[] }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  loadRunContext(deps, snapshot, input.productRunId, input.principalId);
  const plans = Object.values(snapshot.entities.plans)
    .filter((plan) => plan.productRunId === input.productRunId)
    .sort((a, b) => a.planRevision - b.planRevision)
    .map(toPlanDto);
  return { plans };
}

export async function getCurrentApproval(
  deps: ApplicationDeps,
  input: { principalId: PrincipalId; productRunId: ProductRunId },
): Promise<{ approval: ApprovalDto | null }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const { currentApproval } = loadRunContext(deps, snapshot, input.productRunId, input.principalId);
  return { approval: currentApproval !== undefined ? toApprovalDto(currentApproval) : null };
}
