"""Initialize an empty WiaReport schema; existing data is never replaced."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.database import connect,configuration
if __name__ == '__main__':
    assert configuration()['database']['schema']=='wiareport'
    with connect() as db:
        if db.execute("SELECT 1 FROM information_schema.tables WHERE table_schema='wiareport'").fetchone():
            raise SystemExit('Schema already contains tables; initialization was not performed.')
        db.execute((Path(__file__).resolve().parents[1]/'backend/schema.sql').read_text())
    print('WiaReport schema initialized. Platform schema must already be installed.')
