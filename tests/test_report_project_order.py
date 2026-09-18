from pathlib import Path
import subprocess,sys,unittest
SCENARIO=r'''
import os,tempfile
with tempfile.TemporaryDirectory(prefix='report-project-order-') as tmp:
 os.environ['WIAREPORT_DATA_DIR']=tmp
 from backend import main as m
 from fastapi.testclient import TestClient
 m.init_db();c=TestClient(m.app)
 def ok(r,status=200):
  assert r.status_code==status,(r.status_code,r.text)
  return r.json() if r.content else None
 team=ok(c.post('/api/teams',json={'department':'Report order','login_id':'report-order'}),201)['team_id'];base='/api/teams/'+team
 h={'X-Wia-Team':team,'X-Wia-Part':''}
 users=[ok(c.post(base+'/users',json={'name':name,'role':'M'}),201)['user_id'] for name in ['첫째','둘째']]
 ids=[]
 for name in ['가과제','나과제','다과제']:
  ids.append(ok(c.post(base+'/team-projects',json={'project_name':name,'members':[{'user_id':u,'role':'M'} for u in users]}),201)['project_id'])
 report=ok(c.post(base+'/reports',json={'start_date':'2026-09-14','end_date':'2026-09-18'}),201)
 def auth(user):return ok(c.post('/api/reports/'+report['report_id']+'/users/'+user+'/authorize',headers=h,json={'password':m.INITIAL_PASSWORD}))['projects']
 first=auth(users[0]);second=auth(users[1]);entry=first[0]['entry_id']
 for pid in ids:
  ok(c.put('/api/report-entries/'+entry+'/projects/'+pid,headers=h,json={'progress_log':[{'log':'보고 내용 '+pid,'date':'2026-09-18'}],'risk_issue':[],'next_plan':[]}))
 first=auth(users[0]);old=[p['project_id'] for p in first if p['project_id'] in ids]
 wanted=old[::-1]
 with m.get_conn() as conn:
  before={table:[tuple(row) for row in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')] for table in ['project','project_members','report_entries','project_progress','project_issue','project_plan']}
  columns=[r['name'] for r in conn.execute('PRAGMA table_info(project_entry)') if r['name']!='sort_order']
  content=conn.execute('SELECT '+','.join(columns)+' FROM project_entry ORDER BY rowid').fetchall()
 def save(order,expected,status=200,headers=h):return ok(c.put('/api/report-entries/'+entry+'/project-order',headers=headers,json={'project_ids':order,'expected_ids':expected}),status)
 save(wanted,old)
 assert [p['project_id'] for p in auth(users[0]) if p['project_id'] in ids]==wanted
 assert [p['project_id'] for p in auth(users[1])]==[p['project_id'] for p in second]
 save(old,old,409);save([wanted[0]]*3,wanted,409);save(wanted[:-1],wanted,409)
 other=next(p['project_id'] for p in first if p['project_id'] not in ids)
 save(wanted+[other],wanted,409)
 with m.get_conn() as conn:
  for table,rows in before.items():assert rows==[tuple(row) for row in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')],table
  assert [tuple(row) for row in content]==[tuple(row) for row in conn.execute('SELECT '+','.join(columns)+' FROM project_entry ORDER BY rowid')]
 html=ok(c.get('/api/reports/'+report['report_id']+'/users/'+users[0]+'/html-report',headers=h))['html']
 names={p['project_id']:p['project_name'] for p in first};assert [html.index(names[pid]) for pid in wanted]==sorted(html.index(names[pid]) for pid in wanted)
 ok(c.put(base+'/parts/settings',json={'enabled':True}))
 part=ok(c.post(base+'/parts',json={'name':'별도'}),201)['parts'][0]['part_id']
 save(old,wanted,404,{**h,'X-Wia-Part':part})
 ok(c.put('/api/reports/'+report['report_id']+'/users/'+users[1]+'/absence',headers=h))
 ok(c.put('/api/reports/'+report['report_id']+'/complete',headers=h))
 save(old,wanted,409)
 ok(c.put('/api/reports/'+report['report_id']+'/reopen',headers=h))
 save(old,wanted)
 with m.get_conn() as conn:assert not conn.execute('PRAGMA foreign_key_check').fetchall()
 print('PASS: personal/week order, reopen, HTML order, content/timestamps, other users, scope, conflicts')
'''
class ReportProjectOrder(unittest.TestCase):
 def test_report_order(self):
  r=subprocess.run([sys.executable,'-W','ignore::DeprecationWarning','-c',SCENARIO],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=60)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)
