"""
Unit tests for Solana Helius connector.
Tests transaction normalization using fixtures.
"""

import pytest
from decimal import Decimal
from unittest.mock import patch, MagicMock
from backend.connectors.onchain.connector_solana_helius import ConnectorSolanaHelius


class TestSolanaConnector:
    """Test suite for Solana Helius connector."""

    @pytest.fixture
    def connector(self):
        """Create a test connector instance."""
        return ConnectorSolanaHelius(
            wallet_address="11111111111111111111111111111111111111111",
            account_id=1,
            connector_id=1,
            config={"test_mode": True}
        )

    def test_connector_initialization(self, connector):
        """Test connector initializes correctly."""
        assert connector.connector_name == "solana_helius"
        assert connector.wallet_address == "11111111111111111111111111111111111111111"
        assert connector.test_mode is True

    def test_yield_raws_from_fixture(self, connector):
        """Test that yield_raws loads transactions from fixture file."""
        transactions = list(connector.yield_raws())
        
        # Should load 6 transactions from fixture
        assert len(transactions) == 6
        
        # Verify structure of first transaction
        first_tx = transactions[0]
        assert "signature" in first_tx
        assert "timestamp" in first_tx
        assert "type" in first_tx
        assert "fee" in first_tx
        assert "feePayer" in first_tx

    def test_normalization_native_transfer_outflow(self, connector):
        """Test normalization of native SOL transfer (outflow)."""
        # First transaction: native outflow with fee
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[0]))
        
        # Should yield 1 native transfer + 1 fee transaction
        assert len(normalized) == 2
        
        # Check native transfer
        transfer = normalized[0]
        assert transfer.source_transaction_id == f"{raw_txs[0]['signature']}_native_0"
        assert transfer.network_transaction_id == raw_txs[0]['signature']
        assert transfer.direction == "outflow"
        assert transfer.source_asset_symbol == "SOL"
        assert transfer.quantity == Decimal("1.5")  # 1.5 SOL (1500000000 lamports)
        assert transfer.fee == Decimal(0)
        assert transfer.include_fee is False
        assert transfer.network == "solana"
        assert transfer.transaction_type == "transfer"
        assert transfer.source_transaction_type == "TRANSFER"
        
        # Check fee transaction (new COST format: qty=fee, price=1)
        fee_tx = normalized[1]
        assert fee_tx.source_transaction_id == f"{raw_txs[0]['signature']}_fee"
        assert fee_tx.direction == "outflow"
        assert fee_tx.transaction_type == "cost"
        assert fee_tx.quantity == Decimal("0.000005")  # 5000 lamports
        assert fee_tx.price == Decimal(1)
        assert fee_tx.include_fee is False
        assert fee_tx.source_asset_symbol == "SOL"

    def test_normalization_token_transfers_swap(self, connector):
        """Test normalization of token swap with multiple transfers."""
        # Second transaction: USDC -> USDT swap
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[1]))
        
        # Should yield 2 token transfers + 1 fee transaction
        assert len(normalized) == 3
        
        # Check outgoing USDC
        usdc_transfer = normalized[0]
        assert usdc_transfer.source_transaction_id == f"{raw_txs[1]['signature']}_token_0"
        assert usdc_transfer.direction == "outflow"
        assert usdc_transfer.source_asset_symbol == "USDC"
        assert usdc_transfer.quantity == Decimal("100")  # 100 USDC (6 decimals)
        assert usdc_transfer.token_contract_address == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        
        # Check incoming USDT
        usdt_transfer = normalized[1]
        assert usdt_transfer.source_transaction_id == f"{raw_txs[1]['signature']}_token_1"
        assert usdt_transfer.direction == "inflow"
        assert usdt_transfer.source_asset_symbol == "USDT"
        assert usdt_transfer.quantity == Decimal("95")  # 95 USDT (6 decimals)
        assert usdt_transfer.token_contract_address == "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
        
        # Check fee transaction
        fee_tx = normalized[2]
        assert fee_tx.source_transaction_id == f"{raw_txs[1]['signature']}_fee"
        assert fee_tx.transaction_type == "cost"

    def test_normalization_native_transfer_inflow(self, connector):
        """Test normalization of native SOL transfer (inflow)."""
        # Third transaction: native inflow, fee paid by other wallet
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[2]))
        
        # Should yield 1 native transfer only (no fee transaction since feePayer is different)
        assert len(normalized) == 1
        
        transfer = normalized[0]
        assert transfer.direction == "inflow"
        assert transfer.source_asset_symbol == "SOL"
        assert transfer.quantity == Decimal("0.5")  # 0.5 SOL (500000000 lamports)
        assert transfer.fee == Decimal(0)

    def test_normalization_filters_ineligible_transfers(self, connector):
        """Test that transfers not involving the wallet are filtered out."""
        # Fourth transaction: transfers between other wallets
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[3]))
        
        # Should yield nothing (no eligible transfers)
        assert len(normalized) == 0

    def test_normalization_token_transfer_inflow(self, connector):
        """Test normalization of token transfer (inflow)."""
        # Fifth transaction: mSOL inflow with fee paid by wallet
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[4]))
        
        # Should yield 1 token transfer + 1 fee transaction
        assert len(normalized) == 2
        
        # Check token transfer
        transfer = normalized[0]
        assert transfer.source_transaction_id == f"{raw_txs[4]['signature']}_token_0"
        assert transfer.direction == "inflow"
        assert transfer.source_asset_symbol == "mSOL"
        assert transfer.quantity == Decimal("50")  # 50 mSOL (9 decimals)
        assert transfer.token_contract_address == "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"

    def test_token_metadata_caching(self, connector):
        """Test that token metadata is cached after first lookup."""
        mint_address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        
        # First call should load from fixture
        metadata1 = connector._get_token_metadata(mint_address)
        assert metadata1["symbol"] == "USDC"
        assert metadata1["decimals"] == 6
        
        # Second call should return cached value
        metadata2 = connector._get_token_metadata(mint_address)
        assert metadata2 == metadata1
        assert mint_address in connector._token_cache

    def test_token_metadata_fallback(self, connector):
        """Test fallback when token metadata is not found."""
        unknown_mint = "UnknownMint1111111111111111111111111111111"
        
        metadata = connector._get_token_metadata(unknown_mint)
        
        # Should fallback to mint address as symbol and default decimals
        assert metadata["symbol"] == unknown_mint
        assert metadata["decimals"] == 8

    def test_direction_determination(self, connector):
        """Test direction determination logic."""
        wallet = connector.wallet_address
        other = "OtherAddress123456789012345678901234567890"
        
        # Outflow
        assert connector._determine_direction(wallet, other) == "outflow"
        
        # Inflow
        assert connector._determine_direction(other, wallet) == "inflow"
        
        # Self-transfer
        assert connector._determine_direction(wallet, wallet) == "neutral"
        
        # Neither (edge case)
        assert connector._determine_direction(other, other) == "neutral"

    def test_sol_decimal_conversion(self, connector):
        """Test SOL lamports to SOL conversion."""
        # 1 SOL = 1,000,000,000 lamports
        assert Decimal(1_000_000_000) / connector.SOL_DIVISOR == Decimal("1")
        assert Decimal(500_000_000) / connector.SOL_DIVISOR == Decimal("0.5")
        assert Decimal(5000) / connector.SOL_DIVISOR == Decimal("0.000005")

    def test_source_transaction_id_uniqueness(self, connector):
        """Test that source_transaction_id is unique for each transfer."""
        raw_txs = list(connector.yield_raws())
        
        # Get all normalized transactions
        all_normalized = []
        for raw_tx in raw_txs:
            all_normalized.extend(list(connector.raw_to_normalized(raw_tx)))
        
        # Collect all source_transaction_ids
        tx_ids = [tx.source_transaction_id for tx in all_normalized]
        
        # All IDs should be unique
        assert len(tx_ids) == len(set(tx_ids))
        
        # Verify format
        for tx_id in tx_ids:
            # Should match pattern: [SIGNATURE]_[native|token|fee]_[INDEX]
            parts = tx_id.split("_")
            assert len(parts) >= 2
            assert parts[1] in ["native", "token", "fee"]

    def test_network_transaction_id_grouping(self, connector):
        """Test that all transfers from same transaction share network_transaction_id."""
        raw_txs = list(connector.yield_raws())
        
        # Second transaction has multiple transfers
        swap_tx = raw_txs[1]
        normalized = list(connector.raw_to_normalized(swap_tx))
        
        # All should have same network_transaction_id
        network_ids = [tx.network_transaction_id for tx in normalized]
        assert len(set(network_ids)) == 1
        assert network_ids[0] == swap_tx["signature"]

    def test_wsol_swap_skips_native_transfers_to_token_accounts(self, connector):
        """Regression test: native SOL transfers to/from Wrapped SOL token accounts
        must be skipped to avoid double-counting the same SOL outflow.

        In a SOL→token SWAP on Orca/Jupiter, the wallet:
          1. Funds a temporary wSOL token account with SOL + rent (nativeTransfer)
          2. The wSOL is sent to the DEX pool (tokenTransfer with mint So111...112)
          3. The temp account is closed, returning rent (nativeTransfer back)

        Only the tokenTransfer should be emitted; the native funding/defunding
        are book-keeping and would double-count the 0.5 SOL.
        """
        # 6th fixture: the real-world Orca SWAP with wSOL
        raw_txs = list(connector.yield_raws())
        swap_tx = raw_txs[5]
        assert swap_tx["type"] == "SWAP"

        normalized = list(connector.raw_to_normalized(swap_tx))

        # Collect by sub-type
        native_txs = [t for t in normalized if "_native_" in t.source_transaction_id]
        token_txs = [t for t in normalized if "_token_" in t.source_transaction_id]
        fee_txs = [t for t in normalized if "_fee" in t.source_transaction_id]

        # The 4 native transfers are:
        #   idx 0: wallet → Cw8C (3021 lamports priority fee tip) — kept
        #   idx 1: wallet → 5QDi (wSOL token account funding) — SKIPPED
        #   idx 2: wallet → 85aK (ATA rent for AVO token account) — kept
        #   idx 3: 5QDi → wallet (rent refund from closing wSOL acct) — SKIPPED
        # So only native_0 and native_2 should survive.
        assert len(native_txs) == 2, (
            f"Expected 2 native transfers (tip + ATA rent), got {len(native_txs)}: "
            f"{[t.source_transaction_id.split('_')[-1] for t in native_txs]}"
        )

        # Verify the surviving native transfers are the right ones
        native_ids = {t.source_transaction_id.rsplit("_", 1)[-1] for t in native_txs}
        assert native_ids == {"0", "2"}, f"Unexpected native indices: {native_ids}"

        # Token transfers: 2 (wSOL outflow + AVO inflow)
        assert len(token_txs) == 2

        wsol_out = [t for t in token_txs if t.source_asset_symbol == "SOL"]
        assert len(wsol_out) == 1
        assert wsol_out[0].direction == "outflow"
        assert wsol_out[0].quantity == Decimal("0.5")

        avo_in = [t for t in token_txs if t.source_asset_symbol == "AVO"]
        assert len(avo_in) == 1
        assert avo_in[0].direction == "inflow"
        assert avo_in[0].quantity == Decimal("4949.877725022")

        # Fee transaction (new COST format)
        assert len(fee_txs) == 1
        assert fee_txs[0].quantity == Decimal(11774) / Decimal(10**9)

    def test_wsol_swap_no_sol_double_counting(self, connector):
        """Verify the total SOL outflow from a wSOL SWAP is not double-counted.

        Before the fix, both native_1 (0.502 SOL) and token_0 (0.5 SOL) were
        emitted, overcounting the swap input. After the fix only the token
        transfer (0.5 SOL) should represent the swap SOL outflow.
        """
        raw_txs = list(connector.yield_raws())
        swap_tx = raw_txs[5]
        normalized = list(connector.raw_to_normalized(swap_tx))

        sol_outflows = [
            t for t in normalized
            if t.source_asset_symbol == "SOL"
            and t.direction == "outflow"
            and t.transaction_type == "transfer"
        ]

        # Sum of SOL outflow should NOT include the 0.502 native funding.
        # Expected: native_0 tip (0.000003021) + native_2 ATA rent (0.002039280)
        #         + token_0 wSOL (0.5)
        total_sol_out = sum(t.quantity for t in sol_outflows)
        expected = Decimal("0.000003021") + Decimal("0.002039280") + Decimal("0.5")
        assert total_sol_out == expected, (
            f"SOL outflow mismatch: got {total_sol_out}, expected {expected}. "
            f"Transfers: {[(t.source_transaction_id, t.quantity) for t in sol_outflows]}"
        )

    def test_non_wsol_native_transfers_unaffected(self, connector):
        """Ensure the wSOL filter does NOT affect transactions without Wrapped SOL."""
        # 1st fixture: plain native SOL outflow, no token transfers
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[0]))

        # Should still yield 1 native + 1 fee (unchanged behaviour)
        native_txs = [t for t in normalized if "_native_" in t.source_transaction_id]
        assert len(native_txs) == 1
        assert native_txs[0].quantity == Decimal("1.5")

    def test_token_amount_not_double_divided(self, connector):
        """Regression test: tokenAmount from Helius is already human-readable.
        
        Ensures the connector does NOT divide tokenAmount by 10^decimals again.
        See: Helius tokenTransfers[].tokenAmount is pre-divided, unlike
        rawTokenAmount in accountData which is in base units.
        """
        raw_tx = {
            "signature": "41po6Wst73PKC1tD5qzKP33GMTwCntXm1RFB9JTVNaJ83oX8KtW8Paqi5gs69QmPmehKf5F18MmqvMq6DyrYCDzj",
            "timestamp": 1762040831,
            "type": "TRANSFER",
            "fee": 69886,
            "feePayer": "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
            "nativeTransfers": [],
            "tokenTransfers": [
                {
                    "fromUserAccount": "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
                    "toUserAccount": "11111111111111111111111111111111111111111",
                    "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
                    "tokenAmount": 78517.27,
                    "tokenStandard": "Fungible"
                }
            ]
        }

        normalized = list(connector.raw_to_normalized(raw_tx))

        # Should yield 1 token inflow (no fee — feePayer is not our wallet)
        token_transfers = [tx for tx in normalized if tx.transaction_type == "transfer"]
        assert len(token_transfers) == 1

        transfer = token_transfers[0]
        assert transfer.direction == "inflow"
        assert transfer.quantity == Decimal("78517.27"), (
            f"Expected 78517.27 but got {transfer.quantity} — "
            "tokenAmount is already human-readable, do not divide by 10^decimals"
        )
        assert transfer.network == "solana"
        assert transfer.token_contract_address == "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"

    def test_dust_native_transfer_skipped(self, connector):
        """Native transfers below DUST_THRESHOLD_LAMPORTS should be skipped.

        Solana spam/dust attacks commonly send 1 lamport (0.000000001 SOL)
        to wallets. These have no economic value and pollute the tx list.
        """
        raw_tx = {
            "signature": "dust_spam_sig_001",
            "timestamp": 1728942550,
            "type": "TRANSFER",
            "fee": 5000,
            "feePayer": "FLipG5QHjZe1H12f6rr5LCnrmqjhwuBTBp78GwzxnwkR",
            "nativeTransfers": [
                {
                    "fromUserAccount": "FLipG5QHjZe1H12f6rr5LCnrmqjhwuBTBp78GwzxnwkR",
                    "toUserAccount": "11111111111111111111111111111111111111111",
                    "amount": 1,  # 1 lamport — dust
                }
            ],
            "tokenTransfers": [],
        }

        normalized = list(connector.raw_to_normalized(raw_tx))

        # Should yield nothing — 1 lamport is below threshold, and fee payer
        # is not our wallet so fee is also skipped
        assert len(normalized) == 0

    def test_dust_threshold_boundary(self, connector):
        """Transfers at exactly the threshold should be included."""
        threshold = connector.DUST_THRESHOLD_LAMPORTS  # 1000

        raw_tx = {
            "signature": "dust_boundary_sig",
            "timestamp": 1728942550,
            "type": "TRANSFER",
            "fee": 5000,
            "feePayer": "SomeOtherPayer",
            "nativeTransfers": [
                {
                    "fromUserAccount": "SomeSender",
                    "toUserAccount": "11111111111111111111111111111111111111111",
                    "amount": threshold - 1,  # 999 — just below, should be skipped
                },
                {
                    "fromUserAccount": "SomeSender2",
                    "toUserAccount": "11111111111111111111111111111111111111111",
                    "amount": threshold,  # 1000 — at threshold, should be included
                },
                {
                    "fromUserAccount": "SomeSender3",
                    "toUserAccount": "11111111111111111111111111111111111111111",
                    "amount": threshold + 1,  # 1001 — above, should be included
                },
            ],
            "tokenTransfers": [],
        }

        normalized = list(connector.raw_to_normalized(raw_tx))

        native_txs = [t for t in normalized if "_native_" in t.source_transaction_id]
        # 999 skipped, 1000 + 1001 included
        assert len(native_txs) == 2
        quantities = sorted([t.quantity for t in native_txs])
        assert quantities[0] == Decimal(threshold) / connector.SOL_DIVISOR
        assert quantities[1] == Decimal(threshold + 1) / connector.SOL_DIVISOR


class TestSolanaRpcGapFill:
    """Tests for the RPC gap-fill mechanism that catches transactions
    missed by the Helius enhanced API due to indexing lag."""

    def _make_live_connector(self):
        """Create a connector in live mode with mocked API credentials."""
        with patch.dict("os.environ", {"HELIUS_API_KEY": "test-key"}):
            connector = ConnectorSolanaHelius(
                wallet_address="11111111111111111111111111111111111111111",
                account_id=1,
                connector_id=1,
                config={},
            )
        return connector

    def test_fetch_missing_yields_gap_transactions(self):
        """Gap-fill should discover and yield transactions that the
        enhanced API missed."""
        connector = self._make_live_connector()

        # Simulate: enhanced API returned sig_A and sig_B
        seen = {"sig_A", "sig_B"}

        # RPC returns sig_A, sig_B, sig_C (sig_C is the gap)
        rpc_sigs = [
            {"signature": "sig_A", "err": None},
            {"signature": "sig_B", "err": None},
            {"signature": "sig_C", "err": None},
        ]

        parsed_response = [
            {
                "signature": "sig_C",
                "timestamp": 1772498488,
                "type": "TRANSFER",
                "fee": 5000,
                "feePayer": "other",
                "nativeTransfers": [],
                "tokenTransfers": [
                    {
                        "fromUserAccount": "other",
                        "toUserAccount": "11111111111111111111111111111111111111111",
                        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                        "tokenAmount": 48.956623,
                    }
                ],
            }
        ]

        with patch.object(connector, "_get_wallet_token_accounts", return_value=[]):
            with patch.object(connector, "_rpc_request", return_value=rpc_sigs):
                with patch.object(connector, "safe_request", return_value=parsed_response):
                    results = list(connector._fetch_missing_via_rpc(seen))

        assert len(results) == 1
        assert results[0]["signature"] == "sig_C"

    def test_fetch_missing_skips_errored_rpc_sigs(self):
        """Signatures with `err != None` in RPC response should be ignored."""
        connector = self._make_live_connector()

        rpc_sigs = [
            {"signature": "sig_ok", "err": None},
            {"signature": "sig_fail", "err": {"InstructionError": [0, "Custom"]}},
        ]

        parsed_response = [
            {"signature": "sig_ok", "timestamp": 1772498488, "type": "TRANSFER",
             "fee": 0, "feePayer": "x", "nativeTransfers": [], "tokenTransfers": []}
        ]

        with patch.object(connector, "_get_wallet_token_accounts", return_value=[]):
            with patch.object(connector, "_rpc_request", return_value=rpc_sigs):
                with patch.object(connector, "safe_request", return_value=parsed_response):
                    results = list(connector._fetch_missing_via_rpc(set()))

        sigs = [r["signature"] for r in results]
        assert "sig_ok" in sigs
        assert "sig_fail" not in sigs

    def test_fetch_missing_no_gaps(self):
        """If RPC returns exactly what the enhanced API already had, yield nothing."""
        connector = self._make_live_connector()

        seen = {"sig_A", "sig_B"}
        rpc_sigs = [
            {"signature": "sig_A", "err": None},
            {"signature": "sig_B", "err": None},
        ]

        with patch.object(connector, "_get_wallet_token_accounts", return_value=[]):
            with patch.object(connector, "_rpc_request", return_value=rpc_sigs):
                results = list(connector._fetch_missing_via_rpc(seen))

        assert results == []

    def test_fetch_missing_is_best_effort(self):
        """If the RPC call fails, gap-fill should not raise — it logs a warning."""
        connector = self._make_live_connector()

        with patch.object(
            connector, "_get_wallet_token_accounts", side_effect=RuntimeError("RPC down")
        ):
            with patch.object(
                connector, "_rpc_request", side_effect=RuntimeError("RPC down")
            ):
                # Should NOT raise
                results = list(connector._fetch_missing_via_rpc(set()))

        assert results == []

    def test_fetch_missing_batches_large_gap(self):
        """When more than PARSE_BATCH_SIZE signatures are missing,
        they should be split into multiple parse requests."""
        connector = self._make_live_connector()
        connector.PARSE_BATCH_SIZE = 2  # small batch for testing

        seen = set()
        rpc_sigs = [
            {"signature": f"sig_{i}", "err": None} for i in range(5)
        ]

        def mock_safe_request(endpoint, method="GET", json_body=None, params=None):
            sigs = json_body["transactions"]
            return [{"signature": s, "timestamp": 1772498488, "type": "TRANSFER",
                      "fee": 0, "feePayer": "x",
                      "nativeTransfers": [], "tokenTransfers": []} for s in sigs]

        with patch.object(connector, "_get_wallet_token_accounts", return_value=[]):
            with patch.object(connector, "_rpc_request", return_value=rpc_sigs):
                with patch.object(connector, "safe_request", side_effect=mock_safe_request):
                    results = list(connector._fetch_missing_via_rpc(seen))

        assert len(results) == 5

    def test_yield_raws_live_includes_gap_fill(self):
        """End-to-end: yield_raws should include gap-filled transactions."""
        connector = self._make_live_connector()

        # Enhanced API returns 1 transaction
        enhanced_tx = {
            "signature": "enhanced_sig_1",
            "timestamp": 1772490000,
            "type": "TRANSFER",
            "fee": 5000,
            "feePayer": "11111111111111111111111111111111111111111",
            "nativeTransfers": [
                {
                    "fromUserAccount": "11111111111111111111111111111111111111111",
                    "toUserAccount": "someone",
                    "amount": 1000000000,
                }
            ],
            "tokenTransfers": [],
        }

        # Gap-fill finds 1 additional transaction
        gap_tx = {
            "signature": "gap_sig_1",
            "timestamp": 1772498488,
            "type": "TRANSFER",
            "fee": 5000,
            "feePayer": "other",
            "nativeTransfers": [],
            "tokenTransfers": [
                {
                    "fromUserAccount": "other",
                    "toUserAccount": "11111111111111111111111111111111111111111",
                    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                    "tokenAmount": 48.956623,
                }
            ],
        }

        def mock_safe_request(endpoint, params=None, method="GET", json_body=None):
            if method == "POST":
                return [gap_tx]
            # Enhanced API: first call returns 1 tx, second returns empty
            if not hasattr(mock_safe_request, "_called"):
                mock_safe_request._called = True
                return [enhanced_tx]
            return []

        rpc_sigs = [
            {"signature": "enhanced_sig_1", "err": None},
            {"signature": "gap_sig_1", "err": None},
        ]

        with patch.object(connector, "safe_request", side_effect=mock_safe_request):
            with patch.object(connector, "_rpc_request", return_value=rpc_sigs):
                with patch.object(connector, "_get_wallet_token_accounts", return_value=[]):
                    with patch.object(connector, "update_progress"):
                        results = list(connector.yield_raws())

        sigs = [r["signature"] for r in results]
        assert "enhanced_sig_1" in sigs
        assert "gap_sig_1" in sigs
        assert len(results) == 2

    def test_fetch_missing_via_ata_discovers_token_transfer(self):
        """Gap-fill should discover token transfers by querying the wallet's
        Associated Token Accounts (ATAs), not just the wallet address."""
        connector = self._make_live_connector()

        # Enhanced API returned sig_A only; the target token transfer (sig_T)
        # was missed because the wallet address wasn't a direct account key.
        seen = {"sig_A"}

        # Wallet address query returns sig_A only
        wallet_rpc_sigs = [
            {"signature": "sig_A", "err": None},
        ]
        # USDC ATA query returns sig_A (also referenced) + sig_T (the gap)
        ata_rpc_sigs = [
            {"signature": "sig_A", "err": None},
            {"signature": "sig_T", "err": None},
        ]

        parsed_response = [
            {
                "signature": "sig_T",
                "timestamp": 1772498488,
                "type": "TRANSFER",
                "fee": 5000,
                "feePayer": "other",
                "nativeTransfers": [],
                "tokenTransfers": [
                    {
                        "fromUserAccount": "other",
                        "toUserAccount": "11111111111111111111111111111111111111111",
                        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                        "tokenAmount": 48.956623,
                    }
                ],
            }
        ]

        # Mock _rpc_request to return different results per address
        def mock_rpc_request(method, params):
            addr = params[0]
            if addr == connector.wallet_address:
                return wallet_rpc_sigs
            else:
                return ata_rpc_sigs

        with patch.object(connector, "_get_wallet_token_accounts",
                          return_value=["65MoBaeZyGf2hFnkCN7G_fake_ata"]):
            with patch.object(connector, "_rpc_request", side_effect=mock_rpc_request):
                with patch.object(connector, "safe_request", return_value=parsed_response):
                    results = list(connector._fetch_missing_via_rpc(seen))

        assert len(results) == 1
        assert results[0]["signature"] == "sig_T"

    def test_get_wallet_token_accounts_returns_pubkeys(self):
        """ATAs of both the legacy Token program and Token-2022 (e.g. PUMP) are returned."""
        connector = self._make_live_connector()

        by_program = {
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": {
                "value": [{"pubkey": "ata_usdc_123"}, {"pubkey": "ata_sol_456"}]
            },
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": {
                "value": [{"pubkey": "ata_pump_789"}]
            },
        }

        def mock_rpc(method, params):
            return by_program[params[1]["programId"]]

        with patch.object(connector, "_rpc_request", side_effect=mock_rpc):
            atas = connector._get_wallet_token_accounts()

        assert atas == ["ata_usdc_123", "ata_sol_456", "ata_pump_789"]

    def test_yield_raws_requests_token_account_activity(self):
        """Regression: incoming PUMP (Token-2022) transfer only touches the wallet's ATA."""
        connector = self._make_live_connector()
        pump_tx = {
            "signature": "VLodtUohx1hG5ndgg6GQQZkM3oH5ixQxGgAfEKWSXyywYRWGJKPVXtnDfNoBxJY6cbq3qgRMb7FE5EYMKhof8Mx",
            "timestamp": 1794331863,
            "type": "TRANSFER",
            "fee": 5543,
            "feePayer": "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
            "nativeTransfers": [],
            "tokenTransfers": [
                {
                    "fromTokenAccount": "96iQ6xGxAkT4JpoJK6X5nT3U1HuXyT1M4oD8q8VRbnWu",
                    "toTokenAccount": "FNkWv4my3bhpZqjMEn2uooaVfHDrdrGwUczMaPCgHTgg",
                    "fromUserAccount": "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
                    "toUserAccount": connector.wallet_address,
                    "tokenAmount": 8836.09,
                    "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
                }
            ],
        }
        calls = []

        def mock_safe_request(endpoint, params=None, method="GET", json_body=None):
            calls.append(dict(params or {}))
            return [pump_tx] if len(calls) == 1 else []

        with patch.object(connector, "safe_request", side_effect=mock_safe_request):
            with patch.object(connector, "_fetch_missing_via_rpc", return_value=iter([])):
                with patch.object(connector, "update_progress"):
                    with patch.object(connector, "_get_token_metadata",
                                      return_value={"symbol": "PUMP", "decimals": 6}):
                        raws = list(connector.yield_raws())
                        normalized = list(connector.raw_to_normalized(raws[0]))

        assert all(c.get("token-accounts") == "balanceChanged" for c in calls)
        assert calls[1]["before-signature"] == pump_tx["signature"]
        assert len(normalized) == 1
        assert normalized[0].direction == "inflow"
        assert normalized[0].source_asset_symbol == "PUMP"
        assert normalized[0].quantity == Decimal("8836.09")
        assert normalized[0].network_transaction_id == pump_tx["signature"]

    def test_get_wallet_token_accounts_empty(self):
        """_get_wallet_token_accounts should return empty list when no ATAs."""
        connector = self._make_live_connector()

        with patch.object(connector, "_rpc_request", return_value={"value": []}):
            atas = connector._get_wallet_token_accounts()

        assert atas == []

    def test_get_wallet_token_accounts_rpc_returns_none(self):
        """_get_wallet_token_accounts should return empty list on None result."""
        connector = self._make_live_connector()

        with patch.object(connector, "_rpc_request", return_value=None):
            atas = connector._get_wallet_token_accounts()

        assert atas == []


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
