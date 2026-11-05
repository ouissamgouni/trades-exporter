# Getting Started

This guide gets a new user from a local checkout to the first reviewed import. For deeper developer setup, see [Development Workflow](DEVELOPMENT_WORKFLOW.md).

## Before You Begin

Install these tools first:

- Docker, for the local database and containerized stacks.
- Go Task, used by the project command runner.
- Python 3.11 or newer.
- Node.js and npm.

On macOS, the development workflow suggests:

```bash
brew install go-task/tap/go-task
```

## Install Dependencies

From the repository root:

```bash
task install
```

This installs backend Python dependencies and frontend npm dependencies. The backend task expects the root-level virtual environment to exist at `.venv`.

If you need to create it manually:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

## Start the App

```bash
task start:dev
```

The dev stack starts:

- Database on the dev PostgreSQL port from `scenarios/dev/config.env`.
- Backend API on <http://localhost:8000> by default.
- Frontend on <http://localhost:5173> by default.

Open the web app at <http://localhost:5173>. API documentation is available at <http://localhost:8000/docs> while the backend is running.

Stop the dev stack with:

```bash
task stop:dev
```

## First Launch Checklist

Open the Setup tab and work through these areas.

### Accounts and Connectors

Create accounts for the places where transactions occur. An account can represent an exchange account, wallet, broker account, internal account, or other source of activity.

Add connectors to accounts when you want TradeTrail to sync data from an external source. A connector can be API-based, on-chain, or file-based depending on the source.

### Account Mappings

After imports, raw account names may appear before they are linked to internal accounts. Use Account Mappings to connect raw labels to the correct account. Do this before relying on grouped transfers or P&L.

### Assets

Create or review assets such as BTC, ETH, EUR, USD, stocks, tokens, or broker instruments. The asset list is the normalized vocabulary used by transactions, prices, positions, and reports.

### Asset Mappings

Imported files and connectors often use source-specific symbols. Use Asset Mappings to link raw symbols to the correct normalized asset. Unmapped assets can block accurate review, price lookup, and P&L.

### Categories

Categories help describe assets for reporting and review. Use them when you need portfolio grouping, tax grouping, or clearer review filters.

### P&L Settings

Set the base currency before calculating P&L. The default configuration uses EUR, but verify the setting matches the reporting currency you intend to use.

## Import Your First Data

You have three practical options:

1. Use Sync for configured connectors.
2. Use Add / Import for manual entry or generic CSV import.
3. Use file upload attached to file-capable connectors where available.

For details, see [Import and Connectors](IMPORT_AND_CONNECTORS.md).

## Review Before Calculating

After importing, open the Inbox and All tabs. Look for:

- Unmapped accounts or assets.
- Duplicate indicators.
- Bundle or grouping suggestions.
- Transactions still marked as pending.
- Transactions with surprising direction, quantity, fee, price, or taxability.

The P&L result is only as good as the reviewed data. See [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md).

## Calculate P&L

Open P&L after the data is mapped and reviewed. If the P&L tab shows a stale or calculating status, wait for the calculation to complete or refresh it from the panel.

Inspect warnings, cost lots, realized P&L, fees, and positions before exporting reports. See [P&L and Cost Lots](PNL_AND_COST_LOTS.md).

## Try a Scenario First

If you want sample data before using your own records:

```bash
task scenarios
SCENARIO=fr_tax task start:scenario
```

Scenarios run isolated stacks with seeded data. They are useful for learning the UI without changing your dev database. See [Example Workflows](EXAMPLE_WORKFLOWS.md).

## Next Steps

- Learn the UI in [User Guide](USER_GUIDE.md).
- Import real data with [Import and Connectors](IMPORT_AND_CONNECTORS.md).
- Keep [Troubleshooting](TROUBLESHOOTING.md) nearby for setup and import issues.
