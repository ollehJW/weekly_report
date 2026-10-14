"""One-time migration. Run --dry-run first; never overwrites a populated schema."""
import argparse, collections, hashlib, json, re, sqlite3, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.database import connect, configuration
from psycopg import sql

EXCLUDE={'sqlite_sequence','login_sessions'}
PRIVATE={'password_hash','must_change_password','password_expires_at','login_id','account_role'}
def table_name(name): return 'members' if name=='users' else name

def migrate(source, dry_run=False):
    src=sqlite3.connect(f'file:{Path(source).resolve()}?mode=ro',uri=True);src.row_factory=sqlite3.Row
    assert not src.execute('PRAGMA foreign_key_check').fetchall(), 'Source has orphan references'
    tables=[r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") if r[0] not in EXCLUDE]
    manifest={'tables':{},'unmapped_teams':[], 'unmapped_members':[]}
    with connect() as db:
        schema=configuration()['database'].get('schema','wiareport')
        assert not db.execute('SELECT 1 FROM information_schema.tables WHERE table_schema=%s',(schema,)).fetchone(), 'Target must be empty'
        statements=[]
        def ddl(statement):
            statements.append(statement.as_string(db) if hasattr(statement,'as_string') else statement)
            db.execute(statement)
        ddl(sql.SQL('CREATE SCHEMA IF NOT EXISTS {}').format(sql.Identifier(schema)))
        foreign=[]
        for old in tables:
            name=table_name(old)
            cols=[dict(r) for r in src.execute(f'PRAGMA table_info("{old}")') if r['name'] not in PRIVATE]
            defs=[]
            for c in cols:
                assert c['type'].upper() in ('TEXT','INTEGER','REAL'), c
                definition=f'"{c["name"]}" {c["type"]}'
                if c['notnull']: definition+=' NOT NULL'
                if c['dflt_value'] is not None: definition+=' DEFAULT '+c['dflt_value']
                defs.append(definition)
            pk=sorted([c for c in cols if c['pk']],key=lambda c:c['pk'])
            if pk: defs.append('PRIMARY KEY('+','.join('"'+c['name']+'"' for c in pk)+')')
            if old=='teams': defs.append('platform_team_id TEXT UNIQUE REFERENCES platform.teams(team_id)')
            if old=='users': defs += ['platform_user_id TEXT REFERENCES platform.users(user_id)', 'is_active INTEGER NOT NULL DEFAULT 0', 'UNIQUE(team_id,platform_user_id)']
            source_sql=src.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(old,)).fetchone()[0]
            defs.extend(re.findall(r'CHECK\((?:[^()]|\([^()]*\))*\)',source_sql,re.I))
            ddl(f'CREATE TABLE "{name}" ('+','.join(defs)+')')
            # Recreate every unique index, including SQLite-generated UNIQUE constraints.
            for idx in src.execute(f'PRAGMA index_list("{old}")'):
                if idx['origin']=='pk': continue
                keys=[r['name'] for r in src.execute(f'PRAGMA index_info("{idx["name"]}")')]
                if any(k in PRIVATE for k in keys):continue
                unique='UNIQUE ' if idx['unique'] else ''
                ddl(f'CREATE {unique}INDEX ON "{name}" ('+','.join('"'+k+'"' for k in keys)+')')
            grouped=collections.defaultdict(list)
            for fk in src.execute(f'PRAGMA foreign_key_list("{old}")'):grouped[fk['id']].append(dict(fk))
            for group in grouped.values():
                group.sort(key=lambda x:x['seq']);f=group[0]
                foreign.append(f'ALTER TABLE "{name}" ADD FOREIGN KEY ('+','.join('"'+f['from']+'"' for f in group)+') REFERENCES "'+table_name(f['table'])+'" ('+','.join('"'+f['to']+'"' for f in group)+') ON DELETE '+f['on_delete'])
            keys=[c['name'] for c in cols]
            records=[dict(r) for r in src.execute(f'SELECT '+','.join('"'+k+'"' for k in keys)+f' FROM "{old}"')]
            if records:
                with db.cursor() as cur:cur.executemany(f'INSERT INTO "{name}" ('+','.join('"'+k+'"' for k in keys)+') VALUES ('+','.join(['%s']*len(keys))+')', [tuple(r[k] for k in keys) for r in records])
            restored=[dict(r) for r in db.execute('SELECT '+','.join('"'+k+'"' for k in keys)+f' FROM "{name}"')]
            def digest(rows):return hashlib.sha256(json.dumps(sorted(json.dumps(r,ensure_ascii=False,sort_keys=True) for r in rows),ensure_ascii=False).encode()).hexdigest()
            assert digest(records)==digest(restored),f'Data mismatch: {name}'
            manifest['tables'][name]={'rows':len(records),'sha256':digest(records)}
        for statement in foreign:ddl(statement)
        # Exact, unique team and name matches only. Unknown names remain historical members.
        teams=collections.defaultdict(list)
        for t in db.execute('SELECT team_id,name FROM platform.teams'):teams[t['name'].strip()].append(t['team_id'])
        for t in db.execute('SELECT team_id,department FROM teams').fetchall():
            matches=teams[t['department'].strip()]
            if len(matches)!=1:
                manifest['unmapped_teams'].append(dict(t));continue
            pt=matches[0]
            db.execute('UPDATE teams SET platform_team_id=%s WHERE team_id=%s',(pt,t['team_id']))
            old_members=db.execute('SELECT user_id,name FROM members WHERE team_id=%s',(t['team_id'],)).fetchall()
            old_names=collections.Counter(m['name'].strip() for m in old_members)
            for m in old_members:
                matches=db.execute('SELECT user_id FROM platform.users WHERE team_id=%s AND btrim(full_name)=%s',(pt,m['name'].strip())).fetchall()
                if len(matches)==1 and old_names[m['name'].strip()]==1:
                    db.execute('UPDATE members SET platform_user_id=%s WHERE user_id=%s',(matches[0]['user_id'],m['user_id']))
        manifest['unmapped_members']=[dict(r) for r in db.execute('SELECT user_id,team_id,name FROM members WHERE platform_user_id IS NULL')]
        ddl('''CREATE TABLE user_activity(platform_user_id TEXT PRIMARY KEY REFERENCES platform.users(user_id),team_id TEXT REFERENCES teams(team_id),last_seen_at TIMESTAMPTZ NOT NULL)''')
        ddl('''CREATE FUNCTION part_visible(team TEXT,part TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
          SELECT (COALESCE(current_setting('wiareport.team',true),'')='' OR team=current_setting('wiareport.team',true))
           AND (COALESCE(current_setting('wiareport.parts_enabled',true),'0')!='1'
                OR part IS NOT DISTINCT FROM NULLIF(current_setting('wiareport.part',true),'')) $$''')
        ddl('''CREATE FUNCTION safe_timestamp(value TEXT) RETURNS TIMESTAMPTZ LANGUAGE plpgsql IMMUTABLE AS $$
          BEGIN RETURN NULLIF(value,'')::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $$''')
        for table in ('members','project','reports','team_events'):ddl(f'CREATE INDEX ON {table}(team_id,part_id)')
        from backend.platform_auth import sync_members
        for t in db.execute('SELECT * FROM teams WHERE platform_team_id IS NOT NULL').fetchall():sync_members(db,t)
        manifest['active_members']=db.execute('SELECT count(*) AS n FROM members WHERE is_active=1').fetchone()['n']
        manifest['schema_sql']='SET search_path=wiareport,public;\n'+(';'+'\n').join(statements).replace(schema,'wiareport')+';\n'
        manifest['mode']='dry-run' if dry_run else 'committed'
        if dry_run:db.rollback()
    src.close()
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('--dry-run',action='store_true');p.add_argument('--manifest',required=True);a=p.parse_args()
    result=migrate(a.source,a.dry_run);Path(a.manifest).with_suffix('.schema.sql').write_text(result.pop('schema_sql'));Path(a.manifest).write_text(json.dumps(result,ensure_ascii=False,indent=2));Path(a.manifest).chmod(0o600)
    print(json.dumps({'mode':result['mode'],'tables':{k:v['rows'] for k,v in result['tables'].items()},'unmapped_teams':len(result['unmapped_teams']),'unmapped_members':len(result['unmapped_members']),'active_members':result['active_members']}))
