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

- **Cost** (economic) — the market value when the asset was received: the purchase price, or the value at a swap. Each gain is counted once, when it happens.
- **Tax cost** — follows the tax rules. On a tax-deferred (non-taxable) swap, such as a crypto-to-crypto swap under French rules, the asset received keeps the cost of the asset given up.

The two costs are the same unless a non-taxable swap happened earlier in the lot's history.

| Term | Where it is shown | Meaning |
|---|---|---|
| **Realized** | Everywhere (headline) | Proceeds − cost. Unrealized, Cost and Total return use the same view. |
| **Taxable** | Totals; "Taxable gain" per entry | Proceeds − tax cost, on taxable disposals only. Tax reports only read this view. |
| **Deferred** | Portfolio totals, Lots table | Gain already counted in Realized but not taxed yet: cost − tax cost of the lots you still hold. |
| **Deferred in** | Each realized entry | Taxable gain − Realized: the gain from earlier swaps that the consumed lots carried. *Released* (taxed now) on taxable disposals, *rolled over* into the new asset otherwise. |
| **Taxable if sold now** | Asset cards | Market value − tax cost = Unrealized + Deferred held in that asset. |
| **Net deposits** | Cost card (portfolio, account) | Money brought in from outside minus money taken out, valued when it moved. Value − Net deposits = Total return. For an account, transfers in and out of it also count, at cost. |
| **Total bought** | Asset cards ("bought") | Everything ever acquired for the asset, purchases and swaps, at the value received. |

For the whole portfolio, **Realized = Taxable + Deferred**. This does not hold per asset or account, because a deferred gain moves with swaps and transfers: it is counted in Realized where it was earned, and in Deferred where it is held now.

Deferred is not a forecast of tax: later price moves add to or offset it. The gain that would be taxed if you sold everything now is Unrealized + Deferred.

Example: BTC bought for 30 000 is swapped for 16 ETH worth 40 000 (Realized +10 000, Deferred 10 000). Eight ETH are then swapped for 24 000 USDC (Realized +4 000, Deferred in 5 000 rolled over), and the USDC is sold for 24 000 EUR (Realized 0, Taxable gain 9 000 = Deferred in released). Totals: Realized 14 000, Taxable 9 000, Deferred 5 000 still held in the other 8 ETH.

To see how one entry was computed, click its ID in the Realized P&L panel (or its value in the audit table): the entry panel shows both calculations, the lots consumed and the cost chain back to the original purchase. The P&L section of a transaction's side panel shows the same for one transaction, for the latest or any earlier calculation.

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
