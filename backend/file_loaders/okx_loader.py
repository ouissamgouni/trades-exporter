import pandas as pd
from backend.config.loader import configure_logging

log = configure_logging("okx_loader")


def load_okx_file(file_path):
    """
    Load and standardize OKX Spot trade CSV.

    Output columns:
        datetime, type, base, quote,
        quantity, total, price,
        fee, fee_quote, exchange, tags
    """
    log.info("loading_okx_file", file_path=file_path)

    # Read CSV with controlled NA handling to avoid string 'nan' issues
    df_orig = pd.read_csv(file_path, keep_default_na=False, na_values=[""])

    rows = []

    for _, row in df_orig.iterrows():
        try:
            # --- Parse core fields ---
            dt = pd.to_datetime(row["Time"], utc=True)
            symbol = row["Symbol"]  # e.g. "USDC-EUR" or "USDC-EUR-TRANSFER"

            # Handle Action field - check for NaN or empty string
            action_raw = row["Action"]
            if pd.isna(action_raw) or str(action_raw).strip() == "":
                action = None
            else:
                action = str(action_raw).lower().strip()

            qty = float(row["Amount"])
            price = float(row["Filled Price"])
            balance_change = (
                float(row["Balance Change"]) if pd.notna(row["Balance Change"]) else 0
            )

            trading_unit = str(row["Trading Unit"]).upper()  # quote candidate
            balance_unit = str(row["Balance Unit"]).upper()  # base candidate

            # --- Check if this is a transfer operation ---
            is_transfer = symbol.endswith("-CONVERT")

            if is_transfer:
                # For transfers, action is determined by balance change sign
                # Negative balance change = buy (acquiring asset)
                # Positive balance change = sell (disposing asset)
                if balance_change < 0:
                    action = "sell"
                elif balance_change > 0:
                    action = "buy"
                else:
                    # Zero balance change - skip this row
                    log.info(
                        f"Skipping OKX transfer row with zero balance change: {symbol}, dt={dt}"
                    )
                    continue

            # Validate action is not None or empty
            if not action:
                log.warning(
                    f"Skipping OKX row with missing or empty action: {symbol}, dt={dt}"
                )
                continue

            # --- Determine base & quote correctly ---
            # sym_a, sym_b = symbol.split("-")
            # sym_a, sym_b = sym_a.upper(), sym_b.upper()

            # Base is always the BALANCE UNIT (asset whose wallet changed)
            base = balance_unit

            # Quote is always the TRADING UNIT (asset used to price trade)
            quote = trading_unit

            # --- Filter out fake lines ---
            # Fake lines are those where:
            #  - balance unit == quote AND
            #  - balance change reflects the fiat leg of the pair
            # These represent the "backside" of a simple BUY operation.
            if base == quote:
                # Example: EUR balance changed after BUY USDC-EUR → ignore
                log.debug(
                    f"Skipping OKX row where base == quote: {symbol}, base={base}, quote={quote}, action={action}, dt={dt}"
                )
                continue

            # --- Fees ---
            fee = float(row["Fee"]) if pd.notna(row["Fee"]) else 0
            fee_quote = (
                str(row["Fee Unit"]).upper() if pd.notna(row["Fee Unit"]) else None
            )

            # Calculate total (for transfers, use absolute value of balance change)
            total = abs(balance_change) if is_transfer else qty * price

            rows.append(
                {
                    "datetime": dt,
                    "type": action,  # buy/sell (determined by balance change for transfers)
                    "base": base,
                    "quote": quote,
                    "quantity": qty,
                    "total": total,
                    "price": price,
                    "fee": fee,
                    "fee_quote": fee_quote,
                    "exchange": "OKX",
                    "tags": {"type": "convert"} if is_transfer else {},
                }
            )

        except Exception as e:
            log.error(f"Failed to parse OKX row: {e}")
            continue

    return pd.DataFrame(rows)
