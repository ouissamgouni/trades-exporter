"""
Integration tests for date-grouped transaction recaps (Postgres-specific SQL:
date_trunc / timezone / FILTER).

Run with: task test:backend:int
"""

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlmodel import select

from backend.db.models import Account, Asset, NormalizedTransaction, ReviewStatus
from backend.services.transaction_groups import (
    compute_transaction_groups,
    count_invalid_transactions,
)


def _account(session, name, owned=True):
    acct = Account(name=name, account_type="cex", owned=owned)
    session.add(acct)
    session.commit()
    session.refresh(acct)
    return acct


def _asset(session, symbol):
    asset = Asset(symbol=symbol)
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return asset


def _tx(session, account, asset, dt, direction="inflow", qty=1, **kw):
    tx = NormalizedTransaction(
        account_id=account.id,
        asset_id=asset.asset_id if asset else None,
        date_time=dt,
        transaction_type=kw.pop("transaction_type", "trade"),
        direction=direction,
        quantity=qty,
        source="grp_test",
        source_asset_symbol=asset.symbol if asset else "",
        review_status=kw.pop("review_status", ReviewStatus.VALID),
        **kw,
    )
    session.add(tx)
    session.commit()
    return tx


def _ids(account):
    return select(NormalizedTransaction.id).where(
        NormalizedTransaction.account_id == account.id
    )


@pytest.mark.integration
class TestTransactionGroups:
    def test_month_recap_counts_and_net_qty(self, pg_session):
        acct = _account(pg_session, "GrpAcct")
        btc = _asset(pg_session, "GRPBTC")
        eth = _asset(pg_session, "GRPETH")
        _tx(pg_session, acct, btc, datetime(2024, 3, 2, 10), "inflow", 2)
        _tx(pg_session, acct, btc, datetime(2024, 3, 5, 10), "outflow", 0.5)
        _tx(
            pg_session,
            acct,
            eth,
            datetime(2024, 3, 6, 10),
            "inflow",
            3,
            review_status=ReviewStatus.PENDING,
        )
        _tx(
            pg_session,
            acct,
            eth,
            datetime(2024, 3, 7, 10),
            "inflow",
            100,
            review_status=ReviewStatus.INVALID,
        )
        _tx(pg_session, acct, btc, datetime(2024, 2, 10, 10), "inflow", 1)

        groups, total = compute_transaction_groups(
            pg_session, _ids(acct), granularity="month", tz=ZoneInfo("UTC")
        )

        assert total == 2
        march = groups[0]
        assert march.period_start == "2024-03-01"
        assert march.total_count == 3
        assert (march.valid_count, march.pending_count, march.invalid_count) == (
            2,
            1,
            1,
        )
        recap = march.accounts[0]
        assert (recap.inflow_count, recap.outflow_count) == (2, 1)
        nets = {a.symbol: a.net_quantity for a in recap.assets}
        assert nets == {"GRPBTC": 1.5, "GRPETH": 3.0}

    def test_hide_invalid_only_drops_invalid_only_periods(self, pg_session):
        acct = _account(pg_session, "GrpHideInv")
        btc = _asset(pg_session, "GRPHIDE")
        _tx(pg_session, acct, btc, datetime(2024, 3, 2, 10))
        _tx(
            pg_session,
            acct,
            btc,
            datetime(2024, 3, 3, 10),
            review_status=ReviewStatus.INVALID,
        )
        _tx(
            pg_session,
            acct,
            btc,
            datetime(2024, 2, 3, 10),
            review_status=ReviewStatus.INVALID,
        )

        groups, total = compute_transaction_groups(
            pg_session,
            _ids(acct),
            granularity="month",
            tz=ZoneInfo("UTC"),
            hide_invalid_only=True,
        )

        assert total == 1
        assert [g.period_start for g in groups] == ["2024-03-01"]
        assert groups[0].invalid_count == 1
        assert count_invalid_transactions(pg_session, _ids(acct)) == 2

    def test_day_boundary_follows_timezone(self, pg_session):
        acct = _account(pg_session, "GrpTzAcct")
        btc = _asset(pg_session, "GRPTZ")
        # 23:30 UTC on Jan 1 is 00:30 on Jan 2 in Paris
        _tx(pg_session, acct, btc, datetime(2024, 1, 1, 23, 30))

        utc_groups, _ = compute_transaction_groups(
            pg_session, _ids(acct), granularity="day", tz=ZoneInfo("UTC")
        )
        paris_groups, _ = compute_transaction_groups(
            pg_session, _ids(acct), granularity="day", tz=ZoneInfo("Europe/Paris")
        )

        assert utc_groups[0].period_start == "2024-01-01"
        assert paris_groups[0].period_start == "2024-01-02"
        assert paris_groups[0].date_from == "2024-01-01T23:00:00"

    def test_internal_transfer_counted(self, pg_session):
        a = _account(pg_session, "GrpFrom")
        b = _account(pg_session, "GrpTo")
        btc = _asset(pg_session, "GRPINT")
        _tx(
            pg_session,
            a,
            btc,
            datetime(2024, 5, 1, 12),
            "outflow",
            1,
            transaction_type="transfer",
            from_account_id=a.id,
            to_account_id=b.id,
        )

        groups, _ = compute_transaction_groups(
            pg_session, _ids(a), granularity="month", tz=ZoneInfo("UTC")
        )

        assert groups[0].accounts[0].internal_transfer_count == 1
