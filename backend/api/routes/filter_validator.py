"""
Filter validation helper for transaction API endpoints.

Validates filter parameters against the database and returns structured results.
"""

from typing import List, Tuple, Optional
from sqlmodel import Session, select
from backend.db.models import Asset, Account, Category
from backend.api.schemas import ValidationWarning, AppliedFilters


# Valid enum values
VALID_REVIEW_STATUSES = ["valid", "pending", "invalid"]
VALID_TAXABILITY_STATUSES = ["taxable", "non_taxable", "unknown"]
VALID_DIRECTIONS = ["inflow", "outflow", "internal"]
VALID_BUNDLE_PATTERNS = ["internal_transfer", "swap", "flow", "split", "custom", "unknown"]


class FilterValidator:
    """Validates and sanitizes filter parameters."""
    
    def __init__(self, session: Session):
        self.session = session
        self.warnings: List[ValidationWarning] = []
    
    def validate_ids(
        self, 
        ids_str: Optional[str], 
        model_class, 
        id_field_name: str,
        filter_name: str
    ) -> List[int]:
        """
        Validate comma-separated IDs against a database model.
        
        Returns list of valid IDs and adds warnings for invalid ones.
        """
        if not ids_str:
            return []
        
        # Parse IDs
        parsed_ids = []
        invalid_values = []
        
        for id_str in ids_str.split(','):
            id_str = id_str.strip()
            if id_str.isdigit():
                parsed_ids.append(int(id_str))
            else:
                invalid_values.append(id_str)
        
        # Warn about non-numeric values
        if invalid_values:
            self.warnings.append(ValidationWarning(
                filter_name=filter_name,
                provided_value=", ".join(invalid_values),
                reason=f"Non-numeric values ignored",
                severity="warning"
            ))
        
        if not parsed_ids:
            return []
        
        # Check which IDs exist in database
        statement = select(getattr(model_class, id_field_name)).where(
            getattr(model_class, id_field_name).in_(parsed_ids)
        )
        existing_ids = set(self.session.exec(statement).all())
        
        # Warn about non-existent IDs
        non_existent = [id for id in parsed_ids if id not in existing_ids]
        if non_existent:
            self.warnings.append(ValidationWarning(
                filter_name=filter_name,
                provided_value=", ".join(str(id) for id in non_existent),
                reason=f"IDs not found in database",
                severity="warning"
            ))
        
        return list(existing_ids)

    # Recognized sentinel values for account filters
    ACCOUNT_SENTINELS = {"unmapped", "undefined", "non-owned"}

    def validate_ids_with_sentinels(
        self,
        ids_str: Optional[str],
        model_class,
        id_field_name: str,
        filter_name: str,
    ) -> list:
        """
        Validate comma-separated IDs against a database model,
        allowing special sentinel values to pass through.

        Supported sentinels:
        - 'unmapped' / 'undefined': maps to column IS NULL
        - 'non-owned': maps to accounts with owned=False + NULL

        Returns list of valid int IDs + sentinel strings.
        """
        if not ids_str:
            return []

        sentinels_found: list[str] = []
        numeric_parts: list[str] = []

        for id_str in ids_str.split(","):
            id_str = id_str.strip()
            lower = id_str.lower()
            if lower in self.ACCOUNT_SENTINELS:
                # Normalize 'unmapped' → 'undefined' for consistency
                sentinel = "undefined" if lower == "unmapped" else lower
                if sentinel not in sentinels_found:
                    sentinels_found.append(sentinel)
            elif id_str:
                numeric_parts.append(id_str)

        # Validate numeric IDs via the standard method
        numeric_csv = ",".join(numeric_parts) if numeric_parts else None
        valid_ids = self.validate_ids(
            numeric_csv, model_class, id_field_name, filter_name
        )

        result: list = list(valid_ids)
        result.extend(sentinels_found)
        return result

    # Backward-compatible alias
    def validate_ids_with_unmapped(
        self,
        ids_str: Optional[str],
        model_class,
        id_field_name: str,
        filter_name: str,
    ) -> list:
        """Alias for validate_ids_with_sentinels (backward compat)."""
        return self.validate_ids_with_sentinels(
            ids_str, model_class, id_field_name, filter_name
        )
    
    def validate_enum(
        self,
        value: Optional[str],
        valid_values: List[str],
        filter_name: str
    ) -> Optional[str]:
        """
        Validate enum field against allowed values.
        
        Returns valid value or None, adds warning if invalid.
        """
        if not value:
            return None
        
        if value not in valid_values:
            self.warnings.append(ValidationWarning(
                filter_name=filter_name,
                provided_value=value,
                reason=f"Invalid value. Must be one of: {', '.join(valid_values)}",
                severity="error"
            ))
            return None
        
        return value
    
    def validate_enum_list(
        self,
        values_str: Optional[str],
        valid_values: List[str],
        filter_name: str
    ) -> List[str]:
        """
        Validate comma-separated enum values.
        
        Returns list of valid values and adds warnings for invalid ones.
        """
        if not values_str:
            return []
        
        valid = []
        invalid = []
        
        for value in values_str.split(','):
            value = value.strip()
            if value in valid_values:
                valid.append(value)
            else:
                invalid.append(value)
        
        if invalid:
            self.warnings.append(ValidationWarning(
                filter_name=filter_name,
                provided_value=", ".join(invalid),
                reason=f"Invalid values. Must be one of: {', '.join(valid_values)}",
                severity="warning"
            ))
        
        return valid
    
    def validate_date(
        self,
        date_str: Optional[str],
        filter_name: str
    ) -> Optional[str]:
        """
        Validate date string format.
        
        Returns valid date string or None, adds warning if invalid.
        """
        if not date_str:
            return None
        
        try:
            from datetime import datetime
            # Try to parse as ISO format
            datetime.fromisoformat(date_str.replace('Z', '+00:00'))
            return date_str
        except (ValueError, AttributeError):
            self.warnings.append(ValidationWarning(
                filter_name=filter_name,
                provided_value=date_str,
                reason="Invalid date format. Expected ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS)",
                severity="warning"
            ))
            return None
    
    def validate_strings(
        self,
        values_str: Optional[str],
        filter_name: str
    ) -> List[str]:
        """
        Parse and validate comma-separated string values.
        
        Returns list of non-empty strings.
        """
        if not values_str:
            return []
        
        return [v.strip() for v in values_str.split(',') if v.strip()]
    
    def get_warnings(self) -> List[ValidationWarning]:
        """Get all accumulated validation warnings."""
        return self.warnings


def validate_transaction_filters(
    session: Session,
    review_status: Optional[str] = None,
    taxability: Optional[str] = None,
    source: Optional[str] = None,
    account_id: Optional[str] = None,
    from_account_id: Optional[str] = None,
    to_account_id: Optional[str] = None,
    related_account_id: Optional[str] = None,
    asset_id: Optional[str] = None,
    related_asset_id: Optional[str] = None,
    category_id: Optional[str] = None,
    transaction_type: Optional[str] = None,
    direction: Optional[str] = None,
    connector_run_id: Optional[str] = None,
    tag_key: Optional[str] = None,
    network: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    price_quote_asset_id: Optional[str] = None,
    fee_quote_asset_id: Optional[str] = None,
    include_fee: Optional[bool] = None,
    has_bundle: Optional[bool] = None,
    bundle_pattern: Optional[str] = None,
) -> Tuple[AppliedFilters, List[ValidationWarning]]:
    """
    Validate all transaction filter parameters.
    
    Returns tuple of (validated_filters, warnings).
    """
    validator = FilterValidator(session)
    
    # Validate enum fields
    validated_review_statuses = validator.validate_enum_list(
        review_status, VALID_REVIEW_STATUSES, "review_status"
    )
    validated_taxability = validator.validate_enum(
        taxability, VALID_TAXABILITY_STATUSES, "taxability"
    )
    
    # Validate ID fields (with sentinel support for account filters)
    validated_account_ids = validator.validate_ids_with_sentinels(
        account_id, Account, "id", "account_id"
    )
    validated_from_account_ids = validator.validate_ids_with_sentinels(
        from_account_id, Account, "id", "from_account_id"
    )
    validated_to_account_ids = validator.validate_ids_with_sentinels(
        to_account_id, Account, "id", "to_account_id"
    )
    validated_related_account_ids = validator.validate_ids_with_sentinels(
        related_account_id, Account, "id", "related_account_id"
    )
    validated_asset_ids = validator.validate_ids(
        asset_id, Asset, "asset_id", "asset_id"
    )
    validated_related_asset_ids = validator.validate_ids(
        related_asset_id, Asset, "asset_id", "related_asset_id"
    )
    validated_category_ids = validator.validate_ids(
        category_id, Category, "id", "category_id"
    )
    
    # Validate enum lists
    validated_directions = validator.validate_enum_list(
        direction, VALID_DIRECTIONS, "direction"
    )
    
    # Validate string lists (no database validation needed)
    validated_sources = validator.validate_strings(source, "source")
    validated_transaction_types = validator.validate_strings(transaction_type, "transaction_type")
    validated_tag_keys = validator.validate_strings(tag_key, "tag_key")
    validated_networks = validator.validate_strings(network, "network")
    
    # Parse connector_run_ids (no database validation - table not always available)
    validated_connector_run_ids = []
    if connector_run_id:
        for id_str in connector_run_id.split(','):
            id_str = id_str.strip()
            if id_str.isdigit():
                validated_connector_run_ids.append(int(id_str))
    
    # Validate dates
    validated_date_from = validator.validate_date(date_from, "date_from")
    validated_date_to = validator.validate_date(date_to, "date_to")
    
    # Validate new filter fields
    validated_price_quote_asset_ids = validator.validate_ids(
        price_quote_asset_id, Asset, "asset_id", "price_quote_asset_id"
    )
    validated_fee_quote_asset_ids = validator.validate_ids(
        fee_quote_asset_id, Asset, "asset_id", "fee_quote_asset_id"
    )
    validated_bundle_patterns = validator.validate_enum_list(
        bundle_pattern, VALID_BUNDLE_PATTERNS, "bundle_pattern"
    )
    
    # Build applied filters object
    applied_filters = AppliedFilters(
        review_statuses=validated_review_statuses,
        taxability=validated_taxability,
        sources=validated_sources,
        account_ids=validated_account_ids,
        from_account_ids=validated_from_account_ids,
        to_account_ids=validated_to_account_ids,
        related_account_ids=validated_related_account_ids,
        asset_ids=validated_asset_ids,
        related_asset_ids=validated_related_asset_ids,
        category_ids=validated_category_ids,
        transaction_types=validated_transaction_types,
        directions=validated_directions,
        connector_run_ids=validated_connector_run_ids,
        tag_keys=validated_tag_keys,
        networks=validated_networks,
        date_from=validated_date_from,
        date_to=validated_date_to,
        price_quote_asset_ids=validated_price_quote_asset_ids,
        fee_quote_asset_ids=validated_fee_quote_asset_ids,
        include_fee=include_fee,
        has_bundle=has_bundle,
        bundle_patterns=validated_bundle_patterns,
    )
    
    return applied_filters, validator.get_warnings()
