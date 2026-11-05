# Import and Connectors

TradeTrail can bring data in through connector sync, connector file upload, generic CSV import, and manual entry. Use the import method that best matches the source and the level of auditability you need.

## Import Methods

### Connector Sync

Connector sync is the preferred path for sources supported by an API or chain explorer. A connector belongs to an account and can be enabled or disabled from Setup.

Use connector sync when:

- The source is supported by TradeTrail.
- You want repeatable incremental imports.
- You need connector run history.
- You want source-level troubleshooting.

### Connector File Upload

Some connectors are file-based. They use source-specific file parsers while still keeping the import tied to a connector and account.

Use connector file upload when:

- The exchange or broker provides a known export format.
- You want source-specific parsing rather than a generic CSV mapping.
- You want import history for the connector.

### Generic CSV Import

Generic CSV import is available from Add / Import. It is useful for prepared transaction files or unsupported sources.

Always preview the file before confirming. After import, check raw mappings and sample transactions.

### Manual Entry

Manual entry is for one-off adjustments, missing events, corrections, or small sources that do not justify a connector.

Manual records should be reviewed like any other imported transaction.

## Connector Support Matrix

This matrix describes connector types registered in the application. It does not guarantee that every connector is production-ready for every account, region, historical period, or export format. Verify with a small import before relying on a full report.

| Source | Connector types | Import mode | Notes |
| --- | --- | --- | --- |
| Binance | Transactions, deposits, withdrawals | API sync | Supports incremental sync on registered connector types. |
| MEXC | Transactions, deposits, withdrawals | API sync and file | File variants exist for transactions, deposits, and withdrawals. |
| OKX | Transactions, convert, deposits, withdrawals, trading history file | API sync and file | OKX file import supports source timezone configuration. |
| Coinbase | Transactions, deposits, withdrawals | API sync | Registered connector types support incremental sync. |
| DeGiro | Transactions file, account file | File | Useful for broker-style activity and account statements. |
| Hyperliquid | Perps, funding, transfers | API sync | Perps connector can feed derivative position tracking. |
| Blockscout | Base, Ethereum, Polygon, Arbitrum, Optimism, HyperEVM | On-chain | Requires chain and address. Can include internal transactions and token transfers. Base, Polygon and Arbitrum are currently blocked by Cloudflare; use Ankr there. |
| Etherscan | Ethereum | On-chain | Requires address. Can include internal transactions and token transfers. |
| Moralis | Ethereum, BSC, Base, Polygon, Arbitrum, Avalanche, Optimism, Sei | On-chain | Requires chain and address. Legacy; prefer Ankr. |
| Ankr | BSC, Arbitrum, Ethereum, Polygon, Base, Optimism, Avalanche | On-chain | Requires chain and address; uses `ANKR_API_KEY`. Native + ERC-20 transfers (no internal transactions). |
| Solana | Solana via Helius | On-chain | Requires address; API key is optional in the registered config. |
| XRP Ledger | XRP | On-chain | Requires address. |
| Cardano | Cardanoscan | On-chain | Requires address; API key is optional. See [Cardano Connector](../backend/docs/CARDANO_CONNECTOR.md). |
| SUI | SUI | On-chain | Requires address. Uses the public Sui GraphQL API. |
| Bitcoin | Blockstream Esplora | On-chain | Requires address. |
| NEAR | NearBlocks | On-chain | Requires address; API key is optional. |
| Bittensor | TAO | On-chain | Requires address; API key is optional. |
| Polymarket | Polygon-based Polymarket activity | On-chain/API | Requires the proxy wallet address only (public Data API). USDC deposits/withdrawals via Ankr (`ANKR_API_KEY`). Losing positions are closed at $0 on the market's resolution time; winning positions stay open until redeemed and are closed on the redeem date. |

### Switching provider

In the connector's edit dialog, **Switch provider** moves an on-chain connector to another provider for the same chain (for example Blockscout → Ankr) while keeping its ID, history and settings. History already imported stays with the previous provider: syncs never fetch transactions at or before the last imported one, and reprocessing reads each stored row with the provider that produced it.

## Preparing an Import

Before importing:

1. Create the target account in Setup.
2. Add or enable the connector if using connector sync or file upload.
3. Confirm base currency in P&L Settings.
4. Check existing assets for common symbols.
5. Decide the period you want to import.

For exchange imports, start with a short period if possible. For on-chain imports, consider rate limits and large-wallet history.

## Running a Sync

1. Open Setup and confirm the relevant account and connector are enabled.
2. Open Sync.
3. Start the sync job.
4. Watch the overall job status and connector-level run status.
5. Open run details if a connector fails.
6. Go to Inbox and All to review new data.

If one connector fails, do not assume the rest of the reporting period is complete. Fix the connector, rerun it, or document why that source is excluded.

## Uploading Files

For connector-specific file imports:

1. Attach the file-capable connector to the correct account.
2. Use the connector file upload UI.
3. Preview the parsed records.
4. Confirm only if source, account, date, quantity, fee, and asset fields look right.

For generic CSV import:

1. Open Add / Import.
2. Choose Import CSV.
3. Upload and preview the file.
4. Confirm the import.
5. Review raw mappings and transactions.

## After Import

Always complete these checks:

- Review import counts and failed connector runs.
- Resolve unmapped raw accounts.
- Resolve unmapped raw assets.
- Check duplicates.
- Review a sample of raw transaction data against the original source.
- Refresh P&L only after the data looks clean.

## Common Import Problems

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Connector failed | Missing credentials, rate limit, source outage, bad config | Open connector run details and retry after fixing config. |
| Transactions imported to the wrong account | Raw account mapping or connector/account relationship is wrong | Fix Account Mappings, then review affected transactions. |
| Assets appear as raw symbols | Asset mappings are missing | Link raw symbols in Asset Mappings. |
| Duplicate rows appear | Same period imported from multiple sources or repeated file upload | Use duplicate review tools before calculating P&L. |
| Missing old history | Source export/API is limited or start date is too recent | Import older files or adjust connector date settings where supported. |

## Next Steps

- Review imported data with [Review and Data Quality](REVIEW_AND_DATA_QUALITY.md).
- Check prices with [Prices and Settings](PRICES_AND_SETTINGS.md).
- Calculate only after review with [P&L and Cost Lots](PNL_AND_COST_LOTS.md).
