from pathlib import Path

p = Path(__file__).parent / "services" / "price_service.py"
s = p.read_text()


def rep(old, new):
    global s
    assert s.count(old) == 1, old[:80]
    s = s.replace(old, new)


rep(
    """        return session.exec(statement).first()

    def store(
""",
    '''        return session.exec(statement).first()

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
''',
)

rep(
    '''        max_timeout_seconds: Optional[int] = None,
    ) -> PriceResult:
        """
        Get asset price with fallback to latest known price if fetch fails.
''',
    '''        max_timeout_seconds: Optional[int] = None,
        force_live: bool = False,
    ) -> PriceResult:
        """
        Get asset price with fallback to latest known price if fetch fails.
''',
)

rep(
    """            # Check cache first (including source)
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
                    actual_price_date=cached_snapshot.snapshot_time,""",
    """            # Check cache first (including source)
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
                    actual_price_date=cached_snapshot.snapshot_time,""",
)

p.write_text(s)
print("ok")
