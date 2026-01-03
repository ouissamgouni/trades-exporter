import os
from datetime import datetime
import logging

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)
    return path

def list_new_files(base_dir: str):
    """List all files under <exchange>/new/"""
    for root, _, files in os.walk(base_dir):
        for f in files:
            if f.lower().endswith((".xlsx", ".xls", ".csv")):
                yield os.path.join(root, f)

def move_to_processed(file_path: str):
    processed_dir = os.path.join(os.path.dirname(os.path.dirname(file_path)), "processed")
    ensure_dir(processed_dir)
    os.rename(file_path, os.path.join(processed_dir, os.path.basename(file_path)))

def write_failed(export_dir, failed_rows):
    if not len(failed_rows):
        return
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    failed_dir = ensure_dir(export_dir)
    failed_path = os.path.join(failed_dir, f"failed_{ts}.xlsx")
    failed_rows.to_excel(failed_path, index=False)
    logging.warning(f"⚠️ Failed rows written to {failed_path}")
