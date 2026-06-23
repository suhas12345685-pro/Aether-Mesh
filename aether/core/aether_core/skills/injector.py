"""Skill injector — extract and validate downloaded skill packages.

A skill package is either:

* A ``.tar.gz`` tarball (real download from the registry).
* A ``.stub`` sentinel file (dev / offline mode created by the downloader).

In both cases the injector produces a canonical directory under
``workspace/skills/<skill_name>/`` with the following structure::

    workspace/skills/github-tools/
        skill.json          ← manifest (name, version, tools, language, requires)
        github_tools.py     ← main module (or package __init__.py)
        ...                 ← any additional files from the tarball

The injector enforces the structure requirement: every skill *must* contain a
``skill.json`` manifest and at least one Python/Node source file.
"""

from __future__ import annotations

import json
import logging
import shutil
import tarfile
from pathlib import Path
from typing import Any

from .exceptions import SkillInstallError

log = logging.getLogger("aether.skills.injector")

# Required files that every valid skill tarball must contain.
_REQUIRED_MANIFEST = "skill.json"


class SkillInjector:
    """Extracts and validates skill packages into the workspace.

    Args:
        workspace: Root directory where skills are installed.  Skills land
            under ``workspace/skills/<skill_name>/``.
    """

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace
        self._skills_root = workspace / "skills"
        self._skills_root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def inject(self, skill_name: str, tarball_path: Path) -> Path:
        """Install a skill from *tarball_path* into the workspace.

        Handles two input forms:

        * ``*.tar.gz`` — a real tarball downloaded from the registry.
        * ``*.stub`` — a sentinel created by the downloader in dev mode
          (the companion stub directory is already in place).

        Returns the path to the installed skill directory.

        Raises:
            SkillInstallError: If the tarball is missing required files or the
                structure is otherwise invalid.
        """
        skill_dir = self._skills_root / skill_name

        # -- dev-mode stub path -------------------------------------------
        if tarball_path.suffix == ".stub" or tarball_path.name == ".stub":
            # Downloader already extracted the stub dir; just validate it.
            stub_dir = tarball_path.parent  # parent is the stub skill directory
            self._validate_skill_dir(skill_name, stub_dir)
            log.info("injector: stub skill %s validated at %s", skill_name, stub_dir)
            return stub_dir

        # -- real tarball path --------------------------------------------
        if not tarball_path.exists():
            raise SkillInstallError(skill_name, f"tarball not found: {tarball_path}")

        if skill_dir.exists():
            log.debug("injector: removing stale skill dir %s", skill_dir)
            shutil.rmtree(skill_dir)

        skill_dir.mkdir(parents=True, exist_ok=True)

        try:
            with tarfile.open(tarball_path, "r:gz") as tar:
                # Security: strip leading path components and reject absolute
                # paths / path traversal attempts.
                for member in tar.getmembers():
                    safe_name = self._safe_member_path(member.name)
                    if safe_name is None:
                        log.warning("injector: skipping unsafe tarball member %r", member.name)
                        continue
                    member.name = safe_name
                tar.extractall(skill_dir)  # noqa: S202 — members sanitised above
        except tarfile.TarError as exc:
            shutil.rmtree(skill_dir, ignore_errors=True)
            raise SkillInstallError(skill_name, f"tarball extraction failed: {exc}") from exc

        self._validate_skill_dir(skill_name, skill_dir)
        log.info("injector: installed skill %s at %s", skill_name, skill_dir)
        return skill_dir

    def list_installed(self) -> list[str]:
        """Return the names of all skills currently installed in the workspace."""
        if not self._skills_root.exists():
            return []
        return [
            d.name
            for d in sorted(self._skills_root.iterdir())
            if d.is_dir() and (d / _REQUIRED_MANIFEST).exists()
        ]

    def is_installed(self, skill_name: str) -> bool:
        """Return True if *skill_name* is installed and has a valid manifest."""
        skill_dir = self._skills_root / skill_name
        return skill_dir.is_dir() and (skill_dir / _REQUIRED_MANIFEST).exists()

    def remove(self, skill_name: str) -> None:
        """Remove an installed skill from the workspace.

        No-ops silently if the skill is not installed.
        """
        skill_dir = self._skills_root / skill_name
        if skill_dir.exists():
            shutil.rmtree(skill_dir)
            log.info("injector: removed skill %s", skill_name)
        else:
            log.debug("injector: remove called for non-existent skill %s", skill_name)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _validate_skill_dir(self, skill_name: str, skill_dir: Path) -> None:
        """Assert that the extracted directory meets the structural contract.

        Raises:
            SkillInstallError: If ``skill.json`` is missing or contains no
                recognisable source file.
        """
        manifest_path = skill_dir / _REQUIRED_MANIFEST
        if not manifest_path.exists():
            raise SkillInstallError(
                skill_name,
                f"missing {_REQUIRED_MANIFEST} in extracted skill package",
            )

        # Validate the manifest is parseable JSON with the required fields.
        try:
            manifest: dict[str, Any] = json.loads(manifest_path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise SkillInstallError(
                skill_name, f"skill.json is invalid: {exc}"
            ) from exc

        for required_field in ("name", "version", "tools"):
            if required_field not in manifest:
                raise SkillInstallError(
                    skill_name,
                    f"skill.json missing required field: {required_field!r}",
                )

        # At least one Python or Node source file must be present.
        source_files = list(skill_dir.glob("*.py")) + list(skill_dir.glob("*.mjs")) + list(
            skill_dir.glob("*.js")
        )
        if not source_files:
            raise SkillInstallError(
                skill_name,
                "skill package contains no Python (.py) or Node (.mjs/.js) source files",
            )

    @staticmethod
    def _safe_member_path(member_name: str) -> str | None:
        """Sanitise a tarball member path, stripping traversal attempts.

        Returns ``None`` if the path is unsafe (absolute or traversal).
        Otherwise returns the stripped relative path.
        """
        # Normalise separators.
        parts = member_name.replace("\\", "/").split("/")
        # Strip the leading component (archive root directory).
        if len(parts) > 1:
            parts = parts[1:]
        safe_parts = []
        for part in parts:
            if part in ("", ".", ".."):
                if part == "..":
                    return None  # traversal attempt
                continue
            safe_parts.append(part)
        if not safe_parts:
            return None
        result = "/".join(safe_parts)
        # Reject absolute paths.
        if result.startswith("/"):
            return None
        return result
