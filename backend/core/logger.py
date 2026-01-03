import logging
import os
from datetime import datetime

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
