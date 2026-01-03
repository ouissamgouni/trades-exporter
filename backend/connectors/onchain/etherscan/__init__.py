"""
Etherscan connector package: Ethereum blockchain scanners using Etherscan API.
Provides connectors for different transaction types on Ethereum and compatible chains.
"""

from .connector_etherscan_hub import ConnectorEtherscanHub
from .connector_etherscan_normal_tx import ConnectorEtherscanNormalTx
from .connector_etherscan_token_transfers import ConnectorEtherscanTokenTransfers

__all__ = [
    "ConnectorEtherscanHub",
    "ConnectorEtherscanNormalTx",
    "ConnectorEtherscanTokenTransfers",
]
