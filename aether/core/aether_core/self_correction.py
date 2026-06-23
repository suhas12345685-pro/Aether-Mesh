"""Self-correction — the sanity-check layer.

Before any deliverable is shown to humans, Aether critiques its own output and
revises it. This kills the classic agent failure modes (hallucination loops,
broken syntax, structurally wrong answers). Power nodes run multiple passes;
Lite nodes run one. If the brain is unavailable the draft passes through
unchanged rather than blocking the heartbeat.
"""

from __future__ import annotations

from dataclasses import dataclass

from .bridges.hermes_bridge import HermesBridge, HermesUnavailable

_CRITIQUE_SYSTEM = (
    "You are a ruthless reviewer. Check the draft for: factual errors, broken "
    "or non-compiling code, structural mistakes, and unsupported claims. "
    "If it is correct and complete, reply with exactly: OK. "
    "Otherwise reply with a corrected, final version of the deliverable only — "
    "no preamble, no explanation."
)


@dataclass
class CorrectionResult:
    text: str
    passes_run: int
    revised: bool


def self_correct(
    brain: HermesBridge,
    task_summary: str,
    draft: str,
    *,
    passes: int = 1,
) -> CorrectionResult:
    """Iteratively critique and revise ``draft`` up to ``passes`` times."""
    current = draft
    revised = False
    run = 0
    for _ in range(max(1, passes)):
        run += 1
        prompt = (
            f"TASK:\n{task_summary}\n\nDRAFT DELIVERABLE:\n{current}\n\n"
            "Review per your instructions."
        )
        try:
            verdict = brain.complete(
                [
                    {"role": "system", "content": _CRITIQUE_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.0,
            )
        except HermesUnavailable:
            break  # brain down: ship the best draft we have

        if verdict.strip().upper().startswith("OK") and len(verdict.strip()) <= 4:
            break  # reviewer is satisfied
        # Reviewer returned a corrected version.
        current = verdict.strip()
        revised = True
    return CorrectionResult(text=current, passes_run=run, revised=revised)
