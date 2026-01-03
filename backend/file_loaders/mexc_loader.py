import pandas as pd
import re
from backend.config.loader import configure_logging

log = configure_logging("mexc_loader")

def load_mexc_file(file_path):
    """Load and standardize MEXC trades."""
    log.info("loading_mexc_file", file_path=file_path)
    df_origin = pd.read_excel(file_path, keep_default_na=False, na_values=[''])
    df=pd.DataFrame()
    df[["base", "quote"]] = df_origin["Pairs"].str.split("_", expand=True)
    df["datetime"] = pd.to_datetime(df_origin["Time"], utc=True)
    df["fee"] = df_origin["Fee"].apply(lambda x: float(re.match(r"([0-9.]+)", str(x)).group(1)) if pd.notna(x) else 0)
    df["fee_quote"] = df_origin["Fee"].apply(lambda x: re.search(r"[A-Za-z]+", str(x)).group(0) if pd.notna(x) else None)

    df[["quantity","total","price"]] = df_origin[["Executed Amount", "Total", "Filled Price"]]
    df["type"] = df_origin["Side"].str.lower()
    df["exchange"] = "MEXC"
    return df
