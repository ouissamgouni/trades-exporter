from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from backend.services.grouping_engine import GroupingSuggestion
from backend.services.suggestion_service import SuggestionService


def _tx(tx_id, bundle_id=None):
    return SimpleNamespace(id=tx_id, user_calculation_unit_id=bundle_id)


def _sugg(*ids):
    return GroupingSuggestion(
        pattern="internal_transfer",
        label="t",
        reason="r",
        confidence=0.9,
        transactions=[{"id": i} for i in ids],
    )


def test_broken_bundle_members_only_suggested_to_complete_their_bundle():
    svc = SuggestionService(MagicMock())
    svc.dismissed_repo = MagicMock(get_dismissed_fingerprints=lambda: set())
    txs = [_tx(1, 7), _tx(2), _tx(3), _tx(4, 7), _tx(5, 8), _tx(6)]
    svc.engine = MagicMock(
        suggest_groups=lambda _: [
            _sugg(1, 2),  # completes bundle 7
            _sugg(2, 3),  # standalone only
            _sugg(1, 4),  # already all in bundle 7
            _sugg(4, 5),  # spans two bundles
        ]
    )
    with patch.object(svc, "_broken_bundle_ids", return_value={7, 8}), patch.object(
        svc, "_get_standalone_transactions", return_value=txs
    ):
        result = svc.get_suggestions()

    by_ids = {tuple(s.transaction_ids): s.existing_bundle_id for s in result}
    assert by_ids == {(1, 2): 7, (2, 3): None}
