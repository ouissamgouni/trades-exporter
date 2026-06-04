# User Guide

TradeTrail is organized around one main accounting workflow: setup, add data, review the data, then calculate and report P&L.

The header shows this as:

```text
1. Setup -> 2. Sync/Add -> 3. Review -> 4. P&L
```

The main tabs are Setup, Sync, Add / Import, Inbox, All, Timeline, Positions, P&L, and Prices.

## Setup

Use Setup to define the clean version of your data model before and after imports.

Setup has three main sections.

### Accounts

Accounts represent places where assets move or are held: exchanges, wallets, brokers, bank-like accounts, or internal accounts.

Use Accounts & Connectors to:

- Create accounts.
- Enable or disable accounts.
- Attach connectors.
- Review connector status.
- Keep account names consistent.

Use Account Mappings to link imported raw account labels to normalized accounts. This matters for internal transfers, source attribution, and account-level filters.

### Assets

Assets are normalized instruments such as fiat currencies, crypto assets, tokens, stocks, or broker instruments.

Use Assets to:

- Create and edit asset records.
- Check symbols and labels.
- Configure price-related metadata where available.

Use Asset Mappings to connect raw imported symbols to normalized assets. Do this when the Inbox or Setup tab reports unmapped raw assets.

Use Categories when you want assets grouped for review or reporting.

### P&L Settings

Use P&L Settings to review calculation defaults such as base currency. Changing defaults can affect future P&L calculations, so document changes before producing reports.

## Sync

Use Sync to run configured connectors and monitor import jobs.

Typical use:

1. Confirm accounts and connectors are enabled in Setup.
2. Open Sync.
3. Start a sync job.
4. Watch connector-level progress.
5. Open job details for errors or imported transaction counts.
6. Move to Inbox and All after the job finishes.

The Sync tab badge reports failures when the last job or one of its connector runs failed. Treat a failed connector as incomplete data until you resolve it or intentionally exclude that source from the reporting period.

## Add / Import

Use Add / Import when you need to enter transactions manually or upload a generic CSV.

### Manual Entry

Manual entry is useful for:

- One-off adjustments.
- Transactions missing from an exchange export.
- Broker or wallet events that are easier to key in than map from a file.
- Corrections that should stay visible in the transaction ledger.

After adding a manual transaction, review it in All and include it in P&L only after checking asset, account, direction, quantity, fee, and taxability.

### Import CSV

CSV import is useful when a source has no configured connector or when you have a prepared transaction file.

Preview before confirming the import. After confirming, check raw account and raw asset mappings before calculating P&L.

## Inbox

Inbox is the main review queue. Use it to resolve pending data and suggested groupings before calculating.

Look for:

- Pending transactions.
- Bundle or calculation-unit suggestions.
- Taxability suggestions.
- Duplicate indicators.
- Unmapped accounts or assets.
- Transactions that need exclusion or notes.

Grouping suggestions help combine related transaction legs into a single economic event, such as a swap or internal transfer. Accept suggestions only when the included transactions match the real-world event.

## All

All is the full transaction ledger. Use it when you need broad filtering, row-level review, or transaction detail inspection.

Common review filters include:

- Review status.
- Taxability.
- Source or connector run.
- Account.
- Asset.
- Transaction type.
- Date range.
- Network.
- Tags.

Use the transaction detail view to inspect raw data, normalized fields, mapped accounts, mapped assets, notes, duplicate information, and calculation context.

## Timeline

Timeline gives a date-oriented view of activity. Use it to spot missing periods, surprising spikes, or days with many related transactions.

Timeline review is especially useful after large imports because it can reveal gaps that are harder to see in a flat table.

## Positions

Positions is for holdings and derivative-style exposure where supported by the imported data. Use it to review open exposure, broker or exchange positions, and source-specific position records before relying on final reports.

If a connector does not provide position data, this tab may not represent that source completely.

## P&L

P&L is where reviewed data becomes calculation output.

Use it to:

- Refresh or inspect calculation status.
- Review calculation versions.
- Inspect realized P&L.
- Review cost lots.
- Review fee treatment.
- Check warnings.
- Prepare tax-oriented exports.

If the P&L badge shows stale, imported or edited data has changed since the last calculation. Refresh the calculation before using outputs.

## Prices

Prices shows historical price snapshots and price data used by calculations.

Use it to:

- Search price snapshots.
- Edit or delete incorrect snapshots where supported.
- Identify missing price data.
- Check asset-level price behavior.

Missing or incorrect prices can affect P&L and tax reporting. Resolve price gaps before treating reports as final.

## Status Bar and Badges

TradeTrail uses badges and status indicators to keep review work visible.

- Setup warnings mean required setup data or mappings are incomplete.
- Sync warnings mean at least one job or connector run failed.
- Inbox counts mean there are pending review items or suggestions.
- P&L stale status means calculations need refreshing after data changes.

## Safe Review Habits

- Import one source or small group of sources at a time when possible.
- Resolve raw mappings before reviewing taxability.
- Use Timeline to check for missing date ranges.
- Treat duplicates explicitly rather than ignoring them.
- Refresh P&L after any import, mapping change, transaction edit, or price correction.
- Keep exported reports and the calculation version together for auditability.

## Next Steps

- For import choices, read [Import and Connectors](IMPORT_AND_CONNECTORS.md).
- For review decisions, read [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md).
- For calculation outputs, read [P&L and Cost Lots](PNL_AND_COST_LOTS.md).
