"""change tags column from JSON to JSONB

Revision ID: 039_change_tags_to_jsonb
Revises: 038_add_file_imports
Create Date: 2026-01-26

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision: str = '039_change_tags_to_jsonb'
down_revision: Union[str, Sequence[str], None] = '038_add_file_imports'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Change tags column from JSON to JSONB for proper array handling."""
    # Change column type from JSON to JSONB
    # USING clause ensures data is converted properly
    op.execute("""
        ALTER TABLE normalized_transactions 
        ALTER COLUMN tags TYPE JSONB 
        USING tags::jsonb
    """)


def downgrade() -> None:
    """Revert tags column from JSONB back to JSON."""
    op.execute("""
        ALTER TABLE normalized_transactions 
        ALTER COLUMN tags TYPE JSON 
        USING tags::json
    """)
