import asyncio
import base64
import binascii
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime, timedelta
import html
from pathlib import Path
import hashlib
import json
import os
import secrets
import shutil
import psycopg
import uuid
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from string import Template
from backend import parts as part_support
from backend import platform_auth
from backend.database import get_conn, actor, configuration


BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent

# WIAREPORT_DATA_DIR stores persistent report attachments. Database settings live in config.yaml.
_DATA_DIR_ENV = os.getenv("WIAREPORT_DATA_DIR", "").strip()
DATA_ROOT = Path(_DATA_DIR_ENV).expanduser() if _DATA_DIR_ENV else None

WEEKLY_REPORT_TEMPLATE_PATH = BACKEND_DIR / "templates" / "weekly_report_static.html"
PROJECT_REPORT_TEMPLATE_PATH = BACKEND_DIR / "templates" / "project_report_static.html"
WORKSPACE_PATH = (DATA_ROOT / "workspace") if DATA_ROOT else BACKEND_DIR / "workspace"
WORKSPACE_PATH.mkdir(parents=True, exist_ok=True)
ADMIN_LOGIN_ID = "admin"
ONLINE_WINDOW_MINUTES = 5
ACCOUNT_ROLES = ("admin", "user")
OTHER_WORK_PROJECT_NAME = "기타 업무 (교육/출장 등)"
KST = ZoneInfo("Asia/Seoul")
DEFAULT_REPORT_SCHEDULE_WEEKDAY = 4
DEFAULT_REPORT_SCHEDULE_TIME = "17:00"
DEFAULT_REPORT_SCHEDULE_INTERVAL_DAYS = 7
WEEKLY_REPORT_SCHEDULE_WEEKDAY = DEFAULT_REPORT_SCHEDULE_WEEKDAY
WEEKLY_REPORT_SCHEDULE_HOUR = 17


def row_to_dict(row):
    return dict(row) if row else None


def public_team(row):
    data = row_to_dict(row)
    if not data:
        return None
    data.pop("password_hash", None)
    data["must_change_password"] = bool(data.get("must_change_password"))
    data["account_role"] = data.get("account_role") or "user"
    data["report_schedule_enabled"] = bool(data.get("report_schedule_enabled", 1))
    data["report_schedule_weekday"] = int(data.get("report_schedule_weekday") or DEFAULT_REPORT_SCHEDULE_WEEKDAY)
    data["report_schedule_time"] = data.get("report_schedule_time") or DEFAULT_REPORT_SCHEDULE_TIME
    data["report_schedule_interval_days"] = int(data.get("report_schedule_interval_days") or DEFAULT_REPORT_SCHEDULE_INTERVAL_DAYS)
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
        if not conn.execute("SELECT to_regclass(?) AS name", (configuration()["database"].get("schema","wiareport")+".report_entries",)).fetchone()['name']:
            raise RuntimeError('Initialize WiaReport PostgreSQL schema before starting the service')


def normalize_project_issue_item(item):
    if isinstance(item, str):
        issue = item.strip()
        importance = "중"
        detail = ""
        images = []
        confluence_url = ""
    else:
        issue = str(item.get("issue") or item.get("text") or "").strip()
        importance = str(item.get("importance") or "중").strip()
        if importance not in ("상", "중", "하"):
            importance = "중"
        detail = str(item.get("detail") or "").strip()
        images = normalize_report_images(item.get("images") or [])
        confluence_url = normalize_confluence_url(item.get("confluence_url"))
    if not (issue or detail or images or confluence_url):
        return None
    return {
        "issue": issue or "Issue 내용 없음",
        "importance": importance,
        "detail": detail,
        "images": images,
        "confluence_url": confluence_url,
    }


def upsert_project_issue(conn, entry_id, project_id, issue_index, item, now):
    images = json.dumps(item.get("images") or [], ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO project_issue (
            issue_id, project_id, entry_id, issue_index, status,
            issue, importance, detail, images, confluence_url,
            created_at, updated_at, resolved_at, resolution_progress_ids, resolution_comment
        )
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, '', '[]', '')
        ON CONFLICT(entry_id, project_id, issue_index) DO UPDATE SET
            issue = excluded.issue,
            importance = excluded.importance,
            detail = excluded.detail,
            images = excluded.images,
            confluence_url = excluded.confluence_url,
            updated_at = excluded.updated_at
        """,
        (
            str(uuid.uuid4()),
            project_id,
            entry_id,
            issue_index,
            item["issue"],
            item["importance"],
            item["detail"],
            images,
            item["confluence_url"],
            now,
            now,
        ),
    )


def sync_project_issues_for_entry(conn, entry_id, project_id, risk_issue, now=None):
    now = now or datetime.utcnow().isoformat()
    normalized = []
    for item in risk_issue or []:
        normalized_item = normalize_project_issue_item(item)
        if normalized_item:
            normalized.append(normalized_item)
    for index, item in enumerate(normalized):
        upsert_project_issue(conn, entry_id, project_id, index, item, now)
    conn.execute(
        """
        DELETE FROM project_issue
        WHERE entry_id = ? AND project_id = ? AND issue_index >= ?
        """,
        (entry_id, project_id, len(normalized)),
    )


def normalize_project_progress_item(item):
    if isinstance(item, str):
        log = item.strip()
        status = 'done'
        date_value = ""
        detail = ""
        images = []
        confluence_url = ""
    else:
        log = str(item.get("log") or item.get("text") or "").strip()
        status = normalize_progress_status(item.get("status"))
        date_value = normalize_report_date(item.get("date"))
        detail = str(item.get("detail") or "").strip()
        images = normalize_report_images(item.get("images") or [])
        confluence_url = normalize_confluence_url(item.get("confluence_url"))
    if not (log or date_value or detail or images or confluence_url):
        return None
    return {
        "log": log,
        "status": status,
        "date": date_value,
        "detail": detail,
        "images": images,
        "confluence_url": confluence_url,
    }


def upsert_project_progress(conn, entry_id, project_id, progress_index, item, now):
    images = json.dumps(item.get("images") or [], ensure_ascii=False)
    conn.execute(
        """
        INSERT INTO project_progress (
            progress_id, project_id, entry_id, progress_index,
            log, status, date, detail, images, confluence_url,
            created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id, project_id, progress_index) DO UPDATE SET
            log = excluded.log,
            status = excluded.status,
            date = excluded.date,
            detail = excluded.detail,
            images = excluded.images,
            confluence_url = excluded.confluence_url,
            updated_at = excluded.updated_at
        """,
        (
            str(uuid.uuid4()),
            project_id,
            entry_id,
            progress_index,
            item["log"],
            item["status"],
            item["date"],
            item["detail"],
            images,
            item["confluence_url"],
            now,
            now,
        ),
    )


def sync_project_progress_for_entry(conn, entry_id, project_id, progress_log, now=None):
    now = now or datetime.utcnow().isoformat()
    normalized = []
    for item in progress_log or []:
        normalized_item = normalize_project_progress_item(item)
        if normalized_item:
            normalized.append(normalized_item)
    for index, item in enumerate(normalized):
        upsert_project_progress(conn, entry_id, project_id, index, item, now)
    conn.execute(
        """
        DELETE FROM project_progress
        WHERE entry_id = ? AND project_id = ? AND progress_index >= ?
        """,
        (entry_id, project_id, len(normalized)),
    )


def normalize_project_plan_item(item):
    if isinstance(item, str):
        plan = item.strip()
        due = ""
    else:
        plan = str(item.get("plan") or item.get("text") or "").strip()
        due = normalize_report_date(item.get("due"))
    if not (plan or due):
        return None
    return {"plan": plan, "due": due}


def upsert_project_plan(conn, entry_id, project_id, plan_index, item, now):
    conn.execute(
        """
        INSERT INTO project_plan (
            plan_id, project_id, entry_id, plan_index,
            plan, due, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id, project_id, plan_index) DO UPDATE SET
            plan = excluded.plan,
            due = excluded.due,
            updated_at = excluded.updated_at
        """,
        (
            str(uuid.uuid4()),
            project_id,
            entry_id,
            plan_index,
            item["plan"],
            item["due"],
            now,
            now,
        ),
    )


def sync_project_plans_for_entry(conn, entry_id, project_id, next_plan, now=None):
    now = now or datetime.utcnow().isoformat()
    normalized = []
    for item in next_plan or []:
        normalized_item = normalize_project_plan_item(item)
        if normalized_item:
            normalized.append(normalized_item)
    for index, item in enumerate(normalized):
        upsert_project_plan(conn, entry_id, project_id, index, item, now)
    conn.execute(
        """
        DELETE FROM project_plan
        WHERE entry_id = ? AND project_id = ? AND plan_index >= ?
        """,
        (entry_id, project_id, len(normalized)),
    )


def backfill_project_tracking(conn):
    rows = conn.execute(
        """
        SELECT pe.entry_id, pe.project_id, pe.progress_log, pe.risk_issue, pe.next_plan,
               pe.updated_at, re.created_at
        FROM project_entry pe
        JOIN report_entries re ON re.entry_id = pe.entry_id
        WHERE pe.is_excluded = 0
        """
    ).fetchall()
    for row in rows:
        now = row["updated_at"] or row["created_at"] or datetime.utcnow().isoformat()
        sync_project_progress_for_entry(
            conn,
            row["entry_id"],
            row["project_id"],
            parse_json_list(row["progress_log"]),
            now,
        )
        sync_project_issues_for_entry(
            conn,
            row["entry_id"],
            row["project_id"],
            parse_json_list(row["risk_issue"], "issue"),
            now,
        )
        sync_project_plans_for_entry(
            conn,
            row["entry_id"],
            row["project_id"],
            parse_json_list(row["next_plan"], "plan"),
            now,
        )


def parse_schedule_time(value):
    text = value or DEFAULT_REPORT_SCHEDULE_TIME
    try:
        hour_text, minute_text = str(text).split(":", 1)
        hour = int(hour_text)
        minute = int(minute_text)
    except (TypeError, ValueError):
        hour, minute = 17, 0
    hour = min(max(hour, 0), 23)
    minute = min(max(minute, 0), 59)
    return hour, minute


def normalized_report_schedule(row):
    return {
        "enabled": bool(row["report_schedule_enabled"] if "report_schedule_enabled" in row.keys() else 1),
        "weekday": int(row["report_schedule_weekday"] if "report_schedule_weekday" in row.keys() else DEFAULT_REPORT_SCHEDULE_WEEKDAY),
        "time": row["report_schedule_time"] if "report_schedule_time" in row.keys() else DEFAULT_REPORT_SCHEDULE_TIME,
        "interval_days": int(row["report_schedule_interval_days"] if "report_schedule_interval_days" in row.keys() else DEFAULT_REPORT_SCHEDULE_INTERVAL_DAYS),
    }


def scheduled_weekly_report_period_for_team(team, now_kst=None):
    now_kst = now_kst or datetime.now(KST)
    schedule = normalized_report_schedule(team)
    if not schedule["enabled"]:
        return None
    weekday = min(max(schedule["weekday"], 0), 6)
    interval_days = min(max(schedule["interval_days"], 1), 31)
    hour, minute = parse_schedule_time(schedule["time"])
    days_since_schedule_day = (now_kst.weekday() - weekday) % 7
    start = now_kst.date() - timedelta(days=days_since_schedule_day)
    due_at = datetime(start.year, start.month, start.day, hour, minute, 0, tzinfo=KST)
    if now_kst < due_at:
        return None
    return start, start + timedelta(days=interval_days - 1)


def scheduled_weekly_report_period(now_kst=None):
    return scheduled_weekly_report_period_for_team({
        "report_schedule_enabled": 1,
        "report_schedule_weekday": DEFAULT_REPORT_SCHEDULE_WEEKDAY,
        "report_schedule_time": DEFAULT_REPORT_SCHEDULE_TIME,
        "report_schedule_interval_days": DEFAULT_REPORT_SCHEDULE_INTERVAL_DAYS,
    }, now_kst)


def seconds_until_next_report_schedule_for_team(team, now_kst=None):
    now_kst = now_kst or datetime.now(KST)
    schedule = normalized_report_schedule(team)
    if not schedule["enabled"]:
        return None
    weekday = min(max(schedule["weekday"], 0), 6)
    hour, minute = parse_schedule_time(schedule["time"])
    days_until_schedule_day = (weekday - now_kst.weekday()) % 7
    target_date = now_kst.date() + timedelta(days=days_until_schedule_day)
    target_at = datetime(target_date.year, target_date.month, target_date.day, hour, minute, 0, tzinfo=KST)
    if target_at <= now_kst:
        target_at += timedelta(days=7)
    return max(1, int((target_at - now_kst).total_seconds()))


def seconds_until_next_weekly_report_schedule(now_kst=None):
    now_kst = now_kst or datetime.now(KST)
    try:
        with get_conn() as conn:
            teams = conn.execute("SELECT * FROM teams WHERE platform_team_id IS NOT NULL ORDER BY created_at ASC").fetchall()
            configs = list(teams) + list(conn.execute("SELECT p.* FROM parts p JOIN teams t ON t.team_id=p.team_id WHERE t.parts_enabled=1"))
            seconds = [seconds_until_next_report_schedule_for_team(team, now_kst) for team in configs]
            seconds = [value for value in seconds if value is not None]
            if seconds:
                return min(seconds)
    except Exception:
        pass
    return seconds_until_next_report_schedule_for_team({
        "report_schedule_enabled": 1,
        "report_schedule_weekday": DEFAULT_REPORT_SCHEDULE_WEEKDAY,
        "report_schedule_time": DEFAULT_REPORT_SCHEDULE_TIME,
        "report_schedule_interval_days": DEFAULT_REPORT_SCHEDULE_INTERVAL_DAYS,
    }, now_kst)


async def weekly_report_scheduler():
    while True:
        try:
            create_due_weekly_reports()
        except Exception as exc:
            print(f"weekly report scheduler failed: {exc}", flush=True)
        await asyncio.sleep(seconds_until_next_weekly_report_schedule())


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler_task = asyncio.create_task(weekly_report_scheduler())
    try:
        yield
    finally:
        scheduler_task.cancel()
        with suppress(asyncio.CancelledError):
            await scheduler_task


app = FastAPI(title="WiaReport API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:9602",
        "http://127.0.0.1:9602",
        "http://10.217.183.34:9602",
        "http://localhost:9802",
        "http://127.0.0.1:9802",
    ],
    allow_origin_regex=r"^http://(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+):(5173|9602|9802)$",
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


class EpicOrderIn(BaseModel):
    epic_ids: list[str]


class EpicIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    owner: str = ""
    status: str = "planned"
    color: str = "#0ea5b7"
    start_date: date
    end_date: date


class ProjectOrderIn(BaseModel):
    project_ids: list[str]
    expected_ids: list[str]


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


class ReportPeriodIn(ReportIn):
    expected_start_date: date
    expected_end_date: date


class ReportScheduleIn(BaseModel):
    enabled: bool = True
    weekday: int = Field(ge=0, le=6)
    time: str = Field(pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    interval_days: int = Field(ge=1, le=31)


class ProgressLogIn(BaseModel):
    log: str = ""
    status: str = 'done'
    date: str = ""
    detail: str = ""
    images: list[str] = Field(default_factory=list)
    confluence_url: str = ""


class RiskIssueIn(BaseModel):
    issue: str = ""
    importance: str = "중"
    detail: str = ""
    images: list[str] = Field(default_factory=list)
    confluence_url: str = ""


class NextPlanIn(BaseModel):
    plan: str = ""
    due: str = ""


class ReportEntryIn(BaseModel):
    progress_log: list[ProgressLogIn] = Field(default_factory=list)
    risk_issue: list[RiskIssueIn] = Field(default_factory=list)
    next_plan: list[NextPlanIn] = Field(default_factory=list)


class ProjectEntryStatusIn(BaseModel):
    is_excluded: bool


class ProjectIssueStatusIn(BaseModel):
    status: str = Field(pattern="^(open|resolved)$")
    resolution_progress_ids: list[str] = Field(default_factory=list)
    resolution_comment: str = ""


class ProjectProgressHistoryVisibilityIn(BaseModel):
    is_hidden: bool = True


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
               u.name, u.role AS member_role, FALSE AS must_change_password
        FROM project_members pm
        JOIN members u ON u.user_id = pm.user_id
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
            "must_change_password": True if row["must_change_password"] else False,
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
        JOIN members u ON u.user_id = tem.user_id
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
    user = conn.execute("SELECT part_id FROM members WHERE user_id=? AND team_id=?", (user_id, team_id)).fetchone()
    if not user:
        raise HTTPException(404, "User not found")
    part_id = user["part_id"]
    project = conn.execute(
        """
        SELECT * FROM project
        WHERE team_id = ? AND project_name = ? AND part_id IS NOT DISTINCT FROM ?
        LIMIT 1
        """,
        (team_id, OTHER_WORK_PROJECT_NAME, part_id),
    ).fetchone()
    if project:
        project_id = project["project_id"]
        if project["status"] != "in_progress":
            conn.execute("UPDATE project SET status = 'in_progress', completed_at = NULL WHERE project_id = ?", (project_id,))
    else:
        project_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO project (project_id, team_id, project_name, status, created_at, part_id)
            VALUES (?, ?, ?, 'in_progress', ?, ?)
            """,
            (project_id, team_id, OTHER_WORK_PROJECT_NAME, now, part_id),
        )
    conn.execute(
        """
        INSERT INTO project_members (project_id, user_id, role)
        VALUES (?, ?, 'M') ON CONFLICT DO NOTHING
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


IMAGE_DATA_PREFIXES = {
    "data:image/png;base64,": ("png", "image/png"),
    "data:image/jpeg;base64,": ("jpg", "image/jpeg"),
    "data:image/webp;base64,": ("webp", "image/webp"),
    "data:image/gif;base64,": ("gif", "image/gif"),
}


def workspace_image_path(image_id):
    image_id = str(image_id or "").strip()
    if not image_id or image_id.startswith("data:") or any(part in ('', '.', '..') for part in image_id.split('/')):
        return None
    root = WORKSPACE_PATH.resolve()
    candidate = (root / image_id).resolve()
    if candidate == root or root not in candidate.parents:
        return None
    if candidate.relative_to(root).parts[0] != image_id.split('/')[0]:
        return None
    return candidate


def normalize_report_images(values):
    images = []
    for value in values or []:
        image = str(value or "").strip()
        if any(image.startswith(prefix) for prefix in IMAGE_DATA_PREFIXES) and len(image) <= 8 * 1024 * 1024:
            images.append(image)
            continue
        path = workspace_image_path(image)
        if path and path.is_file():
            with get_conn() as conn:
                report = conn.execute("SELECT team_id,part_id FROM reports WHERE report_id=?", (image.split('/')[0],)).fetchone()
            if report and part_support.visible(report['team_id'], report['part_id']):
                images.append(image)
    return images[:8]


def persist_report_images(values, report_id, project_id, entry_id):
    stored = []
    target_dir = WORKSPACE_PATH / report_id / project_id / entry_id
    for image in normalize_report_images(values):
        prefix = next((candidate for candidate in IMAGE_DATA_PREFIXES if image.startswith(candidate)), None)
        if not prefix:
            stored.append(image)
            continue
        try:
            raw = base64.b64decode(image[len(prefix):], validate=True)
        except (ValueError, binascii.Error):
            continue
        if not raw or len(raw) > 5 * 1024 * 1024:
            continue
        extension, _ = IMAGE_DATA_PREFIXES[prefix]
        target_dir.mkdir(parents=True, exist_ok=True)
        image_path = target_dir / f"{uuid.uuid4()}.{extension}"
        image_path.write_bytes(raw)
        stored.append(image_path.relative_to(WORKSPACE_PATH).as_posix())
    return stored[:8]


def collect_stored_image_ids(items):
    image_ids = set()
    for item in items or []:
        if not isinstance(item, dict):
            continue
        for image in item.get("images") or []:
            path = workspace_image_path(image)
            if path and path.is_file():
                image_ids.add(str(image))
    return image_ids


def delete_workspace_images(image_ids):
    root = WORKSPACE_PATH.resolve()
    for image_id in image_ids:
        path = workspace_image_path(image_id)
        if not path or not path.is_file():
            continue
        path.unlink()
        parent = path.parent
        while parent != root and root in parent.parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent


def report_image_data_url(image):
    image = str(image or "").strip()
    if image.startswith("data:image/"):
        return image
    path = workspace_image_path(image)
    if not path or not path.is_file():
        return ""
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}.get(path.suffix.lower())
    if not mime:
        return ""
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def normalize_confluence_url(value):
    url = str(value or "").strip()
    return url if url.startswith(("http://", "https://")) else ""


def normalize_progress_log(items):
    normalized = []
    for item in items:
        log = item.log.strip()
        date_value = normalize_report_date(item.date)
        detail = item.detail.strip()
        images = normalize_report_images(item.images)
        confluence_url = normalize_confluence_url(item.confluence_url)
        if log or date_value or detail or images or confluence_url:
            normalized.append({"log": log, "status": normalize_progress_status(item.status), "date": date_value, "detail": detail, "images": images, "confluence_url": confluence_url})
    return normalized


def normalize_risk_issue(items):
    normalized = []
    for item in items:
        issue = item.issue.strip()
        detail = item.detail.strip()
        images = normalize_report_images(item.images)
        confluence_url = normalize_confluence_url(item.confluence_url)
        if issue or detail or images or confluence_url:
            normalized.append({"issue": issue, "importance": item.importance if item.importance in ("상", "중", "하") else "중", "detail": detail, "images": images, "confluence_url": confluence_url})
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
    return (0 if row["status"] == 'done' else 1, report_date_sort_value(row["date"]))


def render_report_block(title, body_html, class_name="block"):
    if not str(body_html or "").strip():
        return ""
    return f"""
          <section class="{class_name}">
            <h3><span class="bar"></span>{title}</h3>
            {body_html}
          </section>
    """


def progress_status_label(value):
    return "In Progress" if value == "in_progress" else "Done"


def progress_status_class(value):
    return "in-progress" if value == "in_progress" else "done"


def render_report_confluence_link(item):
    confluence_url = normalize_confluence_url(item.get("confluence_url"))
    if not confluence_url:
        return ""
    return f'<a class="confluence-link" href="{escape_html(confluence_url)}" target="_blank" rel="noopener noreferrer">Confluence 상세 보기 ↗</a>'


def render_report_item_extras(item):
    detail = str(item.get("detail") or "").strip()
    images = [source for source in (report_image_data_url(image) for image in normalize_report_images(item.get("images") or [])) if source]
    if not (detail or images):
        return ""
    detail_html = f'<div class="item-detail">{escape_html(detail)}</div>' if detail else ""
    images_html = ""
    if images:
        images_html = '<div class="item-gallery">' + "".join(
            f'<button class="report-image-open" type="button" aria-label="첨부 이미지 {index + 1} 확대"><img src="{escape_html(image)}" alt="첨부 이미지 {index + 1}" /></button>'
            for index, image in enumerate(images)
        ) + "</div>"
    return f'<details class="item-extras"><summary><span>상세 내용</span></summary><div class="item-extras-body">{detail_html}{images_html}</div></details>'


def render_report_progress(items):
    rows = []
    for item in items:
        if isinstance(item, str):
            row = {"log": item.strip(), "status": "done", "date": "", "detail": "", "images": [], "confluence_url": ""}
        else:
            row = {
                "log": str(item.get("log") or item.get("text") or "").strip(),
                "status": normalize_progress_status(item.get("status")),
                "date": str(item.get("date") or "").strip(),
                "detail": str(item.get("detail") or "").strip(),
                "images": item.get("images") or [],
                "confluence_url": str(item.get("confluence_url") or "").strip(),
            }
        if row["log"] or row["date"] or row["detail"] or row["images"] or row["confluence_url"]:
            rows.append(row)
    rows.sort(key=report_progress_sort_value)
    if not rows:
        return ""
    items_html = []
    for row in rows:
        date_html = f'<span class="pdate">{escape_html(format_report_due(row["date"]))}</span>' if row["date"] else ""
        log_html = escape_html(row["log"]) if row["log"] else "진행 내용 없음"
        items_html.append(
            '<li class="pline progress report-item"><div class="item-head">'
            f'<span class="status {progress_status_class(row["status"])}">{escape_html(progress_status_label(row["status"]))}</span>'
            f'{date_html}<div class="ptxt">{log_html}</div>{render_report_confluence_link(row)}</div>'
            f'{render_report_item_extras(row)}</li>'
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
            row = {"issue": item.strip(), "importance": "중", "detail": "", "images": [], "confluence_url": ""}
        else:
            row = {
                "issue": str(item.get("issue") or "").strip(),
                "importance": str(item.get("importance") or "중").strip(),
                "detail": str(item.get("detail") or "").strip(),
                "images": item.get("images") or [],
                "confluence_url": str(item.get("confluence_url") or "").strip(),
            }
        if row["issue"] or row["detail"] or row["images"] or row["confluence_url"]:
            rows.append(row)
    rows.sort(key=lambda row: (report_importance_sort_value(row["importance"]), row["issue"]))
    if not rows:
        return ""
    items_html = []
    for row in rows:
        level = report_importance_class(row["importance"])
        issue_html = escape_html(row["issue"]) if row["issue"] else "리스크 내용 없음"
        items_html.append(
            f'<li class="rline {level} report-item"><div class="item-head">'
            f'<span class="badge {level}">{escape_html(row["importance"])}</span>'
            f'<div class="rtxt">{issue_html}</div>{render_report_confluence_link(row)}</div>'
            f'{render_report_item_extras(row)}</li>'
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
        return ""
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
            has_content = bool(str(item.get("log") or item.get("text") or "").strip() or str(item.get("date") or "").strip() or str(item.get("detail") or "").strip() or item.get("images") or str(item.get("confluence_url") or "").strip())
        if has_content:
            count += 1
    return count


def count_report_risks(items):
    count = 0
    for item in items:
        issue = item if isinstance(item, str) else item.get("issue", "")
        has_content = str(issue).strip() if isinstance(item, str) else (str(issue).strip() or str(item.get("detail") or "").strip() or item.get("images") or str(item.get("confluence_url") or "").strip())
        if has_content:
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
    progress_section = render_report_block("Progress Log", render_report_progress(progress_log))
    risk_section = render_report_block("Risk &amp; Issue", render_report_risks(risk_issue), "block risk")
    plan_section = render_report_block("Next Plan", render_report_plans(next_plan), "block plan")
    return f"""
      <article class="project">
        <div class="project-title">
          <div class="name">
            <h2>{escape_html(project['project_name'])}</h2>
          </div>
          <div class="stats"><span><b>{count_report_progress(progress_log)}</b> Progress</span><span><b>{count_report_risks(risk_issue)}</b> Risk</span><span><b>{count_report_plans(next_plan)}</b> Plan</span></div>
        </div>
        <div class="blocks">
          {progress_section}
          {risk_section}
          {plan_section}
        </div>
      </article>
    """


def render_report_assignment_column(kind, label, projects):
    if projects:
        items = "\n".join(
            f'<li><span class="mark"></span>{escape_html(project["project_name"])}</li>'
            for project in projects
        )
    else:
        items = '<li class="none">해당 과제 없음</li>'
    return f"""
        <div class="assign-col {kind}">
          <div class="assign-col-head"><span class="dot"></span>{escape_html(label)}<b class="mono">{len(projects)}</b></div>
          <ul>{items}</ul>
        </div>
    """


def render_report_assignment_summary(included, excluded):
    total = len(included) + len(excluded)
    if not total:
        return ""
    return f"""
      <section class="assign">
        <div class="assign-head">
          <h2>배정 과제 현황</h2>
          <span class="mono">배정 {total} · 포함 {len(included)} · 미포함 {len(excluded)}</span>
        </div>
        <div class="assign-cols">
          {render_report_assignment_column("in", "보고서에 포함된 과제", included)}
          {render_report_assignment_column("out", "포함하지 않은 과제", excluded)}
        </div>
      </section>
    """


def render_weekly_report_html(report, user, projects):
    if not WEEKLY_REPORT_TEMPLATE_PATH.exists():
        raise HTTPException(status_code=500, detail="Weekly report template not found")
    visible_projects = [project for project in projects if not bool(project["is_excluded"])]
    # 기타 업무는 배정된 과제가 아니라 선택 추가 항목이라 미포함 목록에서 제외한다
    excluded_projects = [
        project for project in projects
        if bool(project["is_excluded"]) and project["project_name"] != OTHER_WORK_PROJECT_NAME
    ]
    if visible_projects:
        project_sections = "\n".join(render_report_project(project) for project in visible_projects)
    else:
        project_sections = '<div class="empty">표시할 과제가 없습니다</div>'
    template = Template(WEEKLY_REPORT_TEMPLATE_PATH.read_text(encoding="utf-8"))
    return template.safe_substitute(
        period=escape_html(f"{report['start_date']} ~ {report['end_date']}"),
        author_role=escape_html(f"{user['name']} {user['role']}"),
        assignment_summary=render_report_assignment_summary(visible_projects, excluded_projects),
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
                row = {"log": item.strip(), "status": "done", "date": "", "detail": "", "images": [], "confluence_url": "", "source": source}
            else:
                row = {
                    "log": str(item.get("log") or item.get("text") or "").strip(),
                    "status": normalize_progress_status(item.get("status")),
                    "date": str(item.get("date") or "").strip(),
                    "detail": str(item.get("detail") or "").strip(),
                    "images": item.get("images") or [],
                    "confluence_url": str(item.get("confluence_url") or "").strip(),
                    "source": source,
                }
            if row["log"] or row["date"] or row["detail"] or row["images"] or row["confluence_url"]:
                progress_rows.append(row)
        for item in parse_json_list(member["risk_issue"], "issue"):
            if isinstance(item, str):
                row = {"issue": item.strip(), "importance": "중", "detail": "", "images": [], "confluence_url": "", "source": source}
            else:
                row = {
                    "issue": str(item.get("issue") or "").strip(),
                    "importance": str(item.get("importance") or "중").strip(),
                    "detail": str(item.get("detail") or "").strip(),
                    "images": item.get("images") or [],
                    "confluence_url": str(item.get("confluence_url") or "").strip(),
                    "source": source,
                }
            if row["issue"] or row["detail"] or row["images"] or row["confluence_url"]:
                risk_rows.append(row)
        for item in parse_json_list(member["next_plan"], "plan"):
            if isinstance(item, str):
                plan = item.strip()
                due = ""
            else:
                plan = str(item.get("plan") or "").strip()
                due = str(item.get("due") or "").strip()
            if plan or due:
                plan_rows.append({"plan": plan, "due": due, "source": source})
    progress_rows.sort(key=lambda row: (0 if row["status"] == 'done' else 1, report_date_sort_value(row["date"]), row["source"], row["log"]))
    risk_rows.sort(key=lambda row: (report_importance_sort_value(row["importance"]), row["source"], row["issue"]))
    plan_rows.sort(key=lambda row: (report_date_sort_value(row["due"]), row["source"], row["plan"]))
    return progress_rows, risk_rows, plan_rows


def render_project_report_progress(rows):
    if not rows:
        return ""
    items = []
    for row in rows:
        date_html = f'<span class="pdate">{escape_html(format_report_due(row["date"]))}</span>' if row["date"] else ""
        log_html = escape_html(row["log"]) if row["log"] else "진행 내용 없음"
        items.append(
            '<li class="pline progress report-item"><div class="item-head">'
            f'<span class="status {progress_status_class(row["status"])}">{escape_html(progress_status_label(row["status"]))}</span>'
            f'{date_html}<div class="ptxt">{log_html}</div>{render_report_confluence_link(row)}'
            f'<span class="source">{escape_html(row["source"])}</span></div>'
            f'{render_report_item_extras(row)}</li>'
        )
    return f"<ul>{''.join(items)}</ul>"


def render_project_report_risks(rows):
    if not rows:
        return ""
    items = []
    for row in rows:
        level = report_importance_class(row["importance"])
        issue_html = escape_html(row["issue"]) if row["issue"] else "리스크 내용 없음"
        items.append(
            f'<li class="rline {level} report-item"><div class="item-head">'
            f'<span class="badge {level}">{escape_html(row["importance"])}</span>'
            f'<div class="rtxt">{issue_html}</div>{render_report_confluence_link(row)}'
            f'<span class="source">{escape_html(row["source"])}</span></div>'
            f'{render_report_item_extras(row)}</li>'
        )
    return f"<ul>{''.join(items)}</ul>"


def render_project_report_plans(rows):
    if not rows:
        return ""
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
    progress_section = render_report_block("Progress Log", render_project_report_progress(progress_rows))
    risk_section = render_report_block("Risk &amp; Issue", render_project_report_risks(risk_rows), "block risk")
    plan_section = render_report_block("Next Plan", render_project_report_plans(plan_rows), "block plan")
    return f"""
      <article class="project">
        <div class="project-title">
          <div class="name">
            <h2>과제 종합</h2>
          </div>
          <div class="stats"><span><b>{len(progress_rows)}</b> Progress</span><span><b>{len(risk_rows)}</b> Risk</span><span><b>{len(plan_rows)}</b> Plan</span></div>
        </div>
        <div class="blocks">
          {progress_section}
          {risk_section}
          {plan_section}
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
        next_status = 'done'
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
        FROM members u
        LEFT JOIN report_entries re ON re.user_id = u.user_id AND re.report_id = ?
        WHERE u.team_id = ? AND ((u.is_active=1 AND ? = 'in_progress') OR re.entry_id IS NOT NULL) AND (u.part_id IS NOT DISTINCT FROM ? OR re.entry_id IS NOT NULL OR (CAST(? AS TEXT) IS NULL AND (SELECT parts_enabled FROM teams WHERE team_id=u.team_id)=0))
        ORDER BY u.sort_order ASC, u.created_at ASC, u.name
        """,
        (report_row["report_id"], report_row["team_id"], report_row["status"], report_row["part_id"], report_row["part_id"]),
    ).fetchall()
    entries = conn.execute(
        """
        SELECT re.entry_id, re.report_id, re.user_id, re.status AS member_status,
               re.created_at, re.updated_at AS entry_updated_at,
               pe.project_id, pe.is_excluded, pe.progress_log, pe.risk_issue, pe.next_plan,
               pe.updated_at AS project_updated_at,
               u.name, u.role AS member_role, p.project_name
        FROM report_entries re
        JOIN members u ON u.user_id = re.user_id
        JOIN project_entry pe ON pe.entry_id = re.entry_id
        JOIN project p ON p.project_id = pe.project_id
        WHERE re.report_id = ?
        ORDER BY u.sort_order ASC, u.created_at ASC, u.name, pe.sort_order, p.created_at DESC, p.project_name
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


def create_weekly_report(conn, team_id: str, start_date: date, end_date: date, skip_existing=False, part_id=None):
    ensure_range(start_date, end_date)
    team = ensure_team(conn, team_id)
    start_text = str(start_date)
    end_text = str(end_date)
    if skip_existing:
        existing = conn.execute(
            """
            SELECT * FROM reports
            WHERE team_id = ? AND start_date = ? AND end_date = ? AND part_id IS NOT DISTINCT FROM ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (team_id, start_text, end_text, part_id),
        ).fetchone()
        if existing:
            return existing, False
    now = datetime.utcnow().isoformat()
    report_id = str(uuid.uuid4())
    conn.execute(
        """
        INSERT INTO reports (report_id, team_id, start_date, end_date, status, created_at, part_id)
        VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
        """,
        (report_id, team_id, start_text, end_text, now, part_id),
    )
    users = conn.execute(
        """
        SELECT user_id FROM members
        WHERE team_id = ? AND is_active=1 AND (part_id IS NOT DISTINCT FROM ? OR ? = 0)
        ORDER BY sort_order ASC, created_at ASC, name
        """,
        (team_id, part_id, int(bool(team["parts_enabled"]))),
    ).fetchall()
    conn.executemany(
        """
        INSERT INTO report_entries (entry_id, report_id, user_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
        """,
        [(str(uuid.uuid4()), report_id, row["user_id"], now, now) for row in users],
    )
    row = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
    return row, True


def remember_report_period(conn, report):
    conn.execute(
        """INSERT INTO report_schedule_runs
           (team_id, part_key, start_date, end_date, report_id, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING""",
        (report["team_id"], report["part_id"] or "", report["start_date"], report["end_date"],
         report["report_id"], datetime.utcnow().isoformat()),
    )


def create_due_weekly_reports(now_kst=None):
    now_kst = now_kst or datetime.now(KST)
    created_reports = []
    created_periods = {}
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        teams = conn.execute("SELECT * FROM teams WHERE platform_team_id IS NOT NULL ORDER BY created_at ASC").fetchall()
        schedule_scopes = [(team, None) for team in teams]
        for team in teams:
            if team["parts_enabled"]:
                schedule_scopes.extend((part, part["part_id"]) for part in conn.execute("SELECT * FROM parts WHERE team_id=?", (team["team_id"],)))
        for team, part_id in schedule_scopes:
            period = scheduled_weekly_report_period_for_team(team, now_kst)
            if not period:
                continue
            start_date, end_date = period
            workspace = conn.execute("SELECT * FROM teams WHERE team_id=?", (team["team_id"],)).fetchone()
            platform_auth.sync_members(conn.conn, workspace)
            consumed = conn.execute(
                "SELECT 1 FROM report_schedule_runs WHERE team_id=? AND part_key=? AND start_date=?",
                (team["team_id"], part_id or "", str(start_date)),
            ).fetchone()
            if consumed:
                continue
            row, created = create_weekly_report(conn, team["team_id"], start_date, end_date, skip_existing=True, part_id=part_id)
            remember_report_period(conn, row)
            if created:
                created_reports.append(row["report_id"])
                key = f"{start_date}..{end_date}"
                created_periods[key] = created_periods.get(key, 0) + 1
    if created_reports:
        summary = ", ".join(f"{period}: {count}" for period, count in created_periods.items())
        print(f"created scheduled weekly reports: {summary}", flush=True)
    return created_reports


def ensure_report_user_entries(conn, report_id: str, user_id: str):
    report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    team = ensure_team(conn, report["team_id"])
    user = conn.execute(
        "SELECT * FROM members WHERE user_id = ? AND team_id = ? AND "
        "(part_id IS NOT DISTINCT FROM ? OR ? = 0 OR EXISTS (SELECT 1 FROM report_entries WHERE report_id=? AND user_id=members.user_id))",
        (user_id, report["team_id"], report["part_id"], int(bool(team["parts_enabled"])), report_id),
    ).fetchone()
    if not user:
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
        SELECT p.project_id, p.project_name
        FROM project p
        JOIN project_members pm ON pm.project_id = p.project_id
        WHERE p.team_id = ? AND p.status = 'in_progress' AND pm.user_id = ? AND (p.part_id IS NOT DISTINCT FROM ? OR ? = 0)
        ORDER BY CASE WHEN p.project_name = ? THEN 1 ELSE 0 END, p.created_at DESC, p.project_name
        """,
        (report["team_id"], user_id, user["part_id"], int(bool(team["parts_enabled"])), OTHER_WORK_PROJECT_NAME),
    ).fetchall()
    for project in projects:
        exists = conn.execute(
            "SELECT entry_id FROM project_entry WHERE entry_id = ? AND project_id = ?",
            (entry_id, project["project_id"]),
        ).fetchone()
        if not exists:
            conn.execute(
                """
                INSERT INTO project_entry (entry_id, project_id, is_excluded, progress_log, risk_issue, next_plan, updated_at, sort_order)
                VALUES (?, ?, 1, '[]', '[]', '[]', ?, (SELECT COALESCE(MAX(sort_order)+1,0) FROM project_entry WHERE entry_id=?))
                """,
                (entry_id, project["project_id"], now, entry_id),
            )
    return report


def ensure_report_entry(conn, entry_id: str):
    row = conn.execute(
        """
        SELECT re.*, r.team_id, r.status AS report_status
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
        ORDER BY CASE WHEN p.project_name = ? THEN 1 ELSE 0 END, pe.sort_order, p.created_at DESC, p.project_name
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


@app.get('/api/teams')
def list_teams():
    platform_auth.require_actor(admin_only=True)
    with get_conn() as conn:
        return [dict(r) for r in conn.execute('SELECT team_id,department,platform_team_id FROM teams ORDER BY department')]


def _period_cutoff(period: str) -> str | None:
    """Return an ISO cutoff for a period key, or None for 'all'."""
    if period == "all":
        return None
    try:
        days = int(period)
    except ValueError:
        raise HTTPException(status_code=422, detail="period must be 7, 30 or all")
    if days < 1 or days > 3650:
        raise HTTPException(status_code=422, detail="period must be 7, 30 or all")
    return (datetime.utcnow() - timedelta(days=days)).isoformat()


@app.get("/api/admin/overview")
def admin_overview(period: str = "7"):
    cutoff = _period_cutoff(period)
    online_cutoff = (datetime.utcnow() - timedelta(minutes=ONLINE_WINDOW_MINUTES)).isoformat()
    # `since` is compared against ISO timestamps; '' sorts below every real value,
    # so the 'all' case degrades to "no lower bound" without branching each query.
    since = cutoff or ""

    with get_conn() as conn:
        online_team_ids = {
            row["team_id"]
            for row in conn.execute(
                "SELECT DISTINCT team_id FROM user_activity WHERE last_seen_at >= CAST(? AS TIMESTAMPTZ)",
                (online_cutoff,),
            ).fetchall()
        }

        summary = {
            "online_accounts": len(online_team_ids),
            "total_accounts": conn.execute("SELECT COUNT(*) AS n FROM teams").fetchone()["n"],
            # Only reports that actually have someone to write them. The scheduler
            # opens a report per team on schedule, so teams with no members would
            # otherwise inflate this with empty shells.
            "in_progress_reports": conn.execute(
                """
                SELECT COUNT(*) AS n FROM reports r
                WHERE r.status = 'in_progress'
                  AND EXISTS (SELECT 1 FROM report_entries e WHERE e.report_id = r.report_id)
                """
            ).fetchone()["n"],
            "done_reports": conn.execute(
                """
                SELECT COUNT(*) AS n FROM reports r
                WHERE r.status = 'done'
                  AND EXISTS (SELECT 1 FROM report_entries e WHERE e.report_id = r.report_id)
                """
            ).fetchone()["n"],
            "in_progress_projects": conn.execute(
                "SELECT COUNT(*) AS n FROM project WHERE status = 'in_progress'"
            ).fetchone()["n"],
            "done_projects": conn.execute(
                "SELECT COUNT(*) AS n FROM project WHERE status = 'done'"
            ).fetchone()["n"],
        }

        recent_writers = [
            {
                "updated_at": row["updated_at"],
                "department": row["department"],
                "login_id": row["login_id"],
                "member_name": row["name"],
                "entry_status": row["status"],
                "project_count": row["project_count"],
                "report_range": f"{row['start_date']} ~ {row['end_date']}",
            }
            for row in conn.execute(
                """
                SELECT re.updated_at, re.status, t.department, t.department AS login_id, u.name,
                       r.start_date, r.end_date,
                       (
                           SELECT COUNT(*) FROM project_entry pe
                           WHERE pe.entry_id = re.entry_id AND pe.is_excluded = 0
                       ) AS project_count
                FROM report_entries re
                JOIN members u ON u.user_id = re.user_id
                JOIN reports r ON r.report_id = re.report_id
                JOIN teams t ON t.team_id = r.team_id
                WHERE re.updated_at != '' AND re.status != 'absent' AND re.updated_at >= ?
                  AND EXISTS (
                      SELECT 1 FROM project_entry pe
                      WHERE pe.entry_id = re.entry_id AND pe.is_excluded = 0
                  )
                ORDER BY re.updated_at DESC
                LIMIT 100
                """,
                (since,),
            ).fetchall()
        ]

        team_members = [
            {
                "team_id": row["team_id"],
                "department": row["department"],
                "login_id": row["login_id"],
                "total": row["total"],
                "recent": row["recent"],
            }
            for row in conn.execute(
                """
                SELECT t.team_id, t.department, t.department AS login_id,
                       COUNT(u.user_id) AS total,
                       COALESCE(SUM(CASE WHEN u.created_at >= ? THEN 1 ELSE 0 END), 0) AS recent
                FROM teams t
                LEFT JOIN members u ON u.team_id = t.team_id
                GROUP BY t.team_id, t.department, t.department
                ORDER BY total DESC, t.department
                """,
                (since,),
            ).fetchall()
        ]

        team_projects = [
            {
                "team_id": row["team_id"],
                "department": row["department"],
                "login_id": row["login_id"],
                "in_progress": row["in_progress"],
                "done": row["done"],
                "total": row["total"],
                "recent": row["recent"],
            }
            for row in conn.execute(
                """
                SELECT t.team_id, t.department, t.department AS login_id,
                       COUNT(p.project_id) AS total,
                       COALESCE(SUM(CASE WHEN p.status = 'in_progress' THEN 1 ELSE 0 END), 0) AS in_progress,
                       COALESCE(SUM(CASE WHEN p.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
                       COALESCE(SUM(CASE WHEN p.created_at >= ? THEN 1 ELSE 0 END), 0) AS recent
                FROM teams t
                LEFT JOIN project p ON p.team_id = t.team_id
                GROUP BY t.team_id, t.department, t.department
                ORDER BY total DESC, t.department
                """,
                (since,),
            ).fetchall()
        ]

        account_logins = [
            {
                "team_id": row["team_id"],
                "department": row["department"],
                "login_id": row["login_id"],
                "account_role": row["account_role"] or "user",
                "login_count": row["login_count"],
                "last_login_at": row["last_login_at"] or "",
                "is_online": row["team_id"] in online_team_ids,
            }
            for row in conn.execute(
                """
                SELECT t.team_id, t.department, t.department AS login_id, 'user' AS account_role,
                       COUNT(s.platform_user_id) AS login_count,
                       MAX(s.last_seen_at)::text AS last_login_at
                FROM teams t
                LEFT JOIN user_activity s
                       ON s.team_id = t.team_id AND s.last_seen_at >= COALESCE(NULLIF(?,'')::timestamptz,'-infinity'::timestamptz)
                GROUP BY t.team_id, t.department
                ORDER BY login_count DESC, t.department
                """,
                (since,),
            ).fetchall()
        ]

        account_completed_reports = [
            {
                "team_id": row["team_id"],
                "department": row["department"],
                "login_id": row["login_id"],
                "count": row["done_report_count"],
                "last_completed_at": row["last_completed_at"] or "",
                "last_report_range": row["last_report_range"] or "",
            }
            for row in conn.execute(
                """
                SELECT t.team_id, t.department, t.department AS login_id,
                       COUNT(r.report_id) AS done_report_count,
                       MAX(r.created_at) AS last_completed_at,
                       (
                           SELECT rr.start_date || ' ~ ' || rr.end_date
                           FROM reports rr
                           WHERE rr.team_id = t.team_id
                             AND rr.status = 'done'
                             AND EXISTS (SELECT 1 FROM report_entries e WHERE e.report_id = rr.report_id)
                           ORDER BY rr.created_at DESC, rr.start_date DESC
                           LIMIT 1
                       ) AS last_report_range
                FROM teams t
                LEFT JOIN reports r
                       ON r.team_id = t.team_id
                      AND r.status = 'done'
                      AND EXISTS (SELECT 1 FROM report_entries e WHERE e.report_id = r.report_id)
                GROUP BY t.team_id, t.department, t.department
                ORDER BY done_report_count DESC, t.department
                """
            ).fetchall()
        ]


        account_milestones = [
            {
                "team_id": row["team_id"],
                "department": row["department"],
                "login_id": row["login_id"],
                "count": row["milestone_count"],
            }
            for row in conn.execute(
                """
                SELECT t.team_id, t.department, t.department AS login_id,
                       COUNT(m.milestone_id) AS milestone_count
                FROM teams t
                LEFT JOIN project p ON p.team_id = t.team_id
                LEFT JOIN milestones m
                       ON m.project_id = p.project_id AND m.created_at >= ?
                GROUP BY t.team_id, t.department, t.department
                ORDER BY milestone_count DESC, t.department
                """,
                (since,),
            ).fetchall()
        ]

        account_events = [
            {
                "team_id": row["team_id"],
                "department": row["department"],
                "login_id": row["login_id"],
                "count": row["event_count"],
            }
            for row in conn.execute(
                """
                SELECT t.team_id, t.department, t.department AS login_id,
                       COUNT(e.event_id) AS event_count
                FROM teams t
                LEFT JOIN team_events e ON e.team_id = t.team_id AND e.created_at >= ?
                GROUP BY t.team_id, t.department, t.department
                ORDER BY event_count DESC, t.department
                """,
                (since,),
            ).fetchall()
        ]

    return {
        "period": period,
        "generated_at": datetime.utcnow().isoformat(),
        "online_window_minutes": ONLINE_WINDOW_MINUTES,
        "summary": summary,
        "recent_writers": recent_writers,
        "team_members": team_members,
        "team_projects": team_projects,
        "account_logins": account_logins,
        "account_completed_reports": account_completed_reports,
        "account_milestones": account_milestones,
        "account_events": account_events,
    }


@app.get('/api/auth/me')
def current_identity(request: Request):
    return request.state.actor


@app.post('/api/auth/heartbeat')
def session_heartbeat(request: Request):
    return {'ok': True}


@app.post('/api/auth/logout')
def logout(request: Request):
    token=request.cookies.get(platform_auth.COOKIE, '')
    with get_conn() as conn:
        conn.execute('DELETE FROM platform.sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))
    response=JSONResponse({'ok':True})
    response.delete_cookie(platform_auth.COOKIE,path='/',secure=True,httponly=True,samesite='strict')
    return response


@app.get("/api/teams/{team_id}/users")
def list_team_users(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM members
            WHERE team_id = ? AND is_active=1 AND part_visible(team_id, part_id)
            ORDER BY sort_order ASC, created_at ASC, name
            """,
            (team_id,),
        ).fetchall()
        return [public_user(row) for row in rows]


@app.get("/api/teams/{team_id}/events")
def list_team_events(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM team_events
            WHERE team_id = ? AND part_visible(team_id, part_id)
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
                "SELECT user_id FROM members WHERE user_id = ? AND team_id = ? AND part_visible(team_id, part_id)",
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
        conn.execute("UPDATE team_events SET part_id=? WHERE event_id=?", (part_support.selected_part(), event_id))
        row = conn.execute("SELECT * FROM team_events WHERE event_id = ?", (event_id,)).fetchone()
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
                "SELECT user_id FROM members WHERE user_id = ? AND team_id = ? AND part_visible(team_id, part_id)",
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
            WHERE team_id = ? AND part_visible(team_id, part_id) AND project_name != ?
            ORDER BY sort_order, created_at DESC, project_name
            """,
            (team_id, OTHER_WORK_PROJECT_NAME),
        ).fetchall()
        return [project_with_members(conn, row) for row in rows]


@app.put("/api/teams/{team_id}/team-projects/order")
def reorder_team_projects(team_id: str, payload: ProjectOrderIn):
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        ensure_team(conn, team_id)
        rows = conn.execute(
            "SELECT project_id FROM project WHERE team_id=? AND part_visible(team_id,part_id) AND project_name!=? "
            "ORDER BY sort_order,created_at DESC,project_name",
            (team_id, OTHER_WORK_PROJECT_NAME),
        ).fetchall()
        current = [row["project_id"] for row in rows]
        if len(payload.project_ids) != len(current) or set(payload.project_ids) != set(current):
            raise HTTPException(409, "과제 목록이 변경되었습니다. 최신 목록에서 다시 정렬하세요.")
        if payload.expected_ids != current:
            raise HTTPException(409, "다른 곳에서 과제 순서가 변경되었습니다. 최신 목록에서 다시 정렬하세요.")
        for index, project_id in enumerate(payload.project_ids):
            conn.execute("UPDATE project SET sort_order=? WHERE project_id=? AND team_id=? AND part_visible(team_id,part_id)",
                         (index, project_id, team_id))
    return list_team_projects(team_id)


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
            INSERT INTO project (project_id, team_id, project_name, status, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (project_id, team_id, payload.project_name.strip(), payload.status, now, now if payload.status == 'done' else None),
        )
        for member in payload.members:
            user = conn.execute(
                "SELECT user_id FROM members WHERE user_id = ? AND team_id = ? AND part_visible(team_id, part_id)",
                (member.user_id, team_id),
            ).fetchone()
            if not user:
                raise HTTPException(status_code=422, detail="해당 팀의 멤버만 과제에 매칭할 수 있습니다")
            conn.execute(
                "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
                (project_id, member.user_id, member.role),
            )
        conn.execute("UPDATE project SET part_id=?,sort_order=(SELECT COALESCE(MAX(sort_order)+1,0) FROM project WHERE team_id=? AND part_id IS NOT DISTINCT FROM ? AND project_id!=?) WHERE project_id=?",
                     (part_support.selected_part(), team_id, part_support.selected_part(), project_id, project_id))
        row = conn.execute("SELECT * FROM project WHERE project_id = ?", (project_id,)).fetchone()
        return project_with_members(conn, row)


def project_completion_time(project, next_status: str):
    if next_status != 'done':
        return None
    if project["status"] == 'done':
        return project["completed_at"]
    return datetime.utcnow().isoformat()


@app.put("/api/team-projects/{project_id}/status")
def update_team_project_status(project_id: str, payload: TeamProjectStatusIn):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        conn.execute(
            "UPDATE project SET status = ?, completed_at = ? WHERE project_id = ?",
            (payload.status, project_completion_time(project, payload.status), project_id),
        )
        row = conn.execute("SELECT * FROM project WHERE project_id = ?", (project_id,)).fetchone()
        return project_with_members(conn, row)


@app.put("/api/team-projects/{project_id}")
def update_team_project(project_id: str, payload: TeamProjectIn):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        existing_user_ids = {row[0] for row in conn.execute("SELECT user_id FROM project_members WHERE project_id=?", (project_id,))}
        if sum(1 for member in payload.members if member.role == "L") > 1:
            raise HTTPException(status_code=422, detail="과제 리더는 한 명만 지정할 수 있습니다")
        conn.execute(
            "UPDATE project SET project_name = ?, status = ?, completed_at = ? WHERE project_id = ?",
            (payload.project_name.strip(), payload.status, project_completion_time(project, payload.status), project_id),
        )
        conn.execute("DELETE FROM project_members WHERE project_id = ?", (project_id,))
        for member in payload.members:
            user = conn.execute(
                "SELECT user_id,part_visible(team_id,part_id) AS in_part FROM members WHERE user_id = ? AND team_id = ?",
                (member.user_id, project["team_id"]),
            ).fetchone()
            if not user or (not user["in_part"] and member.user_id not in existing_user_ids):
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
        existing_user_ids = {row[0] for row in conn.execute("SELECT user_id FROM project_members WHERE project_id=?", (project_id,))}
        if sum(1 for member in payload.members if member.role == "L") > 1:
            raise HTTPException(status_code=422, detail="과제 리더는 한 명만 지정할 수 있습니다")
        normalized = {}
        for member in payload.members:
            user = conn.execute(
                "SELECT user_id,part_visible(team_id,part_id) AS in_part FROM members WHERE user_id = ? AND team_id = ?",
                (member.user_id, project["team_id"]),
            ).fetchone()
            if not user or (not user["in_part"] and member.user_id not in existing_user_ids):
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


@app.get("/api/teams/{team_id}/reports/archive")
def list_report_archive(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            "SELECT report_id, start_date, end_date, completed_at FROM reports "
            "WHERE team_id = ? AND part_visible(team_id, part_id) AND status = 'done' "
            "ORDER BY end_date DESC, start_date DESC, created_at DESC",
            (team_id,),
        ).fetchall()
        return [dict(row) for row in rows]


@app.put("/api/reports/{report_id}/reopen")
def reopen_report(report_id: str):
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        conn.execute("UPDATE reports SET status = 'in_progress' WHERE report_id = ?", (report_id,))
        row = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        return report_with_entries(conn, row)


@app.get("/api/teams/{team_id}/reports/completed")
def list_completed_reports(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT DISTINCT r.*
            FROM reports r
            LEFT JOIN report_entries re ON re.report_id = r.report_id
            WHERE r.team_id = ? AND part_visible(r.team_id, r.part_id)
              AND (
                r.status = 'done'
                OR (r.status = 'in_progress' AND re.status = 'done')
              )
            ORDER BY r.start_date DESC, r.end_date DESC, r.created_at DESC
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
            WHERE team_id = ? AND part_visible(team_id, part_id) AND status = 'in_progress'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (team_id,),
        ).fetchone()
        return report_with_entries(conn, row) if row else None


@app.get("/api/teams/{team_id}/reports/active-list")
def list_active_reports(team_id: str):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        rows = conn.execute(
            """
            SELECT * FROM reports
            WHERE team_id = ? AND part_visible(team_id, part_id) AND status = 'in_progress'
            ORDER BY start_date DESC, end_date DESC, created_at DESC
            """,
            (team_id,),
        ).fetchall()
        return [report_with_entries(conn, row) for row in rows]


@app.post("/api/teams/{team_id}/reports", status_code=201)
def create_report(team_id: str, payload: ReportIn):
    with get_conn() as conn:
        row, _ = create_weekly_report(conn, team_id, payload.start_date, payload.end_date, part_id=part_support.selected_part())
        return report_with_entries(conn, row)


@app.put("/api/reports/{report_id}/period")
def update_report_period(report_id: str, payload: ReportPeriodIn, authorization: str | None = Header(default=None)):
    ensure_range(payload.start_date, payload.end_date)
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        report = conn.execute("SELECT * FROM reports WHERE report_id=? AND part_visible(team_id, part_id)", (report_id,)).fetchone()
        if not report:
            raise HTTPException(404, "Report not found")
        platform_auth.require_actor(team_id=report["team_id"])
        if (report["start_date"], report["end_date"]) != (str(payload.expected_start_date), str(payload.expected_end_date)):
            raise HTTPException(409, "보고 기간이 변경되었습니다. 새로고침한 뒤 다시 수정해 주세요.")
        if (report["start_date"], report["end_date"]) == (str(payload.start_date), str(payload.end_date)):
            return report_with_entries(conn, report)
        duplicate = conn.execute(
            "SELECT 1 FROM reports WHERE team_id=? AND part_id IS NOT DISTINCT FROM ? AND report_id!=? AND start_date=? AND end_date=?",
            (report["team_id"], report["part_id"], report_id, str(payload.start_date), str(payload.end_date)),
        ).fetchone()
        if duplicate:
            raise HTTPException(409, "같은 기간의 주간보고가 이미 있습니다.")
        # Covers existing reports created before schedule tracking was introduced.
        remember_report_period(conn, report)
        conn.execute("UPDATE reports SET start_date=?, end_date=? WHERE report_id=?",
                     (str(payload.start_date), str(payload.end_date), report_id))
        row = conn.execute("SELECT * FROM reports WHERE report_id=?", (report_id,)).fetchone()
        return report_with_entries(conn, row)


@app.get("/api/teams/{team_id}/report-schedule")
def get_report_schedule(team_id: str):
    with get_conn() as conn:
        team = ensure_team(conn, team_id)
        if part_support.selected_part():
            team = conn.execute("SELECT * FROM parts WHERE part_id=? AND team_id=?", (part_support.selected_part(), team_id)).fetchone()
        schedule = normalized_report_schedule(team)
        return {**schedule, "timezone": "Asia/Seoul"}


@app.put("/api/teams/{team_id}/report-schedule")
def update_report_schedule(team_id: str, payload: ReportScheduleIn):
    with get_conn() as conn:
        ensure_team(conn, team_id)
        table = "parts" if part_support.selected_part() else "teams"
        key = "part_id" if part_support.selected_part() else "team_id"
        target = part_support.selected_part() or team_id
        conn.execute(
            f"""
            UPDATE {table}
            SET report_schedule_enabled = ?,
                report_schedule_weekday = ?,
                report_schedule_time = ?,
                report_schedule_interval_days = ?
            WHERE {key} = ?
            """,
            (
                1 if payload.enabled else 0,
                payload.weekday,
                payload.time,
                payload.interval_days,
                target,
            ),
        )
        team = conn.execute(f"SELECT * FROM {table} WHERE {key}=?", (target,)).fetchone()
        schedule = normalized_report_schedule(team)
        return {**schedule, "timezone": "Asia/Seoul"}


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
        completed_at = report["completed_at"] if report["status"] == 'done' else datetime.utcnow().isoformat()
        conn.execute("UPDATE reports SET status = 'done', completed_at = ? WHERE report_id = ?", (completed_at, report_id))
        row = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        return report_with_entries(conn, row)


@app.delete("/api/reports/{report_id}", status_code=204)
def delete_report(report_id: str):
    # Only server-generated UUID directories may be removed, never request paths.
    try:
        canonical_id = str(uuid.UUID(report_id))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=404, detail="Report not found")
    if canonical_id != report_id:
        raise HTTPException(status_code=404, detail="Report not found")
    workspace_root = WORKSPACE_PATH.resolve()
    report_directory = workspace_root / canonical_id
    if report_directory.is_symlink() or report_directory.resolve().parent != workspace_root:
        raise HTTPException(status_code=409, detail="Invalid report workspace")
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        remember_report_period(conn, report)
        conn.execute(
            """
            DELETE FROM project_entry
            WHERE entry_id IN (SELECT entry_id FROM report_entries WHERE report_id = ?)
            """,
            (report_id,),
        )
        conn.execute("DELETE FROM report_entries WHERE report_id = ?", (report_id,))
        conn.execute("DELETE FROM reports WHERE report_id = ?", (report_id,))
    shutil.rmtree(report_directory, ignore_errors=True)


@app.get("/api/report-images/{image_id:path}")
def get_report_image(image_id: str):
    path = workspace_image_path(image_id)
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Report image not found")
    return FileResponse(path)


@app.get("/api/reports/{report_id}/users/{user_id}/html-report")
def get_report_user_html(report_id: str, user_id: str):
    with get_conn() as conn:
        report = conn.execute("SELECT * FROM reports WHERE report_id = ?", (report_id,)).fetchone()
        if not report:
            raise HTTPException(status_code=404, detail="Report not found")
        user = conn.execute(
            "SELECT user_id, team_id, name, role FROM members WHERE user_id = ? AND team_id = ?",
            (user_id, report["team_id"]),
        ).fetchone()
        entry = conn.execute(
            "SELECT * FROM report_entries WHERE report_id = ? AND user_id = ?",
            (report_id, user_id),
        ).fetchone()
        if not user or not entry:
            raise HTTPException(status_code=404, detail="Report member not found")
        if entry["status"] != 'done':
            raise HTTPException(status_code=422, detail="작성 완료된 멤버만 리포트를 볼 수 있습니다")
        # A completed personal report's updated_at is its last saved completion time.
        # Keep included content and unknown historical completion times unchanged.
        projects = conn.execute(
            """
            SELECT p.project_id, p.project_name, pe.entry_id, pe.is_excluded,
                   pe.progress_log, pe.risk_issue, pe.next_plan, pe.updated_at
            FROM project_entry pe
            JOIN project p ON p.project_id = pe.project_id
            WHERE pe.entry_id = ?
              AND (
                  pe.is_excluded = 0
                  OR safe_timestamp(p.completed_at) IS NULL
                  OR safe_timestamp(?) IS NULL
                  OR safe_timestamp(p.completed_at) > safe_timestamp(?)
              )
            ORDER BY CASE WHEN p.project_name = ? THEN 1 ELSE 0 END, pe.sort_order, p.created_at DESC, p.project_name
            """,
            (entry["entry_id"], entry["updated_at"], entry["updated_at"], OTHER_WORK_PROJECT_NAME),
        ).fetchall()
        return {"html": render_weekly_report_html(row_to_dict(report), row_to_dict(user), [row_to_dict(row) for row in projects])}


@app.put("/api/reports/{report_id}/users/{user_id}/absence")
def toggle_report_user_absence(report_id: str, user_id: str):
    with get_conn() as conn:
        platform_auth.require_owner(conn,user_id)
        report = ensure_report_user_entries(conn, report_id, user_id)
        if report["status"] == "done": raise HTTPException(409,"완료된 보고는 작성할 수 없습니다.")
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


@app.post('/api/reports/{report_id}/users/{user_id}/authorize')
def authorize_report_user(report_id: str, user_id: str):
    with get_conn() as conn:
        platform_auth.require_owner(conn,user_id)
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(?,0))',(report_id+':'+user_id,))
        report=ensure_report_user_entries(conn,report_id,user_id)
        if report['status']=='done': raise HTTPException(409,'완료된 보고는 작성할 수 없습니다.')
        entry=conn.execute('SELECT status FROM report_entries WHERE report_id=? AND user_id=?',(report_id,user_id)).fetchone()
        if entry and entry['status']=='absent':raise HTTPException(422,'부재 상태에서는 보고를 작성할 수 없습니다.')
        return {'report_id':report_id,'user_id':user_id,'projects':list_entry_projects(conn,report_id,user_id)}


@app.put("/api/report-entries/{entry_id}/project-order")
def reorder_report_projects(entry_id: str, payload: ProjectOrderIn):
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        entry = ensure_report_entry(conn, entry_id)
        platform_auth.require_owner(conn,entry["user_id"])
        if entry["report_status"] == "done": raise HTTPException(409,"완료된 보고는 작성할 수 없습니다.")
        report = conn.execute("SELECT status FROM reports WHERE report_id=?", (entry["report_id"],)).fetchone()
        if entry["status"] == "absent" or report["status"] == 'done':
            raise HTTPException(409, "작성 가능한 보고를 다시 열어 순서를 변경하세요.")
        rows = conn.execute(
            "SELECT pe.project_id,pe.sort_order FROM project_entry pe JOIN project p ON p.project_id=pe.project_id "
            "WHERE pe.entry_id=? AND pe.is_excluded=0 AND p.project_name!=? ORDER BY pe.sort_order,p.created_at DESC,p.project_name",
            (entry_id, OTHER_WORK_PROJECT_NAME),
        ).fetchall()
        current = [row["project_id"] for row in rows]
        if len(payload.project_ids) != len(current) or set(payload.project_ids) != set(current) or payload.expected_ids != current:
            raise HTTPException(409, "작성 과제 목록이나 순서가 변경되었습니다. 보고를 다시 열고 정렬하세요.")
        # Reorder only the selected regular projects. Content and completion timestamps are untouched.
        all_rows = conn.execute(
            "SELECT pe.project_id FROM project_entry pe JOIN project p ON p.project_id=pe.project_id WHERE pe.entry_id=? "
            "ORDER BY CASE WHEN p.project_name=? THEN 1 ELSE 0 END,pe.sort_order,p.created_at DESC,p.project_name",
            (entry_id, OTHER_WORK_PROJECT_NAME),
        ).fetchall()
        selected = set(current)
        ordered = iter(payload.project_ids)
        result = [next(ordered) if row["project_id"] in selected else row["project_id"] for row in all_rows]
        for index, project_id in enumerate(result):
            conn.execute("UPDATE project_entry SET sort_order=? WHERE entry_id=? AND project_id=?", (index, entry_id, project_id))
        return {"project_ids": result}


@app.put("/api/report-entries/{entry_id}/projects/{project_id}")
def save_project_entry(entry_id: str, project_id: str, payload: ReportEntryIn):
    with get_conn() as conn:
        entry = ensure_report_entry(conn, entry_id)
        platform_auth.require_owner(conn,entry["user_id"])
        if entry["report_status"] == "done": raise HTTPException(409,"완료된 보고는 작성할 수 없습니다.")
        if entry["status"] == "absent":
            raise HTTPException(status_code=422, detail="부재 상태에서는 보고를 저장할 수 없습니다")
        project_entry = ensure_entry_project(conn, entry, project_id)
        existing_payload = project_entry_payload(project_entry)
        old_image_ids = collect_stored_image_ids(existing_payload["progress_log"]) | collect_stored_image_ids(existing_payload["risk_issue"])
        now = datetime.utcnow().isoformat()
        progress_log = normalize_progress_log(payload.progress_log)
        risk_issue = normalize_risk_issue(payload.risk_issue)
        next_plan = normalize_next_plan(payload.next_plan)
        for item in progress_log:
            item["images"] = persist_report_images(item.get("images"), entry["report_id"], project_id, entry_id)
        for item in risk_issue:
            item["images"] = persist_report_images(item.get("images"), entry["report_id"], project_id, entry_id)
        new_image_ids = collect_stored_image_ids(progress_log) | collect_stored_image_ids(risk_issue)
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
        sync_project_progress_for_entry(conn, entry_id, project_id, progress_log, now)
        sync_project_issues_for_entry(conn, entry_id, project_id, risk_issue, now)
        sync_project_plans_for_entry(conn, entry_id, project_id, next_plan, now)
        delete_workspace_images(old_image_ids - new_image_ids)
        recompute_report_entry_status(conn, entry_id)
        return report_for_entry(conn, entry_id)


@app.put("/api/report-entries/{entry_id}/projects/{project_id}/exclusion")
def update_project_entry_exclusion(entry_id: str, project_id: str, payload: ProjectEntryStatusIn):
    with get_conn() as conn:
        entry = ensure_report_entry(conn, entry_id)
        platform_auth.require_owner(conn,entry["user_id"])
        if entry["report_status"] == "done": raise HTTPException(409,"완료된 보고는 작성할 수 없습니다.")
        if entry["status"] == "absent":
            raise HTTPException(status_code=422, detail="부재 상태에서는 과제 제외를 변경할 수 없습니다")
        project_entry = ensure_entry_project(conn, entry, project_id)
        existing_payload = project_entry_payload(project_entry)
        old_image_ids = collect_stored_image_ids(existing_payload["progress_log"]) | collect_stored_image_ids(existing_payload["risk_issue"])
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
            conn.execute(
                "DELETE FROM project_progress WHERE entry_id = ? AND project_id = ?",
                (entry_id, project_id),
            )
            conn.execute(
                "DELETE FROM project_issue WHERE entry_id = ? AND project_id = ?",
                (entry_id, project_id),
            )
            conn.execute(
                "DELETE FROM project_plan WHERE entry_id = ? AND project_id = ?",
                (entry_id, project_id),
            )
            delete_workspace_images(old_image_ids)
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


@app.get("/api/projects/{project_id}/progress-history")
def get_project_progress_history(project_id: str, include_hidden: bool = False):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        rows = conn.execute(
            """
            SELECT
                pp.progress_id,
                pp.project_id,
                pp.entry_id,
                pp.progress_index,
                pp.log,
                pp.status AS progress_status,
                pp.date AS progress_date,
                pp.detail,
                pp.images,
                pp.confluence_url,
                pp.is_history_hidden,
                pp.created_at,
                pp.updated_at,
                r.report_id,
                r.start_date AS report_start_date,
                r.end_date AS report_end_date,
                r.status AS report_status,
                re.status AS entry_status,
                u.user_id,
                u.name,
                u.role
            FROM project_progress pp
            JOIN project_entry pe ON pe.entry_id = pp.entry_id AND pe.project_id = pp.project_id
            JOIN report_entries re ON re.entry_id = pp.entry_id
            JOIN reports r ON r.report_id = re.report_id
            JOIN members u ON u.user_id = re.user_id
            WHERE pp.project_id = ?
              AND r.team_id = ?
              AND pe.is_excluded = 0
              AND pp.status = 'done'
              AND (? = 1 OR pp.is_history_hidden = 0)
            ORDER BY r.end_date DESC, r.start_date DESC, u.sort_order ASC, pp.progress_index ASC
            """,
            (project_id, project["team_id"], 1 if include_hidden else 0),
        ).fetchall()
        history = []
        for row in rows:
            normalized_date = str(row["progress_date"] or "").replace("/", "-").replace(".", "-")
            occurred_on = normalized_date or row["report_end_date"]
            history.append({
                "history_id": row["progress_id"],
                "progress_id": row["progress_id"],
                "project_id": row["project_id"],
                "entry_id": row["entry_id"],
                "progress_index": row["progress_index"],
                "report_id": row["report_id"],
                "report_start_date": row["report_start_date"],
                "report_end_date": row["report_end_date"],
                "report_status": row["report_status"],
                "entry_status": row["entry_status"],
                "occurred_on": occurred_on,
                "log": row["log"] or "진행 내용 없음",
                "status": row["progress_status"],
                "detail": row["detail"] or "",
                "images": parse_json_list(row["images"]),
                "confluence_url": row["confluence_url"] or "",
                "is_history_hidden": bool(row["is_history_hidden"]),
                "reported_by": row["name"],
                "reported_role": row["role"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            })
        history.sort(
            key=lambda item: (item["occurred_on"], item["report_end_date"], item["reported_by"], item["log"]),
            reverse=True,
        )
        return history


@app.put("/api/project-progress/{progress_id}/history-visibility")
def update_project_progress_history_visibility(progress_id: str, payload: ProjectProgressHistoryVisibilityIn):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM project_progress WHERE progress_id = ?", (progress_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Progress not found")
        now = datetime.utcnow().isoformat()
        conn.execute(
            """
            UPDATE project_progress
            SET is_history_hidden = ?, updated_at = ?
            WHERE progress_id = ?
            """,
            (1 if payload.is_hidden else 0, now, progress_id),
        )
        updated = conn.execute("SELECT * FROM project_progress WHERE progress_id = ?", (progress_id,)).fetchone()
        data = row_to_dict(updated)
        data["images"] = parse_json_list(data.get("images"))
        data["is_history_hidden"] = bool(data.get("is_history_hidden"))
        return data


@app.get("/api/projects/{project_id}/upcoming-next-plans")
def get_project_upcoming_next_plans(project_id: str):
    today = datetime.now(KST).date()
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        rows = conn.execute(
            """
            SELECT
                pp.plan_id,
                pp.project_id,
                pp.entry_id,
                pp.plan_index,
                pp.plan,
                pp.due,
                pp.created_at,
                pp.updated_at,
                r.report_id,
                r.start_date AS report_start_date,
                r.end_date AS report_end_date,
                r.status AS report_status,
                re.status AS entry_status,
                u.user_id,
                u.name,
                u.role
            FROM project_plan pp
            JOIN project_entry pe ON pe.entry_id = pp.entry_id AND pe.project_id = pp.project_id
            JOIN report_entries re ON re.entry_id = pp.entry_id
            JOIN reports r ON r.report_id = re.report_id
            JOIN members u ON u.user_id = re.user_id
            WHERE pp.project_id = ?
              AND r.team_id = ?
              AND pe.is_excluded = 0
              AND re.status = 'done'
              AND TRIM(pp.plan) != ''
              AND TRIM(pp.due) != ''
            ORDER BY r.end_date DESC, r.start_date DESC, u.sort_order ASC, pp.plan_index ASC
            """,
            (project_id, project["team_id"]),
        ).fetchall()
        plans = []
        for row in rows:
            due_text = str(row["due"] or "").strip()
            normalized_due = due_text.replace("/", "-").replace(".", "-")
            try:
                due_date = date.fromisoformat(normalized_due)
            except ValueError:
                continue
            if due_date < today:
                continue
            plans.append({
                "plan_id": row["plan_id"],
                "project_id": row["project_id"],
                "entry_id": row["entry_id"],
                "plan_index": row["plan_index"],
                "report_id": row["report_id"],
                "report_start_date": row["report_start_date"],
                "report_end_date": row["report_end_date"],
                "report_status": row["report_status"],
                "entry_status": row["entry_status"],
                "due": normalized_due,
                "plan": row["plan"] or "계획 내용 없음",
                "reported_by": row["name"],
                "reported_role": row["role"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            })
        plans.sort(key=lambda item: (item["due"], item["report_end_date"], item["reported_by"], item["plan"]))
        return plans


@app.get("/api/projects/{project_id}/issue-management")
def get_project_issue_management(project_id: str):
    with get_conn() as conn:
        project = ensure_team_project(conn, project_id)
        rows = conn.execute(
            """
            SELECT
                pi.issue_id,
                pi.project_id,
                pi.entry_id,
                pi.issue_index,
                pi.status AS issue_status,
                pi.issue,
                pi.importance,
                pi.detail,
                pi.images,
                pi.confluence_url,
                pi.created_at,
                pi.updated_at,
                pi.resolved_at,
                pi.resolution_progress_ids,
                pi.resolution_comment,
                r.report_id,
                r.start_date AS report_start_date,
                r.end_date AS report_end_date,
                r.status AS report_status,
                re.status AS entry_status,
                u.user_id,
                u.name,
                u.role
            FROM project_issue pi
            JOIN project_entry pe ON pe.entry_id = pi.entry_id AND pe.project_id = pi.project_id
            JOIN report_entries re ON re.entry_id = pi.entry_id
            JOIN reports r ON r.report_id = re.report_id
            JOIN members u ON u.user_id = re.user_id
            WHERE pi.project_id = ?
              AND r.team_id = ?
              AND pe.is_excluded = 0
            ORDER BY
              CASE pi.status WHEN 'open' THEN 0 ELSE 1 END,
              r.end_date DESC,
              r.start_date DESC,
              u.sort_order ASC,
              pi.issue_index ASC
            """,
            (project_id, project["team_id"]),
        ).fetchall()
        issues = []
        for row in rows:
            issues.append({
                "issue_id": row["issue_id"],
                "project_id": row["project_id"],
                "entry_id": row["entry_id"],
                "issue_index": row["issue_index"],
                "status": row["issue_status"],
                "report_id": row["report_id"],
                "report_start_date": row["report_start_date"],
                "report_end_date": row["report_end_date"],
                "report_status": row["report_status"],
                "entry_status": row["entry_status"],
                "issue": row["issue"] or "Issue 내용 없음",
                "importance": row["importance"] if row["importance"] in ("상", "중", "하") else "중",
                "detail": row["detail"] or "",
                "images": parse_json_list(row["images"]),
                "confluence_url": row["confluence_url"] or "",
                "reported_by": row["name"],
                "reported_role": row["role"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "resolved_at": row["resolved_at"],
                "resolution_progress_ids": parse_json_list(row["resolution_progress_ids"]),
                "resolution_comment": row["resolution_comment"] or "",
            })
        issues.sort(
            key=lambda item: (
                0 if item["status"] == "open" else 1,
                report_importance_sort_value(item["importance"]),
                item["report_end_date"],
                item["report_start_date"],
                item["reported_by"],
            )
        )
        return issues


@app.put("/api/project-issues/{issue_id}/status")
def update_project_issue_status(issue_id: str, payload: ProjectIssueStatusIn):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM project_issue WHERE issue_id = ?", (issue_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Issue not found")
        now = datetime.utcnow().isoformat()
        resolved_at = now if payload.status == "resolved" else ""
        progress_ids = []
        if payload.status == "resolved":
            candidates = [str(value or "").strip() for value in payload.resolution_progress_ids or []]
            candidates = [value for value in candidates if value]
            if candidates:
                placeholders = ",".join("?" for _ in candidates)
                progress_rows = conn.execute(
                    f"SELECT progress_id FROM project_progress WHERE project_id = ? AND progress_id IN ({placeholders})",
                    (row["project_id"], *candidates),
                ).fetchall()
                valid_ids = {progress_row["progress_id"] for progress_row in progress_rows}
                progress_ids = [value for value in candidates if value in valid_ids]
        resolution_comment = payload.resolution_comment.strip()[:4000] if payload.status == "resolved" else row["resolution_comment"]
        conn.execute(
            """
            UPDATE project_issue
            SET status = ?, resolved_at = ?, resolution_progress_ids = ?, resolution_comment = ?, updated_at = ?
            WHERE issue_id = ?
            """,
            (
                payload.status,
                resolved_at,
                json.dumps(progress_ids, ensure_ascii=False) if payload.status == "resolved" else row["resolution_progress_ids"],
                resolution_comment,
                now,
                issue_id,
            ),
        )
        updated = conn.execute("SELECT * FROM project_issue WHERE issue_id = ?", (issue_id,)).fetchone()
        data = row_to_dict(updated)
        data["images"] = parse_json_list(data.get("images"))
        data["resolution_progress_ids"] = parse_json_list(data.get("resolution_progress_ids"))
        return data

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
            JOIN members u ON u.user_id = re.user_id
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
def list_team_timeline_projects(team_id: str, all_projects: bool = False):
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
            WHERE p.team_id = ? AND part_visible(p.team_id, p.part_id) AND p.status = 'in_progress' AND p.project_name != ? AND (? = 1 OR EXISTS (SELECT 1 FROM project_members mine WHERE mine.project_id=p.project_id AND mine.user_id=?))
            GROUP BY p.project_id
            ORDER BY p.sort_order, p.created_at DESC, p.project_name
            """,
            (team_id, OTHER_WORK_PROJECT_NAME, int(all_projects), platform_auth.require_actor()["member_id"]),
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
            JOIN project p ON p.project_id=m.project_id
            WHERE part_visible(p.team_id,p.part_id)
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
            "SELECT * FROM epics WHERE milestone_id = ? ORDER BY sort_order, start_date, created_at, epic_id",
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


@app.put("/api/milestones/{milestone_id}/epics/order")
def reorder_epics(milestone_id: str, payload: EpicOrderIn):
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        ensure_milestone(conn, milestone_id)
        current_ids = {row["epic_id"] for row in conn.execute(
            "SELECT epic_id FROM epics WHERE milestone_id = ?", (milestone_id,)
        )}
        if len(payload.epic_ids) != len(set(payload.epic_ids)) or set(payload.epic_ids) != current_ids:
            raise HTTPException(status_code=409, detail="워크 목록이 변경되었습니다. 새로고침 후 다시 시도하세요.")
        conn.executemany(
            "UPDATE epics SET sort_order = ? WHERE milestone_id = ? AND epic_id = ?",
            [(index, milestone_id, epic_id) for index, epic_id in enumerate(payload.epic_ids)],
        )
    return get_milestone(milestone_id)


@app.post("/api/milestones/{milestone_id}/epics", status_code=201)
def create_epic(milestone_id: str, payload: EpicIn):
    ensure_range(payload.start_date, payload.end_date)
    now = datetime.utcnow().isoformat()
    epic_id = str(uuid.uuid4())
    with get_conn() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('wiareport:write',0))")
        ensure_epic_inside_milestone(conn, milestone_id, payload)
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM epics WHERE milestone_id = ?", (milestone_id,)
        ).fetchone()[0]
        conn.execute(
            """
            INSERT INTO epics (epic_id, milestone_id, title, owner, status, color, start_date, end_date, created_at, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                next_order,
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


part_support.install(app, get_conn, public_team)


def require_request_session(authorization=None, admin_only=False):
    return platform_auth.require_actor(admin_only=admin_only)


@app.middleware('http')
async def platform_session_middleware(request, call_next):
    path=request.url.path.rstrip('/')
    token=None
    try:
        if path.startswith('/api/') and path!='/api/health':
            # Shared cookie only: old bearer sessions and client identity hints cannot authenticate.
            who=await run_in_threadpool(platform_auth.resolve,request.cookies.get(platform_auth.COOKIE))
            token=actor.set(who);request.state.actor=who
            if path.startswith('/api/admin'):platform_auth.require_actor(admin_only=True)
            if request.method not in ('GET','HEAD','OPTIONS'):
                from urllib.parse import urlsplit
                origin=request.headers.get('origin')
                if request.headers.get('x-wia-request')!='1' or (origin and urlsplit(origin).netloc!=request.headers.get('host')):
                    raise HTTPException(403,'허용되지 않은 요청입니다.')
        response=await call_next(request)
    except HTTPException as exc:
        response=JSONResponse(status_code=exc.status_code,content={'detail':exc.detail})
    finally:
        if token is not None:actor.reset(token)
    if path.startswith('/api/'):response.headers['Cache-Control']='no-store'
    return response
