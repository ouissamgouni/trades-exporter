"""
Price Service - Refactored version with cleaner architecture.

This service provides:
- Current and historical price fetching
- Automatic price getter selection by asset type
- Currency conversion with proper forex handling
- Price snapshot caching

Architecture:
- PriceService: Main API for fetching prices
- PriceGetterResolver: Resolves which price getter to use for an asset
- CurrencyConverter: Handles fiat currency conversion
"""

from datetime import datetime, date, timedelta
from decimal import Decimal
from typing import Optional, List, Tuple, Dict, Any
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from dataclasses import dataclass, field, asdict

from sqlmodel import Session, select
from sqlalchemy import case, func

from backend.config.loader import configure_logging
from backend.db.database import get_engine
from backend.db.models import (
    Asset,
    PriceSnapshot,
    AssetPriceGetter,
    AppSettings,
    NormalizedTransaction,
)
from backend.services.price_getters import (
    get_price_getter,
    BasePriceGetter,
)
from backend.services.price_getters.base import (
    PriceGetterConfig,
    PriceResult,
    PriceGetterError,
    PriceGetterAggregateError,
    PriceErrorReason,
)
from backend.services.price_getters.manual import MANUAL_GETTER_NAME

log = configure_logging("price_service")

MANUAL_FALLBACK_SEARCH_DAYS = 36500


# ============================================================================
# Asset Type to Price Getter Mapping
# ============================================================================

# Default price getters by price_type (simplified to 3 types)
# Each price type has a list of getters to try in order
ASSET_TYPE_PRICE_GETTERS: Dict[str, List[str]] = {
    "crypto": [
        "coingecko",
        "yahoo_direct",
        "yahoo",
    ],  # All crypto: tokens, stablecoins, NFTs, etc.
    "stock": [
        "yahoo_direct",
        "datareader",
        "yahoo",
    ],  # All traditional: stocks, ETFs, indices, commodities
    "fiat": ["forex"],  # Fiat currencies
}

# Fallback getter when price type is unknown
DEFAULT_GETTERS = ["yahoo_direct", "yahoo", "coingecko"]


class PriceGetterResolver:
    """
    Resolves which price getter(s) to use for an asset.

    Priority order:
    1. Explicitly configured getters (AssetPriceGetter table)
    2. Default getters based on price_type
    3. Global fallback getters
    """

    def resolve(
        self, session: Session, asset: Asset
    ) -> List[Tuple[str, PriceGetterConfig]]:
        """
        Resolve price getters for an asset.

        Args:
            session: Database session
            asset: Asset to get price getters for

        Returns:
            List of (getter_name, config) tuples in priority order
        """
        # Priority 1: Explicitly configured getters
        configured = self._get_configured_getters(session, asset.asset_id)
        if configured:
            log.debug(
                f"[PriceService] Using configured getters for {asset.symbol}: "
                f"{[g[0] for g in configured]}"
            )
            return configured

        # Priority 2-3: Asset type defaults / fallback
        defaults = self._get_default_getters(asset)
        log.debug(
            f"[PriceService] Using default getters for {asset.symbol} "
            f"(price_type={asset.price_type}): {[g[0] for g in defaults]}"
        )
        return defaults

    def _get_configured_getters(
        self, session: Session, asset_id: int
    ) -> List[Tuple[str, PriceGetterConfig]]:
        """Get explicitly configured price getters from database."""
        statement = (
            select(AssetPriceGetter)
            .where(
                AssetPriceGetter.asset_id == asset_id,
                AssetPriceGetter.enabled,
            )
            .order_by(AssetPriceGetter.priority)
        )

        asset_getters = session.exec(statement).all()

        result = []
        for apg in asset_getters:
            config = PriceGetterConfig.from_db(apg.external_id, apg.params)
            result.append((apg.price_getter, config))

        return result

    def _get_default_getters(self, asset: Asset) -> List[Tuple[str, PriceGetterConfig]]:
        """Get default price getters based on price_type."""
        if asset.symbol and asset.symbol.upper().startswith("PM:"):
            return []

        price_type = (asset.price_type or "crypto").lower()  # Default to crypto
        getter_names = ASSET_TYPE_PRICE_GETTERS.get(price_type, DEFAULT_GETTERS)

        if not getter_names:
            log.warning("no_default_price_getters", price_type=price_type)
            getter_names = DEFAULT_GETTERS

        return [(name, PriceGetterConfig()) for name in getter_names]


class CurrencyConverter:
    """
    Handles currency conversion between fiat currencies.

    Uses a dedicated forex getter to avoid circular dependencies
    when converting prices from one currency to another.
    """

    def __init__(self):
        self._forex_getter = None

    def _get_forex_getter(self) -> BasePriceGetter:
        """Lazy-load forex getter."""
        if self._forex_getter is None:
            self._forex_getter = get_price_getter("forex")
        return self._forex_getter

    def convert(
        self,
        session: Session,
        price: float,
        from_currency: str,
        to_currency: str,
        dt: Optional[datetime] = None,
    ) -> float:
        """
        Convert price from one fiat currency to another.

        Args:
            session: Database session
            price: Price in from_currency
            from_currency: Source currency symbol (e.g., "USD")
            to_currency: Target currency symbol (e.g., "EUR")
            dt: Optional datetime for historical rate

        Returns:
            Price converted to to_currency

        Raises:
            ValueError: If conversion fails
        """
        from_upper = from_currency.upper()
        to_upper = to_currency.upper()

        if from_upper == to_upper:
            return price

        log.debug(
            "converting_currency",
            price=float(price),
            from_currency=from_upper,
            to_currency=to_upper,
        )

        # Get the from_currency as an asset for the forex getter
        statement = select(Asset).where(Asset.symbol == from_upper)
        from_asset = session.exec(statement).first()

        if not from_asset:
            raise ValueError(
                f"Currency '{from_upper}' not found in assets table. "
                f"Add it as a fiat asset to enable conversion."
            )

        # Configure forex getter to return rate in to_currency
        config = PriceGetterConfig(
            external_id=from_upper, extra={"to_currency": to_upper}
        )

        try:
            # Prefer configured getter (e.g. mock) over forex when available.
            # This ensures QA/test scenarios with seeded prices don't hit
            # the real forex API for cross-currency conversion.
            apg = session.exec(
                select(AssetPriceGetter)
                .where(AssetPriceGetter.asset_id == from_asset.asset_id)
                .where(AssetPriceGetter.enabled == True)
                .order_by(AssetPriceGetter.priority)
            ).first()

            if apg and apg.price_getter != "forex":
                configured_getter = get_price_getter(apg.price_getter)
                apg_config = PriceGetterConfig.from_db(apg.external_id, apg.params)
                try:
                    if dt:
                        result = configured_getter.get_historical_price(
                            from_asset, dt, apg_config
                        )
                    else:
                        result = configured_getter.get_current_price(
                            from_asset, apg_config
                        )
                    if (
                        result.quote_currency
                        and result.quote_currency.upper() == to_upper
                    ):
                        rate = result.price
                        converted = price * rate
                        log.debug(
                            f"Converted {price} {from_upper} -> {converted} {to_upper} "
                            f"(rate: {rate}, source: {apg.price_getter})"
                        )
                        return converted
                except Exception:
                    pass  # Fall through to forex

            forex_getter = self._get_forex_getter()

            if dt:
                result = forex_getter.get_historical_price(from_asset, dt, config)
            else:
                result = forex_getter.get_current_price(from_asset, config)

            rate = result.price
            converted = price * rate

            log.debug(
                f"Converted {price} {from_upper} -> {converted} {to_upper} "
                f"(rate: {rate})"
            )
            return converted

        except Exception as e:
            raise ValueError(f"Failed to convert {from_upper} to {to_upper}: {e}")


class PriceCache:
    """
    Manages price snapshot caching in the database.
    """

    def get(
        self,
        session: Session,
        asset_id: int,
        quote_asset_id: Optional[int],
        dt: datetime,
        time_window_minutes: int = 15,
        exclude_sources: Optional[List[str]] = None,
    ) -> Optional[Decimal]:
        """
        Get cached price from price_snapshots within a time window.

        Args:
            session: Database session
            asset_id: Asset ID
            quote_asset_id: Quote asset ID
            dt: Target datetime
            time_window_minutes: Search window in minutes (±)
            exclude_sources: Source names to exclude (e.g. ["mock"])

        Returns:
            Cached price or None if not found
        """
        dt_start = dt - timedelta(minutes=time_window_minutes)
        dt_end = dt + timedelta(minutes=time_window_minutes)

        statement = select(PriceSnapshot).where(
            PriceSnapshot.asset_id == asset_id,
            PriceSnapshot.snapshot_time >= dt_start,
            PriceSnapshot.snapshot_time <= dt_end,
        )

        if quote_asset_id is not None:
            statement = statement.where(PriceSnapshot.quote_asset_id == quote_asset_id)

        if exclude_sources:
            statement = statement.where(PriceSnapshot.source.notin_(exclude_sources))

        # Manual overrides always win, then closest time
        statement = statement.order_by(
            case((PriceSnapshot.source == "manual", 0), else_=1),
            func.abs(func.extract("epoch", PriceSnapshot.snapshot_time - dt)),
        ).limit(1)

        result = session.exec(statement).first()
        if result:
            return result.price
        return None

    def get_with_source(
        self,
        session: Session,
        asset_id: int,
        quote_asset_id: Optional[int],
        dt: datetime,
        time_window_minutes: int = 15,
        exclude_sources: Optional[List[str]] = None,
    ) -> Optional[PriceSnapshot]:
        """
        Get cached price snapshot with source metadata.

        Returns the full PriceSnapshot object including source field.
        """
        dt_start = dt - timedelta(minutes=time_window_minutes)
        dt_end = dt + timedelta(minutes=time_window_minutes)

        statement = select(PriceSnapshot).where(
            PriceSnapshot.asset_id == asset_id,
            PriceSnapshot.snapshot_time >= dt_start,
            PriceSnapshot.snapshot_time <= dt_end,
        )

        if quote_asset_id is not None:
            statement = statement.where(PriceSnapshot.quote_asset_id == quote_asset_id)

        if exclude_sources:
            statement = statement.where(PriceSnapshot.source.notin_(exclude_sources))

        # Manual overrides always win, then closest time
        statement = statement.order_by(
            case((PriceSnapshot.source == "manual", 0), else_=1),
            func.abs(func.extract("epoch", PriceSnapshot.snapshot_time - dt)),
        ).limit(1)

        return session.exec(statement).first()

    def get_latest_before(
        self,
        session: Session,
        asset_id: int,
        quote_asset_id: Optional[int],
        dt: datetime,
        max_days_back: int = 7,
        exclude_sources: Optional[List[str]] = None,
    ) -> Optional[PriceSnapshot]:
        """
        Get the latest cached price before a given datetime within a max lookback window.

        Used for fallback when exact price fetch fails.

        Args:
            session: Database session
            asset_id: Asset ID
            quote_asset_id: Quote asset ID
            dt: Target datetime (search for prices before this)
            max_days_back: Maximum days to look back
            exclude_sources: Optional list of source names to exclude

        Returns:
            Latest PriceSnapshot before dt within window, or None
        """
        dt_min = dt - timedelta(days=max_days_back)

        statement = select(PriceSnapshot).where(
            PriceSnapshot.asset_id == asset_id,
            PriceSnapshot.snapshot_time <= dt,
            PriceSnapshot.snapshot_time >= dt_min,
        )

        if quote_asset_id is not None:
            statement = statement.where(PriceSnapshot.quote_asset_id == quote_asset_id)

        if exclude_sources:
            statement = statement.where(PriceSnapshot.source.notin_(exclude_sources))

        # Manual overrides always win, then most recent first
        statement = statement.order_by(
            case((PriceSnapshot.source == "manual", 0), else_=1),
            PriceSnapshot.snapshot_time.desc(),
        ).limit(1)

        return session.exec(statement).first()

    def get_latest_many(
        self,
        session: Session,
        asset_ids: List[int],
        quote_asset_id: Optional[int],
        exclude_sources: Optional[List[str]] = None,
    ) -> Dict[int, PriceSnapshot]:
        """Most recent snapshot per asset (single query)."""
        if not asset_ids:
            return {}
        rn = (
            func.row_number()
            .over(
                partition_by=PriceSnapshot.asset_id,
                order_by=PriceSnapshot.snapshot_time.desc(),
            )
            .label("rn")
        )
        inner = select(PriceSnapshot.snapshot_id, rn).where(
            PriceSnapshot.asset_id.in_(asset_ids)
        )
        if quote_asset_id is not None:
            inner = inner.where(PriceSnapshot.quote_asset_id == quote_asset_id)
        if exclude_sources:
            inner = inner.where(PriceSnapshot.source.notin_(exclude_sources))
        sub = inner.subquery()
        statement = (
            select(PriceSnapshot)
            .join(sub, PriceSnapshot.snapshot_id == sub.c.snapshot_id)
            .where(sub.c.rn == 1)
        )
        return {snap.asset_id: snap for snap in session.exec(statement).all()}

    def store(
        self,
        session: Session,
        asset_id: int,
        quote_asset_id: Optional[int],
        price: float,
        dt: datetime,
        source: str,
    ) -> PriceSnapshot:
        """Store a price snapshot in the database."""
        snapshot = PriceSnapshot(
            asset_id=asset_id,
            quote_asset_id=quote_asset_id,
            price=Decimal(str(price)),
            snapshot_time=dt,
            source=source,
        )
        session.add(snapshot)
        session.commit()
        session.refresh(snapshot)
        return snapshot


class PriceService:
    """
    Main service for fetching and caching asset prices.

    Uses:
    - PriceGetterResolver: To determine which price getter to use
    - CurrencyConverter: For fiat currency conversion
    - PriceCache: For caching price snapshots
    """

    def __init__(
        self,
        session: Optional[Session] = None,
        base_currency: Optional[str] = None,
    ):
        """
        Initialize PriceService.

        Args:
            session: Optional SQLModel session
            base_currency: Default base currency (e.g., "EUR").
                          If None, must be provided per-request.
        """
        self.default_base_currency = base_currency.upper() if base_currency else None
        self._session = session
        self._engine = None

        # Components
        self.resolver = PriceGetterResolver()
        self.converter = CurrencyConverter()
        self.cache = PriceCache()

    def _get_session(self) -> Session:
        """Get or create a database session."""
        if self._session is not None:
            return self._session
        if self._engine is None:
            self._engine = get_engine()
        return Session(self._engine)

    def _close_session(self, session: Session):
        """Close session if we created it."""
        if self._session is None:
            session.close()

    def _get_asset(self, session: Session, asset_id: int) -> Asset:
        """Get asset from database by ID."""
        asset = session.get(Asset, asset_id)
        if not asset:
            raise ValueError(f"Asset ID '{asset_id}' not found")
        return asset

    def _get_quote_asset_id(self, session: Session, quote_symbol: str) -> Optional[int]:
        """Get the asset_id for a quote currency symbol."""
        statement = select(Asset).where(Asset.symbol == quote_symbol.upper())
        quote_asset = session.exec(statement).first()
        return quote_asset.asset_id if quote_asset else None

    def _get_cache_exclude_sources(self, session: Session) -> Optional[List[str]]:
        """Return sources to exclude from cache when mock mode is off."""
        settings = session.get(AppSettings, 1)
        if settings and settings.mock_mode_enabled:
            return None  # mock mode on — don't exclude anything
        return ["mock"]  # mock mode off — exclude stale mock snapshots

    def _fetch_price(
        self,
        session: Session,
        asset: Asset,
        dt: Optional[datetime],
        price_getters: List[Tuple[str, PriceGetterConfig]],
    ) -> PriceResult:
        """
        Try to fetch price from configured price getters.

        Args:
            session: Database session
            asset: Asset to fetch price for
            dt: Datetime for historical price, None for current
            price_getters: List of (getter_name, config) to try

        Returns:
            PriceResult from first successful getter

        Raises:
            PriceGetterAggregateError: If all getters fail
        """
        errors: List[PriceGetterError] = []
        date_str = dt.strftime("%Y-%m-%d") if dt else "current"

        log.info(
            f"Fetching {date_str} price for {asset.symbol} | "
            f"Getters: {[g[0] for g in price_getters]}"
        )

        for getter_name, config in price_getters:
            try:
                price_getter = get_price_getter(getter_name)

                log.debug(f"Trying {getter_name} for {asset.symbol}...")

                if dt:
                    result = price_getter.get_historical_price(asset, dt, config)
                else:
                    result = price_getter.get_current_price(asset, config)

                log.info(
                    f"Got price for {asset.symbol} from {getter_name}: "
                    f"{result.price} {result.quote_currency}"
                )
                return result

            except PriceGetterError as e:
                log.warning(
                    f"{getter_name} failed for {asset.symbol}: "
                    f"{e.reason.value} - {e.user_message}"
                )
                errors.append(e)
            except Exception as e:
                log.warning(f"{getter_name} failed for {asset.symbol}: {e}")
                # Wrap generic exceptions
                errors.append(
                    PriceGetterError(
                        message=str(e),
                        getter_name=getter_name,
                        asset_symbol=asset.symbol,
                        original_error=e,
                    )
                )

        # All getters failed
        aggregate_error = PriceGetterAggregateError(
            asset_symbol=asset.symbol,
            errors=errors,
        )
        log.error(
            f"✗ All getters failed for {asset.symbol} ({date_str})\n"
            f"{aggregate_error.detailed_report}"
        )
        raise aggregate_error

    def get_current_price(
        self,
        asset_id: int,
        price_quote: Optional[str] = None,
    ) -> float:
        """
        Fetch current asset price.

        Args:
            asset_id: Asset ID
            price_quote: Quote currency (defaults to base_currency)

        Returns:
            Current price in quote currency
        """
        session = self._get_session()
        try:
            asset = self._get_asset(session, asset_id)
            requested_quote = (
                price_quote or self.default_base_currency or "USD"
            ).upper()

            log.info(f"get_current_price: {asset.symbol} in {requested_quote}")

            # Same currency = 1.0
            if asset.symbol.upper() == requested_quote:
                log.debug("same_currency_return_1", asset=asset.symbol)
                return 1.0

            quote_asset_id = self._get_quote_asset_id(session, requested_quote)

            # Get price getters for this asset
            price_getters = self.resolver.resolve(session, asset)

            # Fetch price
            result = self._fetch_price(session, asset, None, price_getters)
            price = result.price
            native_quote = result.quote_currency.upper()

            # Convert if needed
            if native_quote != requested_quote:
                log.info(
                    f"[PriceService] Converting {price} {native_quote} → {requested_quote}"
                )
                price = self.converter.convert(
                    session, price, native_quote, requested_quote
                )

            # Cache the result
            self.cache.store(
                session,
                asset_id,
                quote_asset_id,
                price,
                datetime.utcnow(),
                result.source,
            )

            log.info(
                f"[PriceService] ✓ Current price for {asset.symbol}: {price} {requested_quote}"
            )
            return price

        finally:
            self._close_session(session)

    def get_current_price_with_metadata(
        self,
        asset_id: int,
        price_quote: Optional[str] = None,
    ) -> PriceResult:
        """
        Fetch current asset price with full metadata (source, timestamp).

        Args:
            asset_id: Asset ID
            price_quote: Quote currency (defaults to base_currency)

        Returns:
            PriceResult with price, source, timestamp, quote_currency
        """
        session = self._get_session()
        try:
            asset = self._get_asset(session, asset_id)
            requested_quote = (
                price_quote or self.default_base_currency or "USD"
            ).upper()

            # Same currency = 1.0
            if asset.symbol.upper() == requested_quote:
                return PriceResult(
                    price=1.0,
                    quote_currency=requested_quote,
                    source="same_currency",
                    timestamp=datetime.utcnow(),
                )

            quote_asset_id = self._get_quote_asset_id(session, requested_quote)

            # Get price getters for this asset
            price_getters = self.resolver.resolve(session, asset)

            # Fetch price
            result = self._fetch_price(session, asset, None, price_getters)
            price = result.price
            native_quote = result.quote_currency.upper()

            # Convert if needed
            if native_quote != requested_quote:
                log.info(
                    f"[PriceService] Converting {price} {native_quote} → {requested_quote}"
                )
                price = self.converter.convert(
                    session, price, native_quote, requested_quote
                )

            # Cache the result
            fetched_at = datetime.utcnow()
            self.cache.store(
                session, asset_id, quote_asset_id, price, fetched_at, result.source
            )

            log.info(
                f"[PriceService] ✓ Current price for {asset.symbol}: {price} {requested_quote}"
            )

            return PriceResult(
                price=price,
                quote_currency=requested_quote,
                source=result.source,
                timestamp=fetched_at,
                ticker_used=result.ticker_used,
            )

        finally:
            self._close_session(session)

    def get_price(
        self,
        asset_id: int,
        dt: datetime,
        price_quote: Optional[str] = None,
    ) -> float:
        """
        Get asset price at specific datetime.

        Args:
            asset_id: Asset ID
            dt: Datetime for price lookup
            price_quote: Quote currency (defaults to base_currency)

        Returns:
            Price at specified datetime
        """
        session = self._get_session()
        try:
            asset = self._get_asset(session, asset_id)
            requested_quote = (
                price_quote or self.default_base_currency or "USD"
            ).upper()

            log.info(f"get_price: {asset.symbol} at {dt.date()} in {requested_quote}")

            # Same currency = 1.0
            if asset.symbol.upper() == requested_quote:
                log.debug("same_currency_return_1", asset=asset.symbol)
                return 1.0

            quote_asset_id = self._get_quote_asset_id(session, requested_quote)

            # Check cache first
            exclude = self._get_cache_exclude_sources(session)
            cached = self.cache.get(
                session, asset_id, quote_asset_id, dt, exclude_sources=exclude
            )
            if cached is not None:
                log.debug(f"Cache hit for {asset.symbol} at {dt.date()}: {cached}")
                return float(cached)

            # Get price getters for this asset
            price_getters = self.resolver.resolve(session, asset)

            # Fetch price
            result = self._fetch_price(session, asset, dt, price_getters)
            price = result.price
            native_quote = result.quote_currency.upper()

            # Convert if needed
            if native_quote != requested_quote:
                log.info(f"Converting {price} {native_quote} → {requested_quote}")
                price = self.converter.convert(
                    session, price, native_quote, requested_quote, dt
                )

            # Cache the result
            self.cache.store(
                session, asset_id, quote_asset_id, price, dt, result.source
            )

            log.info(
                f" ✓ Price for {asset.symbol} at {dt.date()}: {price} {requested_quote}"
            )
            return price

        finally:
            self._close_session(session)

    def get_price_with_source(
        self,
        asset_id: int,
        dt: datetime,
        price_quote: Optional[str] = None,
    ) -> PriceResult:
        """
        Get asset price at specific datetime with source metadata.

        Args:
            asset_id: Asset ID
            dt: Datetime for price lookup
            price_quote: Quote currency (defaults to base_currency)

        Returns:
            PriceResult with price, source, timestamp, quote_currency
        """
        session = self._get_session()
        try:
            asset = self._get_asset(session, asset_id)
            requested_quote = (
                price_quote or self.default_base_currency or "USD"
            ).upper()

            # Same currency = 1.0
            if asset.symbol.upper() == requested_quote:
                return PriceResult(
                    price=1.0,
                    quote_currency=requested_quote,
                    source="same_currency",
                    timestamp=dt,
                )

            quote_asset_id = self._get_quote_asset_id(session, requested_quote)

            # Check cache first (including source)
            exclude = self._get_cache_exclude_sources(session)
            cached_snapshot = self.cache.get_with_source(
                session, asset_id, quote_asset_id, dt, exclude_sources=exclude
            )
            if cached_snapshot is not None:
                return PriceResult(
                    price=float(cached_snapshot.price),
                    quote_currency=requested_quote,
                    source=cached_snapshot.source or "cached",
                    timestamp=cached_snapshot.snapshot_time,
                )

            # Get price getters for this asset
            price_getters = self.resolver.resolve(session, asset)

            # Fetch price
            result = self._fetch_price(session, asset, dt, price_getters)
            price = result.price
            native_quote = result.quote_currency.upper()
            source = result.source

            # Convert if needed
            if native_quote != requested_quote:
                price = self.converter.convert(
                    session, price, native_quote, requested_quote, dt
                )

            # Cache the result
            self.cache.store(session, asset_id, quote_asset_id, price, dt, source)

            return PriceResult(
                price=price,
                quote_currency=requested_quote,
                source=source,
                timestamp=dt,
                ticker_used=result.ticker_used,
            )

        finally:
            self._close_session(session)

    def get_price_with_fallback(
        self,
        asset_id: int,
        dt: datetime,
        price_quote: Optional[str] = None,
        use_fallback: bool = True,
        staleness_window_days: int = 7,
        max_timeout_seconds: Optional[int] = None,
        force_live: bool = False,
    ) -> PriceResult:
        """
        Get asset price with fallback to latest known price if fetch fails.

        This method attempts to fetch the price normally, and if that fails
        and use_fallback is True, it will look for the most recent cached
        price before the requested date.

        Args:
            asset_id: Asset ID
            dt: Datetime for price lookup
            price_quote: Quote currency (defaults to base_currency)
            use_fallback: If True, fall back to latest cached price on failure
            staleness_window_days: Max days to look back for fallback price
            max_timeout_seconds: Max seconds to wait for live fetch before falling
                back to cached price. None means no timeout (old behavior).

        Returns:
            PriceResult with price and staleness metadata:
            - is_fallback: True if fallback price was used
            - is_stale: True if fallback price is outside staleness window
            - actual_price_date: The actual date of the price used
            - staleness_days: Days between requested and actual price date
            - fallback_error: Original error that triggered fallback
        """
        session = self._get_session()
        try:
            asset = self._get_asset(session, asset_id)
            requested_quote = (
                price_quote or self.default_base_currency or "USD"
            ).upper()

            # Same currency = 1.0
            if asset.symbol.upper() == requested_quote:
                return PriceResult(
                    price=1.0,
                    quote_currency=requested_quote,
                    source="same_currency",
                    timestamp=dt,
                )

            quote_asset_id = self._get_quote_asset_id(session, requested_quote)

            # Check cache first (including source)
            exclude = self._get_cache_exclude_sources(session)
            cached_snapshot = (
                None
                if force_live
                else self.cache.get_with_source(
                    session, asset_id, quote_asset_id, dt, exclude_sources=exclude
                )
            )
            if cached_snapshot is not None:
                return PriceResult(
                    price=float(cached_snapshot.price),
                    quote_currency=requested_quote,
                    source=cached_snapshot.source or "cached",
                    timestamp=cached_snapshot.snapshot_time,
                    actual_price_date=cached_snapshot.snapshot_time,
                )

            # Get price getters for this asset
            price_getters = self.resolver.resolve(session, asset)
            stored_prices_only = bool(price_getters) and all(
                name == MANUAL_GETTER_NAME for name, _ in price_getters
            )

            original_error: Optional[str] = None
            if stored_prices_only:
                original_error = "No live price source (manual pricing)"
            else:
                try:
                    return self._fetch_price_with_timeout(
                        session,
                        asset,
                        dt,
                        price_getters,
                        requested_quote,
                        quote_asset_id,
                        max_timeout_seconds=max_timeout_seconds,
                    )

                except (PriceGetterAggregateError, FuturesTimeoutError, Exception) as e:
                    original_error = str(e)
                    if isinstance(e, FuturesTimeoutError):
                        original_error = (
                            f"Live price fetch timed out after {max_timeout_seconds}s"
                        )
                    log.warning(
                        f"Price fetch failed for {asset.symbol} at {dt.date()}: {original_error}"
                    )

                    if not use_fallback:
                        raise

            # Fallback: look for latest cached price before requested date
            # Search window = max of staleness_window * 10 or 90 days (always search wider than staleness threshold).
            # Manually priced assets have no other source, so any stored price is acceptable.
            fallback_search_days = (
                MANUAL_FALLBACK_SEARCH_DAYS
                if stored_prices_only
                else max(staleness_window_days * 10, 90)
            )
            log.info(
                f"Attempting fallback lookup for {asset.symbol}, "
                f"looking back up to {fallback_search_days} days (staleness threshold: {staleness_window_days}d)"
            )

            # Look back for any cached price within search window
            fallback_snapshot = self.cache.get_latest_before(
                session,
                asset_id,
                quote_asset_id,
                dt,
                max_days_back=fallback_search_days,
                exclude_sources=exclude,
            )

            if fallback_snapshot is None:
                # No fallback available, re-raise original error
                log.warning(
                    f"No fallback price found for {asset.symbol} before {dt.date()}"
                )
                raise PriceGetterAggregateError(
                    asset_symbol=asset.symbol,
                    errors=[
                        PriceGetterError(
                            message=f"Price fetch failed and no fallback available: {original_error}",
                            getter_name="fallback",
                            reason=PriceErrorReason.NO_DATA_RETURNED,
                            asset_symbol=asset.symbol,
                            details=f"No cached price found in DB. Original error: {original_error}",
                        )
                    ],
                )

            # Calculate staleness
            actual_price_date = fallback_snapshot.snapshot_time
            days_diff = (dt - actual_price_date).days
            is_stale = days_diff > staleness_window_days

            log.info(
                f"Using fallback price for {asset.symbol}: "
                f"{fallback_snapshot.price} from {actual_price_date.date()} "
                f"({days_diff} days ago, stale={is_stale})"
            )

            return PriceResult(
                price=float(fallback_snapshot.price),
                quote_currency=requested_quote,
                source=f"fallback:{fallback_snapshot.source or 'cached'}",
                timestamp=actual_price_date,
                is_fallback=True,
                is_stale=is_stale,
                actual_price_date=actual_price_date,
                staleness_days=days_diff,
                fallback_error=original_error,
            )

        finally:
            self._close_session(session)

    def _fetch_price_with_timeout(
        self,
        session: Session,
        asset: "Asset",
        dt: datetime,
        price_getters: list,
        requested_quote: str,
        quote_asset_id: Optional[int],
        max_timeout_seconds: Optional[int] = None,
    ) -> PriceResult:
        """
        Fetch price, convert currency, and cache — with an optional timeout.

        If max_timeout_seconds is set, the live fetch + conversion runs inside a
        thread pool with the given timeout.  On timeout a FuturesTimeoutError is
        raised so the caller can fall back to cached data.
        """

        def _do_fetch() -> PriceResult:
            result = self._fetch_price(session, asset, dt, price_getters)
            price = result.price
            native_quote = result.quote_currency.upper()
            source = result.source

            # Convert if needed
            if native_quote != requested_quote:
                price = self.converter.convert(
                    session, price, native_quote, requested_quote, dt
                )

            # Cache the result
            self.cache.store(session, asset.asset_id, quote_asset_id, price, dt, source)

            return PriceResult(
                price=price,
                quote_currency=requested_quote,
                source=source,
                timestamp=dt,
                ticker_used=result.ticker_used,
                actual_price_date=dt,
            )

        if max_timeout_seconds is None:
            return _do_fetch()

        # Run with timeout — the thread continues in the background but we
        # stop waiting and let the caller fall back to cached data.
        # NOTE: We avoid using `with` (context manager) because its __exit__
        # calls shutdown(wait=True), which blocks until the background thread
        # finishes — defeating the purpose of the timeout.
        executor = ThreadPoolExecutor(max_workers=1)
        try:
            future = executor.submit(_do_fetch)
            return future.result(timeout=max_timeout_seconds)
        finally:
            executor.shutdown(wait=False)

    def get_staleness_window_for_asset(
        self,
        session: Session,
        asset: Asset,
        default_window_days: int = 7,
    ) -> int:
        """
        Get the staleness window for an asset, checking for per-asset overrides.

        Priority:
        1. Per-asset override in AssetPriceGetter.staleness_window_days
        2. Provided default_window_days

        Args:
            session: Database session
            asset: Asset to check
            default_window_days: Default window if no override found

        Returns:
            Staleness window in days
        """
        # Check for per-asset override
        statement = (
            select(AssetPriceGetter)
            .where(
                AssetPriceGetter.asset_id == asset.asset_id,
                AssetPriceGetter.enabled,
                AssetPriceGetter.staleness_window_days.isnot(None),
            )
            .order_by(AssetPriceGetter.priority)
            .limit(1)
        )

        asset_getter = session.exec(statement).first()
        if asset_getter and asset_getter.staleness_window_days is not None:
            return asset_getter.staleness_window_days

        return default_window_days


# ============================================================================
# Gap Detection
# ============================================================================


@dataclass
class GapRange:
    """A contiguous range of missing price days."""

    start_date: str  # ISO date string
    end_date: str
    missing_days_count: int
    last_known_price: Optional[float] = None
    last_known_price_date: Optional[str] = None
    last_known_source: Optional[str] = None


@dataclass
class GapDetectionResult:
    """Result of gap analysis for a single asset."""

    asset_id: int
    symbol: str
    price_type: Optional[str]
    total_expected: int
    total_covered: int
    coverage_pct: float
    gaps: List[GapRange] = field(default_factory=list)
    has_transactions: bool = True


def _is_business_day(d: date) -> bool:
    return d.weekday() < 5  # Mon-Fri


def _expected_trading_days(
    start: date,
    end: date,
    is_crypto: bool,
) -> List[date]:
    """Return the list of expected price dates between start and end (inclusive)."""
    days: List[date] = []
    d = start
    while d <= end:
        if is_crypto or _is_business_day(d):
            days.append(d)
        d += timedelta(days=1)
    return days


def detect_gaps(
    session: Session,
    asset_id: int,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    quote_asset_id: Optional[int] = None,
) -> GapDetectionResult:
    """
    Detect price gaps for a single asset.

    For crypto assets every calendar day is expected.
    For stocks / fiat / other only business days (Mon-Fri) are expected.

    Args:
        session: DB session
        asset_id: Asset to analyse
        date_from: Override start date (default: first snapshot date)
        date_to: Override end date (default: today)
        quote_asset_id: Filter snapshots by quote currency (default: all)

    Returns:
        GapDetectionResult with coverage stats and gap ranges.
    """
    asset = session.get(Asset, asset_id)
    if not asset:
        raise ValueError(f"Asset ID {asset_id} not found")

    is_crypto = (asset.price_type or "crypto").lower() == "crypto"

    # Determine date range
    if date_from is None:
        # Use first transaction date for this asset (PnL-relevant start)
        first_tx_stmt = select(func.min(NormalizedTransaction.date_time)).where(
            NormalizedTransaction.asset_id == asset_id
        )
        first_tx_dt = session.exec(first_tx_stmt).one()
        if first_tx_dt is None:
            # No transactions → gaps are irrelevant
            return GapDetectionResult(
                asset_id=asset_id,
                symbol=asset.symbol,
                price_type=asset.price_type,
                total_expected=0,
                total_covered=0,
                coverage_pct=0.0,
                has_transactions=False,
            )
        date_from = first_tx_dt.date() if hasattr(first_tx_dt, "date") else first_tx_dt

    if date_to is None:
        date_to = date.today()

    # Collect existing price dates
    snap_stmt = (
        select(func.date(PriceSnapshot.snapshot_time))
        .where(
            PriceSnapshot.asset_id == asset_id,
            PriceSnapshot.snapshot_time
            >= datetime.combine(date_from, datetime.min.time()),
            PriceSnapshot.snapshot_time
            <= datetime.combine(date_to, datetime.max.time()),
        )
        .distinct()
    )
    if quote_asset_id is not None:
        snap_stmt = snap_stmt.where(PriceSnapshot.quote_asset_id == quote_asset_id)
    existing_dates: set[date] = set()
    for row in session.exec(snap_stmt).all():
        d = row[0] if isinstance(row, tuple) else row
        if hasattr(d, "date"):
            d = d.date()
        existing_dates.add(d)

    expected = _expected_trading_days(date_from, date_to, is_crypto)
    if not expected:
        return GapDetectionResult(
            asset_id=asset_id,
            symbol=asset.symbol,
            price_type=asset.price_type,
            total_expected=0,
            total_covered=0,
            coverage_pct=0.0,
        )

    missing = sorted(d for d in expected if d not in existing_dates)
    covered = len(expected) - len(missing)
    coverage_pct = (covered / len(expected) * 100) if expected else 0.0

    # Merge consecutive missing days into gap ranges
    #  For stocks allow a 3-day jump (covers weekends) without splitting the range.
    max_gap_jump = 1 if is_crypto else 3
    gap_ranges: List[Tuple[date, date, int]] = []
    if missing:
        g_start = missing[0]
        g_end = missing[0]
        g_count = 1
        for d in missing[1:]:
            if (d - g_end).days <= max_gap_jump:
                g_end = d
                g_count += 1
            else:
                gap_ranges.append((g_start, g_end, g_count))
                g_start = d
                g_end = d
                g_count = 1
        gap_ranges.append((g_start, g_end, g_count))

    # For each gap range, find last known price before it
    gaps: List[GapRange] = []
    for g_start, g_end, g_count in gap_ranges:
        last_snap_stmt = (
            select(PriceSnapshot)
            .where(
                PriceSnapshot.asset_id == asset_id,
                PriceSnapshot.snapshot_time
                < datetime.combine(g_start, datetime.min.time()),
            )
            .order_by(PriceSnapshot.snapshot_time.desc())
            .limit(1)
        )
        if quote_asset_id is not None:
            last_snap_stmt = last_snap_stmt.where(
                PriceSnapshot.quote_asset_id == quote_asset_id
            )
        last_snap = session.exec(last_snap_stmt).first()

        gaps.append(
            GapRange(
                start_date=g_start.isoformat(),
                end_date=g_end.isoformat(),
                missing_days_count=g_count,
                last_known_price=float(last_snap.price) if last_snap else None,
                last_known_price_date=last_snap.snapshot_time.date().isoformat()
                if last_snap
                else None,
                last_known_source=last_snap.source if last_snap else None,
            )
        )

    return GapDetectionResult(
        asset_id=asset_id,
        symbol=asset.symbol,
        price_type=asset.price_type,
        total_expected=len(expected),
        total_covered=covered,
        coverage_pct=round(coverage_pct, 2),
        gaps=gaps,
    )


# ============================================================================
# Backward Compatibility
# ============================================================================

# Legacy singleton instance
_default_service: Optional[PriceService] = None


def _get_default_service() -> PriceService:
    """Get or create default PriceService instance."""
    global _default_service
    if _default_service is None:
        # Load base currency from settings for legacy compatibility
        from backend.config.loader import load_settings

        settings = load_settings()
        base_currency = settings.get("base_currency", "EUR")
        _default_service = PriceService(base_currency=base_currency)
    return _default_service


def get_current_price(asset_id: int, price_quote: Optional[str] = None) -> float:
    """Legacy module-level function."""
    return _get_default_service().get_current_price(asset_id, price_quote)


def get_price(asset_id: int, dt: datetime, price_quote: Optional[str] = None) -> float:
    """Legacy module-level function."""
    return _get_default_service().get_price(asset_id, dt, price_quote)
