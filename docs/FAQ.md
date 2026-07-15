# FAQ

## Is TradeTrail tax software?

TradeTrail is a transaction review, P&L, and tax-reporting support tool. It can produce tax-oriented outputs, but users remain responsible for validating data and applying the correct tax rules.

## Which tax jurisdictions are supported?

France is the primary documented tax-reporting workflow. Other jurisdictions may still use transaction review and P&L exports, but should validate rules externally.

## Does my data leave my machine?

The standard workflow is self-hosted. Data is stored in your local environment unless you configure remote services or external APIs. Connectors and price sources may call third-party APIs depending on your configuration.

## What should I do first after importing?

Resolve raw account mappings, resolve raw asset mappings, review duplicates, inspect grouping suggestions, and check Timeline for missing periods.

## Why is P&L stale?

P&L becomes stale when inputs change. Imports, edits, mappings, prices, groupings, settings, or overrides can all require recalculation.

## Why are transactions pending?

Pending means the transaction still needs review. It may be newly imported, incomplete, unmapped, or waiting for a user decision.

## What is a bundle or calculation unit?

A calculation unit is a group of related transaction legs that represent one economic event, such as a swap, internal transfer, bridge, split, or custom grouping.

## Should I accept every grouping suggestion?

No. Suggestions are review aids. Accept only when the transactions match the real-world event.

## Why do I see duplicate transactions?

Duplicates often come from repeated file imports, overlapping API and file imports, or one event appearing in multiple source exports.

## Can I import manually?

Yes. Use Add / Import for manual entries and generic CSV import.

## Can I mix API sync and file import?

Yes, but review duplicates carefully. Mixing sources is common when APIs miss history, but it can double-count overlapping periods.

## What if an asset symbol is ambiguous?

Map it explicitly in Asset Mappings and add notes where needed. Be careful with wrapped tokens, bridged tokens, stablecoins, and stock tickers.

## What if an account label is ambiguous?

Map raw account labels to the correct internal account in Account Mappings. Clear account names improve transfer detection and audit review.

## Why are prices missing?

The asset may be unmapped, the price source may not support the asset or date, or the asset may need explicit price configuration.

## Can I edit prices?

The Prices workflow supports reviewing snapshots and editing or deleting snapshots where the UI exposes those actions. Recalculate P&L after price changes.

## What is a negative lot?

A negative lot usually means the system saw a disposal before the matching acquisition. This often indicates missing history, wrong mapping, duplicate data, or an edge case that needs review.

## Can I reset local data?

Development tasks include reset workflows, but resetting destroys local data. Back up anything important first and check [Development Workflow](DEVELOPMENT_WORKFLOW.md).

## How do I learn without using real data?

Use scenarios:

```bash
task scenarios
SCENARIO=fr_tax task start:scenario
```

## How do I know a report is ready?

A report is ready for review when imports are complete, mappings are resolved, duplicates are handled, prices are checked, P&L is current, warnings are documented, and exports are tied to a calculation version.

## Where should developers start?

Developers should read [Development Workflow](DEVELOPMENT_WORKFLOW.md). User-facing behavior is documented from [docs/README.md](README.md).
