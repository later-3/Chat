"""A narrow MAF adapter that makes nested Workflow lifecycle observable.

MAF's native WorkflowExecutor executes real sub-workflows, but version 1.11.0
does not forward inner executor lifecycle events to the parent event stream.
This adapter preserves native execution and prefixes those framework events so
AG-UI can render the hierarchy without guessing node state.
"""

from __future__ import annotations

import types
from typing import Any

from agent_framework import (
    Executor,
    Workflow,
    WorkflowContext,
    WorkflowEvent,
    WorkflowEventSource,
    WorkflowMessage,
    handler,
)

from ..runtime_adapters import maf_is_instance


class VisibleWorkflowExecutor(Executor):
    """Run a native sub-workflow and re-emit namespaced lifecycle events."""

    def __init__(self, workflow: Workflow, *, id: str) -> None:
        super().__init__(id=id)
        self.workflow = workflow

    @property
    def input_types(self) -> list[type[Any] | types.UnionType]:
        return list(self.workflow.input_types)

    @property
    def output_types(self) -> list[type[Any] | types.UnionType]:
        return list(self.workflow.output_types)

    def can_handle(self, message: WorkflowMessage) -> bool:
        return any(maf_is_instance(message.data, input_type) for input_type in self.workflow.input_types)

    @handler
    async def process(self, input_data: object, ctx: WorkflowContext[Any]) -> None:
        outputs: list[Any] = []
        stream = self.workflow.run(input_data, stream=True)
        async for event in stream:
            if event.type in {
                "executor_invoked",
                "executor_completed",
                "executor_failed",
                "executor_bypassed",
            }:
                executor_id = event.executor_id
                if executor_id:
                    await ctx.add_event(
                        WorkflowEvent(
                            event.type,
                            data=event.data,
                            origin=WorkflowEventSource.FRAMEWORK,
                            details=event.details,
                            executor_id=f"{self.id}.{executor_id}",
                        )
                    )
            elif event.type == "output":
                outputs.append(event.data)
            elif event.type == "request_info":
                raise RuntimeError("VisibleWorkflowExecutor当前不转发子流程HITL请求")

        for output in outputs:
            await ctx.send_message(output)
