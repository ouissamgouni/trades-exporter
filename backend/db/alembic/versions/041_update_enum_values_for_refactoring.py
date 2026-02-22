"""update enum values for refactoring

Revision ID: 041_update_enum_values
Revises: 040_rename_tags_to_sys_prefix
Create Date: 2026-02-02 12:00:00.000000

Updates:
- UnitPattern: TRANSFER -> INTERNAL_TRANSFER, PENDING_TRANSFER -> UNMATCHED_INTERNAL_TRANSFER
- TransactionType: TECHNICAL -> TRANSFER (external transfers)
- Note: INTERNAL_TRANSFER transaction_type is set by TransferDetector, not stored in old data

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '041_update_enum_values'
down_revision = '040_rename_tags_to_sys_prefix'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Update enum values in existing data."""
    
    # Check if tables exist before updating
    # Use bind to get connection for checking table existence
    conn = op.get_bind()
    
    # Update UnitPattern values in calculation_unit table if it exists
    if conn.dialect.has_table(conn, 'calculation_unit'):
        op.execute("""
            UPDATE calculation_unit 
            SET pattern = 'internal_transfer' 
            WHERE pattern = 'transfer'
        """)
        
        op.execute("""
            UPDATE calculation_unit 
            SET pattern = 'unmatched_internal_transfer' 
            WHERE pattern = 'pending_transfer'
        """)
    
    # Update TransactionType values in normalized_transaction table if it exists
    if conn.dialect.has_table(conn, 'normalized_transaction'):
        op.execute("""
            UPDATE normalized_transaction 
            SET transaction_type = 'transfer' 
            WHERE transaction_type = 'technical'
        """)
    
    # Update notes in cost_lot table if it exists
    if conn.dialect.has_table(conn, 'cost_lot'):
        op.execute("""
            UPDATE cost_lot 
            SET notes = 'Unmatched internal transfer (provisional FMV cost basis)'
            WHERE notes = 'Pending transfer (provisional FMV cost basis)'
        """)
    
    # Update warning_type in pnl_warnings table if it exists
    if conn.dialect.has_table(conn, 'pnl_warnings'):
        op.execute("""
            UPDATE pnl_warnings 
            SET warning_type = 'unmatched_internal_transfer'
            WHERE warning_type = 'pending_transfer'
        """)


def downgrade() -> None:
    """Revert enum values to old naming."""
    
    conn = op.get_bind()
    
    # Revert UnitPattern values if table exists
    if conn.dialect.has_table(conn, 'calculation_unit'):
        op.execute("""
            UPDATE calculation_unit 
            SET pattern = 'transfer' 
            WHERE pattern = 'internal_transfer'
        """)
        
        op.execute("""
            UPDATE calculation_unit 
            SET pattern = 'pending_transfer' 
            WHERE pattern = 'unmatched_internal_transfer'
        """)
    
    # Revert TransactionType values if table exists
    if conn.dialect.has_table(conn, 'normalized_transaction'):
        op.execute("""
            UPDATE normalized_transaction 
            SET transaction_type = 'technical' 
            WHERE transaction_type = 'transfer'
        """)
    
    # Revert notes in cost_lot table if it exists
    if conn.dialect.has_table(conn, 'cost_lot'):
        op.execute("""
            UPDATE cost_lot 
            SET notes = 'Pending transfer (provisional FMV cost basis)'
            WHERE notes = 'Unmatched internal transfer (provisional FMV cost basis)'
        """)
    
    # Revert warning_type in pnl_warnings table if it exists
    if conn.dialect.has_table(conn, 'pnl_warnings'):
        op.execute("""
            UPDATE pnl_warnings 
            SET warning_type = 'pending_transfer'
            WHERE warning_type = 'unmatched_internal_transfer'
        """)
