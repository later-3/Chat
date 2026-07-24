"""Deterministic nested MAF Workflow used as the observable workflow seed."""

from __future__ import annotations

import asyncio
from types import UnionType
from typing import Any

from agent_framework import Executor, Message, WorkflowBuilder, WorkflowContext, handler

from .visible_executor import VisibleWorkflowExecutor


async def _pause(delay: float) -> None:
    if delay > 0:
        await asyncio.sleep(delay)


def _latest_user_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if isinstance(message, Message) and message.role == "user":
            return message.text
    raise ValueError("Workflow需要至少一条用户消息")


class IntakeExecutor(Executor):
    def __init__(self, delay: float) -> None:
        super().__init__(id="intake")
        self.delay = delay

    @property
    def output_types(self) -> list[type[Any] | UnionType]:
        return [str]

    @handler(input=list)
    async def handle(self, messages: list[Any], ctx: WorkflowContext[str]) -> None:
        await _pause(self.delay)
        await ctx.send_message(_latest_user_text(messages))


class NormalizeExecutor(Executor):
    def __init__(self, delay: float) -> None:
        super().__init__(id="normalize")
        self.delay = delay

    @handler
    async def handle(self, text: str, ctx: WorkflowContext[str]) -> None:
        await _pause(self.delay)
        normalized = " ".join(text.split())
        if not normalized:
            raise ValueError("规范化后的请求为空")
        await ctx.send_message(normalized)


class RulesExecutor(Executor):
    def __init__(self, delay: float) -> None:
        super().__init__(id="rules")
        self.delay = delay

    @handler
    async def handle(self, text: str, ctx: WorkflowContext[dict[str, Any]]) -> None:
        await _pause(self.delay)
        await ctx.send_message(
            {
                "text": text,
                "checks": ["non_empty", "bounded_length"],
                "length": len(text),
            }
        )


class ScoreExecutor(Executor):
    def __init__(self, delay: float) -> None:
        super().__init__(id="score")
        self.delay = delay

    @handler
    async def handle(
        self,
        facts: dict[str, Any],
        ctx: WorkflowContext[None, dict[str, Any]],
    ) -> None:
        await _pause(self.delay)
        if "[fail]" in str(facts["text"]).lower():
            raise RuntimeError("按场景要求注入风险评分失败")
        await ctx.yield_output({**facts, "score": 100, "decision": "pass"})


class DecideExecutor(Executor):
    def __init__(self, delay: float) -> None:
        super().__init__(id="decide")
        self.delay = delay

    @handler
    async def handle(
        self,
        result: dict[str, Any],
        ctx: WorkflowContext[None, dict[str, Any]],
    ) -> None:
        await _pause(self.delay)
        await ctx.yield_output({**result, "quality_gate": "passed"})


class FinalizeExecutor(Executor):
    def __init__(self, delay: float) -> None:
        super().__init__(id="finalize")
        self.delay = delay

    @handler
    async def handle(self, result: dict[str, Any], ctx: WorkflowContext[None, str]) -> None:
        await _pause(self.delay)
        await ctx.yield_output(
            f"工作流已完成：质量检查通过（评分 {result['score']}），输入为“{result['text']}”。"
        )


def create_nested_quality_workflow(*, step_delay: float = 0.12):
    """Build an outer Workflow containing a sub-workflow inside a sub-workflow."""

    rules = RulesExecutor(step_delay)
    score = ScoreExecutor(step_delay)
    policy_workflow = (
        WorkflowBuilder(
            name="policy-bundle",
            start_executor=rules,
            output_from=[score],
        )
        .add_edge(rules, score)
        .build()
    )

    normalize = NormalizeExecutor(step_delay)
    policy_bundle = VisibleWorkflowExecutor(policy_workflow, id="policy_bundle")
    decide = DecideExecutor(step_delay)
    quality_workflow = (
        WorkflowBuilder(
            name="quality-gate",
            start_executor=normalize,
            output_from=[decide],
        )
        .add_edge(normalize, policy_bundle)
        .add_edge(policy_bundle, decide)
        .build()
    )

    intake = IntakeExecutor(step_delay)
    quality_gate = VisibleWorkflowExecutor(quality_workflow, id="quality_gate")
    finalize = FinalizeExecutor(step_delay)
    return (
        WorkflowBuilder(
            name="nested-quality-demo",
            start_executor=intake,
            output_from=[finalize],
        )
        .add_edge(intake, quality_gate)
        .add_edge(quality_gate, finalize)
        .build()
    )
