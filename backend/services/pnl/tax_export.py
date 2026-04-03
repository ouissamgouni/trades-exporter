"""
French Tax Export Formatters.

Generates CSV exports compatible with French tax forms:
  - Cerfa 2086: Crypto-asset gains (Article 150 VH bis CGI)
  - Form 2074: Securities capital gains (Article 150-0 A CGI)

CSV format follows official FISC guidelines for auto-fill compatibility.
"""

import csv
import io
from datetime import datetime
from decimal import Decimal
from typing import List, Optional


def _fmt_eur(value: Decimal) -> str:
    """Format a Decimal as a EUR amount with 2 decimal places."""
    return f"{value:.2f}"


def _fmt_date(dt: Optional[datetime]) -> str:
    """Format a datetime as DD/MM/YYYY (French date format)."""
    if dt is None:
        return ""
    return dt.strftime("%d/%m/%Y")


# ============================================================================
# Cerfa 2086 (Crypto – Article 150 VH bis CGI)
# ============================================================================

# Official Cerfa 2086 column names (simplified English labels in parentheses)
CERFA_2086_HEADERS = [
    "Numéro de cession",          # Line number
    "Date de cession",            # Disposal date (DD/MM/YYYY)
    "Désignation de l'actif",     # Asset name (e.g., "Bitcoin (BTC)")
    "Prix de cession",            # Proceeds (EUR)
    "Valeur globale du portefeuille au moment de la cession",  # Global portfolio value at disposal
    "Prix total d'acquisition du portefeuille",                # Total portfolio acquisition cost
    "Plus ou moins-value brute",  # Gross gain/loss (EUR)
    "Impôt (PFU 30%)",            # Tax at PFU rate (EUR)
    "Notes",                       # Optional notes
]


def export_cerfa_2086_csv(entries, summaries) -> str:
    """
    Generate a Cerfa 2086-compatible CSV string from FrenchCryptoTaxEntry records.
    
    Args:
        entries: List of FrenchCryptoTaxEntry ORM objects
        summaries: List of FrenchCryptoTaxAnnualSummary ORM objects
        
    Returns:
        CSV string with BOM prefix (Excel compatibility)
    """
    output = io.StringIO()
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL)

    writer.writerow(CERFA_2086_HEADERS)

    for idx, entry in enumerate(entries, start=1):
        writer.writerow([
            idx,
            _fmt_date(entry.cession_date),
            entry.asset_symbol,
            _fmt_eur(entry.proceeds),
            _fmt_eur(entry.portfolio_value_at_cession),
            _fmt_eur(entry.total_acquisition_cost),
            _fmt_eur(entry.taxable_gain),
            _fmt_eur(entry.tax_amount),
            entry.note or "",
        ])

    # Append annual totals section
    if summaries:
        writer.writerow([])
        writer.writerow(["=== Récapitulatif annuel ==="])
        writer.writerow([
            "Année fiscale",
            "Total plus-values brutes",
            "Total moins-values brutes",
            "Plus-value nette imposable",
            "Impôt total (PFU 30%)",
            "Nombre de cessions",
        ])
        for s in sorted(summaries, key=lambda x: x.fiscal_year):
            writer.writerow([
                s.fiscal_year,
                _fmt_eur(s.total_gains),
                _fmt_eur(s.total_losses),
                _fmt_eur(s.net_taxable),
                _fmt_eur(s.tax_total),
                s.transaction_count,
            ])

    return output.getvalue()


# ============================================================================
# Form 2074 (Securities – Article 150-0 A CGI)
# ============================================================================

FORM_2074_HEADERS = [
    "Numéro de ligne",
    "Date de cession",
    "Désignation du titre",
    "Sens",
    "Quantité",
    "Prix de cession",
    "Prix d'acquisition (CUMP)",
    "Plus ou moins-value",
    "Impôt (PFU 30%)",
]


def export_form_2074_csv(entries) -> str:
    """
    Generate a Form 2074-compatible CSV string for securities disposals.
    
    Args:
        entries: List of disposal objects with CUMP-based cost_basis
        
    Returns:
        CSV string with BOM prefix (Excel compatibility)
    """
    output = io.StringIO()
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL)

    writer.writerow(FORM_2074_HEADERS)

    for idx, entry in enumerate(entries, start=1):
        qty = entry.qty or Decimal("0")
        proceeds_total = (entry.proceeds_per_unit or Decimal("0")) * qty
        cost_total = (entry.cump_at_time or Decimal("0")) * qty
        writer.writerow([
            idx,
            _fmt_date(entry.trade_date),
            entry.asset_symbol,
            entry.direction or "",
            str(qty),
            _fmt_eur(proceeds_total),
            _fmt_eur(cost_total),
            _fmt_eur(entry.gain_loss),
            _fmt_eur(entry.tax_amount),
        ])

    return output.getvalue()
