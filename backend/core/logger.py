import logging
import os
from datetime import datetime
from typing import List

def setup_logger(export_dir: str, level: str = "INFO"):
    os.makedirs(export_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_path = os.path.join(export_dir, f"trade_export_{ts}.log")

    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
        handlers=[
            logging.FileHandler(log_path, mode="w", encoding="utf-8"),
            logging.StreamHandler()
        ]
    )
    log = logging.getLogger("backend")
    log.info(f"Logger initialized at {log_path}")
    return log


class EndpointFilter(logging.Filter):
    """
    Filter for uvicorn access logs to exclude specific endpoints.
    
    Used to reduce log noise from frequently polled health check and status endpoints.
    """
    
    def __init__(self, exclude_paths: List[str]):
        """
        Initialize the filter with paths to exclude.
        
        Args:
            exclude_paths: List of exact paths to exclude from access logs
                          (e.g., ["/sync-job/status", "/config/setup-status"])
        """
        super().__init__()
        self.exclude_paths = set(exclude_paths)
    
    def filter(self, record: logging.LogRecord) -> bool:
        """
        Filter log records based on the request path.
        
        Returns:
            False if the path should be excluded, True otherwise
        """
        # Access log messages typically contain the path in the message
        # Format: '127.0.0.1:12345 - "GET /path HTTP/1.1" 200 OK'
        message = record.getMessage()
        
        # Check if any excluded path appears in the log message
        for path in self.exclude_paths:
            if f' "{path} ' in message or f' "{path}"' in message:
                return False
        
        return True
