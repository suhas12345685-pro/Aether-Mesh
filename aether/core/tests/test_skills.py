"""Unit tests for the self-skill-injection pipeline.

All tests run offline — no real HTTP calls are made.  The registry, downloader,
and injector are exercised through mocking and temporary file system fixtures.

Run with::

    python -m pytest tests/test_skills.py -v
"""

from __future__ import annotations

import json
import os
import sys
import tarfile
import tempfile
import io
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure the package root is importable regardless of how pytest is invoked.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from aether_core.config import load_config
from aether_core.skills.compiler import SkillCompiler
from aether_core.skills.downloader import SkillDownloader
from aether_core.skills.exceptions import SkillInstallError, SkillNotFound
from aether_core.skills.injector import SkillInjector
from aether_core.skills.registry import SkillRegistry


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

def _power_cfg(workspace: str) -> object:
    """Return a power-profile Config with the given workspace."""
    os.environ["AETHER_PROFILE"] = "power"
    os.environ["AETHER_WORKSPACE"] = workspace
    os.environ["AETHER_TENANT_ID"] = "test"
    return load_config()


def _lite_cfg(workspace: str) -> object:
    """Return a lite-profile Config with the given workspace."""
    os.environ["AETHER_PROFILE"] = "lite"
    os.environ["AETHER_WORKSPACE"] = workspace
    os.environ["AETHER_TENANT_ID"] = "test"
    return load_config()


_FAKE_SKILL: dict = {
    "name": "test-skill",
    "version": "1.0.0",
    "description": "A fake skill for unit tests",
    "tools": ["do_something", "do_another"],
    "language": "python",
    "download_url": "https://registry.aethermesh.dev/packages/test-skill-1.0.0.tar.gz",
    "sha256": "",
    "signature": "",
    "requires": [],
}

_BUNDLED_REGISTRY_DATA: dict = {
    "skills": [_FAKE_SKILL]
}


def _make_valid_tarball(skill_name: str) -> bytes:
    """Build an in-memory .tar.gz that satisfies the injector's structure check."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        # skill.json
        manifest = json.dumps({
            "name": skill_name,
            "version": "1.0.0",
            "tools": ["do_something"],
        }).encode()
        info = tarfile.TarInfo(name=f"{skill_name}/skill.json")
        info.size = len(manifest)
        tar.addfile(info, io.BytesIO(manifest))

        # main module
        module_src = b'"""test skill module."""\n\ndef do_something(): pass\n'
        info2 = tarfile.TarInfo(name=f"{skill_name}/test_skill.py")
        info2.size = len(module_src)
        tar.addfile(info2, io.BytesIO(module_src))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# test_registry_find_for_tool — mock HTTP, verify correct skill returned
# ---------------------------------------------------------------------------

class TestRegistryFindForTool:
    def test_finds_skill_by_exact_tool_name(self):
        """Registry returns the right skill when the remote serves valid JSON."""
        reg = SkillRegistry()
        remote_payload = json.dumps([_FAKE_SKILL]).encode()

        with patch("urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.read.return_value = remote_payload
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_open.return_value = mock_resp

            result = reg.find_for_tool("do_something")

        assert result is not None
        assert result["name"] == "test-skill"

    def test_returns_none_for_unknown_tool(self):
        """find_for_tool returns None when no skill provides the tool."""
        reg = SkillRegistry()
        with patch("urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps([_FAKE_SKILL]).encode()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_open.return_value = mock_resp

            result = reg.find_for_tool("nonexistent_tool_xyz")

        assert result is None

    def test_tool_lookup_is_case_insensitive(self):
        """Case-insensitive matching: 'Do_Something' finds 'do_something'."""
        reg = SkillRegistry()
        with patch("urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps([_FAKE_SKILL]).encode()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_open.return_value = mock_resp

            result = reg.find_for_tool("Do_Something")

        assert result is not None
        assert result["name"] == "test-skill"


# ---------------------------------------------------------------------------
# test_registry_fallback_bundled — when HTTP fails, bundled registry is used
# ---------------------------------------------------------------------------

class TestRegistryFallbackBundled:
    def test_falls_back_to_bundled_when_http_fails(self):
        """When urlopen raises, the bundled registry.json is loaded instead."""
        import urllib.error

        reg = SkillRegistry()
        # Override BUNDLED_REGISTRY to a temp file so we control its content.
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(_BUNDLED_REGISTRY_DATA, f)
            bundled_path = Path(f.name)

        try:
            reg.BUNDLED_REGISTRY = bundled_path
            with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
                result = reg.find_for_tool("do_something")

            assert result is not None
            assert result["name"] == "test-skill"
        finally:
            bundled_path.unlink(missing_ok=True)
            reg.BUNDLED_REGISTRY = SkillRegistry.BUNDLED_REGISTRY  # restore

    def test_cache_is_served_without_second_http_call(self):
        """Second fetch within TTL window uses in-memory cache."""
        reg = SkillRegistry(cache_ttl_seconds=3600)
        remote_payload = json.dumps([_FAKE_SKILL]).encode()

        call_count = 0

        def _fake_open(req, timeout=None):
            nonlocal call_count
            call_count += 1
            mock_resp = MagicMock()
            mock_resp.read.return_value = remote_payload
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            return mock_resp

        with patch("urllib.request.urlopen", side_effect=_fake_open):
            reg.fetch()
            reg.fetch()

        assert call_count == 1, "second fetch should have hit the in-memory cache"


# ---------------------------------------------------------------------------
# test_downloader_sha256_check — bad SHA256 raises SkillInstallError
# ---------------------------------------------------------------------------

class TestDownloaderSha256Check:
    def test_raises_on_bad_sha256(self):
        """SkillInstallError is raised when the downloaded bytes don't match the hash."""
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            dl = SkillDownloader(workspace)

            bad_skill = dict(_FAKE_SKILL)
            bad_skill["sha256"] = "deadbeef" * 8  # wrong hash
            bad_skill["download_url"] = "https://registry.aethermesh.dev/packages/bad.tar.gz"

            tarball_bytes = b"this is definitely not the expected bytes"

            with patch("urllib.request.urlopen") as mock_open:
                mock_resp = MagicMock()
                mock_resp.read.return_value = tarball_bytes
                mock_resp.__enter__ = lambda s: s
                mock_resp.__exit__ = MagicMock(return_value=False)
                mock_open.return_value = mock_resp

                with pytest.raises(SkillInstallError) as exc_info:
                    dl.download(bad_skill)

            assert "SHA-256 mismatch" in str(exc_info.value)

    def test_dev_mode_stub_created_when_remote_unreachable(self):
        """When the registry.aethermesh.dev URL is unreachable, a stub is created."""
        import urllib.error

        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            dl = SkillDownloader(workspace)

            with patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError("connection refused"),
            ):
                sentinel = dl.download(_FAKE_SKILL)

            assert sentinel.name == ".stub"
            stub_dir = sentinel.parent
            assert (stub_dir / "skill.json").exists()
            assert stub_dir.name == "test-skill"


# ---------------------------------------------------------------------------
# test_injector_creates_skill_dir — verify directory structure
# ---------------------------------------------------------------------------

class TestInjectorCreatesSkillDir:
    def test_extracts_tarball_to_skill_dir(self):
        """Injector extracts a valid tarball and returns the skill directory."""
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            injector = SkillInjector(workspace)

            tarball_bytes = _make_valid_tarball("test-skill")
            tarball_path = workspace / "test-skill.tar.gz"
            tarball_path.write_bytes(tarball_bytes)

            skill_dir = injector.inject("test-skill", tarball_path)

            assert skill_dir.is_dir()
            assert (skill_dir / "skill.json").exists()
            assert injector.is_installed("test-skill")

    def test_lists_installed_skills(self):
        """list_installed returns skill names for all installed skills."""
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            injector = SkillInjector(workspace)

            for name in ("alpha-skill", "beta-skill"):
                tarball_bytes = _make_valid_tarball(name)
                tarball_path = workspace / f"{name}.tar.gz"
                tarball_path.write_bytes(tarball_bytes)
                injector.inject(name, tarball_path)

            installed = injector.list_installed()
            assert "alpha-skill" in installed
            assert "beta-skill" in installed

    def test_remove_skill(self):
        """remove() deletes the skill directory and is_installed returns False."""
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            injector = SkillInjector(workspace)

            tarball_bytes = _make_valid_tarball("rm-skill")
            tarball_path = workspace / "rm-skill.tar.gz"
            tarball_path.write_bytes(tarball_bytes)
            injector.inject("rm-skill", tarball_path)

            assert injector.is_installed("rm-skill")
            injector.remove("rm-skill")
            assert not injector.is_installed("rm-skill")

    def test_raises_on_missing_skill_json(self):
        """SkillInstallError if tarball is missing skill.json."""
        with tempfile.TemporaryDirectory() as td:
            workspace = Path(td)
            injector = SkillInjector(workspace)

            # Build a tarball with no skill.json.
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tar:
                src = b"def foo(): pass\n"
                info = tarfile.TarInfo("bad-skill/main.py")
                info.size = len(src)
                tar.addfile(info, io.BytesIO(src))

            tarball_path = workspace / "bad.tar.gz"
            tarball_path.write_bytes(buf.getvalue())

            with pytest.raises(SkillInstallError) as exc_info:
                injector.inject("bad-skill", tarball_path)
            assert "skill.json" in str(exc_info.value)


# ---------------------------------------------------------------------------
# test_compiler_acquire_known_tool — end-to-end mock: tool_name → skill installed
# ---------------------------------------------------------------------------

class TestCompilerAcquireKnownTool:
    def test_acquire_installs_and_activates_skill(self):
        """acquire() returns True and the skill dir is added to sys.path."""
        with tempfile.TemporaryDirectory() as td:
            cfg = _power_cfg(td)
            compiler = SkillCompiler(cfg)

            # Patch the registry to return our fake skill.
            compiler._registry.find_for_tool = MagicMock(return_value=_FAKE_SKILL)

            # Patch the downloader to create a stub (simulates offline dev).
            import urllib.error
            with patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError("mocked offline"),
            ):
                result = compiler.acquire("do_something")

            assert result is True
            # The skill directory should now be on sys.path.
            skill_dir = Path(td) / "skills" / "test-skill"
            assert any("test-skill" in p for p in sys.path), (
                f"skill dir not on sys.path; sys.path={sys.path[:5]}"
            )
            # Clean up sys.path mutation.
            sys.path[:] = [p for p in sys.path if "test-skill" not in p]

    def test_acquire_is_idempotent(self):
        """acquire() called twice returns True both times, installs only once."""
        with tempfile.TemporaryDirectory() as td:
            cfg = _power_cfg(td)
            compiler = SkillCompiler(cfg)
            compiler._registry.find_for_tool = MagicMock(return_value=_FAKE_SKILL)

            import urllib.error
            with patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError("mocked offline"),
            ):
                r1 = compiler.acquire("do_something")
                r2 = compiler.acquire("do_something")

            assert r1 is True
            assert r2 is True
            assert compiler._injector.is_installed("test-skill")
            # Clean up.
            sys.path[:] = [p for p in sys.path if "test-skill" not in p]

    def test_acquired_session_list(self):
        """list_acquired returns names of skills installed in this session."""
        with tempfile.TemporaryDirectory() as td:
            cfg = _power_cfg(td)
            compiler = SkillCompiler(cfg)
            compiler._registry.find_for_tool = MagicMock(return_value=_FAKE_SKILL)

            import urllib.error
            with patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError("mocked offline"),
            ):
                compiler.acquire("do_something")

            assert "test-skill" in compiler.list_acquired()
            # Clean up.
            sys.path[:] = [p for p in sys.path if "test-skill" not in p]


# ---------------------------------------------------------------------------
# test_compiler_acquire_unknown_tool — unknown tool returns False gracefully
# ---------------------------------------------------------------------------

class TestCompilerAcquireUnknownTool:
    def test_returns_false_for_unregistered_tool(self):
        """acquire() returns False (not raises) when tool is not in registry."""
        with tempfile.TemporaryDirectory() as td:
            cfg = _power_cfg(td)
            compiler = SkillCompiler(cfg)

            # Registry returns None → tool unknown.
            compiler._registry.find_for_tool = MagicMock(return_value=None)
            result = compiler.acquire("totally_unknown_tool_xyzzy")

            assert result is False

    def test_lite_tier_rejects_skill_with_deps(self):
        """Lite nodes skip skills that require external pip packages."""
        with tempfile.TemporaryDirectory() as td:
            cfg = _lite_cfg(td)
            compiler = SkillCompiler(cfg)

            skill_with_deps = dict(_FAKE_SKILL)
            skill_with_deps["requires"] = ["some-heavy-dep>=1.0"]
            compiler._registry.find_for_tool = MagicMock(return_value=skill_with_deps)

            result = compiler.acquire("do_something")
            assert result is False  # lite tier should skip, not raise

    def test_does_not_raise_skillnotfound(self):
        """acquire() never raises SkillNotFound — it returns False instead."""
        with tempfile.TemporaryDirectory() as td:
            cfg = _power_cfg(td)
            compiler = SkillCompiler(cfg)
            compiler._registry.find_for_tool = MagicMock(return_value=None)

            # Must not raise.
            try:
                result = compiler.acquire("ghost_tool")
            except SkillNotFound:
                pytest.fail("acquire() should return False, not raise SkillNotFound")
            assert result is False


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Allow running as a plain script for quick iteration.
    import subprocess as _sp
    _sp.run([sys.executable, "-m", "pytest", __file__, "-v"], check=False)
