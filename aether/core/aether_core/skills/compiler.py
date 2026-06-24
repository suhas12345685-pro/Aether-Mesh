"""SkillCompiler — the orchestrator of the self-skill-injection pipeline.

When the heartbeat encounters a ``ToolNotFound`` condition it calls::

    acquired = compiler.acquire("create_issue")

The compiler then:

1. Looks up the tool in the curated registry.
2. Checks if the skill is already installed (idempotent).
3. Downloads and verifies the skill tarball.
4. Extracts and validates the package structure.
5. Installs Python/Node dependencies (Power tier only).
6. Activates the skill by adding its directory to ``sys.path``.
7. Logs the acquisition to the agent's audit ledger.

Tier policy
-----------
* **Lite** nodes: only pure-Python skills (``requires == []``) are installed.
  Skills with external pip dependencies are rejected with a logged notice.
* **Power** nodes: all skills including those with deps are installed.
  ``pip install`` runs inside the agent's sandbox.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from ..config import Config
from .downloader import SkillDownloader
from .exceptions import SkillInstallError, SkillNotFound
from .injector import SkillInjector
from .registry import SkillRegistry

log = logging.getLogger("aether.skills.compiler")

# Allowlist for pip dependency names supplied by the skill registry.
# Matches: optional extras, version specifiers, and URL-based deps are all
# rejected — only simple PyPI package names with optional version pins.
# e.g. "requests", "httpx>=0.27", "my-pkg==1.2.3" are OK.
# "requests; python_version>'3.9'", "../evil", "git+https://..." are rejected.
_SAFE_DEP_RE = re.compile(
    r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?"  # package name
    r"(\s*[><=!]{1,2}\s*[A-Za-z0-9.*+]+)?$"        # optional version specifier
)


class SkillCompiler:
    """Orchestrates the full registry → download → verify → inject → activate pipeline.

    Args:
        config: Aether runtime configuration.  Reads ``config.workspace`` and
            ``config.compile_skills`` to determine install paths and tier policy.
    """

    def __init__(self, config: Config) -> None:
        self._cfg = config
        self._workspace = Path(config.workspace)
        self._registry = SkillRegistry()
        self._downloader = SkillDownloader(self._workspace)
        self._injector = SkillInjector(self._workspace)
        self._acquired: list[str] = []  # skills acquired during this session
        self._ledger_path = self._workspace / f"skills-ledger-{config.tenant_id}.json"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def acquire(self, tool_name: str) -> bool:
        """Find, download, and install the skill that provides *tool_name*.

        Returns:
            ``True``  — skill is now available (either freshly installed or
                        was already present).
            ``False`` — no skill in the registry provides this tool.

        Raises:
            SkillInstallError: If the skill is found in the registry but
                download or installation fails.
        """
        log.info("compiler: acquiring skill for tool %r", tool_name)

        # -- registry lookup -----------------------------------------------
        skill = self._registry.find_for_tool(tool_name)
        if skill is None:
            log.info("compiler: no skill provides %r — returning False", tool_name)
            return False

        skill_name: str = skill["name"]

        # -- idempotency check ----------------------------------------------
        if self._injector.is_installed(skill_name):
            log.debug("compiler: %s already installed — activating only", skill_name)
            skill_dir = self._workspace / "skills" / skill_name
            self._activate(skill, skill_dir)
            return True

        # -- tier policy ----------------------------------------------------
        requires: list[str] = skill.get("requires", [])
        if requires and not self._cfg.compile_skills:
            log.warning(
                "compiler: skill %s requires external deps %s but this is a Lite node — "
                "skipping installation",
                skill_name, requires,
            )
            # We don't raise — the task will simply proceed without the skill.
            return False

        # -- download -------------------------------------------------------
        try:
            tarball_path = self._downloader.download(skill)
        except SkillInstallError:
            raise
        except Exception as exc:
            raise SkillInstallError(skill_name, f"unexpected download error: {exc}") from exc

        # -- inject ---------------------------------------------------------
        try:
            skill_dir = self._injector.inject(skill_name, tarball_path)
        except SkillInstallError:
            raise
        except Exception as exc:
            raise SkillInstallError(skill_name, f"unexpected injection error: {exc}") from exc

        # -- install deps ---------------------------------------------------
        self._install_deps(skill, skill_dir)

        # -- activate -------------------------------------------------------
        self._activate(skill, skill_dir)

        # -- audit ----------------------------------------------------------
        self._acquired.append(skill_name)
        self._log_acquisition(tool_name, skill)

        log.info("compiler: skill %s acquired and activated for tool %r", skill_name, tool_name)
        return True

    def list_acquired(self) -> list[str]:
        """Return the names of skills acquired during this process session."""
        return list(self._acquired)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _install_deps(self, skill: dict[str, Any], skill_dir: Path) -> None:
        """Install Python pip dependencies declared in ``skill['requires']``.

        * On **Power** nodes (``config.compile_skills == True``): runs pip.
        * On **Lite** nodes: dependencies should be empty (enforced by
          ``acquire()`` before reaching this point).
        """
        requires: list[str] = skill.get("requires", [])
        if not requires:
            return

        if not self._cfg.compile_skills:
            # Already gated in acquire(); belt-and-suspenders guard.
            log.debug("compiler: _install_deps called on Lite node — skipping %s", requires)
            return

        # Validate each dependency against the allowlist before passing to pip.
        # A compromised registry entry must not be able to inject arbitrary
        # subprocess arguments (e.g. "--index-url https://evil.example/").
        for dep in requires:
            if not _SAFE_DEP_RE.match(dep.strip()):
                raise SkillInstallError(
                    skill["name"],
                    f"dependency name {dep!r} failed safety check — only simple "
                    "PyPI names with optional version pins are allowed",
                )
        log.info("compiler: installing deps for %s: %s", skill["name"], requires)
        cmd = [sys.executable, "-m", "pip", "install", "--quiet", *requires]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # 5-minute hard limit per skill
                check=False,
            )
            if result.returncode != 0:
                raise SkillInstallError(
                    skill["name"],
                    f"pip install failed (rc={result.returncode}): {result.stderr.strip()}",
                )
            log.debug("compiler: pip install stdout: %s", result.stdout.strip())
        except subprocess.TimeoutExpired as exc:
            raise SkillInstallError(
                skill["name"], f"pip install timed out after 300s: {exc}"
            ) from exc

    def _activate(self, skill: dict[str, Any], skill_dir: Path) -> None:
        """Add *skill_dir* to ``sys.path`` so the agent can import skill modules.

        Also writes a ``.pth`` file into the workspace so the path survives
        process restarts (Python honours ``.pth`` files found on ``sys.path``
        via ``site.py``).
        """
        skill_dir_str = str(skill_dir.resolve())

        if skill_dir_str not in sys.path:
            sys.path.insert(0, skill_dir_str)
            log.debug("compiler: added %s to sys.path", skill_dir_str)

        # Persist the path across restarts.
        pth_file = self._workspace / "skills" / f"{skill['name']}.pth"
        try:
            pth_file.write_text(skill_dir_str + "\n", "utf-8")
        except OSError as exc:
            log.warning("compiler: could not write .pth file for %s: %s", skill["name"], exc)

    def _log_acquisition(self, tool_name: str, skill: dict[str, Any]) -> None:
        """Append an acquisition record to the skills audit ledger."""
        record = {
            "ts": time.time(),
            "tool_name": tool_name,
            "skill_name": skill.get("name"),
            "version": skill.get("version"),
            "tenant_id": self._cfg.tenant_id,
        }
        try:
            self._ledger_path.parent.mkdir(parents=True, exist_ok=True)
            existing: dict = {"acquisitions": []}
            if self._ledger_path.exists():
                try:
                    existing = json.loads(self._ledger_path.read_text("utf-8"))
                except (json.JSONDecodeError, OSError):
                    existing = {"acquisitions": []}
            existing.setdefault("acquisitions", []).append(record)
            self._ledger_path.write_text(json.dumps(existing, indent=2), "utf-8")
        except OSError as exc:
            log.warning("compiler: could not write acquisition ledger: %s", exc)
