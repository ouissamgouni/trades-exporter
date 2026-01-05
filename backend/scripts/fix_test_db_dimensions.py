"""Check TEST database state."""
import sqlalchemy as sa
from backend.db.database import get_engine

engine = get_engine()
with engine.connect() as conn:
    result = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'categories' ORDER BY column_name"
    ))
    print("Categories columns:", [r[0] for r in result.fetchall()])
    
    result = conn.execute(sa.text("SELECT * FROM dimensions"))
    print("Dimensions:", [dict(r._mapping) for r in result.fetchall()])
    
    result = conn.execute(sa.text("SELECT id, label, dimension_id FROM categories LIMIT 5"))
    print("Sample categories:", [dict(r._mapping) for r in result.fetchall()])
