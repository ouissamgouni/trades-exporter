"""
Blockscout connector package: Blockchain scanners using Blockscout API v2.
Supports multiple networks: Base, Ethereum, Optimism, Arbitrum, Polygon, Gnosis.
"""

from .base_blockscout_connector import BlockscoutConnectorBase
from .connector_blockscout_hub import ConnectorBlockscoutHub
from .connector_blockscout_normal_tx import ConnectorBlockscoutNormalTx
from .connector_blockscout_token_transfers import ConnectorBlockscoutTokenTransfers


# Backward compatibility aliases for Base network
ConnectorBlockscoutBaseNormalTx = ConnectorBlockscoutNormalTx
ConnectorBlockscoutBaseTokenTransfers = ConnectorBlockscoutTokenTransfers

__all__ = [
    # Base classes
    "BlockscoutConnectorBase",
    "BLOCKSCOUT_NETWORKS",
    # Generic connectors
    "ConnectorBlockscoutHub",
    "ConnectorBlockscoutNormalTx",
    "ConnectorBlockscoutTokenTransfers",
    # Ethereum network connectors
    "ConnectorBlockscoutEthHub",
    "ConnectorBlockscoutEthNormalTx",
    "ConnectorBlockscoutEthTokenTransfers",
    # Backward compatibility
    "ConnectorBlockscoutBaseNormalTx",
    "ConnectorBlockscoutBaseTokenTransfers",
]
