import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  apiCreateSession,
  apiGetCurrentApproval,
  apiGetMessages,
  apiGetPlans,
  apiGetRun,
  apiSubmitDecision,
  apiSubmitMessage,
  ApiProblemError,
} from "../api/client.js";
import {
  clearBootstrapCommand,
  clearActiveRunId,
  clearPendingDecision,
  clearPendingSend,
  readActiveRunId,
  readBootstrapCommand,
  readPendingDecision,
  readPendingSend,
  readStoredSession,
  writeActiveRunId,
  writeBootstrapCommand,
  writePendingDecision,
  writePendingSend,
  writeStoredSession,
  type PendingDecision,
  type PendingSend,
} from "./real-storage.js";
import type {
  ApprovalDto,
  CommandId,
  CursorPage,
  MessageDto,
  PlanDto,
  ProductRunId,
  RunDto,
  SubmitDecisionPayload,
} from "@chat/contracts/public";

/**
 * 真实规划—确认—执行链的浏览器状态投影。
 *
 * 规则（任务书§15）：
 * - 浏览器只持有投影、未提交草稿与公开定位ID；权威状态全部来自Query。
 * - 活动Run使用受控短轮询；终态或页面不可见时停止。
 * - Command成功后使相关Query失效并重新读取权威状态。
 * - 网络结果未知时保留相同commandId供用户手动重试，不产生localOnly成功。
 */

const ACTIVE_RUN_REFETCH_MS = 1_500;
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"]);

function newCommandId(): CommandId {
  return `cmd_${crypto.randomUUID().replaceAll("-", "")}` as CommandId;
}

function recoveredPendingError(): ApiProblemError {
  return new ApiProblemError({
    code: "network_unknown",
    retryable: true,
    recoveryAction: "retry_same_command",
  });
}

export interface RealChainState {
  readonly bootstrapping: boolean;
  readonly bootstrapError: ApiProblemError | null;
  readonly sessionId: string | null;
  readonly activeRunId: string | null;
  readonly messages: UseQueryResult<CursorPage<MessageDto>>;
  readonly run: UseQueryResult<RunDto>;
  readonly plans: UseQueryResult<PlanDto[]>;
  readonly approval: UseQueryResult<ApprovalDto | null>;
  readonly pendingSend: PendingSend | null;
  /** B2首版一个Session同一时刻只允许一个未终态Run。 */
  readonly canStartNewRun: boolean;
  readonly sendMessage: (text: string) => void;
  readonly retryPendingSend: () => void;
  readonly sending: boolean;
  readonly sendError: ApiProblemError | null;
  readonly submitDecision: (input: {
    payload: SubmitDecisionPayload;
    expectedRunRevision: number;
  }) => void;
  readonly deciding: boolean;
  readonly decisionError: ApiProblemError | null;
  readonly pendingDecision: PendingDecision | null;
  readonly retryPendingDecision: () => void;
  readonly clearDecisionError: () => void;
  readonly clearStaleActiveRun: () => void;
}

export function useRealChain(storage: Storage, options?: { refetchMs?: number }): RealChainState {
  const queryClient = useQueryClient();
  const refetchMs = options?.refetchMs ?? ACTIVE_RUN_REFETCH_MS;
  const [sessionId, setSessionId] = useState<string | null>(
    () => readStoredSession(storage)?.sessionId ?? null,
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(() => {
    const stored = readStoredSession(storage);
    return stored !== null ? readActiveRunId(storage, stored.sessionId) : null;
  });
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(() => {
    const stored = readStoredSession(storage);
    return stored !== null ? readPendingSend(storage, stored.sessionId) : null;
  });
  const [sendError, setSendError] = useState<ApiProblemError | null>(() =>
    pendingSend === null ? null : recoveredPendingError(),
  );
  const [pendingDecision, setPendingDecision] = useState<PendingDecision | null>(() => {
    const stored = readStoredSession(storage);
    const runId = stored === null ? null : readActiveRunId(storage, stored.sessionId);
    return runId === null ? null : readPendingDecision(storage, runId);
  });
  const [decisionError, setDecisionError] = useState<ApiProblemError | null>(() =>
    pendingDecision === null ? null : recoveredPendingError(),
  );

  // 首次使用：无本地Session定位时，用稳定bootstrapCommandId幂等创建真实Session
  const bootstrap = useQuery({
    queryKey: ["real-session-bootstrap"],
    enabled: sessionId === null,
    queryFn: async () => {
      const stored = readStoredSession(storage);
      const commandId =
        stored?.bootstrapCommandId ?? readBootstrapCommand(storage) ?? newCommandId();
      writeBootstrapCommand(storage, commandId);
      const session = await apiCreateSession(commandId);
      writeStoredSession(storage, {
        version: 1,
        sessionId: session.sessionId,
        bootstrapCommandId: commandId,
      });
      clearBootstrapCommand(storage);
      return session.sessionId;
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (bootstrap.isSuccess && sessionId === null) {
      setSessionId(bootstrap.data);
    }
  }, [bootstrap.isSuccess, bootstrap.data, sessionId]);

  useEffect(() => {
    setPendingDecision(activeRunId === null ? null : readPendingDecision(storage, activeRunId));
  }, [activeRunId, storage]);

  const run = useQuery({
    queryKey: ["real-run", activeRunId],
    enabled: activeRunId !== null,
    queryFn: () => apiGetRun(activeRunId ?? ""),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status !== undefined && TERMINAL_STATUSES.has(status)) return false;
      return refetchMs;
    },
    refetchIntervalInBackground: false,
  });

  const messages = useQuery({
    queryKey: ["real-messages", sessionId],
    enabled: sessionId !== null,
    queryFn: () => apiGetMessages(sessionId ?? ""),
    refetchInterval: () => {
      if (activeRunId === null) return false;
      const status = run.data?.status;
      if (status !== undefined && TERMINAL_STATUSES.has(status)) return false;
      return refetchMs;
    },
    refetchIntervalInBackground: false,
  });

  const plans = useQuery({
    queryKey: ["real-plans", activeRunId],
    enabled: activeRunId !== null,
    queryFn: () => apiGetPlans(activeRunId ?? ""),
    refetchInterval: (query) => {
      void query;
      const status = run.data?.status;
      if (status !== undefined && TERMINAL_STATUSES.has(status)) return false;
      return refetchMs;
    },
    refetchIntervalInBackground: false,
  });

  const approval = useQuery({
    queryKey: ["real-approval", activeRunId],
    enabled: activeRunId !== null,
    queryFn: () => apiGetCurrentApproval(activeRunId ?? ""),
    refetchInterval: () => {
      const status = run.data?.status;
      if (status !== undefined && TERMINAL_STATUSES.has(status)) return false;
      return refetchMs;
    },
    refetchIntervalInBackground: false,
  });

  const invalidateRunScoped = (runId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["real-messages"] });
    void queryClient.invalidateQueries({ queryKey: ["real-run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["real-plans", runId] });
    void queryClient.invalidateQueries({ queryKey: ["real-approval", runId] });
  };

  // 终态到达时再刷新一次正式消息与最终Plan；之后停止轮询。
  useEffect(() => {
    const status = run.data?.status;
    if (status === undefined || !TERMINAL_STATUSES.has(status) || sessionId === null) return;
    void queryClient.invalidateQueries({ queryKey: ["real-messages", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["real-plans", activeRunId] });
    void queryClient.invalidateQueries({ queryKey: ["real-approval", activeRunId] });
  }, [activeRunId, queryClient, run.data?.status, sessionId]);

  const sendMutation = useMutation({
    mutationFn: async (pending: PendingSend) => {
      if (sessionId === null) throw new Error("session not ready");
      return apiSubmitMessage(sessionId, pending.commandId, pending.text);
    },
    onSuccess: (result) => {
      if (sessionId !== null) {
        clearPendingSend(storage, sessionId);
        writeActiveRunId(storage, sessionId, result.run.productRunId);
      }
      setPendingSend(null);
      setSendError(null);
      setActiveRunId(result.run.productRunId);
      setPendingDecision(readPendingDecision(storage, result.run.productRunId));
      invalidateRunScoped(result.run.productRunId);
    },
    onError: (error) => {
      setSendError(error instanceof ApiProblemError ? error : null);
    },
  });

  const sendMessage = (text: string) => {
    const activeRunIsUnfinished =
      activeRunId !== null && (run.data === undefined || !TERMINAL_STATUSES.has(run.data.status));
    if (
      sessionId === null ||
      sendMutation.isPending ||
      pendingSend !== null ||
      activeRunIsUnfinished
    ) {
      return;
    }
    const pending: PendingSend = { version: 1, text, commandId: newCommandId() };
    writePendingSend(storage, sessionId, pending);
    setPendingSend(pending);
    setSendError(null);
    sendMutation.mutate(pending);
  };

  const retryPendingSend = () => {
    if (pendingSend === null || sendMutation.isPending) return;
    sendMutation.mutate(pendingSend);
  };

  const decisionMutation = useMutation({
    mutationFn: async (input: PendingDecision) => {
      return apiSubmitDecision({
        productRunId: input.productRunId,
        commandId: input.commandId,
        expectedRunRevision: input.expectedRunRevision,
        payload: input.payload,
      });
    },
    onSuccess: (result) => {
      clearPendingDecision(storage, result.run.productRunId);
      setPendingDecision(null);
      setDecisionError(null);
      invalidateRunScoped(result.run.productRunId);
    },
    onError: (error, submitted) => {
      const problem = error instanceof ApiProblemError ? error : null;
      if (problem?.recoveryAction !== "retry_same_command") {
        clearPendingDecision(storage, submitted.productRunId);
        setPendingDecision(null);
      }
      setDecisionError(problem);
    },
  });

  const beginDecision = (input: {
    payload: SubmitDecisionPayload;
    expectedRunRevision: number;
  }): void => {
    if (activeRunId === null || decisionMutation.isPending || pendingDecision !== null) return;
    const pending: PendingDecision = {
      version: 1,
      productRunId: activeRunId as ProductRunId,
      commandId: newCommandId(),
      expectedRunRevision: input.expectedRunRevision,
      payload: input.payload,
    };
    writePendingDecision(storage, pending);
    setPendingDecision(pending);
    setDecisionError(null);
    decisionMutation.mutate(pending);
  };

  const state = useMemo<RealChainState>(() => {
    const activeRunIsUnfinished =
      activeRunId !== null && (run.data === undefined || !TERMINAL_STATUSES.has(run.data.status));
    return {
      bootstrapping: sessionId === null && bootstrap.isPending,
      bootstrapError:
        bootstrap.error instanceof ApiProblemError
          ? bootstrap.error
          : sessionId === null && bootstrap.isError
            ? new ApiProblemError({
                code: "network_unknown",
                retryable: true,
                recoveryAction: "retry_same_command",
              })
            : null,
      sessionId,
      activeRunId,
      messages,
      run,
      plans,
      approval,
      pendingSend,
      canStartNewRun: pendingSend === null && !sendMutation.isPending && !activeRunIsUnfinished,
      sendMessage,
      retryPendingSend,
      sending: sendMutation.isPending,
      sendError,
      submitDecision: beginDecision,
      deciding: decisionMutation.isPending,
      decisionError,
      pendingDecision,
      retryPendingDecision: () => {
        if (pendingDecision === null || decisionMutation.isPending) return;
        setDecisionError(null);
        decisionMutation.mutate(pendingDecision);
      },
      clearDecisionError: () => setDecisionError(null),
      clearStaleActiveRun: () => {
        if (sessionId !== null) clearActiveRunId(storage, sessionId);
        setActiveRunId(null);
        setPendingDecision(null);
        setDecisionError(null);
      },
    };
  }, [
    sessionId,
    bootstrap.isPending,
    bootstrap.isError,
    bootstrap.error,
    activeRunId,
    messages,
    run,
    plans,
    approval,
    pendingSend,
    sendMutation.isPending,
    sendError,
    decisionMutation.isPending,
    decisionError,
    pendingDecision,
  ]);
  return state;
}
