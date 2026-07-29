"""持续协作节点26/30使用的受治理pi JSONL-RPC子进程与精确字节Provider网关。

一个``PiExecution``只对应一次Chat ToolExecution。pi在专属目录写入全新的JSONL Session，
用于查看本次任务的Prompt、模型消息和Tool事件；进程退出后冻结为只读证据，下一次执行
不会加载它。跨轮权威历史仍分别保存在Chat Product Store、执行账本和MAF Checkpoint。
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import tempfile
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import uuid4

from .config import PiRuntimeSettings
from .execution_dispatch.contracts import RepositoryFence
from .execution_workspaces import ExecutionWorkspaceService
from .model_providers import ModelOption, ModelProviderConfig, is_kimi_code_provider
from .pi_sessions import (
    ChatPiSession,
    ChatPiSessionError,
    pending_pi_session_view,
    prepare_chat_pi_session,
)
from .readonly_tools import ReadonlyToolService, ReadonlyToolValidationError
from .tool_configs import PiToolConfigSnapshot
from .tool_execution import ToolOperationError, ToolOperationService

logger = logging.getLogger(__name__)

PI_EXTENSION_SOURCE = """export default function(pi) {
  pi.on("tool_call", async (event, ctx) => {
    const edited = await ctx.ui.editor(
      "CHAT_PI_TOOL_APPROVAL",
      JSON.stringify({
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: event.input
      })
    );
    if (edited === undefined) {
      return { block: true, reason: "Chat user rejected the pi tool call" };
    }
    let decision;
    try {
      decision = JSON.parse(edited);
    } catch {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    if (!decision || typeof decision.arguments !== "object" || Array.isArray(decision.arguments)) {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    for (const key of Object.keys(event.input)) delete event.input[key];
    Object.assign(event.input, decision.arguments);
    return undefined;
  });
}
"""

PI_READONLY_EXTENSION_SOURCE = """const Schemas = {
  read: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 2000 }
    },
    required: ["path"],
    additionalProperties: false
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      regex: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  find: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  ls: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 }
    },
    additionalProperties: false
  }
};

const Descriptions = {
  read: "Read a bounded range of one UTF-8 text file inside the approved repository snapshot.",
  grep: "Search bounded text files inside the approved repository snapshot.",
  find: "Find bounded file paths inside the approved repository snapshot.",
  ls: "List one directory inside the approved repository snapshot."
};

export default function(pi) {
  for (const name of ["read", "grep", "find", "ls"]) {
    pi.registerTool({
      name,
      label: `Chat ${name}`,
      description: Descriptions[name],
      promptSnippet: Descriptions[name],
      parameters: Schemas[name],
      async execute(toolCallId, params) {
        const response = await fetch(`${process.env.CHAT_PI_READ_TOOL_GATEWAY}/${name}`, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${process.env.CHAT_PI_READ_TOOL_TOKEN}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ tool_call_id: toolCallId, arguments: params })
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.detail || payload?.error?.message || "Chat read tool failed");
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload
        };
      }
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    const edited = await ctx.ui.editor(
      "CHAT_PI_TOOL_APPROVAL",
      JSON.stringify({
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: event.input
      })
    );
    if (edited === undefined) {
      return { block: true, reason: "Chat user rejected the pi tool call" };
    }
    let decision;
    try {
      decision = JSON.parse(edited);
    } catch {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    if (!decision || typeof decision.arguments !== "object" || Array.isArray(decision.arguments)) {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    for (const key of Object.keys(event.input)) delete event.input[key];
    Object.assign(event.input, decision.arguments);
    return undefined;
  });
}
"""

PI_WORKSPACE_EXTENSION_SOURCE = """const Schemas = {
  read: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1, maximum: 2000 }
    },
    required: ["path"],
    additionalProperties: false
  },
  grep: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      regex: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  find: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  ls: {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 500 }
    },
    additionalProperties: false
  },
  edit: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" }
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false
  }
};

const Descriptions = {
  read: "Read a bounded range of one UTF-8 text file inside the managed execution workspace.",
  grep: "Search bounded text files inside the managed execution workspace.",
  find: "Find bounded file paths inside the managed execution workspace.",
  ls: "List one directory inside the managed execution workspace.",
  edit: "Replace one exact, unique text occurrence in one existing UTF-8 file. Chat previews and authorizes the exact diff before execution."
};

export default function(pi) {
  for (const name of ["read", "grep", "find", "ls", "edit"]) {
    pi.registerTool({
      name,
      label: `Chat ${name}`,
      description: Descriptions[name],
      promptSnippet: Descriptions[name],
      parameters: Schemas[name],
      executionMode: name === "edit" ? "sequential" : "parallel",
      async execute(toolCallId, params) {
        const response = await fetch(`${process.env.CHAT_PI_WORKSPACE_TOOL_GATEWAY}/${name}`, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${process.env.CHAT_PI_WORKSPACE_TOOL_TOKEN}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ tool_call_id: toolCallId, arguments: params })
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.detail || payload?.error?.message || "Chat workspace tool failed");
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload
        };
      }
    });
  }

  pi.on("tool_call", async (event, ctx) => {
    const edited = await ctx.ui.editor(
      "CHAT_PI_TOOL_APPROVAL",
      JSON.stringify({
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: event.input
      })
    );
    if (edited === undefined) {
      return { block: true, reason: "Chat user rejected the pi tool call" };
    }
    let decision;
    try {
      decision = JSON.parse(edited);
    } catch {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    if (!decision || typeof decision.arguments !== "object" || Array.isArray(decision.arguments)) {
      return { block: true, reason: "Chat returned invalid tool arguments" };
    }
    for (const key of Object.keys(event.input)) delete event.input[key];
    Object.assign(event.input, decision.arguments);
    return undefined;
  });
}
"""


class PiRuntimeError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "pi_runtime_error",
        metrics: Mapping[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.metrics = dict(metrics or {})
        super().__init__(message)


@dataclass(slots=True)
class PiGatewayDecision:
    approved: bool
    body: bytes | None = None
    provider_id: str | None = None


@dataclass(slots=True)
class PiGatewayCall:
    id: str
    protocol: str
    body: bytes
    received_at: float
    decision: asyncio.Future[PiGatewayDecision]
    approval_id: str | None = None
    outcome_status: str | None = None
    error_code: str | None = None


@dataclass(frozen=True, slots=True)
class PiModelCallBoundary:
    kind: Literal["model_call"]
    call: PiGatewayCall


@dataclass(frozen=True, slots=True)
class PiToolCallBoundary:
    kind: Literal["tool_call"]
    rpc_request_id: str
    tool_call_id: str
    tool_name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class PiCompletedBoundary:
    kind: Literal["completed"]
    text: str
    metrics: dict[str, Any]
    status: Literal["succeeded", "failed", "cancelled"] = "succeeded"
    terminal_reason_code: str = "pi_completed"


PiBoundary = PiModelCallBoundary | PiToolCallBoundary | PiCompletedBoundary

_DASHSCOPE_CODING_HOST = "coding.dashscope.aliyuncs.com"
_PI_DEFAULT_MAX_TOKENS = 16_384
_PI_REASONING_MAX_TOKENS = 65_536
# One read tool result can be 128 KiB and pi's JSONL message events can embed
# several prior results. asyncio's 64 KiB default would split a valid event.
# Keep an explicit upper bound so malformed output still cannot grow unbounded.
_PI_RPC_STREAM_LIMIT = 8 * 1024 * 1024
MAX_PI_READ_TOOL_CALLS = 24
PI_GATEWAY_TOKEN_HEADER = "X-Chat-Pi-Token"
_SENSITIVE_ERROR_VALUE = re.compile(r"(?i)(authorization|api[_-]?key|token|secret)\s*[:=]\s*([^\s,;}]+)")


def _assistant_text(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(item.get("text") or "")
        for item in content
        if isinstance(item, Mapping) and item.get("type") == "text"
    )


def _pi_api(protocol: str) -> str:
    return "openai-completions" if protocol == "openai_chat_completions" else "openai-responses"


def _pi_provider_compat(provider: ModelProviderConfig, model: str) -> dict[str, Any]:
    """Describe the real upstream behind Chat's local approval gateway.

    pi normally derives compatibility from the URL it calls. Here that URL is
    Chat's local gateway, so auto-detection would incorrectly treat every
    upstream as OpenAI. Keep this projection next to gateway construction so
    the request visible to the user is already the exact compatible request;
    the gateway never mutates approved bytes.
    """

    if provider.protocol != "openai_chat_completions":
        return {}
    option = next((value for value in provider.models if value.id == model), None)
    roles = option.capabilities.roles if option is not None else ()
    base_url = (provider.base_url or "").lower()
    is_dashscope_coding = _DASHSCOPE_CODING_HOST in base_url
    is_kimi_code = is_kimi_code_provider(provider)
    return {
        "supportsStore": True,
        # DashScope's coding endpoint rejects the OpenAI `developer` role even
        # when a generic DashScope catalog declares it. It accepts `system`.
        "supportsDeveloperRole": "developer" in roles and not is_dashscope_coding,
        "supportsReasoningEffort": is_dashscope_coding or is_kimi_code,
        "maxTokensField": "max_completion_tokens",
        "supportsStrictMode": False,
    }


def _pi_max_tokens(provider: ModelProviderConfig, model: str, thinking_level: str) -> int:
    """Choose a truthful pi model ceiling from the configured model contract."""

    option = next((value for value in provider.models if value.id == model), None)
    configured: int | None = None
    if option is not None:
        for key in ("max_output_tokens", "max_completion_tokens", "max_tokens"):
            parameter = option.capabilities.parameter(key)
            if parameter is not None and isinstance(parameter.default, int):
                configured = parameter.default
                break
    floor = _PI_REASONING_MAX_TOKENS if thinking_level != "off" else _PI_DEFAULT_MAX_TOKENS
    return max(configured or 0, floor)


def _pi_model_projection(
    provider: ModelProviderConfig,
    model: str,
    thinking_level: str,
) -> dict[str, Any]:
    """Project catalog metadata into pi's custom-model contract."""

    option = next((value for value in provider.models if value.id == model), None)
    if option is None:
        option = ModelOption(id=model, label=model)
    projection: dict[str, Any] = {
        "id": model,
        "name": option.label,
        "reasoning": option.reasoning,
        "contextWindow": option.context_window,
        "maxTokens": _pi_max_tokens(provider, model, thinking_level),
    }
    if option.thinking_level_map:
        projection["thinkingLevelMap"] = dict(option.thinking_level_map)
    return projection


def _safe_pi_error(value: object) -> str:
    """Bound and redact a Provider/pi error before it enters product state."""

    text = " ".join(str(value or "").split())
    text = _SENSITIVE_ERROR_VALUE.sub(r"\1=[redacted]", text)
    return text[:500]


class PiExecutionOwner(Protocol):
    """一个活动pi子进程需要的最小Owner合同，用Token注销进程。"""

    def unregister(self, token: str) -> None: ...


class PiExecution:
    """绑定一个受治理Token和ToolExecution的一次性活动pi进程。

    生命周期：``start``创建临时配置和RPC进程；``next_boundary``向MAF暴露模型/Tool边界；
    Chat批准后再写回pi；``close``回收进程与临时目录。它不是Product Session，也不是
    MAF AgentSession，不能承担跨轮恢复。
    """

    def __init__(
        self,
        *,
        token: str,
        task: str,
        config: PiToolConfigSnapshot,
        runtime: PiRuntimeSettings,
        provider: ModelProviderConfig,
        manager: PiExecutionOwner,
        repository_fence: RepositoryFence | None = None,
        readonly_tools: ReadonlyToolService | None = None,
        workspace_id: str | None = None,
        tool_execution_id: str | None = None,
        product_session_id: str | None = None,
        product_run_id: str | None = None,
        execution_workspaces: ExecutionWorkspaceService | None = None,
        tool_operations: ToolOperationService | None = None,
    ) -> None:
        self.token = token
        self.task = task
        self.config = config
        self.runtime = runtime
        self.provider = provider
        self.manager = manager
        self.repository_fence = repository_fence
        self.readonly_tools = readonly_tools
        self.workspace_id = workspace_id
        self.tool_execution_id = tool_execution_id
        self.product_session_id = product_session_id
        self.product_run_id = product_run_id
        self.execution_workspaces = execution_workspaces
        self.tool_operations = tool_operations
        self.started_at = time.monotonic()
        self.process: asyncio.subprocess.Process | None = None
        self._temp_directory: tempfile.TemporaryDirectory[str] | None = None
        self._boundaries: asyncio.Queue[PiBoundary] = asyncio.Queue()
        self._response_waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr: list[str] = []
        self._final_text = ""
        self._final_stop_reason = ""
        self._final_error_message = ""
        self._last_provider_failure_code: str | None = None
        self._closed = False
        self._pi_session: ChatPiSession | None = None
        self._pi_session_freeze_error = False
        self._pi_session_error_code: str | None = None
        self._model_call_count = 0
        self._internal_tool_call_count = 0
        self._tool_events: list[dict[str, Any]] = []
        self._approved_tool_calls: dict[str, tuple[str, dict[str, Any]]] = {}
        # MAF checkpoints may rebuild the Executor while this subprocess keeps
        # running. Stable boundary IDs let the restored Executor reattach to
        # the exact unresolved Future/RPC request without serializing live
        # asyncio or process objects into the checkpoint.
        self._pending_provider_calls: dict[str, PiGatewayCall] = {}
        self._pending_tool_boundaries: dict[str, PiToolCallBoundary] = {}
        self._usage = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "cost": 0.0,
        }

    @property
    def model_call_count(self) -> int:
        return self._model_call_count

    async def start(self) -> None:
        """创建新pi Session和临时配置，再启动禁用重试及未治理扩展的RPC。"""
        if not self.runtime.available or self.runtime.node_path is None or self.runtime.cli_path is None:
            self._pi_session_error_code = "pi_runtime_unavailable"
            raise PiRuntimeError("pi RPC运行时不可用", code="pi_runtime_unavailable")
        session_execution_id = self.tool_execution_id or f"runtime-{uuid4()}"
        try:
            self._pi_session = prepare_chat_pi_session(
                directory=self.runtime.session_directory,
                working_directory=self.config.working_directory,
                tool_execution_id=session_execution_id,
                product_session_id=self.product_session_id,
                product_run_id=self.product_run_id,
            )
        except ChatPiSessionError as error:
            self._pi_session_error_code = error.code
            raise PiRuntimeError(str(error), code=error.code) from error
        self._temp_directory = tempfile.TemporaryDirectory(prefix="chat-pi-")
        agent_directory = Path(self._temp_directory.name)
        gateway_base = f"{self.runtime.gateway_origin}/api/pi-provider/v1"
        models = {
            "providers": {
                "chat-governed": {
                    "name": "Chat逐次审批网关",
                    "baseUrl": gateway_base,
                    "apiKey": self.token,
                    "authHeader": True,
                    # OpenAI-compatible SDKs may synthesize or replace their
                    # Authorization header. Keep an independent Chat-owned
                    # credential so local gateway authentication does not
                    # depend on SDK header merge behavior.
                    "headers": {PI_GATEWAY_TOKEN_HEADER: self.token},
                    "api": _pi_api(self.provider.protocol),
                    "compat": _pi_provider_compat(self.provider, self.config.model),
                    "models": [
                        _pi_model_projection(
                            self.provider,
                            self.config.model,
                            self.config.thinking_level,
                        )
                    ],
                }
            }
        }
        (agent_directory / "models.json").write_text(json.dumps(models, ensure_ascii=False), encoding="utf-8")
        readonly = self.repository_fence is not None and self.readonly_tools is not None
        workspace = all(
            value is not None
            for value in (
                self.workspace_id,
                self.tool_execution_id,
                self.execution_workspaces,
                self.tool_operations,
                self.readonly_tools,
            )
        )
        if readonly and workspace:
            raise PiRuntimeError(
                "pi执行不能同时绑定只读Snapshot和可写Workspace",
                code="pi_execution_mode_conflict",
            )
        extension_name = (
            "chat-workspace-tools.mjs"
            if workspace
            else ("chat-readonly-tools.mjs" if readonly else "chat-tool-approval.mjs")
        )
        extension_path = agent_directory / extension_name
        extension_path.write_text(
            (
                PI_WORKSPACE_EXTENSION_SOURCE
                if workspace
                else (PI_READONLY_EXTENSION_SOURCE if readonly else PI_EXTENSION_SOURCE)
            ),
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment.update(
            {
                "PI_CODING_AGENT_DIR": str(agent_directory),
                "PI_OFFLINE": "1",
                "PI_TELEMETRY": "0",
            }
        )
        if readonly:
            environment.update(
                {
                    "CHAT_PI_READ_TOOL_GATEWAY": (f"{self.runtime.gateway_origin}/api/pi-read-tools"),
                    "CHAT_PI_READ_TOOL_TOKEN": self.token,
                }
            )
        if workspace:
            environment.update(
                {
                    "CHAT_PI_WORKSPACE_TOOL_GATEWAY": (
                        f"{self.runtime.gateway_origin}/api/pi-workspace-tools"
                    ),
                    "CHAT_PI_WORKSPACE_TOOL_TOKEN": self.token,
                }
            )
        assert self._pi_session is not None
        arguments = [
            str(self.runtime.node_path),
            "--enable-source-maps",
        ]
        if self.runtime.node_debug_port is not None:
            debug_flag = "--inspect-brk" if self.runtime.node_debug_break else "--inspect"
            arguments.append(f"{debug_flag}=127.0.0.1:{self.runtime.node_debug_port}")
        arguments.extend(
            [
                str(self.runtime.cli_path),
                "--mode",
                "rpc",
                "--provider",
                "chat-governed",
                "--model",
                self.config.model,
                "--api-key",
                self.token,
                "--thinking",
                self.config.thinking_level,
                "--system-prompt",
                self.config.system_prompt,
                "--extension",
                str(extension_path),
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                # 关键Session边界：显式文件是本次ToolExecution的新转录证据；既不查找
                # 历史Session，也不把它用作下一轮Chat上下文。
                "--session",
                str(self._pi_session.path),
                "--session-dir",
                str(self.runtime.session_directory),
                "--name",
                self._pi_session.name,
                "--approve",
                "--offline",
            ]
        )
        if readonly or workspace:
            arguments.extend(
                [
                    "--no-builtin-tools",
                    "--tools",
                    ",".join(self.config.allowed_tools),
                ]
            )
        else:
            arguments.extend(["--tools", ",".join(self.config.allowed_tools)])
        self.process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=self.config.working_directory,
            env=environment,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=_PI_RPC_STREAM_LIMIT,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        await self._command("set_auto_retry", {"enabled": False})
        await self._command("prompt", {"message": self.task})

    async def accept_provider_call(self, protocol: str, body: bytes) -> PiGatewayCall:
        """接收pi准备发送的精确Provider字节，挂起为MAF可治理的模型边界。"""
        if self._closed:
            raise PiRuntimeError("pi执行已经结束", code="pi_execution_closed")
        if protocol != self.provider.protocol:
            raise PiRuntimeError("pi网关协议与目标Provider不一致", code="pi_protocol_mismatch")
        self._model_call_count += 1
        if self._model_call_count > self.config.max_model_calls:
            raise PiRuntimeError("pi模型调用次数超过配置上限", code="pi_model_call_limit")
        call = PiGatewayCall(
            id=str(uuid4()),
            protocol=protocol,
            body=body,
            received_at=time.monotonic(),
            decision=asyncio.get_running_loop().create_future(),
        )
        self._pending_provider_calls[call.id] = call
        await self._boundaries.put(PiModelCallBoundary(kind="model_call", call=call))
        return call

    def pending_provider_call(self, call_id: str) -> PiGatewayCall:
        """Return the exact unresolved Provider boundary for checkpoint restore."""

        call = self._pending_provider_calls.get(call_id)
        if call is None or call.decision.done():
            raise PiRuntimeError(
                "pi模型调用边界已经结束或不存在",
                code="pi_model_boundary_not_live",
            )
        return call

    def retire_provider_call(self, call_id: str) -> None:
        self._pending_provider_calls.pop(call_id, None)

    def pending_tool_boundary(self, tool_call_id: str) -> PiToolCallBoundary:
        """Return the exact unresolved Tool boundary for checkpoint restore."""

        boundary = self._pending_tool_boundaries.get(tool_call_id)
        if boundary is None:
            raise PiRuntimeError(
                "pi Tool调用边界已经结束或不存在",
                code="pi_tool_boundary_not_live",
            )
        return boundary

    async def next_boundary(self) -> PiBoundary:
        """在总时限内返回下一个模型/Tool/完成边界；超时先关闭进程再失败。"""
        remaining = self.config.timeout_seconds - (time.monotonic() - self.started_at)
        if remaining <= 0:
            await self.close()
            raise PiRuntimeError("pi执行超过配置的总时限", code="pi_timeout")
        try:
            return await asyncio.wait_for(self._boundaries.get(), timeout=remaining)
        except TimeoutError as error:
            await self.close()
            raise PiRuntimeError("pi执行超过配置的总时限", code="pi_timeout") from error

    async def approve_tool_call(self, boundary: PiToolCallBoundary, arguments: Mapping[str, Any]) -> None:
        self._validate_tool_arguments(boundary.tool_name, arguments)
        approved_arguments = copy.deepcopy(dict(arguments))
        self._approved_tool_calls[boundary.tool_call_id] = (
            boundary.tool_name,
            approved_arguments,
        )
        await self._write(
            {
                "type": "extension_ui_response",
                "id": boundary.rpc_request_id,
                "value": json.dumps(
                    {
                        "tool_call_id": boundary.tool_call_id,
                        "tool_name": boundary.tool_name,
                        "arguments": approved_arguments,
                    },
                    ensure_ascii=False,
                ),
            }
        )
        self._pending_tool_boundaries.pop(boundary.tool_call_id, None)

    async def reject_tool_call(self, boundary: PiToolCallBoundary) -> None:
        await self._write({"type": "extension_ui_response", "id": boundary.rpc_request_id, "cancelled": True})
        self._pending_tool_boundaries.pop(boundary.tool_call_id, None)

    async def execute_read_tool(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Consume exactly one approved custom-tool request."""

        if self.repository_fence is None or self.readonly_tools is None:
            raise PiRuntimeError(
                "当前pi执行没有只读Tool Gateway",
                code="pi_read_tool_gateway_unavailable",
            )
        approved = self._approved_tool_calls.pop(tool_call_id, None)
        if approved is None or approved[0] != tool_name or approved[1] != dict(arguments):
            raise PiRuntimeError(
                "pi只读Tool参数未获当前调用批准",
                code="pi_read_tool_not_approved",
            )
        try:
            return await self.readonly_tools.execute(
                fence=self.repository_fence,
                tool_name=tool_name,
                arguments=arguments,
            )
        except ReadonlyToolValidationError as error:
            raise PiRuntimeError(str(error), code=error.code) from error

    async def execute_workspace_tool(
        self,
        *,
        tool_call_id: str,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Consume one approved custom Tool against the managed SD3 workspace."""

        if (
            self.workspace_id is None
            or self.tool_execution_id is None
            or self.execution_workspaces is None
            or self.tool_operations is None
            or self.readonly_tools is None
        ):
            raise PiRuntimeError(
                "当前pi执行没有Execution Workspace Tool Gateway",
                code="pi_workspace_tool_gateway_unavailable",
            )
        approved = self._approved_tool_calls.pop(tool_call_id, None)
        if approved is None or approved[0] != tool_name or approved[1] != dict(arguments):
            raise PiRuntimeError(
                "pi Workspace Tool参数未获当前调用批准",
                code="pi_workspace_tool_not_approved",
            )
        try:
            if tool_name == "edit":
                return await self.tool_operations.execute_exact_edit(
                    tool_execution_id=self.tool_execution_id,
                    provider_tool_call_id=tool_call_id,
                    arguments=arguments,
                    worker_id=f"pi-gateway:{self.token[:12]}",
                )
            root = await self.execution_workspaces.private_path(self.workspace_id)
            return await self.readonly_tools.execute_at_root(
                root=root,
                tool_name=tool_name,
                arguments=arguments,
                source_identity={"execution_workspace_id": self.workspace_id},
            )
        except (ReadonlyToolValidationError, ToolOperationError) as error:
            raise PiRuntimeError(str(error), code=error.code) from error

    def metrics(self) -> dict[str, Any]:
        metrics = {
            "model_call_count": self._model_call_count,
            "internal_tool_call_count": self._internal_tool_call_count,
            **self._usage,
            "duration_ms": int((time.monotonic() - self.started_at) * 1000),
            "tool_calls": copy.deepcopy(self._tool_events),
            # This is the operator-pinned RPC contract version, not a value
            # guessed from CLI output after the process has already started.
            "pi_version": self.runtime.contract_version,
            "integration_mode": "jsonl_rpc_subprocess",
        }
        if self._pi_session is not None:
            metrics["pi_session"] = {
                **self._pi_session.public_view(),
                "freeze_error": self._pi_session_freeze_error,
            }
        elif self.tool_execution_id is not None:
            metrics["pi_session"] = {
                **pending_pi_session_view(
                    tool_execution_id=self.tool_execution_id,
                    product_session_id=self.product_session_id,
                    product_run_id=self.product_run_id,
                ),
                "state": "not_created",
                "error_code": self._pi_session_error_code,
            }
        return metrics

    def record_provider_outcome(self, status: str, error_code: str | None) -> None:
        if status == "failed" and error_code:
            self._last_provider_failure_code = error_code

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self.process
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except TimeoutError:
                process.kill()
                await process.wait()
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        for call in self._pending_provider_calls.values():
            if not call.decision.done():
                call.decision.cancel()
        self._pending_provider_calls.clear()
        self._pending_tool_boundaries.clear()
        self.manager.unregister(self.token)
        if self._pi_session is not None:
            try:
                self._pi_session.freeze()
            except ChatPiSessionError:
                self._pi_session_freeze_error = True
                logger.exception(
                    "pi_session_freeze_failed execution_id=%s session_id=%s",
                    self.tool_execution_id,
                    self._pi_session.id,
                )
        if self._temp_directory is not None:
            self._temp_directory.cleanup()
            self._temp_directory = None

    async def _command(self, command_type: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        command_id = str(uuid4())
        waiter: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._response_waiters[command_id] = waiter
        await self._write({"id": command_id, "type": command_type, **payload})
        try:
            result = await asyncio.wait_for(waiter, timeout=30)
        except TimeoutError as error:
            raise PiRuntimeError(f"pi RPC命令超时: {command_type}", code="pi_rpc_timeout") from error
        if result.get("success") is not True:
            raise PiRuntimeError(
                str(result.get("error") or f"pi RPC命令失败: {command_type}"),
                code="pi_rpc_rejected",
            )
        return result

    async def _write(self, value: Mapping[str, Any]) -> None:
        if self.process is None or self.process.stdin is None or self.process.returncode is not None:
            raise PiRuntimeError("pi RPC进程不可写", code="pi_process_closed")
        self.process.stdin.write(
            (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        )
        await self.process.stdin.drain()

    async def _read_stdout(self) -> None:
        assert self.process is not None and self.process.stdout is not None
        last_event_type = "decode"
        try:
            while line := await self.process.stdout.readline():
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                last_event_type = str(event.get("type") or "unknown")
                if event.get("type") == "response" and isinstance(event.get("id"), str):
                    waiter = self._response_waiters.pop(event["id"], None)
                    if waiter is not None and not waiter.done():
                        waiter.set_result(event)
                    continue
                await self._handle_event(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception(
                "pi_rpc_output_processing_failed event_type=%s error_type=%s",
                last_event_type,
                type(error).__name__,
            )
            safe_detail = _safe_pi_error(error)
            await self._boundaries.put(
                PiCompletedBoundary(
                    kind="completed",
                    text=(
                        f"pi RPC输出读取失败: {type(error).__name__}"
                        + (f"（{safe_detail}）" if safe_detail else "")
                    ),
                    metrics={
                        **self.metrics(),
                        "failure_code": "pi_rpc_output_failed",
                        "failure_type": type(error).__name__,
                    },
                    status="failed",
                    terminal_reason_code="pi_rpc_output_failed",
                )
            )
        finally:
            if not self._closed and self.process is not None:
                return_code = await self.process.wait()
                if return_code != 0:
                    detail = self._stderr[-1] if self._stderr else f"exit {return_code}"
                    await self._boundaries.put(
                        PiCompletedBoundary(
                            kind="completed",
                            text=f"pi进程异常结束: {detail[:300]}",
                            metrics={**self.metrics(), "failure_code": "pi_process_failed"},
                            status="failed",
                            terminal_reason_code="pi_process_failed",
                        )
                    )

    async def _read_stderr(self) -> None:
        assert self.process is not None and self.process.stderr is not None
        while line := await self.process.stderr.readline():
            text = line.decode("utf-8", errors="replace").strip()
            if text:
                self._stderr.append(text[:1000])
                self._stderr = self._stderr[-20:]

    async def _handle_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "extension_ui_request" and event.get("method") == "editor":
            if event.get("title") != "CHAT_PI_TOOL_APPROVAL":
                await self._write({"type": "extension_ui_response", "id": event.get("id"), "cancelled": True})
                return
            try:
                payload = json.loads(str(event.get("prefill") or "{}"))
            except json.JSONDecodeError:
                payload = {}
            arguments = payload.get("arguments") if isinstance(payload, dict) else {}
            normalized_arguments = self._normalize_tool_arguments(
                str(payload.get("tool_name") or ""),
                arguments if isinstance(arguments, dict) else {},
            )
            boundary = PiToolCallBoundary(
                kind="tool_call",
                rpc_request_id=str(event.get("id") or ""),
                tool_call_id=str(payload.get("tool_call_id") or ""),
                tool_name=str(payload.get("tool_name") or ""),
                arguments=normalized_arguments,
            )
            self._validate_tool_arguments(boundary.tool_name, boundary.arguments)
            if self._internal_tool_call_count >= MAX_PI_READ_TOOL_CALLS:
                raise PiRuntimeError(
                    "pi内部Tool调用次数超过当前上限",
                    code="pi_read_tool_call_limit",
                )
            self._internal_tool_call_count += 1
            if boundary.tool_call_id in self._pending_tool_boundaries:
                raise PiRuntimeError(
                    "pi重复使用了尚未完成的Tool Call ID",
                    code="pi_tool_boundary_duplicate",
                )
            self._pending_tool_boundaries[boundary.tool_call_id] = boundary
            await self._boundaries.put(boundary)
            return
        if event_type == "tool_execution_start":
            self._tool_events.append(
                {
                    "tool_call_id": str(event.get("toolCallId") or ""),
                    "tool_name": str(event.get("toolName") or ""),
                    "status": "running",
                    "started_offset_ms": int((time.monotonic() - self.started_at) * 1000),
                }
            )
            return
        if event_type == "tool_execution_end":
            tool_call_id = str(event.get("toolCallId") or "")
            item = next(
                (value for value in reversed(self._tool_events) if value["tool_call_id"] == tool_call_id),
                None,
            )
            if item is not None:
                item["status"] = "failed" if event.get("isError") else "completed"
                item["finished_offset_ms"] = int((time.monotonic() - self.started_at) * 1000)
            return
        if event_type == "message_end" and isinstance(event.get("message"), dict):
            message = event["message"]
            if message.get("role") == "assistant":
                self._final_stop_reason = str(message.get("stopReason") or "")
                self._final_error_message = _safe_pi_error(message.get("errorMessage"))
                text = _assistant_text(message)
                if text:
                    self._final_text = text
                usage = message.get("usage")
                if isinstance(usage, dict):
                    self._usage["input_tokens"] += int(usage.get("input") or 0)
                    self._usage["output_tokens"] += int(usage.get("output") or 0)
                    self._usage["cache_read_tokens"] += int(usage.get("cacheRead") or 0)
                    self._usage["cache_write_tokens"] += int(usage.get("cacheWrite") or 0)
                    self._usage["cost"] += float(
                        usage.get("cost", {}).get("total", 0) if isinstance(usage.get("cost"), dict) else 0
                    )
            return
        if event_type == "agent_end" and not event.get("willRetry"):
            failure = self._final_stop_reason in {"error", "aborted"}
            terminal_reason = self._last_provider_failure_code or (
                f"pi_{self._final_stop_reason}" if failure else "pi_completed"
            )
            await self._boundaries.put(
                PiCompletedBoundary(
                    kind="completed",
                    text=(
                        self._final_text or self._final_error_message or "pi执行完成，但没有返回可显示文本。"
                    ),
                    metrics=self.metrics(),
                    status=(
                        "cancelled"
                        if self._final_stop_reason == "aborted"
                        else ("failed" if failure else "succeeded")
                    ),
                    terminal_reason_code=terminal_reason,
                )
            )

    def _normalize_tool_arguments(
        self,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Canonicalize SDK-emitted absolute paths into the governed root.

        pi may serialize its working directory as an absolute Tool argument,
        while Chat's public Tool contract is repository-relative. Only paths
        contained by the exact execution root are accepted, so approval and
        Trace records never need the machine-private workspace locator.
        """

        normalized = copy.deepcopy(dict(arguments))
        if self.workspace_id is None and self.repository_fence is None:
            return normalized
        path_value = normalized.get("path")
        if not isinstance(path_value, str) or not path_value.strip():
            return normalized
        candidate = Path(path_value)
        if not candidate.is_absolute():
            return normalized
        root = Path(self.config.working_directory).resolve()
        resolved = candidate.resolve()
        if resolved != root and not resolved.is_relative_to(root):
            raise PiRuntimeError(
                f"pi {tool_name} Tool路径超出本次工作目录",
                code="pi_tool_path_escape",
            )
        relative = resolved.relative_to(root).as_posix()
        normalized["path"] = relative or "."
        return normalized

    def _validate_tool_arguments(self, tool_name: str, arguments: Mapping[str, Any]) -> None:
        if tool_name not in self.config.allowed_tools:
            raise PiRuntimeError(f"pi请求了未授权Tool: {tool_name}", code="pi_tool_not_allowed")
        if self.workspace_id is not None:
            if tool_name not in {*ReadonlyToolService.allowed_tools, "edit"}:
                raise PiRuntimeError(
                    f"pi请求了Workspace Allowlist之外的Tool: {tool_name}",
                    code="pi_tool_not_allowed",
                )
            return
        if self.repository_fence is not None:
            if tool_name not in ReadonlyToolService.allowed_tools:
                raise PiRuntimeError(
                    f"pi请求了非只读Tool: {tool_name}",
                    code="pi_tool_not_allowed",
                )
            return
        path_value = arguments.get("path")
        if isinstance(path_value, str) and path_value.strip():
            base = Path(self.config.working_directory)
            resolved = (
                (base / path_value).resolve()
                if not Path(path_value).is_absolute()
                else Path(path_value).resolve()
            )
            if resolved != base and not resolved.is_relative_to(base):
                raise PiRuntimeError("pi Tool路径超出本次工作目录", code="pi_tool_path_escape")
