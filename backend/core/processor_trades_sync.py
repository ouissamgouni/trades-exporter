"""
Processor for trade_sync objects from connectors.
Enriches trade_sync objects with EUR prices at transaction datetime and inserts into database.
Similar to processor.py but works directly with connector data (no expand_trade needed).
"""

import sqlite3
import pandas as pd
from backend.services.price_service import get_price
from backend.config.loader import configure_logging, load_asset_map

log = configure_logging("processor_trades_sync")


def enrich_trade_sync(trade_sync):
    """
    Enrich a trade_sync object with EUR prices at transaction datetime and fee conversions.

    Args:
        trade_sync (dict): Trade_sync dict with keys: transaction_id, exchange, datetime, type, asset_code,
                          asset_pair, qty, price, quote, total, fee, fee_quote, tags.

    Returns:
        dict or None: Enriched trade_sync dict with price_eur and fee_eur added, or None if enrichment fails.
    """
    try:
        asset = trade_sync.get("asset_code")
        quote = trade_sync.get("quote", "")
        fee_quote = trade_sync.get("fee_quote", "")
        fee = trade_sync.get("fee", 0)
        qty = trade_sync.get("qty", 0)
        dt = trade_sync.get("datetime")

        # Validate asset exists in asset_map
        if asset:
            asset_map = load_asset_map()
            if asset not in asset_map:
                error_msg = f"Asset '{asset}' not found in asset_map"
                log.error(error_msg)
                raise ValueError(error_msg)
        else:
            error_msg = "Missing asset_code in trade_sync"
            log.error(error_msg)
            raise ValueError(error_msg)

        # Price and total in EUR - use price at transaction datetime
        if quote.upper() == "EUR":
            price_eur = trade_sync.get("price", 0)
        else:
            # Get price for the asset at transaction datetime
            try:
                price_eur = get_price(asset, dt)
            except RuntimeError as e:
                log.error(f"Failed to get price for {asset} at {dt}: {e}")
                return None

        total_eur = qty * price_eur

        # Fee in EUR
        if fee_quote.upper() == "EUR":
            fee_eur = fee
        elif fee and fee_quote:
            try:
                fee_price = get_price(fee_quote, dt)
                fee_eur = fee * fee_price
            except RuntimeError:
                log.warning(
                    f"Could not get fee price for {fee_quote} at {dt}, setting fee_eur to 0"
                )
                fee_eur = 0
        else:
            fee_eur = 0

        # Enriched trade_sync with EUR prices
        enriched = trade_sync.copy()
        enriched["price_eur"] = price_eur
        enriched["total_eur"] = total_eur
        enriched["fee_eur"] = fee_eur

        return enriched

    except Exception as e:
        log.exception(
            f"❌ Failed to enrich trade_sync {trade_sync.get('transaction_id', 'unknown')}: {e}"
        )
        return None


def process_trades_sync(trade_syncs, db_path=None, force_rewrite=False):
    """
    Process trade_sync objects: enrich with EUR prices and store in DB.

    Args:
        trade_syncs (list): List of trade_sync dicts from connectors.
        db_path (str, optional): Path to SQLite DB. If None, uses default from settings.
        force_rewrite (bool): If True, overwrite existing trades by transaction_id+exchange.

    Returns:
        tuple: (enriched_df, failed_df, stats)
            - enriched_df: DataFrame of successfully processed trades
            - failed_df: DataFrame of failed trades with failure reasons
            - stats: Dict with counts {added, replaced, skipped, failed}
    """
    from backend.core.trade_sync_db import TradeSyncDB
    from backend.config.loader import load_settings

    # --- Use provided db_path or get from settings ---
    if db_path is None:
        settings = load_settings()
        db_path = settings.get("database_path", "data/trades.db")

    enriched_rows = []
    failed_rows = []

    # Counters for reporting
    count_added = 0
    count_replaced = 0
    count_skipped = 0
    count_failed = 0

    with TradeSyncDB(db_path) as db:
        for trade_sync in trade_syncs:
            try:
                # Step 1: Enrich with EUR prices and fees
                enriched = enrich_trade_sync(trade_sync)
                if enriched is None:
                    # Enrichment failed
                    count_failed += 1
                    r = trade_sync.copy()
                    r["failure_reason"] = "Failed to enrich with EUR prices"
                    failed_rows.append(r)
                    continue

                transaction_id = enriched.get("transaction_id")
                db_exchange = enriched.get("exchange")

                # Step 2: Check if trade already exists
                exists = db.exists_trade(transaction_id, db_exchange)

                if exists and not force_rewrite:
                    # Skip duplicate
                    count_skipped += 1
                    log.debug(
                        f"⏭️  Skipped duplicate trade: {enriched['asset_code']} {enriched['type']} "
                        f"x{enriched['qty']} ({db_exchange})"
                    )
                    continue

                # Step 3: Insert or replace
                try:
                    if exists and force_rewrite:
                        # Replace existing
                        replaced = db.replace_trade(enriched)
                        if replaced:
                            count_replaced += 1
                            enriched_rows.append(enriched)
                            log.info(
                                f"🔄 Replaced trade: {enriched['asset_code']} {enriched['type']} "
                                f"x{enriched['qty']} @ {enriched['price_eur']:.2f}€ ({db_exchange})"
                            )
                        else:
                            count_failed += 1
                            r = enriched.copy()
                            r["failure_reason"] = "replace_trade2 returned False"
                            failed_rows.append(r)
                            log.error(f"❌ Failed to replace trade {transaction_id}")
                    else:
                        # Insert new
                        inserted = db.insert_trade(enriched)
                        if inserted:
                            count_added += 1
                            enriched_rows.append(enriched)
                            log.info(
                                f"✅ Added trade: {enriched['asset_code']} {enriched['type']} "
                                f"x{enriched['qty']} @ {enriched['price_eur']:.2f}€ ({db_exchange})"
                            )
                        else:
                            count_failed += 1
                            r = enriched.copy()
                            r["failure_reason"] = "insert_trade returned False"
                            failed_rows.append(r)
                            log.error(f"❌ Failed to insert trade {transaction_id}")

                except sqlite3.IntegrityError as e:
                    count_failed += 1
                    r = enriched.copy()
                    r["failure_reason"] = f"IntegrityError: {e}"
                    failed_rows.append(r)
                    log.exception(f"❌ IntegrityError inserting/replacing trade: {e}")

            except Exception as e:
                count_failed += 1
                r = trade_sync.copy()
                r["failure_reason"] = str(e)
                failed_rows.append(r)
                log.exception(f"❌ Unexpected error processing trade_sync: {e}")

    enriched_df = pd.DataFrame(enriched_rows) if enriched_rows else pd.DataFrame()
    failed_df = pd.DataFrame(failed_rows) if failed_rows else pd.DataFrame()

    stats = {
        "added": count_added,
        "replaced": count_replaced,
        "skipped": count_skipped,
        "failed": count_failed,
    }

    return enriched_df, failed_df, stats
