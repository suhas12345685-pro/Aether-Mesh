"""A minimal circuit breaker.

Wraps a flaky dependency (the Hermes brain) so that, once it has failed enough
times in a row, calls fast-fail for a cooldown instead of hammering a dead
service every heartbeat. After the cooldown one trial call is allowed
(half-open); success closes the circuit, failure re-opens it.
"""

from __future__ import annotations

import time


class CircuitOpen(RuntimeError):
    """Raised when the breaker is open and the call is short-circuited."""


class CircuitBreaker:
    def __init__(self, *, threshold: int = 3, cooldown: float = 30.0) -> None:
        self.threshold = threshold
        self.cooldown = cooldown
        self._failures = 0
        self._opened_at: float | None = None

    @property
    def state(self) -> str:
        if self._opened_at is None:
            return "closed"
        if time.monotonic() - self._opened_at >= self.cooldown:
            return "half-open"
        return "open"

    def allow(self) -> bool:
        """Return True if a call may proceed (closed or half-open)."""
        return self.state != "open"

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None

    def record_failure(self) -> None:
        self._failures += 1
        if self._failures >= self.threshold and self._opened_at is None:
            self._opened_at = time.monotonic()
        elif self.state == "half-open":
            # trial failed -> re-open the window
            self._opened_at = time.monotonic()
