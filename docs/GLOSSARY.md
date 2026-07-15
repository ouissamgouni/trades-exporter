# Glossary

## Account

A normalized place where assets are held or activity occurs, such as an exchange, wallet, broker account, or internal account.

## Account Connector

A configured import source attached to an account. Connectors can sync from APIs, on-chain sources, or source-specific files.

## Asset

A normalized instrument or currency, such as BTC, ETH, EUR, USD, a token, a stock, or a broker instrument.

## Asset Mapping

A link between a raw imported symbol and a normalized asset.

## Base Currency

The reporting currency used for P&L and tax-oriented outputs.

## Bundle

Older or user-facing name for a group of related transactions. In the current architecture, this maps closely to calculation units.

## Calculation Unit

A group of transaction legs that represent one economic event, such as a swap, transfer, flow, split, or custom grouping.

## Calculation Version

A snapshot of P&L results produced from the current data and settings at calculation time.

## Connector Run

One execution of a connector during a sync job. Connector runs are useful for troubleshooting and audit review.

## Cost Basis

The acquisition value assigned to an asset quantity. Cost basis is consumed when that quantity is disposed of.

## Cost Lot

A tracked quantity of an asset with acquisition information and cost basis.

## Duplicate

A transaction that appears to represent the same real-world event as another transaction.

## Excluded Transaction

A transaction intentionally left out of review or calculation workflows.

## Fair Market Value

The value of an asset at a point in time, usually used for P&L, income, or tax reporting.

## FIFO

First in, first out. A lot consumption method where the earliest available acquisition lots are consumed first.

## Income Event

An event treated as income-like activity, such as dividends, rewards, funding, interest, or source-specific income.

## Internal Transfer

A movement between accounts you own that should generally not be treated the same as a sale or disposal.

## Negative Lot

A lot condition where disposals exceed known acquisitions. It often indicates missing history, wrong mapping, duplicate records, or an edge case that needs review.

## Normalized Transaction

A cleaned transaction record using TradeTrail's internal account, asset, direction, type, and review fields.

## P&L

Profit and loss. In TradeTrail this includes realized P&L, cost lots, fees, positions, and calculation warnings.

## Price Snapshot

A historical price record used by calculations.

## Raw Account

An account label exactly as imported from a source before it is mapped to a normalized account.

## Raw Asset

An asset symbol exactly as imported from a source before it is mapped to a normalized asset.

## Raw Transaction

Imported source data before or alongside normalization.

## Realized P&L

Profit or loss recognized when an asset quantity is disposed of and cost basis is consumed.

## Review Status

The workflow state of a transaction, such as pending, reviewed, or excluded.

## Sync Job

A coordinated import run that may execute multiple connector runs.

## Taxability Status

The classification of an event as taxable, non-taxable, unknown, or otherwise overridden for tax review.

## Tax Override

A manual classification or value adjustment used when automated tax treatment needs user correction.
