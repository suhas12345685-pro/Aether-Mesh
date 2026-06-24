"""Tests for the two fixes landed in heartbeat.py:

  1. _write_ledger_atomic  -- crash-safe atomic write via tmp->rename
  2. _maybe_inject_and_retry -- single helper replacing the 3 copy-paste blocks

Runnable with plain `python tests/test_heartbeat_fixes.py` (no pytest required).
"""

from __future__ import annotations

import dataclasses
import json
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aether_core.config import load_config
from aether_core.heartbeat import Heartbeat
from aether_core.task_detection import Task


# ---------------------------------------------------------------------------
# Minimal fakes so we can construct a Heartbeat without live services
# ---------------------------------------------------------------------------

def _make_heartbeat(tmp_path: Path) -> Heartbeat:
    # Config is frozen — use dataclasses.replace() to override fields.
    base = load_config()
    cfg = dataclasses.replace(
        base,
        workspace=str(tmp_path),
        tenant_id="test-tenant",
        email_inbound_enabled=False,
        sms_inbound_enabled=False,
    )

    hb = Heartbeat.__new__(Heartbeat)
    hb.cfg = cfg
    hb.brain = MagicMock()
    hb.channels = MagicMock()
    hb.infra = MagicMock()
    hb.email_ch = None
    hb.sms_ch = None
    hb._skill_compiler = None
    hb._ledger_path = tmp_path / f"ledger-{cfg.tenant_id}.json"
    hb._seen: set = set()
    hb._stop = threading.Event()
    hb._day = time.strftime("%Y-%m-%d", time.gmtime())
    hb._delivered_today = 0
    return hb


def _fake_task(cid="conv1", mid="msg1") -> Task:
    return Task(
        conversation_id=cid,
        source_message_id=mid,
        summary="Test task",
        confidence=0.9,
        raw="Test task",
    )


@dataclass
class FakeDeliverable:
    delivered: bool = True
    revised: bool = False
    tool_not_found: bool = False
    missing_tool: str | None = None


# ---------------------------------------------------------------------------
# _write_ledger_atomic
# ---------------------------------------------------------------------------

class TestWriteLedgerAtomic(unittest.TestCase):

    def test_creates_ledger_file(self):
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            data = {"handled": ["a", "b"], "log": []}
            hb._write_ledger_atomic(data)
            assert hb._ledger_path.exists(), "ledger file should exist after atomic write"
            saved = json.loads(hb._ledger_path.read_text("utf-8"))
            assert saved["handled"] == ["a", "b"]

    def test_no_tmp_file_left_on_success(self):
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._write_ledger_atomic({"handled": [], "log": []})
            leftover = list(Path(d).glob(".ledger-*.tmp"))
            assert leftover == [], f"tmp file should be cleaned up: {leftover}"

    def test_old_ledger_survives_when_write_fails(self):
        """If the rename step were to fail, the old ledger must remain intact."""
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            # Write a known good ledger first.
            good = {"handled": ["existing"], "log": []}
            hb._write_ledger_atomic(good)

            # Now simulate os.replace failing by patching it.
            import os as _os
            original_replace = _os.replace

            def boom(src, dst):
                # Clean up the tmp file before raising so the test is clean.
                try:
                    _os.unlink(src)
                except OSError:
                    pass
                raise OSError("simulated disk full")

            with patch("aether_core.heartbeat.os.replace", boom):
                try:
                    hb._write_ledger_atomic({"handled": ["new"], "log": []})
                except OSError:
                    pass

            # The original ledger must still be intact.
            saved = json.loads(hb._ledger_path.read_text("utf-8"))
            assert saved["handled"] == ["existing"], (
                "Original ledger should survive a failed atomic write"
            )

    def test_record_persists_seen_set(self):
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._record("conv1:msg1", {"delivered": True, "revised": False})
            assert "conv1:msg1" in hb._seen
            saved = json.loads(hb._ledger_path.read_text("utf-8"))
            assert "conv1:msg1" in saved["handled"]

    def test_log_pruned_after_7_days(self):
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            old_ts = time.time() - 8 * 86400  # 8 days ago
            existing = {
                "handled": [],
                "log": [{"ts": old_ts, "task": "old:task", "delivered": True}],
            }
            hb._ledger_path.write_text(json.dumps(existing), "utf-8")
            hb._record("new:task", {"delivered": True, "revised": False})
            saved = json.loads(hb._ledger_path.read_text("utf-8"))
            keys = [e["task"] for e in saved["log"]]
            assert "old:task" not in keys, "entries older than 7 days should be pruned"
            assert "new:task" in keys


# ---------------------------------------------------------------------------
# _maybe_inject_and_retry
# ---------------------------------------------------------------------------

class TestMaybeInjectAndRetry(unittest.TestCase):

    def test_no_op_when_tool_not_found_is_false(self):
        """If deliverable.tool_not_found is False, return it unchanged."""
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._skill_compiler = MagicMock()
            original = FakeDeliverable(tool_not_found=False, missing_tool="some_tool")
            result = hb._maybe_inject_and_retry(original, _fake_task(), MagicMock())
            hb._skill_compiler.acquire.assert_not_called()
            assert result is original

    def test_no_op_when_no_skill_compiler(self):
        """If _skill_compiler is None, return deliverable unchanged."""
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._skill_compiler = None
            original = FakeDeliverable(tool_not_found=True, missing_tool="some_tool")
            result = hb._maybe_inject_and_retry(original, _fake_task(), MagicMock())
            assert result is original

    def test_retries_after_successful_injection(self):
        """If acquire() returns True, produce_and_push is called a second time."""
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._skill_compiler = MagicMock()
            hb._skill_compiler.acquire.return_value = True

            retried = FakeDeliverable(delivered=True, tool_not_found=False)
            first = FakeDeliverable(delivered=False, tool_not_found=True, missing_tool="mytool")

            channel = MagicMock()
            task = _fake_task()

            with patch("aether_core.heartbeat.produce_and_push", return_value=retried) as mock_pp:
                result = hb._maybe_inject_and_retry(first, task, channel, dry_run=False)

            hb._skill_compiler.acquire.assert_called_once_with("mytool")
            mock_pp.assert_called_once()
            assert result is retried

    def test_returns_original_when_injection_fails(self):
        """If acquire() raises, log the error and return the original deliverable."""
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._skill_compiler = MagicMock()
            hb._skill_compiler.acquire.side_effect = RuntimeError("registry down")

            first = FakeDeliverable(delivered=False, tool_not_found=True, missing_tool="mytool")
            channel = MagicMock()

            with patch("aether_core.heartbeat.produce_and_push") as mock_pp:
                result = hb._maybe_inject_and_retry(first, _fake_task(), channel)

            mock_pp.assert_not_called()
            assert result is first  # original returned, not crashed

    def test_returns_original_when_acquire_returns_false(self):
        """If acquire() returns False (tool not in registry), no retry attempted."""
        with tempfile.TemporaryDirectory() as d:
            hb = _make_heartbeat(Path(d))
            hb._skill_compiler = MagicMock()
            hb._skill_compiler.acquire.return_value = False

            first = FakeDeliverable(delivered=False, tool_not_found=True, missing_tool="unknowntool")

            with patch("aether_core.heartbeat.produce_and_push") as mock_pp:
                result = hb._maybe_inject_and_retry(first, _fake_task(), MagicMock())

            mock_pp.assert_not_called()
            assert result is first


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(TestWriteLedgerAtomic))
    suite.addTests(loader.loadTestsFromTestCase(TestMaybeInjectAndRetry))
    runner = unittest.TextTestRunner(verbosity=0)
    result = runner.run(suite)
    if result.wasSuccessful():
        print("ok")
    else:
        sys.exit(1)
