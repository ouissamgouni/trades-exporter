# Review and Data Quality

Review is the most important part of the TradeTrail workflow. Imports create raw and normalized data, but users still need to confirm mappings, duplicates, grouping, taxability, prices, and calculation warnings.

## Review Goals

Before calculating P&L, aim to answer these questions:

- Are all expected sources imported?
- Are raw accounts mapped to the right internal accounts?
- Are raw asset symbols mapped to the right normalized assets?
- Are duplicates resolved or intentionally retained?
- Are related transaction legs grouped correctly?
- Are pending transactions reviewed?
- Are taxable and non-taxable events classified correctly?
- Are there missing prices that affect reporting?

## Inbox

Inbox is the focused queue for transactions and suggestions that need attention.

Use Inbox to review:

- Pending transaction counts.
- Suggested bundles or calculation units.
- Taxability suggestions.
- Duplicate indicators.
- Items that require user notes or exclusion.

Do not accept a grouping suggestion just because it has high confidence. Check source, timestamp, asset, amount, account, network, and economic meaning.

## All Transactions

The All tab is the complete ledger. Use it for filtering and row-level inspection.

Recommended filters during review:

- Date range, to compare with source statements.
- Source or connector run, to isolate a specific import.
- Account, to validate balances and ownership.
- Asset, to inspect symbol mapping.
- Review status, to find pending items.
- Taxability, to inspect unknown or overridden events.
- Network, to separate on-chain activity.

Open transaction details when a row looks wrong. The detail view can reveal raw source identifiers, account mappings, asset mappings, network transaction IDs, notes, and calculation context.

## Account Mappings

Raw account labels come from files, exchanges, wallets, and chain activity. They may not match the internal account names you want in reports.

Resolve Account Mappings when:

- Setup shows unmapped raw accounts.
- Transfers do not group correctly.
- Transactions appear under an unexpected account.
- Imported source labels are too vague for audit review.

Good account mapping improves transfer detection, account filters, and audit readability.

## Asset Mappings

Raw symbols can be ambiguous. A source symbol can represent a token, fiat asset, stock, wrapped asset, or exchange-specific instrument.

Resolve Asset Mappings when:

- Setup shows unmapped raw assets.
- A transaction has a raw symbol but no linked asset.
- Prices are missing because the normalized asset is unknown.
- Similar symbols exist across networks or brokers.

Be especially careful with wrapped tokens, bridged tokens, stock tickers, stablecoins, and symbols reused by unrelated assets.

## Duplicates

Duplicate detection helps identify transactions that look like repeated imports or overlapping source records.

Duplicates can happen when:

- The same file is imported twice.
- API sync overlaps with file import.
- An exchange reports the same event in multiple exports.
- On-chain and exchange data both represent the same transfer.

Review duplicate groups before calculating. Keep records that represent distinct real events; resolve or exclude repeated records that would double-count activity.

## Grouping and Calculation Units

TradeTrail groups related transaction legs into calculation units. Common patterns include swaps, internal transfers, flows, splits, custom groups, and unknown groups.

A good group should describe one economic event. For example:

- A crypto-to-crypto trade may have an outflow leg, inflow leg, and fee leg.
- An internal transfer may have a withdrawal from one account and deposit to another.
- A bridge may have outflow on one network and inflow on another.

Review groupings carefully because grouping affects taxability, P&L interpretation, and audit trails.

## Taxability Review

Taxability status describes whether an event should be treated as taxable, non-taxable, or unknown for reporting.

Examples that often need review:

- Crypto-to-fiat disposals.
- Crypto-to-crypto swaps.
- Internal transfers.
- Fees paid in crypto.
- Rewards, airdrops, income, or funding payments.
- Broker dividends or securities activity.

Tax rules vary by jurisdiction. Use TradeTrail classifications as workflow support, not as a substitute for professional review.

## Timeline Review

Timeline helps detect missing periods and import spikes. Use it after large imports to compare activity against source records.

Look for:

- Days with no activity when the source shows trades.
- Days with unexpectedly high counts.
- Missing deposit or withdrawal counterparties.
- Periods where an API sync may have stopped early.

## Data Health Checks

Data health indicators and warning counts are meant to keep review work visible. Treat warnings as actionable until you have verified that they are expected.

Common warning categories include:

- Pending review items.
- Unmapped raw accounts.
- Unmapped raw assets.
- Duplicates.
- Missing price data.
- Stale P&L calculations.

## Review Completion Checklist

Before using P&L or tax reports:

- All expected sources are imported.
- Failed connector runs are resolved or documented.
- Raw account mappings are complete for relevant sources.
- Raw asset mappings are complete for relevant sources.
- Duplicate groups are reviewed.
- Grouping suggestions are accepted, dismissed, or manually corrected.
- Pending transactions are reviewed or intentionally left pending.
- Missing price gaps are resolved or documented.
- P&L has been refreshed after the latest data changes.

## Next Steps

- Fix price gaps with [Prices and Settings](PRICES_AND_SETTINGS.md).
- Understand calculations with [P&L and Cost Lots](PNL_AND_COST_LOTS.md).
- Prepare reports with [Tax Reporting](TAX_REPORTING.md).
