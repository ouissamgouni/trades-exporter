"""
Configuration loader with environment variable support.

This module provides configuration loading from both:
- Environment variables (.env file) - for secrets and database config
- YAML files - for non-sensitive settings

Environment variables take precedence over YAML settings.

DATABASE_URL: The primary way to configure the database connection.
If DATABASE_URL is set, it is used directly. Otherwise, falls back to
constructing URL from individual POSTGRES_* environment variables.
"""

import os
import json
import yaml
import logging
import structlog
from pathlib import Path
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

CONFIG_DIR = Path(__file__).parent


def get_database_url() -> str:
    """
    Get the PostgreSQL database URL.

    Priority:
    1. DATABASE_URL environment variable (recommended)
    2. Constructed from individual POSTGRES_* vars

    Raises ValueError if no database configuration is found.
    Set DATABASE_URL or POSTGRES_* env vars (via .env file or environment).

    Returns:
        PostgreSQL connection URL
    """
    # Primary: Use DATABASE_URL if set
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    # Fallback: Construct from individual vars
    user = os.getenv("POSTGRES_USER")
    password = os.getenv("POSTGRES_PASSWORD")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db_name = os.getenv("POSTGRES_DB")

    if not all([user, password, db_name]):
        raise ValueError(
            "Database not configured. Set DATABASE_URL or "
            "POSTGRES_USER, POSTGRES_PASSWORD, and POSTGRES_DB environment variables. "
            "See .env.example for reference."
        )

    return f"postgresql://{user}:{password}@{host}:{port}/{db_name}"


def get_database_path() -> str:
    """
    Legacy function for backward compatibility.
    Returns the database URL for PostgreSQL.

    Note: This is kept for backward compatibility with existing code.
    New code should use get_database_url() directly.
    """
    return get_database_url()





def get_uvicorn_access_log_exclude_paths() -> Optional[List[str]]:
    """
    Get uvicorn access log exclude paths configuration.
    
    Returns:
        - None: Access logs fully disabled (default)
        - []: Access logs enabled for all endpoints
        - List[str]: Access logs enabled, excluding specified paths
    """
    # Check environment variable first (expects JSON list)
    env_paths = os.getenv("UVICORN_ACCESS_LOG_EXCLUDE_PATHS")
    if env_paths:
        try:
            return json.loads(env_paths)
        except (json.JSONDecodeError, TypeError):
            # Invalid JSON, fall back to settings
            pass
    
    # Fall back to settings.yaml
    settings = load_settings()
    return settings.get("uvicorn_access_log_exclude_paths")


def load_settings(path: str | None = None) -> dict:
    """Load settings.yaml from config directory or provided path."""
    p = Path(path) if path else CONFIG_DIR / "settings.yaml"
    if p.exists():
        with p.open("r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


def load_asset_map(path: str | None = None) -> dict:
    """Load asset_map.yaml from config directory or provided path."""
    p = Path(path) if path else CONFIG_DIR / "asset_map.yaml"
    if p.exists():
        with p.open("r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


def get_base_currency() -> str:
    """Get the base currency from environment or settings."""
    return os.getenv("BASE_CURRENCY") or load_settings().get("base_currency", "EUR")


def get_coingecko_api_keys() -> List[str]:
    """Get CoinGecko API keys from environment or settings."""
    env_keys = os.getenv("COINGECKO_API_KEYS")
    if env_keys:
        return [k.strip() for k in env_keys.split(",") if k.strip()]

    settings = load_settings()
    return settings.get("coingecko_api_keys", [])


def get_connectors_output_path() -> str:
    """
    Get the base output path for connector logs and raw data.
    
    Priority:
    1. CONNECTORS_OUTPUT_PATH environment variable
    2. Default: backend/data/output/connectors
    
    Returns:
        Absolute path to connectors output directory
    """
    env_path = os.getenv("CONNECTORS_OUTPUT_PATH")
    if env_path:
        return os.path.abspath(env_path)
    
    # Default to backend/data/output/connectors
    # Get backend directory (parent of config directory)
    backend_dir = Path(__file__).parent.parent
    return str(backend_dir / "data" / "output" / "connectors")


def load_credentials(exchange_name: str) -> dict:
    """
    Load API credentials for an exchange from environment variables.

    Environment variables take precedence. Falls back to settings.yaml.

    Args:
        exchange_name: Name of the exchange (e.g., 'binance', 'mexc', 'okx', 'coinbase')

    Returns:
        dict: Contains 'api_key', 'api_secret', and optionally 'api_passphrase'

    Raises:
        KeyError: If exchange not found and no env vars set
        ValueError: If credentials are missing required fields
    """
    exchange_upper = exchange_name.upper()

    # Try environment variables first
    api_key = os.getenv(f"{exchange_upper}_API_KEY")
    api_secret = os.getenv(f"{exchange_upper}_API_SECRET")
    api_passphrase = os.getenv(f"{exchange_upper}_API_PASSPHRASE")

    # If env vars found, use them
    if api_key and api_secret:
        # Handle escaped newlines in secret (for PEM keys like Coinbase)
        if api_secret and "\\n" in api_secret:
            api_secret = api_secret.replace("\\n", "\n")

        return {
            "api_key": api_key,
            "api_secret": api_secret,
            "api_passphrase": api_passphrase,
        }

    # Fall back to settings.yaml
    settings = load_settings()
    exchanges = settings.get("exchanges", {})

    if exchange_name not in exchanges:
        raise KeyError(
            f"Exchange '{exchange_name}' not found in environment variables or settings.yaml. "
            f"Set {exchange_upper}_API_KEY and {exchange_upper}_API_SECRET environment variables."
        )

    creds = exchanges[exchange_name]

    # Validate required fields
    if not creds.get("api_key"):
        raise ValueError(f"Missing api_key for {exchange_name}")
    if not creds.get("api_secret"):
        raise ValueError(f"Missing api_secret for {exchange_name}")

    return {
        "api_key": creds["api_key"],
        "api_secret": creds["api_secret"],
        "api_passphrase": creds.get("api_passphrase"),
    }


def get_etherscan_api_key() -> Optional[str]:
    """Get Etherscan API key from environment or settings."""
    env_key = os.getenv("ETHERSCAN_API_KEY")
    if env_key:
        return env_key

    settings = load_settings()
    web3_config = settings.get("web3_wallets", {})
    return web3_config.get("etherscan_api_key")


def get_bscscan_api_key() -> Optional[str]:
    """Get BscScan API key from environment or settings."""
    env_key = os.getenv("BSCSCAN_API_KEY")
    if env_key:
        return env_key

    settings = load_settings()
    web3_config = settings.get("web3_wallets", {})
    return web3_config.get("bscscan_api_key")


def get_web3_wallets() -> List[Dict[str, Any]]:
    """
    Get Web3 wallet configurations from environment or settings.

    Returns:
        List of wallet configuration dictionaries
    """
    # Try environment variable (JSON format)
    env_wallets = os.getenv("WEB3_WALLETS")
    if env_wallets:
        try:
            return json.loads(env_wallets)
        except json.JSONDecodeError:
            pass

    # Fall back to settings.yaml
    settings = load_settings()
    web3_config = settings.get("web3_wallets", {})
    return web3_config.get("addresses", [])


def get_web3_config() -> Dict[str, Any]:
    """
    Get full Web3 configuration.

    Returns:
        Dictionary with etherscan_api_key, request_delay, max_retries, addresses
    """
    settings = load_settings()
    web3_config = settings.get("web3_wallets", {})

    return {
        "etherscan_api_key": get_etherscan_api_key(),
        "request_delay": float(
            os.getenv("WEB3_REQUEST_DELAY", web3_config.get("request_delay", 1.25))
        ),
        "max_retries": int(
            os.getenv("WEB3_MAX_RETRIES", web3_config.get("max_retries", 7))
        ),
        "addresses": get_web3_wallets(),
    }


def configure_logging(logger_name: str = "backend") -> structlog.stdlib.BoundLogger:
    """
    Configure and return a structured logger.
    
    Simplified design:
    - Single call to configure structlog (done once per process)
    - Returns a logger bound with the module name
    - Uses rich console for dev, JSON for production
    - Outputs to sys.stderr for compatibility with uvicorn
    - Respects LOG_LEVEL environment variable
    
    Args:
        logger_name: Name to identify the logger in output (e.g., "pnl_engine")

    Returns:
        structlog.stdlib.BoundLogger: Logger with module name bound
        
    Usage:
        log = configure_logging("pnl_engine")
        log.info("order_created", order_id=123, total=99.99)
        log.exception("calculation_failed", unit_id=456)
        
        # Bind additional context for a block of operations
        log_ctx = log.bind(request_id="abc-123")
        log_ctx.info("processing_started")
    """
    import sys
    
    # Get log level from environment or settings (only once)
    settings = load_settings()
    log_level = (
        os.getenv("LOG_LEVEL") or settings.get("log_level", "INFO")
    ).upper()
    log_format = os.getenv("LOG_FORMAT") or settings.get("log_format", "rich")
    numeric_level = getattr(logging, log_level, logging.INFO)

    # Set stdlib logging level FIRST (structlog will use this for filtering)
    logging.basicConfig(
        format="%(message)s",
        level=numeric_level,
        force=True,  # Force reconfiguration if already configured
    )

    # Configure structlog only once
    if not structlog.is_configured():
        # Shared processors for both formats
        shared_processors = [
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.filter_by_level,  # Filter based on stdlib log level
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso" if log_format == "json" else "%H:%M:%S"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
        ]
        
        # Final renderer based on format
        if log_format == "json":
            final_processor = structlog.processors.JSONRenderer()
        else:
            final_processor = structlog.dev.ConsoleRenderer(
                colors=True,
                exception_formatter=structlog.dev.rich_traceback,
            )
        
        structlog.configure(
            processors=shared_processors + [final_processor],
            wrapper_class=structlog.stdlib.BoundLogger,
            context_class=dict,
            logger_factory=structlog.stdlib.LoggerFactory(),  # Use stdlib for level filtering
            cache_logger_on_first_use=True,
        )

    # Return logger bound with module name
    return structlog.get_logger(logger_name).bind(logger=logger_name)
