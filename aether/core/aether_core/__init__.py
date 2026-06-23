"""Aether Core — the autonomous brain-loop of Aether Mesh.

Aether Core sits *below* Hermes in the stack. It does not contain an LLM; it is
the control loop that turns a passive agent (Hermes) into a "synthetic
employee": a persistent heartbeat that watches channels, detects outstanding
work, drives the brain to solve it, sanity-checks the result, and pushes the
finished deliverable back to the humans — untouched by human hands.

Layers it talks to:
    * Hermes  (brain)     -> bridges.hermes_bridge   (OpenAI-compatible API)
    * OpenClaw(channels)  -> bridges.openclaw_bridge  (gateway HTTP / CLI)
    * Infra   (the body)  -> bridges.infra_bridge     (Node infra service)
"""

from .config import Config, load_config

__version__ = "0.1.0"
__all__ = ["Config", "load_config", "__version__"]
