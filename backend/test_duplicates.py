#!/usr/bin/env python3
"""Test script to check duplicate detection"""

from backend.db.database import get_session_dependency
from sqlmodel import select, func
from backend.db.models import NormalizedTransaction

session = next(get_session_dependency())

# Check if transaction_hash column exists and has data
result = session.exec(
    select(
        func.count(NormalizedTransaction.id).label('total'),
        func.count(NormalizedTransaction.transaction_hash).label('with_hash')
    )
).first()

print(f'Total transactions: {result[0]}')
print(f'Transactions with hash: {result[1]}')

# Check for duplicates in transaction_hash
dup_query = select(
    NormalizedTransaction.transaction_hash,
    func.count(NormalizedTransaction.id).label('count')
).where(
    NormalizedTransaction.transaction_hash.isnot(None)
).group_by(
    NormalizedTransaction.transaction_hash
).having(
    func.count(NormalizedTransaction.id) > 1
)

duplicates = session.exec(dup_query).all()
print(f'\nDuplicate hashes found: {len(duplicates)}')
if duplicates:
    print('\nFirst 5 duplicate hashes:')
    for hash_val, count in list(duplicates)[:5]:
        print(f'  Hash {hash_val[:16]}... has {count} transactions')
        
        # Show the transaction IDs
        txs = session.exec(
            select(NormalizedTransaction.id, NormalizedTransaction.source_transaction_id)
            .where(NormalizedTransaction.transaction_hash == hash_val)
        ).all()
        for tx_id, source_id in txs:
            print(f'    - ID {tx_id}, source: {source_id}')
else:
    print('\nNo duplicates found!')
    print('\nChecking if any transactions have NULL hash:')
    null_count = session.exec(
        select(func.count(NormalizedTransaction.id))
        .where(NormalizedTransaction.transaction_hash.is_(None))
    ).first()
    print(f'Transactions with NULL hash: {null_count}')
