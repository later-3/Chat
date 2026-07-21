import asyncio
import hashlib
import json
import multiprocessing
import os
import queue
import sqlite3
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from agent_framework import (
    Executor,
    FileCheckpointStorage,
    WorkflowBuilder,
    WorkflowContext,
    handler,
    response_handler,
)
from agent_framework._workflows._request_info_mixin import RequestInfoMixin
from agent_framework_ag_ui import (
    AGUIThreadSnapshot,
    AgentFrameworkWorkflow,
    add_agent_framework_fastapi_endpoint,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _model_payload(prompt: str) -> dict[str, Any]:
    return {
        "model": "model-under-review",
        "instructions": "只根据已批准的上下文回答。",
        "input": [
            {"role": "user", "content": [{"type": "input_text", "text": "第一轮问题"}]},
            {"role": "assistant", "content": [{"type": "output_text", "text": "第一轮回答"}]},
            {"role": "user", "content": [{"type": "input_text", "text": prompt}]},
        ],
        "tools": [
            {
                "type": "function",
                "name": "lookup_order",
                "description": "读取订单状态",
                "parameters": {
                    "type": "object",
                    "properties": {"order_id": {"type": "string"}},
                    "required": ["order_id"],
                    "additionalProperties": False,
                },
            }
        ],
        "tool_choice": "auto",
        "reasoning": {"effort": "medium"},
        "text": {"verbosity": "low"},
        "store": False,
        "stream": True,
    }


@dataclass(frozen=True, slots=True)
class _PreparedProviderRequest:
    body: bytes
    body_sha256: str
    effective_context_view: dict[str, Any]
    provider_request_view: dict[str, Any]


class _ExactStreamingProviderAdapter:
    """Test-only adapter proving that approval and dispatch share one byte buffer."""

    def __init__(self, endpoint: str) -> None:
        self._endpoint = endpoint

    def prepare(self, prompt: str) -> _PreparedProviderRequest:
        payload = _model_payload(prompt)
        body = _canonical_json_bytes(payload)
        provider_view = json.loads(body)
        effective_view = {
            "instructions": provider_view["instructions"],
            "messages": provider_view["input"],
            "tools": provider_view["tools"],
            "model_parameters": {
                "model": provider_view["model"],
                "tool_choice": provider_view["tool_choice"],
                "reasoning": provider_view["reasoning"],
                "text": provider_view["text"],
                "store": provider_view["store"],
                "stream": provider_view["stream"],
            },
            "continuation": None,
        }
        return _PreparedProviderRequest(
            body=body,
            body_sha256=hashlib.sha256(body).hexdigest(),
            effective_context_view=effective_view,
            provider_request_view=provider_view,
        )

    async def stream(self, prepared: _PreparedProviderRequest) -> list[str]:
        chunks: list[str] = []
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            async with client.stream(
                "POST",
                self._endpoint,
                content=prepared.body,
                headers={"content-type": "application/json"},
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        chunks.append(line.removeprefix("data: "))
        return chunks


class _SQLiteContractStore:
    """Temporary contract store; every table is explicitly spike-only."""

    def __init__(self, path: str | Path, *, initialize: bool = True) -> None:
        self.path = str(path)
        if initialize:
            self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS spike_runs (
                    run_id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS spike_drafts (
                    draft_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    prompt TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    payload_sha256 TEXT NOT NULL,
                    status TEXT NOT NULL,
                    previous_draft_id TEXT,
                    FOREIGN KEY(run_id) REFERENCES spike_runs(run_id)
                );
                CREATE TABLE IF NOT EXISTS spike_approvals (
                    approval_id TEXT PRIMARY KEY,
                    draft_id TEXT NOT NULL UNIQUE,
                    binding_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    FOREIGN KEY(draft_id) REFERENCES spike_drafts(draft_id)
                );
                CREATE TABLE IF NOT EXISTS spike_attempts (
                    attempt_id TEXT PRIMARY KEY,
                    approval_id TEXT NOT NULL UNIQUE,
                    draft_id TEXT NOT NULL,
                    owner TEXT NOT NULL,
                    status TEXT NOT NULL,
                    FOREIGN KEY(approval_id) REFERENCES spike_approvals(approval_id),
                    FOREIGN KEY(draft_id) REFERENCES spike_drafts(draft_id)
                );
                CREATE TABLE IF NOT EXISTS spike_runtime_links (
                    thread_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    draft_id TEXT NOT NULL,
                    approval_id TEXT NOT NULL,
                    checkpoint_id TEXT
                );
                CREATE TABLE IF NOT EXISTS spike_audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    value TEXT
                );
                CREATE TABLE IF NOT EXISTS spike_agui_snapshots (
                    scope TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    PRIMARY KEY(scope, thread_id)
                );
                """
            )

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def _insert_draft(
        self,
        connection: sqlite3.Connection,
        *,
        run_id: str,
        version: int,
        prompt: str,
        previous_draft_id: str | None,
    ) -> tuple[str, str]:
        draft_id = _new_id("draft")
        approval_id = _new_id("approval")
        payload = _canonical_json_bytes(_model_payload(prompt))
        binding_hash = hashlib.sha256(payload).hexdigest()
        connection.execute(
            """
            INSERT INTO spike_drafts(
                draft_id, run_id, version, prompt, payload, payload_sha256, status, previous_draft_id
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending_approval', ?)
            """,
            (draft_id, run_id, version, prompt, payload, binding_hash, previous_draft_id),
        )
        connection.execute(
            "INSERT INTO spike_approvals(approval_id, draft_id, binding_hash, status) VALUES (?, ?, ?, 'pending')",
            (approval_id, draft_id, binding_hash),
        )
        return draft_id, approval_id

    def begin_interaction(self, thread_id: str, prompt: str) -> dict[str, str]:
        run_id = _new_id("run")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO spike_runs(run_id, thread_id, prompt, status) VALUES (?, ?, ?, 'waiting_approval')",
                (run_id, thread_id, prompt),
            )
            draft_id, approval_id = self._insert_draft(
                connection,
                run_id=run_id,
                version=1,
                prompt=prompt,
                previous_draft_id=None,
            )
            connection.execute(
                """
                INSERT INTO spike_runtime_links(thread_id, run_id, draft_id, approval_id, checkpoint_id)
                VALUES (?, ?, ?, ?, NULL)
                ON CONFLICT(thread_id) DO UPDATE SET
                    run_id=excluded.run_id,
                    draft_id=excluded.draft_id,
                    approval_id=excluded.approval_id,
                    checkpoint_id=NULL
                """,
                (thread_id, run_id, draft_id, approval_id),
            )
            connection.execute(
                "INSERT INTO spike_audit(thread_id, kind, value) VALUES (?, 'interaction_started', ?)",
                (thread_id, run_id),
            )
            connection.commit()
        return {"run_id": run_id, "draft_id": draft_id, "approval_id": approval_id}

    def create_revision(self, old_draft_id: str, prompt: str) -> dict[str, str]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            old = connection.execute(
                """
                SELECT d.run_id, d.version, d.status, r.thread_id, a.approval_id, a.status AS approval_status
                FROM spike_drafts d
                JOIN spike_runs r ON r.run_id = d.run_id
                JOIN spike_approvals a ON a.draft_id = d.draft_id
                WHERE d.draft_id = ?
                """,
                (old_draft_id,),
            ).fetchone()
            if old is None or old["status"] != "pending_approval" or old["approval_status"] != "pending":
                connection.rollback()
                raise ValueError("Only the current pending draft can be revised.")
            connection.execute("UPDATE spike_drafts SET status='superseded' WHERE draft_id=?", (old_draft_id,))
            connection.execute(
                "UPDATE spike_approvals SET status='superseded' WHERE approval_id=?",
                (old["approval_id"],),
            )
            draft_id, approval_id = self._insert_draft(
                connection,
                run_id=old["run_id"],
                version=int(old["version"]) + 1,
                prompt=prompt,
                previous_draft_id=old_draft_id,
            )
            connection.execute(
                """
                UPDATE spike_runtime_links
                SET draft_id=?, approval_id=?, checkpoint_id=NULL
                WHERE thread_id=? AND run_id=?
                """,
                (draft_id, approval_id, old["thread_id"], old["run_id"]),
            )
            connection.execute(
                "INSERT INTO spike_audit(thread_id, kind, value) VALUES (?, 'draft_revised', ?)",
                (old["thread_id"], draft_id),
            )
            connection.commit()
        return {"run_id": old["run_id"], "draft_id": draft_id, "approval_id": approval_id}

    def review_card_for_thread(self, thread_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT l.run_id, l.draft_id, l.approval_id, d.prompt, d.payload, d.payload_sha256
                FROM spike_runtime_links l
                JOIN spike_drafts d ON d.draft_id = l.draft_id
                WHERE l.thread_id=?
                """,
                (thread_id,),
            ).fetchone()
        if row is None:
            raise LookupError(thread_id)
        provider = json.loads(bytes(row["payload"]))
        return {
            "message": "请审核本次模型调用",
            "run_id": row["run_id"],
            "draft_id": row["draft_id"],
            "approval_id": row["approval_id"],
            "binding_hash": row["payload_sha256"],
            "effective_context": {
                "instructions": provider["instructions"],
                "messages": provider["input"],
                "tools": provider["tools"],
            },
            "provider_request": provider,
        }

    def revision_card(self, old_draft_id: str, new_draft_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT r.thread_id
                FROM spike_drafts d
                JOIN spike_runs r ON r.run_id=d.run_id
                WHERE d.draft_id=? AND d.previous_draft_id=? AND d.status='pending_approval'
                """,
                (new_draft_id, old_draft_id),
            ).fetchone()
        if row is None:
            raise ValueError("Revision is not a server-owned successor of the reviewed draft.")
        return self.review_card_for_thread(str(row["thread_id"]))

    def grant(self, approval_id: str) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            changed = connection.execute(
                "UPDATE spike_approvals SET status='granted' WHERE approval_id=? AND status='pending'",
                (approval_id,),
            ).rowcount
            if changed != 1:
                connection.rollback()
                raise ValueError("Approval is not pending.")
            connection.commit()

    def claim(self, approval_id: str, owner: str) -> bool:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT a.status AS approval_status, a.draft_id, a.binding_hash,
                       d.payload_sha256, d.status AS draft_status, r.thread_id, r.run_id
                FROM spike_approvals a
                JOIN spike_drafts d ON d.draft_id=a.draft_id
                JOIN spike_runs r ON r.run_id=d.run_id
                WHERE a.approval_id=?
                """,
                (approval_id,),
            ).fetchone()
            if (
                row is None
                or row["approval_status"] != "granted"
                or row["draft_status"] != "pending_approval"
                or row["binding_hash"] != row["payload_sha256"]
            ):
                connection.rollback()
                return False
            try:
                connection.execute(
                    """
                    INSERT INTO spike_attempts(attempt_id, approval_id, draft_id, owner, status)
                    VALUES (?, ?, ?, ?, 'claimed')
                    """,
                    (_new_id("attempt"), approval_id, row["draft_id"], owner),
                )
            except sqlite3.IntegrityError:
                connection.rollback()
                return False
            changed = connection.execute(
                "UPDATE spike_approvals SET status='consumed' WHERE approval_id=? AND status='granted'",
                (approval_id,),
            ).rowcount
            if changed != 1:
                connection.rollback()
                return False
            connection.execute("UPDATE spike_drafts SET status='dispatching' WHERE draft_id=?", (row["draft_id"],))
            connection.execute("UPDATE spike_runs SET status='running' WHERE run_id=?", (row["run_id"],))
            connection.execute(
                "INSERT INTO spike_audit(thread_id, kind, value) VALUES (?, 'attempt_claimed', ?)",
                (row["thread_id"], owner),
            )
            connection.commit()
            return True

    def mark_sent(self, approval_id: str) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT d.run_id, d.draft_id
                FROM spike_attempts a JOIN spike_drafts d ON d.draft_id=a.draft_id
                WHERE a.approval_id=? AND a.status='claimed'
                """,
                (approval_id,),
            ).fetchone()
            if row is None:
                connection.rollback()
                raise ValueError("No claimed attempt exists.")
            connection.execute("UPDATE spike_attempts SET status='sent' WHERE approval_id=?", (approval_id,))
            connection.execute("UPDATE spike_drafts SET status='sent' WHERE draft_id=?", (row["draft_id"],))
            connection.execute("UPDATE spike_runs SET status='completed' WHERE run_id=?", (row["run_id"],))
            connection.commit()

    def reject(self, approval_id: str) -> None:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT d.draft_id, d.run_id, r.thread_id
                FROM spike_approvals a
                JOIN spike_drafts d ON d.draft_id=a.draft_id
                JOIN spike_runs r ON r.run_id=d.run_id
                WHERE a.approval_id=? AND a.status='pending'
                """,
                (approval_id,),
            ).fetchone()
            if row is None:
                connection.rollback()
                raise ValueError("Approval is not pending.")
            connection.execute("UPDATE spike_approvals SET status='rejected' WHERE approval_id=?", (approval_id,))
            connection.execute("UPDATE spike_drafts SET status='rejected' WHERE draft_id=?", (row["draft_id"],))
            connection.execute("UPDATE spike_runs SET status='rejected' WHERE run_id=?", (row["run_id"],))
            connection.execute(
                "UPDATE spike_runtime_links SET checkpoint_id=NULL WHERE thread_id=?",
                (row["thread_id"],),
            )
            connection.commit()

    def record_workflow_start(self, thread_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO spike_audit(thread_id, kind, value) VALUES (?, 'workflow_start', ?)",
                (thread_id, str(os.getpid())),
            )

    def save_checkpoint(self, thread_id: str, approval_id: str, checkpoint_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE spike_runtime_links SET checkpoint_id=?
                WHERE thread_id=? AND approval_id=?
                """,
                (checkpoint_id, thread_id, approval_id),
            )

    def checkpoint_for(self, thread_id: str, approval_id: str) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT checkpoint_id FROM spike_runtime_links WHERE thread_id=? AND approval_id=?",
                (thread_id, approval_id),
            ).fetchone()
        return str(row["checkpoint_id"]) if row is not None and row["checkpoint_id"] else None

    def clear_checkpoint(self, thread_id: str) -> None:
        with self._connect() as connection:
            connection.execute("UPDATE spike_runtime_links SET checkpoint_id=NULL WHERE thread_id=?", (thread_id,))

    def get(self, table: str, key_name: str, key: str) -> dict[str, Any]:
        allowed = {
            "spike_runs": "run_id",
            "spike_drafts": "draft_id",
            "spike_approvals": "approval_id",
        }
        if allowed.get(table) != key_name:
            raise ValueError("Unsupported spike query.")
        with self._connect() as connection:
            row = connection.execute(f"SELECT * FROM {table} WHERE {key_name}=?", (key,)).fetchone()
        if row is None:
            raise LookupError(key)
        return dict(row)

    def attempts(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT * FROM spike_attempts ORDER BY attempt_id").fetchall()
        return [dict(row) for row in rows]

    def audit_count(self, thread_id: str, kind: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM spike_audit WHERE thread_id=? AND kind=?",
                (thread_id, kind),
            ).fetchone()
        return int(row["count"])


class _SQLiteAGUISnapshotStore:
    def __init__(self, db_path: str | Path) -> None:
        self._store = _SQLiteContractStore(db_path)

    async def save(self, *, scope: str, thread_id: str, snapshot: AGUIThreadSnapshot) -> None:
        payload = json.dumps(
            {"messages": snapshot.messages, "state": snapshot.state, "interrupt": snapshot.interrupt},
            ensure_ascii=False,
            sort_keys=True,
        )
        with self._store._connect() as connection:
            connection.execute(
                """
                INSERT INTO spike_agui_snapshots(scope, thread_id, payload) VALUES (?, ?, ?)
                ON CONFLICT(scope, thread_id) DO UPDATE SET payload=excluded.payload
                """,
                (scope, thread_id, payload),
            )

    async def get(self, *, scope: str, thread_id: str) -> AGUIThreadSnapshot | None:
        with self._store._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM spike_agui_snapshots WHERE scope=? AND thread_id=?",
                (scope, thread_id),
            ).fetchone()
        if row is None:
            return None
        payload = json.loads(row["payload"])
        return AGUIThreadSnapshot(
            messages=payload["messages"],
            state=payload["state"],
            interrupt=payload["interrupt"],
        )

    async def delete(self, *, scope: str, thread_id: str) -> bool:
        with self._store._connect() as connection:
            changed = connection.execute(
                "DELETE FROM spike_agui_snapshots WHERE scope=? AND thread_id=?",
                (scope, thread_id),
            ).rowcount
        return changed == 1

    async def clear(self, *, scope: str | None = None) -> None:
        with self._store._connect() as connection:
            if scope is None:
                connection.execute("DELETE FROM spike_agui_snapshots")
            else:
                connection.execute("DELETE FROM spike_agui_snapshots WHERE scope=?", (scope,))


class _ApprovalExecutor(Executor, RequestInfoMixin):
    def __init__(self, db_path: str, thread_id: str) -> None:
        super().__init__(id="model_call_approval")
        self._db_path = db_path
        self._thread_id = thread_id

    @handler
    async def start(self, message: Any, ctx: WorkflowContext[Any, Any]) -> None:
        del message
        store = _SQLiteContractStore(self._db_path)
        store.record_workflow_start(self._thread_id)
        card = store.review_card_for_thread(self._thread_id)
        await ctx.request_info(card, dict, request_id=card["approval_id"])

    @response_handler
    async def resolve(
        self,
        original_request: dict[str, Any],
        decision: dict[str, Any],
        ctx: WorkflowContext[Any, Any],
    ) -> None:
        store = _SQLiteContractStore(self._db_path)
        approval_id = str(original_request["approval_id"])
        action = decision.get("decision")
        if action == "approve":
            store.grant(approval_id)
            if not store.claim(approval_id, owner=f"worker-pid-{os.getpid()}"):
                await ctx.yield_output("MODEL_SEND_SKIPPED_DUPLICATE")
                return
            store.mark_sent(approval_id)
            await ctx.yield_output(f"MODEL_SENT:{original_request['provider_request']['input'][-1]['content'][0]['text']}")
            return
        if action == "revise":
            new_draft_id = str(decision["revision_draft_id"])
            card = store.revision_card(str(original_request["draft_id"]), new_draft_id)
            await ctx.request_info(card, dict, request_id=card["approval_id"])
            return
        if action == "reject":
            store.reject(approval_id)
            await ctx.yield_output("MODEL_CALL_REJECTED")
            return
        raise ValueError(f"Unsupported approval decision: {action}")


class _CheckpointReconnectWorkflow(AgentFrameworkWorkflow):
    """Thin test bridge from a product-owned runtime link to a MAF checkpoint."""

    def __init__(self, db_path: str, checkpoint_dir: str) -> None:
        self._contract_store = _SQLiteContractStore(db_path)
        self._checkpoint_storage = FileCheckpointStorage(checkpoint_dir)

        def workflow_factory(thread_id: str):
            approval_executor = _ApprovalExecutor(db_path, thread_id)
            return WorkflowBuilder(
                name="model-call-approval-spike",
                start_executor=approval_executor,
                checkpoint_storage=self._checkpoint_storage,
                output_from=[approval_executor],
            ).build()

        super().__init__(
            workflow_factory=workflow_factory,
            snapshot_store=_SQLiteAGUISnapshotStore(db_path),
        )

    @staticmethod
    def _resume_entries(input_data: dict[str, Any]) -> list[dict[str, Any]]:
        resume = input_data.get("resume")
        if isinstance(resume, list):
            return [item for item in resume if isinstance(item, dict)]
        if isinstance(resume, dict):
            entries = resume.get("interrupts") or resume.get("interrupt")
            if isinstance(entries, list):
                return [item for item in entries if isinstance(item, dict)]
            return [resume]
        return []

    @staticmethod
    async def _pending_ids(workflow: Any) -> set[str]:
        runner_context = getattr(workflow, "_runner_context", None)
        if runner_context is None:
            return set()
        pending = await runner_context.get_pending_request_info_events()
        return {str(key) for key in pending}

    async def run(self, input_data: dict[str, Any]):
        thread_id = str(input_data.get("thread_id") or input_data.get("threadId"))
        snapshot_scope = input_data.get("__ag_ui_snapshot_scope")
        workflow = self._resolve_workflow(thread_id, snapshot_scope)
        resume_entries = self._resume_entries(input_data)
        if resume_entries and not await self._pending_ids(workflow):
            approval_id = str(resume_entries[0].get("interrupt_id") or resume_entries[0].get("interruptId") or resume_entries[0].get("id"))
            checkpoint_id = self._contract_store.checkpoint_for(thread_id, approval_id)
            if checkpoint_id is None:
                raise RuntimeError("Product runtime link has no MAF checkpoint for this approval.")
            async for _ in workflow.run(checkpoint_id=checkpoint_id, stream=True):
                pass

        interrupt_ids: list[str] = []
        async for event in super().run(input_data):
            if getattr(event, "type", None) == "RUN_FINISHED":
                dumped = event.model_dump(by_alias=True, exclude_none=True)
                outcome = dumped.get("outcome")
                if isinstance(outcome, dict) and outcome.get("type") == "interrupt":
                    interrupt_ids = [str(item["id"]) for item in outcome.get("interrupts", [])]
            yield event

        if interrupt_ids:
            checkpoints = await self._checkpoint_storage.list_checkpoints(workflow_name=workflow.name)
            for approval_id in interrupt_ids:
                candidates = [
                    checkpoint
                    for checkpoint in checkpoints
                    if approval_id in checkpoint.pending_request_info_events
                ]
                if not candidates:
                    raise RuntimeError(f"MAF did not persist pending request {approval_id} in a checkpoint.")
                self._contract_store.save_checkpoint(thread_id, approval_id, candidates[-1].checkpoint_id)
        elif resume_entries:
            self._contract_store.clear_checkpoint(thread_id)


def _build_spike_app(db_path: str, checkpoint_dir: str) -> FastAPI:
    app = FastAPI()
    runner = _CheckpointReconnectWorkflow(db_path, checkpoint_dir)
    app.state.runner = runner
    add_agent_framework_fastapi_endpoint(
        app,
        runner,
        path="/agent",
        snapshot_scope_resolver=lambda _request: "tenant-spike",
        keepalive_seconds=None,
    )
    return app


def _decode_sse(response: Any) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _interrupts(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    finished = [event for event in events if event.get("type") == "RUN_FINISHED"][-1]
    outcome = finished.get("outcome")
    return list(outcome["interrupts"]) if isinstance(outcome, dict) else []


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(str(event.get("delta", "")) for event in events if event.get("type") == "TEXT_MESSAGE_CONTENT")


def _process_http_requests(
    db_path: str,
    checkpoint_dir: str,
    requests: list[dict[str, Any]],
    result_queue: multiprocessing.Queue,
) -> None:
    try:
        app = _build_spike_app(db_path, checkpoint_dir)
        with TestClient(app) as client:
            event_sets = [_decode_sse(client.post("/agent", json=payload)) for payload in requests]
        result_queue.put({"pid": os.getpid(), "event_sets": event_sets})
    except BaseException:
        result_queue.put({"pid": os.getpid(), "error": traceback.format_exc()})


def _claim_in_fresh_process(
    db_path: str,
    approval_id: str,
    owner: str,
    barrier: Any,
    result_queue: multiprocessing.Queue,
) -> None:
    try:
        store = _SQLiteContractStore(db_path, initialize=False)
        barrier.wait(timeout=15)
        result_queue.put({"pid": os.getpid(), "claimed": store.claim(approval_id, owner)})
    except BaseException:
        result_queue.put({"pid": os.getpid(), "error": traceback.format_exc()})


def _run_in_fresh_process(
    db_path: Path,
    checkpoint_dir: Path,
    requests: list[dict[str, Any]],
) -> dict[str, Any]:
    context = multiprocessing.get_context("spawn")
    result_queue = context.Queue()
    process = context.Process(
        target=_process_http_requests,
        args=(str(db_path), str(checkpoint_dir), requests, result_queue),
    )
    process.start()
    process.join(timeout=30)
    if process.is_alive():
        process.terminate()
        process.join(timeout=5)
        raise AssertionError("Spike child process did not finish in 30 seconds.")
    assert process.exitcode == 0
    try:
        result = result_queue.get(timeout=5)
    except queue.Empty as error:
        raise AssertionError("Spike child process returned no result.") from error
    assert "error" not in result, result.get("error")
    return result


def _message_request(thread_id: str, run_id: str, prompt: str) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": run_id,
        "messages": [{"id": _new_id("message"), "role": "user", "content": prompt}],
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _resume_request(thread_id: str, run_id: str, approval_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "threadId": thread_id,
        "runId": run_id,
        "messages": [],
        "resume": [{"interruptId": approval_id, "status": "resolved", "payload": payload}],
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def test_streaming_provider_dispatches_the_exact_approved_body_bytes() -> None:
    async def scenario() -> None:
        captured_bodies: list[bytes] = []

        async def receive(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            header_bytes = await reader.readuntil(b"\r\n\r\n")
            headers = header_bytes.decode("latin-1").split("\r\n")
            content_length = int(
                next(line.split(":", 1)[1].strip() for line in headers if line.lower().startswith("content-length:"))
            )
            captured_bodies.append(await reader.readexactly(content_length))
            event_body = "data: {\"delta\":\"第一段\"}\n\ndata: {\"delta\":\"第二段\"}\n\n".encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/event-stream\r\n"
                + f"Content-Length: {len(event_body)}\r\nConnection: close\r\n\r\n".encode()
            )
            await writer.drain()
            midpoint = len(event_body) // 2
            writer.write(event_body[:midpoint])
            await writer.drain()
            await asyncio.sleep(0)
            writer.write(event_body[midpoint:])
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(receive, "127.0.0.1", 0)
        port = int(server.sockets[0].getsockname()[1])
        adapter = _ExactStreamingProviderAdapter(f"http://127.0.0.1:{port}/responses")
        prepared = adapter.prepare("只查询订单 A-100，不要执行修改")
        try:
            chunks = await adapter.stream(prepared)
        finally:
            server.close()
            await server.wait_closed()

        assert captured_bodies == [prepared.body]
        assert hashlib.sha256(captured_bodies[0]).hexdigest() == prepared.body_sha256
        assert chunks == ['{"delta":"第一段"}', '{"delta":"第二段"}']
        provider = prepared.provider_request_view
        effective = prepared.effective_context_view
        assert effective["instructions"] == provider["instructions"]
        assert effective["messages"] == provider["input"]
        assert effective["tools"] == provider["tools"]
        assert effective["model_parameters"] == {
            "model": provider["model"],
            "tool_choice": provider["tool_choice"],
            "reasoning": provider["reasoning"],
            "text": provider["text"],
            "store": False,
            "stream": True,
        }
        assert effective["continuation"] is None
        assert "previous_response_id" not in provider

    asyncio.run(scenario())


def test_sqlite_claim_is_atomic_across_eight_workers(tmp_path: Path) -> None:
    store = _SQLiteContractStore(tmp_path / "approval-concurrency.db")
    interaction = store.begin_interaction("thread-concurrency", "并发审批测试")
    store.grant(interaction["approval_id"])
    context = multiprocessing.get_context("spawn")
    barrier = context.Barrier(8)
    result_queue = context.Queue()
    processes = [
        context.Process(
            target=_claim_in_fresh_process,
            args=(store.path, interaction["approval_id"], f"worker-{worker}", barrier, result_queue),
        )
        for worker in range(8)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=30)
        assert not process.is_alive()
        assert process.exitcode == 0
    results = [result_queue.get(timeout=5) for _ in processes]
    assert not [result for result in results if "error" in result]
    assert len({result["pid"] for result in results}) == 8
    winners = [bool(result["claimed"]) for result in results]

    assert winners.count(True) == 1
    assert winners.count(False) == 7
    attempts = store.attempts()
    assert len(attempts) == 1
    assert attempts[0]["approval_id"] == interaction["approval_id"]
    assert store.get("spike_approvals", "approval_id", interaction["approval_id"])["status"] == "consumed"

    reopened = _SQLiteContractStore(tmp_path / "approval-concurrency.db")
    assert reopened.claim(interaction["approval_id"], owner="worker-after-restart") is False
    assert len(reopened.attempts()) == 1


def test_agui_product_approval_and_maf_checkpoint_reconnect_across_process_restart(tmp_path: Path) -> None:
    db_path = tmp_path / "restart.db"
    checkpoint_dir = tmp_path / "checkpoints"
    store = _SQLiteContractStore(db_path)
    thread_id = "thread-restart"
    interaction = store.begin_interaction(thread_id, "重启后仍只发送这一版")

    paused = _run_in_fresh_process(
        db_path,
        checkpoint_dir,
        [_message_request(thread_id, interaction["run_id"], "开始")],
    )
    pause_events = paused["event_sets"][0]
    assert _interrupts(pause_events)[0]["id"] == interaction["approval_id"]
    checkpoint_id = store.checkpoint_for(thread_id, interaction["approval_id"])
    assert checkpoint_id is not None
    assert store.get("spike_approvals", "approval_id", interaction["approval_id"])["status"] == "pending"

    hydrate_request = {
        "threadId": thread_id,
        "runId": _new_id("hydrate"),
        "messages": [],
        "state": {},
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    restarted = _run_in_fresh_process(
        db_path,
        checkpoint_dir,
        [
            hydrate_request,
            _resume_request(
                thread_id,
                _new_id("resume"),
                interaction["approval_id"],
                {"decision": "approve"},
            ),
        ],
    )
    assert paused["pid"] != restarted["pid"]
    hydrated_events, resumed_events = restarted["event_sets"]
    assert _interrupts(hydrated_events)[0]["id"] == interaction["approval_id"]
    assert not [event for event in resumed_events if event.get("type") == "RUN_ERROR"]
    assert "MODEL_SENT:重启后仍只发送这一版" in _text(resumed_events)
    assert store.audit_count(thread_id, "workflow_start") == 1
    assert store.get("spike_approvals", "approval_id", interaction["approval_id"])["status"] == "consumed"
    assert store.get("spike_runs", "run_id", interaction["run_id"])["status"] == "completed"
    assert len(store.attempts()) == 1
    snapshot = asyncio.run(_SQLiteAGUISnapshotStore(db_path).get(scope="tenant-spike", thread_id=thread_id))
    assert snapshot is not None
    assert snapshot.interrupt is None


def test_return_for_revision_requires_a_new_draft_and_a_second_approval(tmp_path: Path) -> None:
    db_path = tmp_path / "revision.db"
    checkpoint_dir = tmp_path / "revision-checkpoints"
    store = _SQLiteContractStore(db_path)
    thread_id = "thread-revision"
    first = store.begin_interaction(thread_id, "原始 prompt")
    app = _build_spike_app(str(db_path), str(checkpoint_dir))

    with TestClient(app) as client:
        paused = _decode_sse(client.post("/agent", json=_message_request(thread_id, first["run_id"], "开始")))
        assert _interrupts(paused)[0]["id"] == first["approval_id"]

        invalid_direct_edit = _decode_sse(
            client.post("/agent", json=_message_request(thread_id, _new_id("run"), "直接把 prompt 改掉"))
        )
        errors = [event for event in invalid_direct_edit if event.get("type") == "RUN_ERROR"]
        assert errors[0]["code"] == "WORKFLOW_RESUME_REQUIRED"

        revised = store.create_revision(first["draft_id"], "修改后的 prompt")
        revision_events = _decode_sse(
            client.post(
                "/agent",
                json=_resume_request(
                    thread_id,
                    _new_id("revise"),
                    first["approval_id"],
                    {"decision": "revise", "revision_draft_id": revised["draft_id"]},
                ),
            )
        )
        assert _interrupts(revision_events)[0]["id"] == revised["approval_id"]
        assert len(store.attempts()) == 0

        sent_events = _decode_sse(
            client.post(
                "/agent",
                json=_resume_request(
                    thread_id,
                    _new_id("approve"),
                    revised["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )

    assert "MODEL_SENT:修改后的 prompt" in _text(sent_events)
    assert store.get("spike_drafts", "draft_id", first["draft_id"])["status"] == "superseded"
    assert store.get("spike_approvals", "approval_id", first["approval_id"])["status"] == "superseded"
    assert store.get("spike_drafts", "draft_id", revised["draft_id"])["status"] == "sent"
    assert len(store.attempts()) == 1
    assert store.attempts()[0]["draft_id"] == revised["draft_id"]


def test_reject_ends_the_call_and_later_send_starts_a_new_run(tmp_path: Path) -> None:
    db_path = tmp_path / "rejection.db"
    checkpoint_dir = tmp_path / "rejection-checkpoints"
    store = _SQLiteContractStore(db_path)
    thread_id = "thread-rejection"
    rejected = store.begin_interaction(thread_id, "不要发送这一版")
    app = _build_spike_app(str(db_path), str(checkpoint_dir))

    with TestClient(app) as client:
        paused = _decode_sse(client.post("/agent", json=_message_request(thread_id, rejected["run_id"], "开始")))
        assert _interrupts(paused)[0]["id"] == rejected["approval_id"]

        rejected_events = _decode_sse(
            client.post(
                "/agent",
                json=_resume_request(
                    thread_id,
                    _new_id("reject"),
                    rejected["approval_id"],
                    {"decision": "reject"},
                ),
            )
        )
        assert not [event for event in rejected_events if event.get("type") == "RUN_ERROR"]
        assert "MODEL_CALL_REJECTED" in _text(rejected_events)
        assert len(store.attempts()) == 0

        new_interaction = store.begin_interaction(thread_id, "用户编辑后重新发送的 prompt")
        assert new_interaction["run_id"] != rejected["run_id"]
        second_pause = _decode_sse(
            client.post(
                "/agent",
                json=_message_request(thread_id, new_interaction["run_id"], "用户再次点击发送"),
            )
        )
        assert _interrupts(second_pause)[0]["id"] == new_interaction["approval_id"]

        sent_events = _decode_sse(
            client.post(
                "/agent",
                json=_resume_request(
                    thread_id,
                    _new_id("approve"),
                    new_interaction["approval_id"],
                    {"decision": "approve"},
                ),
            )
        )

    assert "MODEL_SENT:用户编辑后重新发送的 prompt" in _text(sent_events)
    assert store.get("spike_runs", "run_id", rejected["run_id"])["status"] == "rejected"
    assert store.get("spike_approvals", "approval_id", rejected["approval_id"])["status"] == "rejected"
    assert store.get("spike_runs", "run_id", new_interaction["run_id"])["status"] == "completed"
    attempts = store.attempts()
    assert len(attempts) == 1
    assert attempts[0]["approval_id"] == new_interaction["approval_id"]
