"""
OKX Trading History file loader: Unified loader for OKX "Trading History" CSV export.

This single loader replaces both okx_trades_loader.py (Trade Details) and
okx_funding_loader.py (Funding History), since the Trading History export
contains all spot trades, convert trades, and transfer (deposit/withdrawal)
rows in one file.

CSV Format (header row with data rows, no metadata):
id,Order id,Time,Trade Type,Symbol,Action,Amount,Trading Unit,
Filled Price,PnL,Fee,Fee Unit,Position Change,Position Balance,
Balance Change,Balance,Balance Unit

Row classification by Trade Type:
- "Spot": Regular spot trades or convert trades (symbol contains "CONVERT")
- "Transfer": Deposits ("Transfer in") and withdrawals ("Transfer out")

For spot trades, each fill produces TWO rows — one for the base-asset leg
(Balance Unit ≠ Trading Unit) and one for the quote/fiat leg
(Balance Unit == Trading Unit). We keep only the base-asset leg (like
the legacy okx_loader.py already does).

Timezone:
- The filename encodes the export timezone, e.g. "…~UTC0~…".
- The loader accepts source_timezone param (IANA name or UTC±N offset).
  Defaults to UTC if not specified.
"""

import io
import re
from typing import Optional, Dict, Any, List

import pandas as pd
from backend.config.loader import configure_logging

log = configure_logging("okx_trading_history_loader")


def _parse_filename_timezone(filename: str) -> Optional[str]:
    """
    Extract timezone from OKX Trading History filename.

    Filenames look like:
        Trading History_2025-06-30~2026-02-19~UTC0~8339611181c6b…_1.csv

    Returns an IANA-like offset string (e.g., "UTC+0", "UTC+1", "UTC-5")
    or None if not found.
    """
    match = re.search(r"~(UTC[+-]?\d+)~", filename or "")
    if match:
        return match.group(1)
    return None


def _resolve_timezone(source_timezone: Optional[str]) -> str:
    """
    Resolve a source_timezone value into a pandas-compatible timezone string.

    Accepts:
    - None/empty → "UTC"
    - "UTC0", "UTC+0" → "UTC"
    - "UTC+N" / "UTC-N" → "Etc/GMT∓N" (sign inverted per Etc convention)
    - IANA name like "Europe/Paris" → passed through
    """
    if not source_timezone:
        return "UTC"

    # Normalize: "UTC0" → "UTC+0"
    tz = source_timezone.strip()
    if tz.upper() == "UTC" or tz.upper() == "UTC0" or tz.upper() == "UTC+0":
        return "UTC"

    # Match UTC±N pattern
    m = re.match(r"^UTC([+-]\d+)$", tz, re.IGNORECASE)
    if m:
        offset = int(m.group(1))
        if offset == 0:
            return "UTC"
        # Etc/GMT uses inverted sign: UTC+1 → Etc/GMT-1
        return f"Etc/GMT{-offset:+d}"

    # Assume IANA timezone name
    return tz


def load_okx_trading_history_file(
    file_path: Optional[str] = None,
    content: Optional[bytes] = None,
    source_timezone: Optional[str] = None,
) -> pd.DataFrame:
    """
    Load and parse OKX Trading History CSV file.

    Returns a unified DataFrame containing both trade and transfer rows,
    distinguished by the ``row_type`` column ("trade" or "transfer").

    Args:
        file_path: Path to CSV file (mutually exclusive with content)
        content: File content as bytes (mutually exclusive with file_path)
        source_timezone: Timezone of timestamps in the file.
            Accepts IANA names ("Europe/Paris") or UTC offset strings
            ("UTC0", "UTC+1", "UTC-5"). If None, defaults to UTC.

    Returns:
        pd.DataFrame with columns common to all rows:
            - datetime: Timestamp in UTC (timezone-aware)
            - row_type: "trade" or "transfer"
            - transaction_id: Row ``id`` from CSV (unique per row)

        Extra columns for row_type == "trade":
            - symbol, base_asset, quantity, price, quote_asset, total,
              fee, fee_currency, tags (dict or empty dict)

        Extra columns for row_type == "transfer":
            - transfer_type: "deposit" or "withdrawal"
            - currency, amount (always positive), fee (always 0)

    Raises:
        ValueError: If args are invalid or required columns missing
    """
    if content is None and file_path is None:
        raise ValueError("Either file_path or content must be provided")
    if content is not None and file_path is not None:
        raise ValueError("Only one of file_path or content should be provided")

    try:
        if content is not None:
            df_origin = pd.read_csv(
                io.BytesIO(content), keep_default_na=False, na_values=[""],
                encoding="utf-8-sig",
            )
        else:
            df_origin = pd.read_csv(
                file_path, keep_default_na=False, na_values=[""],
                encoding="utf-8-sig",
            )

        log.info(f"📂 Loaded CSV with {len(df_origin)} rows")

        # --- Validate required columns --------------------------------
        required_cols = [
            "id", "Time", "Trade Type", "Symbol", "Action",
            "Amount", "Trading Unit", "Filled Price",
            "Fee", "Fee Unit", "Balance Change", "Balance Unit",
        ]
        missing_cols = [c for c in required_cols if c not in df_origin.columns]
        if missing_cols:
            raise ValueError(f"Missing required columns: {missing_cols}")

        # --- Resolve timezone ------------------------------------------
        tz_resolved = _resolve_timezone(source_timezone)
        log.info(f"📍 Using timezone: {tz_resolved} (source_timezone={source_timezone!r})")

        # --- Parse timestamps and convert to UTC -----------------------
        timestamps = pd.to_datetime(df_origin["Time"], format="%Y-%m-%d %H:%M:%S")
        if tz_resolved == "UTC":
            timestamps = timestamps.dt.tz_localize("UTC")
        else:
            timestamps = timestamps.dt.tz_localize(tz_resolved).dt.tz_convert("UTC")

        # --- Classify rows ---------------------------------------------
        trade_type_col = df_origin["Trade Type"].str.strip()
        is_transfer = trade_type_col.str.lower() == "transfer"
        is_trade = ~is_transfer  # "Spot" or any other trading type

        rows: List[Dict[str, Any]] = []

        # ===============================================================
        # TRADE ROWS
        # ===============================================================
        trade_df = df_origin[is_trade].copy()
        trade_df["_ts"] = timestamps[is_trade]

        for idx, row in trade_df.iterrows():
            try:
                symbol = str(row["Symbol"]).strip()
                balance_unit = str(row["Balance Unit"]).upper().strip()
                trading_unit = str(row["Trading Unit"]).upper().strip()

                # Skip fiat / quote-side legs (base == quote)
                if balance_unit == trading_unit:
                    continue

                # Skip rows with missing critical fields
                if not symbol or pd.isna(row["Filled Price"]):
                    continue

                quantity = abs(float(row["Balance Change"])) if pd.notna(row["Balance Change"]) else float(row["Amount"])
                price = float(row["Filled Price"]) if pd.notna(row["Filled Price"]) else 0.0
                fee_val = float(row["Fee"]) if pd.notna(row["Fee"]) else 0.0

                tags = {}
                if "CONVERT" in symbol.upper():
                    tags["type"] = "convert"

                rows.append({
                    "datetime": row["_ts"],
                    "row_type": "trade",
                    "transaction_id": str(row["id"]),
                    "symbol": symbol,
                    "base_asset": balance_unit,
                    "quantity": quantity,
                    "price": price,
                    "quote_asset": trading_unit,
                    "total": quantity * price,
                    "fee": abs(fee_val),
                    "fee_currency": str(row["Fee Unit"]).upper().strip() if pd.notna(row["Fee Unit"]) and str(row["Fee Unit"]).strip() else balance_unit,
                    "tags": tags,
                })
            except Exception as e:
                log.warning(f"⚠️ Skipping trade row {idx}: {e}")
                continue

        # ===============================================================
        # TRANSFER ROWS
        # ===============================================================
        transfer_df = df_origin[is_transfer].copy()
        transfer_df["_ts"] = timestamps[is_transfer]

        for idx, row in transfer_df.iterrows():
            try:
                action = str(row["Action"]).strip().lower() if pd.notna(row["Action"]) else ""
                balance_change = float(row["Balance Change"]) if pd.notna(row["Balance Change"]) else 0.0
                currency = str(row["Balance Unit"]).upper().strip()

                if "transfer in" in action or balance_change > 0:
                    transfer_type = "deposit"
                elif "transfer out" in action or balance_change < 0:
                    transfer_type = "withdrawal"
                else:
                    log.warning(f"⚠️ Skipping ambiguous transfer row {idx}: action={action}, balance_change={balance_change}")
                    continue

                rows.append({
                    "datetime": row["_ts"],
                    "row_type": "transfer",
                    "transaction_id": str(row["id"]),
                    "transfer_type": transfer_type,
                    "currency": currency,
                    "amount": abs(balance_change),
                    "fee": 0.0,
                    # Provide trade-only fields as None/empty for consistent DataFrame
                    "symbol": "",
                    "base_asset": "",
                    "quantity": 0.0,
                    "price": 0.0,
                    "quote_asset": "",
                    "total": 0.0,
                    "fee_currency": currency,
                    "tags": {},
                })
            except Exception as e:
                log.warning(f"⚠️ Skipping transfer row {idx}: {e}")
                continue

        df = pd.DataFrame(rows)

        if df.empty:
            log.warning("⚠️ No valid rows parsed from Trading History file")
            return df

        # Summary
        trade_count = (df["row_type"] == "trade").sum()
        transfer_count = (df["row_type"] == "transfer").sum()
        convert_count = df[df["tags"].apply(lambda t: isinstance(t, dict) and t.get("type") == "convert")].shape[0]
        log.info(
            f"📊 Processed {len(df)} rows: "
            f"{trade_count} trades ({convert_count} convert), "
            f"{transfer_count} transfers"
        )

        return df

    except Exception as e:
        log.error(f"❌ Failed to load OKX Trading History file: {e}")
        raise


def get_okx_trading_history_file_preview(
    content: bytes,
    source_timezone: Optional[str] = None,
) -> dict:
    """
    Generate preview data for OKX Trading History file.

    Args:
        content: Raw file content as bytes
        source_timezone: Timezone of timestamps (see load function)

    Returns:
        dict with keys:
            - row_count
            - date_range: {min_date, max_date}
            - currencies: sorted unique asset symbols
            - trade_count, transfer_count, convert_trades_count
            - sample_rows: first 5 rows as dicts
    """
    df = load_okx_trading_history_file(content=content, source_timezone=source_timezone)

    if df.empty:
        return {
            "row_count": 0,
            "date_range": None,
            "currencies": [],
            "trade_count": 0,
            "transfer_count": 0,
            "convert_trades_count": 0,
            "sample_rows": [],
        }

    # Currencies: union of base_asset (trades) and currency (transfers)
    trade_assets = set(df.loc[df["row_type"] == "trade", "base_asset"].dropna().unique())
    transfer_assets = set()
    if "currency" in df.columns:
        transfer_assets = set(df.loc[df["row_type"] == "transfer", "currency"].dropna().unique())
    currencies = sorted(trade_assets | transfer_assets - {""})

    trade_count = int((df["row_type"] == "trade").sum())
    transfer_count = int((df["row_type"] == "transfer").sum())
    convert_count = int(df[df["tags"].apply(lambda t: isinstance(t, dict) and t.get("type") == "convert")].shape[0])

    min_date = df["datetime"].min()
    max_date = df["datetime"].max()

    sample_df = df.head(5).copy()
    sample_df["datetime"] = sample_df["datetime"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    # Convert tags dict to string for JSON serialization
    sample_df["tags"] = sample_df["tags"].apply(lambda t: t if isinstance(t, dict) else {})
    sample_rows = sample_df.to_dict("records")

    return {
        "row_count": len(df),
        "date_range": {
            "min_date": min_date.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(min_date) else None,
            "max_date": max_date.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(max_date) else None,
        },
        "currencies": currencies,
        "trade_count": trade_count,
        "transfer_count": transfer_count,
        "convert_trades_count": convert_count,
        "sample_rows": sample_rows,
    }
