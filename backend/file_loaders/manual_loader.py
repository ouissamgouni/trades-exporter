import pandas as pd
from backend.config.loader import configure_logging

log = configure_logging("manual_loader")

def load_manual_file(file_path):
    """Load failed rows that were manually edited and retried."""
    log.info("loading_manual_file", file_path=file_path)
    df = pd.read_excel(file_path, keep_default_na=False, na_values=[''])
    df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
    df.rename( columns={"asset": "base"}, inplace=True)
    return df
