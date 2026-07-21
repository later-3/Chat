"""Thin Product Session gate around MAF's native AG-UI agent bridge."""

from __future__ import annotations

from typing import Any

from ag_ui.core import (
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageStartEvent,
)
from agent_framework import SupportsAgentRun
from agent_framework_ag_ui import AgentFrameworkAgent

from .service import ProductSessionError, ProductSessionService


class ProductAwareAgentFrameworkAgent(AgentFrameworkAgent):
    """Persist Product facts while leaving event conversion to MAF."""

    def __init__(self, agent: SupportsAgentRun, *, sessions: ProductSessionService) -> None:
        super().__init__(agent=agent)
        self._sessions = sessions

    async def run(self, input_data: dict[str, Any]):
        thread_id = self._thread_id(input_data)
        run_id = self._run_id(input_data)
        try:
            await self._sessions.prepare_agui_run(input_data)
            await self._sessions.mark_running(thread_id)
        except ProductSessionError as error:
            yield RunStartedEvent(run_id=run_id, thread_id=thread_id)
            yield RunErrorEvent(message=str(error), code=error.code)
            return

        assistant_message_id: str | None = None
        assistant_text: list[str] = []
        terminal: RunFinishedEvent | RunErrorEvent | None = None
        try:
            async for event in super().run(input_data):
                if isinstance(event, TextMessageStartEvent) and event.role == "assistant":
                    assistant_message_id = event.message_id
                elif isinstance(event, TextMessageContentEvent):
                    assistant_text.append(event.delta)
                if isinstance(event, (RunFinishedEvent, RunErrorEvent)):
                    if terminal is None or isinstance(event, RunErrorEvent):
                        terminal = event
                    continue
                yield event
        except Exception:
            await self._sessions.fail_active_run(
                thread_id,
                error_code="agent_runtime_error",
                message="MAF运行异常结束。",
            )
            yield RunErrorEvent(message="MAF运行异常结束。", code="AGENT_RUNTIME_ERROR")
            return

        if isinstance(terminal, RunErrorEvent):
            await self._sessions.fail_active_run(
                thread_id,
                error_code=getattr(terminal, "code", None),
                message=terminal.message,
            )
            yield terminal
            return
        if terminal is None:
            await self._sessions.fail_active_run(
                thread_id,
                status="interrupted",
                error_code="missing_terminal_event",
                message="MAF运行没有产生终态事件。",
            )
            yield RunErrorEvent(message="MAF运行没有产生终态事件。", code="MISSING_TERMINAL_EVENT")
            return

        outcome = getattr(terminal, "outcome", None)
        if getattr(outcome, "type", None) == "interrupt":
            await self._sessions.mark_waiting_approval(thread_id)
            yield terminal
            return
        try:
            committed = await self._sessions.complete_active_run(
                thread_id,
                assistant_text="".join(assistant_text),
                agui_message_id=assistant_message_id,
            )
            if committed is None:
                raise RuntimeError("Product Store没有可提交的活动Run")
        except Exception:
            await self._sessions.fail_active_run(
                thread_id,
                error_code="product_commit_failed",
                message="模型输出已产生，但Product Store终态提交失败。",
            )
            yield RunErrorEvent(
                message="模型输出已产生，但Product Store终态提交失败。",
                code="PRODUCT_COMMIT_FAILED",
            )
            return
        yield terminal

    @staticmethod
    def _thread_id(input_data: dict[str, Any]) -> str:
        return str(input_data.get("thread_id") or input_data.get("threadId") or "")

    @staticmethod
    def _run_id(input_data: dict[str, Any]) -> str:
        return str(input_data.get("run_id") or input_data.get("runId") or "")
