from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.api.request_context import is_high_frequency_read
from backend.app.config import ObservabilitySettings, Settings
from backend.app.main import create_app
from backend.app.observability.context import bind_context
from backend.app.observability.logging import (
    CorrelatedFormatter,
    configure_observability,
    redact_text,
)
from backend.app.observability.metrics import metrics
from backend.app.observability.tracing import tracer


def test_runtime_polling_is_measured_without_flooding_info_logs() -> None:
    assert is_high_frequency_read("GET", "/api/hitl/decision-requests")
    assert is_high_frequency_read("GET", "/api/runs/run-1/governance")
    assert is_high_frequency_read("GET", "/api/sessions/session-1/runs/run-1/trace")
    assert is_high_frequency_read("GET", "/api/runtime/product-runs/run-1")
    assert is_high_frequency_read("GET", "/api/runtime/jobs/job-1/events")
    assert not is_high_frequency_read("POST", "/api/runs/run-1/governance")
    assert not is_high_frequency_read("GET", "/api/sessions/session-1")


def test_structured_log_redacts_secrets_paths_sql_and_content() -> None:
    source = (
        "Bearer test-abcdefghijklmnopqrstuvwxyz123456 "
        'api_key="sk-test-abcdefghijklmnopqrstuvwxyz" '
        'prompt="用户私密内容" /Users/example/private/config.json '
        "SELECT secret FROM provider_config"
    )

    redacted = redact_text(source)

    assert "sk-" not in redacted
    assert "用户私密内容" not in redacted
    assert "/Users/" not in redacted
    assert "SELECT secret" not in redacted
    assert "[redacted-secret]" in redacted
    assert "[redacted-content]" in redacted
    assert "[redacted-path]" in redacted
    assert "[redacted-query]" in redacted


def test_json_log_includes_only_bound_correlation_and_otel_ids() -> None:
    formatter = CorrelatedFormatter(json_format=True)
    record = logging.LogRecord(
        name="backend.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="run_started",
        args=(),
        exc_info=None,
    )

    with bind_context(
        request_id="request-1",
        session_id="session-1",
        product_run_id="run-1",
        checkpoint_id="checkpoint-1",
        decision_request_id="decision-1",
        command_id="command-1",
        resource_id="project-1",
    ):
        with tracer().start_as_current_span("test-span"):
            payload = json.loads(formatter.format(record))

    assert payload["event"] == "run_started"
    assert payload["request_id"] == "request-1"
    assert payload["session_id"] == "session-1"
    assert payload["product_run_id"] == "run-1"
    assert payload["checkpoint_id"] == "checkpoint-1"
    assert payload["decision_request_id"] == "decision-1"
    assert payload["command_id"] == "command-1"
    assert payload["resource_id"] == "project-1"
    assert len(payload["trace_id"]) == 32
    assert len(payload["span_id"]) == 16
    assert "prompt" not in payload


def test_rotating_jsonl_file_keeps_correlated_process_events_after_terminal_loss(
    tmp_path: Path,
) -> None:
    log_file = tmp_path / "chat.jsonl"
    configure_observability(
        ObservabilitySettings(
            log_level="INFO",
            log_format="console",
            log_file=log_file,
            log_max_bytes=64 * 1024,
            log_backup_count=2,
        )
    )
    try:
        with bind_context(session_id="session-file", product_run_id="run-file"):
            logging.getLogger("backend.test.file").info("durable_test_event")
        for handler in logging.getLogger().handlers:
            handler.flush()

        [payload] = [
            json.loads(line)
            for line in log_file.read_text(encoding="utf-8").splitlines()
            if "durable_test_event" in line
        ]
        assert payload["event"] == "durable_test_event"
        assert payload["session_id"] == "session-file"
        assert payload["product_run_id"] == "run-file"
    finally:
        configure_observability(Settings.for_test().observability)


def test_health_diagnostics_and_request_metrics_are_read_only() -> None:
    metrics.reset()
    with TestClient(create_app(Settings.for_test())) as client:
        live = client.get("/api/live", headers={"X-Request-ID": "diagnostic-live"})
        ready = client.get("/api/ready")
        operations = client.get("/api/diagnostics/operations")
        metric_snapshot = client.get("/api/diagnostics/metrics")

    assert live.json() == {"status": "live"}
    assert live.headers["x-request-id"] == "diagnostic-live"
    assert ready.json() == {
        "status": "ready",
        "dependencies": {"product_store": "ready"},
    }
    assert operations.status_code == 200
    assert operations.json()["runtime_jobs"] == {}
    assert operations.json()["outbox_events"] == {}
    assert operations.json()["workers"] == []
    assert "payload" not in operations.text.lower()
    assert metric_snapshot.json()["counters"]["http.server.requests"] >= 3


def test_untrusted_request_id_is_replaced_before_it_reaches_logs_or_headers() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        response = client.get(
            "/api/live",
            headers={"X-Request-ID": "invalid request id with spaces"},
        )

    request_id = response.headers["x-request-id"]
    assert request_id != "invalid request id with spaces"
    assert len(request_id) == 36


def test_run_diagnostic_timeline_excludes_messages_payloads_and_failure_text() -> None:
    private_text = "这段用户消息不应进入诊断包"
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        run_response = client.post(
            "/api/agent",
            json={
                "threadId": session_id,
                "runId": "diagnostic-run",
                "state": {},
                "messages": [
                    {
                        "id": "diagnostic-user",
                        "role": "user",
                        "content": private_text,
                    }
                ],
                "tools": [],
                "context": [],
                "forwardedProps": {},
            },
        )
        assert run_response.status_code == 200
        product_run = client.get(f"/api/sessions/{session_id}/runs").json()["runs"][0]
        timeline = client.get(f"/api/diagnostics/runs/{product_run['id']}/timeline")

    assert timeline.status_code == 200
    payload = timeline.json()
    assert payload["run"]["id"] == product_run["id"]
    assert payload["attempts"]
    assert payload["runtime_jobs"]
    serialized = timeline.text
    assert private_text not in serialized
    assert "input_payload_json" not in serialized
    assert "public_payload_json" not in serialized
    assert "encoded_checkpoint_json" not in serialized
