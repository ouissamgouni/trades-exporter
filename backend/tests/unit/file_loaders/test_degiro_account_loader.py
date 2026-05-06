"""
Unit tests for DeGiro Account file loader — FX pairing, group_id, and include_consumed.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timezone

from backend.file_loaders.degiro_account_loader import (
    load_degiro_account_file,
    classify_row,
    AccountRowType,
    _pair_dividends_and_withholding,
    _pair_fx_to_dividends,
    _assign_group_ids,
)


# ---------------------------------------------------------------------------
# Helper: Build CSV bytes from rows
# ---------------------------------------------------------------------------

_HEADER = (
    "Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id"
)


def _csv_bytes(rows: list[str]) -> bytes:
    """Build a CSV file from header + rows."""
    lines = [_HEADER] + rows
    return "\n".join(lines).encode("utf-8")


# ---------------------------------------------------------------------------
# Sample CSV fragments
# ---------------------------------------------------------------------------

# A full dividend cycle for a US stock:
#  1. Dividend (gross USD credit)
#  2. Withholding tax (USD debit)
#  3. FX debit (net USD out)
#  4. FX credit (net EUR in)
_DIVIDEND_ROW = '02-01-2025,08:30,02-01-2025,MICROSOFT CORP,US5949181045,Dividende,,"3,57",USD,"100,00",USD,'
_WHT_ROW = '02-01-2025,08:30,02-01-2025,MICROSOFT CORP,US5949181045,Impôts sur dividende,,"- 1,07",USD,"98,93",USD,'
_FX_DEBIT_ROW = '02-01-2025,08:30,02-01-2025,,,Opération de change - Débit,"1,0850","- 2,50",USD,"96,43",USD,'
_FX_CREDIT_ROW = '02-01-2025,08:30,02-01-2025,,,Opération de change - Crédit,"1,0850","2,30",EUR,"200,00",EUR,'

# A EUR-denominated dividend (same currency, no FX needed)
_EUR_DIVIDEND_ROW = '15-03-2025,10:00,15-03-2025,ASML HOLDING,NL0010273215,Dividende,,"5,20",EUR,"300,00",EUR,'
_EUR_WHT_ROW = '15-03-2025,10:00,15-03-2025,ASML HOLDING,NL0010273215,Impôts sur dividende,,"- 1,04",EUR,"298,96",EUR,'

# Rows expected to be SKIPPED
_TRADE_ROW = '18-03-2025,15:30,18-03-2025,QUALCOMM INC,US7475251036,Achat 5 @ 152.30,,"",USD,"",USD,abc12345-1111-2222-3333-444455556666'
_BROKERAGE_FEE_ROW = '18-03-2025,15:30,18-03-2025,,,Frais DEGIRO de courtage,,"-1,00",EUR,"993,93",EUR,abc12345-1111-2222-3333-444455556666'
_CASH_SWEEP_ROW = '12-02-2025,03:00,12-02-2025,,,Degiro Cash Sweep Transfer,,"0,00",EUR,"1000,00",EUR,'

# Standalone rows
_DEPOSIT_ROW = '01-01-2025,12:00,01-01-2025,,,Dépôt flatex,,"500,00",EUR,"500,00",EUR,'
_INTEREST_ROW = '31-12-2024,23:59,31-12-2024,,,Flatex Interest,,"0,12",EUR,"100,12",EUR,'
_EXCHANGE_FEE_ROW = '02-01-2025,00:00,02-01-2025,,,Frais de connexion aux places boursières,,"- 2,50",EUR,"97,50",EUR,'

# Unmatched FX (no dividend to pair with)
_ORPHAN_FX_DEBIT = '05-01-2025,14:00,05-01-2025,,,Opération de change - Débit,"1,10","- 10,00",USD,"80,00",USD,'
_ORPHAN_FX_CREDIT = '05-01-2025,14:00,05-01-2025,,,Opération de change - Crédit,"1,10","9,09",EUR,"210,00",EUR,'


# ---------------------------------------------------------------------------
# Tests: classify_row
# ---------------------------------------------------------------------------

class TestClassifyRow:

    def test_fx_no_order_id_is_standalone(self):
        assert classify_row("Opération de change - Débit", "") == AccountRowType.FX_STANDALONE

    def test_fx_with_order_id_is_skip(self):
        assert classify_row("Opération de change - Débit", "abc-123") == AccountRowType.SKIP

    def test_dividend(self):
        assert classify_row("Dividende", "") == AccountRowType.DIVIDEND

    def test_withholding(self):
        assert classify_row("Impôts sur dividende", "") == AccountRowType.WITHHOLDING


# ---------------------------------------------------------------------------
# Tests: Value date and FX rate parsing
# ---------------------------------------------------------------------------

class TestValueDateAndFxParsing:

    def test_value_date_parsed(self):
        csv = _csv_bytes([_DIVIDEND_ROW])
        records = load_degiro_account_file(content=csv)
        assert len(records) >= 1
        assert records[0]["value_date"] == "02-01-2025"

    def test_fx_rate_parsed(self):
        csv = _csv_bytes([_FX_DEBIT_ROW])
        # FX rows get paired/consumed, but let's check raw before pairing
        # Use a standalone FX that won't get consumed (no matching dividend)
        csv = _csv_bytes([_ORPHAN_FX_DEBIT, _ORPHAN_FX_CREDIT])
        # These will be filtered as SKIP, use include_consumed to check
        records = load_degiro_account_file(content=csv, include_consumed=True)
        # All should be SKIP (filtered) since no dividend to match
        # The fx_rate_raw should have been parsed during loading
        # Let's test via a dividend that gets FX pairing instead
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW])
        records = load_degiro_account_file(content=csv)
        div = [r for r in records if r["_row_type"] == AccountRowType.DIVIDEND]
        assert len(div) == 1
        assert div[0].get("fx_rate") is not None


# ---------------------------------------------------------------------------
# Tests: Dividend + WHT pairing
# ---------------------------------------------------------------------------

class TestDividendWhtPairing:

    def test_basic_pairing(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW])
        records = load_degiro_account_file(content=csv)
        # WHT is consumed into dividend
        assert len(records) == 1
        assert records[0]["_row_type"] == AccountRowType.DIVIDEND
        assert records[0]["withholding_amount"] == Decimal("1.07")
        assert records[0]["withholding_jurisdiction"] == "US"

    def test_group_id_assigned_to_dividend(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW])
        records = load_degiro_account_file(content=csv)
        assert records[0].get("_group_id") is not None
        assert records[0]["_group_id"].startswith("div-")

    def test_consumed_wht_has_group_id(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        consumed = [r for r in records if r.get("_role") == "consumed"]
        assert len(consumed) == 1
        # Consumed WHT shares the dividend's group_id
        primary = [r for r in records if r.get("_role") == "primary"]
        assert consumed[0]["_group_id"] == primary[0]["_group_id"]


# ---------------------------------------------------------------------------
# Tests: FX pairing with dividends
# ---------------------------------------------------------------------------

class TestFxPairing:

    def test_fx_paired_to_dividend(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW])
        records = load_degiro_account_file(content=csv)
        # Only the dividend should remain (WHT + 2 FX consumed)
        assert len(records) == 1
        div = records[0]
        assert div["_row_type"] == AccountRowType.DIVIDEND
        assert div.get("fx_rate") is not None
        assert div.get("fx_net_amount_base") is not None
        assert div.get("fx_base_currency") == "EUR"

    def test_fx_rate_value(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW])
        records = load_degiro_account_file(content=csv)
        div = records[0]
        assert div["fx_rate"] == Decimal("1.0850")

    def test_fx_net_amount_base(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW])
        records = load_degiro_account_file(content=csv)
        div = records[0]
        assert div["fx_net_amount_base"] == Decimal("2.30")

    def test_no_fx_rows_no_crash(self):
        """Same-currency dividend: no FX enrichment, no crash."""
        csv = _csv_bytes([_EUR_DIVIDEND_ROW, _EUR_WHT_ROW])
        records = load_degiro_account_file(content=csv)
        assert len(records) == 1
        div = records[0]
        assert div.get("fx_rate") is None
        assert div.get("fx_net_amount_base") is None

    def test_unmatched_fx_filtered(self):
        """Standalone FX without matching dividend → all consumed/filtered."""
        csv = _csv_bytes([_ORPHAN_FX_DEBIT, _ORPHAN_FX_CREDIT])
        records = load_degiro_account_file(content=csv)
        assert len(records) == 0  # All FX filtered

    def test_fx_consumed_rows_in_include_consumed(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        primary = [r for r in records if r.get("_role") == "primary"]
        consumed = [r for r in records if r.get("_role") == "consumed"]
        assert len(primary) == 1  # dividend
        assert len(consumed) == 3  # WHT + FX debit + FX credit
        # All share the same group_id
        gid = primary[0]["_group_id"]
        for c in consumed:
            assert c["_group_id"] == gid

    def test_multiple_dividends_same_day(self):
        """Two dividends on the same day with different amounts → correct pairing."""
        # Second dividend: different stock, different amounts
        div2 = '02-01-2025,09:00,02-01-2025,APPLE INC,US0378331005,Dividende,,"7,20",USD,"200,00",USD,'
        wht2 = '02-01-2025,09:00,02-01-2025,APPLE INC,US0378331005,Impôts sur dividende,,"- 2,16",USD,"197,84",USD,'
        fx_debit2 = '02-01-2025,09:00,02-01-2025,,,Opération de change - Débit,"1,0850","- 5,04",USD,"192,80",USD,'
        fx_credit2 = '02-01-2025,09:00,02-01-2025,,,Opération de change - Crédit,"1,0850","4,65",EUR,"300,00",EUR,'

        csv = _csv_bytes([
            _DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW,
            div2, wht2, fx_debit2, fx_credit2,
        ])
        records = load_degiro_account_file(content=csv)
        divs = [r for r in records if r["_row_type"] == AccountRowType.DIVIDEND]
        assert len(divs) == 2
        # Each should have FX data
        for d in divs:
            assert d.get("fx_rate") is not None

    def test_fx_amount_mismatch_not_paired(self):
        """FX amount doesn't match net → not paired."""
        # Dividend net = 3.57 - 1.07 = 2.50, but FX debit = 10.00 (no match)
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _ORPHAN_FX_DEBIT, _ORPHAN_FX_CREDIT])
        records = load_degiro_account_file(content=csv)
        div = [r for r in records if r["_row_type"] == AccountRowType.DIVIDEND]
        assert len(div) == 1
        assert div[0].get("fx_rate") is None  # Not paired


# ---------------------------------------------------------------------------
# Tests: Group ID assignment
# ---------------------------------------------------------------------------

class TestGroupIdAssignment:

    def test_standalone_rows_get_group_ids(self):
        csv = _csv_bytes([_DEPOSIT_ROW, _INTEREST_ROW, _EXCHANGE_FEE_ROW])
        records = load_degiro_account_file(content=csv)
        for r in records:
            assert r.get("_group_id") is not None
            assert r["_group_id"] != ""

    def test_each_standalone_row_has_unique_group_id(self):
        csv = _csv_bytes([_DEPOSIT_ROW, _INTEREST_ROW, _EXCHANGE_FEE_ROW])
        records = load_degiro_account_file(content=csv)
        gids = [r["_group_id"] for r in records]
        assert len(gids) == len(set(gids))  # All unique

    def test_dividend_group_id_prefix(self):
        csv = _csv_bytes([_DIVIDEND_ROW])
        records = load_degiro_account_file(content=csv)
        assert records[0]["_group_id"].startswith("div-")


# ---------------------------------------------------------------------------
# Tests: include_consumed mode
# ---------------------------------------------------------------------------

class TestIncludeConsumed:

    def test_default_excludes_consumed(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW])
        records = load_degiro_account_file(content=csv)
        assert all(r.get("_role") is None for r in records)
        assert len(records) == 1

    def test_include_consumed_adds_roles(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        roles = {r.get("_role") for r in records}
        assert "primary" in roles
        assert "consumed" in roles

    def test_include_consumed_full_cycle(self):
        """Full dividend cycle: 1 primary + 3 consumed (WHT + 2 FX)."""
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _FX_DEBIT_ROW, _FX_CREDIT_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        primary = [r for r in records if r.get("_role") == "primary"]
        consumed = [r for r in records if r.get("_role") == "consumed"]
        assert len(primary) == 1
        assert len(consumed) == 3

    def test_consumed_rows_have_generated_id(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        for r in records:
            assert "_generated_id" in r


class TestSkippedRowsVisibility:
    """Verify skipped rows appear with role='skipped' in include_consumed mode."""

    def test_skip_rows_excluded_by_default(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _TRADE_ROW, _CASH_SWEEP_ROW])
        records = load_degiro_account_file(content=csv)
        # Only the dividend should be returned
        assert len(records) == 1

    def test_skip_rows_included_with_role_skipped(self):
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _TRADE_ROW, _CASH_SWEEP_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        skipped = [r for r in records if r.get("_role") == "skipped"]
        assert len(skipped) == 2  # trade + cash sweep

    def test_skipped_rows_have_generated_id(self):
        csv = _csv_bytes([_TRADE_ROW, _BROKERAGE_FEE_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        skipped = [r for r in records if r.get("_role") == "skipped"]
        assert len(skipped) == 2
        for r in skipped:
            assert "_generated_id" in r

    def test_skipped_rows_have_group_id(self):
        csv = _csv_bytes([_TRADE_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        skipped = [r for r in records if r.get("_role") == "skipped"]
        assert len(skipped) == 1
        assert skipped[0].get("_group_id") is not None

    def test_all_three_roles_present(self):
        """Dividend (primary) + WHT (consumed) + trade (skipped)."""
        csv = _csv_bytes([_DIVIDEND_ROW, _WHT_ROW, _TRADE_ROW])
        records = load_degiro_account_file(content=csv, include_consumed=True)
        roles = {r.get("_role") for r in records}
        assert roles == {"primary", "consumed", "skipped"}
