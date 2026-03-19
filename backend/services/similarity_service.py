"""
Similarity Service

Centralized fuzzy matching and suggestion logic for raw asset/account mapping.
Provides Levenshtein distance calculation and best-match suggestions.
"""

from typing import Optional, List, Dict

from backend.api.schemas import SuggestionInfo


def levenshtein_distance(s1: str, s2: str) -> int:
    """
    Calculate Levenshtein distance between two strings.
    
    Uses iterative row-based dynamic programming for memory efficiency.
    """
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    
    prev_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (c1 != c2)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row
    return prev_row[-1]


def calculate_similarity(s1: str, s2: str) -> float:
    """
    Calculate similarity between two strings (0 to 1).
    
    Uses heuristics for common patterns:
    - Exact match: 1.0
    - Substring match: 0.8
    - Prefix match: 0.7
    - Levenshtein-based for others
    """
    s1 = s1.lower().strip()
    s2 = s2.lower().strip()
    
    if s1 == s2:
        return 1.0
    if s1 in s2 or s2 in s1:
        return 0.8
    if s1.startswith(s2) or s2.startswith(s1):
        return 0.7
    
    max_len = max(len(s1), len(s2))
    if max_len == 0:
        return 1.0
    
    distance = levenshtein_distance(s1, s2)
    return 1 - (distance / max_len)


def get_best_asset_suggestion(
    symbol: str, 
    assets: list, 
    min_confidence: float = 0.5
) -> Optional[SuggestionInfo]:
    """
    Get best fuzzy match for a raw asset symbol.
    
    Args:
        symbol: Raw symbol to match
        assets: List of Asset objects with asset_id, symbol, label
        min_confidence: Minimum confidence threshold (0-1)
    
    Returns:
        SuggestionInfo if a match found above threshold, else None
    """
    best_match = None
    best_confidence = min_confidence
    
    for asset in assets:
        symbol_sim = calculate_similarity(symbol, asset.symbol)
        label_sim = calculate_similarity(symbol, asset.label) if asset.label else 0
        confidence = max(symbol_sim, label_sim)
        
        if confidence > best_confidence:
            best_confidence = confidence
            best_match = SuggestionInfo(
                id=asset.asset_id,
                name=asset.symbol,
                confidence=confidence
            )
    
    return best_match


def get_top_account_suggestions(
    label: str,
    accounts: list,
    min_confidence: float = 0.5,
    max_results: int = 3,
    source: Optional[str] = None,
    account_connectors_map: Optional[Dict[int, list]] = None,
    network: Optional[str] = None,
) -> List[SuggestionInfo]:
    """
    Get top N fuzzy matches for a raw account label, ranked by confidence.

    Same logic as ``get_best_account_suggestion`` but returns multiple matches.
    When ``network`` is non-empty and ``account_connectors_map`` is available,
    only accounts whose connectors have ``config.chain == network`` are
    considered (falls back to all accounts if none match).

    Args:
        label: Raw account label to match
        accounts: List of Account objects with id, name, address_or_identifier
        min_confidence: Minimum confidence threshold (0-1)
        max_results: Maximum number of suggestions to return
        source: Connector type that produced the transaction
        account_connectors_map: Dict mapping account.id → list of AccountConnector objects
        network: Normalized chain name for filtering (e.g. 'bsc', 'ethereum')

    Returns:
        List of SuggestionInfo, sorted by descending confidence
    """
    # When network is known, try to filter to only chain-matching accounts
    candidates = accounts
    if network and account_connectors_map:
        chain_matching = [
            a for a in accounts
            if a.id in account_connectors_map
            and any(
                (getattr(c, 'config', None) or {}).get('chain') == network
                for c in account_connectors_map[a.id]
            )
        ]
        if chain_matching:
            candidates = chain_matching

    results: List[SuggestionInfo] = []

    for account in candidates:
        name_sim = calculate_similarity(label, account.name)
        addr_sim = calculate_similarity(label, account.address_or_identifier) if account.address_or_identifier else 0

        # Prioritize address_or_identifier over name
        confidence = addr_sim if addr_sim > 0 else name_sim

        # Boost confidence if the account has a connector matching the source
        if source and account_connectors_map and account.id in account_connectors_map:
            connectors = account_connectors_map[account.id]
            if any(getattr(c, 'connector_type', None) == source for c in connectors):
                confidence = min(confidence + 0.05, 1.0)

        if confidence >= min_confidence:
            results.append(SuggestionInfo(
                id=account.id,
                name=account.name,
                confidence=confidence,
            ))

    results.sort(key=lambda s: s.confidence, reverse=True)
    return results[:max_results]


def get_best_account_suggestion(
    label: str, 
    accounts: list, 
    min_confidence: float = 0.5,
    source: Optional[str] = None,
    account_connectors_map: Optional[Dict[int, list]] = None,
    network: Optional[str] = None,
) -> Optional[SuggestionInfo]:
    """
    Get best fuzzy match for a raw account label.
    
    Prioritizes address_or_identifier match over name match when both exist.
    When ``source`` and ``account_connectors_map`` are provided, accounts whose
    connectors include a matching connector_type get a 0.05 confidence boost so
    they are preferred during ambiguous (same-address) matches.
    
    When ``network`` is non-empty and ``account_connectors_map`` is available,
    only accounts that have a connector with config.chain matching ``network``
    are considered. Falls back to all accounts if no chain-matching
    account is found.
    
    Args:
        label: Raw account label to match
        accounts: List of Account objects with id, name, address_or_identifier
        min_confidence: Minimum confidence threshold (0-1)
        source: Connector type that produced the transaction (e.g. 'blockscout')
        account_connectors_map: Dict mapping account.id → list of AccountConnector objects
        network: Normalized chain name for filtering (e.g. 'bsc', 'ethereum')
    
    Returns:
        SuggestionInfo if a match found above threshold, else None
    """
    # When network is known, try to filter to only chain-matching accounts
    candidates = accounts
    if network and account_connectors_map:
        chain_matching = [
            a for a in accounts
            if a.id in account_connectors_map
            and any(
                (getattr(c, 'config', None) or {}).get('chain') == network
                for c in account_connectors_map[a.id]
            )
        ]
        if chain_matching:
            candidates = chain_matching
    
    best_match = None
    best_confidence = min_confidence
    
    for account in candidates:
        name_sim = calculate_similarity(label, account.name)
        addr_sim = calculate_similarity(label, account.address_or_identifier) if account.address_or_identifier else 0
        
        # Prioritize address_or_identifier over name
        if addr_sim > 0:
            confidence = addr_sim
        else:
            confidence = name_sim
        
        # Boost confidence if the account has a connector matching the source
        if source and account_connectors_map and account.id in account_connectors_map:
            connectors = account_connectors_map[account.id]
            if any(getattr(c, 'connector_type', None) == source for c in connectors):
                confidence = min(confidence + 0.05, 1.0)
        
        if confidence > best_confidence:
            best_confidence = confidence
            best_match = SuggestionInfo(
                id=account.id,
                name=account.name,
                confidence=confidence
            )
    
    return best_match
