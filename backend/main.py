from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
import html
from pathlib import Path
import hashlib
import json
import secrets
import sqlite3
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from string import Template


DB_PATH = Path(__file__).resolve().parent.parent / "app.db"
WEEKLY_REPORT_TEMPLATE_PATH = Path(__file__).resolve().parent / "templates" / "weekly_report_static.html"
PROJECT_REPORT_TEMPLATE_PATH = Path(__file__).resolve().parent / "templates" / "project_report_static.html"
INITIAL_PASSWORD = "wia1234!"
OTHER_WORK_PROJECT_NAME = "기타 업무 (교육/출장 등)"


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
                sort_order INTEGER NOT NULL DEFAULT 0,
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
        team_event_member_links = []
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS team_events (
                event_id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                title TEXT NOT NULL,
                event_type TEXT NOT NULL DEFAULT 'team',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
            )
            """
        )
        if has_column(conn, "team_events", "description"):
            if has_table(conn, "team_event_members"):
                team_event_member_links = conn.execute(
                    "SELECT event_id, user_id FROM team_event_members"
                ).fetchall()
                conn.execute("DROP TABLE IF EXISTS team_event_members")
            conn.execute("ALTER TABLE team_events RENAME TO team_events_legacy")
            conn.execute(
                """
                CREATE TABLE team_events (
                    event_id TEXT PRIMARY KEY,
                    team_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    event_type TEXT NOT NULL DEFAULT 'team',
                    start_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
                )
                """
            )
            conn.execute(
                """
                INSERT INTO team_events (event_id, team_id, title, event_type, start_date, end_date, created_at)
                SELECT event_id, team_id, title,
                       CASE event_type WHEN 'personal' THEN 'vacation' ELSE event_type END,
                       start_date, end_date, created_at
                FROM team_events_legacy
                """
            )
            conn.execute("DROP TABLE team_events_legacy")
        if not has_column(conn, "team_events", "event_type"):
            conn.execute("ALTER TABLE team_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'team'")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS team_event_members (
                event_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                PRIMARY KEY (event_id, user_id),
                FOREIGN KEY (event_id) REFERENCES team_events(event_id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
            """
        )
        for link in team_event_member_links:
            conn.execute(
                "INSERT OR IGNORE INTO team_event_members (event_id, user_id) VALUES (?, ?)",
                (link["event_id"], link["user_id"]),
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                report_id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'in_progress',
                created_at TEXT NOT NULL,
                FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
            )
            """
        )
        if has_table(conn, "report_entries") and has_column(conn, "report_entries", "project_id"):
            conn.execute("ALTER TABLE report_entries RENAME TO report_entries_legacy")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS report_entries (
                entry_id TEXT PRIMARY KEY,
                report_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT '',
                UNIQUE(report_id, user_id),
                FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS project_entry (
                entry_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                is_excluded INTEGER NOT NULL DEFAULT 0,
                progress_log TEXT NOT NULL DEFAULT '[]',
                risk_issue TEXT NOT NULL DEFAULT '[]',
                next_plan TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (entry_id, project_id),
                FOREIGN KEY (entry_id) REFERENCES report_entries(entry_id) ON DELETE CASCADE,
                FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
            )
            """
        )
        if has_table(conn, "report_entries_legacy"):
            legacy_rows = conn.execute(
                """
                SELECT * FROM report_entries_legacy
                ORDER BY report_id, user_id, created_at
                """
            ).fetchall()
            entry_ids = {}
            for legacy in legacy_rows:
                key = (legacy["report_id"], legacy["user_id"])
                if key not in entry_ids:
                    entry_id = str(uuid.uuid4())
                    statuses = [row["status"] for row in legacy_rows if row["report_id"] == key[0] and row["user_id"] == key[1]]
                    if statuses and all(status == "absent" for status in statuses):
                        status = "absent"
                    elif statuses and all(status in ("done", "excluded") for status in statuses):
                        status = "done"
                    elif any(status == "done" for status in statuses):
                        status = "progress"
                    else:
                        status = "pending"
                    conn.execute(
                        """
                        INSERT OR IGNORE INTO report_entries (entry_id, report_id, user_id, status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (entry_id, key[0], key[1], status, legacy["created_at"], legacy["updated_at"] or legacy["created_at"]),
                    )
                    entry_ids[key] = entry_id
                if legacy["project_id"]:
                    conn.execute(
                        """
                        INSERT OR REPLACE INTO project_entry (entry_id, project_id, is_excluded, progress_log, risk_issue, next_plan, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            entry_ids[key],
                            legacy["project_id"],
                            1 if legacy["status"] == "excluded" else 0,
                            legacy["progress_log"],
                            legacy["risk_issue"],
                            legacy["next_plan"],
                            legacy["updated_at"] or legacy["created_at"],
                        ),
                    )
            conn.execute("DROP TABLE report_entries_legacy")

        if not has_column(conn, "project", "status"):
            conn.execute("ALTER TABLE project ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress'")
        if not has_column(conn, "users", "sort_order"):
            conn.execute("ALTER TABLE users ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
            team_rows = conn.execute("SELECT team_id FROM teams").fetchall()
            for team_row in team_rows:
                user_rows = conn.execute(
                    "SELECT user_id FROM users WHERE team_id = ? ORDER BY created_at ASC, name",
                    (team_row["team_id"],),
                ).fetchall()
                for index, user_row in enumerate(user_rows):
                    conn.execute(
                        "UPDATE users SET sort_order = ? WHERE user_id = ?",
                        (index, user_row["user_id"]),
                    )



@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="WiaReport API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:9602",
        "http://127.0.0.1:9602",
        "http://10.217.183.34:9602",
    ],
    allow_origin_regex=r"^http://(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+):(5173|9602)$",
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


class MemberRoleIn(BaseModel):
    role: str = Field(pattern="^(L|CM|M)$")


class MemberOrderIn(BaseModel):
    user_ids: list[str] = Field(default_factory=list)


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


class ReportIn(BaseModel):
    start_date: date
    end_date: date


class ReportEntryAuthIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


class ProgressLogIn(BaseModel):
    log: str = ""
    status: str = "done"
    date: str = ""


class RiskIssueIn(BaseModel):
    issue: str = ""
    importance: str = "중"


class NextPlanIn(BaseModel):
    plan: str = ""
    due: str = ""


class ReportEntryIn(BaseModel):
    progress_log: list[ProgressLogIn] = Field(default_factory=list)
    risk_issue: list[RiskIssueIn] = Field(default_factory=list)
    next_plan: list[NextPlanIn] = Field(default_factory=list)


class ProjectEntryStatusIn(BaseModel):
    is_excluded: bool


class TeamEventIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    event_type: str = Field(default="team", pattern="^(team|vacation|training|trip|personal)$")
    start_date: date
    end_date: date
    member_ids: list[str] = Field(default_factory=list)


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


def team_event_with_members(conn, event_row):
    data = row_to_dict(event_row)
    members = conn.execute(
        """
        SELECT u.*
        FROM team_event_members tem
        JOIN users u ON u.user_id = tem.user_id
        WHERE tem.event_id = ?
        ORDER BY u.sort_order ASC, u.created_at ASC, u.name
        """,
        (event_row["event_id"],),
    ).fetchall()
    data["member_ids"] = [row["user_id"] for row in members]
    data["members"] = [public_user(row) for row in members]
    return data


def public_weekly_project(row):
    data = row_to_dict(row)
    if not data:
        return None
    data["id"] = data["project_id"]
    data["title"] = data["project_name"]
    return data


def ensure_other_work_project(conn, team_id: str, user_id: str):
    now = datetime.utcnow().isoformat()
    project = conn.execute(
        """
        SELECT * FROM project
        WHERE team_id = ? AND project_name = ?
        LIMIT 1
        """,
        (team_id, OTHER_WORK_PROJECT_NAME),
    ).fetchone()
    if project:
        project_id = project["project_id"]
        if project["status"] != "in_progress":
            conn.execute("UPDATE project SET status = 'in_progress' WHERE project_id = ?", (project_id,))
    else:
        project_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO project (project_id, team_id, project_name, status, created_at)
            VALUES (?, ?, ?, 'in_progress', ?)
            """,
            (project_id, team_id, OTHER_WORK_PROJECT_NAME, now),
        )
    conn.execute(
        """
        INSERT OR IGNORE INTO project_members (project_id, user_id, role)
        VALUES (?, ?, 'M')
        """,
        (project_id, user_id),
    )
    return project_id


def parse_json_list(value, fallback_key=None):
    if value is None or value == "":
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        text = str(value).strip()
        return [{fallback_key: text}] if fallback_key and text else ([text] if text else [])
    return parsed if isinstance(parsed, list) else []


def normalize_progress_status(value):
    return "in_progress" if value in ("in_progress", "In Progress", "진행중") else "done"


def normalize_report_date(value):
    return str(value or "").strip().replace("-", "/")


def normalize_progress_log(items):
    normalized = []
    for item in items:
        log = item.log.strip()
        date_value = normalize_report_date(item.date)
        if log or date_value:
            normalized.append({"log": log, "status": normalize_progress_status(item.status), "date": date_value})
    return normalized


def normalize_risk_issue(items):
    normalized = []
    for item in items:
        issue = item.issue.strip()
        if issue:
            normalized.append({"issue": issue, "importance": item.importance if item.importance in ("상", "중", "하") else "중"})
    return normalized


def normalize_next_plan(items):
    normalized = []
    for item in items:
        plan = item.plan.strip()
        due = item.due.strip()
        if plan or due:
            normalized.append({"plan": plan, "due": due})
    return normalized


def project_entry_payload(row):
    return {
        "progress_log": parse_json_list(row["progress_log"]),
        "risk_issue": parse_json_list(row["risk_issue"], "issue"),
        "next_plan": parse_json_list(row["next_plan"], "plan"),
    }


def project_entry_has_content(row):
    payload = project_entry_payload(row)
    return bool(payload["progress_log"] or payload["risk_issue"] or payload["next_plan"])


def project_entry_status(row):
    if row["is_excluded"]:
        return "excluded"
    if project_entry_has_content(row):
        return "done"
    return "pending"


def escape_html(value):
    return html.escape(str(value or ""), quote=True)


def format_report_due(value):
    return str(value or "").replace("/", ".").replace("-", ".")


def report_importance_sort_value(value):
    return {"상": 0, "중": 1, "하": 2}.get(str(value or "중"), 1)


def report_date_sort_value(value):
    text = str(value or "").strip()
    if not text:
        return (1, "")
    normalized = text.replace("/", "-").replace(".", "-")
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return (0, datetime.strptime(normalized, fmt).date().isoformat())
        except ValueError:
            pass
    return (0, normalized)


def report_progress_sort_value(row):
    return (0 if row["status"] == "done" else 1, report_date_sort_value(row["date"]))


def render_report_empty():
    return '<div class="empty">작성 내용 없음</div>'


def progress_status_label(value):
    return "In Progress" if value == "in_progress" else "Done"


def progress_status_class(value):
    return "in-progress" if value == "in_progress" else "done"


def render_report_progress(items):
    rows = []
    for item in items:
        if isinstance(item, str):
            log = item.strip()
            status = "done"
            date_value = ""
        else:
            log = str(item.get("log") or item.get("text") or "").strip()
            status = normalize_progress_status(item.get("status"))
            date_value = str(item.get("date") or "").strip()
        if log or date_value:
            rows.append({"log": log, "status": status, "date": date_value})
    rows.sort(key=report_progress_sort_value)
    if not rows:
        return render_report_empty()
    items_html = []
    for row in rows:
        date_html = f'<span class="pdate">{escape_html(format_report_due(row["date"]))}</span>' if row["date"] else ""
        log_html = escape_html(row["log"]) if row["log"] else "진행 내용 없음"
        items_html.append(
            '<li class="pline progress">'
            f'<span class="status {progress_status_class(row["status"])}">{escape_html(progress_status_label(row["status"]))}</span>'
            f'{date_html}'
            f'<div class="ptxt">{log_html}</div>'
            '</li>'
        )
    return f"<ul>{''.join(items_html)}</ul>"


def report_importance_class(value):
    if value == "상":
        return "high"
    if value == "하":
        return "low"
    return "mid"


def render_report_risks(items):
    rows = []
    for item in items:
        if isinstance(item, str):
            issue = item.strip()
            importance = "중"
        else:
            issue = str(item.get("issue") or "").strip()
            importance = str(item.get("importance") or "중").strip()
        if issue:
            rows.append({"issue": issue, "importance": importance})
    rows.sort(key=lambda row: (report_importance_sort_value(row["importance"]), row["issue"]))
    if not rows:
        return render_report_empty()
    items_html = []
    for row in rows:
        level = report_importance_class(row["importance"])
        items_html.append(
            f'<li class="rline {level}">'
            f'<span class="badge {level}">{escape_html(row["importance"])}</span>'
            f'<div class="rtxt">{escape_html(row["issue"])}</div>'
            '</li>'
        )
    return f"<ul>{''.join(items_html)}</ul>"


def render_report_plans(items):
    rows = []
    for item in items:
        if isinstance(item, str):
            plan = item.strip()
            due = ""
        else:
            plan = str(item.get("plan") or "").strip()
            due = str(item.get("due") or "").strip()
        if plan or due:
            rows.append({"plan": plan, "due": due})
    rows.sort(key=lambda row: (report_date_sort_value(row["due"]), row["plan"]))
    if not rows:
        return render_report_empty()
    items_html = []
    for row in rows:
        due_html = f'<span class="due">DUE {escape_html(format_report_due(row["due"]))}</span>' if row["due"] else ""
        plan_html = escape_html(row["plan"]) if row["plan"] else "계획 내용 없음"
        items_html.append(
            '<li class="pline">'
            f'{due_html}'
            f'<div class="ptxt">{plan_html}</div>'
            '</li>'
        )
    return f"<ul>{''.join(items_html)}</ul>"


def count_report_progress(items):
    count = 0
    for item in items:
        if isinstance(item, str):
            has_content = bool(item.strip())
        else:
            has_content = bool(str(item.get("log") or item.get("text") or "").strip() or str(item.get("date") or "").strip())
        if has_content:
            count += 1
    return count


def count_report_risks(items):
    count = 0
    for item in items:
        issue = item if isinstance(item, str) else item.get("issue", "")
        if str(issue).strip():
            count += 1
    return count


def count_report_plans(items):
    count = 0
    for item in items:
        if isinstance(item, str):
            has_content = bool(item.strip())
        else:
            has_content = bool(str(item.get("plan") or "").strip() or str(item.get("due") or "").strip())
        if has_content:
            count += 1
    return count


def render_report_project(project):
    progress_log = parse_json_list(project["progress_log"])
    risk_issue = parse_json_list(project["risk_issue"], "issue")
    next_plan = parse_json_list(project["next_plan"], "plan")
    return f"""
      <article class="project">
        <div class="project-title">
          <div class="name">
            <h2>{escape_html(project['project_name'])}</h2>
          </div>
          <div class="stats"><span><b>{count_report_progress(progress_log)}</b> Progress</span><span><b>{count_report_risks(risk_issue)}</b> Risk</span><span><b>{count_report_plans(next_plan)}</b> Plan</span></div>
        </div>
        <div class="blocks">
          <section class="block">
            <h3><span class="bar"></span>Progress Log</h3>
            {render_report_progress(progress_log)}
          </section>
          <section class="block risk">
            <h3><span class="bar"></span>Risk &amp; Issue</h3>
            {render_report_risks(risk_issue)}
          </section>
          <section class="block plan">
            <h3><span class="bar"></span>Next Plan</h3>
            {render_report_plans(next_plan)}
          </section>
        </div>
      </article>
    """


def render_weekly_report_html(report, user, projects):
    if not WEEKLY_REPORT_TEMPLATE_PATH.exists():
        raise HTTPException(status_code=500, detail="Weekly report template not found")
    visible_projects = [project for project in projects if not bool(project["is_excluded"])]
    if visible_projects:
        project_sections = "\n".join(render_report_project(project) for project in visible_projects)
    else:
        project_sections = '<div class="empty">표시할 과제가 없습니다</div>'
    template = Template(WEEKLY_REPORT_TEMPLATE_PATH.read_text(encoding="utf-8"))
    return template.safe_substitute(
        period=escape_html(f"{report['start_date']} ~ {report['end_date']}"),
        author_role=escape_html(f"{user['name']} {user['role']}"),
        project_sections=project_sections,
    )


def role_sort_value(role):
    return {"L": 0, "CM": 1, "M": 2}.get(str(role or ""), 99)


def report_member_label(member):
    return f"{member['name']} {member['role']}"


def format_project_report_members(members):
    ordered = sorted(
        members,
        key=lambda member: (
            role_sort_value(member["role"]),
            member["sort_order"] if member["sort_order"] is not None else 999999,
            member["name"] or "",
        ),
    )
    return ", ".join(report_member_label(member) for member in ordered)


def collect_project_report_items(members):
    progress_rows = []
    risk_rows = []
    plan_rows = []
    ordered_members = sorted(
        members,
        key=lambda member: (
            role_sort_value(member["role"]),
            member["sort_order"] if member["sort_order"] is not None else 999999,
            member["name"] or "",
        ),
    )
    for member in ordered_members:
        source = report_member_label(member)
        for item in parse_json_list(member["progress_log"]):
            if isinstance(item, str):
                log = item.strip()
                status = "done"
                date_value = ""
            else:
                log = str(item.get("log") or item.get("text") or "").strip()
                status = normalize_progress_status(item.get("status"))
                date_value = str(item.get("date") or "").strip()
            if log or date_value:
                progress_rows.append({"log": log, "status": status, "date": date_value, "source": source})
        for item in parse_json_list(member["risk_issue"], "issue"):
            if isinstance(item, str):
                issue = item.strip()
                importance = "중"
            else:
                issue = str(item.get("issue") or "").strip()
                importance = str(item.get("importance") or "중").strip()
            if issue:
                risk_rows.append({"issue": issue, "importance": importance, "source": source})
        for item in parse_json_list(member["next_plan"], "plan"):
            if isinstance(item, str):
                plan = item.strip()
                due = ""
            else:
                plan = str(item.get("plan") or "").strip()
                due = str(item.get("due") or "").strip()
            if plan or due:
                plan_rows.append({"plan": plan, "due": due, "source": source})
    progress_rows.sort(key=lambda row: (0 if row["status"] == "done" else 1, report_date_sort_value(row["date"]), row["source"], row["log"]))
    risk_rows.sort(key=lambda row: (report_importance_sort_value(row["importance"]), row["source"], row["issue"]))
    plan_rows.sort(key=lambda row: (report_date_sort_value(row["due"]), row["source"], row["plan"]))
    return progress_rows, risk_rows, plan_rows


def render_project_report_progress(rows):
    if not rows:
        return render_report_empty()
    items = []
    for row in rows:
        date_html = f'<span class="pdate">{escape_html(format_report_due(row["date"]))}</span>' if row["date"] else ""
        log_html = escape_html(row["log"]) if row["log"] else "진행 내용 없음"
        items.append(
            '<li class="pline progress">'
            f'<span class="status {progress_status_class(row["status"])}">{escape_html(progress_status_label(row["status"]))}</span>'
            f'{date_html}'
            f'<div class="ptxt">{log_html}</div>'
            f'<span class="source">{escape_html(row["source"])}</span></li>'
        )
    return f"<ul>{''.join(items)}</ul>"


def render_project_report_risks(rows):
    if not rows:
        return render_report_empty()
    items = []
    for row in rows:
        level = report_importance_class(row["importance"])
        items.append(
            f'<li class="rline {level}">'
            f'<span class="badge {level}">{escape_html(row["importance"])}</span>'
            f'<div class="rtxt">{escape_html(row["issue"])}</div>'
            f'<span class="source">{escape_html(row["source"])}</span></li>'
        )
    return f"<ul>{''.join(items)}</ul>"


def render_project_report_plans(rows):
    if not rows:
        return render_report_empty()
    items = []
    for row in rows:
        due_html = f'<span class="due">DUE {escape_html(format_report_due(row["due"]))}</span>' if row["due"] else ""
        plan_html = escape_html(row["plan"]) if row["plan"] else "계획 내용 없음"
        items.append(
            '<li class="pline">'
            f'{due_html}'
            f'<div class="ptxt">{plan_html}</div>'
            f'<span class="source">{escape_html(row["source"])}</span></li>'
        )
    return f"<ul>{''.join(items)}</ul>"


def render_project_report_summary(members):
    progress_rows, risk_rows, plan_rows = collect_project_report_items(members)
    return f"""
      <article class="project">
        <div class="project-title">
          <div class="name">
            <h2>과제 종합</h2>
          </div>
          <div class="stats"><span><b>{len(progress_rows)}</b> Progress</span><span><b>{len(risk_rows)}</b> Risk</span><span><b>{len(plan_rows)}</b> Plan</span></div>
        </div>
        <div class="blocks">
          <section class="block">
            <h3><span class="bar"></span>Progress Log</h3>
            {render_project_report_progress(progress_rows)}
          </section>
          <section class="block risk">
            <h3><span class="bar"></span>Risk &amp; Issue</h3>
            {render_project_report_risks(risk_rows)}
          </section>
          <section class="block plan">
            <h3><span class="bar"></span>Next Plan</h3>
            {render_project_report_plans(plan_rows)}
          </section>
        </div>
      </article>
    """


def render_project_weekly_report_html(report, project, members):
    if not PROJECT_REPORT_TEMPLATE_PATH.exists():
        raise HTTPException(status_code=500, detail="Project report template not found")
    project_sections = render_project_report_summary(members) if members else '<div class="empty">수집 완료된 멤버 작성 내용이 없습니다</div>'
    template = Template(PROJECT_REPORT_TEMPLATE_PATH.read_text(encoding="utf-8"))
    return template.safe_substitute(
        project_name=escape_html(project["project_name"]),
        member_names=escape_html(format_project_report_members(members) if members else "없음"),
        period=escape_html(f"{report['start_date']} ~ {report['end_date']}"),
        project_sections=project_sections,
    )


def recompute_report_entry_status(conn, entry_id: str):
    entry = conn.execute("SELECT * FROM report_entries WHERE entry_id = ?", (entry_id,)).fetchone()
    if not entry:
        raise HTTPException(status_code=404, detail="Report entry not found")
    if entry["status"] == "absent":
        return entry
    rows = conn.execute("SELECT * FROM project_entry WHERE entry_id = ?", (entry_id,)).fetchall()
    statuses = [project_entry_status(row) for row in rows]
    if statuses and all(status in ("done", "excluded") for status in statuses):
        next_status = "done"
    elif any(status in ("done", "excluded") for status in statuses):
        next_status = "progress"
    else:
        next_status = "pending"
    now = datetime.utcnow().isoformat()
    conn.execute("UPDATE report_entries SET status = ?, updated_at = ? WHERE entry_id = ?", (next_status, now, entry_id))
    return conn.execute("SELECT * FROM report_entries WHERE entry_id = ?", (entry_id,)).fetchone()


def report_with_entries(conn, report_row):
    data = row_to_dict(report_row)
    members = conn.execute(
        """
        SELECT u.user_id, u.name, u.role, re.entry_id, COALESCE(re.status, 'pending') AS report_status
        FROM users u
        LEFT JOIN report_entries re ON re.user_id = u.user_id AND re.report_id = ?
        WHERE u.team_id = ? AND u.role != 'L'
        ORDER BY u.sort_order ASC, u.created_at ASC, u.name
        """,
        (report_row["report_id"], report_row["team_id"]),
    ).fetchall()
    entries = conn.execute(
        """
        SELECT re.entry_id, re.report_id, re.user_id, re.status AS member_status,
               re.created_at, re.updated_at AS entry_updated_at,
               pe.project_id, pe.is_excluded, pe.progress_log, pe.risk_issue, pe.next_plan,
               pe.updated_at AS project_updated_at,
               u.name, u.role AS member_role, p.project_name
        FROM report_entries re
        JOIN users u ON u.user_id = re.user_id
        JOIN project_entry pe ON pe.entry_id = re.entry_id
        JOIN project p ON p.project_id = pe.project_id
        WHERE re.report_id = ?
        ORDER BY u.sort_order ASC, u.created_at ASC, u.name, p.created_at DESC, p.project_name
        """,
        (report_row["report_id"],),
    ).fetchall()
    data["members"] = [
        {
            "entry_id": row["entry_id"] or "",
            "user_id": row["user_id"],
            "name": row["name"],
            "role": row["role"],
            "status": row["report_status"],
        }
        for row in members
    ]
    data["entries"] = [
        {
            "entry_id": row["entry_id"],
            "report_id": row["report_id"],
            "user_id": row["user_id"],
            "member_status": row["member_status"],
            "created_at": row["created_at"],
            "updated_at": row["project_updated_at"],
            "project_id": row["project_id"],
            "is_excluded": bool(row["is_excluded"]),
            "status": project_entry_status(row),
            "progress_log": project_entry_payload(row)["progress_log"],
            "risk_issue": project_entry_payload(row)["risk_issue"],
            "next_plan": project_entry_payload(row)["next_plan"],
            "name": row["name"],
            "role": row["member_role"],
            "project_name": row["project_name"] or "",
        }
        for row in entries
    ]
    return data


def ensure_report_user_entries(conn, report_id: str, user_id: str):
    report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    user = conn.execute("SELECT * FROM users WHERE user_id = ? AND team_id = ?", (user_id, report["team_id"])).fetchone()
    if not user or user["role"] == "L":
        raise HTTPException(status_code=404, detail="Report member not found")
    now = datetime.utcnow().isoformat()
    entry = conn.execute(
        "SELECT * FROM report_entries WHERE report_id = ? AND user_id = ?",
        (report_id, user_id),
    ).fetchone()
    if not entry:
        entry_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO report_entries (entry_id, report_id, user_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
            """,
            (entry_id, report_id, user_id, now, now),
        )
    else:
        entry_id = entry["entry_id"]
    ensure_other_work_project(conn, report["team_id"], user_id)
    projects = conn.execute(
        """
        SELECT DISTINCT p.project_id
        FROM project p
        JOIN project_members pm ON pm.project_id = p.project_id
        WHERE p.team_id = ? AND p.status = 'in_progress' AND pm.user_id = ?
        ORDER BY CASE WHEN p.project_name = ? THEN 1 ELSE 0 END, p.created_at DESC, p.project_name
        """,
        (report["team_id"], user_id, OTHER_WORK_PROJECT_NAME),
    ).fetchall()
    for project in projects:
        exists = conn.execute(
            "SELECT entry_id FROM project_entry WHERE entry_id = ? AND project_id = ?",
            (entry_id, project["project_id"]),
        ).fetchone()
        if not exists:
            conn.execute(
                """
                INSERT INTO project_entry (entry_id, project_id, is_excluded, progress_log, risk_issue, next_plan, updated_at)
                VALUES (?, ?, 0, '[]', '[]', '[]', ?)
                """,
                (entry_id, project["project_id"], now),
            )
    return report


def ensure_report_entry(conn, entry_id: str):
    row = conn.execute(
        """
        SELECT re.*, r.team_id
        FROM report_entries re
        JOIN reports r ON r.report_id = re.report_id
        WHERE re.entry_id = ?
        """,
        (entry_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Report entry not found")
    return row


def report_for_entry(conn, entry_id: str):
    row = conn.execute(
        """
        SELECT r.*
        FROM reports r
        JOIN report_entries re ON re.report_id = r.report_id
        WHERE re.entry_id = ?
        """,
        (entry_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Report not found")
    return report_with_entries(conn, row)


def list_entry_projects(conn, report_id: str, user_id: str):
    report = ensure_report_user_entries(conn, report_id, user_id)
    entry = conn.execute(
        "SELECT * FROM report_entries WHERE report_id = ? AND user_id = ?",
        (report_id, user_id),
    ).fetchone()
    rows = conn.execute(
        """
        SELECT p.project_id, p.project_name, pe.entry_id, pe.is_excluded,
               pe.progress_log, pe.risk_issue, pe.next_plan, pe.updated_at
        FROM project_entry pe
        JOIN project p ON p.project_id = pe.project_id
        WHERE pe.entry_id = ?
        ORDER BY CASE WHEN p.project_name = ? THEN 1 ELSE 0 END, p.created_at DESC, p.project_name
        """,
        (entry["entry_id"], OTHER_WORK_PROJECT_NAME),
    ).fetchall()
    return [
        {
            "project_id": row["project_id"],
            "id": row["project_id"],
            "project_name": row["project_name"],
            "title": row["project_name"],
            "entry_id": row["entry_id"],
            "is_excluded": bool(row["is_excluded"]),
            "status": project_entry_status(row),
            "progress_log": project_entry_payload(row)["progress_log"],
            "risk_issue": project_entry_payload(row)["risk_issue"],
            "next_plan": project_entry_payload(row)["next_plan"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def ensure_entry_project(conn, entry, project_id: str):
    row = conn.execute(
        """
        SELECT pe.*
        FROM project_entry pe
        JOIN project p ON p.project_id = pe.project_id
        JOIN project_members pm ON pm.project_id = p.project_id
        WHERE pe.entry_id = ? AND pe.project_id = ? AND p.team_id = ? AND pm.user_id = ?
        """,
        (entry["entry_id"], project_id, entry["team_id"], entry["user_id"]),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=422, detail="참여 중인 과제만 선택할 수 있습니다")
    return row


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
            ORDER BY sort_order ASC, created_at ASC, name
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
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM users WHERE team_id = ?",
            (team_id,),
        ).fetchone()["next_order"]
        cursor = conn.execute(
            """
            INSERT INTO users (user_id, team_id, name, role, password_hash, must_change_password, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (
                user_id,
                team_id,
                payload.name.strip(),
                payload.role,
                hash_password(INITIAL_PASSWORD),
                next_order,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM users WHERE rowid = ?", (cursor.lastrowid,)).fetchone()
        return public_user(row)


@app.put("/api/teams/{team_id}/users/order")
def reorder_team_users(team_id: str, payload: MemberOrderIn):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            "SELECT user_id FROM users WHERE team_id = ? ORDER BY sort_order ASC, created_at ASC, name",
            (team_id,),
        ).fetchall()
        existing_ids = [row["user_id"] for row in rows]
        if len(payload.user_ids) != len(existing_ids) or set(payload.user_ids) != set(existing_ids):
            raise HTTPException(status_code=422, detail="멤버 목록이 현재 팀 구성과 일치하지 않습니다")
        for index, user_id in enumerate(payload.user_ids):
            conn.execute(
                "UPDATE users SET sort_order = ? WHERE team_id = ? AND user_id = ?",
                (index, team_id, user_id),
            )
        updated = conn.execute(
            """
            SELECT * FROM users
            WHERE team_id = ?
            ORDER BY sort_order ASC, created_at ASC, name
            """,
            (team_id,),
        ).fetchall()
        return [public_user(row) for row in updated]


@app.get("/api/teams/{team_id}/events")
def list_team_events(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM team_events
            WHERE team_id = ?
            ORDER BY start_date ASC, end_date ASC, created_at ASC
            """,
            (team_id,),
        ).fetchall()
        return [team_event_with_members(conn, row) for row in rows]


@app.post("/api/teams/{team_id}/events", status_code=201)
def create_team_event(team_id: str, payload: TeamEventIn):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=422, detail="종료일은 시작일보다 빠를 수 없습니다")
    now = datetime.utcnow().isoformat()
    event_id = str(uuid.uuid4())
    event_type = "vacation" if payload.event_type == "personal" else payload.event_type
    member_ids = [] if event_type == "team" else list(dict.fromkeys(payload.member_ids))
    with get_conn() as conn:
        ensure_team(conn, team_id)
        for user_id in member_ids:
            user = conn.execute(
                "SELECT user_id FROM users WHERE user_id = ? AND team_id = ?",
                (user_id, team_id),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=422, detail="해당 팀의 멤버만 일정에 포함할 수 있습니다")
        cursor = conn.execute(
            """
            INSERT INTO team_events (event_id, team_id, title, event_type, start_date, end_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                team_id,
                payload.title.strip(),
                event_type,
                str(payload.start_date),
                str(payload.end_date),
                now,
            ),
        )
        for user_id in member_ids:
            conn.execute(
                "INSERT INTO team_event_members (event_id, user_id) VALUES (?, ?)",
                (event_id, user_id),
            )
        row = conn.execute("SELECT * FROM team_events WHERE rowid = ?", (cursor.lastrowid,)).fetchone()
        return team_event_with_members(conn, row)


@app.put("/api/team-events/{event_id}")
def update_team_event(event_id: str, payload: TeamEventIn):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=422, detail="종료일은 시작일보다 빠를 수 없습니다")
    event_type = "vacation" if payload.event_type == "personal" else payload.event_type
    member_ids = [] if event_type == "team" else list(dict.fromkeys(payload.member_ids))
    with get_conn() as conn:
        existing = conn.execute("SELECT * FROM team_events WHERE event_id = ?", (event_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Event not found")
        for user_id in member_ids:
            user = conn.execute(
                "SELECT user_id FROM users WHERE user_id = ? AND team_id = ?",
                (user_id, existing["team_id"]),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=422, detail="해당 팀의 멤버만 일정에 포함할 수 있습니다")
        conn.execute(
            """
            UPDATE team_events
            SET title = ?, event_type = ?, start_date = ?, end_date = ?
            WHERE event_id = ?
            """,
            (
                payload.title.strip(),
                event_type,
                str(payload.start_date),
                str(payload.end_date),
                event_id,
            ),
        )
        conn.execute("DELETE FROM team_event_members WHERE event_id = ?", (event_id,))
        for user_id in member_ids:
            conn.execute(
                "INSERT INTO team_event_members (event_id, user_id) VALUES (?, ?)",
                (event_id, user_id),
            )
        row = conn.execute("SELECT * FROM team_events WHERE event_id = ?", (event_id,)).fetchone()
        return team_event_with_members(conn, row)


@app.delete("/api/team-events/{event_id}", status_code=204)
def delete_team_event(event_id: str):
    with get_conn() as conn:
        row = conn.execute("SELECT event_id FROM team_events WHERE event_id = ?", (event_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Event not found")
        conn.execute("DELETE FROM team_events WHERE event_id = ?", (event_id,))
    return None


@app.get("/api/teams/{team_id}/team-projects")
def list_team_projects(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM project
            WHERE team_id = ? AND project_name != ?
            ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, created_at DESC, project_name
            """,
            (team_id, OTHER_WORK_PROJECT_NAME),
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


@app.put("/api/users/{user_id}/role")
def set_user_role(user_id: str, payload: MemberRoleIn):
    with get_conn() as conn:
        existing = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="User not found")
        conn.execute("UPDATE users SET role = ? WHERE user_id = ?", (payload.role, user_id))
        row = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        return public_user(row)


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




@app.get("/api/teams/{team_id}/reports/completed")
def list_completed_reports(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM reports
            WHERE team_id = ? AND status = 'done'
            ORDER BY start_date DESC, end_date DESC, created_at DESC
            """,
            (team_id,),
        ).fetchall()
        return [report_with_entries(conn, row) for row in rows]


@app.get("/api/teams/{team_id}/reports/active")
def get_active_report(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        row = conn.execute(
            """
            SELECT * FROM reports
            WHERE team_id = ? AND status = 'in_progress'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (team_id,),
        ).fetchone()
        return report_with_entries(conn, row) if row else None


@app.post("/api/teams/{team_id}/reports", status_code=201)
def create_report(team_id: str, payload: ReportIn):
    ensure_range(payload.start_date, payload.end_date)
    now = datetime.utcnow().isoformat()
    report_id = str(uuid.uuid4())
    with get_conn() as conn:
        ensure_team(conn, team_id)
        existing = conn.execute(
            "SELECT report_id FROM reports WHERE team_id = ? AND status = 'in_progress' LIMIT 1",
            (team_id,),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="이미 진행중인 보고가 있습니다")
        conn.execute(
            """
            INSERT INTO reports (report_id, team_id, start_date, end_date, status, created_at)
            VALUES (?, ?, ?, ?, 'in_progress', ?)
            """,
            (report_id, team_id, str(payload.start_date), str(payload.end_date), now),
        )
        users = conn.execute(
            """
            SELECT user_id FROM users
            WHERE team_id = ? AND role != 'L'
            ORDER BY sort_order ASC, created_at ASC, name
            """,
            (team_id,),
        ).fetchall()
        conn.executemany(
            """
            INSERT INTO report_entries (entry_id, report_id, user_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?)
            """,
            [(str(uuid.uuid4()), report_id, row["user_id"], now, now) for row in users],
        )
        row = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        return report_with_entries(conn, row)


@app.put("/api/reports/{report_id}/complete")
def complete_report(report_id: str):
    with get_conn() as conn:
        report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        entries = conn.execute("SELECT status FROM report_entries WHERE report_id = ?", (report_id,)).fetchall()
        if not entries:
            raise HTTPException(status_code=422, detail="완료할 보고 대상이 없습니다")
        if any(row["status"] not in ("done", "absent") for row in entries):
            raise HTTPException(status_code=422, detail="모든 멤버가 작성 완료 또는 부재 상태여야 완료할 수 있습니다")
        conn.execute("UPDATE reports SET status = 'done' WHERE report_id = ?", (report_id,))
        row = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        return report_with_entries(conn, row)


@app.delete("/api/reports/{report_id}", status_code=204)
def delete_report(report_id: str):
    with get_conn() as conn:
        report = conn.execute("SELECT report_id FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        conn.execute(
            """
            DELETE FROM project_entry
            WHERE entry_id IN (SELECT entry_id FROM report_entries WHERE report_id = ?)
            """,
            (report_id,),
        )
        conn.execute("DELETE FROM report_entries WHERE report_id = ?", (report_id,))
        conn.execute("DELETE FROM reports WHERE report_id = ?", (report_id,))




@app.get("/api/reports/{report_id}/users/{user_id}/html-report")
def get_report_user_html(report_id: str, user_id: str):
    with get_conn() as conn:
        report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        user = conn.execute(
            "SELECT user_id, team_id, name, role FROM users WHERE user_id = ? AND team_id = ?",
            (user_id, report["team_id"]),
        ).fetchone()
        entry = conn.execute(
            "SELECT * FROM report_entries WHERE report_id = ? AND user_id = ?",
            (report_id, user_id),
        ).fetchone()
        if not user or not entry:
            raise HTTPException(status_code=404, detail="Report member not found")
        if entry["status"] != "done":
            raise HTTPException(status_code=422, detail="작성 완료된 멤버만 리포트를 볼 수 있습니다")
        projects = conn.execute(
            """
            SELECT p.project_id, p.project_name, pe.entry_id, pe.is_excluded,
                   pe.progress_log, pe.risk_issue, pe.next_plan, pe.updated_at
            FROM project_entry pe
            JOIN project p ON p.project_id = pe.project_id
            WHERE pe.entry_id = ?
            ORDER BY CASE WHEN p.project_name = ? THEN 1 ELSE 0 END, p.created_at DESC, p.project_name
            """,
            (entry["entry_id"], OTHER_WORK_PROJECT_NAME),
        ).fetchall()
        return {"html": render_weekly_report_html(row_to_dict(report), row_to_dict(user), [row_to_dict(row) for row in projects])}


@app.put("/api/reports/{report_id}/users/{user_id}/absence")
def toggle_report_user_absence(report_id: str, user_id: str):
    with get_conn() as conn:
        report = ensure_report_user_entries(conn, report_id, user_id)
        entry = conn.execute(
            "SELECT * FROM report_entries WHERE report_id = ? AND user_id = ?",
            (report_id, user_id),
        ).fetchone()
        now = datetime.utcnow().isoformat()
        if entry and entry["status"] == "absent":
            conn.execute(
                """
                UPDATE report_entries
                SET status = 'pending', updated_at = ?
                WHERE report_id = ? AND user_id = ?
                """,
                (now, report_id, user_id),
            )
            recompute_report_entry_status(conn, entry["entry_id"])
        else:
            conn.execute(
                """
                UPDATE report_entries
                SET status = 'absent', updated_at = ?
                WHERE report_id = ? AND user_id = ?
                """,
                (now, report_id, user_id),
            )
        row = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        return report_with_entries(conn, row)


@app.post("/api/reports/{report_id}/users/{user_id}/authorize")
def authorize_report_user(report_id: str, user_id: str, payload: ReportEntryAuthIn):
    with get_conn() as conn:
        report = ensure_report_user_entries(conn, report_id, user_id)
        user = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
        if not user or not verify_password(payload.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="비밀번호가 올바르지 않습니다")
        entry = conn.execute(
            "SELECT status FROM report_entries WHERE report_id = ? AND user_id = ?",
            (report_id, user_id),
        ).fetchone()
        if entry and entry["status"] == "absent":
            raise HTTPException(status_code=422, detail="부재 상태에서는 보고를 작성할 수 없습니다")
        return {"report_id": report["report_id"], "user_id": user_id, "projects": list_entry_projects(conn, report_id, user_id)}


@app.put("/api/report-entries/{entry_id}/projects/{project_id}")
def save_project_entry(entry_id: str, project_id: str, payload: ReportEntryIn):
    with get_conn() as conn:
        entry = ensure_report_entry(conn, entry_id)
        if entry["status"] == "absent":
            raise HTTPException(status_code=422, detail="부재 상태에서는 보고를 저장할 수 없습니다")
        ensure_entry_project(conn, entry, project_id)
        now = datetime.utcnow().isoformat()
        progress_log = normalize_progress_log(payload.progress_log)
        risk_issue = normalize_risk_issue(payload.risk_issue)
        next_plan = normalize_next_plan(payload.next_plan)
        conn.execute(
            """
            UPDATE project_entry
            SET is_excluded = 0, progress_log = ?, risk_issue = ?, next_plan = ?, updated_at = ?
            WHERE entry_id = ? AND project_id = ?
            """,
            (
                json.dumps(progress_log, ensure_ascii=False),
                json.dumps(risk_issue, ensure_ascii=False),
                json.dumps(next_plan, ensure_ascii=False),
                now,
                entry_id,
                project_id,
            ),
        )
        recompute_report_entry_status(conn, entry_id)
        return report_for_entry(conn, entry_id)


@app.put("/api/report-entries/{entry_id}/projects/{project_id}/exclusion")
def update_project_entry_exclusion(entry_id: str, project_id: str, payload: ProjectEntryStatusIn):
    with get_conn() as conn:
        entry = ensure_report_entry(conn, entry_id)
        if entry["status"] == "absent":
            raise HTTPException(status_code=422, detail="부재 상태에서는 과제 제외를 변경할 수 없습니다")
        ensure_entry_project(conn, entry, project_id)
        now = datetime.utcnow().isoformat()
        if payload.is_excluded:
            conn.execute(
                """
                UPDATE project_entry
                SET is_excluded = 1, progress_log = '[]', risk_issue = '[]', next_plan = '[]', updated_at = ?
                WHERE entry_id = ? AND project_id = ?
                """,
                (now, entry_id, project_id),
            )
        else:
            conn.execute(
                """
                UPDATE project_entry
                SET is_excluded = 0, updated_at = ?
                WHERE entry_id = ? AND project_id = ?
                """,
                (now, entry_id, project_id),
            )
        recompute_report_entry_status(conn, entry_id)
        return report_for_entry(conn, entry_id)


@app.get("/api/projects/{project_id}/weekly-reports")
def list_project_weekly_reports(project_id: str):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        rows = conn.execute(
            """
            SELECT
                r.report_id,
                r.team_id,
                r.start_date,
                r.end_date,
                r.status,
                r.created_at,
                COUNT(DISTINCT re.user_id) AS member_count
            FROM reports r
            JOIN report_entries re ON re.report_id = r.report_id
            JOIN project_entry pe ON pe.entry_id = re.entry_id
            WHERE r.team_id = ?
              AND pe.project_id = ?
              AND pe.is_excluded = 0
              AND re.status = 'done'
            GROUP BY r.report_id
            ORDER BY r.start_date DESC, r.end_date DESC, r.created_at DESC
            """,
            (project["team_id"], project_id),
        ).fetchall()
        return [row_to_dict(row) for row in rows]


@app.get("/api/reports/{report_id}/projects/{project_id}/html-report")
def get_project_html_report(report_id: str, project_id: str):
    with get_conn() as conn:
        report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        project = ensure_team_project(conn, project_id)
        if project["team_id"] != report["team_id"]:
            raise HTTPException(status_code=422, detail="The project does not belong to the report team")
        rows = conn.execute(
            """
            SELECT
                u.user_id,
                u.name,
                u.role,
                u.sort_order,
                re.entry_id,
                re.status AS entry_status,
                pe.is_excluded,
                pe.progress_log,
                pe.risk_issue,
                pe.next_plan,
                pe.updated_at
            FROM report_entries re
            JOIN users u ON u.user_id = re.user_id
            JOIN project_entry pe ON pe.entry_id = re.entry_id
            WHERE re.report_id = ?
              AND pe.project_id = ?
              AND re.status = 'done'
              AND pe.is_excluded = 0
            ORDER BY
              CASE u.role WHEN 'L' THEN 0 WHEN 'CM' THEN 1 WHEN 'M' THEN 2 ELSE 99 END,
              u.sort_order ASC,
              u.created_at ASC,
              u.name
            """,
            (report_id, project_id),
        ).fetchall()
        if not rows:
            raise HTTPException(status_code=404, detail="Project report entries not found")
        return {"html": render_project_weekly_report_html(row_to_dict(report), row_to_dict(project), [row_to_dict(row) for row in rows])}


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
            WHERE p.team_id = ? AND p.status = 'in_progress' AND p.project_name != ?
            GROUP BY p.project_id
            ORDER BY p.created_at DESC, p.project_name
            """,
            (team_id, OTHER_WORK_PROJECT_NAME),
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
