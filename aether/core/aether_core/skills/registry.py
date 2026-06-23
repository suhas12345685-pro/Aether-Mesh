"""Aether Skill Registry client.

Fetches the curated skill catalogue from::

    https://registry.aethermesh.dev/skills.json

Falls back to the bundled ``registry.json`` when the remote is unavailable
(air-gapped nodes, dev machines, first-boot before network is up).

The registry is cached in memory for ``cache_ttl_seconds`` (default 1 h).
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

log = logging.getLogger("aether.skills.registry")

# Remote registry endpoint (operator-controlled, signed payloads only).
_REGISTRY_URL = "https://registry.aethermesh.dev/skills.json"

# Bundled fallback — always ships with the core package.
_BUNDLED_REGISTRY = Path(__file__).parent / "registry.json"

# HTTP request timeout in seconds.
_HTTP_TIMEOUT = 10


class SkillRegistry:
    """Catalogue of available skills with tool-to-skill resolution.

    Args:
        registry_url: Override the remote registry URL (useful in tests).
        cache_ttl_seconds: How long the in-memory catalogue is considered
            fresh before the next remote fetch is attempted.
    """

    REGISTRY_URL: str = _REGISTRY_URL
    BUNDLED_REGISTRY: Path = _BUNDLED_REGISTRY

    def __init__(
        self,
        registry_url: str | None = None,
        cache_ttl_seconds: int = 3600,
    ) -> None:
        self._url = registry_url or self.REGISTRY_URL
        self._ttl = cache_ttl_seconds
        self._cache: list[dict[str, Any]] = []
        self._cache_ts: float = 0.0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fetch(self) -> list[dict[str, Any]]:
        """Return the full skill catalogue, refreshing the cache when stale.

        Always returns a non-empty list: if the remote is unreachable and the
        cache is cold the bundled registry is loaded as the fallback.
        """
        if self._cache and (time.monotonic() - self._cache_ts) < self._ttl:
            return self._cache

        self._refresh_cache()
        return self._cache

    def find_for_tool(self, tool_name: str) -> dict[str, Any] | None:
        """Return the first skill that exposes *tool_name*, or ``None``.

        Matching is case-insensitive so ``Create_Issue`` finds ``create_issue``.
        """
        needle = tool_name.lower()
        for skill in self.fetch():
            tools: list[str] = skill.get("tools", [])
            if needle in (t.lower() for t in tools):
                return skill
        return None

    def find_by_name(self, skill_name: str) -> dict[str, Any] | None:
        """Return the skill whose ``name`` field equals *skill_name* (case-insensitive)."""
        needle = skill_name.lower()
        for skill in self.fetch():
            if skill.get("name", "").lower() == needle:
                return skill
        return None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _refresh_cache(self) -> None:
        """Try remote → fall back to bundled registry on any failure."""
        skills = self._fetch_remote()
        if skills is None:
            skills = self._load_bundled()

        self._cache = skills
        self._cache_ts = time.monotonic()

    def _fetch_remote(self) -> list[dict[str, Any]] | None:
        """GET the remote registry JSON.  Returns ``None`` on any error."""
        try:
            req = urllib.request.Request(
                self._url,
                headers={"Accept": "application/json", "User-Agent": "aether-core/1.0"},
            )
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                raw = resp.read()
            data = json.loads(raw)
            skills: list[dict] = data if isinstance(data, list) else data.get("skills", [])
            if not isinstance(skills, list):
                raise ValueError("registry payload is not a list")
            log.debug("registry: fetched %d skills from %s", len(skills), self._url)
            return skills
        except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError) as exc:
            log.info("registry: remote unavailable (%s), using bundled fallback", exc)
            return None

    def _load_bundled(self) -> list[dict[str, Any]]:
        """Load the bundled ``registry.json`` shipped with the package."""
        try:
            raw = self.BUNDLED_REGISTRY.read_text("utf-8")
            data = json.loads(raw)
            skills: list[dict] = data if isinstance(data, list) else data.get("skills", [])
            log.debug("registry: loaded %d skills from bundled registry", len(skills))
            return skills
        except (OSError, json.JSONDecodeError) as exc:
            log.error("registry: bundled registry unreadable: %s", exc)
            return []
