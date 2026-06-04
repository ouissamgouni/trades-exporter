# TradeTrail User Documentation

This documentation is written for people using TradeTrail to organize transaction data, review accounting classifications, calculate P&L, and prepare tax reports. It focuses on the application workflow rather than the internal code architecture.

TradeTrail is a self-hosted tool. You are responsible for reviewing imported data, checking calculations, keeping backups, and validating tax outputs with a qualified professional where appropriate.

## Start Here

- [Getting Started](GETTING_STARTED.md) - install, run, and complete the first setup.
- [User Guide](USER_GUIDE.md) - walkthrough of the main app tabs and workflow.
- [Example Workflows](EXAMPLE_WORKFLOWS.md) - practical journeys for common use cases.
- [Glossary](GLOSSARY.md) - definitions for terms used across the app.

## Working With Data

- [Import and Connectors](IMPORT_AND_CONNECTORS.md) - sync connectors, file imports, manual entries, and supported connector types.
- [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md) - Inbox, mappings, duplicates, grouping suggestions, and warnings.
- [Prices and Settings](PRICES_AND_SETTINGS.md) - base currency, price data, price snapshots, and user-facing settings.

## Accounting and Tax

- [P&L and Cost Lots](PNL_AND_COST_LOTS.md) - calculation versions, lots, fees, positions, and warnings.
- [Tax Reporting](TAX_REPORTING.md) - supported tax-reporting flows, with France as the primary documented jurisdiction.

## Help

- [Troubleshooting](TROUBLESHOOTING.md) - symptom-based fixes for common issues.
- [FAQ](FAQ.md) - short answers to common product and workflow questions.

## Advanced References

- [Development Workflow](DEVELOPMENT_WORKFLOW.md) - local development, scenarios, testing, and local deployment stacks.
- [Cardano Connector](../backend/docs/CARDANO_CONNECTOR.md) - detailed Cardano connector behavior.
- [Negative Lot Settlement Design](../backend/docs/tech-design/negative-lot-settlement.md) - technical design behind one P&L edge case.

## Recommended Reading Order

1. Read [Getting Started](GETTING_STARTED.md).
2. Follow the [User Guide](USER_GUIDE.md) through Setup, Sync/Add, Review, and P&L.
3. Use [Import and Connectors](IMPORT_AND_CONNECTORS.md) for your exchange, wallet, broker, or file source.
4. Use [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md) before trusting calculations.
5. Use [P&L and Cost Lots](PNL_AND_COST_LOTS.md) and [Tax Reporting](TAX_REPORTING.md) when preparing reports.
