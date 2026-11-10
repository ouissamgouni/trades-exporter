from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

from backend.connectors.base.base_connector import BalanceEntry
from backend.services.balance_service import BalanceService

REAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"
FAKE = "0xf094052b3b9d76c6c2e0f54cba92e9811a1ef5b8"
SPAM = "0x4d15e62900b9f518352a94daf6c46b11775e3697"


def _result(rows):
    return MagicMock(all=lambda: rows)


def test_other_contracts_reusing_a_ticker_stay_separate_and_visible():
    session = MagicMock()
    session.exec.side_effect = [
        _result([SimpleNamespace(contract_address=SPAM)]),  # block rules
        _result(
            [  # (symbol, contract, review_status, asset_id)
                ("VIRTUAL", REAL, "valid", 42),
                ("VIRTUAL", FAKE, "invalid", 42),
            ]
        ),
        _result(
            [
                SimpleNamespace(symbol="ETH", asset_id=1),
                SimpleNamespace(symbol="VIRTUAL", asset_id=42),
            ]
        ),
    ]
    svc = BalanceService.__new__(BalanceService)
    svc.session = session
    entries = [
        BalanceEntry("VIRTUAL", Decimal(10), contract_address=REAL),
        BalanceEntry("VIRTUAL", Decimal(25), contract_address=FAKE),
        BalanceEntry("GPM", Decimal(14), contract_address=SPAM),
        BalanceEntry("ETH", Decimal(1)),
    ]

    svc._annotate_entries(316, entries)

    real, fake, spam, eth = entries
    assert len(entries) == 4
    assert (real.asset_id, real.match_symbol, real.spam_reason) == (42, None, None)
    assert fake.asset_id is None and fake.spam_reason == "rejected_transactions"
    assert fake.match_symbol.startswith("VIRTUAL (0xf094")
    assert spam.spam_reason == "spam_rule" and spam.match_symbol
    assert (eth.asset_id, eth.match_symbol) == (1, None)
