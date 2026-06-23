"""Environment-driven configuration for Aether Core.

All knobs come from the unified ``aether/.env`` (or the process environment).
Two execution tiers, mirroring the product's Lite/Power split:

    lite   -> phone-class node: slow heartbeat, single self-correction pass.
    power  -> desktop node: fast heartbeat, multi-pass verification.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(key: str, default: str = "") -> str:
    val = os.environ.get(key)
    return default if val is None else val


def _split(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _int(value: str, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Config:
    """Immutable runtime configuration resolved from the environment."""

    tenant_id: str = "demo"
    profile: str = "power"  # "lite" | "power"
    workspace: str = "./workspace"

    # Brain — Hermes (OpenAI-compatible)
    hermes_api_base: str = "http://localhost:8642/v1"
    hermes_api_key: str = ""
    hermes_model: str = "hermes"

    # Channels — OpenClaw gateway
    openclaw_url: str = "http://localhost:18789"
    openclaw_cmd: str = "openclaw"
    openclaw_token: str = ""
    watch_channels: list[str] = field(default_factory=list)

    # Body — Infrastructure layer (Node service)
    infra_api_base: str = "http://localhost:8090"
    infra_api_token: str = ""

    # Tier entitlements (0 = unlimited), injected by the platform worker spec.
    max_channels: int = 0
    max_deliverables_per_day: int = 0

    # Agent identity (set by the platform worker spec from the stored persona).
    agent_name: str = ""
    agent_email: str = ""

    # Email inbound channel: poll the infra inbox as a second conversation source.
    email_inbound_enabled: bool = False

    # SMS inbound channel: poll the infra SMS inbox as a task source.
    sms_inbound_enabled: bool = False
    agent_phone: str = ""

    @property
    def heartbeat_seconds(self) -> int:
        """Lite nodes beat slower to conserve a phone battery/data."""
        return 180 if self.profile == "lite" else 60

    @property
    def self_correct_passes(self) -> int:
        """Power nodes run an extra verification pass before delivering."""
        return 1 if self.profile == "lite" else 2

    @property
    def compile_skills(self) -> bool:
        """Only Power nodes self-compile downloaded skills (CPU heavy)."""
        return self.profile != "lite"


def load_config() -> Config:
    """Resolve a :class:`Config` from the current environment."""
    profile = _env("AETHER_PROFILE", "power").lower()
    if profile not in ("lite", "power"):
        profile = "power"
    return Config(
        tenant_id=_env("AETHER_TENANT_ID", "demo"),
        profile=profile,
        workspace=_env("AETHER_WORKSPACE", "./workspace"),
        hermes_api_base=_env("HERMES_API_BASE", "http://localhost:8642/v1"),
        hermes_api_key=_env("HERMES_API_KEY", ""),
        hermes_model=_env("HERMES_MODEL", "hermes"),
        openclaw_url=_env("OPENCLAW_GATEWAY_URL", "http://localhost:18789"),
        openclaw_cmd=_env("OPENCLAW_CMD", "openclaw"),
        openclaw_token=_env("OPENCLAW_TOKEN", ""),
        watch_channels=_split(_env("AETHER_WATCH_CHANNELS", "")),
        infra_api_base=_env("INFRA_API_BASE", "http://localhost:8090"),
        infra_api_token=_env("INFRA_API_TOKEN", ""),
        max_channels=_int(_env("AETHER_MAX_CHANNELS", "0")),
        max_deliverables_per_day=_int(_env("AETHER_MAX_DELIVERABLES_PER_DAY", "0")),
        agent_name=_env("AETHER_AGENT_NAME", ""),
        agent_email=_env("AETHER_AGENT_EMAIL", ""),
        email_inbound_enabled=_env("AETHER_EMAIL_INBOUND", "false").lower() == "true",
        sms_inbound_enabled=_env("AETHER_SMS_INBOUND", "false").lower() == "true",
        agent_phone=_env("AETHER_AGENT_PHONE", ""),
    )
