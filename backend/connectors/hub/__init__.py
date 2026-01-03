"""
Master connector package - First-level connectors that orchestrate second-level connectors.
"""

from .connector_hub import ConnectorHub

__all__ = ["ConnectorHub"]
