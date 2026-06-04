# Prices and Settings

Price data and user-facing settings affect P&L, tax reports, and review confidence. This guide covers the settings and price workflows most users need.

## Base Currency

Base currency is the reporting currency used for P&L and tax-oriented outputs. The default settings file uses EUR, but you should confirm the value in Setup before calculating.

Changing base currency after imports may require recalculation and additional price data.

## P&L Defaults

P&L defaults define how calculations should be prepared. Review them before producing final reports and document any change made for a filing period.

If you are not sure whether a setting should change, keep the default and ask a tax professional or project maintainer before producing final tax outputs.

## Price Snapshots

Price snapshots are historical price records used by calculations. They are usually tied to assets, timestamps, source type, and values in the base currency or quote currency.

Use the Prices tab to:

- Search historical price records.
- Inspect values used around important disposals.
- Edit or remove incorrect snapshots where supported.
- Investigate missing price gaps.

## Missing Prices

Missing prices can cause incomplete P&L, inaccurate tax outputs, or warnings.

Common causes:

- Raw asset is not mapped to a normalized asset.
- The asset has no configured price getter.
- The price source has no historical data for that date.
- The asset is illiquid, private, or source-specific.
- The transaction timestamp is outside the supported source range.

Review missing prices before trusting P&L.

## Asset Price Configuration

Assets may have price-related metadata or price getter behavior. Check asset setup when:

- An asset has no price data.
- A token symbol maps to the wrong market.
- A stock or broker instrument uses a symbol that differs from a public ticker.
- Fiat conversion is required.

For ambiguous symbols, prefer explicit mappings and notes.

## User-Facing Configuration Files

The main user-relevant backend settings are in `backend/config/settings.yaml`. Important concepts include:

- `base_currency`, the default reporting currency.
- Grouping time windows and confidence thresholds.
- Duplicate detection behavior.
- Web3 wallet scanner defaults.
- Input and output data paths.

Most users should change settings through the UI where possible. If you edit configuration files directly, restart the backend and document the change.

Developer environment variables and stack configuration are covered in [Development Workflow](DEVELOPMENT_WORKFLOW.md).

## Grouping Settings

Grouping settings affect how TradeTrail suggests transfers, swaps, bridges, and related flows. The defaults include time windows, quantity/value tolerances, and confidence thresholds.

Changing these values can affect grouping suggestions, not just display. Re-review affected suggestions after changing grouping configuration.

## Duplicate Settings

Duplicate detection helps identify records that share similar transaction characteristics. The default configuration enables duplicate detection and uses tolerances for matching.

If duplicates are overreported or underreported, first review the source imports and mappings. Change duplicate settings only when you understand the tradeoff.

## Price Review Checklist

- Base currency is correct.
- Assets are mapped before price review.
- Price gaps are checked before P&L export.
- Important disposals have plausible historical prices.
- Manual price edits are documented.
- P&L is refreshed after price changes.

## Next Steps

- Review data issues in [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md).
- Diagnose calculation issues in [P&L and Cost Lots](PNL_AND_COST_LOTS.md).
- Use [Troubleshooting](TROUBLESHOOTING.md) for common price problems.
