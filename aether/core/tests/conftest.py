# conftest.py — pytest configuration for aether-core tests
# Ensures __pycache__ is bypassed on NTFS mounts where mtime is not updated on write.
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
