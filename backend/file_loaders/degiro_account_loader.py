"""
DeGiro Account file loader: Parse DeGiro Account.csv export into classified records.

CSV Format (DeGiro Account export):
Date,Time,Value date,Product,ISIN,Description,FX,Change,[Currency],Balance,[Currency],Order Id

Key characteristics:
- European number format: comma as decimal separator (e.g. "1.234,56")
- Dates in DD-MM-YYYY format, times in HH:MM
- Description-based classification (French locale)
- Dividend + withholding tax pairing by ISIN+date
- FX operation pairing with dividends (auto-FX conversion tracking)
- Skip logic for rows already covered by Transactions.csv
"""

import io
import hashlib
import re
from decimal import Decimal
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Any, Tuple
from collections import defaultdict

from backend.config.loader import configure_logging
from backend.file_loaders.degiro_loader import parse_european_number

log = configure_logging("degiro_account_loader")


# ============================================================================
# Classification patterns
# ============================================================================

# Rows to SKIP — already in Transactions.csv or internal bookkeeping
_SKIP_PATTERNS = [
    # Trades (have Order ID and match buy/sell)
    re.compile(r"^(Achat|Vente)\s+\d+", re.IGNORECASE),
    # Brokerage fees (with Order ID)
    re.compile(r"Frais\s+(DEGIRO\s+de\s+courtage|de transaction)", re.IGNORECASE),
    # FX operations with Order ID (skip handled separately — needs Order ID check)
    # Cash sweep (internal bookkeeping, net zero)
    re.compile(r"Degiro Cash Sweep Transfer", re.IGNORECASE),
    re.compile(r"Virement\s+(vers|depuis)\s+votre\s+Compte\s+Espèces", re.IGNORECASE),
    # Spinoff inflows (already in Transactions.csv)
    re.compile(r"Spin-off:\s+(Achat|Vente)", re.IGNORECASE),
]

# FX operations — skip only when Order ID is present
_FX_PATTERN = re.compile(
    r"Op[eé]ration\s+de\s+change\s*[-–]\s*(D[eé]bit|Cr[eé]dit)", re.IGNORECASE
)

# Import patterns with classification
_DIVIDEND_PATTERN = re.compile(r"^Dividende$", re.IGNORECASE)
_WITHHOLDING_PATTERN = re.compile(r"Imp[oô]ts?\s+sur\s+dividende", re.IGNORECASE)
_EXCHANGE_FEE_PATTERN = re.compile(
    r"Frais\s+de\s+connexion\s+aux\s+places\s+boursi[eè]res", re.IGNORECASE
)
_ADR_FEE_PATTERN = re.compile(
    r"Frais\s+de\s+d[eé]tention\s+d.ADR", re.IGNORECASE
)
_INTEREST_PATTERN = re.compile(r"Flatex\s+Interest", re.IGNORECASE)
_DEPOSIT_PATTERN = re.compile(r"D[eé]p[oô]t\s+flatex", re.IGNORECASE)
_CASH_SETTLEMENT_PATTERN = re.compile(
    r"R[eè]glement\s+esp[eè]ces\s*[-–]\s*Action", re.IGNORECASE
)


class AccountRowType:
    """Classification of an Account.csv row."""
    SKIP = "skip"
    DIVIDEND = "dividend"
    WITHHOLDING = "withholding"
    EXCHANGE_FEE = "exchange_fee"
    ADR_FEE = "adr_custody_fee"
    INTEREST = "interest"
    DEPOSIT = "deposit"
    CASH_IN_LIEU = "cash_in_lieu"
    FX_STANDALONE = "fx_standalone"


def classify_row(description: str, order_id: str) -> str:
    """
    Classify an Account.csv row by its description and Order ID.

    Returns an AccountRowType value.
    """
    desc = (description or "").strip()
    oid = (order_id or "").strip()

    # Check skip patterns first
    for pattern in _SKIP_PATTERNS:
        if pattern.search(desc):
            return AccountRowType.SKIP

    # FX operations: skip with Order ID, standalone without
    if _FX_PATTERN.search(desc):
        return AccountRowType.FX_STANDALONE if not oid else AccountRowType.SKIP

    # Cash settlement: skip with Order ID (trade settlement), import without (cash-in-lieu)
    if _CASH_SETTLEMENT_PATTERN.search(desc):
        return AccountRowType.CASH_IN_LIEU if not oid else AccountRowType.SKIP

    # Import patterns
    if _DIVIDEND_PATTERN.search(desc):
        return AccountRowType.DIVIDEND
    if _WITHHOLDING_PATTERN.search(desc):
        return AccountRowType.WITHHOLDING
    if _EXCHANGE_FEE_PATTERN.search(desc):
        return AccountRowType.EXCHANGE_FEE
    if _ADR_FEE_PATTERN.search(desc):
        return AccountRowType.ADR_FEE
    if _INTEREST_PATTERN.search(desc):
        return AccountRowType.INTEREST
    if _DEPOSIT_PATTERN.search(desc):
        return AccountRowType.DEPOSIT

    # Unknown — skip by default (conservatively avoid double-counting)
    log.debug(f"Unknown Account.csv row, skipping: {desc}")
    return AccountRowType.SKIP


def generate_account_transaction_id(row: Dict[str, Any]) -> str:
    """
    Generate a stable unique transaction ID for an Account.csv row.

    Hash of: (date, time, description, isin, change_amount, currency)
    """
    parts = [
        str(row.get("date", "")),
        str(row.get("time", "")),
        str(row.get("description", "")),
        str(row.get("isin", "")),
        str(row.get("change", "")),
        str(row.get("currency", "")),
    ]
    unique_str = "_".join(parts)
    return hashlib.md5(unique_str.encode()).hexdigest()


def _pair_dividends_and_withholding(
    rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Pair dividend rows with their corresponding withholding tax rows.

    Matching key: (ISIN, date). Withholding rows are merged into the
    dividend row (stored in 'withholding_amount', 'withholding_jurisdiction'
    fields). Withholding rows are marked as skip after pairing.

    Withholding rows get `_consumed_by` set to the dividend's `_group_id`.
    """
    group_counter = 0

    # Index dividends by (isin, date)
    dividend_index: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in rows:
        if row.get("_row_type") == AccountRowType.DIVIDEND:
            key = (row.get("isin", ""), row.get("date", ""))
            group_id = f"div-{row.get('isin', 'unknown')}-{row.get('date', '')}-{group_counter}"
            group_counter += 1
            row["_group_id"] = group_id
            dividend_index[key] = row
            row["withholding_amount"] = Decimal(0)
            row["withholding_jurisdiction"] = None

    # Match withholding to dividends
    for row in rows:
        if row.get("_row_type") != AccountRowType.WITHHOLDING:
            continue
        key = (row.get("isin", ""), row.get("date", ""))
        dividend = dividend_index.get(key)
        if dividend:
            # Withholding is negative (debit), store as positive
            wht_amount = abs(row.get("change_decimal", Decimal(0)))
            dividend["withholding_amount"] = wht_amount
            # Infer jurisdiction from product name heuristics or leave None
            # (connector can set this based on ISIN country prefix)
            isin = row.get("isin", "")
            if isin.startswith("US"):
                dividend["withholding_jurisdiction"] = "US"
            elif isin.startswith("DE"):
                dividend["withholding_jurisdiction"] = "DE"
            elif isin.startswith("IE"):
                dividend["withholding_jurisdiction"] = "IE"
            elif isin.startswith("NL"):
                dividend["withholding_jurisdiction"] = "NL"
            elif isin.startswith("FR"):
                dividend["withholding_jurisdiction"] = "FR"
            row["_row_type"] = AccountRowType.SKIP  # Consumed into dividend
            row["_consumed_by"] = dividend["_group_id"]
        else:
            log.warning(
                f"Withholding without matching dividend: "
                f"ISIN={row.get('isin')}, date={row.get('date')}, "
                f"amount={row.get('change')}"
            )
            row["_row_type"] = AccountRowType.SKIP  # Can't import standalone

    return rows


def _pair_fx_to_dividends(
    rows: List[Dict[str, Any]],
    base_currency: str = "EUR",
) -> List[Dict[str, Any]]:
    """
    Pair FX_STANDALONE rows with their triggering dividend/ADR fee operations.

    DeGiro auto-FX generates 2 rows per conversion (debit source + credit base).
    For dividends in non-base currency, the net dividend amount (gross - WHT)
    is converted via auto-FX. This function links those FX rows back to the
    dividend, extracting the actual broker FX rate and base-currency net amount.

    FX debit matching: abs(debit.change) == dividend.net_source (within tolerance).
    Consumed FX rows are marked SKIP with `_consumed_by` = dividend's group_id.
    """
    # Collect FX_STANDALONE rows, split into debits (negative) and credits (positive)
    fx_debits: List[Dict[str, Any]] = []
    fx_credits: List[Dict[str, Any]] = []
    for row in rows:
        if row.get("_row_type") != AccountRowType.FX_STANDALONE:
            continue
        change = row.get("change_decimal", Decimal(0))
        if change < 0:
            fx_debits.append(row)
        elif change > 0:
            fx_credits.append(row)

    # Group FX pairs by (date, time, value_date) — DeGiro always emits
    # debit+credit at same timestamps
    def _fx_time_key(r: Dict[str, Any]) -> Tuple[str, str, str]:
        return (r.get("date", ""), r.get("time", ""), r.get("value_date", ""))

    credit_by_key: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = defaultdict(list)
    for c in fx_credits:
        credit_by_key[_fx_time_key(c)].append(c)

    # Track consumed FX rows to avoid double-matching
    consumed_fx: set = set()

    # Match FX to dividends (or ADR fees, cash-in-lieu)
    for row in rows:
        row_type = row.get("_row_type")
        if row_type not in (AccountRowType.DIVIDEND, AccountRowType.ADR_FEE, AccountRowType.CASH_IN_LIEU):
            continue
        # Only match if dividend is in non-base currency
        div_currency = row.get("currency", base_currency)
        if div_currency == base_currency:
            continue

        # Compute the net source-currency amount that should match the FX debit
        gross = abs(row.get("change_decimal", Decimal(0)))
        wht = row.get("withholding_amount", Decimal(0))
        net_source = gross - wht

        if net_source <= 0:
            continue

        group_id = row.get("_group_id")

        # Find matching FX debit: same currency, amount matches net, date proximity
        div_date_str = row.get("value_date") or row.get("date", "")
        try:
            div_date = datetime.strptime(div_date_str, "%d-%m-%Y")
        except (ValueError, TypeError):
            continue

        best_debit = None
        best_credit = None
        tolerance = Decimal("0.02")  # 2 cent tolerance for rounding

        for debit in fx_debits:
            if id(debit) in consumed_fx:
                continue
            if debit.get("currency") != div_currency:
                continue
            debit_amount = abs(debit.get("change_decimal", Decimal(0)))
            if abs(debit_amount - net_source) > tolerance:
                continue
            # Check date proximity (±2 days based on value_date)
            debit_vdate_str = debit.get("value_date") or debit.get("date", "")
            try:
                debit_date = datetime.strptime(debit_vdate_str, "%d-%m-%Y")
            except (ValueError, TypeError):
                continue
            if abs((debit_date - div_date).days) > 2:
                continue

            # Found a matching debit — now find its paired credit
            time_key = _fx_time_key(debit)
            candidates = credit_by_key.get(time_key, [])
            for credit in candidates:
                if id(credit) in consumed_fx:
                    continue
                # Credit should be in base currency
                if credit.get("currency") != base_currency:
                    continue
                best_debit = debit
                best_credit = credit
                break

            if best_debit:
                break

        if best_debit and best_credit:
            # Extract FX rate from the row that has it
            fx_rate = best_debit.get("fx_rate_raw") or best_credit.get("fx_rate_raw")

            # Enrich dividend row with FX data
            row["fx_rate"] = fx_rate
            row["fx_net_amount_base"] = abs(best_credit.get("change_decimal", Decimal(0)))
            row["fx_base_currency"] = best_credit.get("currency", base_currency)

            # Mark FX rows as consumed
            consumed_fx.add(id(best_debit))
            consumed_fx.add(id(best_credit))
            best_debit["_row_type"] = AccountRowType.SKIP
            best_debit["_consumed_by"] = group_id
            best_credit["_row_type"] = AccountRowType.SKIP
            best_credit["_consumed_by"] = group_id

            log.debug(
                f"Paired FX to dividend: {row.get('isin')} {row.get('date')} "
                f"net={net_source} {div_currency} → {row['fx_net_amount_base']} {base_currency} "
                f"(FX rate: {fx_rate})"
            )

    # Any remaining FX_STANDALONE rows → mark SKIP (prevents connector crash)
    fx_remaining = 0
    for row in rows:
        if row.get("_row_type") == AccountRowType.FX_STANDALONE:
            row["_row_type"] = AccountRowType.SKIP
            fx_remaining += 1
    if fx_remaining:
        log.info(f"Filtered {fx_remaining} unmatched FX_STANDALONE rows as SKIP")

    return rows


def _assign_group_ids(rows: List[Dict[str, Any]]) -> None:
    """
    Assign _group_id to non-dividend rows that don't already have one.

    Dividends get group_ids in _pair_dividends_and_withholding().
    This assigns IDs to deposits, interest, fees, and skipped rows.
    """
    idx = 0
    for row in rows:
        if row.get("_group_id"):
            continue  # Already assigned (dividends, consumed rows via _consumed_by)
        consumed_by = row.get("_consumed_by")
        if consumed_by:
            row["_group_id"] = consumed_by
            continue
        row_type = row.get("_row_type", "")
        row["_group_id"] = f"{row_type}-{row.get('date', '')}-{idx}"
        idx += 1


def load_degiro_account_file(
    file_path: Optional[str] = None,
    content: Optional[bytes] = None,
    include_consumed: bool = False,
) -> List[Dict[str, Any]]:
    """
    Load a DeGiro Account.csv and return classified, paired records.

    Args:
        file_path: Path to the CSV file.
        content: Raw CSV bytes (e.g., from file upload).
        include_consumed: If True, include consumed rows (WHT, FX) with their
            _group_id and _consumed_by fields for preview use. Default False.

    Returns:
        List of dicts with classified records ready for connector normalization.
        Skipped rows are excluded (unless include_consumed=True for consumed ones).
        Dividend+withholding are paired. FX operations are paired with dividends.
    """
    import pandas as pd

    if file_path and content:
        raise ValueError("Only one of file_path or content should be provided")
    if not file_path and content is None:
        raise ValueError("Either file_path or content must be provided")

    # Read CSV
    if content is not None:
        text = content.decode("utf-8-sig") if isinstance(content, bytes) else content
        buf = io.StringIO(text)
    else:
        buf = file_path

    df = pd.read_csv(buf, sep=",", dtype=str, keep_default_na=False)

    if df.empty:
        return []

    # Validate expected columns
    expected_headers = {"Date", "Time", "Description"}
    actual_headers = set(df.columns)
    missing = expected_headers - actual_headers
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    all_rows: List[Dict[str, Any]] = []

    for _, row in df.iterrows():
        date_str = str(row.get("Date", "")).strip()
        time_str = str(row.get("Time", "")).strip()
        value_date_str = str(row.get("Value date", "")).strip()
        description = str(row.get("Description", "")).strip()
        product = str(row.get("Product", "")).strip()
        isin = str(row.get("ISIN", "")).strip().upper()
        order_id = str(row.get("Order Id", "")).strip()

        if not date_str:
            continue

        # Parse date + time
        try:
            if time_str and time_str != "00:00":
                dt = datetime.strptime(f"{date_str} {time_str}", "%d-%m-%Y %H:%M")
            else:
                dt = datetime.strptime(date_str, "%d-%m-%Y")
            dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            log.warning(f"Skipping row with unparseable date: {date_str} {time_str}")
            continue

        # Parse FX rate (European number format, e.g. "1,1672")
        fx_str = str(row.get("FX", "")).strip()
        fx_rate_raw = parse_european_number(fx_str)

        # Parse Change amount (European format)
        change_str = str(row.get("Change", "")).strip()
        change_decimal = parse_european_number(change_str)

        # Parse currency from the column after Change
        cols = list(df.columns)
        currency = ""
        change_col_idx = None
        for i, col in enumerate(cols):
            if col == "Change":
                change_col_idx = i
                break
        if change_col_idx is not None and change_col_idx + 1 < len(cols):
            currency = str(row.iloc[change_col_idx + 1]).strip().upper()
        if not currency or currency == "NAN":
            currency = "EUR"

        # Classify
        row_type = classify_row(description, order_id)

        record = {
            "datetime": dt,
            "date": date_str,
            "time": time_str,
            "value_date": value_date_str,
            "product": product,
            "isin": isin,
            "description": description,
            "order_id": order_id,
            "change": change_str,
            "change_decimal": change_decimal if change_decimal is not None else Decimal(0),
            "currency": currency,
            "fx_rate_raw": fx_rate_raw,
            "_row_type": row_type,
        }
        all_rows.append(record)

    # Pair dividends with withholding tax
    all_rows = _pair_dividends_and_withholding(all_rows)

    # Pair FX operations with dividends (auto-FX conversion tracking)
    all_rows = _pair_fx_to_dividends(all_rows)

    # Assign group_ids to remaining rows
    _assign_group_ids(all_rows)

    # Filter out skipped rows and zero-amount interest
    result = []
    consumed_rows = []
    skipped_rows = []
    skip_count = 0
    for record in all_rows:
        is_consumed = bool(record.get("_consumed_by"))
        if record["_row_type"] == AccountRowType.SKIP:
            if is_consumed and include_consumed:
                # Consumed rows (WHT, FX) — include in preview mode
                record["_generated_id"] = generate_account_transaction_id(record)
                consumed_rows.append(record)
            elif include_consumed:
                # Pure skip rows — include in preview mode for transparency
                record["_generated_id"] = generate_account_transaction_id(record)
                skipped_rows.append(record)
            else:
                skip_count += 1
            continue
        # Skip zero-amount interest
        if (
            record["_row_type"] == AccountRowType.INTEREST
            and record["change_decimal"] == Decimal(0)
        ):
            skip_count += 1
            continue
        record["_generated_id"] = generate_account_transaction_id(record)
        result.append(record)

    log.info(
        f"✅ Loaded {len(result)} importable records from DeGiro Account.csv "
        f"(skipped {skip_count + len(skipped_rows)}, consumed {len(consumed_rows)})"
    )

    if include_consumed:
        # Return primary rows + consumed rows + skipped rows with role markers
        for r in result:
            r["_role"] = "primary"
        for r in consumed_rows:
            r["_role"] = "consumed"
        for r in skipped_rows:
            r["_role"] = "skipped"
        return result + consumed_rows + skipped_rows

    return result


def get_degiro_account_file_preview(content: bytes) -> dict:
    """
    Generate preview data for a DeGiro Account CSV file.

    Returns:
        dict with keys: row_count, date_range, types_breakdown, sample_rows
    """
    records = load_degiro_account_file(content=content)

    if not records:
        return {
            "row_count": 0,
            "date_range": None,
            "types_breakdown": {},
            "sample_rows": [],
        }

    dates = [r["datetime"] for r in records]
    types = defaultdict(int)
    for r in records:
        types[r["_row_type"]] += 1

    return {
        "row_count": len(records),
        "date_range": {
            "start": min(dates).isoformat(),
            "end": max(dates).isoformat(),
        },
        "types_breakdown": dict(types),
        "sample_rows": [
            {
                "date": r["datetime"].isoformat(),
                "type": r["_row_type"],
                "product": r["product"],
                "isin": r["isin"],
                "amount": str(r["change_decimal"]),
                "currency": r["currency"],
                "group_id": r.get("_group_id"),
            }
            for r in records[:10]
        ],
    }
