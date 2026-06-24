"""Task detection -- turn a stream of chat messages into actionable work.

This is what makes Aether proactive instead of reactive: it reads channel
history the way a diligent teammate would and decides "there is an open task
here that nobody has picked up." It prefers the brain (Hermes) for judgement
but always has a rule-based fallback so a dead LLM never stalls the heartbeat.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from .bridges.hermes_bridge import HermesBridge, HermesUnavailable
from .bridges.openclaw_bridge import Message

log = logging.getLogger("aether.task_detection")

# Cheap signals that a message is asking for work to be done.
# NOTE: hints-only detection requires a specific action word -- vague words
# like "please" / "send" alone are not enough to avoid false-positives on
# casual conversation ("could someone please pass the salt").
# Pure @aether mentions always trigger regardless of hint words.
_ACTION_HINTS = re.compile(
    r"\b(todo|to-?do|action item|follow.?up|fix|investigate|draft|write.?up|"
    r"summari[sz]e|schedule|research|prepare|deadline|blocked on)\b",
    re.IGNORECASE,
)
_MENTION = re.compile(r"@aether\b", re.IGNORECASE)


@dataclass
class Task:
    conversation_id: str
    source_message_id: str
    summary: str
    confidence: float
    raw: str

    @property
    def key(self) -> str:
        return f"{self.conversation_id}:{self.source_message_id}"


def _rule_based(messages: list[Message]) -> list[Task]:
    tasks: list[Task] = []
    for msg in messages:
        if msg.is_bot or not msg.text.strip():
            continue
        mentioned = bool(_MENTION.search(msg.text))
        hinted = bool(_ACTION_HINTS.search(msg.text))
        # Require an explicit @aether mention OR a strong action-word hit.
        if not (mentioned or hinted):
            continue
        tasks.append(
            Task(
                conversation_id=msg.conversation_id,
                source_message_id=msg.id,
                summary=msg.text.strip()[:200],
                confidence=0.9 if mentioned else 0.65,
                raw=msg.text.strip(),
            )
        )
    return tasks


def _validate_task_item(item: object) -> bool:
    """Return True only if *item* is a well-formed task dict from the LLM.

    Rejects anything that would cause a downstream crash or produce a
    nonsensical task (missing id, empty summary, out-of-range confidence).
    """
    if not isinstance(item, dict):
        return False
    mid = item.get("source_message_id")
    if not mid or not isinstance(mid, (str, int)):
        return False
    summary = item.get("summary", "")
    if not isinstance(summary, str) or not summary.strip():
        return False
    try:
        conf = float(item.get("confidence", -1))
    except (TypeError, ValueError):
        return False
    return 0.0 <= conf <= 1.0


def _brain_based(brain: HermesBridge, messages: list[Message]) -> list[Task] | None:
    """Ask the brain to extract open tasks. Returns None if the brain is down."""
    transcript = "\n".join(
        f"[{m.id}] {m.author}: {m.text}" for m in messages if not m.is_bot and m.text
    )
    if not transcript:
        return []
    prompt = (
        "You are a meticulous team operations assistant. Read the chat "
        "transcript and extract OUTSTANDING tasks that no human has clearly "
        "taken ownership of. Respond ONLY with compact JSON: a list of objects "
        '{"source_message_id": str, "summary": str, "confidence": 0..1}. '
        "Empty list if nothing is actionable.\n\nTRANSCRIPT:\n" + transcript
    )
    try:
        raw = brain.complete(
            [{"role": "user", "content": prompt}], temperature=0.0, max_tokens=800
        )
    except HermesUnavailable:
        return None

    payload = _extract_json(raw)
    if payload is None:
        log.warning("task_detection: LLM returned unparseable response; falling back to rules")
        return None

    by_id = {m.id: m for m in messages}
    out: list[Task] = []
    for item in payload:
        if not _validate_task_item(item):
            log.warning("task_detection: dropping malformed LLM item: %r", item)
            continue
        mid = str(item["source_message_id"])
        src = by_id.get(mid)
        cid = src.conversation_id if src else (messages[0].conversation_id if messages else "")
        # Clamp confidence strictly to [0, 1] regardless of what the LLM said.
        conf = max(0.0, min(1.0, float(item["confidence"])))
        out.append(
            Task(
                conversation_id=cid,
                source_message_id=mid,
                summary=item["summary"].strip()[:200],
                confidence=conf,
                raw=item["summary"],
            )
        )
    return out


def _extract_json(text: str):
    """Best-effort JSON-list extraction from a model response."""
    text = text.strip()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        data = json.loads(text[start : end + 1])
        return data if isinstance(data, list) else None
    except json.JSONDecodeError:
        return None


def detect_tasks(
    brain: HermesBridge,
    messages: list[Message],
    *,
    min_confidence: float = 0.5,
) -> list[Task]:
    """Detect open tasks, preferring the brain and falling back to rules."""
    result = _brain_based(brain, messages)
    if result is None:  # brain unavailable or returned garbage
        result = _rule_based(messages)
    return [t for t in result if t.confidence >= min_confidence and t.summary]
