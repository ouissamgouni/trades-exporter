"""Fix legtype enum values to lowercase

Revision ID: 037_fix_legtype_lowercase
Revises: 036_drop_event_metadata
Create Date: 2026-01-15

The PostgreSQL enum 'legtype' was created with uppercase values (INFLOW, OUTFLOW, FEE)
but the Python enum uses lowercase values. This migration renames the enum values
to lowercase to match the Python code.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '037_fix_legtype_lowercase'
down_revision: Union[str, None] = 'add_content_hash_column'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Rename legtype enum values from uppercase to lowercase and update existing data."""
    connection = op.get_bind()
    
    # Check current enum values
    result = connection.execute(sa.text(
        "SELECT enumlabel FROM pg_enum e "
        "JOIN pg_type t ON e.enumtypid = t.oid "
        "WHERE t.typname = 'legtype'"
    ))
    current_values = [row[0] for row in result]
    
    # Only rename if uppercase values exist
    if 'INFLOW' in current_values:
        connection.execute(sa.text("ALTER TYPE legtype RENAME VALUE 'INFLOW' TO 'inflow'"))
    if 'OUTFLOW' in current_values:
        connection.execute(sa.text("ALTER TYPE legtype RENAME VALUE 'OUTFLOW' TO 'outflow'"))
    if 'FEE' in current_values:
        connection.execute(sa.text("ALTER TYPE legtype RENAME VALUE 'FEE' TO 'fee'"))
    
    # Update existing data: convert column to text, lowercase all values, convert back
    connection.execute(sa.text("ALTER TABLE calculation_unit_legs ALTER COLUMN leg_type TYPE text"))
    connection.execute(sa.text("UPDATE calculation_unit_legs SET leg_type = LOWER(leg_type)"))
    connection.execute(sa.text("ALTER TABLE calculation_unit_legs ALTER COLUMN leg_type TYPE legtype USING leg_type::legtype"))


def downgrade() -> None:
    """Rename legtype enum values from lowercase back to uppercase."""
    connection = op.get_bind()
    
    # Check current enum values
    result = connection.execute(sa.text(
        "SELECT enumlabel FROM pg_enum e "
        "JOIN pg_type t ON e.enumtypid = t.oid "
        "WHERE t.typname = 'legtype'"
    ))
    current_values = [row[0] for row in result]
    
    # Only rename if lowercase values exist
    if 'inflow' in current_values:
        connection.execute(sa.text("ALTER TYPE legtype RENAME VALUE 'inflow' TO 'INFLOW'"))
    if 'outflow' in current_values:
        connection.execute(sa.text("ALTER TYPE legtype RENAME VALUE 'outflow' TO 'OUTFLOW'"))
    if 'fee' in current_values:
        connection.execute(sa.text("ALTER TYPE legtype RENAME VALUE 'fee' TO 'FEE'"))
