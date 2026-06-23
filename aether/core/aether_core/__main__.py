"""Entry point: ``python -m aether_core`` (or the ``aether-core`` script).

Usage:
    python -m aether_core run            # run the heartbeat forever
    python -m aether_core beat           # run a single beat and exit
    python -m aether_core beat --dry-run # detect + solve but do not deliver
    python -m aether_core status         # show resolved config + service health
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

from .config import load_config
from .heartbeat import Heartbeat


class _JsonFormatter(logging.Formatter):
    """One JSON object per log line, matching the Node services' format."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + "Z",
            "level": record.levelname.lower(),
            "service": "aether-core",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        tenant = os.environ.get("AETHER_TENANT_ID")
        if tenant:
            payload["tenant"] = tenant
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def _setup_logging() -> None:
    handler = logging.StreamHandler()
    if os.environ.get("AETHER_LOG_JSON", "true").lower() != "false":
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aether-core", description="Aether Mesh Core")
    parser.add_argument(
        "command", choices=["run", "beat", "status"], nargs="?", default="run"
    )
    parser.add_argument("--dry-run", action="store_true", help="do not deliver")
    args = parser.parse_args(argv)

    _setup_logging()
    cfg = load_config()
    hb = Heartbeat(cfg)

    if args.command == "status":
        print(f"tenant       : {cfg.tenant_id}")
        print(f"profile      : {cfg.profile} (heartbeat {cfg.heartbeat_seconds}s, "
              f"{cfg.self_correct_passes} self-correct pass(es))")
        print(f"brain        : {cfg.hermes_api_base}  "
              f"[{'up' if hb.brain.healthy() else 'down'}]")
        print(f"channels     : {cfg.openclaw_url}")
        print(f"body (infra) : {cfg.infra_api_base}")
        identity = hb.infra.identity()
        if identity:
            print(f"identity     : {identity}")
        return 0

    if args.command == "beat":
        result = hb.beat(dry_run=args.dry_run)
        print(result)
        return 0

    hb.install_signal_handlers()
    hb.run_forever(dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
