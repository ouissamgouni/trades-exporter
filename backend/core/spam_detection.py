"""
Spam and phishing token detection utilities.

Provides reusable heuristics to detect phishing/scam ERC-20 token transfers 
during normalization. Covers both Moralis and Blockscout API data formats.

Detection signals:
  - Unicode confusable characters in token names/symbols (e.g., Lisu ꓴꓢꓓС mimicking USDC)
  - Moralis: unverified contract with no security score, spoofed sender
  - Blockscout: is_scam flag, scam reputation, Phish/Hack tags, spam token tags, phishing contract names
"""

import re
import unicodedata
from typing import List, Dict, Any

from backend.config.loader import configure_logging

log = configure_logging("spam_detection")


# ---------------------------------------------------------------------------
# Human-readable reason descriptions
# ---------------------------------------------------------------------------

_REASON_DESCRIPTIONS: Dict[str, str] = {
    "unverified_contract": "Token contract is unverified with no security score",
    "confusable_unicode": "Token name/symbol contains non-ASCII characters that mimic legitimate tokens",
    "spoofed_sender": "Transaction initiated by a different address but the transfer event spoofs the wallet as sender (address poisoning)",
    "is_scam": "Address flagged as scam by the block explorer",
    "scam_reputation": "Address has a scam reputation rating",
    "spam_token_tag": "Token tagged as spam by the block explorer",
    "phish_hack_tag": "Address tagged as Phish/Hack by the block explorer",
    "phishing_contract_name": "Contract name contains URL-like phishing lure",
    "unsolicited_unpriced": "Incoming transfer the wallet did not initiate, of a token with no price source",
    "user_blocklisted": "Token marked as spam by the user",
}


# ---------------------------------------------------------------------------
# Shared heuristics
# ---------------------------------------------------------------------------

def has_suspicious_unicode(text: str) -> bool:
    """
    Return True if *text* contains non-ASCII letter characters.

    Legitimate token names/symbols use plain ASCII (A-Z, a-z, 0-9, spaces, punctuation).
    Phishing tokens use visually similar characters from scripts like Lisu (ꓴꓢꓓ),
    Cyrillic (С looks like C), Cherokee, etc. to impersonate well-known tokens.

    Examples:
        >>> has_suspicious_unicode("USDC")
        False
        >>> has_suspicious_unicode("ꓴꓢꓓС ")   # Lisu + Cyrillic
        True
    """
    if not text:
        return False
    for ch in text:
        if unicodedata.category(ch).startswith("L") and ord(ch) > 127:
            return True
    return False


_PHISHING_URL_PATTERN = re.compile(
    r"\.(com|org|net|io|xyz|co|finance|me|info|app)\b",
    re.IGNORECASE,
)

def _looks_like_phishing_name(name: str) -> bool:
    """Return True if *name* looks like a phishing lure (contains URL-like patterns)."""
    if not name:
        return False
    return bool(_PHISHING_URL_PATTERN.search(name))


# ---------------------------------------------------------------------------
# Moralis-specific detection
# ---------------------------------------------------------------------------

def detect_moralis_erc20_phishing(
    tx: Dict[str, Any],
    transfer: Dict[str, Any],
    wallet_address: str,
) -> List[str]:
    """
    Check a Moralis ERC-20 transfer for phishing signals.

    Args:
        tx: The outer raw transaction dict from Moralis API.
        transfer: One ERC-20 transfer entry from ``tx["erc20_transfers"]``.
        wallet_address: The scanned wallet address (lower-cased).

    Returns:
        List of reason strings. Empty list means the transfer looks legitimate.
    """
    reasons: List[str] = []

    # 1. Unverified contract with no/low security score
    verified = transfer.get("verified_contract")
    security_score = transfer.get("security_score")
    if verified is False and (security_score is None or (isinstance(security_score, (int, float)) and security_score < 20)):
        reasons.append("unverified_contract")

    # 2. Confusable Unicode in token name or symbol
    token_name = transfer.get("token_name", "")
    token_symbol = transfer.get("token_symbol", "")
    if has_suspicious_unicode(token_name) or has_suspicious_unicode(token_symbol):
        reasons.append("confusable_unicode")

    # 3. Spoofed sender — someone else initiated the tx but the Transfer event
    #    shows our wallet as the sender (address poisoning / fake transfer)
    outer_from = (tx.get("from_address") or "").lower()
    transfer_from = (transfer.get("from_address") or "").lower()
    if outer_from and transfer_from:
        if outer_from != wallet_address and transfer_from == wallet_address:
            reasons.append("spoofed_sender")

    return reasons


# ---------------------------------------------------------------------------
# Blockscout-specific detection
# ---------------------------------------------------------------------------

def _check_address_scam_signals(addr_obj: Dict[str, Any]) -> List[str]:
    """Extract scam signals from a Blockscout address object (from/to)."""
    if not addr_obj or not isinstance(addr_obj, dict):
        return []

    signals: List[str] = []

    # Direct scam flag
    if addr_obj.get("is_scam") is True:
        signals.append("is_scam")

    # Reputation field
    if str(addr_obj.get("reputation", "")).lower() == "scam":
        signals.append("scam_reputation")

    # Metadata tags
    metadata = addr_obj.get("metadata") or {}
    tags = metadata.get("tags") or []
    for tag in tags:
        if not isinstance(tag, dict):
            continue
        tag_type = tag.get("tagType", "")
        tag_name = tag.get("name", "")
        meta = tag.get("meta") or {}

        # Spam token tag
        if tag_type == "token_reputation" and str(meta.get("data", "")).lower() == "spam":
            signals.append("spam_token_tag")
        # Phish / Hack generic tag
        if tag_name.lower() in ("phish / hack", "phish/hack"):
            signals.append("phish_hack_tag")

    # Phishing lure in contract name
    name = addr_obj.get("name", "")
    if _looks_like_phishing_name(name):
        signals.append("phishing_contract_name")

    return signals


def detect_blockscout_phishing(tx: Dict[str, Any]) -> List[str]:
    """
    Check a raw Blockscout token-transfer (or normal-tx) for phishing signals.

    Inspects the ``from``, ``to``, and ``token`` objects that the Blockscout API v2
    returns for each item.

    Args:
        tx: Raw item dict from Blockscout API v2 (token transfer or normal tx).

    Returns:
        List of unique reason strings. Empty list means the transfer looks legitimate.
    """
    reasons: List[str] = []

    # Check from / to address objects
    from_obj = tx.get("from") if isinstance(tx.get("from"), dict) else {}
    to_obj = tx.get("to") if isinstance(tx.get("to"), dict) else {}

    reasons.extend(_check_address_scam_signals(from_obj))
    reasons.extend(_check_address_scam_signals(to_obj))

    # Check token object (present on token transfers, absent on normal tx)
    token_info = tx.get("token") or {}
    if token_info:
        token_symbol = token_info.get("symbol") or ""
        token_name = token_info.get("name") or ""
        if has_suspicious_unicode(token_symbol) or has_suspicious_unicode(token_name):
            reasons.append("confusable_unicode")

    # Deduplicate while preserving order
    seen = set()
    unique: List[str] = []
    for r in reasons:
        if r not in seen:
            seen.add(r)
            unique.append(r)

    return unique


# ---------------------------------------------------------------------------
# Shared helpers for connectors
# ---------------------------------------------------------------------------

def _build_review_notes(reasons: List[str], suspected: bool = False) -> str:
    """Build a human-readable review notes string from detection reasons."""
    lines = ["⚠️ Auto-flagged as suspected spam:" if suspected else "⚠️ Auto-flagged as spam/phishing:"]
    for reason in reasons:
        description = _REASON_DESCRIPTIONS.get(reason, reason)
        lines.append(f"  • {description}")
    return "\n".join(lines)


def apply_spam_markers(
    normalized,
    reasons: List[str],
    tags: Any,
    tx_id: str = "",
    suspected: bool = False,
) -> None:
    """
    Mutate a NormalizedTransaction in-place to mark it as spam/phishing.

    Sets:
      - ``review_status = "invalid"``
      - ``taxability_status = "non_taxable"``
      - ``review_notes`` with human-readable detection reasons
      - Appends ``{"spam": True, "spam_reasons": reasons}`` to tags

    Args:
        normalized: A NormalizedTransaction instance (mutated in place).
        reasons: Non-empty list of detection reason strings.
        tags: The tags value (list or dict) currently on the transaction.
        tx_id: Transaction identifier for logging.
    """
    normalized.review_status = "invalid"
    normalized.taxability_status = "non_taxable"
    normalized.review_notes = _build_review_notes(reasons, suspected)

    spam_tag = {"spam": True, "spam_reasons": reasons}
    if suspected:
        spam_tag["spam_level"] = "suspected"

    # Handle both list and dict tag formats
    if isinstance(tags, list):
        # Remove any existing simple {"spam": True} tag to avoid duplication
        tags = [t for t in tags if t != {"spam": True}]
        tags.append(spam_tag)
    elif isinstance(tags, dict):
        tags = [tags, spam_tag] if tags else [spam_tag]
    else:
        tags = [spam_tag]

    normalized.tags = tags

    log.warning(
        f"🚫 Phishing detected on {tx_id}: reasons={reasons}"
    )
