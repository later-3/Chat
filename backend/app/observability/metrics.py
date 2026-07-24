"""Small in-process metric registry with OpenTelemetry-compatible names."""

from __future__ import annotations

import threading
from collections import defaultdict
from dataclasses import dataclass


@dataclass(slots=True)
class Histogram:
    count: int = 0
    sum: float = 0.0
    maximum: float = 0.0


class MetricRegistry:
    """Keep bounded aggregate metrics; never retain payloads or user text."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: defaultdict[str, int] = defaultdict(int)
        self._histograms: defaultdict[str, Histogram] = defaultdict(Histogram)

    def increment(self, name: str, value: int = 1) -> None:
        with self._lock:
            self._counters[name] += value

    def observe(self, name: str, value: float) -> None:
        with self._lock:
            histogram = self._histograms[name]
            histogram.count += 1
            histogram.sum += value
            histogram.maximum = max(histogram.maximum, value)

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "counters": dict(sorted(self._counters.items())),
                "histograms": {
                    name: {
                        "count": value.count,
                        "sum": round(value.sum, 6),
                        "max": round(value.maximum, 6),
                    }
                    for name, value in sorted(self._histograms.items())
                },
            }

    def reset(self) -> None:
        """Reset only for deterministic process-local tests."""

        with self._lock:
            self._counters.clear()
            self._histograms.clear()


metrics = MetricRegistry()
