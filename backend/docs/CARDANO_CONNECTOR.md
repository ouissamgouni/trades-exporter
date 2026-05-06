# Cardano Connector Documentation

## Overview

The Cardano connector integrates with the Cardanoscan API to fetch and normalize Cardano blockchain transactions. It implements stake credential-based address matching and proper eUTxO net flow calculations.

## Features

- **Stake Credential Matching**: Uses `pycardano` to extract stake credentials from addresses, enabling multi-address wallet detection
- **eUTxO Net Flow Calculation**: Accurately calculates net flow as: (outputs to wallet) - (inputs from wallet) + (withdrawals)
- **Self-Transfer Detection**: Identifies transactions where all inputs and outputs belong to the same wallet
- **Staking Support**: Handles withdrawal transactions (staking rewards)
- **Fee Inclusion**: Correctly includes fees for outflows and self-transfers
- **Test Mode**: Supports loading test data from fixtures for testing

## Configuration

### Chain Configuration

Added to [backend/connectors/onchain/chain_config.py](../connectors/onchain/chain_config.py):

```python
"cardano": {
    "native_token": "ADA",
    "native_token_decimals": 6,  # 1 ADA = 1,000,000 lovelaces
}
```

### Connector Registration

Registered in [backend/connectors/connector_registry.py](../connectors/connector_registry.py):

```python
"cardano_scan": {
    "display_name": "Cardano (Cardanoscan)",
    "hub_key": "on-chain",
    "category": "on-chain",
}
```

### Database Seeding

Added to [backend/db/seed_data/accounts.yaml](../db/seed_data/accounts.yaml):

```yaml
- id: 17
  name: "Cardano Wallet"
  connector_type: "cardano_scan"
  address: "addr1qx478mhvuvlu2wfufdfem7a0truw3zjj7mrtxcdhytyjazkd4rpkpyue5qayv2spsznjn43q4phsldkptpthw3u5teasar990w"
  credentials_ref: "env:CARDANOSCAN_API_KEY"
  source_key: "cardano_mainnet"
  tags:
    - "blockchain"
    - "cardano"
```

## Usage

### Environment Variables

Set your Cardanoscan API key:

```bash
export CARDANOSCAN_API_KEY="your-cardanoscan-api-key-here"
```

### Running the Connector

```python
from connectors.onchain.connector_cardano_scan import ConnectorCardanoScan

connector = ConnectorCardanoScan(
    account_id=1,
    connector_type="cardano_scan",
    address="addr1qx478...",  # Your Cardano address
    api_key="your_api_key"
)

# Fetch transactions
for raw_tx in connector.yield_raws():
    print(raw_tx)

# Normalize transactions
for ntx in connector.raw_to_normalized(raw_tx):
    print(ntx)
```

### Test Mode

For testing, set the `test_mode` parameter:

```python
connector = ConnectorCardanoScan(
    account_id=1,
    connector_type="cardano_scan",
    address="addr1qx478...",
    api_key="test_key",
    test_mode=True
)
```

This loads transactions from [backend/tests/fixtures/cardano/cardanoscan_transactions.json](../tests/fixtures/cardano/cardanoscan_transactions.json).

## Implementation Details

### Stake Credential Extraction

The connector uses `pycardano` to extract stake credentials from Cardano addresses:

```python
def _get_stake_credential(self, address_str: str) -> Optional[str]:
    try:
        addr = Address.from_primitive(address_str)
        if hasattr(addr, 'staking_part') and addr.staking_part:
            return addr.staking_part.to_primitive().hex()
        elif hasattr(addr, 'payment_part') and addr.payment_part:
            return addr.payment_part.to_primitive().hex()
    except Exception:
        return None
```

This enables matching addresses that share the same stake key, supporting wallets with multiple addresses.

### Net Flow Calculation

The eUTxO net flow is calculated as:

```
net_flow = (sum of outputs to wallet) - (sum of inputs from wallet) + (withdrawals)
```

This handles:

- **Incoming payments**: Positive net flow
- **Outgoing payments**: Negative net flow (includes change addresses automatically)
- **Self-transfers**: All inputs and outputs from/to wallet addresses
- **Withdrawals**: Staking rewards added as inflows

### Direction Determination

Transaction direction is determined by:

1. **Self-transfer**: All inputs AND all outputs belong to wallet → `neutral`
2. **Inflow**: Net flow > 0 → `inflow`
3. **Outflow**: Net flow < 0 → `outflow`
4. **Zero net flow** (e.g., failed transactions): `neutral`

### Fee Handling

- **Outflows and self-transfers**: Fee is included (`include_fee=True`)
- **Inflows**: Fee is NOT included (paid by sender)

## Testing

### Unit Tests

Run all unit tests:

```bash
pytest tests/test_cardano_scan_connector.py -v
```

Test coverage includes:

- Initialization and configuration
- Stake credential extraction
- Address ownership detection
- Transaction normalization
- Fee calculation
- Direction determination
- Withdrawal handling
- Failed transaction filtering
- Lovelace to ADA conversion
- Timestamp parsing
- Transaction and certificate tags

All 18 tests pass.

### Integration Tests

Test against the live Cardanoscan API:

```bash
export CARDANOSCAN_API_KEY="your_api_key"
pytest backend/test_cardano_integration.py -v
```

## API Reference

### Cardanoscan API

- **Endpoint**: `https://api.cardanoscan.io/api/v1/transaction/list`
- **Method**: GET
- **Parameters**:
  - `address`: Cardano address to fetch transactions for
  - `pageNo`: Page number (starts at 1)

**Response Format**:

```json
{
  "pageNo": 1,
  "limit": 50,
  "transactions": [
    {
      "hash": "tx_hash",
      "slot": 125000000,
      "epoch": 450,
      "index": 0,
      "status": true,
      "timestamp": "2024-01-15T10:30:00.000Z",
      "fees": "175000",
      "inputs": [
        {
          "address": "addr1...",
          "value": "5000000",
          "tokens": []
        }
      ],
      "outputs": [
        {
          "address": "addr1...",
          "value": "4825000"
        }
      ],
      "withdrawals": [],
      "certificate": {}
    }
  ],
  "count": 150
}
```

## Dependencies

- **pycardano**: `0.11.1` - For Cardano address parsing and stake credential extraction

## Known Limitations

1. **ADA Only**: Currently only processes ADA (native token). Multi-asset support planned for future.
2. **API Rate Limiting**: Cardanoscan API may have rate limits; the connector includes retry logic.
3. **Pagination**: Large transaction histories require multiple API calls.

## Future Enhancements

- Multi-asset (native token) support
- Metadata extraction
- Smart contract interaction detection
- Pool delegation tracking
- NFT transaction handling

## References

- [Cardanoscan API Documentation](https://docs.cardanoscan.io/operation/operation-get-transaction-list)
- [PyCardano Documentation](https://pycardano.readthedocs.io/)
- [Cardano eUTxO Model](https://docs.cardano.org/learn/eutxo-explainer)
