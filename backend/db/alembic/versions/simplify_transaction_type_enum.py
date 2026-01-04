"""Simplify transaction_type to 3-value enum (trade, transfer, technical).

Revision ID: simplify_tx_type
Revises: add_account_ids_to_calculation_versions
Create Date: 2026-01-03

Migration transforms existing transaction_type values:
- 'acquisition' -> 'trade'
- 'disposal' -> 'trade'
- 'transfer' -> 'transfer'
- 'internal_transfer' -> 'transfer'
- 'technical' -> 'technical'
- NULL/empty with direction='inflow' or 'outflow' -> infer from context
- NULL/empty with zero quantity -> 'technical'
- Other NULL/empty -> 'transfer' (deposits/withdrawals most common case)
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'simplify_tx_type'
down_revision = 'c1d2e3f4g5h6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """
    Migrate transaction_type values to new 3-value enum.
    
    Old values -> New values:
    - 'acquisition' -> 'trade'
    - 'disposal' -> 'trade'
    - 'transfer', 'internal_transfer', 'transfer_in', 'transfer_out' -> 'transfer'
    - 'technical' -> 'technical'
    - NULL/empty -> inferred based on context
    """
    # Step 1: Migrate 'acquisition' and 'disposal' to 'trade'
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = 'trade' 
        WHERE transaction_type IN ('acquisition', 'disposal')
    """)
    
    # Step 2: Migrate transfer variants to 'transfer'
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = 'transfer' 
        WHERE transaction_type IN ('transfer', 'internal_transfer', 'transfer_in', 'transfer_out')
    """)
    
    # Step 3: Keep 'technical' as-is (no change needed)
    
    # Step 4: Handle NULL/empty values with zero quantity -> 'technical'
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = 'technical' 
        WHERE (transaction_type IS NULL OR transaction_type = '') 
          AND quantity = 0
    """)
    
    # Step 5: Handle NULL/empty values with buy/sell source_transaction_type -> 'trade'
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = 'trade' 
        WHERE (transaction_type IS NULL OR transaction_type = '') 
          AND source_transaction_type IN ('buy', 'sell')
    """)
    
    # Step 6: Handle remaining NULL/empty values -> 'transfer' (deposits, withdrawals, token transfers)
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = 'transfer' 
        WHERE transaction_type IS NULL OR transaction_type = ''
    """)
    
    # Step 7: Handle any other legacy values -> default to 'transfer'
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = 'transfer' 
        WHERE transaction_type NOT IN ('trade', 'transfer', 'technical')
    """)


def downgrade() -> None:
    """
    Revert to legacy transaction_type values.
    
    Note: This is a lossy downgrade - we cannot perfectly restore
    'acquisition' vs 'disposal' distinction without source_transaction_type.
    """
    # Revert 'trade' to 'acquisition' or 'disposal' based on direction
    op.execute("""
        UPDATE normalized_transactions 
        SET transaction_type = CASE 
            WHEN direction = 'inflow' THEN 'acquisition'
            WHEN direction = 'outflow' THEN 'disposal'
            ELSE 'acquisition'
        END
        WHERE transaction_type = 'trade'
    """)
    
    # 'transfer' and 'technical' remain unchanged
