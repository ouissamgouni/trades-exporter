# P&L and Cost Lots

The P&L workflow turns reviewed transactions into calculation outputs: cost lots, realized P&L, fees, positions, warnings, and tax-oriented report data.

This guide explains how to read the outputs. It is not accounting or tax advice.

## When to Calculate

Calculate P&L after importing and reviewing data. Refresh P&L again whenever you change:

- Transactions.
- Account mappings.
- Asset mappings.
- Groupings or calculation units.
- Taxability overrides.
- Price snapshots.
- P&L defaults.

If the P&L status is stale, outputs do not reflect the latest data.

## Calculation Versions

A calculation version is a snapshot of P&L output produced from the current reviewed data and settings. Keep the version together with any exported report so you can later explain which inputs produced the numbers.

Use versions to:

- Compare before and after review changes.
- Preserve a filing-period result.
- Revisit warnings from an earlier calculation.
- Avoid mixing reports from different data states.

## Cost Lots

A cost lot represents acquired quantity and cost basis. Lots are created when assets enter the portfolio through purchases, income, transfers with basis, or other supported acquisition events.

Lots are consumed when assets leave through sales, swaps, fees, transfers that should reduce available quantity, or other disposal events.

The project currently presents FIFO-oriented lot tracking and settlement concepts. Confirm current configuration and jurisdiction rules before using reports for filing.

## Realized P&L

Realized P&L is created when a disposal consumes cost lots. The simplified idea is:

```text
realized P&L = disposal proceeds - consumed cost basis - relevant fees
```

The actual treatment depends on transaction type, grouping, fee handling, price data, and tax overrides.

Review realized P&L by asset, account, date, and calculation version. Surprising values usually come from missing prices, wrong mappings, duplicate records, incorrect grouping, or missing historical acquisition data.

### Economic and Tax Views

Every lot carries two costs:

- **Tax cost** — follows the tax rules. On a tax-deferred (non-taxable) swap, such as a crypto-to-crypto swap under French rules, the asset received keeps the cost of the asset given up.
- **Economic cost** — the market value at the time of the swap. Each gain is counted once, when it happens.

The two costs are the same unless a non-taxable swap happened earlier in the lot's history.

- **Realized** (and Unrealized, Cost, Total return) uses the economic view.
- **Taxable** uses the tax view. Tax reports only read the tax view.
- **Deferred** is the gain already included in Realized but not yet taxed: the economic cost minus the tax cost of the lots you still hold. It is shown next to Taxable when it is not zero.

Example: BTC bought for 30 000 is swapped for ETH worth 40 000, and the ETH is later sold for 40 000 EUR. Realized shows +10 000 at the swap and 0 at the sale. Taxable shows 0 at the swap and +10 000 at the sale. In the Realized P&L list, rows where the two views differ show the tax figures in a grey "Tax: …" line.

## Fees

Fees can affect both economic P&L and tax reporting. A fee may be paid in fiat, the disposed asset, the acquired asset, a platform token, or another asset.

Review fee fields during transaction review because wrong fee assets or quantities can affect cost basis, proceeds, and remaining lots.

## Negative Lots

A negative lot can appear when the system sees a disposal before it sees the matching acquisition. Common causes include:

- Missing historical imports.
- Late or incomplete source data.
- Transfers without matching inbound records.
- Short or derivative-like activity.
- Incorrect asset mapping.

Negative lots should be investigated before reports are final. The technical design for settlement is documented in [Negative Lot Settlement Design](../backend/docs/tech-design/negative-lot-settlement.md), but user review should start with source completeness and mapping correctness.

## Settlement and Overrides

Some edge cases require settlement or fair-market-value review. Use overrides only when you understand why the automated result is incomplete or jurisdiction-specific.

Document manual changes with notes so an accountant or future reviewer can understand the reason.

## Positions

Positions show holdings or exposure where the imported data supports them. They are useful for reviewing open exposure, derivatives, and source-level balances, but they should not be treated as complete unless all sources and connector types are imported.

Compare positions against source balances when possible.

## Warnings

P&L warnings are review tasks. Common warning themes include:

- Missing price data.
- Missing acquisition history.
- Negative or unresolved lots.
- Unsupported transaction patterns.
- Ambiguous grouping or taxability.
- Incomplete source mappings.

Do not ignore warnings simply because a report exported successfully.

## Diagnosing Surprising P&L

If realized P&L looks wrong:

1. Check whether P&L is stale.
2. Inspect the related transaction group or calculation unit.
3. Check source transactions against the original exchange, wallet, or broker data.
4. Verify raw account and asset mappings.
5. Check for duplicates.
6. Inspect price snapshots around the transaction date.
7. Check whether historical acquisition data is missing.
8. Review fee assets and quantities.
9. Recalculate and compare the new version.

## Report-Ready Checklist

Before exporting P&L or tax reports:

- P&L status is current.
- Warnings are resolved or documented.
- Missing prices are resolved or documented.
- Negative lots are understood.
- Duplicate records are reviewed.
- Manual overrides have notes.
- The calculation version is recorded with the exported files.

## Next Steps

- Review tax outputs with [Tax Reporting](TAX_REPORTING.md).
- Fix price issues with [Prices and Settings](PRICES_AND_SETTINGS.md).
- Use [Troubleshooting](TROUBLESHOOTING.md) for common calculation problems.
