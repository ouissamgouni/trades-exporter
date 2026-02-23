"""
Bitcoin connector using Blockstream Esplora API.
Fetches confirmed transactions for a Bitcoin wallet address and normalizes UTXO transfers.

Supports:
- Single address mode: Track a single Bitcoin address
- xpub mode: Derive addresses from extended public key (BIP44/BIP84) and track all

Aggregates transaction inputs/outputs by direction:
- Inflows: Sum of all outputs to our address(es)
- Outflows: Net of (inputs from our address(es) - change outputs to our address(es))

Change addresses are handled automatically when using xpub mode.
"""

import hashlib
import json
import os
import re
import time
import requests
import base58
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, Optional, List, Set

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("bitcoin_esplora")


# ============================================================================
# HD Wallet / xpub Derivation Utilities
# ============================================================================

def _hash160(data: bytes) -> bytes:
    """RIPEMD160(SHA256(data)) - standard Bitcoin hash160."""
    sha256_hash = hashlib.sha256(data).digest()
    ripemd160 = hashlib.new('ripemd160')
    ripemd160.update(sha256_hash)
    return ripemd160.digest()


def _decode_xpub(xpub: str) -> tuple:
    """
    Decode an xpub/ypub/zpub to extract chain code and public key.
    
    Returns:
        Tuple of (version_bytes, depth, fingerprint, child_index, chain_code, public_key)
    """
    try:
        decoded = base58.b58decode_check(xpub)
        if len(decoded) != 78:
            raise ValueError(f"Invalid xpub length: {len(decoded)}")
        
        version = decoded[0:4]
        depth = decoded[4]
        fingerprint = decoded[5:9]
        child_index = int.from_bytes(decoded[9:13], 'big')
        chain_code = decoded[13:45]
        public_key = decoded[45:78]
        
        return version, depth, fingerprint, child_index, chain_code, public_key
    except Exception as e:
        raise ValueError(f"Failed to decode xpub: {e}")


def _point_add(p1: tuple, p2: tuple, p: int) -> tuple:
    """Add two points on secp256k1 curve."""
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    
    x1, y1 = p1
    x2, y2 = p2
    
    if x1 == x2 and y1 != y2:
        return None
    
    if x1 == x2:
        # Point doubling
        lam = (3 * x1 * x1 * pow(2 * y1, -1, p)) % p
    else:
        lam = ((y2 - y1) * pow(x2 - x1, -1, p)) % p
    
    x3 = (lam * lam - x1 - x2) % p
    y3 = (lam * (x1 - x3) - y1) % p
    
    return (x3, y3)


def _point_multiply(k: int, point: tuple, p: int, n: int) -> tuple:
    """Multiply a point by a scalar on secp256k1."""
    k = k % n
    result = None
    addend = point
    
    while k:
        if k & 1:
            result = _point_add(result, addend, p)
        addend = _point_add(addend, addend, p)
        k >>= 1
    
    return result


def _decompress_pubkey(compressed: bytes) -> tuple:
    """Decompress a 33-byte compressed public key to (x, y) point."""
    p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
    
    if len(compressed) != 33:
        raise ValueError(f"Invalid compressed pubkey length: {len(compressed)}")
    
    prefix = compressed[0]
    x = int.from_bytes(compressed[1:33], 'big')
    
    # y^2 = x^3 + 7 (mod p)
    y_squared = (pow(x, 3, p) + 7) % p
    y = pow(y_squared, (p + 1) // 4, p)
    
    # Check parity
    if (prefix == 0x02 and y % 2 != 0) or (prefix == 0x03 and y % 2 == 0):
        y = p - y
    
    return (x, y)


def _compress_point(point: tuple) -> bytes:
    """Compress an (x, y) point to 33-byte compressed public key."""
    x, y = point
    prefix = 0x02 if y % 2 == 0 else 0x03
    return bytes([prefix]) + x.to_bytes(32, 'big')


def _derive_child_pubkey(parent_pubkey: bytes, parent_chain_code: bytes, index: int) -> tuple:
    """
    Derive a child public key from parent (non-hardened derivation only).
    
    Returns:
        Tuple of (child_pubkey, child_chain_code)
    """
    import hmac
    
    if index >= 0x80000000:
        raise ValueError("Hardened derivation not supported for public keys")
    
    # secp256k1 parameters
    p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
    n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
    Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
    G = (Gx, Gy)
    
    # HMAC-SHA512(chain_code, pubkey || index)
    data = parent_pubkey + index.to_bytes(4, 'big')
    I = hmac.new(parent_chain_code, data, 'sha512').digest()
    IL = int.from_bytes(I[:32], 'big')
    IR = I[32:]
    
    if IL >= n:
        raise ValueError("Invalid child key")
    
    # child_pubkey = point(IL) + parent_pubkey
    parent_point = _decompress_pubkey(parent_pubkey)
    IL_point = _point_multiply(IL, G, p, n)
    child_point = _point_add(IL_point, parent_point, p)
    
    if child_point is None:
        raise ValueError("Invalid child key (point at infinity)")
    
    child_pubkey = _compress_point(child_point)
    child_chain_code = IR
    
    return child_pubkey, child_chain_code


def _pubkey_to_p2pkh_address(pubkey: bytes) -> str:
    """Convert public key to P2PKH (Legacy) address starting with '1'."""
    h160 = _hash160(pubkey)
    versioned = b'\x00' + h160
    return base58.b58encode_check(versioned).decode()


def _pubkey_to_p2wpkh_address(pubkey: bytes) -> str:
    """Convert public key to P2WPKH (Native SegWit) address starting with 'bc1q'."""
    h160 = _hash160(pubkey)
    
    # Bech32 encoding
    CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    
    def bech32_polymod(values):
        GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
        chk = 1
        for v in values:
            b = chk >> 25
            chk = ((chk & 0x1ffffff) << 5) ^ v
            for i in range(5):
                chk ^= GEN[i] if ((b >> i) & 1) else 0
        return chk
    
    def bech32_hrp_expand(hrp):
        return [ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp]
    
    def bech32_create_checksum(hrp, data):
        values = bech32_hrp_expand(hrp) + data
        polymod = bech32_polymod(values + [0, 0, 0, 0, 0, 0]) ^ 1
        return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    
    def convertbits(data, frombits, tobits, pad=True):
        acc = 0
        bits = 0
        ret = []
        maxv = (1 << tobits) - 1
        for value in data:
            acc = (acc << frombits) | value
            bits += frombits
            while bits >= tobits:
                bits -= tobits
                ret.append((acc >> bits) & maxv)
        if pad:
            if bits:
                ret.append((acc << (tobits - bits)) & maxv)
        return ret
    
    hrp = "bc"
    witness_version = 0
    data = [witness_version] + convertbits(h160, 8, 5)
    checksum = bech32_create_checksum(hrp, data)
    
    return hrp + "1" + "".join([CHARSET[d] for d in data + checksum])


def derive_addresses_from_xpub(xpub: str, address_type: str = "auto", gap_limit: int = 20) -> List[str]:
    """
    Derive addresses from an extended public key.
    
    Args:
        xpub: Extended public key (xpub, ypub, or zpub)
        address_type: "legacy" (P2PKH), "segwit" (P2WPKH), or "auto" (detect from prefix)
        gap_limit: Number of consecutive unused addresses before stopping
    
    Returns:
        List of derived addresses (receive + change chains)
    """
    version, depth, fingerprint, child_index, chain_code, public_key = _decode_xpub(xpub)
    
    # Detect address type from version bytes
    version_hex = version.hex()
    if address_type == "auto":
        if version_hex == "0488b21e":  # xpub - Legacy (BIP44)
            address_type = "legacy"
        elif version_hex == "049d7cb2":  # ypub - SegWit P2SH (BIP49) - treated as segwit
            address_type = "segwit"
        elif version_hex == "04b24746":  # zpub - Native SegWit (BIP84)
            address_type = "segwit"
        else:
            log.warning(f"Unknown xpub version {version_hex}, defaulting to legacy")
            address_type = "legacy"
    
    log.info(f"🔑 Deriving {address_type} addresses from xpub (version: {version_hex})")
    
    addresses = []
    
    # Derive for both chains: 0 = receive, 1 = change
    for chain in [0, 1]:
        chain_name = "receive" if chain == 0 else "change"
        
        # Derive chain-level key (m/purpose'/coin'/account'/chain)
        chain_pubkey, chain_code_derived = _derive_child_pubkey(public_key, chain_code, chain)
        
        # Derive addresses up to gap_limit
        for i in range(gap_limit):
            child_pubkey, _ = _derive_child_pubkey(chain_pubkey, chain_code_derived, i)
            
            if address_type == "legacy":
                addr = _pubkey_to_p2pkh_address(child_pubkey)
            else:
                addr = _pubkey_to_p2wpkh_address(child_pubkey)
            
            addresses.append(addr)
            log.debug(f"  {chain_name}/{i}: {addr}")
    
    log.info(f"✅ Derived {len(addresses)} addresses ({gap_limit} receive + {gap_limit} change)")
    return addresses


class ConnectorBitcoinEsplora(BaseConnector):
    """Blockstream Esplora API connector for Bitcoin blockchain transactions."""

    SATOSHIS_PER_BTC = 100_000_000

    @property
    def connector_name(self) -> str:
        return "bitcoin_esplora"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize Bitcoin Blockstream Esplora connector.

        Args:
            wallet_address: Bitcoin address OR xpub/ypub/zpub for HD wallet
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = "bitcoin"
        self.wallet_address = wallet_address
        
        # xpub mode detection and address tracking
        self.xpub_mode = False
        self.derived_addresses_list: List[str] = []  # Ordered list for iteration
        self.derived_addresses_set: Set[str] = set()  # Set for fast lookup
        self.primary_address = ""  # First receive address (for display)

        # Initialize base (sets self.test_mode and logs)
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address or xpub")

        # Check if this is an xpub/ypub/zpub
        if self._is_xpub(self.wallet_address):
            self.xpub_mode = True
            log.info(f"🔑 xpub mode detected, deriving addresses...")
            gap_limit = self.config.get("gap_limit", 20) if self.config else 20
            self.derived_addresses_list = derive_addresses_from_xpub(
                self.wallet_address, 
                address_type="auto",
                gap_limit=gap_limit
            )
            self.derived_addresses_set = set(self.derived_addresses_list)
            if self.derived_addresses_list:
                self.primary_address = self.derived_addresses_list[0]  # First receive address
                log.info(f"📍 Primary address: {self.primary_address}")
        else:
            # Single address mode
            if not self._validate_bitcoin_address(self.wallet_address):
                raise ValueError(f"Invalid Bitcoin address format: {self.wallet_address}")
            self.derived_addresses_list = [self.wallet_address]
            self.derived_addresses_set = {self.wallet_address}
            self.primary_address = self.wallet_address

        # Get chain configuration from registry
        registry = get_connector_registry()
        self.native_token = registry.get_native_token("bitcoin_esplora", "bitcoin")
        self.native_token_decimals = registry.get_native_token_decimals("bitcoin_esplora", "bitcoin")
        if not self.native_token or self.native_token_decimals is None:
            raise ValueError("Chain configuration not found for bitcoin")

        self.request_delay = 0.5  # Blockstream rate limits (free API)
        self.max_retries = 5

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration
        self.base_url = "https://blockstream.info/api"

    def _is_xpub(self, value: str) -> bool:
        """Check if value is an extended public key (xpub/ypub/zpub)."""
        return value.startswith(('xpub', 'ypub', 'zpub', 'tpub', 'upub', 'vpub'))

    def _get_default_test_file(self) -> str:
        """Get the default test fixture file path."""
        connector_dir = os.path.dirname(__file__)
        return os.path.join(
            connector_dir, "..", "..", "tests", "fixtures", "bitcoin", "blockstream_transactions.json"
        )

    def _validate_bitcoin_address(self, address: str) -> bool:
        """
        Validate Bitcoin address format.

        Supports:
        - P2PKH (Legacy): starts with 1, 26-35 characters, base58
        - P2SH (Script Hash): starts with 3, 26-35 characters, base58
        - Bech32 (SegWit): starts with bc1, lowercase, 42-62 characters

        Args:
            address: Bitcoin address to validate

        Returns:
            True if address matches known Bitcoin formats, False otherwise
        """
        # P2PKH: starts with 1, 26-35 characters, base58
        if re.match(r'^1[1-9A-HJ-NP-Za-km-z]{25,34}$', address):
            return True

        # P2SH: starts with 3, 26-35 characters, base58
        if re.match(r'^3[1-9A-HJ-NP-Za-km-z]{25,34}$', address):
            return True

        # Bech32 (SegWit): starts with bc1, lowercase, 42-62 characters
        # Normalize to lowercase for comparison
        if re.match(r'^bc1[a-z0-9]{39,59}$', address.lower()):
            return True

        return False

    def _is_own_address(self, address: Optional[str]) -> bool:
        """
        Check if an address belongs to our wallet.

        In xpub mode, checks against all derived addresses.
        In single address mode, checks against the wallet address.

        Args:
            address: Bitcoin address to check

        Returns:
            True if address matches any of our wallet addresses
        """
        if not address:
            return False

        # Normalize for comparison (Bech32 is case-insensitive)
        addr_lower = address.lower() if address.lower().startswith('bc1') else address
        
        for own_addr in self.derived_addresses_set:
            own_lower = own_addr.lower() if own_addr.lower().startswith('bc1') else own_addr
            if addr_lower == own_lower:
                return True
        
        return False

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for Blockstream API.

        Args:
            endpoint: API endpoint path (e.g., "/address/{address}/txs/chain")
            params: Optional query parameters

        Returns:
            JSON response data

        Raises:
            RuntimeError: If all retries fail
        """
        delay = self.request_delay
        url = f"{self.base_url}{endpoint}"
        if params is None:
            params = {}

        headers = {
            "Accept": "application/json",
        }

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, headers=headers, timeout=30)

                # Check HTTP status
                if response.status_code == 429:
                    log.warning(f"⚠️ Rate limited (attempt {attempt}): HTTP 429")
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    error_text = response.text[:200]
                    log.error(f"HTTP {response.status_code}: {error_text}")
                    raise RuntimeError(
                        f"HTTP {response.status_code}: {error_text}"
                    )

                data = response.json()
                return data

            except requests.exceptions.RequestException as e:
                log.warning(f"⚠️ Network error (attempt {attempt}): {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(f"Network error after {self.max_retries} retries: {e}")
            except Exception as e:
                log.error(f"⚠️ API error: {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(f"API error after {self.max_retries} retries: {e}")

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API request failed"
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield raw transaction data from Blockstream Esplora API.

        In test mode, loads from fixture file.
        In live mode, paginates through confirmed transactions (excludes mempool).
        In xpub mode, fetches transactions for all derived addresses.

        Yields:
            Raw transaction dict from Blockstream API
        """
        # Test mode: Load from fixture file
        if self.test_mode:
            test_file = self.config.get("test_file_path") or self._get_default_test_file()
            log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")

            if not os.path.exists(test_file):
                log.warning(f"Test file not found: {test_file}")
                return

            with open(test_file, "r") as f:
                data = json.load(f)

            items = data.get("transactions", [])
            for item in items:
                yield item

            log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transactions")
            return

        # Live mode: Fetch from Blockstream API
        if self.xpub_mode:
            log.info(f"🔍 Fetching Bitcoin transactions for xpub ({len(self.derived_addresses_list)} addresses)")
        else:
            log.info(f"🔍 Fetching Bitcoin transactions for address: {self.wallet_address}")

        # Track seen txids to avoid duplicates across addresses
        seen_txids: Set[str] = set()
        total_txs = 0

        # Iterate through all addresses (1 in single mode, many in xpub mode)
        for addr_idx, address in enumerate(self.derived_addresses_list):
            if self.xpub_mode:
                log.info(f"📍 Scanning address {addr_idx + 1}/{len(self.derived_addresses_list)}: {address[:12]}...")
            
            # Start with initial request (no txid parameter)
            last_seen_txid = None
            page = 1
            addr_txs = 0

            while True:
                # Build endpoint with pagination
                if last_seen_txid:
                    endpoint = f"/address/{address}/txs/chain/{last_seen_txid}"
                else:
                    endpoint = f"/address/{address}/txs/chain"

                log.debug(f"📄 Address {address[:12]}... page {page}")

                # Fetch page of transactions
                txs = self.safe_request(endpoint)

                # Check if we got an empty response
                if not txs or len(txs) == 0:
                    break

                # Yield only confirmed transactions that we haven't seen
                for tx in txs:
                    txid = tx.get("txid")
                    status = tx.get("status", {})
                    
                    if status.get("confirmed") and txid not in seen_txids:
                        seen_txids.add(txid)
                        addr_txs += 1
                        total_txs += 1
                        yield tx

                # Update pagination cursor
                if txs:
                    last_seen_txid = txs[-1].get("txid")

                page += 1

                # Report progress
                if self._progress_callback:
                    self._progress_callback(
                        connector_id=self.connector_id,
                        operation=f"Scanning addresses ({addr_idx + 1}/{len(self.derived_addresses_list)})",
                        current=total_txs,
                        total=0,  # Unknown total for blockchain pagination
                        fetched_count=total_txs,
                    )

            if addr_txs > 0:
                log.info(f"  ✓ {address[:12]}...: {addr_txs} transactions")

        log.info(f"✅ Total confirmed transactions fetched: {total_txs}")

    def raw_to_normalized(self, tx: Dict) -> Generator[NormalizedTransaction, None, None]:
        """
        Convert raw Blockstream transaction to normalized format(s).

        Aggregates UTXO inputs/outputs by direction:
        - Creates inflow record if we received BTC (outputs to our address)
        - Creates outflow record if we spent BTC (net of inputs minus change)

        Args:
            tx: Raw transaction dict from Blockstream API

        Yields:
            NormalizedTransaction record(s) (0-2 per Bitcoin transaction)
        """
        try:
            tx_hash = tx.get("txid")
            if not tx_hash:
                log.warning("⚠️ Transaction missing txid, skipping")
                return

            # Parse timestamp
            status = tx.get("status", {})
            block_time = status.get("block_time")
            if block_time:
                dt = datetime.fromtimestamp(block_time, tz=timezone.utc)
            else:
                log.warning(f"⚠️ Transaction {tx_hash} missing block_time")
                dt = None

            # Parse fee (in satoshis)
            fee_sats = tx.get("fee", 0)
            fee_btc = Decimal(fee_sats) / Decimal(self.SATOSHIS_PER_BTC)

            # Calculate inflows (outputs to our address)
            total_inflow_sats = 0
            for vout in tx.get("vout", []):
                address = vout.get("scriptpubkey_address")
                if address and self._is_own_address(address):
                    total_inflow_sats += vout.get("value", 0)

            # Calculate outflows (inputs from our address)
            total_outflow_sats = 0
            for vin in tx.get("vin", []):
                prevout = vin.get("prevout", {})
                address = prevout.get("scriptpubkey_address")
                if address and self._is_own_address(address):
                    total_outflow_sats += prevout.get("value", 0)

            # Get metadata for tags
            block_height = status.get("block_height")

            # Create inflow transaction if we received BTC
            if total_inflow_sats > 0:
                # Find external sender (first non-own input address)
                from_address = None
                for vin in tx.get("vin", []):
                    prevout = vin.get("prevout", {})
                    addr = prevout.get("scriptpubkey_address")
                    if addr and not self._is_own_address(addr):
                        from_address = addr
                        break
                
                # Find our receiving address (for display)
                to_address = self.primary_address
                for vout in tx.get("vout", []):
                    addr = vout.get("scriptpubkey_address")
                    if addr and self._is_own_address(addr):
                        to_address = addr
                        break

                inflow_btc = Decimal(total_inflow_sats) / Decimal(self.SATOSHIS_PER_BTC)

                yield NormalizedTransaction(
                    source="bitcoin_esplora",
                    source_transaction_id=f"{tx_hash}_in",
                    source_transaction_type="bitcoin-transfer",
                    source_asset_symbol="BTC",
                    date_time=dt,
                    direction="inflow",
                    transaction_type="transfer",
                    quantity=float(inflow_btc),
                    fee=0.0,  # Inflows don't include fee (sender pays)
                    source_fee_quote_asset_symbol="BTC",
                    include_fee=False,
                    source_from_account=from_address or "",
                    source_to_account=to_address,
                    network="bitcoin",
                    network_transaction_id=tx_hash,
                    token_contract_address="",
                    tags=[{
                        "block_height": block_height,
                        "total_inflow_sats": total_inflow_sats,
                        "total_outflow_sats": total_outflow_sats,
                        "xpub_mode": self.xpub_mode,
                    }],
                )

            # Create outflow transaction if we spent BTC
            if total_outflow_sats > 0:
                # Find external recipient (first non-own output address)
                to_address = None
                for vout in tx.get("vout", []):
                    addr = vout.get("scriptpubkey_address")
                    if addr and not self._is_own_address(addr):
                        to_address = addr
                        break
                
                # Find our sending address (for display)
                from_address = self.primary_address
                for vin in tx.get("vin", []):
                    prevout = vin.get("prevout", {})
                    addr = prevout.get("scriptpubkey_address")
                    if addr and self._is_own_address(addr):
                        from_address = addr
                        break

                # Net outflow = spent - received (excludes change back to us)
                net_outflow_sats = total_outflow_sats - total_inflow_sats
                net_outflow_btc = Decimal(net_outflow_sats) / Decimal(self.SATOSHIS_PER_BTC)

                # Only create outflow if net outflow is positive
                if net_outflow_sats > 0:
                    yield NormalizedTransaction(
                        source="bitcoin_esplora",
                        source_transaction_id=f"{tx_hash}_out",
                        source_transaction_type="bitcoin-transfer",
                        source_asset_symbol="BTC",
                        date_time=dt,
                        direction="outflow",
                        transaction_type="transfer",
                        quantity=float(net_outflow_btc),
                        fee=float(fee_btc),
                        source_fee_quote_asset_symbol="BTC",
                        include_fee=True,  # Outflows include fee
                        source_from_account=from_address,
                        source_to_account=to_address or "",
                        network="bitcoin",
                        network_transaction_id=tx_hash,
                        token_contract_address="",
                        tags=[{
                            "block_height": block_height,
                            "fee_sats": fee_sats,
                            "total_inflow_sats": total_inflow_sats,
                            "total_outflow_sats": total_outflow_sats,
                            "net_outflow_sats": net_outflow_sats,
                            "xpub_mode": self.xpub_mode,
                        }],
                    )

        except Exception as e:
            log.error(f"❌ Error normalizing transaction {tx.get('txid', 'unknown')}: {e}")
            raise

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self):
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        total_sats = 0
        try:
            if self.xpub_mode and self.derived_addresses_set:
                # Sum balance across all derived addresses
                for addr in self.derived_addresses_set:
                    data = self.safe_request(f"/address/{addr}")
                    if data:
                        funded = data.get("chain_stats", {}).get("funded_txo_sum", 0)
                        spent = data.get("chain_stats", {}).get("spent_txo_sum", 0)
                        total_sats += funded - spent
            else:
                data = self.safe_request(f"/address/{self.wallet_address}")
                if data:
                    funded = data.get("chain_stats", {}).get("funded_txo_sum", 0)
                    spent = data.get("chain_stats", {}).get("spent_txo_sum", 0)
                    total_sats = funded - spent

            if total_sats > 0:
                total = Decimal(total_sats) / Decimal(10 ** 8)
                return [BalanceEntry(
                    asset_symbol="BTC",
                    total=total,
                    available=total,
                    chain="bitcoin",
                    raw={"total_sats": total_sats},
                )]
        except Exception as e:
            log.warning(f"Failed to fetch Bitcoin balance: {e}")
        return []
