"""Services module for TradeTrail."""

# PriceService disabled until migration to PostgreSQL repositories is complete
# from backend.services.price_service import PriceService

from backend.services.connector_loader_service import ConnectorLoaderService

# Lazy imports to avoid circular dependency:
#   connectors → db → repositories → services → sync_job_service → connectors
# SyncJobService and get_sync_job_service are imported on first access.


def __getattr__(name):
    if name == "SyncJobService":
        from backend.services.sync_job_service import SyncJobService

        return SyncJobService
    if name == "get_sync_job_service":
        from backend.services.sync_job_service import get_sync_job_service

        return get_sync_job_service
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "ConnectorLoaderService",
    "SyncJobService",
    "get_sync_job_service",
]
