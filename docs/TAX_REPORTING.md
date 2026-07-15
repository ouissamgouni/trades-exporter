# Tax Reporting

TradeTrail helps organize transaction data and generate tax-oriented reports. This documentation explains the product workflow. It is not tax, legal, or accounting advice.

Always review generated reports with the rules that apply to your jurisdiction and, where appropriate, with a qualified tax professional.

## Current Scope

The application contains strong support for France-oriented crypto, securities, and income reporting workflows. Other jurisdictions may still benefit from transaction review and P&L exports, but they should not be treated as fully supported unless explicitly implemented and verified.

Use this practical scope:

| Jurisdiction | Current documentation stance |
| --- | --- |
| France | Primary documented tax-reporting workflow. |
| Other jurisdictions | Use P&L and export data for review, but validate rules externally. |

## Before Generating Tax Reports

Complete the review checklist first:

- All expected accounts, wallets, exchanges, brokers, and files are imported.
- Connector failures are fixed or documented.
- Raw account mappings are complete.
- Raw asset mappings are complete.
- Duplicates are reviewed.
- Grouping suggestions are accepted, dismissed, or corrected.
- Price gaps and P&L warnings are resolved or documented.
- P&L has been refreshed after the latest data changes.

## French Crypto Reporting

French crypto reporting depends on correct classification of taxable and non-taxable events, accurate fair market values, and complete acquisition/disposal history.

Review these areas closely:

- Crypto-to-fiat disposals.
- Crypto-to-crypto swaps where relevant to your reporting method.
- Internal transfers, which should generally not be double-counted as disposals.
- Fees paid in crypto.
- Missing acquisition history.
- Price data at disposal time.
- Manual taxability overrides.

When reviewing a French crypto report, trace any surprising line back to the source transaction, calculation unit, cost lot, and price snapshot.

## French Securities and Broker Activity

Broker imports such as DeGiro files may include securities activity, account statements, dividends, or related cash movements.

Review:

- Account file imports and transaction file imports together.
- Instrument symbols and asset mappings.
- Dividend and income events.
- Fees and withholding fields where present.
- Corporate actions such as spinoffs where represented in the data.

## Income Events

Income-like events may include dividends, rewards, funding, interest, airdrops, or other source-specific records.

Income treatment varies heavily by jurisdiction. Make sure the event type, value, date, asset, and source account are correct before relying on any summary.

## Overrides

Use tax overrides when the automated classification does not match the intended treatment.

Good override practice:

- Add a note explaining why the override exists.
- Keep source evidence outside the app where needed.
- Recalculate P&L after changing overrides.
- Recheck exported reports after recalculation.

Avoid using overrides to hide unresolved import or mapping problems.

## Exports and Audit Trail

When exporting reports, keep these files or references together:

- Exported report files.
- Calculation version.
- Source import files or connector run identifiers.
- Notes about unresolved warnings.
- Notes about manual overrides.
- Any accountant review comments.

This makes the report easier to reproduce later.

## Common Tax Review Problems

| Problem | Likely cause | Review path |
| --- | --- | --- |
| Taxable amount is too high | Duplicate disposals, internal transfer misclassified, missing cost basis | Review duplicates, grouping, taxability, and lots. |
| Taxable amount is too low | Missing source, excluded transaction, unmapped asset, stale P&L | Review imports, filters, mappings, and calculation status. |
| Fiat value looks wrong | Missing or incorrect price snapshot | Check Prices and transaction date. |
| Report changed unexpectedly | Data, mapping, price, grouping, or override changed after prior calculation | Compare calculation versions. |
| Income is missing | Source import lacks income records or event type is unmapped | Review source file/API coverage and transaction types. |

## Next Steps

- Understand calculations in [P&L and Cost Lots](PNL_AND_COST_LOTS.md).
- Resolve data quality issues in [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md).
- Check definitions in [Glossary](GLOSSARY.md).
