"""convert_tags_to_jsonb

Revision ID: 4b74174f7a1f
Revises: 07d1751fb1e6
Create Date: 2026-01-29 00:51:03.279003

Converts Account.tags and Asset.tags from ARRAY(Text) to JSONB.
Transforms existing data from ["tag1", "tag2"] to [{"tag1": true}, {"tag2": true}].
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY, JSONB


# revision identifiers, used by Alembic.
revision: str = '4b74174f7a1f'
down_revision: Union[str, Sequence[str], None] = '07d1751fb1e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """
    Upgrade schema: Convert tags from ARRAY(Text) to JSONB.
    
    Transforms data from ["tag1", "tag2"] to [{"tag1": true}, {"tag2": true}].
    """
    # Add temporary columns for new JSONB format
    op.add_column('accounts', sa.Column('tags_jsonb', JSONB, nullable=True))
    op.add_column('assets', sa.Column('tags_jsonb', JSONB, nullable=True))
    
    # Migrate data: Convert array of strings to array of single-key objects
    # accounts: ["trading", "spot"] -> [{"trading": true}, {"spot": true}]
    op.execute("""
        UPDATE accounts
        SET tags_jsonb = (
            SELECT jsonb_agg(jsonb_build_object(tag, true))
            FROM unnest(tags) AS tag
        )
        WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
    """)
    
    # assets: ["defi", "ethereum"] -> [{"defi": true}, {"ethereum": true}]
    op.execute("""
        UPDATE assets
        SET tags_jsonb = (
            SELECT jsonb_agg(jsonb_build_object(tag, true))
            FROM unnest(tags) AS tag
        )
        WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
    """)
    
    # Drop old columns
    op.drop_column('accounts', 'tags')
    op.drop_column('assets', 'tags')
    
    # Rename new columns to original names
    op.alter_column('accounts', 'tags_jsonb', new_column_name='tags')
    op.alter_column('assets', 'tags_jsonb', new_column_name='tags')


def downgrade() -> None:
    """
    Downgrade schema: Convert tags from JSONB back to ARRAY(Text).
    
    Transforms data from [{"tag1": true}, {"tag2": true}] back to ["tag1", "tag2"].
    Loses values, keeps only keys.
    """
    # Add temporary columns for old ARRAY format
    op.add_column('accounts', sa.Column('tags_array', ARRAY(sa.Text), nullable=True))
    op.add_column('assets', sa.Column('tags_array', ARRAY(sa.Text), nullable=True))
    
    # Migrate data back: Extract keys from JSONB objects
    # [{"trading": true}, {"spot": true}] -> ["trading", "spot"]
    op.execute("""
        UPDATE accounts
        SET tags_array = (
            SELECT array_agg(key)
            FROM jsonb_array_elements(tags) AS elem,
                 jsonb_each(elem) AS kv(key, value)
        )
        WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
    """)
    
    op.execute("""
        UPDATE assets
        SET tags_array = (
            SELECT array_agg(key)
            FROM jsonb_array_elements(tags) AS elem,
                 jsonb_each(elem) AS kv(key, value)
        )
        WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
    """)
    
    # Drop JSONB columns
    op.drop_column('accounts', 'tags')
    op.drop_column('assets', 'tags')
    
    # Rename array columns back
    op.alter_column('accounts', 'tags_array', new_column_name='tags')
    op.alter_column('assets', 'tags_array', new_column_name='tags')
