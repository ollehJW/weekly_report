from pathlib import Path
import subprocess,sys,unittest
SCENARIO=r'''
import os,tempfile
with tempfile.TemporaryDirectory(prefix='project-order-') as tmp:
 os.environ['WIAREPORT_DATA_DIR']=tmp
 from backend import main as m
 from fastapi.testclient import TestClient
 m.init_db();c=TestClient(m.app)
 def ok(r,status=200):
  assert r.status_code==status,(r.status_code,r.text)
  return r.json() if r.content else None
 team=ok(c.post('/api/teams',json={'department':'Order','login_id':'order-test'}),201)['team_id'];base='/api/teams/'+team
 h={'X-Wia-Team':team,'X-Wia-Part':''}
 ps=[]
 for name,status in [('과제 10','in_progress'),('과제 2','in_progress'),('가나다','done')]:
  ps.append(ok(c.post(base+'/team-projects',headers=h,json={'project_name':name,'status':status}),201)['project_id'])
 def order(ids,expected,status=200,headers=h):return ok(c.put(base+'/team-projects/order',headers=headers,json={'project_ids':ids,'expected_ids':expected}),status)
 with m.get_conn() as conn:
  snapshot={r['project_id']:dict(r) for r in conn.execute('SELECT * FROM project WHERE team_id=?',(team,))}
 rows=order([ps[1],ps[0],ps[2]],ps);assert [r['project_id'] for r in rows]==[ps[1],ps[0],ps[2]]
 order(ps,ps,409)
 order([ps[1],ps[1],ps[2]],[ps[1],ps[0],ps[2]],409)
 order(ps[:2],[ps[1],ps[0],ps[2]],409)
 order(['invalid',ps[0],ps[2]],[ps[1],ps[0],ps[2]],409)
 ok(c.put(base+'/parts/settings',json={'enabled':True}))
 part=ok(c.post(base+'/parts',json={'name':'A'}),201)['parts'][0]['part_id']
 hp={**h,'X-Wia-Part':part}
 other=ok(c.post(base+'/team-projects',headers=hp,json={'project_name':'파트 과제'}),201)['project_id']
 order([other]+ps,[ps[1],ps[0],ps[2]],409)
 order([other],[other],headers=hp)
 order(ps,[ps[1],ps[0],ps[2]])
 assert [r['project_id'] for r in ok(c.get(base+'/team-projects',headers=h))]==ps
 assert [r['project_id'] for r in ok(c.get(base+'/team-projects',headers=hp))]==[other]
 with m.get_conn() as conn:
  for row in conn.execute('SELECT * FROM project WHERE team_id=?',(team,)):
   if row['project_id'] in snapshot:
    assert all(row[k]==v for k,v in snapshot[row['project_id']].items() if k!='sort_order')
  assert not conn.execute('PRAGMA foreign_key_check').fetchall()
 print('PASS: ordering persists, stale/duplicate/missing/foreign items rejected, scopes and task content preserved')
'''
class ProjectOrder(unittest.TestCase):
 def test_order(self):
  result=subprocess.run([sys.executable,'-W','ignore::DeprecationWarning','-c',SCENARIO],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=60)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
