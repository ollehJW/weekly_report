"""PostgreSQL storage; private config is independent of deployment paths."""
from contextvars import ContextVar
from pathlib import Path
import os, re
import psycopg
import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env', override=False)
actor = ContextVar('wiareport_actor', default=None)


def configuration():
    path = Path(os.getenv('WIAREPORT_DB_CONFIG', ROOT / 'config.yaml'))
    load_dotenv(path.resolve().parent / 'database.env', override=False)
    config = yaml.safe_load(path.read_text())
    if not re.fullmatch(r'wiareport(?:_test_[a-z0-9_]+)?', config['database'].get('schema', 'wiareport')):
        raise RuntimeError('WiaReport schema must be wiareport')
    return config


class Row(dict):
    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


def rows(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: Row(zip(names, values))


def connect():
    c = configuration()['database']
    return psycopg.connect(host=c['host'], port=c.get('port', 5432), dbname=c['name'], user=c['user'],
        password=os.getenv(c.get('password_env', 'AX_DB_PASSWORD'), c.get('password', '')),
        sslmode=c.get('sslmode', 'prefer'), connect_timeout=5,
        options=f"-c search_path={c.get('schema', 'wiareport')},public -c timezone=UTC -c statement_timeout=30000", row_factory=rows)


def parameters(statement):
    # Domain SQL uses qmark binding. Quoted literals are left untouched.
    parts = re.split(r"('(?:''|[^'])*'|\"(?:\"\"|[^\"])*\")", statement)
    return ''.join(p.replace('%', '%%') if i % 2 else p.replace('%', '%%').replace('?', '%s') for i, p in enumerate(parts))


class Connection:
    def __init__(self):
        from .parts import scope
        self.conn = connect()
        team, part, enabled = scope.get()
        self.conn.execute("SELECT set_config('wiareport.team',%s,true),set_config('wiareport.part',%s,true),set_config('wiareport.parts_enabled',%s,true)", (team or '', part or '', '1' if enabled else '0'))
    def __enter__(self): return self
    def __exit__(self, *args): return self.conn.__exit__(*args)
    def execute(self, statement, values=()): return self.conn.execute(parameters(statement), values or ())
    def executemany(self, statement, values):
        cur = self.conn.cursor(); cur.executemany(parameters(statement), values); return cur
    def commit(self): self.conn.commit()
    def rollback(self): self.conn.rollback()
    def close(self): self.conn.close()


def get_conn(): return Connection()
