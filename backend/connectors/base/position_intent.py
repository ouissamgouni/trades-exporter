"""
PositionIntent — Typed contract between connectors and the DerivativePositionStage.

Replaces the untyped _position_data dict that was embedded in tags[0].
Connectors create a PositionIntent to declare their intent for derivative
position lifecycle management. The DerivativePositionStage reads this to
create/update/close positions.

Usage in a connector's raw_to_normalized():
    from backend.connectors.base.position_intent import PositionIntent

    intent = PositionIntent(
        coin="ETH",
        side="long",
        action="open",
        size=Decimal("1.0"),
        execution_price=Decimal("3000.0"),
        is_new_position=True,
    )
    tag_data["_position_data"] = intent.to_dict()
"""

from dataclasses import dataclass, asdict
from decimal import Decimal


@dataclass
class PositionIntent:
    """
    Formal contract for derivative position data embedded by connectors.

    Fields:
        coin: Asset symbol (e.g. "BTC", "ETH", "ZEC").
        side: Position side — "long" or "short".
        action: What this fill represents — "open", "close", or "add".
            - "open": Opening a brand-new position (is_new_position=True) or
              adding to an existing one (is_new_position=False).
            - "close": Partially or fully closing an existing position.
        size: Fill size in the coin's base unit.
        execution_price: Execution price for this fill.
        realized_pnl: Realized P&L for close fills. Defaults to 0.
        margin_currency: Settlement/margin asset. Defaults to "USDC".
        is_new_position: Explicit flag — True means this opens a brand-new
            position (replaces the Hyperliquid-specific start_position=="0"
            heuristic). Defaults to False.
    """

    coin: str
    side: str  # "long" / "short"
    action: str  # "open" / "close"
    size: Decimal
    execution_price: Decimal
    realized_pnl: Decimal = Decimal(0)
    margin_currency: str = "USDC"
    is_new_position: bool = False

    def to_dict(self) -> dict:
        """Serialize to a plain dict for embedding in NT tags."""
        d = asdict(self)
        # Convert Decimals to strings for JSON serialization
        for key in ("size", "execution_price", "realized_pnl"):
            d[key] = str(d[key])
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "PositionIntent":
        """Deserialize from a dict (as stored in tags)."""
        return cls(
            coin=d["coin"],
            side=d["side"],
            action=d["action"],
            size=Decimal(str(d["size"])),
            execution_price=Decimal(str(d["execution_price"])),
            realized_pnl=Decimal(str(d.get("realized_pnl", "0"))),
            margin_currency=d.get("margin_currency", "USDC"),
            is_new_position=d.get("is_new_position", False),
        )

    @classmethod
    def from_legacy_dict(cls, d: dict) -> "PositionIntent":
        """
        Convert the legacy _position_data format to PositionIntent.

        Legacy format (from HyperliquidPerpsConnector pre-refactor):
            {
                "coin": "ETH", "side": "long",
                "entry_price": "3000.0", "size": "1.0",
                "closed_pnl": "0.0", "start_position": "0.0",
                "is_open": True, "is_close": False,
            }
        """
        is_open = d.get("is_open", False)
        is_close = d.get("is_close", False)
        start_position = d.get("start_position", "0")

        if is_close:
            action = "close"
        else:
            action = "open"

        is_new = is_open and start_position in ("0", "0.0", "0.00")

        return cls(
            coin=d["coin"],
            side=d["side"],
            action=action,
            size=Decimal(str(d["size"])),
            execution_price=Decimal(str(d.get("entry_price", d.get("execution_price", "0")))),
            realized_pnl=Decimal(str(d.get("closed_pnl", d.get("realized_pnl", "0")))),
            margin_currency=d.get("margin_currency", "USDC"),
            is_new_position=is_new,
        )
