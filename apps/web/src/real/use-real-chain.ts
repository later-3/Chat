import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  apiCreateSession,
  apiGetCurrentApproval,
  apiGetMessages,
  apiGetMemoryBackends,
  apiGetPlans,
  apiGetRun,
  apiGetRunContext,
  apiSubmitDecision,
  apiSubmitMessage,
  apiCreateMemoryImport,
  apiGetSessionMemoryImports,
  apiReconcileMemoryImport,
  ApiProblemError,
} from "../api/client.js";
import {
  clearBootstrapCommand,
  clearActiveRunId,
  clearPendingDecision,
  clearPendingMemoryImport,
  clearPendingSend,
  readActiveRunId,
  readBootstrapCommand,
  readPendingDecision,
  readPendingMemoryImport,
  readPendingSend,
  readStoredSession,
  writeActiveRunId,
  writeBootstrapCommand,
  writePendingDecision,
  writePendingMemoryImport,
  writePendingSend,
  writeStoredSession,
  type PendingDecision,
  type PendingMemoryImport,
  type PendingSend,
  pendingSendPayload,
} from "./real-storage.js";
import type {
  ApprovalDto,
  CommandId,
  CursorPage,
  MessageDto,
  MemoryBackendProfileDto,
  PlanDto,
  ProductRunId,
  RunDto,
  RunContextDto,
  SubmitDecisionPayload,
  SubmitMessagePayload,
  CreateMemoryImportPayload,
  MemoryImportDto,
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
const ACCEPTED_IMPORT_MAX_POLLS = 3;
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
  readonly memoryBackends: UseQueryResult<MemoryBackendProfileDto[]>;
  readonly runContext: UseQueryResult<RunContextDto>;
  readonly memoryImports: UseQueryResult<MemoryImportDto[]>;
  readonly pendingSend: PendingSend | null;
  /** B2首版一个Session同一时刻只允许一个未终态Run。 */
  readonly canStartNewRun: boolean;
  readonly sendMessage: (text: string, context?: SubmitMessagePayload["context"]) => void;
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
  readonly importMemory: (payload: CreateMemoryImportPayload) => void;
  readonly pendingMemoryImport: PendingMemoryImport | null;
  readonly retryPendingMemoryImport: () => void;
  readonly importingMemory: boolean;
  readonly memoryImportError: ApiProblemError | null;
  readonly reconcileMemoryImport: (memoryImport: MemoryImportDto) => void;
  readonly reconcilingMemory: boolean;
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
  const [pendingMemoryImport, setPendingMemoryImport] = useState<PendingMemoryImport | null>(() => {
    const stored = readStoredSession(storage);
    return stored === null ? null : readPendingMemoryImport(storage, stored.sessionId);
  });
  const [memoryImportError, setMemoryImportError] = useState<ApiProblemError | null>(() =>
    pendingMemoryImport === null ? null : recoveredPendingError(),
  );
  const acceptedImportPolls = useRef<{
    signature: string;
    dataUpdatedAt: number;
    count: number;
  } | null>(null);

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

  /**
   * 调试导航：下面不是一份可变的“前端Run对象”，而是一组独立的服务端资源投影。
   * activeRunId只是公开定位ID；Run负责生命周期，Plan负责版本内容，Approval负责当前等待点，
   * Context负责本轮采用来源，Message负责正式会话历史。拆开Query可按资源精确失效，也避免
   * Workflow内部状态或某个大响应替浏览器拥有全部产品事实。
   *
   * 当前1.5秒轮询只在Run活动且页面可见时发生；终态后停止。未来换成SSE时，SSE也只通知
   * 资源失效，最终内容仍通过这些Query读取。
   */
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

  const memoryBackends = useQuery({
    queryKey: ["memory-backends"],
    queryFn: apiGetMemoryBackends,
    staleTime: 30_000,
  });

  const memoryImports = useQuery({
    queryKey: ["memory-imports", sessionId],
    enabled: sessionId !== null,
    queryFn: () => apiGetSessionMemoryImports(sessionId ?? ""),
    refetchInterval: (query) => {
      const imports = query.state.data ?? [];
      if (imports.some((item) => ["queued", "dispatching"].includes(item.status))) {
        return refetchMs;
      }
      const accepted = imports.filter((item) => item.status === "accepted");
      if (accepted.length === 0) {
        acceptedImportPolls.current = null;
        return false;
      }
      const signature = accepted
        .map((item) => `${item.memoryImportIntentId}:${item.updatedAt}`)
        .sort()
        .join("|");
      const previous = acceptedImportPolls.current;
      const nextCount =
        previous === null || previous.signature !== signature
          ? 1
          : previous.dataUpdatedAt === query.state.dataUpdatedAt
            ? previous.count
            : previous.count + 1;
      acceptedImportPolls.current = {
        signature,
        dataUpdatedAt: query.state.dataUpdatedAt,
        count: nextCount,
      };
      return nextCount <= ACCEPTED_IMPORT_MAX_POLLS ? refetchMs : false;
    },
    refetchIntervalInBackground: false,
  });

  const runContext = useQuery({
    queryKey: ["real-run-context", activeRunId],
    enabled: activeRunId !== null,
    queryFn: () => apiGetRunContext(activeRunId ?? ""),
    refetchInterval: () => {
      const status = run.data?.status;
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

  // Command响应只证明对应事务已提交；统一失效相关Query后，页面再从服务端读取新的权威投影。
  const invalidateRunScoped = (runId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["real-messages"] });
    void queryClient.invalidateQueries({ queryKey: ["real-run", runId] });
    void queryClient.invalidateQueries({ queryKey: ["real-plans", runId] });
    void queryClient.invalidateQueries({ queryKey: ["real-approval", runId] });
    void queryClient.invalidateQueries({ queryKey: ["real-run-context", runId] });
  };

  // 终态到达时再刷新一次正式消息与最终Plan；之后停止轮询。
  useEffect(() => {
    const status = run.data?.status;
    if (status === undefined || !TERMINAL_STATUSES.has(status) || sessionId === null) return;
    void queryClient.invalidateQueries({ queryKey: ["real-messages", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["real-plans", activeRunId] });
    void queryClient.invalidateQueries({ queryKey: ["real-approval", activeRunId] });
    void queryClient.invalidateQueries({ queryKey: ["real-run-context", activeRunId] });
  }, [activeRunId, queryClient, run.data?.status, sessionId]);

  /**
   * 调试导航②：浏览器Command协调边界。
   *
   * PendingSend不是服务端Message，而是“待确认命令”：
   * - commandId：幂等身份，响应丢失后必须原样重试；
   * - payload：已经冻结的文本和本轮Context选择；
   * - version：localStorage恢复格式版本，不是产品对象revision。
   *
   * 只有API返回并通过公开合同校验后，才清除PendingSend并保存Product Run定位；
   * 网络异常时保留同一个对象，绝不能生成新commandId猜测重发。
   */
  const sendMutation = useMutation({
    mutationFn: async (pending: PendingSend) => {
      if (sessionId === null) throw new Error("session not ready");
      return apiSubmitMessage(sessionId, pending.commandId, pendingSendPayload(pending));
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

  const sendMessage = (text: string, context?: SubmitMessagePayload["context"]) => {
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
    // 先持久化完整命令再发HTTP，页面在响应中途刷新也能用同一身份恢复。
    const pending: PendingSend = {
      version: 2,
      payload: { text, ...(context !== undefined ? { context } : {}) },
      commandId: newCommandId(),
    };
    writePendingSend(storage, sessionId, pending);
    setPendingSend(pending);
    setSendError(null);
    sendMutation.mutate(pending);
  };

  const retryPendingSend = () => {
    if (pendingSend === null || sendMutation.isPending) return;
    sendMutation.mutate(pendingSend);
  };

  /**
   * 调试导航⑨：Plan决定仍然是产品Command，不是浏览器直接恢复Workflow Hook。
   * expectedRunRevision防止旧页面决定新状态；payload绑定approval/plan/hash；
   * API提交Decision和workflow_resume Outbox后，Dispatcher才恢复同一个Workflow。
   */
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

  const memoryImportMutation = useMutation({
    mutationFn: apiCreateMemoryImport,
    onSuccess: () => {
      if (sessionId !== null) clearPendingMemoryImport(storage, sessionId);
      setPendingMemoryImport(null);
      setMemoryImportError(null);
      void queryClient.invalidateQueries({ queryKey: ["memory-imports", sessionId] });
    },
    onError: (error) => {
      const problem = error instanceof ApiProblemError ? error : null;
      if (problem?.recoveryAction !== "retry_same_command") {
        if (sessionId !== null) clearPendingMemoryImport(storage, sessionId);
        setPendingMemoryImport(null);
      }
      setMemoryImportError(problem);
    },
  });

  const reconcileMemoryMutation = useMutation({
    mutationFn: (memoryImport: MemoryImportDto) =>
      apiReconcileMemoryImport({
        memoryImportIntentId: memoryImport.memoryImportIntentId,
        commandId: newCommandId(),
        expectedResultRevision: memoryImport.resultRevision,
      }),
    onSuccess: () => {
      acceptedImportPolls.current = null;
      setMemoryImportError(null);
      void queryClient.invalidateQueries({ queryKey: ["memory-imports", sessionId] });
    },
    onError: (error) => {
      setMemoryImportError(error instanceof ApiProblemError ? error : null);
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
      memoryBackends,
      runContext,
      memoryImports,
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
      importMemory: (payload) => {
        if (sessionId === null || memoryImportMutation.isPending || pendingMemoryImport !== null)
          return;
        const pending: PendingMemoryImport = { version: 1, commandId: newCommandId(), payload };
        writePendingMemoryImport(storage, sessionId, pending);
        setPendingMemoryImport(pending);
        setMemoryImportError(null);
        memoryImportMutation.mutate(pending);
      },
      pendingMemoryImport,
      retryPendingMemoryImport: () => {
        if (pendingMemoryImport === null || memoryImportMutation.isPending) return;
        setMemoryImportError(null);
        memoryImportMutation.mutate(pendingMemoryImport);
      },
      importingMemory: memoryImportMutation.isPending,
      memoryImportError,
      reconcileMemoryImport: (memoryImport) => {
        if (reconcileMemoryMutation.isPending) return;
        setMemoryImportError(null);
        reconcileMemoryMutation.mutate(memoryImport);
      },
      reconcilingMemory: reconcileMemoryMutation.isPending,
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
    memoryBackends,
    runContext,
    memoryImports,
    pendingSend,
    sendMutation.isPending,
    sendError,
    decisionMutation.isPending,
    decisionError,
    pendingDecision,
    pendingMemoryImport,
    memoryImportMutation.isPending,
    memoryImportError,
    reconcileMemoryMutation.isPending,
  ]);
  return state;
}
