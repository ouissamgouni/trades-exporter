"""Unit tests for contract-aware raw asset keys and mapping suggestions."""

from unittest.mock import MagicMock

from backend.db.models import Asset
from backend.db.repositories.raw_asset_repository import normalize_contract, token_key
from backend.services import asset_contract_suggestions as svc

EVM = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"


def _result(rows):
    r = MagicMock()
    r.all.return_value = rows
    return r


def test_token_key_normalizes_evm_and_keeps_case_sensitive_addresses():
    assert normalize_contract(EVM) == EVM.lower()
    assert normalize_contract(SOL) == SOL
    assert token_key("Base", EVM) == ("base", EVM.lower())
    assert token_key("base", "") == ("", "")


def test_known_contract_wins(monkeypatch):
    monkeypatch.setattr(
        svc.RawAssetRepository, "known_contract_asset_id", lambda self, n, c: 7
    )
    session = MagicMock()
    session.get.return_value = Asset(asset_id=7, symbol="USDC")
    s = svc.suggest_asset_for_contract(session, "USDC", "base", EVM)
    assert (s.id, s.confidence, s.reason) == (7, 1.0, "known_contract")


def test_official_deployment_via_coingecko(monkeypatch):
    monkeypatch.setattr(
        svc.RawAssetRepository, "known_contract_asset_id", lambda self, n, c: None
    )
    monkeypatch.setattr(
        svc,
        "coingecko_platforms",
        lambda coin_id: {"base": EVM} if coin_id == "usd-coin" else {},
    )
    session = MagicMock()
    session.exec.side_effect = [
        _result([Asset(asset_id=3, symbol="USDC")]),
        _result(["usd-coin"]),
    ]
    s = svc.suggest_asset_for_contract(session, "usdc", "base", EVM.lower())
    assert (s.id, s.confidence, s.reason) == (3, 0.95, "official_deployment")


def test_same_symbol_unknown_contract_is_low_confidence(monkeypatch):
    monkeypatch.setattr(
        svc.RawAssetRepository, "known_contract_asset_id", lambda self, n, c: None
    )
    monkeypatch.setattr(svc, "coingecko_platforms", lambda coin_id: {"base": EVM})
    session = MagicMock()
    session.exec.side_effect = [
        _result([Asset(asset_id=250, symbol="VIRTUAL")]),
        _result(["virtual-protocol"]),
    ]
    fake = "0xf094052b3b9d76c6c2e0f54cba92e9811a1ef5b8"
    s = svc.suggest_asset_for_contract(session, "VIRTUAL", "base", fake)
    assert (s.id, s.reason) == (250, "unverified_contract")
    assert s.confidence < 0.7  # below the "Apply all" threshold


def test_no_contract_no_suggestion():
    assert svc.suggest_asset_for_contract(MagicMock(), "BTC", None, None) is None
