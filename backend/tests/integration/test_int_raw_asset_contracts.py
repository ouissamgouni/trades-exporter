"""
Integration tests for contract-aware raw asset mapping (strict: a new contract never
inherits a symbol-level mapping).

Run with: task test:backend:int
"""

from datetime import datetime, timezone

import pytest
from sqlmodel import select

from backend.api.routes.raw_assets import _propagate
from backend.db.models import Asset, NormalizedTransaction, RawAsset
from backend.db.repositories.raw_asset_repository import RawAssetRepository

T0 = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
REAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"
FAKE = "0xf094052b3b9d76c6c2e0f54cba92e9811a1ef5b8"


def _add(session, obj):
    session.add(obj)
    session.commit()
    session.refresh(obj)
    return obj


def _tx(session, contract, source="ctr_test_src", **kw):
    return _add(
        session,
        NormalizedTransaction(
            source=source,
            source_transaction_id=f"{source}-{contract}-{kw.get('quantity', 1)}",
            date_time=T0,
            direction="inflow",
            transaction_type="transfer",
            source_asset_symbol="CTRTEST",
            quantity=kw.pop("quantity", 1),
            network="base",
            token_contract_address=contract,
            review_status="pending",
            **kw,
        ),
    )


@pytest.mark.integration
class TestRawAssetContracts:
    def test_new_contract_stays_unmapped_even_if_symbol_mapped(self, pg_session):
        asset = _add(pg_session, Asset(symbol="CTRTEST"))
        _add(
            pg_session,
            RawAsset(symbol="CTRTEST", source="ctr_test_src", asset_id=asset.asset_id),
        )
        repo = RawAssetRepository(pg_session)

        raw = repo.get_or_create(
            "CTRTEST", "ctr_test_src", "Base", "0x" + FAKE[2:].upper()
        )

        assert (raw.network, raw.contract_address, raw.asset_id) == ("base", FAKE, None)

    def test_known_contract_from_other_source_is_auto_mapped(self, pg_session):
        asset = _add(pg_session, Asset(symbol="CTRTEST"))
        _add(
            pg_session,
            RawAsset(
                symbol="CTRTEST",
                source="other_src",
                network="base",
                contract_address=REAL,
                asset_id=asset.asset_id,
            ),
        )

        raw = RawAssetRepository(pg_session).get_or_create(
            "CTRTEST", "ctr_test_src", "base", REAL
        )

        assert raw.asset_id == asset.asset_id

    def test_propagate_is_scoped_to_the_row_contract(self, pg_session):
        asset = _add(pg_session, Asset(symbol="CTRTEST"))
        real_tx = _tx(pg_session, REAL, quantity=1)
        fake_tx = _tx(pg_session, FAKE, quantity=2)
        plain_tx = _tx(pg_session, None, quantity=3)

        token_row = _add(
            pg_session,
            RawAsset(
                symbol="CTRTEST",
                source="ctr_test_src",
                network="base",
                contract_address=REAL,
            ),
        )
        _propagate(pg_session, token_row, asset.asset_id)
        plain_row = _add(pg_session, RawAsset(symbol="CTRTEST", source="ctr_test_src"))
        _propagate(pg_session, plain_row, asset.asset_id)
        pg_session.commit()

        ids = dict(
            pg_session.exec(
                select(NormalizedTransaction.id, NormalizedTransaction.asset_id).where(
                    NormalizedTransaction.id.in_([real_tx.id, fake_tx.id, plain_tx.id])
                )
            ).all()
        )
        assert ids[real_tx.id] == asset.asset_id
        assert ids[plain_tx.id] == asset.asset_id
        assert ids[fake_tx.id] is None
