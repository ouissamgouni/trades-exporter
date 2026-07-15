#!/usr/bin/env python3
"""
Script to delete all draft calculation versions and their children in cascade.

Usage:
    python scripts/delete_draft_versions.py [--test] [--force] [--dry-run]

This script will:
1. Find all CalculationVersion records with status='draft'
2. Delete them with CASCADE (automatically deletes all children):
   - CalculationUnit → CostLot → ConsumedLotSlice, LotSettlement, CostLotEvent
   - CalculationUnit → RealizedPnl
   - CalculationUnit → PnlWarning
   - CalculationUnit → CalculationUnitLeg
   - UnrealizedPnl (direct FK to version)

Options:
    --test     Use test database (default: production)
    --force    Skip confirmation prompt
    --dry-run  Show what would be deleted without actually deleting
"""

import sys
import argparse
from pathlib import Path
from datetime import datetime

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from sqlalchemy import text, func
from sqlmodel import Session, select

from ..config.loader import get_database_url
from ..db.database import get_engine
from ..db.models import (
    CalculationVersion,
    CalculationUnit,
    CostLot,
    RealizedPnl,
    PnlWarning,
    CalculationUnitLeg,
    ConsumedLotSlice,
    LotSettlement,
    CostLotEvent,
)


def get_draft_versions_stats(session: Session) -> dict:
    """
    Get statistics about draft versions and their children.
    
    Returns:
        Dictionary with counts of draft versions and related entities
    """
    # Count draft versions
    draft_versions = session.exec(
        select(CalculationVersion).where(CalculationVersion.status == "draft")
    ).all()
    
    version_ids = [v.version_id for v in draft_versions]
    
    if not version_ids:
        return {
            "draft_versions": 0,
            "calculation_units": 0,
            "cost_lots": 0,
            "realized_pnl": 0,
            "pnl_warnings": 0,
            "unit_legs": 0,
            "consumed_slices": 0,
            "lot_settlements": 0,
            "cost_lot_events": 0,
            "versions": [],
        }
    
    # Get calculation units for these versions
    units = session.exec(
        select(CalculationUnit).where(CalculationUnit.version_id.in_(version_ids))
    ).all()
    unit_ids = [u.id for u in units]
    
    # Get cost lots for these units
    cost_lots = []
    if unit_ids:
        cost_lots = session.exec(
            select(CostLot).where(CostLot.unit_id.in_(unit_ids))
        ).all()
    lot_ids = [lot.cost_lot_id for lot in cost_lots]
    
    # Count children
    realized_count = 0
    warning_count = 0
    leg_count = 0
    slice_count = 0
    settlement_count = 0
    event_count = 0
    
    if unit_ids:
        realized_count = session.exec(
            select(func.count(RealizedPnl.pnl_id)).where(RealizedPnl.origin_unit_id.in_(unit_ids))
        ).one()
        warning_count = session.exec(
            select(func.count(PnlWarning.id)).where(PnlWarning.unit_id.in_(unit_ids))
        ).one()
        leg_count = session.exec(
            select(func.count(CalculationUnitLeg.id)).where(CalculationUnitLeg.unit_id.in_(unit_ids))
        ).one()
    
    if lot_ids:
        slice_count = session.exec(
            select(func.count(ConsumedLotSlice.slice_id)).where(ConsumedLotSlice.cost_lot_id.in_(lot_ids))
        ).one()
        settlement_count = session.exec(
            select(func.count(LotSettlement.settlement_id)).where(
                LotSettlement.settling_lot_id.in_(lot_ids) | 
                LotSettlement.negative_lot_id.in_(lot_ids)
            )
        ).one()
        event_count = session.exec(
            select(func.count(CostLotEvent.event_id)).where(CostLotEvent.lot_id.in_(lot_ids))
        ).one()
    
    return {
        "draft_versions": len(draft_versions),
        "calculation_units": len(units),
        "cost_lots": len(cost_lots),
        "realized_pnl": realized_count,
        "pnl_warnings": warning_count,
        "unit_legs": leg_count,
        "consumed_slices": slice_count,
        "lot_settlements": settlement_count,
        "cost_lot_events": event_count,
        "versions": [
            {
                "version_id": v.version_id,
                "created_at": v.created_at,
                "expires_at": v.expires_at,
                "method": v.method,
                "description": v.description,
            }
            for v in draft_versions
        ],
    }


def delete_draft_versions(session: Session) -> int:
    """
    Delete all draft calculation versions.
    
    The CASCADE relationships in the model will automatically delete:
    - CalculationVersion → CalculationUnit (cascade)
    - CalculationUnit → CostLot, RealizedPnl, PnlWarning, CalculationUnitLeg (cascade)
    - CostLot → ConsumedLotSlice, LotSettlement, CostLotEvent (cascade)
    
    Returns:
        Number of draft versions deleted
    """
    # Find all draft versions
    draft_versions = session.exec(
        select(CalculationVersion).where(CalculationVersion.status == "draft")
    ).all()
    
    count = len(draft_versions)
    
    # Delete each version (cascade handles children)
    for version in draft_versions:
        session.delete(version)
    
    session.commit()
    return count


def main():
    parser = argparse.ArgumentParser(
        description="Delete all draft calculation versions and their children"
    )
    parser.add_argument(
        "--force", action="store_true", help="Skip confirmation prompt"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Show what would be deleted without deleting"
    )
    
    args = parser.parse_args()
    
    
    db_url = get_database_url()
    
    print(f"\n{'='*60}")
    print(f"DELETE DRAFT CALCULATION VERSIONS")
    print(f"Database: {db_url}")
    print(f"{'='*60}\n")
    
    engine = get_engine()
    
    with Session(engine) as session:
        # Get stats
        stats = get_draft_versions_stats(session)
        
        if stats["draft_versions"] == 0:
            print("✅ No draft versions found. Nothing to delete.")
            return
        
        # Display what will be deleted
        print(f"📊 Found {stats['draft_versions']} draft version(s) to delete:\n")
        
        for v in stats["versions"]:
            created = v["created_at"].strftime("%Y-%m-%d %H:%M:%S") if v["created_at"] else "N/A"
            expires = v["expires_at"].strftime("%Y-%m-%d %H:%M:%S") if v["expires_at"] else "Never"
            desc = v["description"] or "(no description)"
            print(f"  • Version {v['version_id']}: {v['method']} - {desc}")
            print(f"    Created: {created}, Expires: {expires}")
        
        print(f"\n📈 Cascade deletion will remove:")
        print(f"  • {stats['draft_versions']:,} CalculationVersion(s)")
        print(f"  • {stats['calculation_units']:,} CalculationUnit(s)")
        print(f"  • {stats['cost_lots']:,} CostLot(s)")
        print(f"  • {stats['realized_pnl']:,} RealizedPnl record(s)")
        print(f"  • {stats['pnl_warnings']:,} PnlWarning(s)")
        print(f"  • {stats['unit_legs']:,} CalculationUnitLeg(s)")
        print(f"  • {stats['consumed_slices']:,} ConsumedLotSlice(s)")
        print(f"  • {stats['lot_settlements']:,} LotSettlement(s)")
        print(f"  • {stats['cost_lot_events']:,} CostLotEvent(s)")
        
        if args.dry_run:
            print(f"\n🔍 DRY RUN - No changes made")
            return
        
        # Confirmation
        if not args.force:
            print(f"\n⚠️  This action is IRREVERSIBLE!")
            response = input(f"Type 'DELETE' to confirm: ")
            if response != "DELETE":
                print("❌ Aborted.")
                return
        
        # Delete
        print(f"\n🗑️  Deleting draft versions...")
        deleted = delete_draft_versions(session)
        print(f"✅ Successfully deleted {deleted} draft version(s) and all children.")


if __name__ == "__main__":
    main()
