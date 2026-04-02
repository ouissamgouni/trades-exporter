from sqlalchemy import create_engine, text

engine = create_engine('postgresql://trades_user:trades_password@localhost:5432/trades_db_dev')
with engine.connect() as conn:
    # Get latest version
    r = conn.execute(text('SELECT version_id, status, created_at FROM calculation_versions ORDER BY created_at DESC LIMIT 1'))
    row = r.fetchone()
    vid = row[0]
    print(f'Version {vid}, status: {row[1]}, created: {row[2]}')

    # Check cost_lots date range
    r = conn.execute(text('SELECT MIN(acquired_date), MAX(acquired_date), COUNT(*) FROM cost_lots WHERE version_id = :v'), {'v': vid})
    row = r.fetchone()
    print(f'Cost lots: min={row[0]}, max={row[1]}, count={row[2]}')

    # Check normalized_transactions date range
    r = conn.execute(text('SELECT MIN(timestamp), MAX(timestamp), COUNT(*) FROM normalized_transactions'))
    row = r.fetchone()
    print(f'Transactions: min={row[0]}, max={row[1]}, count={row[2]}')
