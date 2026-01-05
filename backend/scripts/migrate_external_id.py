#!/usr/bin/env python
"""
Migrate ticker/coin_id from params to external_id column.

Run with: TEST_MODE=1 python scripts/migrate_external_id.py
"""
import os
import json
import psycopg2
from dotenv import load_dotenv

load_dotenv('.env')

# Determine which port to use based on TEST_MODE
is_test = os.getenv('TEST_MODE', '').lower() in ('1', 'true', 'yes')
port = os.getenv('POSTGRES_TEST_PORT', '5433') if is_test else os.getenv('POSTGRES_PORT', '5432')
dbname = os.getenv('POSTGRES_DB_TEST', 'trades_db_test') if is_test else os.getenv('POSTGRES_DB', 'trades_db')

print(f"Connecting to {dbname} on port {port} (TEST_MODE={is_test})")

conn = psycopg2.connect(
    host=os.getenv('POSTGRES_HOST', 'localhost'),
    port=port,
    dbname=dbname,
    user=os.getenv('POSTGRES_USER', 'trades_user'),
    password=os.getenv('POSTGRES_PASSWORD', 'trades_password')
)
cur = conn.cursor()

# Get all rows with ticker or coin_id in params
cur.execute('''
    SELECT id, price_getter, params 
    FROM asset_price_getters 
    WHERE (params->>'ticker' IS NOT NULL 
       OR params->>'coin_id' IS NOT NULL
       OR params->>'asset_id' IS NOT NULL)
      AND external_id IS NULL
''')

updates = []
for row in cur.fetchall():
    id, getter, params = row
    params = params or {}
    
    # Extract external_id based on what's available (priority: asset_id > ticker > coin_id)
    external_id = params.get('asset_id') or params.get('ticker') or params.get('coin_id')
    
    if external_id:
        # Remove the old keys from params
        new_params = {k: v for k, v in params.items() if k not in ('asset_id', 'ticker', 'coin_id')}
        updates.append((external_id, json.dumps(new_params), id))

print(f'Found {len(updates)} rows to update')

# Apply updates
for external_id, params_json, id in updates:
    cur.execute('''
        UPDATE asset_price_getters 
        SET external_id = %s, params = %s::jsonb
        WHERE id = %s
    ''', (external_id, params_json, id))

conn.commit()
print('Migration complete')

# Verify
print('\nSample rows after migration:')
cur.execute('SELECT id, price_getter, external_id, params FROM asset_price_getters LIMIT 5;')
for row in cur.fetchall():
    print(row)

conn.close()
