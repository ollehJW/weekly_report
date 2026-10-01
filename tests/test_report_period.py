"""Period edits preserve content; scheduled occurrences survive edits/deletion."""
from pathlib import Path
import subprocess
import sys
import unittest

SCENARIO = r'''
import os, tempfile
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
with tempfile.TemporaryDirectory(prefix='report-period-') as tmp:
 os.environ['WIAREPORT_DATA_DIR']=tmp
 from backend import main as m
 from tests.credential_support import TestClient, TEST_PASSWORD
 m.init_db(); c=TestClient(m.app)
 def ok(r,status=200):
  assert r.status_code==status,(r.status_code,r.text)
  return r.json() if r.content else None
 team=ok(c.post('/api/teams',json={'department':'DX추진랩','login_id':'period-test'}),201)['team_id']
 base='/api/teams/'+team; h={'X-Wia-Team':team,'X-Wia-Part':''}
 with m.get_conn() as conn:conn.execute('UPDATE teams SET report_schedule_enabled=0')
 m.init_db()
 with m.get_conn() as conn:assert conn.execute('SELECT report_schedule_enabled FROM teams WHERE team_id=?',(team,)).fetchone()[0]==0
 ok(c.put(base+'/report-schedule',headers=h,json={'enabled':True,'weekday':4,'time':'17:00','interval_days':7}))
 user=ok(c.post(base+'/users',json={'name':'작성자','role':'M'}),201)['user_id']
 project=ok(c.post(base+'/team-projects',json={'project_name':'기간 검증','members':[{'user_id':user,'role':'M'}]}),201)['project_id']
 now=datetime(2026,10,2,18,tzinfo=m.KST)
 with ThreadPoolExecutor(max_workers=3) as pool: batches=list(pool.map(lambda _:m.create_due_weekly_reports(now),range(3)))
 ids=[rid for batch in batches for rid in batch];assert len(ids)==1,ids
 rid=ids[0];url='/api/reports/'+rid
 report=ok(c.get(base+'/reports/active-list',headers=h))[0]
 projects=ok(c.post(url+'/users/'+user+'/authorize',headers=h,json={'password':TEST_PASSWORD}))['projects'];entry=projects[0]['entry_id']
 ok(c.put('/api/report-entries/'+entry+'/projects/'+project,headers=h,json={'progress_log':[{'log':'기간 변경 후에도 유지','date':'2026-10-04'}],'risk_issue':[],'next_plan':[]}))
 with m.get_conn() as conn:
  before={t:[tuple(row) for row in conn.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in ['report_entries','project_entry','project_progress','project_issue','project_plan']}
  conn.execute("UPDATE reports SET status='done',completed_at='2026-10-08T08:00:00' WHERE report_id=?",(rid,))
 def edit(start,end,expected_start='2026-10-02',expected_end='2026-10-08',status=200,headers=h):
  return ok(c.put(url+'/period',headers=headers,json={'start_date':start,'end_date':end,'expected_start_date':expected_start,'expected_end_date':expected_end}),status)
 edit('2026-10-10','2026-10-09',status=422)
 updated=edit('2026-10-03','2026-10-09')
 assert updated['status']=='done' and updated['completed_at']=='2026-10-08T08:00:00'
 assert updated['created_at']==report['created_at']
 with m.get_conn() as conn:
  for table,rows in before.items():assert rows==[tuple(row) for row in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')],table
 edit('2026-10-04','2026-10-10',status=409)
 duplicate=ok(c.post(base+'/reports',headers=h,json={'start_date':'2026-10-15','end_date':'2026-10-20'}),201)
 edit('2026-10-15','2026-10-20','2026-10-03','2026-10-09',409)
 edit('2026-10-04','2026-10-10','2026-10-03','2026-10-09',404,{**h,'X-Wia-Team':'other'})
 edit('2026-10-04','2026-10-10','2026-10-03','2026-10-09',401,{**h,'Authorization':''})
 assert m.create_due_weekly_reports(now+timedelta(days=1))==[]
 ok(c.delete(url,headers=h),204)
 m.init_db()
 assert m.create_due_weekly_reports(now+timedelta(days=2))==[]
 # Altering the report length must not recreate an already-consumed occurrence.
 ok(c.put(base+'/report-schedule',headers=h,json={'enabled':True,'weekday':4,'time':'17:00','interval_days':5}))
 assert m.create_due_weekly_reports(now+timedelta(days=2))==[]
 assert len(m.create_due_weekly_reports(now+timedelta(days=7)))==1
 # Explicit manual recreation remains possible.
 manual=ok(c.post(base+'/reports',headers=h,json={'start_date':'2026-10-02','end_date':'2026-10-08'}),201)
 assert manual['report_id']!=rid
 # Old reports without a schedule record are protected on edit/deletion too.
 with m.get_conn() as conn:
  old,_=m.create_weekly_report(conn,team,m.date(2026,10,16),m.date(2026,10,20));old_id=old['report_id']
 ok(c.delete('/api/reports/'+old_id,headers=h),204)
 assert m.create_due_weekly_reports(now+timedelta(days=14))==[]
 with m.get_conn() as conn:
  old,_=m.create_weekly_report(conn,team,m.date(2026,10,23),m.date(2026,10,27));old_id=old['report_id']
 ok(c.put('/api/reports/'+old_id+'/period',headers=h,json={'start_date':'2026-10-24','end_date':'2026-10-28','expected_start_date':'2026-10-23','expected_end_date':'2026-10-27'}))
 assert m.create_due_weekly_reports(now+timedelta(days=21))==[]
 # The same occurrence in another part is independent of the deleted team report.
 ok(c.put(base+'/parts/settings',json={'enabled':True}))
 part=ok(c.post(base+'/parts',json={'name':'A파트'}),201)['parts'][0]['part_id'];ph={**h,'X-Wia-Part':part}
 ok(c.put(base+'/report-schedule',headers=ph,json={'enabled':True,'weekday':4,'time':'17:00','interval_days':7}))
 part_ids=m.create_due_weekly_reports(now);assert len(part_ids)==1
 ok(c.delete('/api/reports/'+part_ids[0],headers=ph),204)
 assert m.create_due_weekly_reports(now+timedelta(days=1))==[]
 edit('2026-10-04','2026-10-10','2026-10-03','2026-10-09',404)
 with m.get_conn() as conn:
  assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
  assert not conn.execute('PRAGMA foreign_key_check').fetchall()
 print('PASS: concurrent schedules, period edit/content preservation, validation/conflicts/auth, deleted and legacy reports, restart, settings, next recurrence, parts, manual creation')
'''

class ReportPeriod(unittest.TestCase):
    def test_period_and_schedule(self):
        result = subprocess.run([sys.executable, '-W', 'ignore::DeprecationWarning', '-c', SCENARIO], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
