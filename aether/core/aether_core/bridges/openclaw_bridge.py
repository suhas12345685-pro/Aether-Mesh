"""Bridge to the OpenClaw gateway — the multi-channel fabric.

OpenClaw (and Hermes) expose a 9-tool *channel bridge* surface:
    conversations_list, conversation_get, messages_read, attachments_fetch,
    events_poll, events_wait, messages_send, permissions_list_open,
    permissions_respond

Aether Core only needs four of them: list conversations, read history, poll for
new events, and send a deliverable back. This bridge speaks to the gateway's
HTTP control plane (default :18789) and falls back to the ``openclaw`` CLI for
sending when HTTP is unavailable.

Route templates are configurable because the exact REST path can differ between
OpenClaw releases; override ``ROUTES`` to match ``openclaw gateway routes`` on
the installed version.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

from ..config import Config
from ._http import HttpError, request_json


@dataclass
class Message:
    id: str
    conversation_id: str
    author: str
    text: str
    ts: float
    is_bot: bool = False

    @classmethod
    def from_dict(cls, d: dict) -> "Message":
        return cls(
            id=str(d.get("id", "")),
            conversation_id=str(d.get("conversationId", d.get("conversation_id", ""))),
            author=str(d.get("author", d.get("sender", "unknown"))),
            text=str(d.get("text", d.get("body", ""))),
            ts=float(d.get("ts", d.get("timestamp", 0)) or 0),
            is_bot=bool(d.get("isBot", d.get("is_bot", False))),
        )


class OpenClawBridge:
    # tool -> (method, path template). Override to match the installed gateway.
    ROUTES = {
        "conversations_list": ("GET", "/api/channels/conversations"),
        "messages_read": ("GET", "/api/channels/conversations/{cid}/messages"),
        "events_poll": ("GET", "/api/channels/events"),
        "messages_send": ("POST", "/api/channels/conversations/{cid}/messages"),
    }

    def __init__(self, config: Config) -> None:
        self._cfg = config
        self._base = config.openclaw_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        headers = {}
        if self._cfg.openclaw_token:
            headers["Authorization"] = f"Bearer {self._cfg.openclaw_token}"
        return headers

    def _url(self, tool: str, **fmt) -> tuple[str, str]:
        method, path = self.ROUTES[tool]
        return method, self._base + path.format(**fmt)

    # -- reads ---------------------------------------------------------------
    def list_conversations(self) -> list[dict]:
        method, url = self._url("conversations_list")
        data = request_json(method, url, headers=self._headers(), timeout=15.0)
        return data if isinstance(data, list) else data.get("conversations", [])

    def read_messages(self, conversation_id: str, limit: int = 50) -> list[Message]:
        method, url = self._url("messages_read", cid=conversation_id)
        data = request_json(
            method, f"{url}?limit={limit}", headers=self._headers(), timeout=15.0
        )
        rows = data if isinstance(data, list) else data.get("messages", [])
        return [Message.from_dict(r) for r in rows]

    def poll_events(self, since_ts: float = 0.0) -> list[dict]:
        method, url = self._url("events_poll")
        data = request_json(
            method, f"{url}?since={since_ts}", headers=self._headers(), timeout=20.0
        )
        return data if isinstance(data, list) else data.get("events", [])

    # -- writes --------------------------------------------------------------
    def send_message(self, conversation_id: str, text: str) -> bool:
        """Deliver text back to a conversation. HTTP first, CLI fallback."""
        try:
            method, url = self._url("messages_send", cid=conversation_id)
            request_json(
                method,
                url,
                headers=self._headers(),
                body={"text": text},
                timeout=20.0,
            )
            return True
        except (ConnectionError, HttpError):
            return self._send_via_cli(conversation_id, text)

    def _send_via_cli(self, conversation_id: str, text: str) -> bool:
        try:
            result = subprocess.run(
                [self._cfg.openclaw_cmd, "message", "send",
                 "--conversation", conversation_id, "--text", text],
                capture_output=True, text=True, timeout=30,
            )
            return result.returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False
