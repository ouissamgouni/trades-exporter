import pandas as pd
import sqlite3
from backend.services.price_service import get_price
from backend.config.loader import load_asset_map, configure_logging

log = configure_logging("processor")


def expand_trade(row, exchange):
    """
    Expand a single trade row into one or two operations depending on EUR involvement.
    Uses 'type' column to compute side. Skips EUR-as-base rows.
    Adds asset_full_name using asset_map.
    Returns list of dicts.
    """
    if row["exchange"].upper() == "OKX" and row.get("base") == "BTC":
        log.debug("Debugging OKX BTC trade row:")

    asset_map = load_asset_map()

    base, quote = row["base"].upper(), row["quote"].upper()
    type_ = (row.get("type") or "").lower()
    qty, total, price = row["quantity"], row["total"], row["price"]
    fee_value, fee_quote = row.get("fee", 0), row.get("fee_quote")
    dt = row["datetime"]

    ops = []

    def make_op(op_type, asset, quantity, tags=None):
        if not op_type:
            raise ValueError(f"Operation type is empty for asset '{asset}'")
        if asset not in asset_map:
            raise ValueError(f"Asset '{asset}' not found in asset_map")
        asset_full_name = f"{asset_map[asset].get('name', asset)} ({asset})"
        return {
            "datetime": dt,
            "type": op_type,
            "asset_code": asset,
            "asset_full_name": asset_full_name,
            "quantity": quantity,
            "price": price,
            "quote": quote,
            "total": total,
            "fee": fee_value,
            "fee_quote": fee_quote,
            "exchange": exchange,
            "tags": tags or {},
        }

    if base == "EUR":
        op_type = "sell" if type_ == "buy" else "buy"
        ops.append(make_op(op_type, quote, total))
    elif quote == "EUR":
        ops.append(make_op(type_, base, qty))
    else:
        # Non-EUR pair, treat as swap
        tags = {"type": "swap"}
        if type_ == "buy":
            ops.append(make_op("sell", quote, total, tags))
            ops.append(make_op("buy", base, qty, tags))
        else:
            ops.append(make_op("sell", base, qty, tags))
            ops.append(make_op("buy", quote, total, tags))

    return ops


def enrich_prices(ops, db):
    """
    Enrich a list of trade operations with EUR prices and fee conversions.
    Optimized: if quote is EUR, price_eur = price and total_eur = total
              if fee_quote is EUR, fee_eur = fee

    Args:
        ops (list): List of operation dicts from expand_trade.
        db (TradeDB): TradeDB instance for price lookups.

    Returns:
        list: List of enriched operation dicts (failed rows logged but not returned).
    """
    asset_map = load_asset_map()
    enriched_rows = []

    for op in ops:
        try:
            dt = pd.to_datetime(op["datetime"])
            asset, fee_asset = op["asset_code"], op.get("fee_quote")
            qty, fee = op["quantity"], op.get("fee", 0)
            quote = op["quote"].upper()

            # Price and total in EUR
            # Check if price_eur already exists in the operation (pre-computed)
            if "price_eur" in op and op["price_eur"] is not None:
                price_eur = op["price_eur"]
            elif quote == "EUR":
                price_eur = op["price"]
            else:
                price_eur = get_price(asset, dt)

            total_eur = qty * price_eur

            # Fee in EUR
            if fee_asset and fee_asset.upper() == "EUR":
                fee_eur = fee
            elif fee and fee_asset:
                fee_eur = fee * get_price(fee_asset, dt)
            else:
                fee_eur = 0

            enriched_row = {
                "date_time": dt,
                "exchange": op["exchange"],
                "type": op["type"],
                "asset_code": op["asset_code"],
                "asset_name": op["asset_full_name"],
                "quantity": qty,
                "price": op["price"],
                "quote": quote,
                "price_eur": price_eur,
                "total": op["total"],
                "total_eur": total_eur,
                "fee": fee,
                "fee_quote": fee_asset,
                "fee_eur": fee_eur,
                "tags": op.get("tags", {}),
            }
            enriched_rows.append(enriched_row)

        except Exception as e:
            log.exception(f"❌ Failed to enrich operation: {e}")

    return enriched_rows


def process_trades(df, exchange, db_path=None, force_rewrite=False):
    """
    Process trades: expand, enrich, and store in DB.

    Args:
        df (pd.DataFrame): Input trades.
        exchange (str): Exchange name.
        db_path (str, optional): Path to SQLite DB. If None, uses default from settings.
        force_rewrite (bool): If True, overwrite existing trades.

    Returns:
        tuple: (enriched_df, failed_df)
    """
    from backend.core.trade_db import TradeDB
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

    with TradeDB(db_path) as db:
        for _, row in df.iterrows():
            # Step 1: Expand trade by quote currency
            expanded = expand_trade(row, exchange)

            # Step 2: Enrich with EUR prices and fees
            enriched_rows_batch = enrich_prices(expanded, db)

            # Step 3: Insert into DB
            for enriched_row in enriched_rows_batch:
                try:
                    # First try a normal INSERT. Will raise IntegrityError for duplicates.
                    success = db.insert_trade(enriched_row)
                    if success:
                        count_added += 1
                        enriched_rows.append(enriched_row)
                        log.info(
                            f"✅ Added trade: {enriched_row['asset_code']} {enriched_row['type']} x{enriched_row['quantity']} @ {enriched_row['price_eur']:.2f}€ ({enriched_row['exchange']})"
                        )

                except sqlite3.IntegrityError as e:
                    # Check if it's a UNIQUE constraint violation (duplicate)
                    if "UNIQUE constraint failed" in str(e):
                        # Duplicate detected. If force_rewrite is requested, replace it.
                        if force_rewrite:
                            try:
                                replaced = db.replace_trade(enriched_row)
                                if replaced:
                                    count_replaced += 1
                                    enriched_rows.append(enriched_row)
                                    log.info(
                                        f"🔄 Replaced trade: {enriched_row['asset_code']} {enriched_row['type']} x{enriched_row['quantity']} @ {enriched_row['price_eur']:.2f}€ ({enriched_row['exchange']})"
                                    )
                                else:
                                    # Unexpected: replace didn't report insertion
                                    count_failed += 1
                                    r = enriched_row.copy()
                                    r["failure_reason"] = (
                                        "replace_trade did not insert/replace row"
                                    )
                                    failed_rows.append(r)
                                    log.error(
                                        f"❌ Failed to replace trade: replace_trade returned False"
                                    )
                            except Exception as ex:
                                log.exception(
                                    f"❌ Failed to replace duplicate trade: {ex}"
                                )
                                r = enriched_row.copy()
                                r["failure_reason"] = str(ex)
                                failed_rows.append(r)
                                count_failed += 1
                        else:
                            count_skipped += 1
                            log.debug(
                                f"⏭️  Skipped duplicate trade: {enriched_row['asset_code']} {enriched_row['type']} x{enriched_row['quantity']} ({enriched_row['exchange']})"
                            )
                    else:
                        # Other IntegrityError (e.g., foreign key, check constraint) - count as failed
                        log.exception(
                            f"❌ IntegrityError inserting trade (not UNIQUE): {e}"
                        )
                        r = enriched_row.copy()
                        r["failure_reason"] = f"IntegrityError: {e}"
                        failed_rows.append(r)
                        count_failed += 1

                except Exception as e:
                    # Unexpected DB error during insert/replace
                    log.exception(f"❌ Failed to insert trade into DB: {e}")
                    r = enriched_row.copy()
                    r["failure_reason"] = str(e)
                    failed_rows.append(r)
                    count_failed += 1

    enriched_df = pd.DataFrame(enriched_rows) if enriched_rows else pd.DataFrame()
    failed_df = pd.DataFrame(failed_rows) if failed_rows else pd.DataFrame()

    stats = {
        "added": count_added,
        "replaced": count_replaced,
        "skipped": count_skipped,
        "failed": count_failed,
    }

    return enriched_df, failed_df, stats
