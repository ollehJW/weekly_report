"""Authenticated fixtures for existing disposable-database integration scenarios."""
from datetime import datetime
from fastapi.testclient import TestClient as BaseTestClient

TEST_PASSWORD = 'Regression-fixture-password!2026'


class TestClient(BaseTestClient):
    def __init__(self, app, **kwargs):
        from backend import main as m
        with m.get_conn() as conn:
            conn.execute("INSERT OR IGNORE INTO teams(team_id,department,login_id,password_hash,account_role,must_change_password,created_at) VALUES('regression-admin','Test','regression-admin',?,'admin',0,?)", (m.hash_password(TEST_PASSWORD), datetime.utcnow().isoformat()))
        super().__init__(app, **kwargs)
        response = super().post('/api/auth/login', json={'login_id':'regression-admin','password':TEST_PASSWORD})
        assert response.status_code == 200, response.text
        self.headers['Authorization'] = 'Bearer ' + response.json()['session_id']

    def post(self, url, **kwargs):
        response = super().post(url, **kwargs)
        if response.status_code == 201 and str(url).startswith('/api/teams/') and str(url).endswith('/users'):
            member = response.json()
            password_response = self.put('/api/users/'+member['user_id']+'/password', json={'password':TEST_PASSWORD}, headers=kwargs.get('headers'))
            assert password_response.status_code == 200, password_response.text
        return response
