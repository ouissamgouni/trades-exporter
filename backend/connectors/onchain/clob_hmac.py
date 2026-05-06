"""
CLOB API HMAC authentication for Polymarket.

Builds L2 authentication headers for the CLOB REST API.
HMAC-SHA256 signing using stored API credentials (derived once via setup script).
"""

import base64
import hashlib
import hmac
import time


def build_hmac_signature(secret: str, timestamp: str, method: str, path: str, body: str = "") -> str:
    """
    Build HMAC-SHA256 signature for CLOB API request.

    Args:
        secret: Base64-encoded API secret (from credential derivation)
        timestamp: Unix timestamp string
        method: HTTP method (GET, POST, etc.)
        path: Request path (e.g. /data/trades)
        body: Request body string (empty for GET)

    Returns:
        Base64-encoded HMAC-SHA256 signature
    """
    key = base64.urlsafe_b64decode(secret)
    message = (timestamp + method + path + body).encode("utf-8")
    digest = hmac.new(key, message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8")


def build_clob_headers(
    api_key: str,
    api_secret: str,
    passphrase: str,
    address: str,
    method: str = "GET",
    path: str = "/",
    body: str = "",
) -> dict:
    """
    Build complete L2 authentication headers for a CLOB API request.

    Args:
        api_key: CLOB API key
        api_secret: CLOB API secret (base64-encoded)
        passphrase: CLOB API passphrase
        address: Polymarket wallet address
        method: HTTP method
        path: Request path
        body: Request body (empty for GET)

    Returns:
        Dict of authentication headers
    """
    timestamp = str(int(time.time()))
    signature = build_hmac_signature(api_secret, timestamp, method, path, body)

    return {
        "POLY_ADDRESS": address,
        "POLY_SIGNATURE": signature,
        "POLY_TIMESTAMP": timestamp,
        "POLY_API_KEY": api_key,
        "POLY_PASSPHRASE": passphrase,
    }
