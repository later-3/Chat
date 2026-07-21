import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProductTraceEvent, WorkflowDefinition } from "./workflow-api";
import { workflowEndpointUrl } from "./workflow-api";
import {
  applyExecutorActivity,
  emptyWorkflowProgress,
  progressFromTrace,
  type WorkflowProgress,
} from "./workflow-progress";

export type WorkflowRunStatus = "idle" | "running" | "succeeded" | "failed";

function cloneMessages(messages: ReadonlyArray<Readonly<Message>>): Message[] {
  return messages.map((message) => ({ ...message })) as Message[];
}

interface UseWorkflowAgentOptions {
  definition: WorkflowDefinition;
  sessionId: string | null;
  hydratedMessages: Message[];
  hydrationVersion: number;
  restoredTrace: ProductTraceEvent[];
  onSessionSettled: (hydrateMessages: boolean) => void;
  onRunningChange: (running: boolean) => void;
}

export function useWorkflowAgent({
  definition,
  sessionId,
  hydratedMessages,
  hydrationVersion,
  restoredTrace,
  onSessionSettled,
  onRunningChange,
}: UseWorkflowAgentOptions) {
  const [agent] = useState(
    () =>
      new HttpAgent({
        url: workflowEndpointUrl(definition.endpoint),
        threadId: crypto.randomUUID(),
        description: definition.description,
      }),
  );
  const [status, setStatus] = useState<WorkflowRunStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<WorkflowProgress>(() =>
    emptyWorkflowProgress(definition),
  );
  const [runId, setRunId] = useState<string | null>(null);
  const sequence = useRef(0);
  const hydratedSessionId = useRef<string | null>(null);
  const mounted = useRef(true);
  const settledRef = useRef(onSessionSettled);
  const runningChangeRef = useRef(onRunningChange);

  useEffect(() => {
    settledRef.current = onSessionSettled;
    runningChangeRef.current = onRunningChange;
  }, [onRunningChange, onSessionSettled]);

  useEffect(() => {
    if (!sessionId || agent.isRunning) return;
    const sessionChanged = hydratedSessionId.current !== sessionId;
    hydratedSessionId.current = sessionId;
    agent.threadId = sessionId;
    agent.setMessages(cloneMessages(hydratedMessages));
    agent.setState({});
    agent.pendingInterrupts = [];
    if (sessionChanged) {
      setStatus("idle");
      setError(null);
      setRunId(null);
    }
  }, [agent, hydrationVersion, sessionId]);

  useEffect(() => {
    if (agent.isRunning) return;
    sequence.current = restoredTrace.reduce((max, event) => Math.max(max, event.sequence), 0);
    setProgress(progressFromTrace(definition, restoredTrace));
  }, [agent, definition, restoredTrace]);

  useEffect(() => {
    mounted.current = true;
    const subscription = agent.subscribe({
      onRunStartedEvent({ event }) {
        if (!mounted.current) return;
        setRunId(event.runId);
        setStatus("running");
        setError(null);
        runningChangeRef.current(true);
      },
      onActivitySnapshotEvent({ event }) {
        if (!mounted.current || event.activityType !== "executor") return;
        sequence.current += 1;
        const content =
          event.content && typeof event.content === "object"
            ? (event.content as Record<string, unknown>)
            : {};
        setProgress((value) => applyExecutorActivity(value, content, sequence.current));
      },
      onRunFinishedEvent(result) {
        if (!mounted.current) return;
        if (result.outcome === "interrupt") {
          setStatus("failed");
          setError("该可视化Workflow暂不支持HITL恢复");
        } else {
          setStatus("succeeded");
        }
        runningChangeRef.current(false);
        settledRef.current(true);
      },
      onRunErrorEvent({ event }) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(event.message);
        runningChangeRef.current(false);
        settledRef.current(true);
      },
      onRunFailed({ error: runError }) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(runError.message || "Workflow连接失败");
        runningChangeRef.current(false);
        settledRef.current(true);
      },
    });
    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      agent.abortRun();
      runningChangeRef.current(false);
    };
  }, [agent]);

  const run = useCallback(
    async (input: string) => {
      const text = input.trim();
      if (!text || !sessionId) return;
      sequence.current = 0;
      setProgress(emptyWorkflowProgress(definition));
      setStatus("running");
      setError(null);
      runningChangeRef.current(true);
      try {
        agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });
        await agent.runAgent();
      } catch (runError) {
        if (!mounted.current) return;
        setStatus("failed");
        setError(runError instanceof Error ? runError.message : "Workflow连接失败");
        runningChangeRef.current(false);
      }
    },
    [agent, definition, sessionId],
  );

  return { status, error, progress, runId, run };
}
