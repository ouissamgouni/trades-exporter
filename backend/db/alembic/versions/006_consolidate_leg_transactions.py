"""consolidate leg transactions and clean up bundles

Revision ID: 006_consolidate_leg_transactions
Revises: 005_cleanup_unused_fields
Create Date: 2025-12-24

This migration:
1. Consolidates transactions that were split into legs (outflow, inflow, fee)
   back into single transactions
2. Cleans up all existing bundles and bundle-transaction associations
3. Resets transactions to pending status for fresh review

Strategy for leg consolidation:
- Identifies transactions with same source_transaction_id and source
- Keeps one "parent" transaction per group, deletes the others
- Accumulates fees from fee legs into the parent transaction
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = '006_consolidate_leg_transactions'
down_revision = '005_cleanup_unused_fields'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Consolidate leg transactions and clean up bundles."""
    
    connection = op.get_bind()
    
    # =========================================
    # STEP 1: Clean up all existing bundles
    # =========================================
    print("Step 1: Cleaning up existing bundles...")
    
    # Check if bundle_id column exists before trying to update
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'bundle_id'
    """))
    if result.fetchone():
        connection.execute(text("""
            UPDATE normalized_transactions
            SET bundle_id = NULL
            WHERE bundle_id IS NOT NULL
        """))
        print("  - Cleared bundle_id from all transactions")
    else:
        print("  - No bundle_id column exists (skipped)")
    
    # Check if bundle_transactions table exists
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'bundle_transactions'
    """))
    if result.fetchone():
        connection.execute(text("DELETE FROM bundle_transactions"))
        print("  - Deleted all bundle_transactions associations")
    else:
        print("  - No bundle_transactions table exists (skipped)")
    
    # Check if bundles table exists
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'bundles'
    """))
    if result.fetchone():
        result = connection.execute(text("DELETE FROM bundles"))
        print(f"  - Deleted {result.rowcount} bundles")
    else:
        print("  - No bundles table exists (skipped)")
    
    # =========================================
    # STEP 2: Consolidate leg transactions
    # =========================================
    print("\nStep 2: Consolidating leg transactions...")
    
    # Find transactions that share source_transaction_id and source
    # and occurred within 1 second of each other (likely legs)
    consolidation_query = text("""
        WITH potential_legs AS (
            SELECT 
                id,
                source,
                source_transaction_id,
                date_time,
                direction,
                quantity,
                fee,
                asset_id,
                ROW_NUMBER() OVER (
                    PARTITION BY source, source_transaction_id, 
                                 DATE_TRUNC('second', date_time)
                    ORDER BY 
                        CASE WHEN fee > 0 THEN 2 ELSE 1 END,  -- Fee transactions last
                        id
                ) as row_num,
                COUNT(*) OVER (
                    PARTITION BY source, source_transaction_id, 
                                 DATE_TRUNC('second', date_time)
                ) as group_count
            FROM normalized_transactions
            WHERE source_transaction_id IS NOT NULL
        ),
        legs_to_delete AS (
            SELECT id, source, source_transaction_id
            FROM potential_legs
            WHERE group_count > 1 AND row_num > 1
        ),
        parent_with_fees AS (
            SELECT 
                p.id as parent_id,
                COALESCE(SUM(l.fee), 0) as total_fees
            FROM potential_legs p
            LEFT JOIN legs_to_delete ltd ON 
                p.source = ltd.source AND 
                p.source_transaction_id = ltd.source_transaction_id
            LEFT JOIN normalized_transactions l ON l.id = ltd.id
            WHERE p.row_num = 1 AND p.group_count > 1
            GROUP BY p.id
        )
        SELECT parent_id, total_fees 
        FROM parent_with_fees 
        WHERE total_fees > 0
    """)

    
    result = connection.execute(consolidation_query)
    parents_with_fees = result.fetchall()
    
    # Update parent transactions with accumulated fees
    for parent_id, total_fees in parents_with_fees:
        connection.execute(
            text("""
                UPDATE normalized_transactions
                SET fee = COALESCE(fee, 0) + :total_fees,
                    include_fee = TRUE
                WHERE id = :parent_id
            """),
            {"parent_id": parent_id, "total_fees": total_fees}
        )
    
    # Delete the leg transactions
    delete_query = text("""
        WITH potential_legs AS (
            SELECT 
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY source, source_transaction_id, 
                                 DATE_TRUNC('second', date_time)
                    ORDER BY 
                        CASE WHEN fee > 0 THEN 2 ELSE 1 END,
                        id
                ) as row_num,
                COUNT(*) OVER (
                    PARTITION BY source, source_transaction_id, 
                                 DATE_TRUNC('second', date_time)
                ) as group_count
            FROM normalized_transactions
            WHERE source_transaction_id IS NOT NULL
        )
        DELETE FROM normalized_transactions
        WHERE id IN (
            SELECT id 
            FROM potential_legs 
            WHERE group_count > 1 AND row_num > 1
        )
    """)
    
    result = connection.execute(delete_query)
    deleted_count = result.rowcount
    
    print(f"  - Consolidated {deleted_count} leg transactions into parent transactions")
    
    # =========================================
    # STEP 3: Reset all transactions to pending
    # =========================================
    print("\nStep 3: Resetting transaction statuses...")
    
    # Check if status column exists
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'status'
    """))
    if result.fetchone():
        result = connection.execute(text("""
            UPDATE normalized_transactions
            SET status = 'pending'
            WHERE status != 'pending'
        """))
        print(f"  - Reset {result.rowcount} transactions to pending status")
    else:
        print("  - No status column exists (skipped)")
    
    print("\n✅ Migration complete! All transactions are now ready for fresh review.")


def downgrade() -> None:
    """Cannot reverse this consolidation."""
    # This migration is not reversible as we're deleting data
    # If you need to reverse, restore from backup
    pass
