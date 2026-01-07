#!/usr/bin/env python3
"""
Script to clean up data from CSV import source.
Deletes transactions, raw accounts, and raw assets from the trades_csv_import source.

Usage (from project root):
    backend/.venv/bin/python -m backend.scripts.cleanup_csv_import
"""

from sqlmodel import Session, delete

from backend.db.database import get_engine
from backend.db.models import NormalizedTransaction, RawAsset, RawAccount
from backend.file_loaders.trades_csv_loader import SOURCE_IDENTIFIER


def cleanup():
    engine = get_engine()
    with Session(engine) as session:
        # Delete transactions from CSV import
        stmt = delete(NormalizedTransaction).where(
            NormalizedTransaction.source == SOURCE_IDENTIFIER
        )
        result = session.exec(stmt)
        print(f"Deleted {result.rowcount} transactions from source: {SOURCE_IDENTIFIER}")

        # Delete raw accounts from CSV import
        stmt = delete(RawAccount).where(RawAccount.source == SOURCE_IDENTIFIER)
        result = session.exec(stmt)
        print(f"Deleted {result.rowcount} raw accounts from source: {SOURCE_IDENTIFIER}")

        # Delete raw assets from CSV import
        stmt = delete(RawAsset).where(RawAsset.source == SOURCE_IDENTIFIER)
        result = session.exec(stmt)
        print(f"Deleted {result.rowcount} raw assets from source: {SOURCE_IDENTIFIER}")

        session.commit()
        print("Database cleaned up successfully!")


if __name__ == "__main__":
    cleanup()
