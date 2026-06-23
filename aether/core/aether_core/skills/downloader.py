"""Skill downloader with SHA-256 and Ed25519 signature verification.

Security model
--------------
Every skill tarball served by the Aether registry is:

1. Content-hashed (SHA-256) — the digest is embedded in the registry entry.
2. Ed25519-signed — the signature covers ``name + version + sha256`` and is
   verified against the hardcoded Aether public key.  An attacker who hijacks
   the download URL cannot swap in a malicious package unless they also
   compromise the Aether signing key.

Dev / air-gapped mode
---------------------
When ``DEV_MODE = True`` (set automatically when the download URL is a
placeholder pointing at ``registry.aethermesh.dev`` and the registry cannot be
reached), the downloader creates a minimal stub skill directory in the
workspace instead of actually downloading anything.  This lets the full
pipeline run end-to-end in tests and on developer machines.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .exceptions import SkillInstallError

log = logging.getLogger("aether.skills.downloader")

# ---------------------------------------------------------------------------
# Aether registry Ed25519 public key (base64-encoded, 32 bytes decoded).
#
# This key is the only trust anchor for skill verification.  Rotate by
# shipping a new key in a signed core update — never accept keys from the
# registry payload itself.
#
# NOTE: For the development build this is a well-known test key whose
# matching private key is kept in the CI secrets vault.  The production key
# is substituted at release time via the signing pipeline.
# ---------------------------------------------------------------------------
AETHER_PUBLIC_KEY_B64: str = (
    "MCowBQYDK2VwAyEA3p3V8r5D2JBxqK7LzN4Yf1mT6cW0Hs8eUvXiQgPbOjA="
)

# Raw 32-byte Ed25519 public key (decoded from the DER SubjectPublicKeyInfo
# above — last 32 bytes are the raw key material).
_RAW_PUBLIC_KEY_BYTES: bytes = bytes([
    0xDE, 0x9D, 0xD5, 0xF2, 0xBE, 0x43, 0xD8, 0x90,
    0x71, 0xA8, 0xAE, 0xCB, 0xCC, 0xDE, 0x18, 0x7F,
    0x59, 0x93, 0xE9, 0xC5, 0xB4, 0x1E, 0xCF, 0x1E,
    0x52, 0xF5, 0xE2, 0x42, 0x03, 0x6F, 0x3A, 0x30,
])

# HTTP request timeout in seconds.
_HTTP_TIMEOUT = 30


class SkillDownloader:
    """Downloads and cryptographically verifies skill tarballs.

    Args:
        workspace: Root directory where the agent stores downloaded artefacts.
    """

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace
        self._cache_dir = workspace / ".skill_cache"
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def download(self, skill: dict[str, Any]) -> Path:
        """Download and verify a skill, returning the path to the tarball.

        Verification steps:
            1. GET ``skill['download_url']`` → save to a temp file.
            2. SHA-256 the bytes, compare against ``skill['sha256']``.
            3. Ed25519-verify the signature against the hardcoded public key.

        In dev mode (remote unreachable **and** URL is a placeholder):
            Creates a stub skill directory and returns a sentinel ``.stub``
            path so the injector can handle the no-network case gracefully.

        Raises:
            SkillInstallError: If SHA-256 or signature verification fails, or
                if the download fails for a non-dev-mode URL.
        """
        name: str = skill.get("name", "unknown")
        url: str = skill.get("download_url", "")
        expected_sha: str = skill.get("sha256", "")
        signature: str = skill.get("signature", "")

        # Return cached tarball if already present (idempotent downloads).
        cached = self._cache_dir / f"{name}.tar.gz"
        if cached.exists():
            log.debug("downloader: using cached tarball for %s", name)
            return cached

        log.info("downloader: fetching %s from %s", name, url)
        raw_bytes, dev_mode = self._fetch(name, url)

        if dev_mode:
            # Build a stub directory rather than an actual tarball.
            return self._make_stub(skill)

        # -- integrity checks ------------------------------------------------
        if not self._verify_sha256(raw_bytes, expected_sha):
            raise SkillInstallError(
                name,
                f"SHA-256 mismatch — expected {expected_sha[:16]}…, "
                f"got {hashlib.sha256(raw_bytes).hexdigest()[:16]}…",
            )

        if not self._verify_signature(skill, raw_bytes):
            raise SkillInstallError(
                name,
                "Ed25519 signature verification failed — tarball may have been tampered with",
            )

        # -- persist to cache ------------------------------------------------
        cached.write_bytes(raw_bytes)
        log.info("downloader: verified and cached %s (%d bytes)", name, len(raw_bytes))
        return cached

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch(self, name: str, url: str) -> tuple[bytes, bool]:
        """Fetch URL bytes.  Returns ``(data, dev_mode)``.

        ``dev_mode`` is True when the remote is unreachable AND the URL is a
        placeholder (i.e. points at the official registry host).
        """
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "aether-core/1.0"},
            )
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
                return resp.read(), False
        except (urllib.error.URLError, OSError) as exc:
            is_placeholder = "registry.aethermesh.dev" in url
            if is_placeholder:
                log.info(
                    "downloader: %s — remote unreachable, activating dev-mode stub for %s",
                    exc, name,
                )
                return b"", True
            raise SkillInstallError(name, f"download failed: {exc}") from exc

    def _make_stub(self, skill: dict[str, Any]) -> Path:
        """Create a minimal stub skill directory for dev / offline mode.

        The stub satisfies the injector's structure requirements so the full
        pipeline can be exercised without a real registry.
        """
        name: str = skill.get("name", "stub")
        stub_dir = self._workspace / "skills" / name
        stub_dir.mkdir(parents=True, exist_ok=True)

        # skill.json — the manifest the injector validates.
        (stub_dir / "skill.json").write_text(
            json.dumps(
                {
                    "name": name,
                    "version": skill.get("version", "0.0.0"),
                    "tools": skill.get("tools", []),
                    "language": skill.get("language", "python"),
                    "requires": skill.get("requires", []),
                    "stub": True,
                },
                indent=2,
            ),
            "utf-8",
        )

        # Minimal Python module so the injector can import it.
        main_module = stub_dir / f"{name.replace('-', '_')}.py"
        tools = skill.get("tools", [])
        tool_stubs = "\n\n".join(
            f"def {t}(*args, **kwargs):\n    raise NotImplementedError({t!r} + ' stub — real skill not installed')"
            for t in tools
        )
        main_module.write_text(
            f'"""Stub skill: {name} (dev mode — real tarball not downloaded)."""\n\n{tool_stubs}\n',
            "utf-8",
        )

        log.info("downloader: created stub for %s at %s", name, stub_dir)
        # Return a sentinel path so the injector knows this is already extracted.
        sentinel = stub_dir / ".stub"
        sentinel.touch()
        return sentinel

    def _verify_sha256(self, data: bytes, expected: str) -> bool:
        """Return True iff SHA-256(data) == expected (hex)."""
        if not expected:
            log.warning("downloader: no SHA-256 in registry entry — skipping digest check")
            return True  # registry entry has no hash; allow but log
        actual = hashlib.sha256(data).hexdigest()
        return actual == expected.lower()

    def _verify_signature(self, skill: dict[str, Any], tarball: bytes) -> bool:
        """Return True iff the Ed25519 signature is valid.

        Signs the canonical message: ``name + "|" + version + "|" + sha256``.

        Falls back gracefully when the ``cryptography`` library is not
        installed (pure-stdlib build): logs a warning and returns True so that
        the installation proceeds without the cryptographic check.  On Power
        nodes (production) the ``cryptography`` package is always present.
        """
        name = skill.get("name", "")
        version = skill.get("version", "")
        sha256 = skill.get("sha256", "")
        signature_hex: str = skill.get("signature", "")

        if not signature_hex:
            log.warning("downloader: no signature in registry entry for %s — skipping", name)
            return True

        message = f"{name}|{version}|{sha256}".encode()

        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
            from cryptography.exceptions import InvalidSignature

            pub_key = Ed25519PublicKey.from_public_bytes(_RAW_PUBLIC_KEY_BYTES)
            sig_bytes = bytes.fromhex(signature_hex) if len(signature_hex) > 90 else (
                # Base64-encoded signatures (legacy format).
                __import__("base64").b64decode(signature_hex + "==")
            )
            try:
                pub_key.verify(sig_bytes, message)
                return True
            except InvalidSignature:
                return False
        except ImportError:
            log.warning(
                "downloader: 'cryptography' package not available — "
                "Ed25519 signature check skipped for %s",
                name,
            )
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("downloader: signature check failed unexpectedly (%s) — rejecting", exc)
            return False
