"""
Configuration loader with environment variable support.

This module provides configuration loading from both:
- Environment variables - for secrets and database config
- YAML files - for non-sensitive settings

Environment variables take precedence over YAML settings.

DATABASE_URL: The primary way to configure the database connection.
If DATABASE_URL is set, it is used directly. Otherwise, falls back to
constructing URL from individual POSTGRES_* environment variables.

Note: Environment variables should be loaded by the orchestration layer
(Taskfile, Docker, K8s). The optional load_dotenv() call below is a 
fallback for running Python scripts directly outside of task orchestration.
"""

import os
import json
import yaml
import logging
import structlog
from pathlib import Path
from typing import Optional, List, Dict, Any

# Note: Environment variables are loaded by the orchestration layer (Taskfile, Docker, K8s)
# This module only reads from os.getenv() - no dotenv loading needed
CONFIG_DIR = Path(__file__).parent

# Default database URL for local development
DEFAULT_DATABASE_URL = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"

# Test mode flag (used by e2e tests)
_test_mode = os.getenv("TEST_MODE", "").lower() in ("1", "true", "yes")


def set_test_mode(enabled: bool = True) -> None:
    """
    Set test mode flag for the application.
    
    When enabled, uses test database configuration instead of production.
    Primarily used by e2e tests to ensure isolated test environment.
    """
    global _test_mode
    _test_mode = enabled
    if enabled:
        os.environ["TEST_MODE"] = "true"
    else:
        os.environ.pop("TEST_MODE", None)


def is_test_mode() -> bool:
    """Check if the application is running in test mode."""
    return _test_mode or os.getenv("TEST_MODE", "").lower() in ("1", "true", "yes")


def get_database_url() -> str:
    """
    Get the PostgreSQL database URL.

    Priority:
    1. DATABASE_URL environment variable (recommended)
    2. Constructed from individual POSTGRES_* vars (legacy support)

    Returns:
        PostgreSQL connection URL
    """
    # Primary: Use DATABASE_URL if set
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    # Fallback: Construct from individual vars (legacy support)
    user = os.getenv("POSTGRES_USER", "trades_user")
    password = os.getenv("POSTGRES_PASSWORD", "trades_password")
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    db_name = os.getenv("POSTGRES_DB", "trades_db_dev")

    return f"postgresql://{user}:{password}@{host}:{port}/{db_name}"


def get_database_path() -> str:
    """
    Legacy function for backward compatibility.
    Returns the database URL for PostgreSQL.

    Note: This is kept for backward compatibility with existing code.
    New code should use get_database_url() directly.
    """
    return get_database_url()


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


def get_price_getter_override() -> Optional[str]:
    """
    Get global price getter override for testing.
    
    When set, forces ALL assets to use the specified price getter,
    bypassing asset-specific configurations and defaults.
    
    Environment variable takes precedence over settings.yaml.
    
    Usage:
        # Enable mock prices for quick manual testing
        PRICE_GETTER_OVERRIDE=mock python -m backend.api.run
    
    Returns:
        Price getter name to use globally, or None if not set.
    """
    override = os.getenv("PRICE_GETTER_OVERRIDE")
    if override:
        return override.lower()
    
    settings = load_settings()
    override_setting = settings.get("price_getter_override")
    if override_setting:
        return override_setting.lower()
    
    return None


def get_mock_prices_seed() -> Optional[int]:
    """
    Get seed for mock price generator for reproducible tests.
    
    When set, MockPriceGetter will use this seed for random.seed(),
    making generated prices deterministic across runs.
    
    Environment variable takes precedence over settings.yaml.
    
    Usage:
        # Reproducible mock prices
        PRICE_GETTER_OVERRIDE=mock MOCK_PRICES_SEED=42 python -m backend.api.run
    
    Returns:
        Integer seed value, or None if not set.
    """
    env_seed = os.getenv("MOCK_PRICES_SEED")
    if env_seed:
        try:
            return int(env_seed)
        except ValueError:
            return None
    
    settings = load_settings()
    seed_setting = settings.get("mock_prices_seed")
    if seed_setting is not None:
        try:
            return int(seed_setting)
        except (ValueError, TypeError):
            return None
    
    return None


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

    # Configure structlog only once
    if not structlog.is_configured():
        # Shared processors for both formats
        shared_processors = [
            structlog.contextvars.merge_contextvars,
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
            # Use WriteLoggerFactory with sys.stderr for uvicorn compatibility
            logger_factory=structlog.WriteLoggerFactory(file=sys.stderr),
            cache_logger_on_first_use=True,
        )

    # Set stdlib logging level for compatibility
    logging.basicConfig(
        format="%(message)s",
        level=getattr(logging, log_level, logging.INFO),
        force=True,  # Force reconfiguration if already configured
    )

    # Return logger bound with module name
    return structlog.get_logger().bind(logger=logger_name)
