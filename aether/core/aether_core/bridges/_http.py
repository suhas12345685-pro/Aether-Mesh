"""Tiny stdlib JSON-over-HTTP client.

Kept dependency-free on purpose: Aether Core's hot loop must run in any demo
environment without `pip install`. If `httpx` is present it is *not* required —
this is enough for the JSON request/response the bridges need.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from typing import Any

# Status codes worth retrying (transient).
_RETRYABLE = {429, 500, 502, 503, 504}


class HttpError(RuntimeError):
    def __init__(self, status: int, body: str, url: str) -> None:
        super().__init__(f"HTTP {status} from {url}: {body[:300]}")
        self.status = status
        self.body = body
        self.url = url


def _once(method, url, headers, body, timeout) -> Any:
    data = None
    hdrs = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=hdrs, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as exc:  # 4xx/5xx
        raw = exc.read().decode("utf-8", "replace")
        raise HttpError(exc.code, raw, url) from exc
    except urllib.error.URLError as exc:  # host down / DNS / refused
        raise ConnectionError(f"cannot reach {url}: {exc.reason}") from exc


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: Any = None,
    timeout: float = 30.0,
    retries: int = 0,
    backoff: float = 0.25,
    _sleep=time.sleep,
) -> Any:
    """Perform a JSON request and decode the JSON response.

    Returns the decoded JSON (dict/list), or ``None`` for an empty body.
    Raises :class:`HttpError` on non-2xx, :class:`ConnectionError` if the host
    is unreachable (so callers can degrade gracefully).

    Transient failures (connection errors, HTTP 429/5xx) are retried up to
    ``retries`` times with exponential backoff + jitter.
    """
    attempt = 0
    while True:
        try:
            return _once(method, url, headers, body, timeout)
        except (ConnectionError, HttpError) as exc:
            transient = isinstance(exc, ConnectionError) or exc.status in _RETRYABLE
            if not transient or attempt >= retries:
                raise
            delay = backoff * (2 ** attempt) + random.uniform(0, backoff)
            _sleep(delay)
            attempt += 1
