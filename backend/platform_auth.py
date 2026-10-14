"""AX session identity and non-credential team membership projections."""
import hashlib, time, uuid
from datetime import datetime, timezone
from fastapi import HTTPException
from .database import connect, actor, configuration

COOKIE = 'ax_platform_session'


def sync_members(db, team):
    """Never claim legacy records by name at login: migration owns that mapping."""
    db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('wiareport:team:' + team['team_id'],))
    db.execute('UPDATE members SET is_active=0 WHERE team_id=%s', (team['team_id'],))
    db.execute('''INSERT INTO members(user_id,team_id,platform_user_id,name,role,is_active,sort_order,created_at)
        SELECT md5('wiareport:' || %s || ':' || u.user_id),%s,u.user_id,u.full_name,
          CASE WHEN r.name LIKE '%%책임%%' THEN 'CM' ELSE 'M' END,1,0,u.created_at::text
        FROM platform.users u LEFT JOIN platform.roles r ON r.role_id=u.role_id
        WHERE u.team_id=%s AND u.is_active=TRUE
        ON CONFLICT(team_id,platform_user_id) DO UPDATE SET name=excluded.name,is_active=1''',
        (team['team_id'], team['team_id'], team['platform_team_id']))


def resolve(token):
    if not token or len(token) > 256: raise HTTPException(401, '통합 로그인이 필요합니다.')
    with connect() as db:
        user = db.execute('''SELECT u.user_id,u.employee_id,u.full_name,u.team_id,u.is_admin,u.must_change_password,
            t.name AS team_name FROM platform.sessions s JOIN platform.users u ON u.user_id=s.user_id
            LEFT JOIN platform.teams t ON t.team_id=u.team_id
            WHERE s.token_hash=%s AND s.expires_at>%s AND u.is_active=TRUE''',
            (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if not user or user['must_change_password']: raise HTTPException(401, '플랫폼에서 로그인과 비밀번호 설정을 완료해 주세요.')
        valid_team = user['team_name'] and user['team_name'].strip() not in ('', '미지정')
        if not valid_team and not user['is_admin']:
            raise HTTPException(403, {'code':'profile_required','message':'통합 계정에서 소속 팀을 등록해 주세요.'})
        team = None; member = None
        if valid_team:
            db.execute('''INSERT INTO teams(team_id,platform_team_id,department,created_at)
                VALUES(%s,%s,%s,%s) ON CONFLICT(platform_team_id) DO UPDATE SET department=excluded.department''',
                (uuid.uuid5(uuid.NAMESPACE_URL,'wiareport:team:'+user['team_id']).hex, user['team_id'], user['team_name'], datetime.now(timezone.utc).isoformat()))
            team = db.execute('SELECT * FROM teams WHERE platform_team_id=%s',(user['team_id'],)).fetchone()
            sync_members(db, team)
            member = db.execute('SELECT user_id,part_id FROM members WHERE team_id=%s AND platform_user_id=%s AND is_active=1', (team['team_id'],user['user_id'])).fetchone()
        db.execute('''INSERT INTO user_activity(platform_user_id,team_id,last_seen_at) VALUES(%s,%s,now())
            ON CONFLICT(platform_user_id) DO UPDATE SET team_id=excluded.team_id,last_seen_at=excluded.last_seen_at''',
            (user['user_id'],team['team_id'] if team else None))
        return {**(dict(team) if team else {'team_id':None,'department':'관리자'}),
            'actor_user_id':user['user_id'], 'member_id':member['user_id'] if member else None,
            'member_part_id':member['part_id'] if member else None,
            'full_name':user['full_name'],'login_id':user['employee_id'],
            'account_role':'admin' if user['is_admin'] else 'user', 'must_change_password':False}


def require_actor(admin_only=False, team_id=None):
    who = actor.get()
    if not who: raise HTTPException(401, '통합 로그인이 필요합니다.')
    if admin_only and who['account_role'] != 'admin': raise HTTPException(403, '관리자 권한이 필요합니다.')
    if team_id and who['team_id'] != team_id and who['account_role'] != 'admin': raise HTTPException(403, '다른 팀에 접근할 권한이 없습니다.')
    return who


def require_owner(conn, user_id):
    who = require_actor()
    member = conn.execute('SELECT * FROM members WHERE user_id=?', (user_id,)).fetchone()
    if not member or member['platform_user_id'] != who['actor_user_id'] or member['team_id'] != who['team_id'] or not member['is_active']:
        raise HTTPException(403, '본인의 주간보고만 작성할 수 있습니다.')
    return member
