"""Bridge to the Hermes brain over its OpenAI-compatible API.

Hermes exposes ``POST {base}/chat/completions`` (default
``http://localhost:8642/v1``) once started with ``API_SERVER_ENABLED=true``.
The actual model behind it is the customer's BYOB choice (Claude / GPT-4 /
Ollama-local) — Aether Core never sees the provider, only this endpoint.
"""

from __future__ import annotations

from ..circuit import CircuitBreaker
from ..config import Config
from ._http import HttpError, request_json


class HermesUnavailable(RuntimeError):
    """Raised when the brain cannot be reached or returns an error."""


class HermesBridge:
    def __init__(self, config: Config) -> None:
        self._base = config.hermes_api_base.rstrip("/")
        self._key = config.hermes_api_key
        self._model = config.hermes_model
        # Open after 3 consecutive failures; fast-fail for 30s before a trial.
        self._breaker = CircuitBreaker(threshold=3, cooldown=30.0)

    def _headers(self) -> dict[str, str]:
        headers = {}
        if self._key:
            headers["Authorization"] = f"Bearer {self._key}"
        return headers

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int | None = None,
    ) -> str:
        """Run a chat completion and return the assistant text.

        Raises :class:`HermesUnavailable` so the caller can fall back to a
        rule-based path (the brain may be a local Ollama that is down).
        """
        payload: dict = {
            "model": self._model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        if not self._breaker.allow():
            raise HermesUnavailable("circuit open: brain recently unavailable")
        try:
            data = request_json(
                "POST",
                f"{self._base}/chat/completions",
                headers=self._headers(),
                body=payload,
                timeout=120.0,
                retries=2,
            )
        except (ConnectionError, HttpError) as exc:
            self._breaker.record_failure()
            raise HermesUnavailable(str(exc)) from exc

        try:
            text = data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError) as exc:
            self._breaker.record_failure()
            raise HermesUnavailable(f"unexpected response shape: {data!r}") from exc
        self._breaker.record_success()
        return text

    def healthy(self) -> bool:
        try:
            request_json("GET", f"{self._base}/models", headers=self._headers(), timeout=5.0)
            return True
        except (ConnectionError, HttpError):
            return False
