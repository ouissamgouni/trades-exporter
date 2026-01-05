"""
Asset Import Service.

Handles importing assets, categories, and price getters from parsed CSV data.
Uses upsert logic for idempotent imports.

Usage:
    from backend.services.asset_import_service import AssetImportService
    from backend.file_loaders.asset_csv_loader import AssetCSVLoader
    
    loader = AssetCSVLoader()
    result = loader.load("path/to/assets.csv")
    
    service = AssetImportService(session)
    import_result = service.import_from_load_result(result)
"""

from typing import List, Dict, Any, Optional, Set
from dataclasses import dataclass, field
from datetime import datetime, timezone
from sqlmodel import Session, select

from backend.db.models import Asset, AssetPriceGetter, Category, AssetCategory, Dimension
from backend.file_loaders.asset_csv_loader import LoadResult, ParsedAsset, CategoryDefinition, PriceGetterConfig
from backend.config.loader import configure_logging

log = configure_logging("asset_import_service")


def utc_now() -> datetime:
    """Return current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


@dataclass
class ImportStats:
    """Statistics for an import operation."""
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class ImportResult:
    """Complete result of an import operation."""
    assets: ImportStats = field(default_factory=ImportStats)
    categories: ImportStats = field(default_factory=ImportStats)
    price_getters: ImportStats = field(default_factory=ImportStats)
    asset_categories: ImportStats = field(default_factory=ImportStats)
    parse_errors: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    dry_run: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API response."""
        return {
            "assets": {
                "created": self.assets.created,
                "updated": self.assets.updated,
                "skipped": self.assets.skipped,
                "errors": self.assets.errors,
            },
            "categories": {
                "created": self.categories.created,
                "updated": self.categories.updated,
                "skipped": self.categories.skipped,
                "errors": self.categories.errors,
            },
            "price_getters": {
                "created": self.price_getters.created,
                "updated": self.price_getters.updated,
                "skipped": self.price_getters.skipped,
                "errors": self.price_getters.errors,
            },
            "asset_categories": {
                "created": self.asset_categories.created,
                "updated": self.asset_categories.updated,
                "skipped": self.asset_categories.skipped,
                "errors": self.asset_categories.errors,
            },
            "parse_errors": self.parse_errors,
            "warnings": self.warnings,
            "dry_run": self.dry_run,
            "summary": {
                "total_assets": self.assets.created + self.assets.updated,
                "total_categories": self.categories.created + self.categories.updated,
                "total_price_getters": self.price_getters.created + self.price_getters.updated,
                "total_errors": (
                    len(self.assets.errors) + 
                    len(self.categories.errors) + 
                    len(self.price_getters.errors) +
                    len(self.parse_errors)
                ),
            }
        }


class AssetImportService:
    """
    Service for importing assets from parsed CSV data.
    
    Handles:
    - Asset upsert by symbol
    - Dimension upsert by label
    - Category upsert by (dimension_id, label)
    - Price getter upsert by (asset_id, price_getter)
    - Asset-category linking
    """
    
    def __init__(self, session: Session):
        self.session = session
        self._dimension_cache: Dict[str, int] = {}  # dimension_label -> dimension_id
        self._category_cache: Dict[str, int] = {}  # "dimension_label:category_label" -> category_id
    
    def import_from_load_result(
        self, 
        load_result: LoadResult, 
        dry_run: bool = False,
        replace_price_getters: bool = True
    ) -> ImportResult:
        """
        Import assets, categories, and price getters from a LoadResult.
        
        Args:
            load_result: Parsed data from AssetCSVLoader
            dry_run: If True, don't commit changes
            replace_price_getters: If True, replace existing price getters; 
                                   if False, merge with existing
                                   
        Returns:
            ImportResult with statistics and errors
        """
        result = ImportResult(
            parse_errors=load_result.errors,
            warnings=load_result.warnings,
            dry_run=dry_run
        )
        
        log.info("starting_import",
                 assets_count=len(load_result.assets),
                 categories_count=len(load_result.categories),
                 dry_run=dry_run)
        
        try:
            # Step 1: Import categories first (needed for asset linking)
            result.categories = self._import_categories(load_result.categories, dry_run)
            
            # Step 2: Import assets
            asset_id_map = {}  # symbol -> asset_id
            result.assets = self._import_assets(load_result.assets, asset_id_map, dry_run)
            
            # Step 3: Import price getters
            result.price_getters = self._import_price_getters(
                load_result.assets, 
                asset_id_map, 
                replace_price_getters,
                dry_run
            )
            
            # Step 4: Link assets to categories
            result.asset_categories = self._link_asset_categories(
                load_result.assets,
                asset_id_map,
                dry_run
            )
            
            if not dry_run:
                self.session.commit()
                log.info("import_committed")
            else:
                self.session.rollback()
                log.info("import_dry_run_rolled_back")
                
        except Exception as e:
            self.session.rollback()
            log.error("import_failed", error=str(e))
            result.assets.errors.append({"error": f"Import failed: {str(e)}"})
        
        return result
    
    def _import_categories(self, categories: List[CategoryDefinition], dry_run: bool) -> ImportStats:
        """Import category definitions using upsert logic.
        
        Uses the new Dimension model - creates/finds dimension first, then category.
        """
        stats = ImportStats()
        
        for cat_def in categories:
            try:
                # First, ensure the dimension exists (using dimension_label as the label)
                dim_label = cat_def.dimension_label or cat_def.dimension.replace('_', ' ').title()
                
                dimension_id = self._dimension_cache.get(dim_label)
                
                if not dimension_id:
                    # Check if dimension exists by label
                    existing_dim = self.session.exec(
                        select(Dimension).where(Dimension.label == dim_label)
                    ).first()
                    
                    if existing_dim:
                        dimension_id = existing_dim.id
                    else:
                        # Create new dimension
                        dimension = Dimension(
                            label=dim_label,
                            ordinal=0,
                            created_at=utc_now()
                        )
                        if not dry_run:
                            self.session.add(dimension)
                            self.session.flush()
                            dimension_id = dimension.id
                        else:
                            dimension_id = -1  # Placeholder for dry run
                    
                    self._dimension_cache[dim_label] = dimension_id
                
                # Now handle the category
                # Check if category exists by (dimension_id, label)
                cache_key = f"{dim_label}:{cat_def.label}"
                
                if dimension_id != -1:  # Only check DB if we have a real dimension_id
                    existing = self.session.exec(
                        select(Category)
                        .where(Category.dimension_id == dimension_id)
                        .where(Category.label == cat_def.label)
                    ).first()
                else:
                    existing = None
                
                if existing:
                    # Category already exists, skip
                    stats.skipped += 1
                    self._category_cache[cache_key] = existing.id
                else:
                    # Create new category
                    if dimension_id != -1:
                        category = Category(
                            dimension_id=dimension_id,
                            label=cat_def.label,
                            created_at=utc_now()
                        )
                        
                        if not dry_run:
                            self.session.add(category)
                            self.session.flush()  # Get the ID
                            self._category_cache[cache_key] = category.id
                    
                    stats.created += 1
                    
            except Exception as e:
                stats.errors.append({
                    "category": f"{cat_def.dimension_label}:{cat_def.label}",
                    "error": str(e)
                })
                log.warning("category_import_error", 
                           category=f"{cat_def.dimension_label}:{cat_def.label}",
                           error=str(e))
        
        log.info("categories_imported",
                 created=stats.created,
                 updated=stats.updated,
                 skipped=stats.skipped)
        
        return stats
    
    def _import_assets(
        self, 
        assets: List[ParsedAsset], 
        asset_id_map: Dict[str, int],
        dry_run: bool
    ) -> ImportStats:
        """Import assets using upsert logic."""
        stats = ImportStats()
        
        for parsed in assets:
            try:
                # Check if asset exists by symbol
                existing = self.session.exec(
                    select(Asset).where(Asset.symbol == parsed.symbol)
                ).first()
                
                if existing:
                    # Update existing asset
                    existing.label = parsed.label
                    existing.price_type = parsed.price_type
                    stats.updated += 1
                    asset_id_map[parsed.symbol] = existing.asset_id
                else:
                    # Create new asset
                    asset = Asset(
                        symbol=parsed.symbol,
                        label=parsed.label,
                        price_type=parsed.price_type,
                        status=0,
                        created_at=utc_now()
                    )
                    
                    if not dry_run:
                        self.session.add(asset)
                        self.session.flush()  # Get the ID
                        asset_id_map[parsed.symbol] = asset.asset_id
                    else:
                        # For dry run, use a placeholder ID
                        asset_id_map[parsed.symbol] = -1
                    
                    stats.created += 1
                    
            except Exception as e:
                stats.errors.append({
                    "symbol": parsed.symbol,
                    "error": str(e)
                })
                log.warning("asset_import_error", symbol=parsed.symbol, error=str(e))
        
        log.info("assets_imported",
                 created=stats.created,
                 updated=stats.updated,
                 skipped=stats.skipped)
        
        return stats
    
    def _import_price_getters(
        self,
        assets: List[ParsedAsset],
        asset_id_map: Dict[str, int],
        replace_existing: bool,
        dry_run: bool
    ) -> ImportStats:
        """Import price getter configurations."""
        stats = ImportStats()
        
        for parsed in assets:
            asset_id = asset_id_map.get(parsed.symbol)
            if not asset_id or asset_id == -1:
                continue
            
            try:
                # Use no_autoflush to prevent premature constraint checks
                with self.session.no_autoflush:
                    if replace_existing:
                        # Delete existing price getters for this asset
                        existing_getters = self.session.exec(
                            select(AssetPriceGetter).where(AssetPriceGetter.asset_id == asset_id)
                        ).all()
                        
                        for getter in existing_getters:
                            if not dry_run:
                                self.session.delete(getter)
                        
                        # Flush deletes before inserting new ones
                        if not dry_run:
                            self.session.flush()
                    
                    # Deduplicate price getters by getter name (keep highest priority = lowest number)
                    seen_getters: Dict[str, PriceGetterConfig] = {}
                    for getter_config in parsed.price_getters:
                        getter_name = getter_config.price_getter
                        if getter_name not in seen_getters or getter_config.priority < seen_getters[getter_name].priority:
                            seen_getters[getter_name] = getter_config
                    
                    # Add new price getters (deduplicated)
                    for getter_config in seen_getters.values():
                        # Check for existing (if not replacing)
                        if not replace_existing:
                            existing = self.session.exec(
                                select(AssetPriceGetter)
                                .where(AssetPriceGetter.asset_id == asset_id)
                                .where(AssetPriceGetter.price_getter == getter_config.price_getter)
                            ).first()
                            
                            if existing:
                                # Update existing
                                existing.priority = getter_config.priority
                                existing.external_id = getter_config.external_id
                                existing.params = getter_config.params
                                existing.enabled = getter_config.enabled
                                existing.updated_at = utc_now()
                                stats.updated += 1
                                continue
                        
                        # Create new price getter
                        price_getter = AssetPriceGetter(
                            asset_id=asset_id,
                            price_getter=getter_config.price_getter,
                            external_id=getter_config.external_id,
                            priority=getter_config.priority,
                            enabled=getter_config.enabled,
                            params=getter_config.params,
                            created_at=utc_now(),
                            updated_at=utc_now()
                        )
                        
                        if not dry_run:
                            self.session.add(price_getter)
                        
                        stats.created += 1
                    
            except Exception as e:
                stats.errors.append({
                    "symbol": parsed.symbol,
                    "error": str(e)
                })
                log.warning("price_getter_import_error", symbol=parsed.symbol, error=str(e))
        
        log.info("price_getters_imported",
                 created=stats.created,
                 updated=stats.updated)
        
        return stats
    
    def _link_asset_categories(
        self,
        assets: List[ParsedAsset],
        asset_id_map: Dict[str, int],
        dry_run: bool
    ) -> ImportStats:
        """Link assets to categories."""
        stats = ImportStats()
        
        # Build category cache if not already done
        if not self._category_cache:
            all_categories = self.session.exec(
                select(Category, Dimension)
                .join(Dimension, Dimension.id == Category.dimension_id)
            ).all()
            for cat, dim in all_categories:
                self._category_cache[f"{dim.label}:{cat.label}"] = cat.id
        
        for parsed in assets:
            asset_id = asset_id_map.get(parsed.symbol)
            
            # For dry run, we still want to count potential links
            # For real import, skip if no valid asset_id
            if not asset_id:
                continue
            if asset_id == -1 and not dry_run:
                continue
            
            for category_tuple in parsed.category_keys:
                # Handle both (dimension, key) and (dimension, key, parent_key) tuples
                # dimension is actually the dimension_label now, key is the category_label
                dimension_label = category_tuple[0]
                category_label = category_tuple[1]
                # parent_key = category_tuple[2] if len(category_tuple) > 2 else None  # Not used anymore
                
                cache_key = f"{dimension_label}:{category_label}"
                category_id = self._category_cache.get(cache_key)
                
                # For dry run with new categories, assume they would be created
                if not category_id:
                    if dry_run:
                        # Count as would-be-created for new categories
                        stats.created += 1
                    else:
                        stats.skipped += 1
                    continue
                
                # For dry run with placeholder asset_id, just count it
                if asset_id == -1 and dry_run:
                    stats.created += 1
                    continue
                
                try:
                    # Check if link already exists
                    existing = self.session.exec(
                        select(AssetCategory)
                        .where(AssetCategory.asset_id == asset_id)
                        .where(AssetCategory.category_id == category_id)
                    ).first()
                    
                    if existing:
                        stats.skipped += 1
                        continue
                    
                    # Create link
                    link = AssetCategory(
                        asset_id=asset_id,
                        category_id=category_id,
                        created_at=utc_now()
                    )
                    
                    if not dry_run:
                        self.session.add(link)
                    
                    stats.created += 1
                    
                except Exception as e:
                    stats.errors.append({
                        "symbol": parsed.symbol,
                        "category": cache_key,
                        "error": str(e)
                    })
        
        log.info("asset_categories_linked", created=stats.created, skipped=stats.skipped)
        
        return stats
