#!/usr/bin/env python3
"""
Script to copy all data from test database to production database.

Usage:
    python scripts/copy_test_to_prod.py [--force]

This script will:
1. Dump all data from the test database
2. Empty the production database
3. Restore the test data into production

Options:
    --force  Skip confirmation prompt

⚠️ WARNING: This will REPLACE ALL DATA in the production database!
"""

import os
import sys
import subprocess
import argparse
from pathlib import Path
from dotenv import load_dotenv

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

# Load environment variables
load_dotenv(project_root / ".env")


def get_db_credentials():
    """Get database credentials from environment variables."""
    return {
        "user": os.getenv("POSTGRES_USER", "trades_user"),
        "password": os.getenv("POSTGRES_PASSWORD", "trades_password"),
        "host": os.getenv("POSTGRES_HOST", "localhost"),
        "prod_port": os.getenv("POSTGRES_PORT", "5432"),
        "test_port": os.getenv("POSTGRES_TEST_PORT", "5433"),
        "prod_db": os.getenv("POSTGRES_DB", "trades_db"),
        "test_db": os.getenv("POSTGRES_DB_TEST", "trades_db_test"),
    }


def run_command(cmd: list[str], env: dict = None, check: bool = True) -> subprocess.CompletedProcess:
    """Run a shell command with the given environment."""
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    
    result = subprocess.run(
        cmd,
        env=merged_env,
        capture_output=True,
        text=True,
    )
    
    if check and result.returncode != 0:
        print(f"❌ Command failed: {' '.join(cmd)}")
        print(f"   STDOUT: {result.stdout}")
        print(f"   STDERR: {result.stderr}")
        sys.exit(1)
    
    return result


def test_connection(creds: dict, is_test: bool) -> bool:
    """Test database connection."""
    port = creds["test_port"] if is_test else creds["prod_port"]
    db = creds["test_db"] if is_test else creds["prod_db"]
    db_type = "test" if is_test else "production"
    
    print(f"🔗 Testing connection to {db_type} database ({db}:{port})...")
    
    env = {"PGPASSWORD": creds["password"]}
    result = run_command(
        ["psql", "-h", creds["host"], "-p", port, "-U", creds["user"], "-d", db, "-c", "SELECT 1"],
        env=env,
        check=False
    )
    
    if result.returncode == 0:
        print(f"   ✅ Connection successful")
        return True
    else:
        print(f"   ❌ Connection failed: {result.stderr}")
        return False


def get_table_counts(creds: dict, is_test: bool) -> dict:
    """Get row counts for all tables."""
    port = creds["test_port"] if is_test else creds["prod_port"]
    db = creds["test_db"] if is_test else creds["prod_db"]
    
    env = {"PGPASSWORD": creds["password"]}
    
    # Get all table names
    result = run_command(
        ["psql", "-h", creds["host"], "-p", port, "-U", creds["user"], "-d", db, 
         "-t", "-c", "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"],
        env=env
    )
    
    tables = [t.strip() for t in result.stdout.strip().split("\n") if t.strip()]
    counts = {}
    
    for table in tables:
        result = run_command(
            ["psql", "-h", creds["host"], "-p", port, "-U", creds["user"], "-d", db,
             "-t", "-c", f"SELECT COUNT(*) FROM {table}"],
            env=env,
            check=False
        )
        if result.returncode == 0:
            counts[table] = int(result.stdout.strip())
    
    return counts


def dump_test_database(creds: dict, dump_file: Path) -> bool:
    """Dump the test database to a file."""
    print(f"\n📤 Dumping test database to {dump_file}...")
    
    env = {"PGPASSWORD": creds["password"]}
    
    result = run_command(
        [
            "pg_dump",
            "-h", creds["host"],
            "-p", creds["test_port"],
            "-U", creds["user"],
            "-d", creds["test_db"],
            "--data-only",  # Only dump data, not schema
            "--disable-triggers",  # Disable triggers during restore
            "-f", str(dump_file),
        ],
        env=env
    )
    
    if dump_file.exists():
        size = dump_file.stat().st_size
        print(f"   ✅ Dump created ({size / 1024:.1f} KB)")
        return True
    return False


def empty_prod_database(creds: dict) -> bool:
    """Empty all tables in the production database."""
    print(f"\n🗑️  Emptying production database...")
    
    env = {"PGPASSWORD": creds["password"]}
    
    # Get all tables
    result = run_command(
        ["psql", "-h", creds["host"], "-p", creds["prod_port"], "-U", creds["user"], 
         "-d", creds["prod_db"], "-t", "-c", 
         "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"],
        env=env
    )
    
    tables = [t.strip() for t in result.stdout.strip().split("\n") if t.strip()]
    
    if tables:
        # Truncate all tables with CASCADE
        tables_str = ", ".join(tables)
        run_command(
            ["psql", "-h", creds["host"], "-p", creds["prod_port"], "-U", creds["user"],
             "-d", creds["prod_db"], "-c", f"TRUNCATE TABLE {tables_str} RESTART IDENTITY CASCADE"],
            env=env
        )
        print(f"   ✅ Truncated {len(tables)} tables")
    
    return True


def restore_to_prod(creds: dict, dump_file: Path) -> bool:
    """Restore the dump file to the production database."""
    print(f"\n📥 Restoring data to production database...")
    
    env = {"PGPASSWORD": creds["password"]}
    
    result = run_command(
        [
            "psql",
            "-h", creds["host"],
            "-p", creds["prod_port"],
            "-U", creds["user"],
            "-d", creds["prod_db"],
            "-f", str(dump_file),
        ],
        env=env
    )
    
    print(f"   ✅ Data restored successfully")
    return True


def main():
    parser = argparse.ArgumentParser(description="Copy test database to production")
    parser.add_argument("--force", "-f", action="store_true", help="Skip confirmation prompt")
    args = parser.parse_args()
    
    print("=" * 60)
    print("🔄 TEST → PRODUCTION DATABASE COPY SCRIPT")
    print("=" * 60)
    
    # Get credentials
    creds = get_db_credentials()
    
    print(f"\n📋 Configuration:")
    print(f"   Host: {creds['host']}")
    print(f"   Test DB: {creds['test_db']} (port {creds['test_port']})")
    print(f"   Prod DB: {creds['prod_db']} (port {creds['prod_port']})")
    
    # Test connections
    if not test_connection(creds, is_test=True):
        print("\n❌ Cannot connect to test database. Is the container running?")
        print("   Run: docker compose up -d postgres_test")
        sys.exit(1)
    
    if not test_connection(creds, is_test=False):
        print("\n❌ Cannot connect to production database. Is the container running?")
        print("   Run: docker compose up -d postgres")
        sys.exit(1)
    
    # Show current state
    print("\n📊 Current table counts:")
    print("\n   TEST DATABASE:")
    test_counts = get_table_counts(creds, is_test=True)
    for table, count in sorted(test_counts.items()):
        print(f"      {table}: {count} rows")
    
    print("\n   PRODUCTION DATABASE:")
    prod_counts = get_table_counts(creds, is_test=False)
    for table, count in sorted(prod_counts.items()):
        print(f"      {table}: {count} rows")
    
    # Confirmation
    if not args.force:
        print("\n" + "=" * 60)
        print("⚠️  WARNING: This will REPLACE ALL DATA in production!")
        print("=" * 60)
        response = input("\nType 'yes' to continue: ")
        if response.lower() != "yes":
            print("\n❌ Aborted by user")
            sys.exit(0)
    
    # Create temp dump file
    dump_file = project_root / "data" / "temp_dump.sql"
    dump_file.parent.mkdir(parents=True, exist_ok=True)
    
    try:
        # Dump test database
        if not dump_test_database(creds, dump_file):
            sys.exit(1)
        
        # Empty production database
        if not empty_prod_database(creds):
            sys.exit(1)
        
        # Restore to production
        if not restore_to_prod(creds, dump_file):
            sys.exit(1)
        
        # Show final state
        print("\n📊 Final production table counts:")
        final_counts = get_table_counts(creds, is_test=False)
        for table, count in sorted(final_counts.items()):
            print(f"   {table}: {count} rows")
        
        print("\n" + "=" * 60)
        print("✅ SUCCESS: Test data copied to production!")
        print("=" * 60)
        
    finally:
        # Clean up dump file
        if dump_file.exists():
            dump_file.unlink()
            print(f"\n🧹 Cleaned up temporary dump file")


if __name__ == "__main__":
    main()
