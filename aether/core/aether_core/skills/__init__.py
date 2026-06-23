"""Aether Skill Injection Pipeline.

When the agent encounters a task requiring a capability it does not have, this
package autonomously downloads and installs the right skill from the curated
Aether registry — no human intervention required.

Public surface::

    from aether_core.skills import SkillCompiler, SkillNotFound, SkillInstallError

    compiler = SkillCompiler(config)
    acquired = compiler.acquire("create_issue")   # True → skill is now live
"""

from .compiler import SkillCompiler
from .exceptions import SkillInstallError, SkillNotFound, ToolNotFound

__all__ = ["SkillCompiler", "SkillNotFound", "SkillInstallError", "ToolNotFound"]
