"""Compatibility import for the relocated core.mod_install module."""
import sys
from .core import mod_install as _module
sys.modules[__name__] = _module
