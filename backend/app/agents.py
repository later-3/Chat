"""Create the MAF agent selected by the immutable runtime configuration."""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any
from uuid import uuid4

from agent_framework import (
    Agent,
    AgentResponse,
    AgentResponseUpdate,
    AgentSession,
    BaseAgent,
    Content,
    Message,
)
from agent_framework.openai import OpenAIChatClient

from .config import Settings


BOOTSTRAP_RESPONSE = (
    "AG-UI 已连接到 Microsoft Agent Framework。"
    "当前未配置模型密钥，因此由确定性启动 Agent 返回此消息。"
)


class BootstrapAgent(BaseAgent):
    """A deterministic MAF agent that verifies the full AG-UI transport offline.

    It deliberately implements the same streaming and non-streaming surface as
    a provider-backed agent, but it owns no conversation history or product
    state. It must therefore never be treated as proof of Session recovery.
    """

    async def run(
        self,
        messages: Message | Sequence[Message] | None = None,
        *,
        stream: bool = False,
        session: AgentSession | None = None,
        function_invocation_kwargs: dict[str, Any] | None = None,
        client_kwargs: dict[str, Any] | None = None,
        **_: Any,
    ) -> AgentResponse | AsyncIterator[AgentResponseUpdate]:
        del messages, session, function_invocation_kwargs, client_kwargs
        response_id = f"bootstrap-{uuid4()}"
        message_id = f"message-{uuid4()}"
        if stream:

            async def updates() -> AsyncIterator[AgentResponseUpdate]:
                # A real MAF streaming update is required so the AG-UI bridge is
                # tested instead of being bypassed by a custom HTTP response.
                yield AgentResponseUpdate(
                    contents=[Content.from_text(BOOTSTRAP_RESPONSE)],
                    role="assistant",
                    agent_id=self.id,
                    response_id=response_id,
                    message_id=message_id,
                )

            return updates()
        return AgentResponse(
            messages=[Message(role="assistant", contents=[BOOTSTRAP_RESPONSE], message_id=message_id)],
            response_id=response_id,
            agent_id=self.id,
        )


def create_agent(settings: Settings) -> BaseAgent:
    """Build either the offline verifier or the provider-backed primary Agent.

    Session stores and product repositories are intentionally absent here until
    their ownership and recovery contract have passed design review.
    """

    if settings.runtime_mode == "bootstrap":
        return BootstrapAgent(
            id="chat-bootstrap",
            name="Chat Bootstrap",
            description="Deterministic MAF agent for transport verification.",
        )

    client = OpenAIChatClient(
        model=settings.model,
        api_key=settings.model_api_key,
        base_url=settings.model_base_url,
    )
    return Agent(
        id="chat-primary",
        name="Chat",
        description="Primary agent for the independent Chat product.",
        instructions=(
            "你是 Later 的 Chat 协作助手。"
            "使用中文直接回答，明确区分已知事实、候选和需要用户确认的事项。"
        ),
        client=client,
    )
