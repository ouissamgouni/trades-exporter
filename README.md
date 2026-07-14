# TradeTrail

TradeTrail is a self-hosted transaction review and tax-reporting workspace for crypto and multi-asset activity. It imports data from exchanges, wallets, brokers, CSV files, and manual entries; normalizes the transactions; helps review grouping and data quality; calculates P&L; and produces tax-oriented exports.

The repository name is `trades-exporter`; the application UI is branded as TradeTrail.

## What It Helps With

- Import transactions from exchange, on-chain, broker, file, and manual sources.
- Map raw account and asset names to clean internal accounts and assets.
- Review duplicate transactions, unmapped data, grouping suggestions, and calculation warnings.
- Track positions, timeline activity, price data, cost lots, fees, realized P&L, and tax-oriented reports.
- Run isolated scenarios for QA, demos, and edge-case review.

TradeTrail can help organize tax work, but it does not replace professional tax advice. Always review outputs before filing.

## Quick Start

Prerequisites: Docker, Go Task, Python virtual environment dependencies, and Node/npm. The development workflow documents the full setup.

```bash
task install
task start:dev
```

Default local URLs:

- Web app: <http://localhost:5173>
- Backend API: <http://localhost:8000>
- Swagger/OpenAPI: <http://localhost:8000/docs>

Stop the development stack with:

```bash
task stop:dev
```

For a complete local development workflow, see [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md).

## User Workflow

The UI is organized around a practical accounting flow:

1. Setup accounts, connectors, assets, mappings, categories, and P&L defaults.
2. Sync or add data from connectors, files, or manual entries.
3. Review inbox items, raw mappings, duplicates, grouped transactions, and timelines.
4. Calculate P&L, inspect cost lots and positions, and prepare tax reports.

The main app tabs are Setup, Sync, Add / Import, Inbox, All, Timeline, Positions, P&L, and Prices.

## Documentation

Start with [docs/README.md](docs/README.md), then follow the guide that matches your task:

- [Getting Started](docs/GETTING_STARTED.md)
- [User Guide](docs/USER_GUIDE.md)
- [Import and Connectors](docs/IMPORT_AND_CONNECTORS.md)
- [Review and Data Quality](docs/REVIEW_AND_DATA_QUALITY.md)
- [P&L and Cost Lots](docs/PNL_AND_COST_LOTS.md)
- [Tax Reporting](docs/TAX_REPORTING.md)
- [Prices and Settings](docs/PRICES_AND_SETTINGS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [FAQ](docs/FAQ.md)
- [Glossary](docs/GLOSSARY.md)
- [Example Workflows](docs/EXAMPLE_WORKFLOWS.md)

## Project Structure

```text
backend/      FastAPI backend, database models, services, connectors, tests
frontend/     Vite React frontend
config/       Layered environment configuration
docs/         User and developer documentation
scenarios/    Seeded QA and demonstration datasets
infra/        Docker configuration
```

## Testing

```bash
task test
task test:unit:backend
task test:unit:frontend
```

Scenario environments are useful for manual QA and demos:

```bash
task scenarios
SCENARIO=fr_tax task start:scenario
```

See [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md) for integration tests, scenario ports, deployment-style local stacks, branching, and release tasks.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. In short:

- Sign off every commit under the [Developer Certificate of Origin](DCO) with `git commit -s`.
- By contributing you also agree to the [Contributor License Agreement](CLA.md).
- Run `task test` and keep changes focused with accompanying tests where practical.

## License

TradeTrail is free software licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later). See [LICENSE](LICENSE) for the full text.

The AGPL means you can use, study, modify, and self-host TradeTrail freely. If you run a modified version as a network service, you must make your modified source available to its users. The software is provided "as is", without warranty of any kind (see sections 15–16 of the license).

As the sole copyright holder, the maintainer retains the right to offer TradeTrail under separate commercial terms, including a hosted edition. See [CLA.md](CLA.md) for how this applies to contributions.

Copyright © 2026 Ouissam Gouni and the TradeTrail contributors.
