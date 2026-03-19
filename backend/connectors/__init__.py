"""
Connectors module: Exchange-specific API clients for fetching trades.
Provides standardized connector classes organized by type (exchanges, web3).
"""

# Base connector
from backend.connectors.base.base_connector import BaseConnector

# Exchange connectors
from backend.connectors.cex.connector_mexc_trx import MEXCConnectorTrx
from backend.connectors.cex.connector_binance_trx import BinanceTrxConnector
from backend.connectors.cex.connector_binance_deposits import (
    ConnectorBinanceDeposits,
)
from backend.connectors.cex.connector_binance_withdrawals import (
    BinanceWithdrawalsConnector,
)
from backend.connectors.cex.connector_coinbase_trx import ConnectorCoinbaseTrx
from backend.connectors.cex.connector_okx_trx import OKXConnectorTrx
from backend.connectors.cex.connector_okx_convert import (
    OKXConvertConnector,
)

# Web3 connectors
from backend.connectors.onchain.etherscan.connector_etherscan_hub import (
    ConnectorEtherscanHub,
)
from backend.connectors.onchain.blockscout.connector_blockscout_hub import (
    ConnectorBlockscoutHub,
)

__all__ = [
    # Base
    "BaseConnector",
    # Exchanges
    "MEXCConnectorTrx",
    "BinanceTrxConnector",
    "ConnectorBinanceDeposits",
    "BinanceWithdrawalsConnector",
    "ConnectorCoinbaseTrx",
    "OKXConnectorTrx",
    "OKXConvertConnector",
    # Web3
    "ConnectorEtherscanHub",
    "ConnectorBlockscoutHub",
]
