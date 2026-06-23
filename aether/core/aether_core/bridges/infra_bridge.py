"""Bridge to the Infrastructure layer — the leased "body".

The Node infra service (default :8090) gives a tenant a real corporate identity:
a phone number, a mailbox, a sandboxed browser, and an isolated VM. Aether Core
calls it to *act in the world* on the tenant's behalf.
"""

from __future__ import annotations

from ..config import Config
from ._http import HttpError, request_json


class InfraBridge:
    def __init__(self, config: Config) -> None:
        self._base = config.infra_api_base.rstrip("/")
        self._token = config.infra_api_token
        self._tenant = config.tenant_id

    def _headers(self) -> dict[str, str]:
        headers = {}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def _post(self, path: str, body: dict) -> dict:
        return request_json(
            "POST",
            f"{self._base}/tenants/{self._tenant}{path}",
            headers=self._headers(),
            body=body,
            timeout=60.0,
        ) or {}

    # -- body capabilities ---------------------------------------------------
    def send_sms(self, to: str, text: str) -> dict:
        return self._post("/sms", {"to": to, "text": text})

    def send_email(self, to: str, subject: str, body: str) -> dict:
        return self._post("/email", {"to": to, "subject": subject, "body": body})

    def browser_action(self, action: str, **params) -> dict:
        return self._post("/browser", {"action": action, "params": params})

    def vm_exec(self, command: str) -> dict:
        return self._post("/vm/exec", {"command": command})

    def identity(self) -> dict:
        """Fetch the tenant's provisioned identity (phone/email/vm)."""
        try:
            return request_json(
                "GET",
                f"{self._base}/tenants/{self._tenant}",
                headers=self._headers(),
                timeout=15.0,
            ) or {}
        except (ConnectionError, HttpError):
            return {}
