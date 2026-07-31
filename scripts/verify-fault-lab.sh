#!/usr/bin/env bash
set -euo pipefail
export PYTHONBREAKPOINT=0

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

mkdir -p .artifacts

.venv/bin/pytest -q \
  --junitxml=.artifacts/fault-lab.xml \
  backend/tests/test_model_call_review.py::test_provider_failure_is_the_last_agui_event \
  backend/tests/test_model_call_review.py::test_timeout_like_failure_is_not_retried_and_is_exposed_as_outcome_unknown \
  backend/tests/test_model_call_review.py::test_cancelling_after_dispatch_claim_marks_attempt_unknown_without_retry \
  backend/tests/test_runtime_execution.py::test_expired_lease_is_requeued_only_before_external_dispatch \
  backend/tests/test_runtime_execution.py::test_cancel_before_worker_dispatch_is_a_durable_terminal_event \
  backend/tests/test_runtime_execution.py::test_running_cancel_is_consumed_without_publishing_success \
  backend/tests/test_runtime_execution.py::test_http_disconnect_does_not_cancel_worker_and_cursor_replays_rest \
  backend/tests/test_governance.py::test_outbox_lease_allows_only_one_worker_and_dead_letters_at_limit \
  backend/tests/test_continuous_chat.py::test_checkpoint_corruption_fails_closed_without_provider_replay \
  backend/tests/test_continuous_chat.py::test_outbox_worker_resumes_recorded_decision_after_api_process_restart

echo "Fault-lab evidence: .artifacts/fault-lab.xml"
