"""Reliability tests: circuit breaker + HTTP retry/backoff.

Runnable with plain `python tests/test_reliability.py` (no pytest required).
"""

from __future__ import annotations

import sys
import time
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aether_core.bridges import _http
from aether_core.bridges import hermes_bridge as hb
from aether_core.bridges.hermes_bridge import HermesBridge, HermesUnavailable
from aether_core.circuit import CircuitBreaker
from aether_core.config import load_config


@contextmanager
def patched(obj, attr, value):
    original = getattr(obj, attr)
    setattr(obj, attr, value)
    try:
        yield
    finally:
        setattr(obj, attr, original)


def test_circuit_breaker_opens_and_recovers():
    cb = CircuitBreaker(threshold=2, cooldown=0.05)
    assert cb.state == "closed" and cb.allow()
    cb.record_failure()
    assert cb.state == "closed"  # below threshold
    cb.record_failure()
    assert cb.state == "open" and not cb.allow()  # tripped
    time.sleep(0.06)
    assert cb.state == "half-open" and cb.allow()  # trial allowed
    cb.record_success()
    assert cb.state == "closed"


def test_http_retries_transient_then_succeeds():
    calls = {"n": 0}

    def flaky(method, url, headers, body, timeout):
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("refused")
        return {"ok": True}

    with patched(_http, "_once", flaky):
        out = _http.request_json("GET", "http://x", retries=5, _sleep=lambda _: None)
    assert out == {"ok": True}
    assert calls["n"] == 3  # failed twice, succeeded on the third


def test_http_gives_up_after_retries():
    def always_down(*a):
        raise ConnectionError("refused")

    with patched(_http, "_once", always_down):
        try:
            _http.request_json("GET", "http://x", retries=2, _sleep=lambda _: None)
            assert False, "should have raised"
        except ConnectionError:
            pass


def test_hermes_breaker_fast_fails():
    brain = HermesBridge(load_config())

    def down(*a, **k):
        raise ConnectionError("refused")

    with patched(hb, "request_json", down):
        for _ in range(3):  # trip the breaker
            try:
                brain.complete([{"role": "user", "content": "hi"}])
            except HermesUnavailable:
                pass
        assert brain._breaker.state == "open"
        try:
            brain.complete([{"role": "user", "content": "hi"}])
            assert False, "should short-circuit"
        except HermesUnavailable as exc:
            assert "circuit open" in str(exc)


if __name__ == "__main__":
    test_circuit_breaker_opens_and_recovers()
    test_http_retries_transient_then_succeeds()
    test_http_gives_up_after_retries()
    test_hermes_breaker_fast_fails()
    print("ok")
