"""
Flag existing unsolicited incoming transfers of unpriced tokens as suspected spam.

Dry-run by default; pass --apply to write. Only connectors whose type supports the
heuristic (ConnectorInfo.detects_unsolicited_spam) are scanned.

    python -m backend.scripts.flag_suspected_spam [--connector-id 697 ...] [--apply]
"""

import argparse
from collections import Counter

from sqlmodel import select

from backend.config.loader import configure_logging
from backend.connectors.connector_registry import get_connector_registry
from backend.db.database import get_session
from backend.db.models import AccountConnector
from backend.services.spam_heuristic_service import scan_suspected_spam

log = configure_logging("flag_suspected_spam")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connector-id", type=int, action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    registry = get_connector_registry()
    with get_session() as session:
        connectors = session.exec(select(AccountConnector)).all()
        for c in connectors:
            if args.connector_id and c.id not in args.connector_id:
                continue
            info = registry.get(c.connector_type)
            if not info or not info.detects_unsolicited_spam:
                continue
            flagged = scan_suspected_spam(
                session, connector_id=c.id, dry_run=not args.apply
            )
            symbols = Counter(tx.source_asset_symbol for tx in flagged)
            log.info(
                "connector_scanned",
                connector_id=c.id,
                connector_type=c.connector_type,
                flagged=len(flagged),
                top_symbols=symbols.most_common(10),
                applied=args.apply,
            )


if __name__ == "__main__":
    main()
