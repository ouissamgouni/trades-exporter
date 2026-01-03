"""backend package

Minimal package entry. Exposes basic metadata.
"""

__all__ = ["config", "core", "file_loaders", "services", "connectors"]
__version__ = "0.1.0"

from . import config, core, file_loaders
