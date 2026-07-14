from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
import hashlib
import secrets
import sqlite3
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


DB_PATH = Path(__file__).resolve().parent.parent / "app.db"
INITIAL_PASSWORD = "wia1234!"


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def row_to_dict(row):
    return dict(row) if row else None


def has_column(conn, table, column):
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def has_table(conn, table):
    row = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
    return row is not None


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, salt, digest = stored_hash.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    return secrets.compare_digest(hash_password(password, salt), stored_hash)


def public_team(row):
    data = row_to_dict(row)
    if not data:
        return None
    data.pop("password_hash", None)
    data["must_change_password"] = bool(data.get("must_change_password"))
    return data


def public_user(row):
    data = row_to_dict(row)
    if not data:
        return None
    data.pop("password_hash", None)
    data["must_change_password"] = bool(data.get("must_change_password"))
    return data


def init_db():
    with get_conn() as conn:
        if has_table(conn, "milestones") and not has_column(conn, "milestones", "milestone_id"):
            conn.execute("DROP TABLE IF EXISTS epics")
            conn.execute("DROP TABLE IF EXISTS milestones")
        if has_table(conn, "epics") and not has_column(conn, "epics", "epic_id"):
            conn.execute("DROP TABLE IF EXISTS epics")
        conn.execute("DROP TABLE IF EXISTS projects")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS teams (
                team_id TEXT PRIMARY KEY,
                department TEXT NOT NULL,
                login_id TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute("DROP TABLE IF EXISTS user_db")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project (
                project_id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                project_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'in_progress',
                created_at TEXT NOT NULL,
                FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS milestones (
                milestone_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS epics (
                epic_id TEXT PRIMARY KEY,
                milestone_id TEXT NOT NULL,
                title TEXT NOT NULL,
                owner TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'planned',
                color TEXT NOT NULL DEFAULT '#0ea5b7',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (milestone_id) REFERENCES milestones(milestone_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_members (
                project_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('L', 'M')),
                PRIMARY KEY (project_id, user_id),
                FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
            """
        )

        if not has_column(conn, "project", "status"):
            conn.execute("ALTER TABLE project ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress'")



@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="WiaReport API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:9602", "http://127.0.0.1:9602"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ProjectIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = ""


class MilestoneIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    description: str = ""
    start_date: date
    end_date: date


class EpicIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    owner: str = ""
    status: str = "planned"
    color: str = "#0ea5b7"
    start_date: date
    end_date: date


class TeamIn(BaseModel):
    department: str = Field(min_length=1, max_length=80)
    login_id: str = Field(min_length=1, max_length=80)


class LoginIn(BaseModel):
    login_id: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class PasswordChangeIn(BaseModel):
    team_id: str = Field(min_length=1)
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=200)


class MemberIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    role: str = Field(pattern="^(L|CM|M)$")


class MemberPasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ProjectMemberIn(BaseModel):
    user_id: str = Field(min_length=1)
    role: str = Field(pattern="^(L|M)$")


class TeamProjectIn(BaseModel):
    project_name: str = Field(min_length=1, max_length=120)
    status: str = Field(default="in_progress", pattern="^(in_progress|done)$")
    members: list[ProjectMemberIn] = Field(default_factory=list)


class TeamProjectStatusIn(BaseModel):
    status: str = Field(pattern="^(in_progress|done)$")


class ProjectMembersIn(BaseModel):
    members: list[ProjectMemberIn] = Field(default_factory=list)


def ensure_range(start_date: date, end_date: date):
    if end_date < start_date:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date")
    cursor = start_date
    while cursor <= end_date:
        if cursor.weekday() < 5:
            return
        cursor += timedelta(days=1)
    raise HTTPException(status_code=422, detail="date range must include at least one weekday")


def public_timeline_project(row):
    data = row_to_dict(row)
    if not data:
        return None
    data["id"] = data["project_id"]
    data["title"] = data["project_name"]
    data.setdefault("milestone_count", 0)
    data.setdefault("epic_count", 0)
    return data


def public_milestone(row, epics=None):
    data = row_to_dict(row)
    if not data:
        return None
    data["id"] = data["milestone_id"]
    if epics is not None:
        data["epics"] = epics
    return data


def public_epic(row):
    data = row_to_dict(row)
    if not data:
        return None
    data["id"] = data["epic_id"]
    return data


def ensure_team(conn, team_id: str):
    team = conn.execute("SELECT * FROM teams WHERE team_id = ?", (team_id,)).fetchone()
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


def ensure_team_project(conn, project_id: str):
    project = conn.execute("SELECT * FROM project WHERE project_id = ?", (project_id,)).fetchone()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def project_with_members(conn, project_row):
    data = row_to_dict(project_row)
    members = conn.execute(
        """
        SELECT pm.project_id, pm.user_id, pm.role AS project_role,
               u.name, u.role AS member_role, u.must_change_password
        FROM project_members pm
        JOIN users u ON u.user_id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY CASE pm.role WHEN 'L' THEN 0 ELSE 1 END, u.name
        """,
        (project_row["project_id"],),
    ).fetchall()
    data["members"] = [
        {
            "project_id": row["project_id"],
            "user_id": row["user_id"],
            "role": row["project_role"],
            "name": row["name"],
            "member_role": row["member_role"],
            "must_change_password": bool(row["must_change_password"]),
        }
        for row in members
    ]
    return data


def ensure_milestone(conn, milestone_id: str):
    milestone = conn.execute("SELECT * FROM milestones WHERE milestone_id = ?", (milestone_id,)).fetchone()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    return milestone


def ensure_epic_inside_milestone(conn, milestone_id: str, payload: EpicIn):
    milestone = ensure_milestone(conn, milestone_id)
    if str(payload.start_date) < milestone["start_date"] or str(payload.end_date) > milestone["end_date"]:
        raise HTTPException(status_code=422, detail="epic dates must stay inside the milestone range")
    return milestone


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/teams")
def list_teams():
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM teams
            ORDER BY created_at DESC, department, login_id
            """
        ).fetchall()
        return [public_team(row) for row in rows]


@app.post("/api/teams", status_code=201)
def create_team(payload: TeamIn):
    now = datetime.utcnow().isoformat()
    team_id = str(uuid.uuid4())
    login_id = payload.login_id.strip()
    with get_conn() as conn:
        existing = conn.execute("SELECT team_id FROM teams WHERE login_id = ?", (login_id,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="이미 사용 중인 ID입니다")
        cursor = conn.execute(
            """
            INSERT INTO teams (team_id, department, login_id, password_hash, must_change_password, created_at)
            VALUES (?, ?, ?, ?, 1, ?)
            """,
            (
                team_id,
                payload.department.strip(),
                login_id,
                hash_password(INITIAL_PASSWORD),
                now,
            ),
        )
        row = conn.execute("SELECT * FROM teams WHERE rowid = ?", (cursor.lastrowid,)).fetchone()
        return public_team(row)


@app.post("/api/auth/login")
def login(payload: LoginIn):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM teams WHERE login_id = ?", (payload.login_id.strip(),)).fetchone()
        if not row or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="ID 또는 비밀번호가 올바르지 않습니다")
        return public_team(row)


@app.post("/api/auth/change-password")
def change_password(payload: PasswordChangeIn):
    if payload.new_password == INITIAL_PASSWORD:
        raise HTTPException(status_code=422, detail="초기 비밀번호와 다른 비밀번호를 입력하세요")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM teams WHERE team_id = ?", (payload.team_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Team not found")
        if not verify_password(payload.current_password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="현재 비밀번호가 올바르지 않습니다")
        conn.execute(
            "UPDATE teams SET password_hash = ?, must_change_password = 0 WHERE team_id = ?",
            (hash_password(payload.new_password), payload.team_id),
        )
        updated = conn.execute("SELECT * FROM teams WHERE team_id = ?", (payload.team_id,)).fetchone()
        return public_team(updated)


@app.get("/api/teams/{team_id}/users")
def list_team_users(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM users
            WHERE team_id = ?
            ORDER BY created_at ASC, name
            """,
            (team_id,),
        ).fetchall()
        return [public_user(row) for row in rows]


@app.post("/api/teams/{team_id}/users", status_code=201)
def create_team_user(team_id: str, payload: MemberIn):
    now = datetime.utcnow().isoformat()
    user_id = str(uuid.uuid4())
    with get_conn() as conn:
        ensure_team(conn, team_id)
        cursor = conn.execute(
            """
            INSERT INTO users (user_id, team_id, name, role, password_hash, must_change_password, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?)
            """,
            (
                user_id,
                team_id,
                payload.name.strip(),
                payload.role,
                hash_password(INITIAL_PASSWORD),
                now,
            ),
        )
        row = conn.execute("SELECT * FROM users WHERE rowid = ?", (cursor.lastrowid,)).fetchone()
        return public_user(row)


@app.get("/api/teams/{team_id}/team-projects")
def list_team_projects(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM project
            WHERE team_id = ?
            ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, created_at DESC, project_name
            """,
            (team_id,),
        ).fetchall()
        return [project_with_members(conn, row) for row in rows]


@app.post("/api/teams/{team_id}/team-projects", status_code=201)
def create_team_project(team_id: str, payload: TeamProjectIn):
    now = datetime.utcnow().isoformat()
    project_id = str(uuid.uuid4())
    with get_conn() as conn:
        ensure_team(conn, team_id)
        if sum(1 for member in payload.members if member.role == "L") > 1:
            raise HTTPException(status_code=422, detail="과제 리더는 한 명만 지정할 수 있습니다")
        cursor = conn.execute(
            """
            INSERT INTO project (project_id, team_id, project_name, status, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (project_id, team_id, payload.project_name.strip(), payload.status, now),
        )
        for member in payload.members:
            user = conn.execute(
                "SELECT user_id FROM users WHERE user_id = ? AND team_id = ?",
                (member.user_id, team_id),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=422, detail="해당 팀의 멤버만 과제에 매칭할 수 있습니다")
            conn.execute(
                "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
                (project_id, member.user_id, member.role),
            )
        row = conn.execute("SELECT * FROM project WHERE rowid = ?", (cursor.lastrowid,)).fetchone()
        return project_with_members(conn, row)


@app.put("/api/team-projects/{project_id}/status")
def update_team_project_status(project_id: str, payload: TeamProjectStatusIn):
    with get_conn() as conn:
        ensure_team_project(conn, project_id)
        conn.execute("UPDATE project SET status = ? WHERE project_id = ?", (payload.status, project_id))
        row = conn.execute("SELECT * FROM project WHERE project_id = ?", (project_id,)).fetchone()
        return project_with_members(conn, row)


@app.put("/api/team-projects/{project_id}")
def update_team_project(project_id: str, payload: TeamProjectIn):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        if sum(1 for member in payload.members if member.role == "L") > 1:
            raise HTTPException(status_code=422, detail="과제 리더는 한 명만 지정할 수 있습니다")
        conn.execute(
            "UPDATE project SET project_name = ?, status = ? WHERE project_id = ?",
            (payload.project_name.strip(), payload.status, project_id),
        )
        conn.execute("DELETE FROM project_members WHERE project_id = ?", (project_id,))
        for member in payload.members:
            user = conn.execute(
                "SELECT user_id FROM users WHERE user_id = ? AND team_id = ?",
                (member.user_id, project["team_id"]),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=422, detail="해당 팀의 멤버만 과제에 매칭할 수 있습니다")
            conn.execute(
                "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
                (project_id, member.user_id, member.role),
            )
        row = conn.execute("SELECT * FROM project WHERE project_id = ?", (project_id,)).fetchone()
        return project_with_members(conn, row)


@app.put("/api/team-projects/{project_id}/members")
def set_team_project_members(project_id: str, payload: ProjectMembersIn):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        if sum(1 for member in payload.members if member.role == "L") > 1:
            raise HTTPException(status_code=422, detail="과제 리더는 한 명만 지정할 수 있습니다")
        normalized = {}
        for member in payload.members:
            user = conn.execute(
                "SELECT user_id FROM users WHERE user_id = ? AND team_id = ?",
                (member.user_id, project["team_id"]),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=422, detail="해당 팀의 멤버만 과제에 매칭할 수 있습니다")
            normalized[member.user_id] = member.role
        conn.execute("DELETE FROM project_members WHERE project_id = ?", (project_id,))
        conn.executemany(
            "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
            [(project_id, user_id, role) for user_id, role in normalized.items()],
        )
        row = conn.execute("SELECT * FROM project WHERE project_id = ?", (project_id,)).fetchone()
        return project_with_members(conn, row)


@app.delete("/api/team-projects/{project_id}", status_code=204)
def delete_team_project(project_id: str):
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM project WHERE project_id = ?", (project_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found")


@app.put("/api/users/{user_id}/password")
def set_user_password(user_id: str, payload: MemberPasswordIn):
    if payload.password == INITIAL_PASSWORD:
        must_change_password = 1
    else:
        must_change_password = 0
    with get_conn() as conn:
        existing = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="User not found")
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = ? WHERE user_id = ?",
            (hash_password(payload.password), must_change_password, user_id),
        )
        row = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return public_user(row)


@app.delete("/api/users/{user_id}", status_code=204)
def delete_user(user_id: str):
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found")


@app.get("/api/teams/{team_id}/timeline-projects")
def list_team_timeline_projects(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT p.*,
                COUNT(DISTINCT m.milestone_id) AS milestone_count,
                COUNT(e.epic_id) AS epic_count
            FROM project p
            LEFT JOIN milestones m ON m.project_id = p.project_id
            LEFT JOIN epics e ON e.milestone_id = m.milestone_id
            WHERE p.team_id = ? AND p.status = 'in_progress'
            GROUP BY p.project_id
            ORDER BY p.created_at DESC, p.project_name
            """,
            (team_id,),
        ).fetchall()
        return [public_timeline_project(row) for row in rows]


@app.get("/api/projects/{project_id}/milestones")
def list_project_milestones(project_id: str):
    with get_conn() as conn:
        ensure_team_project(conn, project_id)
        rows = conn.execute(
            """
            SELECT m.*,
                COUNT(e.epic_id) AS epic_count,
                MIN(e.start_date) AS first_epic_date,
                MAX(e.end_date) AS last_epic_date
            FROM milestones m
            LEFT JOIN epics e ON e.milestone_id = m.milestone_id
            WHERE m.project_id = ?
            GROUP BY m.milestone_id
            ORDER BY m.start_date, m.created_at
            """,
            (project_id,),
        ).fetchall()
        return [public_milestone(row) for row in rows]


@app.post("/api/projects/{project_id}/milestones", status_code=201)
def create_milestone(project_id: str, payload: MilestoneIn):
    ensure_range(payload.start_date, payload.end_date)
    now = datetime.utcnow().isoformat()
    milestone_id = str(uuid.uuid4())
    with get_conn() as conn:
        ensure_team_project(conn, project_id)
        conn.execute(
            """
            INSERT INTO milestones (milestone_id, project_id, title, start_date, end_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (milestone_id, project_id, payload.title, str(payload.start_date), str(payload.end_date), now),
        )
        row = conn.execute("SELECT * FROM milestones WHERE milestone_id = ?", (milestone_id,)).fetchone()
        return public_milestone(row)


@app.get("/api/milestones")
def list_milestones():
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT m.*,
                COUNT(e.epic_id) AS epic_count,
                MIN(e.start_date) AS first_epic_date,
                MAX(e.end_date) AS last_epic_date
            FROM milestones m
            LEFT JOIN epics e ON e.milestone_id = m.milestone_id
            GROUP BY m.milestone_id
            ORDER BY m.start_date, m.created_at
            """
        ).fetchall()
        return [public_milestone(row) for row in rows]


@app.get("/api/milestones/{milestone_id}")
def get_milestone(milestone_id: str):
    with get_conn() as conn:
        milestone = ensure_milestone(conn, milestone_id)
        epics = conn.execute(
            "SELECT * FROM epics WHERE milestone_id = ? ORDER BY start_date, created_at",
            (milestone_id,),
        ).fetchall()
        return public_milestone(milestone, [public_epic(row) for row in epics])


@app.put("/api/milestones/{milestone_id}")
def update_milestone(milestone_id: str, payload: MilestoneIn):
    ensure_range(payload.start_date, payload.end_date)
    with get_conn() as conn:
        ensure_milestone(conn, milestone_id)
        conn.execute(
            """
            UPDATE milestones
            SET title = ?, start_date = ?, end_date = ?
            WHERE milestone_id = ?
            """,
            (payload.title, str(payload.start_date), str(payload.end_date), milestone_id),
        )
    return get_milestone(milestone_id)


@app.delete("/api/milestones/{milestone_id}", status_code=204)
def delete_milestone(milestone_id: str):
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM milestones WHERE milestone_id = ?", (milestone_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Milestone not found")


@app.post("/api/milestones/{milestone_id}/epics", status_code=201)
def create_epic(milestone_id: str, payload: EpicIn):
    ensure_range(payload.start_date, payload.end_date)
    now = datetime.utcnow().isoformat()
    epic_id = str(uuid.uuid4())
    with get_conn() as conn:
        ensure_epic_inside_milestone(conn, milestone_id, payload)
        conn.execute(
            """
            INSERT INTO epics (epic_id, milestone_id, title, owner, status, color, start_date, end_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                epic_id,
                milestone_id,
                payload.title,
                payload.owner,
                payload.status,
                payload.color,
                str(payload.start_date),
                str(payload.end_date),
                now,
            ),
        )
        row = conn.execute("SELECT * FROM epics WHERE epic_id = ?", (epic_id,)).fetchone()
        return public_epic(row)


@app.put("/api/epics/{epic_id}")
def update_epic(epic_id: str, payload: EpicIn):
    ensure_range(payload.start_date, payload.end_date)
    with get_conn() as conn:
        existing = conn.execute("SELECT * FROM epics WHERE epic_id = ?", (epic_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Epic not found")
        ensure_epic_inside_milestone(conn, existing["milestone_id"], payload)
        conn.execute(
            """
            UPDATE epics
            SET title = ?, owner = ?, status = ?, color = ?, start_date = ?, end_date = ?
            WHERE epic_id = ?
            """,
            (
                payload.title,
                payload.owner,
                payload.status,
                payload.color,
                str(payload.start_date),
                str(payload.end_date),
                epic_id,
            ),
        )
        row = conn.execute("SELECT * FROM epics WHERE epic_id = ?", (epic_id,)).fetchone()
        return public_epic(row)


@app.delete("/api/epics/{epic_id}", status_code=204)
def delete_epic(epic_id: str):
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM epics WHERE epic_id = ?", (epic_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Epic not found")
