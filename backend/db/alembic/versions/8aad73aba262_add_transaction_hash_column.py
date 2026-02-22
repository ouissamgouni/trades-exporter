"""add_transaction_hash_column

Revision ID: 8aad73aba262
Revises: c25306085d6e
Create Date: 2026-01-21 20:01:31.677442

"""
from typing import Sequence, Union
import hashlib
from decimal import Decimal, ROUND_DOWN

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text


# revision identifiers, used by Alembic.
revision: str = '8aad73aba262'
down_revision: Union[str, Sequence[str], None] = 'c25306085d6e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def compute_transaction_hash(
    account_id: int,
    datetime_str: str,
    source_asset_symbol: str,
    source_price_quote_asset_symbol: str,
    direction: str,
    quantity: Decimal,
    price: Decimal,
) -> str:
    """
    Compute transaction hash for duplicate detection.
    This is a copy of the function from duplicate_detection_service.py
    to ensure the migration is self-contained and reproducible.
    """
    # Normalize symbols to uppercase
    base_normalized = source_asset_symbol.upper() if source_asset_symbol else ""
    quote_normalized = source_price_quote_asset_symbol.upper() if source_price_quote_asset_symbol else ""
    direction_normalized = direction.lower() if direction else ""
    
    # Format numbers with fixed precision (8 decimals)
    qty_decimal = Decimal(str(quantity)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    price_decimal = Decimal(str(price or 0)).quantize(Decimal("0.00000001"), rounding=ROUND_DOWN)
    
    # Build unique string
    unique_str = f"{account_id}_{datetime_str}_{base_normalized}_{quote_normalized}_{direction_normalized}_{qty_decimal}_{price_decimal}"
    
    # Generate MD5 hash
    return hashlib.md5(unique_str.encode()).hexdigest()


def upgrade() -> None:
    """Upgrade schema: Add transaction_hash column and backfill existing data."""
    
    # Step 1: Add transaction_hash column (nullable initially)
    op.add_column(
        'normalized_transactions',
        sa.Column('transaction_hash', sa.String(length=64), nullable=True)
    )
    
    # Step 2: Backfill transaction_hash for existing transactions
    connection = op.get_bind()
    
    # Query all transactions that need hashing
    result = connection.execute(text("""
        SELECT 
            id,
            account_id,
            to_char(date_time, 'YYYY-MM-DD"T"HH24:MI:SS') as datetime_str,
            source_asset_symbol,
            source_price_quote_asset_symbol,
            direction,
            quantity,
            COALESCE(price, 0) as price
        FROM normalized_transactions
        WHERE transaction_hash IS NULL
        ORDER BY id
    """))
    
    # Process in batches to avoid memory issues
    batch_size = 1000
    updates = []
    
    for row in result:
        try:
            tx_hash = compute_transaction_hash(
                account_id=row.account_id,
                datetime_str=row.datetime_str,
                source_asset_symbol=row.source_asset_symbol or "",
                source_price_quote_asset_symbol=row.source_price_quote_asset_symbol or "",
                direction=row.direction or "",
                quantity=Decimal(str(row.quantity)),
                price=Decimal(str(row.price or 0)),
            )
            updates.append({'tx_id': row.id, 'tx_hash': tx_hash})
            
            # Execute batch update
            if len(updates) >= batch_size:
                connection.execute(
                    text("""
                        UPDATE normalized_transactions
                        SET transaction_hash = :tx_hash
                        WHERE id = :tx_id
                    """),
                    updates
                )
                updates = []
        except Exception as e:
            print(f"Warning: Could not compute hash for transaction {row.id}: {e}")
            # Set a placeholder hash for problematic transactions
            updates.append({'tx_id': row.id, 'tx_hash': 'error'})
    
    # Execute remaining updates
    if updates:
        connection.execute(
            text("""
                UPDATE normalized_transactions
                SET transaction_hash = :tx_hash
                WHERE id = :tx_id
            """),
            updates
        )
    
    # Step 3: Create index on transaction_hash
    op.create_index(
        'ix_normalized_transactions_transaction_hash',
        'normalized_transactions',
        ['transaction_hash'],
        unique=False
    )


def downgrade() -> None:
    """Downgrade schema: Remove transaction_hash column."""
    op.drop_index('ix_normalized_transactions_transaction_hash', table_name='normalized_transactions')
    op.drop_column('normalized_transactions', 'transaction_hash')

