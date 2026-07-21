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
    """A deterministic MAF agent used before a real provider is configured."""

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
    if settings.runtime_mode == "bootstrap":
        return BootstrapAgent(
            id="opc-os-chat-bootstrap",
            name="OPC-OS Chat Bootstrap",
            description="Deterministic MAF agent for transport verification.",
        )

    client = OpenAIChatClient(
        model=settings.model,
        api_key=settings.model_api_key,
        base_url=settings.model_base_url,
    )
    return Agent(
        id="opc-os-chat-primary",
        name="OPC-OS Chat",
        description="Primary agent for the self-developed OPC-OS Chat channel.",
        instructions=(
            "你是 Later 的 OPC-OS Chat 协作助手。"
            "使用中文直接回答，明确区分已知事实、候选和需要用户确认的事项。"
        ),
        client=client,
    )
