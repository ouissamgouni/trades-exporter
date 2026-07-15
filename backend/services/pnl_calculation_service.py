"""
PnL Calculation Service - Background P&L calculation with stale detection.

Singleton service that:
- Tracks whether existing P&L results are stale (data changed since last calculation)
- Runs P&L calculations in a background thread when triggered
- Manages auto-draft lifecycle (old auto-draft kept until new one succeeds)
- Provides status for frontend polling

Not auto-triggered — only runs when user clicks "Refresh" or the system explicitly calls start_calculation().
The stale flag is set by the SQLAlchemy after_flush listener when P&L-relevant data changes.
"""

import threading
import traceback
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Optional, List

from sqlalchemy import text

from backend.config.loader import configure_logging

log = configure_logging("pnl_calculation_service")


class PnLCalcStatus(str, Enum):
    """Status of the P&L calculation service."""
    IDLE = "idle"             # No calculation has ever been run
    STALE = "stale"           # Data changed since last calculation
    CALCULATING = "calculating"  # Calculation in progress
    COMPLETED = "completed"   # Latest calculation is up to date
    ERROR = "error"           # Last calculation failed


# Maximum stale reasons to keep (avoid unbounded memory)
MAX_STALE_REASONS = 20


class PnLCalculationService:
    """
    Singleton service for managing background P&L calculations.
    
    Thread-safe: all state mutations are guarded by a threading.Lock.
    Uses a daemon thread for background calculation (like SyncJobService).
    """

    _instance: Optional["PnLCalculationService"] = None
    _lock_class = threading.Lock()

    @classmethod
    def get_instance(cls) -> "PnLCalculationService":
        """Get or create the singleton instance."""
        with cls._lock_class:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    @classmethod
    def reset_instance(cls):
        """Reset singleton (for testing)."""
        with cls._lock_class:
            if cls._instance is not None:
                cls._instance.shutdown()
            cls._instance = None

    def __init__(self):
        self._lock = threading.Lock()
        
        # State
        self._status: PnLCalcStatus = PnLCalcStatus.IDLE
        self._is_stale: bool = True  # Assume stale on startup
        self._stale_since: Optional[datetime] = datetime.now(timezone.utc)
        self._stale_reasons: List[str] = ["Server started"]
        self._current_version_id: Optional[int] = None
        self._last_calculated_at: Optional[datetime] = None
        self._error_message: Optional[str] = None
        
        # Thread management
        self._calculation_thread: Optional[threading.Thread] = None
        self._shutting_down: bool = False

    def mark_stale(self, reason: str) -> None:
        """
        Mark P&L as stale due to a data change.
        
        Called by the SQLAlchemy after_flush listener when P&L-relevant
        models are modified. Only flags — does NOT trigger calculation.
        
        Args:
            reason: Human-readable reason (e.g., "NormalizedTransaction created (×3)")
        """
        with self._lock:
            if not self._is_stale:
                self._stale_since = datetime.now(timezone.utc)
                self._stale_reasons = []
            
            self._is_stale = True
            
            # Accumulate reasons (capped)
            if len(self._stale_reasons) < MAX_STALE_REASONS:
                self._stale_reasons.append(reason)
            elif len(self._stale_reasons) == MAX_STALE_REASONS:
                self._stale_reasons.append("... and more changes")
            
            # Update status (don't override "calculating")
            if self._status != PnLCalcStatus.CALCULATING:
                self._status = PnLCalcStatus.STALE
            
            log.info("pnl_marked_stale", reason=reason)

    def start_calculation(self, trigger: str = "refresh") -> bool:
        """
        Start a background P&L calculation.
        
        Called by the refresh endpoint or programmatically.
        Returns False if a calculation is already running.
        
        Args:
            trigger: "refresh" (user clicked refresh) or "auto" (system-initiated)
            
        Returns:
            True if calculation was started, False if already running
        """
        with self._lock:
            if self._status == PnLCalcStatus.CALCULATING:
                log.info("pnl_calculation_already_running")
                return False
            
            if self._shutting_down:
                log.info("pnl_service_shutting_down")
                return False
            
            self._status = PnLCalcStatus.CALCULATING
            self._error_message = None
            # Clear pre-existing stale flag so end-of-calculation check
            # only detects NEW changes that arrive during calculation.
            self._is_stale = False
            self._stale_since = None
            self._stale_reasons = []
        
        # Start background thread
        self._calculation_thread = threading.Thread(
            target=self._run_calculation,
            args=(trigger,),
            daemon=True,
            name="pnl-calculation",
        )
        self._calculation_thread.start()
        log.info("pnl_calculation_started", trigger=trigger)
        return True

    def _run_calculation(self, trigger: str) -> None:
        """
        Background thread: run P&L calculation using default config from AppSettings.
        
        Flow:
        1. Load default config from AppSettings
        2. Run PnLEngine.calculate()
        3. Persist as draft with trigger type
        4. On success: delete previous auto-draft, update state
        5. On error: keep previous auto-draft, set error state
        """
        import time
        start_time = time.perf_counter()
        previous_auto_version_id = None
        
        try:
            from sqlmodel import Session, select
            from backend.db.database import get_engine
            from backend.db.models import AppSettings, Asset, CalculationVersion
            from backend.services.pnl.engine import PnLEngine
            from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
            from backend.services.price_service import PriceService
            
            engine = get_engine()
            with Session(engine) as session:
                # Load default P&L config from AppSettings
                settings = session.get(AppSettings, 1)
                if not settings:
                    raise ValueError("AppSettings not found — run setup first")
                
                # Resolve base currency asset
                base_currency = session.exec(
                    select(Asset).where(Asset.symbol == settings.base_currency)
                ).first()
                if not base_currency:
                    raise ValueError(f"Base currency '{settings.base_currency}' not found in assets")
                
                # Build PnLConfig from defaults
                config = PnLConfig(
                    lot_method=CostMethod(settings.pnl_lot_method),
                    lot_mode=LotMode(settings.pnl_lot_mode),
                    base_currency_id=base_currency.asset_id,
                    base_currency_symbol=base_currency.symbol,
                    residual_tolerance_pct=Decimal(str(settings.pnl_residual_tolerance_pct)),
                    allow_negative_balances=settings.pnl_allow_negative_balances,
                    compute_residuals=settings.pnl_compute_residuals,
                    crypto_swap_taxable_by_default=settings.pnl_crypto_swap_taxable,
                    fee_taxable_by_default=settings.pnl_fee_taxable,
                    use_price_fallback=settings.pnl_use_price_fallback,
                    price_staleness_window_days=settings.pnl_price_staleness_days,
                )
                
                # Remember previous auto-draft for cleanup after success
                with self._lock:
                    previous_auto_version_id = self._current_version_id
                
                # Run P&L calculation
                price_service = PriceService(session=session)
                pnl_engine = PnLEngine(session=session, price_service=price_service, config=config)
                result = pnl_engine.calculate()
                
                # Persist as draft
                version = pnl_engine.persist_results(result, status="draft", expires_in_hours=24)
                version.trigger = trigger
                session.add(version)
                session.commit()
                
                new_version_id = version.version_id
                elapsed = time.perf_counter() - start_time
                
                log.info(
                    "pnl_calculation_complete",
                    version_id=new_version_id,
                    trigger=trigger,
                    elapsed_seconds=round(elapsed, 2),
                    units_processed=len(result.calculation_units),
                    total_pnl=float(result.total_realized_pnl),
                )
                
                # Delete previous auto-draft (only auto/refresh triggers, not manual)
                if previous_auto_version_id and previous_auto_version_id != new_version_id:
                    old_version = session.get(CalculationVersion, previous_auto_version_id)
                    if old_version and old_version.trigger in ("auto", "refresh") and old_version.status == "draft":
                        # Clear self-referencing FKs before cascade delete
                        session.exec(
                            text(
                                "UPDATE cost_lots SET settled_by_lot_id = NULL, source_lot_id = NULL "
                                "WHERE unit_id IN ("
                                "  SELECT id FROM calculation_units WHERE version_id = :vid"
                                ")"
                            ).bindparams(vid=previous_auto_version_id)
                        )
                        session.delete(old_version)
                        session.commit()
                        log.info("pnl_old_auto_draft_deleted", old_version_id=previous_auto_version_id)
                
                # Update state on success
                with self._lock:
                    self._current_version_id = new_version_id
                    self._last_calculated_at = datetime.now(timezone.utc)
                    self._error_message = None
                    # Clear stale only if no new changes arrived during calculation
                    # Check if still stale (new mark_stale() calls during calculation)
                    if self._is_stale:
                        # New changes came in during calculation — stay stale
                        self._status = PnLCalcStatus.STALE
                        log.info("pnl_still_stale_after_calculation", reason="new changes during calculation")
                    else:
                        self._status = PnLCalcStatus.COMPLETED
                    # The stale reasons were for this calculation, clear them
                    # If new stale reasons came in, they'll be re-added by mark_stale
                    self._is_stale = False
                    self._stale_reasons = []
        
        except Exception as e:
            elapsed = time.perf_counter() - start_time
            error_msg = f"{type(e).__name__}: {str(e)}"
            log.exception("pnl_calculation_failed", error=error_msg, elapsed_seconds=round(elapsed, 2))
            
            with self._lock:
                self._status = PnLCalcStatus.ERROR
                self._error_message = error_msg
                # Keep is_stale=True so user knows to retry
                self._is_stale = True

    def get_status(self) -> dict:
        """
        Get current calculation status for API response.
        
        Returns:
            Dict with status, staleness info, version, timing, and error info
        """
        with self._lock:
            return {
                "status": self._status.value,
                "is_stale": self._is_stale,
                "stale_since": self._stale_since.isoformat() if self._stale_since else None,
                "stale_reasons": list(self._stale_reasons),
                "current_version_id": self._current_version_id,
                "last_calculated_at": self._last_calculated_at.isoformat() if self._last_calculated_at else None,
                "error": self._error_message,
            }

    def shutdown(self) -> None:
        """Clean shutdown — let current calculation finish."""
        with self._lock:
            self._shutting_down = True
        
        if self._calculation_thread and self._calculation_thread.is_alive():
            log.info("pnl_service_waiting_for_calculation_thread")
            self._calculation_thread.join(timeout=5)
