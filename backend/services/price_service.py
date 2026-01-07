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

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Optional, List, Tuple, Dict

from sqlmodel import Session, select
from sqlalchemy import func

from backend.config.loader import configure_logging
from backend.db.database import get_engine
from backend.db.models import Asset, PriceSnapshot, AssetPriceGetter
from backend.services.price_getters import (
    get_price_getter,
    BasePriceGetter,
)
from backend.services.price_getters.base import (
    PriceGetterConfig,
    PriceResult,
    PriceGetterError,
    PriceGetterAggregateError,
)

log = configure_logging("price_service")


# ============================================================================
# Asset Type to Price Getter Mapping
# ============================================================================

# Default price getters by price_type (simplified to 3 types)
# Each price type has a list of getters to try in order
ASSET_TYPE_PRICE_GETTERS: Dict[str, List[str]] = {
    "crypto": ["coingecko", "yahoo"],  # All crypto: tokens, stablecoins, NFTs, etc.
    "stock": ["datareader", "yahoo"],  # All traditional: stocks, ETFs, indices, commodities
    "fiat": ["forex"],  # Fiat currencies
}

# Fallback getter when price type is unknown
DEFAULT_GETTERS = ["yahoo", "coingecko"]


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
        # First check for explicitly configured getters
        configured = self._get_configured_getters(session, asset.asset_id)
        if configured:
            log.debug(
                f"[PriceService] Using configured getters for {asset.symbol}: "
                f"{[g[0] for g in configured]}"
            )
            return configured
        
        # Fall back to asset type defaults
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

    def _get_default_getters(
        self, asset: Asset
    ) -> List[Tuple[str, PriceGetterConfig]]:
        """Get default price getters based on price_type."""
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
        
        log.debug("converting_currency", price=float(price), from_currency=from_upper, to_currency=to_upper)
        
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
            external_id=from_upper,
            extra={"to_currency": to_upper}
        )
        
        try:
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
            raise ValueError(
                f"Failed to convert {from_upper} to {to_upper}: {e}"
            )


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
    ) -> Optional[Decimal]:
        """
        Get cached price from price_snapshots within a time window.
        
        Args:
            session: Database session
            asset_id: Asset ID
            quote_asset_id: Quote asset ID
            dt: Target datetime
            time_window_minutes: Search window in minutes (±)
            
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
            statement = statement.where(
                PriceSnapshot.quote_asset_id == quote_asset_id
            )
        
        # Order by closest time
        statement = statement.order_by(
            func.abs(func.extract("epoch", PriceSnapshot.snapshot_time - dt))
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
            statement = statement.where(
                PriceSnapshot.quote_asset_id == quote_asset_id
            )
        
        # Order by closest time
        statement = statement.order_by(
            func.abs(func.extract("epoch", PriceSnapshot.snapshot_time - dt))
        ).limit(1)
        
        return session.exec(statement).first()

    def get_latest_before(
        self,
        session: Session,
        asset_id: int,
        quote_asset_id: Optional[int],
        dt: datetime,
        max_days_back: int = 7,
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
            statement = statement.where(
                PriceSnapshot.quote_asset_id == quote_asset_id
            )
        
        # Order by most recent first
        statement = statement.order_by(
            PriceSnapshot.snapshot_time.desc()
        ).limit(1)
        
        return session.exec(statement).first()

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

    def _get_quote_asset_id(
        self, session: Session, quote_symbol: str
    ) -> Optional[int]:
        """Get the asset_id for a quote currency symbol."""
        statement = select(Asset).where(Asset.symbol == quote_symbol.upper())
        quote_asset = session.exec(statement).first()
        return quote_asset.asset_id if quote_asset else None

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
                
                log.debug(
                    f"Trying {getter_name} for {asset.symbol}..."
                )
                
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
                log.warning(
                    f"{getter_name} failed for {asset.symbol}: {e}"
                )
                # Wrap generic exceptions
                errors.append(PriceGetterError(
                    message=str(e),
                    getter_name=getter_name,
                    asset_symbol=asset.symbol,
                    original_error=e,
                ))
        
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
            
            log.info(
                f"get_current_price: {asset.symbol} in {requested_quote}"
            )
            
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
                session, asset_id, quote_asset_id, price,
                datetime.utcnow(), result.source
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
                session, asset_id, quote_asset_id, price,
                fetched_at, result.source
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
            
            log.info(
                f"get_price: {asset.symbol} at {dt.date()} in {requested_quote}"
            )
            
            # Same currency = 1.0
            if asset.symbol.upper() == requested_quote:
                log.debug("same_currency_return_1", asset=asset.symbol)
                return 1.0
            
            quote_asset_id = self._get_quote_asset_id(session, requested_quote)
            
            # Check cache first
            cached = self.cache.get(session, asset_id, quote_asset_id, dt)
            if cached is not None:
                log.debug(
                    f"Cache hit for {asset.symbol} at {dt.date()}: {cached}"
                )
                return float(cached)
            
            # Get price getters for this asset
            price_getters = self.resolver.resolve(session, asset)
            
            # Fetch price
            result = self._fetch_price(session, asset, dt, price_getters)
            price = result.price
            native_quote = result.quote_currency.upper()
            
            # Convert if needed
            if native_quote != requested_quote:
                log.info(
                    f"Converting {price} {native_quote} → {requested_quote}"
                )
                price = self.converter.convert(
                    session, price, native_quote, requested_quote, dt
                )
            
            # Cache the result
            self.cache.store(
                session, asset_id, quote_asset_id, price, dt, result.source
            )
            
            log.info(
                f" ✓ Price for {asset.symbol} at {dt.date()}: "
                f"{price} {requested_quote}"
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
            cached_snapshot = self.cache.get_with_source(session, asset_id, quote_asset_id, dt)
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
            self.cache.store(
                session, asset_id, quote_asset_id, price, dt, source
            )
            
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
            cached_snapshot = self.cache.get_with_source(session, asset_id, quote_asset_id, dt)
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
            
            # Try to fetch price normally
            original_error: Optional[str] = None
            try:
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
                self.cache.store(
                    session, asset_id, quote_asset_id, price, dt, source
                )
                
                return PriceResult(
                    price=price,
                    quote_currency=requested_quote,
                    source=source,
                    timestamp=dt,
                    ticker_used=result.ticker_used,
                    actual_price_date=dt,
                )
                
            except (PriceGetterAggregateError, Exception) as e:
                original_error = str(e)
                log.warning(
                    f"Price fetch failed for {asset.symbol} at {dt.date()}: {original_error}"
                )
                
                if not use_fallback:
                    raise
            
            # Fallback: look for latest cached price before requested date
            log.info(
                f"Attempting fallback lookup for {asset.symbol}, "
                f"looking back up to {staleness_window_days} days"
            )
            
            # Look back for any cached price (use large window for fallback search)
            fallback_snapshot = self.cache.get_latest_before(
                session, asset_id, quote_asset_id, dt, max_days_back=365  # Search up to 1 year
            )
            
            if fallback_snapshot is None:
                # No fallback available, re-raise original error
                log.warning(
                    f"No fallback price found for {asset.symbol} before {dt.date()}"
                )
                raise PriceGetterAggregateError(
                    asset_symbol=asset.symbol,
                    errors=[PriceGetterError(
                        message=f"Price fetch failed and no fallback available: {original_error}",
                        getter_name="fallback",
                        asset_symbol=asset.symbol,
                    )],
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


def get_price(
    asset_id: int, dt: datetime, price_quote: Optional[str] = None
) -> float:
    """Legacy module-level function."""
    return _get_default_service().get_price(asset_id, dt, price_quote)
