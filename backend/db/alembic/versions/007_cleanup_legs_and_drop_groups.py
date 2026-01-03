"""cleanup leg transactions and drop groups tables

Revision ID: 007_cleanup_legs_and_drop_groups
Revises: 006_consolidate_leg_transactions
Create Date: 2025-12-24

This migration:
1. Properly consolidates leg transactions (with _cost, _fee, _proceeds suffixes)
   back into single parent transactions
2. Drops the groups and group_members tables which are no longer used
3. Removes group_id columns from related tables
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision = '007_cleanup_legs_and_drop_groups'
down_revision = '006_consolidate_leg_transactions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Consolidate leg transactions and drop unused tables."""
    
    connection = op.get_bind()
    
    # =========================================
    # STEP 1: Consolidate leg transactions
    # =========================================
    print("Step 1: Consolidating leg transactions...")
    
    # Find all leg transactions (those with _cost, _fee, _proceeds suffixes)
    leg_query = text("""
        SELECT id, source_transaction_id, fee, quantity, direction
        FROM normalized_transactions
        WHERE source_transaction_id LIKE '%\\_cost'
           OR source_transaction_id LIKE '%\\_fee'
           OR source_transaction_id LIKE '%\\_proceeds'
    """)
    
    result = connection.execute(leg_query)
    legs = result.fetchall()
    
    if legs:
        print(f"  Found {len(legs)} leg transactions to consolidate")
        
        # Group legs by parent transaction ID (remove suffix)
        leg_groups = {}
        for leg_id, source_tx_id, fee, quantity, direction in legs:
            # Extract parent ID by removing suffix
            if source_tx_id.endswith('_cost'):
                parent_id = source_tx_id[:-5]
            elif source_tx_id.endswith('_fee'):
                parent_id = source_tx_id[:-4]
            elif source_tx_id.endswith('_proceeds'):
                parent_id = source_tx_id[:-9]
            else:
                continue
            
            if parent_id not in leg_groups:
                leg_groups[parent_id] = []
            leg_groups[parent_id].append({
                'id': leg_id,
                'source_tx_id': source_tx_id,
                'fee': fee,
                'quantity': quantity,
                'direction': direction
            })
        
        # For each parent, update fees if needed and delete legs
        legs_deleted = 0
        for parent_source_id, leg_list in leg_groups.items():
            # Find the parent transaction
            parent_result = connection.execute(text("""
                SELECT id, fee FROM normalized_transactions 
                WHERE source_transaction_id = :parent_id
            """), {"parent_id": parent_source_id})
            parent = parent_result.fetchone()
            
            if parent:
                parent_db_id, current_fee = parent
                
                # Sum up fees from fee legs
                total_leg_fees = sum(
                    float(leg['quantity'] or 0) 
                    for leg in leg_list 
                    if leg['source_tx_id'].endswith('_fee')
                )
                
                if total_leg_fees > 0:
                    # Add leg fees to parent's fee
                    new_fee = float(current_fee or 0) + total_leg_fees
                    connection.execute(text("""
                        UPDATE normalized_transactions
                        SET fee = :new_fee, include_fee = TRUE
                        WHERE id = :parent_id
                    """), {"new_fee": new_fee, "parent_id": parent_db_id})
            
            # Delete all leg transactions
            leg_ids = [leg['id'] for leg in leg_list]
            connection.execute(text("""
                DELETE FROM normalized_transactions
                WHERE id = ANY(:leg_ids)
            """), {"leg_ids": leg_ids})
            legs_deleted += len(leg_ids)
        
        print(f"  - Deleted {legs_deleted} leg transactions")
    else:
        print("  No leg transactions found (already consolidated)")
    
    # =========================================
    # STEP 2: Reset all transactions to pending (if status column exists)
    # =========================================
    print("\nStep 2: Resetting transaction statuses...")
    
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
        print("  - status column does not exist (skipped)")
    
    # =========================================
    # STEP 3: Drop groups-related tables and columns using CASCADE
    # =========================================
    print("\nStep 3: Dropping groups-related tables and columns...")
    
    # Drop tables using CASCADE to handle all dependencies automatically
    # This will drop foreign key constraints and any dependent objects
    
    # Drop group_members table
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'group_members' AND table_schema = 'public'
    """))
    if result.fetchone():
        connection.execute(text("DROP TABLE IF EXISTS group_members CASCADE"))
        print("  - Dropped group_members table")
    
    # Drop groups table (CASCADE will remove all FK constraints pointing to it)
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'groups' AND table_schema = 'public'
    """))
    if result.fetchone():
        connection.execute(text("DROP TABLE IF EXISTS groups CASCADE"))
        print("  - Dropped groups table (CASCADE removed dependent constraints)")
    
    # Now remove the orphaned group_id columns from tables
    tables_with_group_id = ['normalized_transactions', 'cost_lots', 'realized_pnl']
    for table_name in tables_with_group_id:
        result = connection.execute(text(f"""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = '{table_name}' AND column_name = 'group_id'
        """))
        if result.fetchone():
            connection.execute(text(f"ALTER TABLE {table_name} DROP COLUMN IF EXISTS group_id"))
            print(f"  - Dropped group_id column from {table_name}")
    
    # =========================================
    # STEP 4: Clean up bundles tables if they exist
    # =========================================
    print("\nStep 4: Cleaning up bundles tables...")
    
    # Drop bundle_transactions table
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'bundle_transactions' AND table_schema = 'public'
    """))
    if result.fetchone():
        connection.execute(text("DROP TABLE IF EXISTS bundle_transactions CASCADE"))
        print("  - Dropped bundle_transactions table")
    
    # Remove bundle_id column from normalized_transactions if it exists
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'normalized_transactions' AND column_name = 'bundle_id'
    """))
    if result.fetchone():
        connection.execute(text("ALTER TABLE normalized_transactions DROP COLUMN IF EXISTS bundle_id"))
        print("  - Dropped bundle_id column from normalized_transactions")
    
    # Drop bundles table
    result = connection.execute(text("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'bundles' AND table_schema = 'public'
    """))
    if result.fetchone():
        connection.execute(text("DROP TABLE IF EXISTS bundles CASCADE"))
        print("  - Dropped bundles table")
    
    print("\n✅ Migration complete!")


def downgrade() -> None:
    """Recreate dropped tables (empty)."""
    
    # Recreate groups table
    op.create_table(
        'groups',
        sa.Column('group_id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(100), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now()),
    )
    
    # Recreate group_members table
    op.create_table(
        'group_members',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('group_id', sa.Integer(), sa.ForeignKey('groups.group_id')),
        sa.Column('transaction_id', sa.Integer(), sa.ForeignKey('normalized_transactions.id')),
    )
    
    # Note: Cannot restore deleted leg transactions or dropped columns
