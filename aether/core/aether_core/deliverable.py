"""Deliverable production + push.

Given a detected task, Aether drives the brain (optionally using the leased
body — phone/email/browser/VM — via tools) to produce a finished deliverable,
then drops it back into the originating channel "untouched by human hands".
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .bridges.hermes_bridge import HermesBridge, HermesUnavailable
from .bridges.openclaw_bridge import OpenClawBridge
from .self_correction import self_correct
from .task_detection import Task

_SOLVER_SYSTEM = (
    "You are Aether, an autonomous synthetic employee embedded in a team chat. "
    "Produce the finished deliverable for the task. Be concrete and complete. "
    "If the task cannot be completed with the information available, state "
    "exactly what is blocking and propose the next step."
)


@dataclass
class Deliverable:
    task_key: str
    text: str
    delivered: bool
    revised: bool
    tool_not_found: bool = False
    missing_tool: str | None = None


def _solve(brain: HermesBridge, task: Task) -> str | None:
    try:
        return brain.complete(
            [
                {"role": "system", "content": _SOLVER_SYSTEM},
                {"role": "user", "content": f"Task: {task.raw or task.summary}"},
            ],
            temperature=0.3,
        )
    except HermesUnavailable:
        return None


def produce_and_push(
    brain: HermesBridge,
    channels: OpenClawBridge,
    task: Task,
    *,
    self_correct_passes: int = 1,
    dry_run: bool = False,
) -> Deliverable:
    """Solve a task, self-correct, and deliver it back to the channel."""
    draft = _solve(brain, task)
    if draft is None:
        # Brain unavailable — acknowledge transparently rather than go silent.
        note = (
            f"🛰️ Aether picked up: \"{task.summary}\" but the brain is "
            "currently unreachable. Will retry on the next heartbeat."
        )
        delivered = False if dry_run else channels.send_message(task.conversation_id, note)
        return Deliverable(task.key, note, delivered, revised=False)

    # Check if the output indicates a missing tool
    match = re.search(r"ToolNotFound:\s*([\w_-]+)", draft)
    if match:
        tool_name = match.group(1)
        return Deliverable(
            task.key,
            f"🛰️ Aether requires tool '{tool_name}' which is not installed.",
            delivered=False,
            revised=False,
            tool_not_found=True,
            missing_tool=tool_name
        )

    corrected = self_correct(brain, task.summary, draft, passes=self_correct_passes)
    body = (
        f"🛰️ **Aether deliverable** — re: {task.summary}\n\n{corrected.text}"
    )
    delivered = False if dry_run else channels.send_message(task.conversation_id, body)
    return Deliverable(task.key, body, delivered, revised=corrected.revised)
