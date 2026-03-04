#!/usr/bin/env python3
"""
Fix timezone issues in existing OKX trades file transactions.

OKX CSV exports use the user's local timezone (typically CET / UTC+1),
but the loader incorrectly assumed timestamps were in UTC.
This script:
1. Identifies all okx-trades-file transactions
2. Converts their datetime from incorrect UTC to correct UTC (subtracts 1 hour)
3. Recalculates transaction_hash with corrected datetime
4. Updates the database

Usage:
    # Dry run (preview changes without applying)
    python scripts/fix_okx_trades_file_timezones.py --dry-run
    
    # Apply changes
    python scripts/fix_okx_trades_file_timezones.py
    
    # Apply changes to specific account
    python scripts/fix_okx_trades_file_timezones.py --account-id 37
    
    # Custom offset (default is 1 hour for CET)
    python scripts/fix_okx_trades_file_timezones.py --offset-hours 2
"""

import sys
import argparse
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any

sys.path.insert(0, '/Users/ouissamgouni/Documents/it-workspace/trades-exporter')

from sqlmodel import Session, select
from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction
from backend.services.duplicate_detection_service import compute_transaction_hash
from backend.config.loader import configure_logging

log = configure_logging("fix_okx_trades_timezones")


def find_affected_transactions(session: Session, account_id: int = None) -> List[NormalizedTransaction]:
    """
    Find all OKX trades file transactions that need timezone correction.
    """
    stmt = select(NormalizedTransaction).where(
        NormalizedTransaction.source == 'okx-trades-file'
    )
    
    if account_id is not None:
        stmt = stmt.where(NormalizedTransaction.account_id == account_id)
    
    stmt = stmt.order_by(NormalizedTransaction.id)
    
    transactions = session.exec(stmt).all()
    return list(transactions)


def calculate_corrected_values(
    tx: NormalizedTransaction,
    session: Session,
    offset_hours: int = 1,
) -> Dict[str, Any]:
    """
    Calculate corrected datetime and transaction_hash for a transaction.
    
    The stored datetime was incorrectly treated as UTC when it was actually
    in the user's local timezone (UTC+offset_hours).
    To correct: subtract offset_hours from the stored value.
    """
    if not tx.date_time:
        return {
            'error': 'Missing date_time',
            'corrected': False
        }
    
    corrected_datetime = tx.date_time - timedelta(hours=offset_hours)
    
    # Recalculate transaction hash with corrected datetime
    if tx.account_id and tx.source_asset_symbol and tx.direction and tx.quantity:
        corrected_hash = compute_transaction_hash(
            account_id=tx.account_id,
            datetime_obj=corrected_datetime,
            source_asset_symbol=tx.source_asset_symbol,
            source_price_quote_asset_symbol=tx.source_price_quote_asset_symbol or '',
            direction=tx.direction,
            quantity=tx.quantity,
            price=tx.price,
            session=session,
            asset_id=tx.asset_id,
            price_quote_asset_id=tx.price_quote_asset_id,
        )
    else:
        corrected_hash = None
    
    return {
        'corrected': True,
        'original_datetime': tx.date_time,
        'corrected_datetime': corrected_datetime,
        'original_hash': tx.transaction_hash,
        'corrected_hash': corrected_hash,
        'datetime_changed': corrected_datetime != tx.date_time,
        'hash_changed': corrected_hash != tx.transaction_hash
    }


def apply_corrections(
    session: Session,
    transactions: List[NormalizedTransaction],
    offset_hours: int = 1,
    dry_run: bool = True,
) -> Dict[str, Any]:
    """Apply timezone corrections to transactions."""
    stats = {
        'total_checked': len(transactions),
        'total_corrected': 0,
        'datetime_updated': 0,
        'hash_updated': 0,
        'errors': 0,
        'details': []
    }
    
    for tx in transactions:
        correction = calculate_corrected_values(tx, session, offset_hours)
        
        if not correction.get('corrected'):
            log.warning(
                f"Cannot correct transaction {tx.id}",
                error=correction.get('error'),
                tx_id=tx.id
            )
            stats['errors'] += 1
            continue
        
        needs_update = correction['datetime_changed'] or correction['hash_changed']
        
        if needs_update:
            detail = {
                'tx_id': tx.id,
                'source': tx.source,
                'source_tx_id': tx.source_transaction_id,
                'account_id': tx.account_id,
                'asset': tx.source_asset_symbol,
                'original_datetime': correction['original_datetime'].isoformat(),
                'corrected_datetime': correction['corrected_datetime'].isoformat(),
                'datetime_changed': correction['datetime_changed'],
                'original_hash': correction['original_hash'],
                'corrected_hash': correction['corrected_hash'],
                'hash_changed': correction['hash_changed']
            }
            stats['details'].append(detail)
            
            if not dry_run:
                if correction['datetime_changed']:
                    tx.date_time = correction['corrected_datetime']
                    stats['datetime_updated'] += 1
                
                if correction['hash_changed']:
                    tx.transaction_hash = correction['corrected_hash']
                    stats['hash_updated'] += 1
                
                session.add(tx)
                stats['total_corrected'] += 1
    
    if not dry_run and stats['total_corrected'] > 0:
        session.commit()
        log.info(
            "Applied timezone corrections",
            total_corrected=stats['total_corrected'],
            datetime_updated=stats['datetime_updated'],
            hash_updated=stats['hash_updated']
        )
    
    return stats


def print_summary(stats: Dict[str, Any], dry_run: bool, offset_hours: int):
    """Print summary of corrections."""
    print("\n" + "="*80)
    print(f"{'DRY RUN - ' if dry_run else ''}OKX Trades File Timezone Correction Summary")
    print(f"Offset: -{offset_hours} hour(s) (timestamps were UTC+{offset_hours}, stored as UTC)")
    print("="*80)
    
    print(f"\nTransactions checked: {stats['total_checked']}")
    print(f"Transactions needing correction: {len(stats['details'])}")
    print(f"Datetime updates: {stats['datetime_updated']}")
    print(f"Hash updates: {stats['hash_updated']}")
    print(f"Errors: {stats['errors']}")
    
    if stats['details']:
        print("\n" + "-"*80)
        print("Details of corrections:")
        print("-"*80)
        
        for detail in stats['details'][:20]:
            print(f"\nTransaction ID: {detail['tx_id']}")
            print(f"  Source: {detail['source']}")
            print(f"  Source TX ID: {str(detail['source_tx_id'])[:60]}")
            print(f"  Account: {detail['account_id']}")
            print(f"  Asset: {detail['asset']}")
            
            if detail['datetime_changed']:
                print(f"  Datetime: {detail['original_datetime']} → {detail['corrected_datetime']}")
            
            if detail['hash_changed']:
                print(f"  Hash: {detail['original_hash']} → {detail['corrected_hash']}")
        
        if len(stats['details']) > 20:
            print(f"\n... and {len(stats['details']) - 20} more")
    
    print("\n" + "="*80)
    
    if dry_run and stats['details']:
        print("\n⚠️  This was a DRY RUN - no changes were applied.")
        print("Run without --dry-run to apply these corrections.")
    elif not dry_run and stats['total_corrected'] > 0:
        print(f"\n✅ Successfully corrected {stats['total_corrected']} transactions!")
    elif not dry_run and stats['total_corrected'] == 0:
        print("\n✓ No transactions needed correction.")


def main():
    parser = argparse.ArgumentParser(
        description='Fix timezone issues in OKX trades file transactions',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview changes without applying them'
    )
    parser.add_argument(
        '--account-id',
        type=int,
        help='Only fix transactions for specific account ID'
    )
    parser.add_argument(
        '--offset-hours',
        type=int,
        default=1,
        help='Hours offset to subtract (default: 1 for CET/UTC+1)'
    )
    
    args = parser.parse_args()
    
    print("="*80)
    print("OKX Trades File Timezone Correction Script")
    print("="*80)
    print(f"\nMode: {'DRY RUN (preview only)' if args.dry_run else 'APPLY CHANGES'}")
    print(f"Offset: -{args.offset_hours} hour(s)")
    if args.account_id:
        print(f"Account filter: {args.account_id}")
    print()
    
    engine = get_engine()
    
    with Session(engine) as session:
        log.info("Finding affected transactions...")
        transactions = find_affected_transactions(session, args.account_id)
        
        print(f"Found {len(transactions)} OKX trades file transactions")
        
        if not transactions:
            print("\nNo transactions found to correct.")
            return 0
        
        stats = apply_corrections(
            session, transactions,
            offset_hours=args.offset_hours,
            dry_run=args.dry_run,
        )
        
        print_summary(stats, args.dry_run, args.offset_hours)
        
        return 0 if stats['errors'] == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n\nInterrupted by user")
        sys.exit(1)
    except Exception as e:
        log.error(f"Fatal error: {e}", exc_info=True)
        print(f"\n❌ Error: {e}")
        sys.exit(1)
