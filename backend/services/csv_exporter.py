import os
import json
import pandas as pd
from backend.config.loader import load_settings


def _parse_tags(tag_field):
    """Safely parse the `tags` field from the DB into a Python list.

    Handles:
      - None -> []
      - already a list -> returned as-is
      - valid JSON string -> parsed
      - empty string or invalid JSON -> fallback to comma-split
    """
    if tag_field is None:
        return []
    if isinstance(tag_field, list):
        return tag_field
    if not isinstance(tag_field, str):
        return []
    tag_field = tag_field.strip()
    if tag_field == "":
        return []
    try:
        parsed = json.loads(tag_field)
        # if parsed is not a list, coerce to list
        if isinstance(parsed, list):
            return parsed
        return [parsed]
    except (json.JSONDecodeError, TypeError):
        # fallback: comma separated values
        return [t.strip() for t in tag_field.split(",") if t.strip()]


def export_trades_to_csv(from_datetime, to_datetime, export_dir, db_path=None):
    """
    Export trades to CSV for a given datetime range.

    Args:
        from_datetime (str or datetime): Start datetime as 'YYYY-MM-DD HH:MM:SS' or datetime object.
        to_datetime (str or datetime): End datetime as 'YYYY-MM-DD HH:MM:SS' or datetime object.
        export_dir (str): Directory to save CSV file.
        db_path (str, optional): Path to SQLite DB. If None, uses default from settings.

    Returns:
        str: Path to exported CSV file, or None if no trades found.
    """
    from backend.core.trade_db import TradeDB

    # --- Use provided db_path or get from settings ---
    if db_path is None:
        settings = load_settings()
        db_path = settings.get("database_path", "data/trades.db")

    with TradeDB(db_path) as db:
        # --- Query trades using the new method (accepts datetime objects directly) ---
        df = db.get_trades(from_datetime, to_datetime)

        if df.empty:
            print(f"⚠️ No trades found between {from_datetime} and {to_datetime}")
            return None

        # --- Convert datetime from Unix timestamp to YYYY-MM-DD HH:MM:SS ---
        df["datetime"] = pd.to_datetime(df["datetime"], unit="s").dt.strftime(
            "%Y-%m-%d %H:%M:%S"
        )

        # --- Comment ---
        # comment = f"{exchange.upper()}|{tags}|{typ} {qty} {asset_name} @ {price:.4f} {quote}"
        df["comment"] = df.apply(
            lambda r: f"{r['exchange']}|{_parse_tags(r['tags'])}|{r['type']} "
            f"{r['qty']} {r['asset_name']} @ {r['price']:.4f} {r['quote']}",
            axis=1,
        )

        # --- Export CSV ---
        timestamp = pd.Timestamp.now().strftime("%Y-%m-%d_%H-%M-%S")
        csv_path = os.path.join(export_dir, f"trades_to_sheet_{timestamp}.csv")
        df[
            [
                "datetime",
                "type",
                "asset_code",
                "asset_name",
                "qty",
                "price_eur",
                "fee_eur",
                "comment",
            ]
        ].to_csv(csv_path, index=False)
        print(f"✅ Exported CSV: {csv_path}")
        return csv_path
