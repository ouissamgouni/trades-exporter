"""
Suggestion fingerprint utility.

Provides a deterministic, stable identifier for bundle suggestions
based on (pattern, sorted transaction IDs). Used to track dismissed suggestions.
"""

import hashlib
from typing import List


def compute_suggestion_fingerprint(pattern: str, transaction_ids: List[int]) -> str:
    """
    Compute a stable fingerprint for a suggestion.

    The fingerprint is a truncated SHA-256 hash of the pattern and sorted
    transaction IDs. This ensures:
    - Same inputs always produce the same fingerprint (deterministic)
    - Order of transaction IDs doesn't matter (sorted before hashing)
    - Different patterns with the same tx IDs produce different fingerprints

    Args:
        pattern: The suggestion pattern (e.g., 'internal_transfer', 'swap')
        transaction_ids: List of transaction IDs in the suggestion

    Returns:
        16-character hex string (64 bits of entropy)
    """
    sorted_ids = sorted(transaction_ids)
    payload = f"{pattern}:{','.join(str(tid) for tid in sorted_ids)}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]
