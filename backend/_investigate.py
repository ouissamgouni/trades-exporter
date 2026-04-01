"""Temporary investigation script for unit #72640"""
import sys
sys.path.insert(0, "/Users/ouissamgouni/Documents/it-workspace/trades-exporter")

from backend.db.database import get_engine
from sqlmodel import Session, text

engine = get_engine()
with Session(engine) as s:
    # Legs (account_id is on the transaction, not the leg)
    legs = s.exec(text(
        "SELECT l.id, l.leg_type, l.asset_id, l.quantity, "
        "a.symbol, l.transaction_id, t.account_id, t.from_account_id, t.to_account_id, "
        "t.transaction_type, t.direction "
        "FROM calculation_unit_legs l "
        "LEFT JOIN assets a ON l.asset_id = a.asset_id "
        "LEFT JOIN normalized_transactions t ON l.transaction_id = t.id "
        "WHERE l.unit_id = 72640 "
        "ORDER BY l.leg_type, l.asset_id"
    )).all()
    print("=== Legs ===")
    for leg in legs:
        print(f"  leg={leg[0]} type={leg[1]} asset={leg[4]}(id={leg[2]}) qty={leg[3]} tx={leg[5]} acct={leg[6]} from={leg[7]} to={leg[8]} tx_type={leg[9]} dir={leg[10]}")

    # Realized PnL
    pnl = s.exec(text(
        "SELECT pnl_id, asset_id, qty, proceeds_in_base, cost_basis_in_base, pnl_in_base, "
        "disposal_taxable, proceeds_source, proceeds_price, proceeds_price_source, notes "
        "FROM realized_pnl WHERE origin_unit_id = 72640"
    )).all()
    print("\n=== Realized PnL ===")
    for p in pnl:
        print(f"  pnl={p[0]} asset_id={p[1]} qty={p[2]} proceeds={p[3]} cost={p[4]} pnl={p[5]} taxable={p[6]} src={p[7]} price={p[8]} price_src={p[9]} notes={p[10]}")

    # Warnings
    warnings = s.exec(text(
        "SELECT id, warning_type, message, asset_id "
        "FROM pnl_warnings WHERE unit_id = 72640"
    )).all()
    print("\n=== Warnings ===")
    if not warnings:
        print("  (none)")
    for w in warnings:
        print(f"  id={w[0]} type={w[1]} msg={w[2][:150]} asset={w[3]}")

    # INDW.PA asset
    asset_cols = s.exec(text("SELECT column_name FROM information_schema.columns WHERE table_name = 'assets' ORDER BY ordinal_position")).all()
    print(f"\n=== assets columns: {[c[0] for c in asset_cols]}")
    asset = s.exec(text("SELECT asset_id, symbol, label FROM assets WHERE symbol = 'INDW.PA'")).first()
    if asset:
        print(f"=== Asset INDW.PA === id={asset[0]} sym={asset[1]} label={asset[2]}")

    # Bundle #117
    bundle = s.exec(text(
        "SELECT b.id, b.pattern, b.taxability_override "
        "FROM bundles b WHERE b.id = 117"
    )).first()
    if bundle:
        print(f"\n=== Bundle #117 === id={bundle[0]} pattern={bundle[1]} tax_override={bundle[2]}")
    else:
        print("\n=== Bundle #117 === NOT FOUND")

    # Transactions in the bundle via user_calculation_unit_id
    bundle_txs = s.exec(text(
        "SELECT t.id, t.transaction_type, t.direction, t.asset_id, a.symbol, "
        "t.quantity, t.account_id, t.from_account_id, t.to_account_id "
        "FROM normalized_transactions t "
        "LEFT JOIN assets a ON t.asset_id = a.asset_id "
        "WHERE t.user_calculation_unit_id = 117 ORDER BY t.direction"
    )).all()
    print(f"\n=== Transactions in bundle 117 (via user_calculation_unit_id) ===")
    if not bundle_txs:
        print("  (none)")
    for m in bundle_txs:
        print(f"  tx={m[0]} type={m[1]} dir={m[2]} asset={m[4]}(id={m[3]}) qty={m[5]} acct={m[6]} from_acct={m[7]} to_acct={m[8]}")

    # Price snapshots for INDW.PA
    if asset:
        prices = s.exec(text(
            "SELECT snapshot_id, snapshot_time, price, source, quote_asset_id "
            "FROM price_snapshots WHERE asset_id = :aid ORDER BY snapshot_time DESC LIMIT 5"
        ).bindparams(aid=asset[0])).all()
        print(f"\n=== Price Snapshots for INDW.PA (last 5) ===")
        for p in prices:
            print(f"  snap={p[0]} time={p[1]} price={p[2]} source={p[3]} quote_asset={p[4]}")

    # Check base currency
    print(f"\n=== EUR asset ===")
    eur = s.exec(text("SELECT asset_id, symbol, label FROM assets WHERE symbol = 'EUR'")).first()
    if eur:
        print(f"  id={eur[0]} sym={eur[1]} label={eur[2]}")

    # Unit #51153
    r2 = s.exec(text("SELECT id, version_id, pattern, unit_label, unit_origin FROM calculation_units WHERE id = 51153")).first()
    if r2:
        print(f"\n=== Unit #51153 === id={r2[0]} version={r2[1]} pattern={r2[2]} label={r2[3]} origin={r2[4]}")

    # Realized PnL #51154
    p2 = s.exec(text(
        "SELECT pnl_id, asset_id, qty, proceeds_in_base, cost_basis_in_base, pnl_in_base, "
        "disposal_taxable, proceeds_source, proceeds_price, proceeds_price_source "
        "FROM realized_pnl WHERE pnl_id = 51154"
    )).first()
    if p2:
        print(f"\n=== Realized PnL #51154 === pnl={p2[0]} asset_id={p2[1]} qty={p2[2]} proceeds={p2[3]} cost={p2[4]} pnl={p2[5]} taxable={p2[6]} src={p2[7]} price={p2[8]} price_src={p2[9]}")

    # Price getters for INDW.PA
    if asset:
        getters = s.exec(text(
            "SELECT id, asset_id, price_getter, enabled, priority, external_id, params "
            "FROM asset_price_getters WHERE asset_id = :aid"
        ).bindparams(aid=asset[0])).all()
        print(f"\n=== Price Getters for INDW.PA ===")
        if not getters:
            print("  (none)")
        for g in getters:
            print(f"  id={g[0]} getter={g[2]} enabled={g[3]} priority={g[4]} ext_id={g[5]} params={g[6]}")

    # Raw transaction data for bundle txs
    print(f"\n=== Raw Transaction Data ===")
    for txid in [9684, 9685]:
        r = s.exec(text(
            "SELECT id, transaction_type, direction, asset_id, quantity, price, "
            "price_quote_asset_id, source_asset_symbol, source_price_quote_asset_symbol, "
            "account_id, source, source_transaction_type "
            "FROM normalized_transactions WHERE id = :tid"
        ).bindparams(tid=txid)).first()
        if r:
            total = r[4] * r[5] if r[4] and r[5] else None
            print(f"  TX {r[0]}: type={r[1]} dir={r[2]} asset_id={r[3]} qty={r[4]} price={r[5]} "
                  f"quote_id={r[6]} src_sym={r[7]} src_quote={r[8]} acct={r[9]} source={r[10]} "
                  f"src_type={r[11]} computed_total={total}")
