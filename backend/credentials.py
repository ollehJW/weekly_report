"""Credential issuance and authorization for account lifecycle operations."""
from datetime import datetime, timedelta, timezone
import secrets

from fastapi import HTTPException

TEMPORARY_PASSWORD_TTL_HOURS = 24
INITIAL_PASSWORD = "wia1234!"


def utc_now():
    return datetime.now(timezone.utc)


def is_initial_password(password):
    return secrets.compare_digest(password.encode(), INITIAL_PASSWORD.encode())


def new_initial_password():
    """Business-required initial credential for newly created teams and members."""
    return INITIAL_PASSWORD, (utc_now() + timedelta(hours=TEMPORARY_PASSWORD_TTL_HOURS)).isoformat()


def new_temporary_password():
    return secrets.token_urlsafe(24), (utc_now() + timedelta(hours=TEMPORARY_PASSWORD_TTL_HOURS)).isoformat()


def validate_new_password(password, current_password=None):
    if len(password) < 12 or len(password) > 200 or not password.strip():
        raise HTTPException(422, "새 비밀번호는 12자 이상 200자 이하로 입력하세요.")
    if is_initial_password(password) or (current_password is not None and secrets.compare_digest(password.encode(), current_password.encode())):
        raise HTTPException(422, "기존 비밀번호와 다른 새 비밀번호를 입력하세요.")


def check_temporary_password(row):
    if not row['must_change_password']:
        return
    expiry = row['password_expires_at']
    try:
        expired = not expiry or datetime.fromisoformat(expiry) <= utc_now()
    except (ValueError, TypeError):
        expired = True
    if expired:
        raise HTTPException(401, "임시 비밀번호가 만료되었습니다. 관리자에게 재발급을 요청하세요.")


def init_schema(conn):
    for table in ('teams', 'users'):
        columns = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
        if 'password_expires_at' not in columns:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN password_expires_at TEXT')


def require_manager(conn, authorization, team_id=None, admin_only=False):
    if not isinstance(authorization, str) or not authorization.startswith('Bearer '):
        raise HTTPException(401, "다시 로그인하세요.")
    session_id = authorization[7:].strip()
    row = conn.execute('''
        SELECT t.*, s.login_at FROM login_sessions s JOIN teams t ON t.team_id=s.team_id
        WHERE s.session_id=? AND s.ended_at=''
    ''', (session_id,)).fetchone()
    if not row:
        raise HTTPException(401, "다시 로그인하세요.")
    try:
        issued = datetime.fromisoformat(row['login_at'])
        if issued.tzinfo is None:
            issued = issued.replace(tzinfo=timezone.utc)
        if utc_now() - issued > timedelta(hours=24):
            raise HTTPException(401, "로그인이 만료되었습니다. 다시 로그인하세요.")
    except (ValueError, TypeError):
        raise HTTPException(401, "다시 로그인하세요.")
    if row['must_change_password']:
        raise HTTPException(403, "비밀번호를 변경한 뒤 다시 로그인하세요.")
    admin = row['account_role'] == 'admin'
    if admin_only and not admin:
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    if team_id and row['team_id'] != team_id and not admin:
        raise HTTPException(403, "다른 팀의 비밀번호를 관리할 수 없습니다.")
    return row


def close_team_sessions(conn, team_id):
    conn.execute("UPDATE login_sessions SET ended_at=? WHERE team_id=? AND ended_at=''", (datetime.utcnow().isoformat(), team_id))
