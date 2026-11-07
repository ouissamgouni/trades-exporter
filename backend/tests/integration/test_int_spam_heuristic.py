"""
Integration tests for the suspected-spam heuristic queries (JSONB @>, IN lists) and verdicts.

Run with: task test:backend:int
"""

from datetime import datetime, timezone

import pytest
from sqlmodel import select

from backend.db.models import (
    Account,
    Asset,
    AssetPriceGetter,
    NormalizedTransaction,
    SpamTokenRule,
)
from backend.services.spam_heuristic_service import (
    apply_token_verdict,
    count_suspected,
    scan_suspected_spam,
    spam_tag,
)

T0 = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
T1 = datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc)


def _add(session, obj):
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return obj


def _transfer(session, account, contract, tx_hash, dt=T0, **kw):
    defaults = dict(
        account_id=account.id,
        source="ankr_test",
        source_transaction_id=f"{tx_hash}_erc20_{contract}_{kw.get('direction', 'inflow')}",
        network_transaction_id=tx_hash,
        date_time=dt,
        direction="inflow",
        transaction_type="transfer",
        source_transaction_type="erc20",
        source_asset_symbol="JUNK",
        quantity=1000,
        network="spamtestnet",
        token_contract_address=contract,
        review_status="pending",
        tags=[],
    )
    defaults.update(kw)
    return _add(session, NormalizedTransaction(**defaults))


@pytest.mark.integration
class TestSpamHeuristicSQL:
    def test_scan_flags_only_unsolicited_unpriced(self, pg_session):
        acct = _add(
            pg_session,
            Account(name="Spam Test Wallet", account_type="wallet", owned=True),
        )
        priced = _add(pg_session, Asset(symbol="SPAMTEST-PRICED"))
        _add(
            pg_session,
            AssetPriceGetter(asset_id=priced.asset_id, price_getter="coingecko"),
        )

        junk = _transfer(pg_session, acct, "0xjunk", "0xh1")
        swap_in = _transfer(pg_session, acct, "0xnew", "0xh2", dt=T1)
        _transfer(pg_session, acct, "0xusdc", "0xh2", dt=T1, direction="outflow")
        priced_in = _transfer(
            pg_session, acct, "0xpriced", "0xh3", asset_id=priced.asset_id
        )

        flagged = scan_suspected_spam(pg_session)
        flagged_ids = {tx.id for tx in flagged}

        assert junk.id in flagged_ids
        assert swap_in.id not in flagged_ids
        assert priced_in.id not in flagged_ids
        pg_session.refresh(junk)
        assert junk.review_status == "invalid"
        assert spam_tag(junk.tags)["spam_level"] == "suspected"
        assert count_suspected(pg_session) >= 1

    def test_allow_verdict_restores_token_and_prevents_reflag(self, pg_session):
        acct = _add(
            pg_session,
            Account(name="Spam Test Wallet 2", account_type="wallet", owned=True),
        )
        a = _transfer(pg_session, acct, "0xairdrop", "0xa1")
        b = _transfer(pg_session, acct, "0xAirdrop", "0xa2", dt=T1)
        scan_suspected_spam(pg_session)

        result = apply_token_verdict(pg_session, a.id, "allow")
        assert result["updated_count"] == 2
        for tx in (a, b):
            pg_session.refresh(tx)
            assert tx.review_status == "pending"
            assert spam_tag(tx.tags) is None

        later = _transfer(pg_session, acct, "0xairdrop", "0xa3", dt=T1)
        assert later.id not in {tx.id for tx in scan_suspected_spam(pg_session)}
        rule = pg_session.exec(
            select(SpamTokenRule).where(SpamTokenRule.contract_address == "0xairdrop")
        ).one()
        assert rule.verdict == "allow"

    def test_block_verdict_confirms_and_leaves_validated_rows(self, pg_session):
        acct = _add(
            pg_session,
            Account(name="Spam Test Wallet 3", account_type="wallet", owned=True),
        )
        suspected = _transfer(pg_session, acct, "0xscam", "0xb1")
        scan_suspected_spam(pg_session)
        validated = _transfer(
            pg_session, acct, "0xscam", "0xb2", dt=T1, review_status="valid"
        )

        apply_token_verdict(pg_session, suspected.id, "block")

        pg_session.refresh(suspected)
        pg_session.refresh(validated)
        assert spam_tag(suspected.tags).get("spam_level") is None
        assert suspected.review_status == "invalid"
        assert validated.review_status == "valid"
