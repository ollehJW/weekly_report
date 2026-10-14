"""Integration checks against an isolated migrated wiareport_test_* schema.
Never run against the live workspace. AX tokens expire in five minutes and are removed.
"""
import hashlib, os, secrets, time, unittest, uuid
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from backend.database import configuration, connect
from backend.main import app

class PlatformMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert configuration()['database']['schema'].startswith('wiareport_test_')
        cls.client=TestClient(app,raise_server_exceptions=True)
        cls.tokens=[]
        with connect() as db:
            cls.members=db.execute('''SELECT m.*,t.department FROM members m JOIN teams t USING(team_id)
                JOIN platform.users u ON u.user_id=m.platform_user_id
                WHERE m.is_active=1 AND u.is_admin=FALSE AND NOT u.must_change_password
                ORDER BY (t.department='DX추진랩') DESC,m.created_at''').fetchall()
            cls.me=cls.members[0]
            cls.peer=next(m for m in cls.members if m['team_id']==cls.me['team_id'] and m['user_id']!=cls.me['user_id'])
            cls.other=db.execute('SELECT team_id FROM teams WHERE team_id!=%s LIMIT 1',(cls.me['team_id'],)).fetchone()
            cls.admin=db.execute('SELECT user_id FROM platform.users WHERE is_admin=TRUE AND is_active=TRUE AND NOT must_change_password LIMIT 1').fetchone()
        cls.token=cls.issue(cls.me['platform_user_id'])
        cls.admin_token=cls.issue(cls.admin['user_id'])
    @classmethod
    def issue(cls,uid):
        token=secrets.token_urlsafe(32);h=hashlib.sha256(token.encode()).hexdigest();cls.tokens.append(h)
        with connect() as db:db.execute('INSERT INTO platform.sessions(token_hash,user_id,created_at,expires_at) VALUES(%s,%s,%s,%s)',(h,uid,datetime.now(timezone.utc),time.time()+300))
        return token
    @classmethod
    def tearDownClass(cls):
        with connect() as db:
            for token in cls.tokens:db.execute('DELETE FROM platform.sessions WHERE token_hash=%s',(token,))
        cls.client.close()
    def req(self,method,path,body=None,expected=200,token=None,headers=None):
        self.client.cookies.set('ax_platform_session',token or self.token)
        r=self.client.request(method,path,json=body,headers={'X-Wia-Request':'1',**(headers or {})})
        self.assertEqual(r.status_code,expected,(method,path,r.text[:1200]))
        return r.json() if r.content else None
    def test_01_identity_and_reads(self):
        who=self.req('GET','/api/auth/me');self.assertEqual(who['member_id'],self.me['user_id']);self.assertNotIn('password_hash',who)
        team=self.me['team_id']
        for suffix in ['users','parts','parts/members','parts/projects','team-projects','timeline-projects','events','reports/archive','reports/active-list','reports/completed','report-schedule']:
            self.req('GET',f'/api/teams/{team}/{suffix}')
        self.req('GET','/api/admin/overview',token=self.admin_token)
        self.req('GET',f'/api/teams/{self.other["team_id"]}/team-projects',expected=403)
        self.req('GET','/api/admin/overview',expected=403)
        self.req('POST','/api/auth/login',{'login_id':'admin','password':'obsolete'},expected=404)
        self.req('POST',f'/api/teams/{team}/users',{'name':'blocked','role':'M'},expected=405)
        self.client.cookies.clear()
        r=self.client.get('/api/auth/me',headers={'Authorization':'Bearer obsolete'});self.assertEqual(r.status_code,401)
    def test_02_projects_reports_and_permissions(self):
        team=self.me['team_id'];me=self.me['user_id'];peer=self.peer['user_id']
        project=self.req('POST',f'/api/teams/{team}/team-projects',{'project_name':'Migration integration '+uuid.uuid4().hex[:8],'members':[{'user_id':me,'role':'L'},{'user_id':peer,'role':'M'}]},expected=201)
        pid=project['project_id']
        all_projects=self.req('GET',f'/api/teams/{team}/timeline-projects?all_projects=true')
        mine=self.req('GET',f'/api/teams/{team}/timeline-projects')
        self.assertIn(pid,[p['id'] for p in mine]);self.assertGreaterEqual(len(all_projects),len(mine))
        self.req('PUT',f'/api/team-projects/{pid}/members',{'members':[{'user_id':peer,'role':'M'}]})
        self.assertNotIn(pid,[p['id'] for p in self.req('GET',f'/api/teams/{team}/timeline-projects')])
        self.assertIn(pid,[p['id'] for p in self.req('GET',f'/api/teams/{team}/timeline-projects?all_projects=true')])
        self.req('PUT',f'/api/team-projects/{pid}/members',{'members':[{'user_id':me,'role':'L'},{'user_id':peer,'role':'M'}]})
        milestone=self.req('POST',f'/api/projects/{pid}/milestones',{'title':'검증','start_date':'2099-01-01','end_date':'2099-01-07'},expected=201)
        mid=milestone['id'];self.req('GET',f'/api/milestones/{mid}')
        epic=self.req('POST',f'/api/milestones/{mid}/epics',{'title':'작업','start_date':'2099-01-01','end_date':'2099-01-02'},expected=201)
        self.req('PUT',f'/api/epics/{epic["id"]}',{'title':'작업 수정','start_date':'2099-01-01','end_date':'2099-01-03'})
        report=self.req('POST',f'/api/teams/{team}/reports',{'start_date':'2099-01-01','end_date':'2099-01-07'},expected=201);rid=report['report_id']
        self.req('POST',f'/api/reports/{rid}/users/{peer}/authorize',expected=403)
        own=self.req('POST',f'/api/reports/{rid}/users/{me}/authorize')
        with connect() as db:
            eid=db.execute('SELECT entry_id FROM report_entries WHERE report_id=%s AND user_id=%s',(rid,me)).fetchone()['entry_id']
            peid=db.execute('SELECT entry_id FROM report_entries WHERE report_id=%s AND user_id=%s',(rid,peer)).fetchone()['entry_id']
        content={'progress_log':[{'log':'이관 검증','status':'done','date':'2099-01-01'}],'risk_issue':[],'next_plan':[{'plan':'다음 단계','due':'2099-01-08'}]}
        self.req('PUT',f'/api/report-entries/{peid}/projects/{pid}',content,expected=403)
        self.req('PUT',f'/api/report-entries/{peid}/projects/{pid}/exclusion',{'is_excluded':True},expected=403)
        self.req('PUT',f'/api/report-entries/{peid}/project-order',{'project_ids':[],'expected_ids':[]},expected=403)
        self.req('PUT',f'/api/reports/{rid}/users/{peer}/absence',expected=403)
        self.req('PUT',f'/api/report-entries/{eid}/projects/{pid}',content)
        self.req('GET',f'/api/reports/{rid}/users/{me}/html-report')
        for suffix in ['progress-history','upcoming-next-plans','issue-management','weekly-reports']:
            self.req('GET',f'/api/projects/{pid}/{suffix}')
        self.req('GET',f'/api/reports/{rid}/projects/{pid}/html-report')
        self.req('PUT',f'/api/reports/{rid}/period',{'start_date':'2099-01-01','end_date':'2099-01-08','expected_start_date':'2099-01-01','expected_end_date':'2099-01-07'})
        self.req('DELETE',f'/api/reports/{rid}',expected=204)
        self.req('DELETE',f'/api/team-projects/{pid}',expected=204)
    def test_03_part_membership_and_csrf(self):
        team=self.me['team_id'];me=self.me['user_id']
        r=self.client.put(f'/api/teams/{team}/parts/settings',json={'enabled':True});self.assertEqual(r.status_code,403)
        self.req('PUT',f'/api/teams/{team}/parts/settings',{'enabled':True})
        parts=self.req('POST',f'/api/teams/{team}/parts',{'name':'검증 파트'},expected=201);pid=next(p['part_id'] for p in parts['parts'] if p['name']=='검증 파트')
        self.req('PUT',f'/api/teams/{team}/parts/members/{me}',{'part_id':pid,'expected_part_id':None})
        users=self.req('GET',f'/api/teams/{team}/users',headers={'X-Wia-Part':pid})
        self.assertEqual([u['user_id'] for u in users],[me])
        self.req('PUT',f'/api/teams/{team}/parts/members/{me}',{'part_id':None,'expected_part_id':pid})
        self.req('DELETE',f'/api/teams/{team}/parts/{pid}',expected=204)
        self.req('PUT',f'/api/teams/{team}/parts/settings',{'enabled':False})

if __name__=='__main__':unittest.main(verbosity=2)
