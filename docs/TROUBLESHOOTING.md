# Troubleshooting

Use this guide by symptom. If you are working on the codebase itself, also see [Development Workflow](DEVELOPMENT_WORKFLOW.md).

## The App Will Not Start

Try:

```bash
task status
task stop:dev
task start:dev
```

Check that Docker is running and the backend virtual environment exists at `backend/.venv`.

If dependencies are missing:

```bash
task install
```

## Frontend Opens but API Calls Fail

Symptoms include empty tabs, network errors, or setup status not loading.

Check:

- Backend is running at <http://localhost:8000>.
- Swagger docs open at <http://localhost:8000/docs>.
- Frontend was started with the correct `VITE_API_URL`.
- No old process is already using the backend port.

Restarting the dev stack often clears local port drift:

```bash
task stop:dev
task start:dev
```

## Database Is in a Bad Local State

For development data only, use the project database reset task from the workflow documentation. Do not reset a database that contains data you need unless you have a backup.

Review available tasks with:

```bash
task help
```

## Connector Fails

Check connector run details in Sync.

Common causes:

- Missing or invalid credentials.
- Wrong address or chain.
- API rate limits.
- Source outage.
- Unsupported export format.
- Start date too old or too new.

Fix the connector configuration, then rerun the sync. If the connector keeps failing, import a small period or file export to isolate the issue.

## File Import Looks Wrong

If previewed rows look wrong, do not confirm the import.

Check:

- Correct file type for the connector.
- Correct timezone setting where available.
- Header row and delimiter.
- Export period.
- Whether the source file is a trade history, account statement, deposits file, or withdrawals file.

If you already imported the file, use review filters to inspect the connector run or source before calculating P&L.

## Transactions Are Missing

Possible causes:

- Connector failed or stopped early.
- Start date excluded older data.
- Exchange API does not expose the required history.
- File export did not include all transaction types.
- Account or connector is disabled.
- Filters hide the rows in All.

Compare source record counts against connector run counts and Timeline activity.

## Transactions Are Duplicated

Possible causes:

- Same file imported more than once.
- API sync overlaps with file import.
- Deposits and withdrawals appear in multiple source exports.
- On-chain activity and exchange activity both represent one transfer.

Use duplicate review before calculating. Excluding repeated records is usually safer than relying on P&L to compensate later.

## Assets or Accounts Are Unmapped

Open Setup and resolve Account Mappings or Asset Mappings.

Unmapped accounts can break transfer detection and account filters. Unmapped assets can break price lookup and P&L.

## P&L Is Stale

P&L becomes stale after imports, transaction edits, mapping changes, grouping changes, price corrections, or setting changes.

Open P&L and refresh the calculation. Use the new calculation version for exports.

## P&L Looks Wrong

Check in this order:

1. Is P&L stale?
2. Are there duplicate transactions?
3. Are raw assets and accounts mapped?
4. Are important transaction groups correct?
5. Are prices present and plausible?
6. Is historical acquisition data missing?
7. Are fees mapped to the right asset?
8. Are taxability overrides documented?

## Tax Report Looks Wrong

Start from the report line and trace back to:

- Calculation version.
- Realized P&L entry.
- Cost lots consumed.
- Calculation unit or bundle.
- Source transactions.
- Price snapshots.
- Taxability overrides.

Most tax report problems originate in import completeness, duplicate records, mappings, grouping, prices, or stale calculations.

## Prices Are Missing

Check:

- Asset mapping is complete.
- The normalized asset has the expected symbol or price metadata.
- The price source supports the historical date.
- The asset is not a private, illiquid, or source-specific instrument.

After correcting prices, refresh P&L.

## Scenario Does Not Start

List scenarios and ports:

```bash
task scenarios
```

Start a named scenario:

```bash
SCENARIO=fr_tax task start:scenario
```

If a scenario is already running, stop it first:

```bash
SCENARIO=fr_tax task stop:scenario
```

## When to Stop and Review Manually

Pause before final exports if:

- You cannot explain a large P&L number.
- You see unresolved negative lots.
- You have missing prices around taxable events.
- You imported only partial history.
- You used manual overrides without notes.
- A connector failed for a source in the reporting period.

## Related Docs

- [Getting Started](GETTING_STARTED.md)
- [Import and Connectors](IMPORT_AND_CONNECTORS.md)
- [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md)
- [P&L and Cost Lots](PNL_AND_COST_LOTS.md)
- [Tax Reporting](TAX_REPORTING.md)
