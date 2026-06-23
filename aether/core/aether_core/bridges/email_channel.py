"""Email inbox channel bridge.

Polls the infra service's inbound email queue and presents each unread email as
a conversation that the heartbeat loop can detect tasks in and reply to — using
the same duck-typed interface as OpenClawBridge so ``produce_and_push`` works
without modification.

Inbound flow:
    email → Mailgun/SendGrid → POST /inbound/email (infra) → inbound_messages table
    → GET /tenants/{id}/inbox (this bridge) → detect_tasks → produce_and_push
    → send_message → POST /tenants/{id}/email (infra SMTP)
    → DELETE /tenants/{id}/inbox/{msgId} (ack)
"""

from __future__ import annotations

import json
import logging

from ..config import Config
from ._http import HttpError, request_json
from .openclaw_bridge import Message

log = logging.getLogger("aether.email_channel")


class EmailChannel:
    """Duck-types OpenClawBridge for the heartbeat loop."""

    def __init__(self, config: Config) -> None:
        self._base = config.infra_api_base.rstrip("/")
        self._token = config.infra_api_token
        self._tenant = config.tenant_id
        # Track pending acks: {msg_id: conversation_id}
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
        """Return one conversation per unique sender in the unread inbox."""
        msgs = self._raw_inbox()
        seen: dict[str, dict] = {}
        for m in msgs:
            cid = m.get("fromAddr", "")
            if cid and cid not in seen:
                seen[cid] = {"id": cid, "channel": "email", "subject": m.get("subject", "")}
            # Map each msg_id → conversation_id for acking later.
            self._pending[m["id"]] = cid
        return list(seen.values())

    def read_messages(self, conversation_id: str, limit: int = 50) -> list[Message]:
        """Return all unread emails from this sender as Message objects."""
        msgs = [m for m in self._raw_inbox() if m.get("fromAddr", "") == conversation_id]
        result = []
        for m in msgs[:limit]:
            subject = m.get("subject") or ""
            body = m.get("body") or ""
            text = f"Subject: {subject}\n\n{body}" if subject else body
            result.append(Message(
                id=m["id"],
                conversation_id=conversation_id,
                author=m.get("fromAddr", "unknown"),
                text=text,
                ts=float(m.get("receivedAt", 0)) / 1000,
                is_bot=False,
            ))
        return result

    def poll_events(self, since_ts: float = 0.0) -> list[dict]:
        return []  # heartbeat uses list_conversations for email

    # -- writes --------------------------------------------------------------

    def send_message(self, conversation_id: str, text: str) -> bool:
        """Reply by email. conversation_id is the sender's address."""
        # Find the original subject from pending messages so we can thread the reply.
        subject = "Re: your message"
        for m in self._raw_inbox():
            if m.get("fromAddr") == conversation_id and m.get("subject"):
                subject = f"Re: {m['subject']}"
                break
        try:
            request_json(
                "POST",
                self._tenant_url("/email"),
                headers=self._headers(),
                body={"to": conversation_id, "subject": subject, "body": text},
                timeout=30.0,
            )
            return True
        except (ConnectionError, HttpError) as exc:
            log.warning("email reply failed: %s", exc)
            return False

    # -- ack -----------------------------------------------------------------

    def ack_all_for(self, conversation_id: str) -> None:
        """Mark every inbox message from this sender as processed."""
        for msg_id, cid in list(self._pending.items()):
            if cid == conversation_id:
                try:
                    request_json(
                        "DELETE",
                        self._tenant_url(f"/inbox/{msg_id}"),
                        headers=self._headers(),
                        timeout=10.0,
                    )
                except Exception as exc:
                    log.debug("ack failed for %s: %s", msg_id, exc)
                self._pending.pop(msg_id, None)

    # -- internal ------------------------------------------------------------

    def _raw_inbox(self) -> list[dict]:
        try:
            data = request_json(
                "GET",
                self._tenant_url("/inbox?limit=50"),
                headers=self._headers(),
                timeout=15.0,
            )
            return data if isinstance(data, list) else []
        except Exception as exc:
            log.debug("inbox fetch failed: %s", exc)
            return []
