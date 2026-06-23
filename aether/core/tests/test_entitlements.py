"""Tier-entitlement enforcement in the heartbeat: per-day deliverable quota and
max watched channels. Runs against a single mock server that serves both the
OpenClaw (/api/*) and Hermes (/v1/*) contracts.

Runnable with plain `python tests/test_entitlements.py`.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SENT = []


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/v1/models":
            return self._send(200, {"data": []})
        if p == "/api/channels/conversations":
            return self._send(200, [{"id": "c1"}, {"id": "c2"}])
        if p.startswith("/api/channels/conversations/") and p.endswith("/messages"):
            cid = p.split("/")[4]
            return self._send(200, [
                {"id": f"{cid}-m1", "conversationId": cid, "author": "u",
                 "text": "@aether please do the thing", "ts": 1},
            ])
        return self._send(404, {})

    def do_POST(self):
        p = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length", 0))
        self.rfile.read(n)
        if p == "/v1/chat/completions":
            return self._send(200, {"choices": [{"message": {"content": "done."}}]})
        if p.endswith("/messages"):
            SENT.append(p)
            return self._send(200, {"ok": True})
        return self._send(404, {})


def _serve():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _env_for(srv, ws, **extra):
    port = srv.server_address[1]
    os.environ.update({
        "AETHER_TENANT_ID": "ent",
        "AETHER_PROFILE": "lite",
        "HERMES_API_BASE": f"http://127.0.0.1:{port}/v1",
        "OPENCLAW_GATEWAY_URL": f"http://127.0.0.1:{port}",
        "AETHER_WATCH_CHANNELS": "",
        "AETHER_WORKSPACE": str(ws),
        "AETHER_MAX_CHANNELS": "0",
        "AETHER_MAX_DELIVERABLES_PER_DAY": "0",
        **extra,
    })


def _fresh_heartbeat(ws):
    from aether_core.config import load_config
    from aether_core.heartbeat import Heartbeat
    shutil.rmtree(ws, ignore_errors=True)
    return Heartbeat(load_config())


def test_daily_deliverable_quota():
    srv = _serve()
    ws = Path(__file__).resolve().parent / "_ent_ws_quota"
    try:
        SENT.clear()
        _env_for(srv, ws, AETHER_MAX_DELIVERABLES_PER_DAY="1")
        hb = _fresh_heartbeat(ws)
        summary = hb.beat()
        # two conversations -> two tasks, but the quota caps deliveries at 1
        assert summary["tasks"] == 2, summary
        assert summary["delivered"] == 1, summary
        assert summary["skipped_quota"] == 1, summary
    finally:
        srv.shutdown()
        shutil.rmtree(ws, ignore_errors=True)


def test_max_channels_cap():
    srv = _serve()
    ws = Path(__file__).resolve().parent / "_ent_ws_chan"
    try:
        SENT.clear()
        _env_for(srv, ws, AETHER_MAX_CHANNELS="1")
        hb = _fresh_heartbeat(ws)
        summary = hb.beat()
        assert summary["conversations"] == 1, summary  # capped from 2 to 1
    finally:
        srv.shutdown()
        shutil.rmtree(ws, ignore_errors=True)


if __name__ == "__main__":
    test_daily_deliverable_quota()
    test_max_channels_cap()
    print("ok")
