#!/usr/bin/env python
"""Debug script to check units and transactions."""

from sqlmodel import Session, select
from backend.db.models import NormalizedTransaction, CalculationUnit
from backend.db.database import get_engine

engine = get_engine()

with Session(engine) as session:
    # Check valid transactions
    txs = session.exec(
        select(NormalizedTransaction)
        .where(NormalizedTransaction.review_status == 'valid')
        .limit(10)
    ).all()
    print(f"Found {len(txs)} valid transactions")
    for tx in txs[:3]:
        print(f"  TX {tx.id}: type={tx.transaction_type}, direction={tx.direction}, asset={tx.source_asset_symbol}")
    
    # Check units
    units = session.exec(select(CalculationUnit).limit(10)).all()
    print(f"\nFound {len(units)} calculation units in DB")
    for unit in units[:3]:
        print(f"  Unit {unit.id}: pattern={unit.pattern}, origin={unit.unit_origin}")
