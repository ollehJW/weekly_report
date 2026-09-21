"""Move actual members through unassigned and part scopes without altering history."""
from pathlib import Path
import subprocess
import sys
import unittest

SCENARIO = r'''
import os, tempfile
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='wia-member-move-') as tmp:
 os.environ['WIAREPORT_DATA_DIR']=tmp
 from backend import main as m
 from tests.credential_support import TestClient, TEST_PASSWORD
 m.init_db()
 c=TestClient(m.app)
 def ok(r,status=200):
  assert r.status_code==status,(r.status_code,r.text)
  return r.json() if r.content else None
 t=ok(c.post('/api/teams',json={'department':'Move test','login_id':'move-test'}),201)['team_id']
 other=ok(c.post('/api/teams',json={'department':'Other','login_id':'move-other'}),201)['team_id']
 base='/api/teams/'+t
 h={'X-Wia-Team':t,'X-Wia-Part':''}
 user=ok(c.post(base+'/users',headers=h,json={'name':'이동 멤버','role':'CM'}),201)
 uid=user['user_id']
 outsider=ok(c.post('/api/teams/'+other+'/users',json={'name':'외부 멤버','role':'M'}),201)['user_id']
 project=ok(c.post(base+'/team-projects',headers=h,json={'project_name':'Original','members':[{'user_id':uid,'role':'M'}]}),201)
 ok(c.post(base+'/events',headers=h,json={'title':'Original event','event_type':'team','start_date':'2026-09-14','end_date':'2026-09-18','member_ids':[uid]}),201)
 report=ok(c.post(base+'/reports',headers=h,json={'start_date':'2026-09-14','end_date':'2026-09-18'}),201)
 ok(c.post('/api/reports/'+report['report_id']+'/users/'+uid+'/authorize',headers=h,json={'password':TEST_PASSWORD}))
 tables=['project','project_members','milestones','epics','reports','report_entries','project_entry','team_events','team_event_members','project_progress','project_issue','project_plan']
 with m.get_conn() as conn:
  snapshot={table:[tuple(r) for r in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')] for table in tables}
  original=dict(conn.execute('SELECT * FROM users WHERE user_id=?',(uid,)).fetchone())
 endpoint=base+'/parts/members/'+uid
 def move(part,expected,status=200,headers=h):
  return ok(c.put(endpoint,headers=headers,json={'part_id':part,'expected_part_id':expected}),status)
 move(None,None,409)
 ok(c.put(base+'/parts/settings',json={'enabled':True}))
 a=ok(c.post(base+'/parts',json={'name':'A'}),201)['parts'][0]['part_id']
 b=ok(c.post(base+'/parts',json={'name':'B'}),201)['parts'][1]['part_id']
 resident=ok(c.post(base+'/users',headers={**h,'X-Wia-Part':a},json={'name':'기존 A 멤버','role':'M'}),201)['user_id']
 ok(c.put('/api/teams/'+other+'/parts/settings',json={'enabled':True}))
 foreign=ok(c.post('/api/teams/'+other+'/parts',json={'name':'Foreign'}),201)['parts'][0]['part_id']
 board=ok(c.get(base+'/parts/members',headers={**h,'X-Wia-Part':a}))
 assert {x['user_id'] for x in board}=={uid,resident}
 assert all(set(x)=={'user_id','name','role','part_id'} for x in board)
 ok(c.get(base+'/parts/members',headers={'X-Wia-Team':other}),404)
 move(a,None,404,{'X-Wia-Team':other})
 ok(c.put(base+'/parts/members/'+outsider,headers=h,json={'part_id':a,'expected_part_id':None}),404)
 move(foreign,None,404);move('missing',None,404)
 ok(c.put(endpoint,headers=h,json={'part_id':a}),422)
 rows=move(a,None)
 assert next(x for x in rows if x['user_id']==uid)['part_id']==a
 assert [x['user_id'] for x in ok(c.get(base+'/users',headers={**h,'X-Wia-Part':a}))]==[resident,uid]
 assert not ok(c.get(base+'/users',headers=h))
 # Idempotent retry succeeds; a stale move to a different destination is rejected.
 move(a,None)
 move(b,None,409)
 assert next(x for x in ok(c.get(base+'/parts/members')) if x['user_id']==uid)['part_id']==a
 move(b,a)
 assert [x['user_id'] for x in ok(c.get(base+'/users',headers={**h,'X-Wia-Part':b}))]==[uid]
 move(None,b)
 assert [x['user_id'] for x in ok(c.get(base+'/users',headers=h))]==[uid]
 with m.get_conn() as conn:
  now=dict(conn.execute('SELECT * FROM users WHERE user_id=?',(uid,)).fetchone())
  for key in original:
   if key!='sort_order': assert original[key]==now[key],key
  for table in tables:
   assert snapshot[table]==[tuple(r) for r in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')],table
  assert not conn.execute('PRAGMA foreign_key_check').fetchall()
 move(a,None)
 # Existing report keeps its original member, and future part reports include them.
 reports=ok(c.get(base+'/reports/active',headers=h))
 with m.get_conn() as conn:
  old=m.report_with_entries(conn,conn.execute('SELECT * FROM reports WHERE report_id=?',(report['report_id'],)).fetchone())
 assert uid in [u['user_id'] for u in old['members']]
 future=ok(c.post(base+'/reports',headers={**h,'X-Wia-Part':a},json={'start_date':'2026-09-21','end_date':'2026-09-25'}),201)
 assert uid in [u['user_id'] for u in future['members']]
 ok(c.put(base+'/parts/settings',json={'enabled':False}))
 move(b,a,409)
 assert len(ok(c.get(base+'/users',headers=h)))==2
 print('PASS: moves, return to unassigned, scope, history, future reports, validation, conflicts')
'''

class PartMemberMoves(unittest.TestCase):
    def test_move_members(self):
        result = subprocess.run([sys.executable, '-W', 'ignore::DeprecationWarning', '-c', SCENARIO], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

if __name__ == '__main__':
    unittest.main()
