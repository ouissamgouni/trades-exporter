"""
Base utilities for repository classes.
"""

from datetime import datetime, date
from decimal import Decimal
from typing import Any


def make_json_serializable(obj: Any) -> Any:
    """
    Recursively convert an object to JSON-serializable types.
    Handles datetime, Decimal, Pydantic models, and nested structures.
    """
    if obj is None:
        return None
    if isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: make_json_serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [make_json_serializable(item) for item in obj]
    if hasattr(obj, "model_dump"):
        # Pydantic v2 model
        return make_json_serializable(obj.model_dump())
    if hasattr(obj, "dict"):
        # Pydantic v1 model
        return make_json_serializable(obj.dict())
    # Fallback: convert to string
    return str(obj)
