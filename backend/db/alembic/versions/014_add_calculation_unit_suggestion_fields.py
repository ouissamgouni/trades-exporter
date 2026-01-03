"""Add suggestion fields to bundles (CalculationUnit)

Revision ID: 014_add_calculation_unit_suggestion_fields
Revises: 013_cost_lots_cleanup
Create Date: 2025-01-15

Adds confidence and reason fields to support the unified CalculationUnit concept
where suggestions can be persisted with their metadata.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision = "014_add_calculation_unit_suggestion_fields"
down_revision = "013_cost_lots_cleanup"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    
    print("Adding suggestion fields to bundles (CalculationUnit)...")
    
    # Add confidence column if it doesn't exist
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'bundles' AND column_name = 'confidence'
    """))
    if not result.fetchone():
        connection.execute(text("""
            ALTER TABLE bundles 
            ADD COLUMN confidence FLOAT DEFAULT 0.5
        """))
        print("  - Added confidence column")
    else:
        print("  - confidence column already exists")
    
    # Add reason column if it doesn't exist
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'bundles' AND column_name = 'reason'
    """))
    if not result.fetchone():
        connection.execute(text("""
            ALTER TABLE bundles 
            ADD COLUMN reason TEXT
        """))
        print("  - Added reason column")
    else:
        print("  - reason column already exists")
    
    # Update pattern enum to include new values if needed
    # Check if SPLIT pattern exists
    result = connection.execute(text("""
        SELECT pattern FROM bundles WHERE pattern = 'SPLIT' LIMIT 1
    """))
    
    print("Suggestion fields added successfully!")


def downgrade() -> None:
    connection = op.get_bind()
    
    print("Removing suggestion fields from bundles...")
    
    # Remove confidence column
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'bundles' AND column_name = 'confidence'
    """))
    if result.fetchone():
        connection.execute(text("""
            ALTER TABLE bundles DROP COLUMN confidence
        """))
        print("  - Removed confidence column")
    
    # Remove reason column
    result = connection.execute(text("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'bundles' AND column_name = 'reason'
    """))
    if result.fetchone():
        connection.execute(text("""
            ALTER TABLE bundles DROP COLUMN reason
        """))
        print("  - Removed reason column")
    
    print("Suggestion fields removed!")
