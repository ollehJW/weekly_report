"""Isolated PostgreSQL regression test; production report rows are never changed."""
import hashlib, os, secrets, time, unittest
from pathlib import Path
from datetime import datetime, timezone
import yaml
from fastapi.testclient import TestClient
from backend.database import configuration, connect

class ReportMembersTests(unittest.TestCase):
    def test_membership(self):
        original=configuration(); schema='wiareport_test_members_'+secrets.token_hex(4)
        cfg=Path('/tmp/'+schema+'.yaml'); cfg.write_text(yaml.safe_dump({**original,'database':{**original['database'],'schema':schema}}));cfg.chmod(0o600)
        token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
        with connect() as db:
            team=db.execute("SELECT * FROM teams WHERE department='DX추진랩' AND platform_team_id IS NOT NULL LIMIT 1").fetchone()
            user=db.execute('SELECT * FROM platform.users WHERE team_id=%s AND is_active AND NOT is_admin AND NOT must_change_password LIMIT 1',(team['platform_team_id'],)).fetchone()
            db.execute('INSERT INTO platform.sessions(token_hash,user_id,created_at,expires_at) VALUES(%s,%s,%s,%s)',(digest,user['user_id'],datetime.now(timezone.utc),time.time()+300))
            db.execute(Path('backend/schema.sql').read_text().replace('wiareport',schema))
        old=os.environ.get('WIAREPORT_DB_CONFIG');os.environ['WIAREPORT_DB_CONFIG']=str(cfg)
        try:
            from backend.main import app, init_db
            init_db()
            with connect() as db:db.execute('INSERT INTO teams(team_id,platform_team_id,department,created_at,report_schedule_enabled) VALUES(%s,%s,%s,%s,0)',(team['team_id'],team['platform_team_id'],team['department'],datetime.now().isoformat()))
            c=TestClient(app);c.cookies.set('ax_platform_session',token)
            def req(method,path,body=None,status=200):
                r=c.request(method,path,json=body,headers={'X-Wia-Request':'1'});self.assertEqual(r.status_code,status,r.text);return r.json()
            who=req('GET','/api/auth/me');url=f"/api/teams/{who['team_id']}/report-members"
            rows=req('GET',url);me=who['member_id'];peer=next(x['user_id'] for x in rows if x['user_id']!=me)
            report=req('POST',f"/api/teams/{who['team_id']}/reports",{'start_date':'2099-01-01','end_date':'2099-01-07'},201)
            payload={'enabled_ids':[me],'expected_enabled_ids':[x['user_id'] for x in rows],'expected_member_ids':[x['user_id'] for x in rows]}
            req('PUT',url,payload);req('PUT',url,payload,status=409)
            req('GET','/api/auth/me') # login synchronization must preserve selection
            self.assertEqual([x['user_id'] for x in req('GET',url) if x['report_enabled']],[me])
            active=req('GET',f"/api/teams/{who['team_id']}/reports/active-list")
            self.assertEqual([m['user_id'] for m in active[0]['members']],[me])
            req('PUT',f"/api/reports/{report['report_id']}/users/{me}/absence")
            req('PUT',f"/api/reports/{report['report_id']}/complete") # excluded pending entries do not block
            new=req('POST',f"/api/teams/{who['team_id']}/reports",{'start_date':'2099-01-08','end_date':'2099-01-14'},201)
            self.assertEqual([m['user_id'] for m in new['members']],[me])
            from backend.main import create_due_weekly_reports, KST
            now=datetime(2099,2,6,18,0,tzinfo=KST)
            with connect() as db:
                db.execute("UPDATE teams SET report_schedule_enabled=1,report_schedule_weekday=%s,report_schedule_time='17:00' WHERE team_id=%s",(now.weekday(),who['team_id']))
            scheduled=create_due_weekly_reports(now)
            self.assertEqual(len(scheduled),1)
            self.assertEqual(create_due_weekly_reports(now),[])
            with connect() as db:
                members=db.execute('SELECT user_id FROM report_entries WHERE report_id=%s',(scheduled[0],)).fetchall()
                self.assertEqual([m['user_id'] for m in members],[me])
            rows=req('GET',url);req('PUT',url,{'enabled_ids':[],'expected_enabled_ids':[me],'expected_member_ids':[x['user_id'] for x in rows]})
            req('POST',f"/api/reports/{new['report_id']}/users/{me}/authorize",status=403)
            req('GET','/api/teams/another-team/report-members',status=403)
            with connect() as db:
                self.assertTrue(db.execute('SELECT 1 FROM report_entries WHERE report_id=%s AND user_id=%s',(report['report_id'],peer)).fetchone())
            c.close()
        finally:
            if old is None:os.environ.pop('WIAREPORT_DB_CONFIG',None)
            else:os.environ['WIAREPORT_DB_CONFIG']=old
            with connect() as db:
                db.execute('DELETE FROM platform.sessions WHERE token_hash=%s',(digest,));db.execute('DROP SCHEMA '+schema+' CASCADE')
            cfg.unlink(missing_ok=True)

if __name__=='__main__':unittest.main(verbosity=2)
