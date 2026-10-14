"""Part configuration and request-scoped partition checks."""
from contextvars import ContextVar
from datetime import datetime
import psycopg
import uuid
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# (team_id, part_id, parts_enabled). A missing part means unassigned data.
scope = ContextVar("wia_part_scope", default=(None, None, False))

def visible(team_id, part_id):
    team, selected, enabled = scope.get()
    return int((not team or team == team_id) and (not enabled or part_id == selected))

def selected_part():
    return scope.get()[1] if scope.get()[2] else None


class PartsEnabledIn(BaseModel):
    enabled: bool

class PartIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)

class PartMemberMoveIn(BaseModel):
    part_id: str | None = Field(...)
    expected_part_id: str | None = Field(...)
    before_id: str | None = None


def install(app, get_conn, public_team):
    def resource(conn, kind, key):
        direct = {"users": ("members", "user_id"), "team-projects": ("project", "project_id"),
                  "projects": ("project", "project_id"), "team-events": ("team_events", "event_id"),
                  "reports": ("reports", "report_id")}
        if kind in direct:
            table, pk = direct[kind]
            return conn.execute(f"SELECT team_id, part_id FROM {table} WHERE {pk} = ?", (key,)).fetchone()
        joins = {
            "milestones": "SELECT p.team_id,p.part_id FROM milestones x JOIN project p ON p.project_id=x.project_id WHERE x.milestone_id=?",
            "epics": "SELECT p.team_id,p.part_id FROM epics x JOIN milestones m ON m.milestone_id=x.milestone_id JOIN project p ON p.project_id=m.project_id WHERE x.epic_id=?",
            "report-entries": "SELECT r.team_id,r.part_id FROM report_entries x JOIN reports r ON r.report_id=x.report_id WHERE x.entry_id=?",
            "project-progress": "SELECT p.team_id,p.part_id FROM project_progress x JOIN project p ON p.project_id=x.project_id WHERE x.progress_id=?",
            "project-issues": "SELECT p.team_id,p.part_id FROM project_issue x JOIN project p ON p.project_id=x.project_id WHERE x.issue_id=?",
        }
        return conn.execute(joins[kind], (key,)).fetchone() if kind in joins else None

    @app.middleware("http")
    async def part_scope_middleware(request, call_next):
        segments = request.url.path.strip("/").split("/")
        token = None
        try:
            if len(segments) >= 2 and segments[0] == "api":
                with get_conn() as conn:
                    actor = getattr(request.state, "actor", None)
                    # Client team/role hints never establish the authenticated identity.
                    if actor and actor['account_role'] != 'admin':
                        hinted = request.headers.get('x-wia-team')
                        if hinted and hinted != actor['team_id']:
                            return JSONResponse({"detail": "다른 팀에 접근할 권한이 없습니다."}, status_code=403)
                        owner = None
                        if segments[1] == 'teams' and len(segments) >= 3:
                            owner = segments[2]
                        elif len(segments) >= 3:
                            target = resource(conn, 'reports' if segments[1] == 'report-images' else segments[1], segments[2])
                            if target:
                                owner = target['team_id']
                            elif segments[1] == 'report-images':
                                return JSONResponse({"detail": "이미지를 찾을 수 없습니다."}, status_code=404)
                        if owner and owner != actor['team_id']:
                            return JSONResponse({"detail": "다른 팀에 접근할 권한이 없습니다."}, status_code=403)
                    row = None
                    team_id = (actor['team_id'] if actor and actor['account_role'] != 'admin' else request.headers.get("x-wia-team")) if segments[1] == "milestones" and len(segments) == 2 else None
                    if segments[1] == "teams" and len(segments) >= 4 and segments[3] in (
                        "users", "events", "team-projects", "timeline-projects", "reports", "report-schedule"
                    ):
                        team_id = segments[2]
                    elif len(segments) >= 3 and segments[1] not in ("teams", "auth", "admin", "report-images"):
                        row = resource(conn, segments[1], segments[2])
                        if row:
                            team_id = row["team_id"]
                    if team_id:
                        team = conn.execute("SELECT * FROM teams WHERE team_id=?", (team_id,)).fetchone()
                        if team:
                            header_team = request.headers.get("x-wia-team")
                            if header_team and header_team != team_id:
                                return JSONResponse({"detail": "선택한 팀의 데이터가 아닙니다."}, status_code=404)
                            enabled = bool(team["parts_enabled"])
                            part_id = request.headers.get("x-wia-part") or None
                            if enabled and part_id:
                                part = conn.execute("SELECT part_id FROM parts WHERE part_id=? AND team_id=?", (part_id, team_id)).fetchone()
                                if not part:
                                    return JSONResponse({"detail": "파트가 변경되었습니다. 파트를 다시 선택하세요."}, status_code=409)
                            if not enabled:
                                if part_id:
                                    return JSONResponse({"detail": "파트 사용이 꺼졌습니다. 새로고침 후 팀 전체로 이동하세요."}, status_code=409)
                                part_id = None
                            token = scope.set((team_id, part_id, enabled))
                            if row and not visible(row["team_id"], row["part_id"]):
                                return JSONResponse({"detail": "선택한 파트의 데이터가 아닙니다."}, status_code=404)
                            # Validate nested resources too, e.g. report/user and entry/project URLs.
                            for i in range(3, len(segments) - 1, 2):
                                nested = resource(conn, segments[i], segments[i + 1])
                                if nested and not visible(nested["team_id"], nested["part_id"]):
                                    linked = False
                                    if nested["team_id"] == team_id:
                                        # Reports created while parts were off retain their original participants.
                                        if segments[1] == "reports" and segments[i] == "users":
                                            linked = bool(conn.execute("SELECT 1 FROM report_entries WHERE report_id=? AND user_id=?", (segments[2], segments[i + 1])).fetchone())
                                        elif segments[1] == "reports" and segments[i] == "projects":
                                            linked = bool(conn.execute("SELECT 1 FROM report_entries re JOIN project_entry pe ON pe.entry_id=re.entry_id WHERE re.report_id=? AND pe.project_id=?", (segments[2], segments[i + 1])).fetchone())
                                        elif segments[1] == "report-entries" and segments[i] == "projects":
                                            linked = bool(conn.execute("SELECT 1 FROM project_entry WHERE entry_id=? AND project_id=?", (segments[2], segments[i + 1])).fetchone())
                                    if not linked:
                                        return JSONResponse({"detail": "다른 파트의 항목은 사용할 수 없습니다."}, status_code=404)
            return await call_next(request)
        finally:
            if token is not None:
                scope.reset(token)

    @app.get("/api/teams/{team_id}/parts")
    def list_parts(team_id: str):
        with get_conn() as conn:
            team = conn.execute("SELECT * FROM teams WHERE team_id=?", (team_id,)).fetchone()
            if not team:
                raise HTTPException(404, "Team not found")
            rows = conn.execute("SELECT part_id,name,created_at FROM parts WHERE team_id=? ORDER BY created_at,part_id", (team_id,)).fetchall()
            return {"enabled": bool(team["parts_enabled"]), "parts": [dict(r) for r in rows]}

    def check_board_team(conn, team_id, request):
        header_team = request.headers.get("x-wia-team")
        if header_team and header_team != team_id:
            raise HTTPException(404, "선택한 팀의 데이터가 아닙니다.")
        team = conn.execute("SELECT * FROM teams WHERE team_id=?", (team_id,)).fetchone()
        if not team:
            raise HTTPException(404, "Team not found")
        return team

    def board_members(conn, team_id):
        return [dict(row) for row in conn.execute(
            "SELECT user_id,name,role,part_id FROM members WHERE team_id=? AND is_active=1 ORDER BY sort_order,created_at,name,user_id",
            (team_id,),
        )]

    def place_item(conn, table, key, team_id, item_id, part_id, before_id):
        label = "name" if table == "members" else "project_name"
        rows = conn.execute(f"SELECT {key} FROM {table} WHERE team_id=? AND part_id IS NOT DISTINCT FROM ? ORDER BY sort_order,created_at,{label},{key}", (team_id, part_id)).fetchall()
        ids = [row[0] for row in rows if row[0] != item_id]
        if before_id == item_id:
            return
        if before_id is not None and before_id not in ids:
            raise HTTPException(409, "목록이 변경되었습니다. 최신 목록에서 다시 이동하세요.")
        ids.insert(ids.index(before_id) if before_id is not None else len(ids), item_id)
        conn.execute(f"UPDATE {table} SET part_id=? WHERE {key}=? AND team_id=?", (part_id, item_id, team_id))
        for index, current in enumerate(ids):
            conn.execute(f"UPDATE {table} SET sort_order=? WHERE {key}=? AND team_id=?", (index, current, team_id))

    @app.get("/api/teams/{team_id}/parts/members")
    def list_part_members(team_id: str, request: Request):
        # The management board spans all parts, independent of the sidebar selection.
        with get_conn() as conn:
            check_board_team(conn, team_id, request)
            return board_members(conn, team_id)

    @app.put("/api/teams/{team_id}/parts/members/{user_id}")
    def move_part_member(team_id: str, user_id: str, payload: PartMemberMoveIn, request: Request):
        with get_conn() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
            team = check_board_team(conn, team_id, request)
            if not team["parts_enabled"]:
                raise HTTPException(409, "파트 사용이 꺼졌습니다. 새로고침 후 다시 시도하세요.")
            user = conn.execute("SELECT * FROM members WHERE team_id=? AND user_id=? AND is_active=1", (team_id, user_id)).fetchone()
            if not user:
                raise HTTPException(404, "팀에서 멤버를 찾을 수 없습니다.")
            if payload.part_id is not None and not conn.execute(
                "SELECT 1 FROM parts WHERE team_id=? AND part_id=?", (team_id, payload.part_id)
            ).fetchone():
                raise HTTPException(404, "이동할 파트를 찾을 수 없습니다.")
            if user["part_id"] != payload.expected_part_id:
                if user["part_id"] == payload.part_id:
                    return board_members(conn, team_id)
                raise HTTPException(409, "다른 곳에서 멤버의 파트가 변경되었습니다. 최신 목록에서 다시 이동하세요.")
            if payload.before_id == user_id and user["part_id"] != payload.part_id:
                raise HTTPException(409, "이동 위치가 올바르지 않습니다.")
            # Only affiliation and display order change; all assignment/history links survive.
            place_item(conn, "members", "user_id", team_id, user_id, payload.part_id, payload.before_id)
            return board_members(conn, team_id)

    def board_projects(conn, team_id):
        rows = conn.execute("""
            SELECT p.project_id,p.project_name,p.part_id,
                   COALESCE((SELECT string_agg(u.name, ', ' ORDER BY u.sort_order,u.name,u.user_id) FROM project_members pm JOIN members u ON u.user_id=pm.user_id WHERE pm.project_id=p.project_id AND pm.role='L' AND u.team_id=p.team_id), '') AS leader_name
            FROM project p WHERE p.team_id=? AND p.project_name != '기타 업무 (교육/출장 등)' ORDER BY p.sort_order,p.created_at,p.project_name,p.project_id
        """, (team_id,)).fetchall()
        return [dict(row) for row in rows]

    @app.get("/api/teams/{team_id}/parts/projects")
    def list_part_projects(team_id: str, request: Request):
        with get_conn() as conn:
            check_board_team(conn, team_id, request)
            return board_projects(conn, team_id)

    @app.put("/api/teams/{team_id}/parts/projects/{project_id}")
    def move_part_project(team_id: str, project_id: str, payload: PartMemberMoveIn, request: Request):
        with get_conn() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
            team = check_board_team(conn, team_id, request)
            if not team["parts_enabled"]:
                raise HTTPException(409, "파트 사용이 꺼졌습니다. 새로고침 후 다시 시도하세요.")
            project = conn.execute("SELECT * FROM project WHERE team_id=? AND project_id=?", (team_id, project_id)).fetchone()
            if not project:
                raise HTTPException(404, "팀에서 과제를 찾을 수 없습니다.")
            if payload.part_id is not None and not conn.execute(
                "SELECT 1 FROM parts WHERE team_id=? AND part_id=?", (team_id, payload.part_id)
            ).fetchone():
                raise HTTPException(404, "이동할 파트를 찾을 수 없습니다.")
            if project["project_name"] == "기타 업무 (교육/출장 등)":
                raise HTTPException(409, "자동 생성된 기타 업무는 과제 배정 대상이 아닙니다.")
            if project["part_id"] != payload.expected_part_id:
                if project["part_id"] == payload.part_id:
                    return board_projects(conn, team_id)
                raise HTTPException(409, "다른 곳에서 과제의 파트가 변경되었습니다. 최신 목록에서 다시 이동하세요.")
            if payload.before_id == project_id and project["part_id"] != payload.part_id:
                raise HTTPException(409, "이동 위치가 올바르지 않습니다.")
            place_item(conn, "project", "project_id", team_id, project_id, payload.part_id, payload.before_id)
            return board_projects(conn, team_id)

    @app.put("/api/teams/{team_id}/parts/settings")
    def set_parts_enabled(team_id: str, payload: PartsEnabledIn):
        with get_conn() as conn:
            if not conn.execute("SELECT team_id FROM teams WHERE team_id=?", (team_id,)).fetchone():
                raise HTTPException(404, "Team not found")
            conn.execute("UPDATE teams SET parts_enabled=? WHERE team_id=?", (int(payload.enabled), team_id))
        return list_parts(team_id)

    @app.post("/api/teams/{team_id}/parts", status_code=201)
    def create_part(team_id: str, payload: PartIn):
        name = payload.name.strip()
        if not name:
            raise HTTPException(422, "파트 이름을 입력하세요.")
        with get_conn() as conn:
            team = conn.execute("SELECT * FROM teams WHERE team_id=?", (team_id,)).fetchone()
            if not team:
                raise HTTPException(404, "Team not found")
            if not team["parts_enabled"]:
                raise HTTPException(409, "파트 사용을 먼저 켜주세요.")
            try:
                conn.execute("INSERT INTO parts(part_id,team_id,name,created_at) VALUES(?,?,?,?)",
                             (str(uuid.uuid4()), team_id, name, datetime.utcnow().isoformat()))
            except psycopg.IntegrityError:
                raise HTTPException(409, "같은 이름의 파트가 이미 있습니다.")
        return list_parts(team_id)

    @app.put("/api/teams/{team_id}/parts/{part_id}")
    def rename_part(team_id: str, part_id: str, payload: PartIn):
        name = payload.name.strip()
        if not name:
            raise HTTPException(422, "파트 이름을 입력하세요.")
        with get_conn() as conn:
            try:
                result = conn.execute("UPDATE parts SET name=? WHERE part_id=? AND team_id=?", (name, part_id, team_id))
            except psycopg.IntegrityError:
                raise HTTPException(409, "같은 이름의 파트가 이미 있습니다.")
            if not result.rowcount:
                raise HTTPException(404, "Part not found")
        return list_parts(team_id)

    @app.delete("/api/teams/{team_id}/parts/{part_id}", status_code=204)
    def delete_part(team_id: str, part_id: str):
        with get_conn() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
            if not conn.execute("SELECT part_id FROM parts WHERE part_id=? AND team_id=?", (part_id, team_id)).fetchone():
                raise HTTPException(404, "Part not found")
            for table in ("members", "project", "reports", "team_events"):
                if conn.execute(f"SELECT 1 FROM {table} WHERE part_id=? LIMIT 1", (part_id,)).fetchone():
                    raise HTTPException(409, "데이터가 있는 파트는 삭제할 수 없습니다. 파트 사용을 끄면 팀 전체로 볼 수 있습니다.")
            conn.execute("DELETE FROM parts WHERE part_id=?", (part_id,))
