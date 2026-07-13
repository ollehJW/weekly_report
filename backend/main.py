from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
import sqlite3

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


DB_PATH = Path(__file__).resolve().parent.parent / "app.db"


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


def init_db():
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS milestones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS epics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                milestone_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                owner TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'planned',
                color TEXT NOT NULL DEFAULT '#0ea5b7',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE CASCADE
            )
            """
        )

        if not has_column(conn, "milestones", "project_id"):
            conn.execute("ALTER TABLE milestones ADD COLUMN project_id INTEGER")

        project_count = conn.execute("SELECT COUNT(*) AS count FROM projects").fetchone()["count"]
        now = datetime.utcnow().isoformat()
        if project_count == 0:
            cursor = conn.execute(
                "INSERT INTO projects (title, description, created_at) VALUES (?, ?, ?)",
                ("프로젝트 마일스톤 관리", "프로젝트 단위로 마일스톤과 Epic을 관리합니다.", now),
            )
            project_id = cursor.lastrowid
        else:
            project_id = conn.execute("SELECT id FROM projects ORDER BY id LIMIT 1").fetchone()["id"]

        conn.execute("UPDATE milestones SET project_id = ? WHERE project_id IS NULL", (project_id,))

        milestone_count = conn.execute("SELECT COUNT(*) AS count FROM milestones").fetchone()["count"]
        if milestone_count == 0:
            cursor = conn.execute(
                """
                INSERT INTO milestones (project_id, title, description, start_date, end_date, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    "백앤드 로직 개발",
                    "FastAPI 기반의 핵심 비즈니스 로직 개발 일정",
                    "2026-07-13",
                    "2026-07-31",
                    now,
                ),
            )
            milestone_id = cursor.lastrowid
            conn.executemany(
                """
                INSERT INTO epics
                    (milestone_id, title, owner, status, color, start_date, end_date, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (milestone_id, "A 로직 개발", "Backend", "in_progress", "#4f46e5", "2026-07-13", "2026-07-20", now),
                    (milestone_id, "B 로직 개발", "Backend", "planned", "#0ea5b7", "2026-07-17", "2026-07-27", now),
                    (milestone_id, "API 통합 테스트", "QA", "planned", "#d99a00", "2026-07-24", "2026-07-31", now),
                ],
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Project Milestone API", lifespan=lifespan)
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


def ensure_range(start_date: date, end_date: date):
    if end_date < start_date:
        raise HTTPException(status_code=422, detail="end_date must be on or after start_date")
    cursor = start_date
    while cursor <= end_date:
        if cursor.weekday() < 5:
            return
        cursor += timedelta(days=1)
    raise HTTPException(status_code=422, detail="date range must include at least one weekday")


def ensure_project(conn, project_id: int):
    project = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def ensure_epic_inside_milestone(conn, milestone_id: int, payload: EpicIn):
    milestone = conn.execute("SELECT * FROM milestones WHERE id = ?", (milestone_id,)).fetchone()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    if str(payload.start_date) < milestone["start_date"] or str(payload.end_date) > milestone["end_date"]:
        raise HTTPException(status_code=422, detail="epic dates must stay inside the milestone range")
    return milestone


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/projects")
def list_projects():
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT p.*,
                COUNT(DISTINCT m.id) AS milestone_count,
                COUNT(e.id) AS epic_count
            FROM projects p
            LEFT JOIN milestones m ON m.project_id = p.id
            LEFT JOIN epics e ON e.milestone_id = m.id
            GROUP BY p.id
            ORDER BY p.id
            """
        ).fetchall()
        return [row_to_dict(row) for row in rows]


@app.post("/api/projects", status_code=201)
def create_project(payload: ProjectIn):
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO projects (title, description, created_at) VALUES (?, ?, ?)",
            (payload.title, payload.description, now),
        )
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return row_to_dict(row)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: int):
    with get_conn() as conn:
        ensure_project(conn, project_id)
        milestone_ids = [row["id"] for row in conn.execute("SELECT id FROM milestones WHERE project_id = ?", (project_id,)).fetchall()]
        for milestone_id in milestone_ids:
            conn.execute("DELETE FROM epics WHERE milestone_id = ?", (milestone_id,))
        conn.execute("DELETE FROM milestones WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))


@app.get("/api/projects/{project_id}/milestones")
def list_project_milestones(project_id: int):
    with get_conn() as conn:
        ensure_project(conn, project_id)
        rows = conn.execute(
            """
            SELECT m.*,
                COUNT(e.id) AS epic_count,
                MIN(e.start_date) AS first_epic_date,
                MAX(e.end_date) AS last_epic_date
            FROM milestones m
            LEFT JOIN epics e ON e.milestone_id = m.id
            WHERE m.project_id = ?
            GROUP BY m.id
            ORDER BY m.start_date, m.id
            """,
            (project_id,),
        ).fetchall()
        return [row_to_dict(row) for row in rows]


@app.post("/api/projects/{project_id}/milestones", status_code=201)
def create_milestone(project_id: int, payload: MilestoneIn):
    ensure_range(payload.start_date, payload.end_date)
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        ensure_project(conn, project_id)
        cursor = conn.execute(
            """
            INSERT INTO milestones (project_id, title, description, start_date, end_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (project_id, payload.title, payload.description, str(payload.start_date), str(payload.end_date), now),
        )
        row = conn.execute("SELECT * FROM milestones WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return row_to_dict(row)


@app.get("/api/milestones")
def list_milestones():
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT m.*,
                COUNT(e.id) AS epic_count,
                MIN(e.start_date) AS first_epic_date,
                MAX(e.end_date) AS last_epic_date
            FROM milestones m
            LEFT JOIN epics e ON e.milestone_id = m.id
            GROUP BY m.id
            ORDER BY m.start_date, m.id
            """
        ).fetchall()
        return [row_to_dict(row) for row in rows]


@app.get("/api/milestones/{milestone_id}")
def get_milestone(milestone_id: int):
    with get_conn() as conn:
        milestone = conn.execute("SELECT * FROM milestones WHERE id = ?", (milestone_id,)).fetchone()
        if not milestone:
            raise HTTPException(status_code=404, detail="Milestone not found")
        epics = conn.execute(
            "SELECT * FROM epics WHERE milestone_id = ? ORDER BY start_date, id",
            (milestone_id,),
        ).fetchall()
        data = row_to_dict(milestone)
        data["epics"] = [row_to_dict(row) for row in epics]
        return data


@app.put("/api/milestones/{milestone_id}")
def update_milestone(milestone_id: int, payload: MilestoneIn):
    ensure_range(payload.start_date, payload.end_date)
    with get_conn() as conn:
        existing = conn.execute("SELECT id FROM milestones WHERE id = ?", (milestone_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Milestone not found")
        conn.execute(
            """
            UPDATE milestones
            SET title = ?, description = ?, start_date = ?, end_date = ?
            WHERE id = ?
            """,
            (payload.title, payload.description, str(payload.start_date), str(payload.end_date), milestone_id),
        )
        return get_milestone(milestone_id)


@app.delete("/api/milestones/{milestone_id}", status_code=204)
def delete_milestone(milestone_id: int):
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM milestones WHERE id = ?", (milestone_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Milestone not found")


@app.post("/api/milestones/{milestone_id}/epics", status_code=201)
def create_epic(milestone_id: int, payload: EpicIn):
    ensure_range(payload.start_date, payload.end_date)
    now = datetime.utcnow().isoformat()
    with get_conn() as conn:
        ensure_epic_inside_milestone(conn, milestone_id, payload)
        cursor = conn.execute(
            """
            INSERT INTO epics (milestone_id, title, owner, status, color, start_date, end_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
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
        row = conn.execute("SELECT * FROM epics WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return row_to_dict(row)


@app.put("/api/epics/{epic_id}")
def update_epic(epic_id: int, payload: EpicIn):
    ensure_range(payload.start_date, payload.end_date)
    with get_conn() as conn:
        existing = conn.execute("SELECT * FROM epics WHERE id = ?", (epic_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Epic not found")
        ensure_epic_inside_milestone(conn, existing["milestone_id"], payload)
        conn.execute(
            """
            UPDATE epics
            SET title = ?, owner = ?, status = ?, color = ?, start_date = ?, end_date = ?
            WHERE id = ?
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
        row = conn.execute("SELECT * FROM epics WHERE id = ?", (epic_id,)).fetchone()
        return row_to_dict(row)


@app.delete("/api/epics/{epic_id}", status_code=204)
def delete_epic(epic_id: int):
    with get_conn() as conn:
        cursor = conn.execute("DELETE FROM epics WHERE id = ?", (epic_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Epic not found")
