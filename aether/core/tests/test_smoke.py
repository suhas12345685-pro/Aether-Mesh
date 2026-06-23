"""Offline smoke tests for Aether Core.

These run without Hermes/OpenClaw/Infra up: they force the brain "down" so the
rule-based and degraded paths are exercised end to end.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aether_core.bridges.hermes_bridge import HermesBridge, HermesUnavailable
from aether_core.bridges.openclaw_bridge import Message, OpenClawBridge
from aether_core.config import load_config
from aether_core.deliverable import produce_and_push
from aether_core.task_detection import detect_tasks


class _DownBrain(HermesBridge):
    def complete(self, *a, **k):  # type: ignore[override]
        raise HermesUnavailable("forced down")

    def healthy(self):  # type: ignore[override]
        return False


class _FakeChannels(OpenClawBridge):
    def __init__(self, cfg):
        super().__init__(cfg)
        self.sent = []

    def send_message(self, conversation_id, text):  # type: ignore[override]
        self.sent.append((conversation_id, text))
        return True


def _cfg():
    os.environ["AETHER_TENANT_ID"] = "test"
    return load_config()


def test_rule_based_detection_when_brain_down():
    cfg = _cfg()
    brain = _DownBrain(cfg)
    msgs = [
        Message("1", "c1", "alice", "morning everyone", 1.0),
        Message("2", "c1", "bob", "@aether can someone summarise the Q3 report?", 2.0),
        Message("3", "c1", "carol", "thanks!", 3.0),
    ]
    tasks = detect_tasks(brain, msgs)
    assert len(tasks) == 1
    assert tasks[0].source_message_id == "2"
    assert tasks[0].confidence >= 0.9  # @mention => high confidence


def test_delivery_degrades_gracefully_when_brain_down():
    cfg = _cfg()
    brain = _DownBrain(cfg)
    channels = _FakeChannels(cfg)
    msgs = [Message("9", "c2", "dan", "please draft the onboarding email", 1.0)]
    tasks = detect_tasks(brain, msgs)
    assert tasks, "rule-based detection should find the task"
    d = produce_and_push(brain, channels, tasks[0], self_correct_passes=1)
    assert d.delivered is True
    assert channels.sent and "Aether" in channels.sent[0][1]


def test_profile_tiers():
    os.environ["AETHER_PROFILE"] = "lite"
    assert load_config().heartbeat_seconds == 180
    os.environ["AETHER_PROFILE"] = "power"
    assert load_config().self_correct_passes == 2


if __name__ == "__main__":
    test_rule_based_detection_when_brain_down()
    test_delivery_degrades_gracefully_when_brain_down()
    test_profile_tiers()
    print("ok")
