#!/usr/bin/env python3
"""Test hex address parsing for Cardano connector."""

from connectors.onchain.connector_cardano_scan import ConnectorCardanoScan

# Create connector
c = ConnectorCardanoScan(
    wallet_address='addr1qx478mhvuvlu2wfufdfem7a0truw3zjj7mrtxcdhytyjazkd4rpkpyue5qayv2spsznjn43q4phsldkptpthw3u5teasar990w',
    account_id=1,
    config={'test_mode': True}
)

# Test hex address parsing
hex_addr = '01abe3eeece33fc5393c4b539dfbaf58f8e88a52f6c6b361b722c92e8acda8c3609399a03a462a0180a729d620a86f0fb6c158577747945e7b'
stake_id = c._get_stake_credential(hex_addr)
print(f'Hex address stake ID: {stake_id}')
print(f'User stake ID: {c.user_stake_id}')
print(f'Is own address: {c._is_own_address(hex_addr)}')

# Test the transaction
tx = {
    'hash': '67b09cf1048e2684666da1cf0757bf0df16b99e73affd21533a3d1698f4f3fff',
    'fees': '175161',
    'timestamp': '2025-10-04T15:14:14.000Z',
    'status': True,
    'inputs': [{
        'address': '616543bc16fabd30010292e2367ece8a4afaa54a086a44a15e4c95864e',
        'value': '10330339584'
    }],
    'outputs': [{
        'address': '01abe3eeece33fc5393c4b539dfbaf58f8e88a52f6c6b361b722c92e8acda8c3609399a03a462a0180a729d620a86f0fb6c158577747945e7b',
        'value': '273564172'
    }, {
        'address': '616543bc16fabd30010292e2367ece8a4afaa54a086a44a15e4c95864e',
        'value': '10056600251'
    }],
    'certificate': {},
    'withdrawals': []
}

# Normalize
print('\nNormalizing transaction...')
for ntx in c.raw_to_normalized(tx):
    print(f'\nNormalized transaction:')
    print(f'  Hash: {ntx.network_transaction_id}')
    print(f'  Direction: {ntx.direction}')
    print(f'  Quantity: {ntx.quantity} ADA')
    print(f'  Fee: {ntx.fee} ADA')
    print(f'  From: {ntx.from_address[:20] if ntx.from_address else "N/A"}...')
    print(f'  To: {ntx.to_address[:20] if ntx.to_address else "N/A"}...')
