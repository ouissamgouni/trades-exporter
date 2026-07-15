#!/usr/bin/env python3
"""
Run the TradeTrail FastAPI application.

Usage:
    python -m backend.api.run

    Or with uvicorn directly:
    uvicorn backend.api.main:app --reload --port 8000
"""

import os
import uvicorn
import copy
from backend.config.loader import get_uvicorn_access_log_exclude_paths
from backend.core.logger import EndpointFilter

if __name__ == "__main__":
    # Get configuration from environment
    port = int(os.getenv("BACKEND_PORT", "8000"))
    reload = os.getenv("UVICORN_RELOAD", "true").lower() in ("true", "1", "yes")

    # Get access log configuration
    exclude_paths = get_uvicorn_access_log_exclude_paths()

    # Determine access_log and log_config based on configuration
    if exclude_paths is None:
        # None = Fully disable access logs
        access_log = False
        log_config = None
    elif len(exclude_paths) == 0:
        # Empty list = Enable all access logs
        access_log = True
        log_config = None
    else:
        # Has paths = Enable access logs with filtering
        access_log = True

        # Configure uvicorn logging with custom filter
        log_config = uvicorn.config.LOGGING_CONFIG
        log_config = copy.deepcopy(log_config)

        # Add our filter to the access logger
        log_config["filters"] = {
            "endpoint_filter": {
                "()": "backend.core.logger.EndpointFilter",
                "exclude_paths": exclude_paths,
            }
        }
        log_config["handlers"]["access"]["filters"] = ["endpoint_filter"]

    uvicorn.run(
        "backend.api.main:app",
        host="0.0.0.0",
        port=port,
        reload=reload,
        log_level="info",
        access_log=access_log,
        log_config=log_config,
    )
