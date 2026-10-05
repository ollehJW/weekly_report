"""Credential lifecycle integration checks; uses only a disposable database."""
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_work = tempfile.TemporaryDirectory(prefix='wiareport-credential-tests-')
os.environ['WIAREPORT_DATA_DIR'] = _work.name
from backend import main as m
from fastapi.testclient import TestClient

TEST_PASSWORD = 'Audit-only-account-password!2026'
CHANGED_PASSWORD = 'Different-audit-password!2026'


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=_work.name)
        self.addCleanup(self.tmp.cleanup)
        m.DB_PATH = Path(self.tmp.name) / 'app.db'
        m.init_db()
        with m.get_conn() as conn:
            conn.execute("INSERT INTO teams(team_id,department,login_id,password_hash,account_role,must_change_password,created_at) VALUES('audit-admin','Audit','audit-admin',?,'admin',0,?)", (m.hash_password(TEST_PASSWORD), datetime.utcnow().isoformat()))
        self.client = TestClient(m.app)
        self.addCleanup(self.client.close)
        self.admin = self.ok(self.client.post('/api/auth/login', json={'login_id':'audit-admin','password':TEST_PASSWORD}))
        self.client.headers['Authorization'] = 'Bearer ' + self.admin['session_id']

    def ok(self, response, status=200):
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def team(self, login='team-a'):
        return self.ok(self.client.post('/api/teams', json={'department':'Audit team','login_id':login}),201)

    def activate(self, team, password=TEST_PASSWORD):
        return self.ok(self.client.post('/api/auth/login', json={'login_id':team['login_id'],'password':m.credential_security.INITIAL_PASSWORD,'new_password':password}))

    def member(self, team):
        return self.ok(self.client.post('/api/teams/'+team['team_id']+'/users', json={'name':'Audit member','role':'M'}),201)

    def test_initial_credential_is_fixed_authorized_and_not_public(self):
        denied = self.client.post('/api/teams',headers={'Authorization':''},json={'department':'x','login_id':'x'})
        self.assertEqual(denied.status_code,401)
        a,b=self.team(),self.team('team-b')
        self.assertNotIn('temporary_password', a)
        self.assertNotIn('temporary_password', b)
        with m.get_conn() as conn:
            hashes = [row[0] for row in conn.execute("SELECT password_hash FROM teams WHERE team_id IN (?, ?)", (a['team_id'], b['team_id']))]
        self.assertEqual(len(set(hashes)), 2)
        self.assertTrue(all(value != 'wia1234!' and m.verify_password('wia1234!', value) for value in hashes))
        expiry=datetime.fromisoformat(a['password_expires_at'])
        self.assertGreater(expiry,datetime.now(timezone.utc)+timedelta(hours=23))
        response=self.client.get('/api/teams')
        self.assertEqual(response.headers['cache-control'],'no-store')
        for row in response.json():
            self.assertNotIn('password_hash',row)
            self.assertNotIn('temporary_password',row)
        self.assertNotIn(m.credential_security.INITIAL_PASSWORD,response.text)
        session=self.activate(a)
        denied=self.client.post('/api/teams',headers={'Authorization':'Bearer '+session['session_id']},json={'department':'x','login_id':'x'})
        self.assertEqual(denied.status_code,403)

    def test_team_directory_requires_active_admin_session(self):
        a = self.team()
        session = self.activate(a)
        for path in ('/api/teams', '/api/teams/', '/api/teams?probe=1'):
            response = self.client.get(path, headers={'Authorization': ''}, follow_redirects=False)
            self.assertEqual(response.status_code, 401)
        for header in ('', 'Bearer invalid-session', 'Basic invalid', 'Bearer ' + a['team_id']):
            response = self.client.get('/api/teams', headers={'Authorization': header})
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertNotIn(a['team_id'], response.text)
            self.assertNotIn(a['login_id'], response.text)
        response = self.client.get('/api/teams', headers={'Authorization': 'Bearer ' + session['session_id']})
        self.assertEqual(response.status_code, 403)
        rows = self.ok(self.client.get('/api/teams'))
        self.assertTrue(any(row['team_id'] == a['team_id'] for row in rows))
        fields = {'team_id', 'department', 'login_id', 'account_role', 'must_change_password', 'created_at'}
        self.assertTrue(all(set(row) == fields for row in rows))
        self.ok(self.client.post('/api/auth/logout', json={'session_id': self.admin['session_id']}))
        self.assertEqual(self.client.get('/api/teams').status_code, 401)

    def test_expired_admin_cannot_read_team_directory(self):
        with m.get_conn() as conn:
            conn.execute("UPDATE login_sessions SET login_at=? WHERE session_id=?",
                         ((datetime.now(timezone.utc)-timedelta(hours=25)).isoformat(), self.admin['session_id']))
        self.assertEqual(self.client.get('/api/teams').status_code, 401)

    def test_team_activation_requires_change_and_consumes_temp(self):
        a=self.team();payload={'login_id':a['login_id'],'password':m.credential_security.INITIAL_PASSWORD}
        self.assertEqual(self.client.post('/api/auth/login',json=payload).status_code,428)
        with m.get_conn() as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM login_sessions WHERE team_id=?',(a['team_id'],)).fetchone()[0],0)
        self.assertEqual(self.client.post('/api/auth/login',json={**payload,'new_password':m.credential_security.INITIAL_PASSWORD}).status_code,422)
        self.assertEqual(self.client.post('/api/auth/login',json={**payload,'new_password':'short'}).status_code,422)
        m.init_db()  # Initial credentials survive normal schema initialization.
        session=self.activate(a)
        self.assertFalse(session['must_change_password'])
        self.assertIsNone(session['password_expires_at'])
        self.assertEqual(self.client.post('/api/auth/login',json=payload).status_code,401)
        self.ok(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':TEST_PASSWORD}))

    def test_expired_temp_rejected_and_reissue_revokes_sessions(self):
        a=self.team();session=self.activate(a)
        response=self.client.put('/api/teams/'+a['team_id']+'/password/reset')
        reset=self.ok(response)
        self.assertEqual(response.headers['cache-control'],'no-store')
        self.assertNotIn('temporary_password', reset)
        self.assertEqual(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':'wia1234!'}).status_code,428)
        self.assertEqual(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':TEST_PASSWORD}).status_code,401)
        with m.get_conn() as conn:
            self.assertTrue(conn.execute('SELECT ended_at FROM login_sessions WHERE session_id=?',(session['session_id'],)).fetchone()[0])
            conn.execute("UPDATE teams SET password_expires_at=? WHERE team_id=?",((datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat(),a['team_id']))
        self.assertEqual(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':m.credential_security.INITIAL_PASSWORD,'new_password':CHANGED_PASSWORD}).status_code,401)
        self.assertEqual(self.client.put('/api/teams/audit-admin/password/reset').status_code,409)

    def test_member_password_operations_enforce_team_ownership(self):
        a,b=self.team(),self.team('team-b');member=self.member(a);session=self.activate(b)
        url='/api/users/'+member['user_id']+'/password'
        for suffix,body in [('',{'password':TEST_PASSWORD}),('/reset',None)]:
            self.assertEqual(self.client.put(url+suffix,headers={'Authorization':''},json=body).status_code,401)
            self.assertEqual(self.client.put(url+suffix,headers={'Authorization':'Bearer '+session['session_id']},json=body).status_code,403)
        self.assertEqual(self.client.put(url,json={'password':'short'}).status_code,422)
        changed=self.ok(self.client.put(url,json={'password':TEST_PASSWORD}))
        self.assertFalse(changed['must_change_password'])
        reset=self.ok(self.client.put(url+'/reset'))
        self.assertTrue(reset['must_change_password'])
        self.assertNotIn('temporary_password', reset)
        with m.get_conn() as conn:
            row=conn.execute('SELECT password_hash FROM users WHERE user_id=?',(member['user_id'],)).fetchone()
        self.assertTrue(m.verify_password('wia1234!',row['password_hash']))
        self.assertFalse(m.verify_password(TEST_PASSWORD,row['password_hash']))

    def test_member_activation_changes_before_report_access(self):
        a=self.team();member=self.member(a)
        self.assertNotIn('temporary_password', member)
        report=self.ok(self.client.post('/api/teams/'+a['team_id']+'/reports',json={'start_date':'2026-09-21','end_date':'2026-09-27'}),201)
        url='/api/reports/'+report['report_id']+'/users/'+member['user_id']+'/authorize'
        payload={'password':m.credential_security.INITIAL_PASSWORD}
        self.assertEqual(self.client.post(url,json=payload).status_code,428)
        result=self.ok(self.client.post(url,json={**payload,'new_password':TEST_PASSWORD}))
        self.assertIn('projects',result)
        self.assertEqual(self.client.post(url,json=payload).status_code,401)
        self.ok(self.client.post(url,json={'password':TEST_PASSWORD}))

    def test_password_change_validates_current_session_and_revokes_others(self):
        a=self.team();first=self.activate(a)
        second=self.ok(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':TEST_PASSWORD}))
        payload={'team_id':a['team_id'],'current_password':TEST_PASSWORD,'new_password':'한글비밀번호도사용가능합니다2026!'}
        self.assertEqual(self.client.post('/api/auth/change-password',json=payload).status_code,403)
        self.ok(self.client.post('/api/auth/change-password',headers={'Authorization':'Bearer '+first['session_id']},json=payload))
        with m.get_conn() as conn:
            self.assertTrue(conn.execute('SELECT ended_at FROM login_sessions WHERE session_id=?',(second['session_id'],)).fetchone()[0])
        self.ok(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':payload['new_password']}))

    def test_schema_idempotent_and_legacy_pending_requires_reissue(self):
        m.init_db()
        a=self.team()
        with m.get_conn() as conn:
            conn.execute('UPDATE teams SET password_expires_at=NULL WHERE team_id=?',(a['team_id'],))
        self.assertEqual(self.client.post('/api/auth/login',json={'login_id':a['login_id'],'password':m.credential_security.INITIAL_PASSWORD}).status_code,401)


    def test_report_workspace_requires_uuid_and_rejects_symlinks(self):
        from unittest.mock import patch
        from fastapi import HTTPException
        team=self.team()
        report=self.ok(self.client.post('/api/teams/'+team['team_id']+'/reports',json={'start_date':'2026-09-21','end_date':'2026-09-27'}),201)
        with patch.object(m.shutil, 'rmtree') as remove:
            for value in ['..','../outside','/tmp/outside','not-a-uuid']:
                with self.assertRaises(HTTPException) as result:m.delete_report(value)
                self.assertEqual(result.exception.status_code,404)
            remove.assert_not_called()
            root=Path(self.tmp.name)/'workspace';root.mkdir();outside=Path(self.tmp.name)/'outside';outside.mkdir()
            marker=outside/'keep';marker.write_text('untouched')
            link=root/report['report_id'];link.symlink_to(outside,target_is_directory=True)
            with patch.object(m,'WORKSPACE_PATH',root):
                with self.assertRaises(HTTPException) as result:m.delete_report(report['report_id'])
                self.assertEqual(result.exception.status_code,409)
                remove.assert_not_called();self.assertEqual(marker.read_text(),'untouched')
                with m.get_conn() as conn:self.assertIsNotNone(conn.execute('SELECT report_id FROM reports WHERE report_id=?',(report['report_id'],)).fetchone())
                link.unlink()
                self.assertEqual(self.client.delete('/api/reports/'+report['report_id']).status_code,204)
                remove.assert_called_once_with(root/report['report_id'],ignore_errors=True)

if __name__=='__main__':
    unittest.main()
