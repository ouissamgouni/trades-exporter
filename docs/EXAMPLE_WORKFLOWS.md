# Example Workflows

These examples show how to combine the main docs into practical review journeys. Use scenarios when you want to practice without real data.

## First Exchange Import

Use this for a small Binance, OKX, MEXC, Coinbase, or similar source import.

1. Create an account in Setup.
2. Attach the relevant connector.
3. Start with a short date range if the connector supports it.
4. Run Sync.
5. Check connector run details and imported counts.
6. Resolve raw account and asset mappings.
7. Review duplicates.
8. Review Inbox grouping suggestions.
9. Check Timeline for missing periods.
10. Refresh P&L.
11. Inspect warnings and realized P&L.

Use [Import and Connectors](IMPORT_AND_CONNECTORS.md) and [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md) while working through this flow.

## File-Only Import

Use this when a broker or exchange gives you CSV files but no reliable API sync.

1. Create the account in Setup.
2. Choose the connector-specific file importer if available.
3. Use generic CSV import only when no source-specific importer exists.
4. Preview the file before confirming.
5. Confirm the file only after date, account, asset, quantity, fee, and direction look right.
6. Review imported rows in All using source or connector-run filters.
7. Resolve mappings and duplicates.
8. Refresh P&L.

## French Tax Review

Try the scenario first:

```bash
SCENARIO=fr_tax task start:scenario
```

Review path:

1. Open Setup and check base currency.
2. Open All and inspect taxable and non-taxable events.
3. Check Inbox suggestions for swaps and internal transfers.
4. Open Prices and inspect relevant historical price records.
5. Refresh P&L.
6. Inspect realized P&L and warnings.
7. Generate or inspect France-oriented tax outputs.
8. Record calculation version and unresolved assumptions.

Use [Tax Reporting](TAX_REPORTING.md) and [P&L and Cost Lots](PNL_AND_COST_LOTS.md).

## Fee-Heavy Activity

Use the `fee-pnl` scenario for focused review.

1. Start the scenario.
2. Inspect transactions with non-zero fees.
3. Verify fee asset mappings.
4. Refresh P&L.
5. Compare realized P&L with and without fee-heavy rows in filters.
6. Check warnings and lots consumed by fee events.

Fees can change both economic results and tax-oriented outputs.

## Dividend or Broker Income Review

Use the `degiro-dividend-lifecycle` or `degiro-file` scenario where relevant.

1. Import or inspect broker account files.
2. Resolve broker account mappings.
3. Resolve securities and cash asset mappings.
4. Check income or dividend events.
5. Review fees and withholding fields if present.
6. Refresh P&L.
7. Review tax-oriented income outputs.

Use [Tax Reporting](TAX_REPORTING.md) for income review scope.

## Derivatives and Positions

Use `derivative_pnl` or Hyperliquid-related data when reviewing derivatives.

1. Confirm the connector or file source imports derivative activity.
2. Open Positions to review exposure.
3. Inspect funding, transfers, realized P&L, and fees separately.
4. Review Timeline for high-activity periods.
5. Refresh P&L and inspect warnings.

Derivative tax treatment varies by jurisdiction. Validate externally before filing.

## Polymarket Review

Use `polymarket_pnl` or the Polymarket connector where configured.

1. Import activity for the relevant address.
2. Resolve asset and market-related mappings.
3. Review positions and realized outcomes.
4. Check prices and settlement values.
5. Refresh P&L.
6. Document manual assumptions.

## Corporate Action Review

Use `spinoff` for corporate-action style review.

1. Inspect the source records in All.
2. Confirm asset mappings for old and new instruments.
3. Review cost basis allocation.
4. Check P&L warnings.
5. Document any manual override.

Corporate actions are high-risk reporting events. Keep source evidence and calculation version together.

## Learning With Scenarios

List available scenarios:

```bash
task scenarios
```

Start a scenario:

```bash
SCENARIO=spinoff task start:scenario
```

Scenarios are isolated from the dev database and are useful for demos, manual QA, and training.
