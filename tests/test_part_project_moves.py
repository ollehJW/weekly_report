"""Project allocation, stable ordering and preservation of linked history."""
from pathlib import Path
import subprocess,sys,unittest
from test_part_member_moves import SCENARIO as MEMBER_SCENARIO
SCENARIO = MEMBER_SCENARIO + r'''
 ok(c.put(base+'/parts/settings',json={'enabled':True}))
 # Order members inside A, then move back to the original relative order.
 def ids(kind,part):
  key='user_id' if kind=='members' else 'project_id'
  return [row[key] for row in ok(c.get(base+'/parts/'+kind,headers={**h,'X-Wia-Part':b})) if row['part_id']==part]
 def place(kind,item,part,expected,before=None,status=200):
  return ok(c.put(base+'/parts/'+kind+'/'+item,headers=h,json={'part_id':part,'expected_part_id':expected,'before_id':before}),status)
 assert ids('members',a)==[resident,uid]
 place('members',uid,a,a,resident);assert ids('members',a)==[uid,resident]
 place('members',uid,a,a);assert ids('members',a)==[resident,uid]
 place('members',uid,a,a,'missing',409);assert ids('members',a)==[resident,uid]
 projects=[]
 for i in range(3):
  projects.append(ok(c.post(base+'/team-projects',headers={**h,'X-Wia-Part':a},json={'project_name':'과제 '+str(i),'members':[{'user_id':uid,'role':'L'}]}),201)['project_id'])
 p,q,r=projects
 assert ids('projects',a)==projects
 board=ok(c.get(base+'/parts/projects'))
 assert next(x for x in board if x['project_id']==p)['leader_name']=='이동 멤버'
 assert all(set(x)=={'project_id','project_name','part_id','leader_name'} for x in board)
 milestone=ok(c.post('/api/projects/'+p+'/milestones',headers={**h,'X-Wia-Part':a},json={'title':'Milestone','start_date':'2026-09-14','end_date':'2026-09-18'}),201)['id']
 epic=ok(c.post('/api/milestones/'+milestone+'/epics',headers={**h,'X-Wia-Part':a},json={'title':'Work','start_date':'2026-09-14','end_date':'2026-09-18','owner':'Owner','status':'planned','color':'#123456'}),201)
 with m.get_conn() as conn:
  history={table:[tuple(row) for row in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')] for table in ['project_members','milestones','epics','report_entries','project_entry','project_progress','project_issue','project_plan']}
  old_project=dict(conn.execute('SELECT * FROM project WHERE project_id=?',(p,)).fetchone())
 place('projects',r,a,a,p);assert ids('projects',a)==[r,p,q]
 place('projects',r,a,a);assert ids('projects',a)==[p,q,r]
 place('projects',q,a,a,p);assert ids('projects',a)==[q,p,r]
 assert [x['project_id'] for x in ok(c.get(base+'/team-projects',headers={**h,'X-Wia-Part':a}))]==[q,p,r]
 assert [x['project_id'] for x in ok(c.get(base+'/timeline-projects',headers={**h,'X-Wia-Part':a}))]==[q,p,r]
 place('projects',p,b,a);assert ids('projects',b)==[p]
 # Moving a project must not make a normal edit lose or reject its existing leader.
 ok(c.put('/api/team-projects/'+p,headers={**h,'X-Wia-Part':b},json={'project_name':'과제 0','members':[{'user_id':uid,'role':'L'}]}))
 ok(c.put('/api/team-projects/'+p+'/members',headers={**h,'X-Wia-Part':b},json={'members':[{'user_id':uid,'role':'L'}]}))
 ok(c.put('/api/team-projects/'+p+'/members',headers={**h,'X-Wia-Part':b},json={'members':[{'user_id':uid,'role':'L'},{'user_id':resident,'role':'M'}]}),422)

 ok(c.get('/api/projects/'+p+'/milestones',headers={**h,'X-Wia-Part':a}),404)
 assert ok(c.get('/api/projects/'+p+'/milestones',headers={**h,'X-Wia-Part':b}))[0]['id']==milestone
 place('projects',q,b,a,p);assert ids('projects',b)==[q,p]
 place('projects',p,None,b)
 assert p in ids('projects',None)
 place('projects',p,a,None,r);assert ids('projects',a)==[p,r]
 place('projects',p,b,None,status=409)
 place('projects',p,foreign,a,status=404)
 place('projects',p,a,a,'missing',409)
 ok(c.put('/api/teams/'+other+'/parts/projects/'+p,json={'part_id':foreign,'expected_part_id':a}),404)
 with m.get_conn() as conn:
  for table,rows in history.items(): assert sorted(rows)==sorted(tuple(row) for row in conn.execute('SELECT * FROM '+table+' ORDER BY rowid')),table
  new_project=dict(conn.execute('SELECT * FROM project WHERE project_id=?',(p,)).fetchone())
  assert all(v==new_project[k] for k,v in old_project.items() if k not in ['part_id','sort_order'])
  order_before=[tuple(row) for row in conn.execute('SELECT project_id,sort_order FROM project ORDER BY project_id')]
  m.part_support.init_parts(conn)
  assert order_before==[tuple(row) for row in conn.execute('SELECT project_id,sort_order FROM project ORDER BY project_id')]
  assert not conn.execute('PRAGMA foreign_key_check').fetchall()
 ok(c.put(base+'/parts/settings',json={'enabled':False}))
 place('projects',p,None,a,status=409)
 print('PASS: project moves, leader, member/project ordering, inherited scope, exact history, invalid targets, migration idempotency')
'''
class ProjectMoves(unittest.TestCase):
 def test_allocation_and_order(self):
  result=subprocess.run([sys.executable,'-W','ignore::DeprecationWarning','-c',SCENARIO],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=60)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr)
