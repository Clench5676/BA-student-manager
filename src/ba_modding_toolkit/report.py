"""Compatibility import for the relocated core.report module."""
import sys
from .core import report as _module
sys.modules[__name__] = _module
