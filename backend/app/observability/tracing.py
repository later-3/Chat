"""OpenTelemetry SDK bootstrap without an implicit external exporter."""

from __future__ import annotations

import threading

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

_lock = threading.Lock()
_initialized = False


def configure_tracing() -> None:
    """Install a local SDK provider once; deployment exporters remain explicit."""

    global _initialized
    with _lock:
        if _initialized:
            return
        provider = trace.get_tracer_provider()
        if provider.__class__.__name__ == "ProxyTracerProvider":
            trace.set_tracer_provider(
                TracerProvider(
                    resource=Resource.create(
                        {
                            "service.name": "chat",
                            "service.version": "0.1.0",
                        }
                    )
                )
            )
        _initialized = True


def tracer():
    configure_tracing()
    return trace.get_tracer("backend.app", "0.1.0")
