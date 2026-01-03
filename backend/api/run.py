#!/usr/bin/env python3
"""
Run the Trade Exporter FastAPI application.

Usage:
    python -m backend.api.run

    Or with uvicorn directly:
    uvicorn backend.api.main:app --reload --port 8000
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "backend.api.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
