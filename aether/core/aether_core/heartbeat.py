"""The heartbeat — Aether's persistent background loop.

Every beat:
    1. enumerate watched conversations on the OpenClaw gateway
    2. read recent history
    3. detect outstanding tasks (brain, with rule fallback)
    4. skip tasks already handled (dedup ledger on disk)
    5. for each new task: produce -> self-correct -> push deliverable
    6. record what was done in the audit ledger

The loop is resilient: a single unreachable service degrades one beat, it does
not crash the worker.
"""

from __future__ import annotations

import json
import logging
import signal
import threading
import time
from pathlib import Path

from .bridges.email_channel import EmailChannel
from .bridges.sms_channel import SmsChannel
from .bridges.hermes_bridge import HermesBridge
from .bridges.infra_bridge import InfraBridge
from .bridges.openclaw_bridge import OpenClawBridge
from .config import Config
from .deliverable import produce_and_push, Deliverable
from .task_detection import detect_tasks
from .skills import SkillCompiler
from .skills.exceptions import ToolNotFound

log = logging.getLogger("aether.heartbeat")


def _utc_day(ts: float | None = None) -> str:
    """UTC calendar day (YYYY-MM-DD) for quota windowing."""
    return time.strftime("%Y-%m-%d", time.gmtime(ts if ts else time.time()))


class Heartbeat:
    def __init__(self, config: Config) -> None:
        self.cfg = config
        self.brain = HermesBridge(config)
        self.channels = OpenClawBridge(config)
        self.infra = InfraBridge(config)
        self.email_ch = EmailChannel(config) if config.email_inbound_enabled else None
        self.sms_ch   = SmsChannel(config)   if config.sms_inbound_enabled   else None
        self._skill_compiler = SkillCompiler(config) if config.compile_skills else None
        self._ledger_path = Path(config.workspace) / f"ledger-{config.tenant_id}.json"
        self._seen: set[str] = set()
        self._stop = threading.Event()
        self._load_ledger()
        self._day = _utc_day()
        self._delivered_today = self._count_today()

    def _count_today(self) -> int:
        """Count deliverables already sent today (from the ledger) for quota."""
        try:
            data = json.loads(self._ledger_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return 0
        day = _utc_day()
        return sum(
            1 for e in data.get("log", [])
            if e.get("delivered") and _utc_day(e.get("ts", 0)) == day
        )

    def _quota_reached(self) -> bool:
        if _utc_day() != self._day:  # new day -> reset
            self._day = _utc_day()
            self._delivered_today = 0
        cap = self.cfg.max_deliverables_per_day
        return cap > 0 and self._delivered_today >= cap

    def install_signal_handlers(self) -> None:
        """Stop the loop cleanly on SIGINT/SIGTERM (main thread only)."""
        for sig in (signal.SIGINT, getattr(signal, "SIGTERM", None)):
            if sig is None:
                continue
            try:
                signal.signal(sig, lambda *_: self._stop.set())
            except (ValueError, OSError):
                pass  # not in the main thread; supervisor handles termination

    def stop(self) -> None:
        self._stop.set()

    # -- persistence ---------------------------------------------------------
    def _load_ledger(self) -> None:
        try:
            data = json.loads(self._ledger_path.read_text("utf-8"))
            self._seen = set(data.get("handled", []))
        except (OSError, json.JSONDecodeError):
            self._seen = set()

    def _record(self, task_key: str, deliverable: dict) -> None:
        self._seen.add(task_key)
        try:
            self._ledger_path.parent.mkdir(parents=True, exist_ok=True)
            existing = {"handled": [], "log": []}
            if self._ledger_path.exists():
                existing = json.loads(self._ledger_path.read_text("utf-8"))
            existing["handled"] = sorted(self._seen)
            existing.setdefault("log", []).append(
                {"ts": time.time(), "task": task_key, **deliverable}
            )
            self._ledger_path.write_text(json.dumps(existing, indent=2), "utf-8")
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("could not persist ledger: %s", exc)

    # -- one beat ------------------------------------------------------------
    def beat(self, *, dry_run: bool = False) -> dict:
        """Run a single heartbeat. Returns a small summary for observability."""
        summary = {"conversations": 0, "tasks": 0, "delivered": 0, "skipped_quota": 0, "errors": []}
        try:
            conversations = self._target_conversations()
        except Exception as exc:  # gateway unreachable
            summary["errors"].append(f"list_conversations: {exc}")
            return summary

        summary["conversations"] = len(conversations)
        for cid in conversations:
            try:
                messages = self.channels.read_messages(cid, limit=50)
            except Exception as exc:
                summary["errors"].append(f"read[{cid}]: {exc}")
                continue

            tasks = detect_tasks(self.brain, messages)
            for task in tasks:
                if task.key in self._seen:
                    continue
                summary["tasks"] += 1
                # Entitlement: stop delivering once the daily quota is hit.
                if self._quota_reached():
                    summary["skipped_quota"] += 1
                    continue
                deliverable = produce_and_push(
                    self.brain,
                    self.channels,
                    task,
                    self_correct_passes=self.cfg.self_correct_passes,
                    dry_run=dry_run,
                )
                if deliverable.tool_not_found and self._skill_compiler and deliverable.missing_tool:
                    log.info("ToolNotFound encountered for '%s'. Attempting skill injection...", deliverable.missing_tool)
                    try:
                        if self._skill_compiler.acquire(deliverable.missing_tool):
                            log.info("Skill '%s' successfully injected. Retrying task.", deliverable.missing_tool)
                            deliverable = produce_and_push(
                                self.brain,
                                self.channels,
                                task,
                                self_correct_passes=self.cfg.self_correct_passes,
                                dry_run=dry_run,
                            )
                    except Exception as exc:
                        log.exception("Skill injection failed for '%s': %s", deliverable.missing_tool, exc)
                if deliverable.delivered:
                    summary["delivered"] += 1
                    self._delivered_today += 1
                self._record(
                    task.key,
                    {"delivered": deliverable.delivered, "revised": deliverable.revised},
                )
        # Also drain the email inbox.
        if self.email_ch is not None:
            email_summary = self._email_beat(dry_run=dry_run)
            summary["emails_processed"] = email_summary.get("delivered", 0)
            summary["errors"].extend(email_summary.get("errors", []))

        # Also drain the SMS inbox.
        if self.sms_ch is not None:
            sms_summary = self._sms_beat(dry_run=dry_run)
            summary["sms_processed"] = sms_summary.get("delivered", 0)
            summary["errors"].extend(sms_summary.get("errors", []))

        return summary

    def _target_conversations(self) -> list[str]:
        if self.cfg.watch_channels:
            convs = list(self.cfg.watch_channels)
        else:
            rows = self.channels.list_conversations()
            convs = [str(c.get("id", c.get("conversationId", ""))) for c in rows if c]
        # Entitlement: cap the number of channels this tier may watch.
        cap = self.cfg.max_channels
        return convs[:cap] if cap > 0 else convs

    # -- email beat ----------------------------------------------------------
    def _email_beat(self, *, dry_run: bool = False) -> dict:
        """Process the inbound email inbox as a second task source."""
        summary: dict = {"emails": 0, "delivered": 0, "errors": []}
        if self.email_ch is None:
            return summary

        try:
            conversations = self.email_ch.list_conversations()
        except Exception as exc:
            summary["errors"].append(f"email inbox: {exc}")
            return summary

        for conv in conversations:
            cid = conv["id"]
            try:
                messages = self.email_ch.read_messages(cid, limit=10)
            except Exception as exc:
                summary["errors"].append(f"email read[{cid}]: {exc}")
                continue

            summary["emails"] += len(messages)
            tasks = detect_tasks(self.brain, messages)
            for task in tasks:
                # Use a namespaced key so email tasks don't collide with channel tasks.
                task_key = f"email:{task.key}"
                if task_key in self._seen:
                    continue
                if self._quota_reached():
                    continue
                deliverable = produce_and_push(
                    self.brain,
                    self.email_ch,
                    task,
                    self_correct_passes=self.cfg.self_correct_passes,
                    dry_run=dry_run,
                )
                if deliverable.tool_not_found and self._skill_compiler and deliverable.missing_tool:
                    log.info("ToolNotFound encountered for email task: '%s'. Attempting skill injection...", deliverable.missing_tool)
                    try:
                        if self._skill_compiler.acquire(deliverable.missing_tool):
                            log.info("Skill '%s' successfully injected for email task. Retrying.", deliverable.missing_tool)
                            deliverable = produce_and_push(
                                self.brain,
                                self.email_ch,
                                task,
                                self_correct_passes=self.cfg.self_correct_passes,
                                dry_run=dry_run,
                            )
                    except Exception as exc:
                        log.exception("Skill injection failed for '%s': %s", deliverable.missing_tool, exc)
                if deliverable.delivered:
                    summary["delivered"] += 1
                    self._delivered_today += 1
                self._record(task_key, {"delivered": deliverable.delivered, "revised": deliverable.revised})

            # Ack all inbox messages for this conversation regardless of task detection
            # so stale mail doesn't pile up.
            if not dry_run:
                self.email_ch.ack_all_for(cid)

        return summary

    # -- sms beat ------------------------------------------------------------
    def _sms_beat(self, *, dry_run: bool = False) -> dict:
        """Process the inbound SMS inbox as a task source."""
        summary: dict = {"sms": 0, "delivered": 0, "errors": []}
        if self.sms_ch is None:
            return summary

        try:
            conversations = self.sms_ch.list_conversations()
        except Exception as exc:
            summary["errors"].append(f"sms inbox: {exc}")
            return summary

        for conv in conversations:
            cid = conv["id"]
            try:
                messages = self.sms_ch.read_messages(cid, limit=10)
            except Exception as exc:
                summary["errors"].append(f"sms read[{cid}]: {exc}")
                continue

            summary["sms"] += len(messages)
            tasks = detect_tasks(self.brain, messages)
            for task in tasks:
                task_key = f"sms:{task.key}"
                if task_key in self._seen:
                    continue
                if self._quota_reached():
                    continue
                deliverable = produce_and_push(
                    self.brain,
                    self.sms_ch,
                    task,
                    self_correct_passes=self.cfg.self_correct_passes,
                    dry_run=dry_run,
                )
                if deliverable.tool_not_found and self._skill_compiler and deliverable.missing_tool:
                    log.info("ToolNotFound encountered for SMS task: '%s'. Attempting skill injection...", deliverable.missing_tool)
                    try:
                        if self._skill_compiler.acquire(deliverable.missing_tool):
                            log.info("Skill '%s' successfully injected for SMS task. Retrying.", deliverable.missing_tool)
                            deliverable = produce_and_push(
                                self.brain,
                                self.sms_ch,
                                task,
                                self_correct_passes=self.cfg.self_correct_passes,
                                dry_run=dry_run,
                            )
                    except Exception as exc:
                        log.exception("Skill injection failed for '%s': %s", deliverable.missing_tool, exc)
                if deliverable.delivered:
                    summary["delivered"] += 1
                    self._delivered_today += 1
                self._record(task_key, {"delivered": deliverable.delivered, "revised": deliverable.revised})

            if not dry_run:
                self.sms_ch.ack_all_for(cid)

        return summary

    # -- forever -------------------------------------------------------------
    def run_forever(self, *, dry_run: bool = False) -> None:
        interval = self.cfg.heartbeat_seconds
        log.info(
            "Aether Core online — tenant=%s profile=%s heartbeat=%ss",
            self.cfg.tenant_id, self.cfg.profile, interval,
        )
        while not self._stop.is_set():
            start = time.time()
            try:
                result = self.beat(dry_run=dry_run)
                log.info("beat: %s", result)
            except Exception as exc:  # never let the loop die
                log.exception("heartbeat error: %s", exc)
            elapsed = time.time() - start
            # interruptible sleep so shutdown is immediate
            self._stop.wait(timeout=max(1.0, interval - elapsed))
        log.info("Aether Core stopped cleanly (tenant=%s)", self.cfg.tenant_id)
