import os
import sys
from pathlib import Path
from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool
from alembic import context

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from backend.config.loader import get_database_url
from backend.db.models import SQLModel  # Import all models

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Check for test_mode flag: alembic -x test_mode=true upgrade head
x_args = context.get_x_argument(as_dictionary=True)
test_mode = (
    x_args.get("test_mode") == "true" or os.getenv("TEST_MODE") == "1"
)

# Override sqlalchemy.url with our dynamic database URL
database_url = get_database_url(test_mode=test_mode)
config.set_main_option("sqlalchemy.url", database_url)

print(
    f"[Alembic] Using database: {'TEST' if test_mode else 'PROD'} - {database_url.split('@')[-1]}"
)

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Set target metadata for autogenerate support
target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
