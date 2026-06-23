"""SMS inbox channel bridge.

Polls the infra service's inbound SMS queue and presents each unread text as a
conversation the heartbeat loop can detect tasks in and reply to via SMS.

Uses the same duck-typed interface as OpenClawBridge / EmailChannel so
``produce_and_push`` works without modification.

Inbound flow:
    SMS → Twilio → POST /inbound/sms (infra) → inbound_messages (channel='sms')
    → GET /tenants/{id}/sms-inbox (this bridge) → detect_tasks → produce_and_push
    → send_message → POST /tenants/{id}/sms (infra Twilio outbound)
    → DELETE /tenants/{id}/sms-inbox/{msgId} (ack)
"""

from __future__ import annotations

import logging

from ..config import Config
from ._http import HttpError, request_json
from .openclaw_bridge import Message

log = logging.getLogger("aether.sms_channel")


class SmsChannel:
    """Duck-types OpenClawBridge for the heartbeat loop."""

    def __init__(self, config: Config) -> None:
        self._base = config.infra_api_base.rstrip("/")
        self._token = config.infra_api_token
        self._tenant = config.tenant_id
        # Track pending acks: {msg_id: conversation_id (sender's phone number)}
        self._pending: dict[str, str] = {}

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def _tenant_url(self, path: str) -> str:
        return f"{self._base}/tenants/{self._tenant}{path}"

    # -- reads (called by heartbeat) -----------------------------------------

    def list_conversations(self) -> list[dict]:
        """Return one conversation per unique sender phone number."""
        msgs = self._raw_inbox()
        seen: dict[str, dict] = {}
        for m in msgs:
            cid = m.get("fromAddr", "")  # sender's E.164 phone number
            if cid and cid not in seen:
                seen[cid] = {"id": cid, "channel": "sms"}
            if m.get("id"):
                self._pending[m["id"]] = cid
        return list(seen.values())

    def read_messages(self, conversation_id: str, limit: int = 50) -> list[Message]:
        """Return all unread SMS from this phone number as Message objects."""
        msgs = [m for m in self._raw_inbox() if m.get("fromAddr", "") == conversation_id]
        return [
            Message(
                id=m["id"],
                conversation_id=conversation_id,
                author=m.get("fromAddr", "unknown"),
                text=m.get("body", ""),
                ts=float(m.get("receivedAt", 0)) / 1000,
                is_bot=False,
            )
            for m in msgs[:limit]
        ]

    def poll_events(self, since_ts: float = 0.0) -> list[dict]:
        return []  # heartbeat uses list_conversations for SMS

    # -- writes --------------------------------------------------------------

    def send_message(self, conversation_id: str, text: str) -> bool:
        """Reply via SMS. conversation_id is the sender's E.164 phone number."""
        try:
            request_json(
                "POST",
                self._tenant_url("/sms"),
                headers=self._headers(),
                body={"to": conversation_id, "text": text},
                timeout=30.0,
            )
            return True
        except (ConnectionError, HttpError) as exc:
            log.warning("sms reply failed: %s", exc)
            return False

    # -- ack -----------------------------------------------------------------

    def ack_all_for(self, conversation_id: str) -> None:
        """Mark every SMS from this sender as processed."""
        for msg_id, cid in list(self._pending.items()):
            if cid == conversation_id:
                try:
                    request_json(
                        "DELETE",
                        self._tenant_url(f"/sms-inbox/{msg_id}"),
                        headers=self._headers(),
                        timeout=10.0,
                    )
                except Exception as exc:
                    log.debug("sms ack failed for %s: %s", msg_id, exc)
                self._pending.pop(msg_id, None)

    # -- internal ------------------------------------------------------------

    def _raw_inbox(self) -> list[dict]:
        try:
            data = request_json(
                "GET",
                self._tenant_url("/sms-inbox?limit=50"),
                headers=self._headers(),
                timeout=15.0,
            )
            return data if isinstance(data, list) else []
        except Exception as exc:
            log.debug("sms inbox fetch failed: %s", exc)
            return []
