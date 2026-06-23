"""Contract / integration test for the Aether Core bridges.

Spins up mock OpenClaw + Hermes HTTP servers implementing the *assumed* wire
contract, then runs a full heartbeat against them. If the real engines differ,
this test (and OpenClawBridge.ROUTES) is the single place to adjust — it pins
exactly what Aether Core expects from each engine.

Runnable with plain `python tests/test_contracts.py`.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SENT = []  # deliverables the mock OpenClaw "received"


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        p = self.path.split("?")[0]
        # --- Hermes contract ---
        if p == "/v1/models":
            return self._json(200, {"data": [{"id": "hermes"}]})
        # --- OpenClaw contract ---
        if p == "/api/channels/conversations":
            return self._json(200, [{"id": "c1"}])
        if p == "/api/channels/conversations/c1/messages":
            return self._json(200, [
                {"id": "m1", "conversationId": "c1", "author": "bob",
                 "text": "@aether please summarise the Q3 report", "ts": 2, "isBot": False},
            ])
        return self._json(404, {"error": "no route"})

    def do_POST(self):
        p = self.path.split("?")[0]
        body = self._read()
        # --- Hermes contract: OpenAI-shaped completion ---
        if p == "/v1/chat/completions":
            return self._json(200, {
                "choices": [{"message": {"role": "assistant", "content": "Q3 summary: revenue up 12%."}}]
            })
        # --- OpenClaw contract: deliver a message back ---
        if p == "/api/channels/conversations/c1/messages":
            SENT.append(body)
            return self._json(200, {"ok": True, "id": "m2"})
        return self._json(404, {"error": "no route"})


def _serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_full_heartbeat_against_mock_engines():
    hermes = _serve()
    openclaw = _serve()
    # Use a fresh temp workspace each run so the dedup ledger never carries over.
    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            os.environ.update({
                "AETHER_TENANT_ID": "contract",
                "AETHER_PROFILE": "lite",  # 1 self-correct pass -> fast
                "HERMES_API_BASE": f"http://127.0.0.1:{hermes.server_address[1]}/v1",
                "OPENCLAW_GATEWAY_URL": f"http://127.0.0.1:{openclaw.server_address[1]}",
                "AETHER_WATCH_CHANNELS": "",  # exercise list_conversations
                "AETHER_WORKSPACE": tmpdir,
            })
            # import after env is set so config picks it up
            from aether_core.config import load_config
            from aether_core.heartbeat import Heartbeat

            SENT.clear()
            hb = Heartbeat(load_config())
            # brain should be reachable on the mock
            assert hb.brain.healthy() is True
            summary = hb.beat()
            assert summary["conversations"] == 1, summary
            assert summary["tasks"] >= 1, summary
            assert summary["delivered"] >= 1, summary
            assert SENT, "a deliverable should have been POSTed back to OpenClaw"
            assert "Aether deliverable" in SENT[0]["text"]
        finally:
            hermes.shutdown()
            openclaw.shutdown()


if __name__ == "__main__":
    test_full_heartbeat_against_mock_engines()
    print("ok")
