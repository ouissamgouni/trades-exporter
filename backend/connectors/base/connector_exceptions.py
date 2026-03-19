"""
Custom exceptions for connector error handling.

Provides structured error handling for API connectors to distinguish between
retryable errors, fatal errors, and legitimate empty results.
"""

from enum import Enum
from typing import Optional


class ErrorReason(str, Enum):
    """Enumeration of connector error reasons for structured error handling."""
    
    # Authentication & Authorization
    AUTHENTICATION_FAILED = "authentication_failed"  # 401, invalid credentials
    PERMISSION_DENIED = "permission_denied"  # 403, insufficient permissions
    API_KEY_INVALID = "api_key_invalid"  # Invalid or revoked API key
    
    # Rate Limiting
    RATE_LIMITED = "rate_limited"  # 429, too many requests
    
    # Network & Connectivity
    NETWORK_ERROR = "network_error"  # Connection errors, DNS failures
    TIMEOUT = "timeout"  # Request timeout
    
    # API Errors
    API_ERROR = "api_error"  # Server errors (5xx)
    BAD_REQUEST = "bad_request"  # Client errors (4xx)
    RESOURCE_NOT_FOUND = "resource_not_found"  # 404
    
    # Data & Configuration
    INVALID_RESPONSE = "invalid_response"  # Malformed response
    MISSING_REQUIRED_FIELD = "missing_required_field"  # Required data missing
    
    # Other
    UNKNOWN = "unknown"  # Unclassified error


class ConnectorAPIError(Exception):
    """
    Exception raised when a connector encounters an API error.
    
    This exception should be raised instead of returning empty arrays when
    an actual error occurs (vs. legitimate empty results).
    
    Attributes:
        message: Human-readable error message
        connector_name: Name of the connector that raised the error
        operation: Operation being performed (e.g., "fetch_deposits")
        reason: Structured error reason from ErrorReason enum
        http_status_code: HTTP status code if applicable
        retryable: Whether the error is retryable
        original_error: Original exception that caused this error
        details: Additional context-specific details
    """
    
    def __init__(
        self,
        message: str,
        connector_name: str,
        operation: str = None,
        reason: ErrorReason = ErrorReason.UNKNOWN,
        http_status_code: Optional[int] = None,
        retryable: bool = False,
        original_error: Optional[Exception] = None,
        details: Optional[str] = None,
    ):
        self.message = message
        self.connector_name = connector_name
        self.operation = operation
        self.reason = reason
        self.http_status_code = http_status_code
        self.retryable = retryable
        self.original_error = original_error
        self.details = details
        
        # Build comprehensive error message
        full_message = f"[{connector_name}]"
        if operation:
            full_message += f" {operation}:"
        full_message += f" {message}"
        
        if http_status_code:
            full_message += f" (HTTP {http_status_code})"
        
        if details:
            full_message += f" - {details}"
        
        super().__init__(full_message)
    
    def to_dict(self):
        """Convert to dictionary for logging/serialization."""
        return {
            "error_type": "connector_api_error",
            "connector": self.connector_name,
            "operation": self.operation,
            "reason": self.reason.value,
            "message": self.message,
            "http_status_code": self.http_status_code,
            "retryable": self.retryable,
            "details": self.details,
            "original_error": str(self.original_error) if self.original_error else None,
        }
    
    def __repr__(self):
        return (
            f"ConnectorAPIError(connector={self.connector_name}, "
            f"operation={self.operation}, reason={self.reason.value}, "
            f"retryable={self.retryable})"
        )
