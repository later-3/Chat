import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8030/api/agent";

export type RunStatus = "idle" | "running" | "error";

function createThreadId(): string {
  return crypto.randomUUID();
}

export function useChatAgent() {
  const [agent] = useState(
    () =>
      new HttpAgent({
        url: import.meta.env.VITE_AG_UI_URL ?? DEFAULT_AGENT_URL,
        threadId: createThreadId(),
        description: "OPC-OS 自研 Chat 通道",
      }),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const subscription = agent.subscribe({
      onMessagesChanged({ messages: nextMessages }) {
        if (mounted.current) {
          setMessages(nextMessages.map((message) => ({ ...message })) as Message[]);
        }
      },
      onRunStartedEvent() {
        if (mounted.current) {
          setStatus("running");
          setError(null);
        }
      },
      onRunFinishedEvent() {
        if (mounted.current) {
          setStatus("idle");
        }
      },
      onRunErrorEvent({ event }) {
        if (mounted.current) {
          setStatus("error");
          setError(event.message);
        }
      },
      onRunFailed({ error: runError }) {
        if (mounted.current) {
          setStatus("error");
          setError(runError.message || "Agent连接失败");
        }
      },
    });

    return () => {
      mounted.current = false;
      subscription.unsubscribe();
      agent.abortRun();
    };
  }, [agent]);

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || agent.isRunning) return;

      agent.addMessage({
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      });
      setMessages(agent.messages.map((message) => ({ ...message })) as Message[]);
      setStatus("running");
      setError(null);

      try {
        await agent.runAgent();
      } catch (runError) {
        if (mounted.current) {
          setStatus("error");
          setError(runError instanceof Error ? runError.message : "Agent连接失败");
        }
      }
    },
    [agent],
  );

  const stop = useCallback(() => {
    agent.abortRun();
    setStatus("idle");
  }, [agent]);

  const newConversation = useCallback(() => {
    if (agent.isRunning) agent.abortRun();
    agent.threadId = createThreadId();
    agent.setMessages([]);
    agent.setState({});
    setMessages([]);
    setStatus("idle");
    setError(null);
  }, [agent]);

  return {
    messages,
    status,
    error,
    threadId: agent.threadId,
    send,
    stop,
    newConversation,
  };
}
