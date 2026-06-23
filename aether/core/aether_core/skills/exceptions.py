"""Skill pipeline exceptions."""

from __future__ import annotations


class SkillNotFound(LookupError):
    """Raised when no skill in the registry provides the requested tool."""

    def __init__(self, tool_or_skill: str) -> None:
        super().__init__(f"No registered skill provides: {tool_or_skill!r}")
        self.tool_or_skill = tool_or_skill


class SkillInstallError(RuntimeError):
    """Raised when a skill download, verification, or installation fails."""

    def __init__(self, skill_name: str, reason: str) -> None:
        super().__init__(f"Failed to install skill {skill_name!r}: {reason}")
        self.skill_name = skill_name
        self.reason = reason


class ToolNotFound(Exception):
    """Raised when a required tool is not found during task processing."""

    def __init__(self, tool_name: str) -> None:
        super().__init__(f"Tool not found: {tool_name}")
        self.tool_name = tool_name

