"""Unit tests for P&L warning triage, transfer-issue dismissal tags and bundle health helpers."""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from backend.db.models import PnlWarning
from backend.services.pnl import warning_status as ws


def _warning(wtype="provisional_cost_lot", details=None, tx_id=9839, asset_id=7):
    return PnlWarning(warning_type=wtype, message="m", transaction_id=tx_id, asset_id=asset_id, details=details)


class TestWarningAnnotation:
    def test_tiny_provisional_lot_is_dust(self):
        w = _warning(details={"fmv_value": 2.2e-8})
        ws.annotate_warnings([w], Decimal("0.01"))
        assert w.details["severity"] == ws.STATUS_DUST
        assert w.details["fingerprint"] == "0.00"

    def test_unsettled_negative_lot_value_from_qty_and_cost(self):
        w = _warning("unsettled_negative_lot", {"negative_lot_qty": -10.0, "unit_cost": 0.9})
        ws.annotate_warnings([w], Decimal("0.01"))
        assert "severity" not in w.details
        assert w.details["value_in_base"] == 9.0
        assert w.details["fingerprint"] == "9.00"

    def test_unknown_value_is_never_dust(self):
        w = _warning("missing_price", {"error": "no price"})
        ws.annotate_warnings([w], Decimal("0.01"))
        assert "severity" not in w.details
        assert w.details["fingerprint"] == ""

    def test_status_prefers_acknowledged_over_dust(self):
        w = _warning(details={"severity": "dust", "fingerprint": "0.00"})
        acked = {ws.ack_key(w.warning_type, w.transaction_id, w.asset_id, "0.00")}
        assert ws.warning_status(w, acked) == ws.STATUS_ACKNOWLEDGED
        assert ws.warning_status(w, set()) == ws.STATUS_DUST

    def test_changed_amount_no_longer_matches_ack(self):
        w = _warning(details={"fingerprint": "12.50"})
        acked = {ws.ack_key(w.warning_type, w.transaction_id, w.asset_id, "0.00")}
        assert ws.warning_status(w, acked) == ws.STATUS_OPEN

    def test_status_clause_all_has_no_filter(self):
        assert ws.status_clause(ws.STATUS_ALL) is None
        assert ws.status_clause(ws.STATUS_OPEN) is not None


class TestTransferDismissalTags:
    def test_strip_removes_new_and_legacy_formats_for_field(self):
        from backend.api.routes.transactions import _strip_transfer_dismissal, _transfer_dismissal_tag

        tags = [
            {"note": "keep"},
            {"sys_transfer_dismissed": "source_to_account"},
            {"sys_transfer_dismissed": "true"},
            {"sys_dismissed_field": "source_from_account"},
            {"sys_dismissed_at": "2026-01-01"},
        ]
        assert _strip_transfer_dismissal(tags, "source_from_account") == [
            {"note": "keep"},
            {"sys_transfer_dismissed": "source_to_account"},
        ]
        assert _strip_transfer_dismissal(tags, "source_to_account")[0] == {"note": "keep"}

        tag = _transfer_dismissal_tag("source_to_account", "bank")
        assert tag["sys_transfer_dismissed"] == "source_to_account"
        assert tag["sys_dismissed_reason"] == "bank"


class TestBundleHealthHelpers:
    @staticmethod
    def _bundle(pattern):
        return SimpleNamespace(pattern=pattern)

    @staticmethod
    def _tx(direction):
        return SimpleNamespace(direction=direction)

    def test_issue_detection(self):
        from backend.services.bundle_health import BundleHealthService as S

        assert S._issue_for(self._bundle("internal_transfer"), []) == "empty"
        assert S._issue_for(self._bundle("internal_transfer"), [self._tx("outflow")]) == "missing_inflow"
        assert S._issue_for(self._bundle("internal_transfer"), [self._tx("inflow")]) == "missing_outflow"
        assert S._issue_for(self._bundle("internal_transfer"), [self._tx("inflow"), self._tx("outflow")]) is None
        assert S._issue_for(self._bundle("flow"), [self._tx("outflow")]) is None

    def test_reason_formatting(self):
        from backend.services.bundle_health import _format_reason

        assert _format_reason(61, Decimal("0.032177"), "USDC") == "61s apart, fee 0.032177 USDC"
        assert _format_reason(5400, Decimal("0"), "USDC").startswith("90min apart")
