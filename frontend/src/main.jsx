import ReportMembersDialog from './ReportMembersDialog';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, FolderKanban, Library, ChartNoAxesCombined, ArrowLeft, Plus, Trash2, AudioWaveform, User, ChevronRight, Pencil, Save, X, KeyRound, LogOut, Users, ClipboardList, GripVertical, HelpCircle, Check, FileText, Link2, ImagePlus, AlertTriangle, History, ExternalLink, CalendarClock, Clock, CalendarRange, Zap, Wifi } from 'lucide-react';
import './styles.css';
import './platformLayout.css';
import Introduction from './Introduction.jsx';
import { emptyFormFields } from './formFields.mjs';
import PartManagement from './PartManagement.jsx';
import { useProjectOrder } from './useProjectOrder.js';
import WeeklyProjectOrderList from './WeeklyProjectOrderList.jsx';
import { buildTimelineAxis } from './timelineAxis.mjs';

// 기본값은 같은 출처(''). vite 가 /api 를 백엔드로 프록시한다(vite.config.js).
// 백엔드를 다른 주소로 직접 호출해야 하면 VITE_API_BASE 로 절대주소를 넣는다.
const SERVICE_PREFIX = window.location.pathname === '/wiareport' || window.location.pathname.startsWith('/wiareport/') ? '/wiareport' : '';
const API_BASE = import.meta.env.VITE_API_BASE ?? SERVICE_PREFIX;
// Only server responses populate this identity. Stored profile fields are never trusted.
let verifiedTeam = null;
const PLATFORM_ORIGIN = 'https://axforwork.wia.co.kr';
function platformLogin(profile = false) {
  const next = '/wiareport/agent' + window.location.search;
  window.location.replace(PLATFORM_ORIGIN + '/login?' + new URLSearchParams({ next, ...(profile ? { profile: 'complete' } : {}) }));
}


function AuthenticatedImage({ src, alt, ...props }) {
  const protectedImage = String(src || '').startsWith(API_BASE + '/api/report-images/');
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    if (!protectedImage) return;
    let active = true, objectUrl;
    const controller = new AbortController();
    setLoaded(null);
    fetch(src, { credentials: 'include', signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error('이미지를 불러올 수 없습니다.'); return response.blob(); })
      .then((blob) => { if (active) { objectUrl = URL.createObjectURL(blob); setLoaded({ src, objectUrl }); } })
      .catch(() => {});
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, protectedImage]);
  return <img {...props} src={protectedImage ? (loaded?.src === src ? loaded.objectUrl : undefined) : src} alt={alt} />;
}

function reportImageSrc(value) {
  const image = String(value || "");
  if (!image || image.startsWith("data:") || image.startsWith("http://") || image.startsWith("https://") || image.startsWith("blob:")) return image;
  return API_BASE + "/api/report-images/" + image.split("/").map(encodeURIComponent).join("/");
}
const DAY = 24 * 60 * 60 * 1000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const OTHER_WORK_PROJECT_NAME = '기타 업무 (교육/출장 등)';
const WEEKDAY_OPTIONS = [
  { value: 0, label: "월요일" },
  { value: 1, label: "화요일" },
  { value: 2, label: "수요일" },
  { value: 3, label: "목요일" },
  { value: 4, label: "금요일" },
  { value: 5, label: "토요일" },
  { value: 6, label: "일요일" },
];
const OVERVIEW_PERIODS = [
  { value: '7', label: '7일' },
  { value: '30', label: '30일' },
  { value: 'all', label: '전체' },
];

// Backend timestamps are naive UTC ISO strings; mark them as UTC before formatting to KST.
function formatUtcStamp(value, withTime = true) {
  const raw = String(value || '');
  if (!raw) return '-';
  const parsed = new Date(/[Z+]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  });
}

// Year-less "09.07 14:23" for the narrow side-panel columns.
function formatUtcStampShort(value) {
  const raw = String(value || '');
  if (!raw) return '-';
  const parsed = new Date(/[Z+]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (Number.isNaN(parsed.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(parsed).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

const DEFAULT_REPORT_SCHEDULE = { enabled: true, weekday: 4, time: "17:00", interval_days: 7 };
const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 31;

function clampIntervalDays(value) {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_REPORT_SCHEDULE.interval_days;
  return Math.min(Math.max(days, MIN_INTERVAL_DAYS), MAX_INTERVAL_DAYS);
}

// weekday: 0=월 ~ 6=일, time: "HH:MM" — 한국시간 기준 다음 개설 시점
function nextScheduleRun(weekday, time) {
  const [hour, minute] = String(time || DEFAULT_REPORT_SCHEDULE.time).split(":").map(Number);
  const nowKst = new Date(Date.now() + new Date().getTimezoneOffset() * 60000 + 9 * 3600000);
  const todayIdx = (nowKst.getDay() + 6) % 7;
  const run = new Date(nowKst);
  run.setDate(run.getDate() + ((Number(weekday) - todayIdx + 7) % 7));
  run.setHours(Number.isFinite(hour) ? hour : 17, Number.isFinite(minute) ? minute : 0, 0, 0);
  if (run <= nowKst) run.setDate(run.getDate() + 7);
  return run;
}

function formatKoreanDate(date) {
  return date.getFullYear() + "년 " + (date.getMonth() + 1) + "월 " + date.getDate() + "일 (" + DOW[date.getDay()] + ")";
}

function formatShortDate(date) {
  return (date.getMonth() + 1) + "월 " + date.getDate() + "일";
}
const ACCENTS = [
  { id: 'indigo', bar: '#4F46E5' },
  { id: 'teal', bar: '#0F8B8D' },
  { id: 'coral', bar: '#D8592F' },
  { id: 'amber', bar: '#B8790F' },
];
const STATUS_STYLE = {
  planned: { label: '예정', bg: '#F7F5EF', text: '#5F5A4F', border: '#D8D1C3' },
  in_progress: { label: '진행중', bg: '#EEEDFE', text: '#4F46E5', border: '#C7C2FF' },
  in_progress_delayed: { label: '진행 지연', bg: '#FFF4D6', text: '#9A5B00', border: '#EAC46F' },
  done: { label: '완료', bg: '#E4F5EC', text: '#0E8F52', border: '#A9D9BD' },
  done_delayed: { label: '완료 지연', bg: '#FCF1EC', text: '#B0331C', border: '#E7B4A8' },
  blocked: { label: '차단', bg: '#FCF1EC', text: '#B0331C', border: '#E7B4A8' },
};
const ROLE_LABELS = { L: '리더', CM: '책임매니저', M: '매니저' };
const CALENDAR_EVENT_TYPES = {
  team: { label: '팀 일정', className: 'team' },
  vacation: { label: '휴가', className: 'vacation' },
  training: { label: '교육', className: 'training' },
  trip: { label: '출장', className: 'trip' },
  personal: { label: '휴가', className: 'vacation' },
};
const PERSONAL_CALENDAR_EVENT_TYPES = ['vacation', 'training', 'trip'];

function calendarEventTypeMeta(type) {
  return CALENDAR_EVENT_TYPES[type] || CALENDAR_EVENT_TYPES.team;
}

function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayIso() {
  return isoOf(new Date());
}

function kstTodayIso() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function plusDays(iso, days) {
  const date = toDate(iso);
  date.setDate(date.getDate() + days);
  return isoOf(date);
}

function slashDateToInput(value) {
  return typeof value === "string" ? value.replaceAll("/", "-") : "";
}

function inputDateToSlash(value) {
  return value ? value.replaceAll("-", "/") : "";
}

function weeklyCompletionText(members) {
  const list = members || [];
  const doneCount = list.filter((member) => member.status === 'done').length;
  const absentCount = list.filter((member) => member.status === 'absent').length;
  const targetCount = Math.max(0, list.length - absentCount);
  return `작성 ${doneCount}/${targetCount} 명${absentCount ? ` (부재 ${absentCount}명)` : ''}`;
}

function emptyWeeklyEntryDraft() {
  return {
    progress_log: [{ log: "", status: "done", date: "", detail: "", images: [], confluence_url: "" }],
    risk_issue: [{ issue: "", importance: "중", detail: "", images: [], confluence_url: "" }],
    next_plan: [{ plan: "", due: "" }],
  };
}

function normalizeWeeklyList(value, emptyItem) {
  if (Array.isArray(value)) return value.length ? value : [emptyItem];
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [emptyItem];
}

function weeklyDraftFromProject(project = {}) {
  return {
    progress_log: normalizeWeeklyList(project.progress_log, { log: "", status: "done", date: "", detail: "", images: [], confluence_url: "" }).map((item) => (typeof item === "string" ? { log: item, status: "done", date: "", detail: "", images: [], confluence_url: "" } : { log: item.log || item.text || "", status: item.status === "in_progress" ? "in_progress" : "done", date: slashDateToInput(item.date || ""), detail: item.detail || "", images: Array.isArray(item.images) ? item.images : [], confluence_url: item.confluence_url || "" })),
    risk_issue: normalizeWeeklyList(project.risk_issue, { issue: "", importance: "중", detail: "", images: [], confluence_url: "" }).map((item) => (typeof item === "string" ? { issue: item, importance: "중", detail: "", images: [], confluence_url: "" } : { issue: item.issue || "", importance: item.importance || "중", detail: item.detail || "", images: Array.isArray(item.images) ? item.images : [], confluence_url: item.confluence_url || "" })),
    next_plan: normalizeWeeklyList(project.next_plan, { plan: "", due: "" }).map((item) => (typeof item === "string" ? { plan: item, due: "" } : { plan: item.plan || "", due: slashDateToInput(item.due || "") })),
  };
}

function compactWeeklyDraft(draft) {
  return {
    progress_log: (draft.progress_log || []).map((item) => ({ log: String(item.log || "").trim(), status: item.status === "in_progress" ? "in_progress" : "done", date: inputDateToSlash(item.date || ""), detail: String(item.detail || "").trim(), images: Array.isArray(item.images) ? item.images : [], confluence_url: String(item.confluence_url || "").trim() })).filter((item) => item.log || item.date || item.detail || item.images.length || item.confluence_url),
    risk_issue: (draft.risk_issue || []).map((item) => ({ issue: String(item.issue || "").trim(), importance: item.importance || "중", detail: String(item.detail || "").trim(), images: Array.isArray(item.images) ? item.images : [], confluence_url: String(item.confluence_url || "").trim() })).filter((item) => item.issue || item.detail || item.images.length || item.confluence_url),
    next_plan: (draft.next_plan || []).map((item) => ({ plan: String(item.plan || "").trim(), due: inputDateToSlash(item.due || "") })).filter((item) => item.plan || item.due),
  };
}

// compactWeeklyDraft 가 실제로 저장하는 행(내용이 있는 행)만 날짜 필수로 본다.
// 빈 행은 저장 시 어차피 버려지므로 경고 대상이 아니다.
function findMissingWeeklyDates(draft) {
  const progress = [];
  (draft.progress_log || []).forEach((item, index) => {
    const hasContent = String(item.log || "").trim() || String(item.detail || "").trim()
      || (Array.isArray(item.images) ? item.images.length : 0) || String(item.confluence_url || "").trim();
    if (hasContent && !String(item.date || "").trim()) progress.push(index);
  });
  const plan = [];
  (draft.next_plan || []).forEach((item, index) => {
    if (String(item.plan || "").trim() && !String(item.due || "").trim()) plan.push(index);
  });
  return { progress, plan };
}

function businessDaysBetween(startIso, endIso) {
  const start = toDate(startIso);
  const end = toDate(endIso);
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function normalizeStatus(status) {
  if (status === '예정') return 'planned';
  if (status === '진행중') return 'in_progress';
  if (status === '진행 지연') return 'in_progress_delayed';
  if (status === '완료') return 'done';
  if (status === '완료 지연') return 'done_delayed';
  return status || 'planned';
}

function accentFor(index) {
  return ACCENTS[index % ACCENTS.length];
}

async function request(path, options = {}) {
  let partHeaders = {};
  try {
    const team = verifiedTeam;
    if (team?.team_id && !path.startsWith('/api/auth/')) {
      partHeaders = { ...partHeaders, 'X-Wia-Team': team.team_id, 'X-Wia-Part': localStorage.getItem('wiareport_part_' + team.team_id) || '' };
    }
  } catch {}
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Wia-Request': '1', ...partHeaders, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) platformLogin();
    if (body.detail?.code === 'profile_required') platformLogin(true);
    const detail = Array.isArray(body.detail)
      ? body.detail.map((item) => item.msg || JSON.stringify(item)).join(', ')
      : (body.detail?.message || body.detail);
    const error = new Error(detail || `Request failed: ${res.status}`);
    error.status = res.status;
    if (res.status === 401 && !path.startsWith("/api/auth/login") && !path.endsWith("/authorize")) window.dispatchEvent(new Event("wiareport-session-expired"));
    throw error;
  }
  if (res.status === 204) return null;
  return res.json();
}


function App() {
  const [scopeVersion, setScopeVersion] = useState(0);
  useEffect(() => {
    const change = () => setScopeVersion((version) => version + 1);
    window.addEventListener('wiareport-part-change', change);
    return () => window.removeEventListener('wiareport-part-change', change);
  }, []);
  return <TeamWorkspace key={scopeVersion} />;
}

function TeamWorkspace() {
  const [activePage, setActivePage] = useState(() => { const saved = sessionStorage.getItem('wiareport_scope_page'); return ['member-management', 'accounts'].includes(saved) ? 'part-management' : saved || 'team-status'; });
  const [activeTeamTab, setActiveTeamTab] = useState('tasks');
  const [projects, setProjects] = useState([]);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [teams, setTeams] = useState([]);
  const [members, setMembers] = useState([]);
  const [teamProjects, setTeamProjects] = useState([]);
  const [currentTeam, setCurrentTeam] = useState(null);
  const [sessionReady, setSessionReady] = useState(false);
  useEffect(() => {
    let active = true;
    verifiedTeam = null;
    localStorage.removeItem('wiareport_team');
    request('/api/auth/me').then((team) => {
      if (active) { if (team.team_id && team.member_part_id && localStorage.getItem('wiareport_part_' + team.team_id) === null) localStorage.setItem('wiareport_part_' + team.team_id, team.member_part_id); verifiedTeam = team; setCurrentTeam(team); }
    }).catch((err) => {
      if (active) { verifiedTeam = null; setError(err.message); }
    }).finally(() => { if (active) setSessionReady(true); });
    return () => { active = false; };
  }, []);
  const [partsConfig, setPartsConfig] = useState({ enabled: false, parts: [] });
  const selectedPartId = currentTeam?.team_id ? localStorage.getItem('wiareport_part_' + currentTeam.team_id) || '' : '';
  const selectedPart = partsConfig.enabled ? partsConfig.parts.find((part) => part.part_id === selectedPartId) : null;
  function changePart(partId, nextPage = activePage) {
    localStorage.setItem('wiareport_part_' + currentTeam.team_id, partId);
    sessionStorage.setItem('wiareport_scope_page', nextPage);
    window.dispatchEvent(new Event('wiareport-part-change'));
  }
  useEffect(() => {
    if (!currentTeam?.team_id || currentTeam.account_role === 'admin') return;
    let active = true;
    request(`/api/teams/${currentTeam.team_id}/parts`).then((config) => {
      if (!active) return;
      setPartsConfig(config);
      if (selectedPartId && (!config.enabled || !config.parts.some((part) => part.part_id === selectedPartId))) changePart('');
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [currentTeam?.team_id]);
  async function toggleParts(enabled) {
    await request(`/api/teams/${currentTeam.team_id}/parts/settings`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    changePart('', 'part-management');
  }
  async function reorderProjects(projectIds, expectedIds) {
    try {
      const rows = await request(`/api/teams/${currentTeam.team_id}/team-projects/order`, {
        method: 'PUT', body: JSON.stringify({ project_ids: projectIds, expected_ids: expectedIds }),
      });
      setTeamProjects(rows);
      loadProjects(selectedProjectId, currentTeam.team_id).catch((err) => setError(err.message));
    } catch (err) {
      await loadTeamProjects(currentTeam.team_id).catch(() => {});
      throw err;
    }
  }
  async function createPart(name) {
    setPartsConfig(await request(`/api/teams/${currentTeam.team_id}/parts`, { method: 'POST', body: JSON.stringify({ name }) }));
  }
  async function renamePart(partId, name) {
    setPartsConfig(await request(`/api/teams/${currentTeam.team_id}/parts/${partId}`, { method: 'PUT', body: JSON.stringify({ name }) }));
  }
  async function deletePart(partId) {
    await request(`/api/teams/${currentTeam.team_id}/parts/${partId}`, { method: 'DELETE' });
    if (partId === selectedPartId) changePart('', 'part-management');
    else setPartsConfig(await request(`/api/teams/${currentTeam.team_id}/parts`));
  }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [milestoneDraft, setMilestoneDraft] = useState({ title: '', start_date: todayIso(), end_date: plusDays(todayIso(), 14) });
  const [weeklyReports, setWeeklyReports] = useState([]);
  const [completedWeeklyReports, setCompletedWeeklyReports] = useState([]);
  const [weeklyReportDraft, setWeeklyReportDraft] = useState({ start_date: todayIso(), end_date: plusDays(todayIso(), 7) });
  const [isWeeklyReportModalOpen, setIsWeeklyReportModalOpen] = useState(false);
  const [isWeeklyScheduleModalOpen, setIsWeeklyScheduleModalOpen] = useState(false);
  const [weeklyScheduleDraft, setWeeklyScheduleDraft] = useState(DEFAULT_REPORT_SCHEDULE);
  const [weeklyWarningMessage, setWeeklyWarningMessage] = useState('');
  const [authorizationTarget, setAuthorizationTarget] = useState(null);
  const [weeklyWritingEntry, setWeeklyWritingEntry] = useState(null);
  const [weeklyEntryProjects, setWeeklyEntryProjects] = useState([]);
  const [selectedWeeklyEntryId, setSelectedWeeklyEntryId] = useState('');
  const [weeklyEntryDraft, setWeeklyEntryDraft] = useState(emptyWeeklyEntryDraft());
  const [weeklyDateCheckOn, setWeeklyDateCheckOn] = useState(false);
  const [weeklyReportPreview, setWeeklyReportPreview] = useState(null);
  const [teamDraft, setTeamDraft] = useState({ department: '', login_id: '', account_role: 'user' });
  const [overview, setOverview] = useState(null);
  const [overviewPeriod, setOverviewPeriod] = useState('7');
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [memberDraft, setMemberDraft] = useState({ name: '', role: 'M' });
  const [teamProjectDraft, setTeamProjectDraft] = useState({ project_name: '', leaderId: '', memberIds: [] });
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [editingTeamProjectId, setEditingTeamProjectId] = useState(null);
  const [projectAssignmentDrafts, setProjectAssignmentDrafts] = useState({});
  const [draggingMemberId, setDraggingMemberId] = useState(null);
  const [loginDraft, setLoginDraft] = useState(emptyFormFields('login_id'));
  const loginFormRef = useRef(null);
  const entryFormRef = useRef(null);
  const [isUsageGuideOpen, setIsUsageGuideOpen] = useState(() => new URLSearchParams(window.location.search).get('guide') === '1');
  const [isAccountUpdateOpen, setIsAccountUpdateOpen] = useState(false);
  const [loginNeedsChange, setLoginNeedsChange] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [weeklyNeedsChange, setWeeklyNeedsChange] = useState(false);
  useEffect(() => {
    const expired = () => {
      verifiedTeam = null;
      localStorage.removeItem('wiareport_team');
      setCurrentTeam(null);
      setError('로그인이 만료되었습니다. 다시 로그인하세요.');
    };
    window.addEventListener('wiareport-session-expired', expired);
    return () => window.removeEventListener('wiareport-session-expired', expired);
  }, []);


  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const weeklyReport = weeklyReports[0] || null;
  const selectedTeamProject = teamProjects.find((project) => project.project_id === selectedProjectId) || null;
  const isAdminAccount = currentTeam?.account_role === 'admin';

  useEffect(() => {
    if (!currentTeam) return;
    const timer = setInterval(() => request('/api/auth/heartbeat', {method: 'POST'}).catch(() => {}), 60_000);
    return () => clearInterval(timer);
  }, [currentTeam?.actor_user_id]);

  useEffect(() => {
    if (isAdminAccount && activePage !== 'accounts' && activePage !== 'admin-overview') {
      setActivePage('admin-overview');
      return;
    }
    if (!isAdminAccount && (activePage === 'accounts' || activePage === 'admin-overview')) {
      setActivePage('tasks');
    }
  }, [isAdminAccount, activePage]);

  async function loadProjects(nextProjectId, teamId = currentTeam?.team_id) {
    if (!teamId) {
      setProjects([]);
      setSelectedProjectId(null);
      return null;
    }
    const list = await request(`/api/teams/${teamId}/timeline-projects?all_projects=${activePage !== 'tasks' || showAllProjects}`);
    setProjects(list);
    const fallbackId = list[0]?.id || null;
    const currentStillExists = selectedProjectId && list.some((project) => project.id === selectedProjectId);
    const id = nextProjectId !== undefined ? nextProjectId : currentStillExists ? selectedProjectId : fallbackId;
    setSelectedProjectId(id);
    if (!id) setMilestones([]);
    return id;
  }

  useEffect(() => {
    if (currentTeam && !isAdminAccount) loadProjects(undefined).then(loadMilestones).catch(err => setError(err.message));
  }, [showAllProjects, activePage, currentTeam?.team_id]);

  async function loadMilestones(projectId) {
    if (!projectId) {
      setMilestones([]);
      return;
    }
    const list = await request(`/api/projects/${projectId}/milestones`);
    const details = await Promise.all(list.map((item) => request(`/api/milestones/${item.id}`)));
    setMilestones(details);
  }

  async function loadTeams() {
    if (!currentTeam?.actor_user_id || !isAdminAccount) {
      setTeams([]);
      return;
    }
    const list = await request('/api/teams');
    setTeams(list);
  }

  async function loadMembers(teamId = currentTeam?.team_id) {
    if (!teamId) {
      setMembers([]);
      return;
    }
    const list = await request(`/api/teams/${teamId}/users`);
    setMembers(list);
  }

  async function loadTeamProjects(teamId = currentTeam?.team_id) {
    if (!teamId) {
      setTeamProjects([]);
      return;
    }
    const list = await request(`/api/teams/${teamId}/team-projects`);
    setTeamProjects(list);
    setProjectAssignmentDrafts((prev) => {
      const next = { ...prev };
      list.forEach((project) => {
        const leader = project.members.find((member) => member.role === 'L');
        next[project.project_id] = {
          leaderId: next[project.project_id]?.leaderId ?? leader?.user_id ?? '',
          memberIds: next[project.project_id]?.memberIds ?? project.members.filter((member) => member.role === 'M').map((member) => member.user_id),
        };
      });
      return next;
    });
  }

  async function loadWeeklyReport(teamId = currentTeam?.team_id) {
    if (!teamId) {
      setWeeklyReports([]);
      setCompletedWeeklyReports([]);
      return;
    }
    const [reports, archive] = await Promise.all([
      request(`/api/teams/${teamId}/reports/active-list`),
      request(`/api/teams/${teamId}/reports/archive`),
    ]);
    setWeeklyReports(reports || []);
    setCompletedWeeklyReports(archive || []);
  }

  async function loadWeeklySchedule(teamId = currentTeam?.team_id) {
    if (!teamId) {
      setWeeklyScheduleDraft(DEFAULT_REPORT_SCHEDULE);
      return;
    }
    const schedule = await request("/api/teams/" + teamId + "/report-schedule");
    setWeeklyScheduleDraft({ ...DEFAULT_REPORT_SCHEDULE, ...schedule });
  }

  function updateWeeklyReportState(report) {
    if (!report?.report_id) return;
    setWeeklyReports((prev) => prev.map((item) => (item.report_id === report.report_id ? report : item)));
  }

  async function refresh(projectId) {
    setError('');
    const id = await loadProjects(projectId, currentTeam?.team_id);
    await Promise.all([
      loadMilestones(id),
      currentTeam?.team_id ? loadMembers(currentTeam.team_id) : Promise.resolve(),
      currentTeam?.team_id ? loadTeamProjects(currentTeam.team_id) : Promise.resolve(),
      currentTeam?.team_id ? loadWeeklyReport(currentTeam.team_id) : Promise.resolve(),
      currentTeam?.team_id ? loadWeeklySchedule(currentTeam.team_id) : Promise.resolve(),
    ]);
  }

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let active = true;
    setTeams([]);
    if (currentTeam?.actor_user_id && isAdminAccount) {
      request('/api/teams').then((list) => { if (active) setTeams(list); })
        .catch((err) => { if (active) setError(err.message); });
    }
    return () => { active = false; };
  }, [currentTeam?.actor_user_id, isAdminAccount]);

  useEffect(() => {
    if (!selectedProjectId) return;
    loadMilestones(selectedProjectId).catch((err) => setError(err.message));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!sessionReady) return;
    verifiedTeam = currentTeam;
    if (currentTeam) localStorage.setItem('wiareport_team', JSON.stringify(currentTeam));
    else localStorage.removeItem('wiareport_team');
  }, [currentTeam, sessionReady]);

  useEffect(() => {
    if (!currentTeam?.team_id) return;
    Promise.all([
      loadMembers(currentTeam.team_id),
      loadTeamProjects(currentTeam.team_id),
      loadWeeklyReport(currentTeam.team_id),
      loadWeeklySchedule(currentTeam.team_id),
      loadProjects(undefined, currentTeam.team_id).then((projectId) => loadMilestones(projectId)),
    ]).catch((err) => setError(err.message));
  }, [currentTeam?.team_id]);

  async function logout() {
    try { await request('/api/auth/logout', {method:'POST'}); platformLogin(); }
    catch (err) { setError(err.message); }
  }


  async function loadOverview(period = overviewPeriod) {
    setOverviewLoading(true);
    try {
      const data = await request(`/api/admin/overview?period=${encodeURIComponent(period)}`);
      setOverview(data);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setOverviewLoading(false);
    }
  }




  async function createTeamProject() {
    if (!currentTeam?.team_id || !teamProjectDraft.project_name.trim() || !teamProjectDraft.leaderId) return;
    const memberIds = (teamProjectDraft.memberIds || []).filter((userId) => userId && userId !== teamProjectDraft.leaderId);
    const payload = {
      project_name: teamProjectDraft.project_name.trim(),
      status: teamProjectDraft.status || 'in_progress',
      members: [
        ...(teamProjectDraft.leaderId ? [{ user_id: teamProjectDraft.leaderId, role: 'L' }] : []),
        ...memberIds.map((userId) => ({ user_id: userId, role: 'M' })),
      ],
    };
    try {
      if (editingTeamProjectId) {
        await request(`/api/team-projects/${editingTeamProjectId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await request(`/api/teams/${currentTeam.team_id}/team-projects`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setTeamProjectDraft({ project_name: '', leaderId: '', memberIds: [], status: 'in_progress' });
      setEditingTeamProjectId(null);
      setIsProjectModalOpen(false);
      await loadTeamProjects(currentTeam.team_id);
      const projectId = await loadProjects(undefined, currentTeam.team_id);
      await loadMilestones(projectId);
    } catch (err) {
      setError(err.message);
    }
  }

  function openTeamProjectEditor(project) {
    const leader = project.members.find((member) => member.role === 'L');
    setTeamProjectDraft({
      project_name: project.project_name,
      leaderId: leader?.user_id || '',
      memberIds: project.members.filter((member) => member.role === 'M').map((member) => member.user_id),
      status: project.status || 'in_progress',
    });
    setEditingTeamProjectId(project.project_id);
    setIsProjectModalOpen(true);
  }

  async function updateTeamProjectStatus(projectId, status) {
    try {
      await request(`/api/team-projects/${projectId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      await loadTeamProjects(currentTeam.team_id);
      const nextProjectId = await loadProjects(undefined, currentTeam.team_id);
      await loadMilestones(nextProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveProjectMembers(projectId) {
    const draft = projectAssignmentDrafts[projectId] || { leaderId: '', memberIds: [] };
    const memberIds = (draft.memberIds || []).filter((userId) => userId && userId !== draft.leaderId);
    const payloadMembers = [
      ...(draft.leaderId ? [{ user_id: draft.leaderId, role: 'L' }] : []),
      ...memberIds.map((userId) => ({ user_id: userId, role: 'M' })),
    ];
    try {
      await request(`/api/team-projects/${projectId}/members`, {
        method: 'PUT',
        body: JSON.stringify({ members: payloadMembers }),
      });
      await loadTeamProjects(currentTeam.team_id);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteTeamProject(projectId) {
    try {
      await request(`/api/team-projects/${projectId}`, { method: 'DELETE' });
      setProjectAssignmentDrafts((prev) => {
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
      if (editingTeamProjectId === projectId) {
        setEditingTeamProjectId(null);
        setIsProjectModalOpen(false);
      }
      await loadTeamProjects(currentTeam.team_id);
      const nextProjectId = await loadProjects(undefined, currentTeam.team_id);
      await loadMilestones(nextProjectId);
    } catch (err) {
      setError(err.message);
    }
  }






  async function createMilestone() {
    if (!selectedProjectId || !milestoneDraft.title.trim()) {
      setAddingMilestone(false);
      return;
    }
    try {
      await request(`/api/projects/${selectedProjectId}/milestones`, {
        method: 'POST',
        body: JSON.stringify({
          title: milestoneDraft.title.trim(),
          description: '',
          start_date: milestoneDraft.start_date,
          end_date: milestoneDraft.end_date,
        }),
      });
      setMilestoneDraft({ title: '', start_date: todayIso(), end_date: plusDays(todayIso(), 14) });
      setAddingMilestone(false);
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateMilestone(milestone, draft) {
    if (!draft.title.trim()) return;
    try {
      await request(`/api/milestones/${milestone.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: draft.title.trim(),
          description: '',
          start_date: draft.start_date,
          end_date: draft.end_date,
        }),
      });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteMilestone(id) {
    try {
      await request(`/api/milestones/${id}`, { method: 'DELETE' });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function reorderEpics(milestoneId, epicIds) {
    const saved = await request(`/api/milestones/${milestoneId}/epics/order`, {
      method: 'PUT', body: JSON.stringify({ epic_ids: epicIds }),
    });
    setMilestones((prev) => prev.map((item) => item.id === milestoneId ? saved : item));
  }

  async function createEpic(milestone, draft) {
    if (!draft.name.trim()) return;
    try {
      const accent = accentFor(milestone.epics.length);
      await request(`/api/milestones/${milestone.id}/epics`, {
        method: 'POST',
        body: JSON.stringify({
          title: draft.name.trim(),
          owner: draft.owner.trim(),
          status: draft.status || 'planned',
          color: accent.bar,
          start_date: draft.start_date,
          end_date: draft.end_date,
        }),
      });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateEpic(epic, draft) {
    if (!draft.name.trim()) return;
    try {
      await request(`/api/epics/${epic.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: draft.name.trim(),
          owner: draft.owner.trim(),
          status: draft.status,
          color: epic.color || accentFor(0).bar,
          start_date: draft.start_date,
          end_date: draft.end_date,
        }),
      });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteEpic(id) {
    try {
      await request(`/api/epics/${id}`, { method: 'DELETE' });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createWeeklyReportPeriod() {
    if (!currentTeam?.team_id) return;
    if (!weeklyReportDraft.start_date || !weeklyReportDraft.end_date) {
      setError('보고 기간을 입력하세요');
      return;
    }
    if (weeklyReportDraft.end_date < weeklyReportDraft.start_date) {
      setError('종료일은 시작일 이후여야 합니다');
      return;
    }
    try {
      const report = await request(`/api/teams/${currentTeam.team_id}/reports`, {
        method: 'POST',
        body: JSON.stringify(weeklyReportDraft),
      });
      setWeeklyReports((prev) => [report, ...prev.filter((item) => item.report_id !== report.report_id)]);
      setIsWeeklyReportModalOpen(false);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveWeeklyReportSchedule() {
    if (!currentTeam?.team_id) return;
    const payload = {
      enabled: Boolean(weeklyScheduleDraft.enabled),
      weekday: Number(weeklyScheduleDraft.weekday),
      time: weeklyScheduleDraft.time || DEFAULT_REPORT_SCHEDULE.time,
      interval_days: clampIntervalDays(weeklyScheduleDraft.interval_days),
    };
    try {
      const schedule = await request("/api/teams/" + currentTeam.team_id + "/report-schedule", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const nextSchedule = { ...DEFAULT_REPORT_SCHEDULE, ...schedule };
      setWeeklyScheduleDraft(nextSchedule);
      setCurrentTeam((prev) => prev ? {
        ...prev,
        report_schedule_enabled: nextSchedule.enabled,
        report_schedule_weekday: nextSchedule.weekday,
        report_schedule_time: nextSchedule.time,
        report_schedule_interval_days: nextSchedule.interval_days,
      } : prev);
      setIsWeeklyScheduleModalOpen(false);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateWeeklyReportPeriod(report, dates) {
    const updated = await request(`/api/reports/${report.report_id}/period`, {
      method: 'PUT',
      body: JSON.stringify({ ...dates, expected_start_date: report.start_date, expected_end_date: report.end_date }),
    });
    setWeeklyReports((prev) => prev.map((item) => item.report_id === updated.report_id ? updated : item)
      .sort((a, b) => b.start_date.localeCompare(a.start_date) || b.end_date.localeCompare(a.end_date)));
    setCompletedWeeklyReports((prev) => prev.map((item) => item.report_id === updated.report_id ? { ...item, start_date: updated.start_date, end_date: updated.end_date } : item)
      .sort((a, b) => b.end_date.localeCompare(a.end_date) || b.start_date.localeCompare(a.start_date)));
  }

  async function deleteWeeklyReport(reportId) {
    if (!reportId) return;
    try {
      await request(`/api/reports/${reportId}`, { method: 'DELETE' });
      setWeeklyReports((prev) => prev.filter((report) => report.report_id !== reportId));
      setAuthorizationTarget(null);
      entryFormRef.current?.reset();
      closeWeeklyEntryModal();
      setWeeklyReportPreview(null);
      setError('');
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  }

  async function completeWeeklyReport(reportId) {
    if (!reportId) return;
    try {
      await request(`/api/reports/${reportId}/complete`, { method: 'PUT' });
      await loadWeeklyReport();
      setAuthorizationTarget(null);
      entryFormRef.current?.reset();
      closeWeeklyEntryModal();
      setWeeklyReportPreview(null);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function reopenWeeklyReport(reportId) {
    const report = await request(`/api/reports/${reportId}/reopen`, { method: 'PUT' });
    setWeeklyReports((prev) => [report, ...prev.filter((item) => item.report_id !== reportId)]);
    setCompletedWeeklyReports((prev) => prev.filter((item) => item.report_id !== reportId));
  }

  async function toggleWeeklyAbsence(report, member) {
    if (!report?.report_id) return;
    try {
      const updatedReport = await request(`/api/reports/${report.report_id}/users/${member.user_id}/absence`, { method: 'PUT' });
      updateWeeklyReportState(updatedReport);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function openWeeklyReportPreview(report, member) {
    if (!report?.report_id || member.status !== 'done') return;
    try {
      const result = await request(`/api/reports/${report.report_id}/users/${member.user_id}/html-report`);
      setWeeklyReportPreview({ member, html: result.html || '' });
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function openEntryAuthorization(report, entry) {
    if (entry.user_id !== currentTeam?.member_id) return;
    try {
      const result = await request(`/api/reports/${report.report_id}/users/${entry.user_id}/authorize`, {method:'POST'});
      const nextProjects = result.projects || [];
      const first = nextProjects.find(p => !p.is_excluded && p.project_name !== OTHER_WORK_PROJECT_NAME) || nextProjects.find(p => !p.is_excluded) || null;
      setWeeklyEntryProjects(nextProjects);
      setSelectedWeeklyEntryId(first?.project_id || '');
      setWeeklyWritingEntry({...entry,report_id:report.report_id,report_period:`${report.start_date} ~ ${report.end_date}`});
      setWeeklyEntryDraft(first ? weeklyDraftFromProject(first) : emptyWeeklyEntryDraft());
      setError('');
    } catch (err) { setError(err.message); }
  }

  async function reorderWeeklyProjects(entryId, projectIds, expectedIds) {
    if (!entryId) return;
    const result = await request(`/api/report-entries/${entryId}/project-order`, {
      method: 'PUT', body: JSON.stringify({ project_ids: projectIds, expected_ids: expectedIds }),
    });
    setWeeklyEntryProjects((prev) => {
      if (!prev.length || prev[0].entry_id !== entryId) return prev;
      const positions = new Map(result.project_ids.map((id, index) => [id, index]));
      return [...prev].sort((a, b) => (positions.get(a.project_id) ?? Infinity) - (positions.get(b.project_id) ?? Infinity));
    });
  }
  function selectWeeklyProject(project) {
    setSelectedWeeklyEntryId(project.project_id);
    setWeeklyEntryDraft(weeklyDraftFromProject(project));
    setWeeklyDateCheckOn(false);
  }

  async function saveWeeklyEntry(projectId = selectedWeeklyEntryId) {
    const project = weeklyEntryProjects.find((item) => item.project_id === projectId);
    if (!weeklyWritingEntry || !project) return;
    const missingDates = findMissingWeeklyDates(weeklyEntryDraft);
    if (missingDates.progress.length || missingDates.plan.length) {
      setWeeklyDateCheckOn(true);
      return;
    }
    setWeeklyDateCheckOn(false);
    try {
      const payload = compactWeeklyDraft(weeklyEntryDraft);
      const report = await request(`/api/report-entries/${project.entry_id}/projects/${project.project_id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const savedStatus = payload.progress_log.length || payload.risk_issue.length || payload.next_plan.length ? 'done' : 'pending';
      updateWeeklyReportState(report);
      setWeeklyEntryProjects((prev) => prev.map((item) => (item.project_id === project.project_id ? { ...item, ...payload, is_excluded: false, status: savedStatus } : item)));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateWeeklyEntryStatus(projectId, isExcluded) {
    const project = weeklyEntryProjects.find((item) => item.project_id === projectId);
    if (!project) return;
    try {
      const report = await request(`/api/report-entries/${project.entry_id}/projects/${project.project_id}/exclusion`, {
        method: 'PUT',
        body: JSON.stringify({ is_excluded: isExcluded }),
      });
      updateWeeklyReportState(report);
      setWeeklyEntryProjects((prev) => prev.map((item) => (item.project_id === project.project_id ? { ...item, is_excluded: isExcluded, status: isExcluded ? 'excluded' : 'pending', progress_log: isExcluded ? [] : item.progress_log, risk_issue: isExcluded ? [] : item.risk_issue, next_plan: isExcluded ? [] : item.next_plan } : item)));
      if (selectedWeeklyEntryId === project.project_id && isExcluded) {
        setWeeklyEntryDraft(emptyWeeklyEntryDraft());
      }
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  function closeWeeklyEntryModal() {
    setWeeklyWritingEntry(null);
    setWeeklyEntryProjects([]);
    setSelectedWeeklyEntryId('');
    setWeeklyEntryDraft(emptyWeeklyEntryDraft());
    setWeeklyDateCheckOn(false);
  }

  if (!sessionReady) return <div className="empty">로그인 정보를 확인하고 있습니다.</div>;
  if (!currentTeam) return <div className="empty" role="status">{error || '통합 로그인으로 이동하고 있습니다.'}<button type="button" onClick={() => platformLogin()}>통합 로그인</button></div>;

  return (
    <main className="app-shell report-portal-shell">
      <aside className="sidebar">
        <div className="brand">
          <ChartNoAxesCombined size={26} />
          <div>
            <h1>WiaReport</h1>
          </div>
        </div>

        <nav className="side-nav" aria-label="주요 메뉴">
          {!isAdminAccount && <>
          <button className={`side-tab${activePage === 'team-status' ? ' active' : ''}`} type="button" onClick={() => setActivePage('team-status')} aria-current={activePage === 'team-status' ? 'page' : undefined}><LayoutDashboard size={17} aria-hidden="true"/><span>팀 현황</span></button>
          <button className={`side-tab${activePage === 'tasks' ? ' active' : ''}`} type="button" onClick={() => setActivePage('tasks')} aria-current={activePage === 'tasks' ? 'page' : undefined}><FolderKanban size={17} aria-hidden="true"/><span>과제 현황</span></button>
          <button className={`side-tab${activePage === 'weekly-report' ? ' active' : ''}`} type="button" onClick={() => setActivePage('weekly-report')} aria-current={activePage === 'weekly-report' ? 'page' : undefined}><Pencil size={17} aria-hidden="true"/><span>주간 보고 작성</span></button>
          <button className={`side-tab${activePage === 'weekly-lounge' ? ' active' : ''}`} type="button" onClick={() => setActivePage('weekly-lounge')} aria-current={activePage === 'weekly-lounge' ? 'page' : undefined}><Library size={17} aria-hidden="true"/><span>주간 보고 라운지</span></button>
          <button className={'side-tab' + (activePage === 'project-management' ? ' active' : '')} type="button" onClick={() => setActivePage('project-management')} aria-current={activePage === 'project-management' ? 'page' : undefined}><ClipboardList size={17} aria-hidden="true"/><span>과제 관리</span></button>
          <button className={'side-tab' + (activePage === 'part-management' ? ' active' : '')} type="button" onClick={() => setActivePage('part-management')} aria-current={activePage === 'part-management' ? 'page' : undefined}><Users size={17} aria-hidden="true"/><span>파트 관리</span></button>
          </>}
          {isAdminAccount && <button className={`side-tab${activePage === 'admin-overview' ? ' active' : ''}`} type="button" onClick={() => setActivePage('admin-overview')} aria-current={activePage === 'admin-overview' ? 'page' : undefined}><ChartNoAxesCombined size={17} aria-hidden="true"/><span>운영 현황</span></button>}
        </nav>

        {!isAdminAccount && partsConfig.enabled && <label className="side-part-select">
          <span className="side-part-caption">현재 파트</span>
          <span className="side-part-control">
            <Users className="side-part-icon" size={16} aria-hidden="true" />
            <select aria-label="파트 선택" title={selectedPart?.name || '미지정 · 기존 데이터'} value={selectedPartId} onChange={(e) => changePart(e.target.value)}>
              <option value="">미지정 · 기존 데이터</option>
              {partsConfig.parts.map((part) => <option key={part.part_id} value={part.part_id}>{part.name}</option>)}
            </select>
            <ChevronRight className="side-part-chevron" size={14} aria-hidden="true" />
          </span>
        </label>}

        <div className="side-user">
          <div className="avatar">{currentTeam.department.slice(0, 1)}</div>
          <div className="side-user-info">
            <b>{currentTeam.full_name}</b>
            <span>{currentTeam.department}</span>
          </div>

          <button className="side-logout" type="button" onClick={logout} aria-label="로그아웃"><LogOut size={16} /></button>
        </div>
      </aside>

      <div className="report-main">
        <header className="report-topbar">
          <nav className="report-breadcrumb" aria-label="현재 위치"><a href={PLATFORM_ORIGIN + '/'}>AX for Works</a><ChevronRight size={13}/><a href={SERVICE_PREFIX + '/'}>WiaReport</a><ChevronRight size={13}/><strong aria-current="page">{{'team-status':'팀 현황',tasks:'과제 현황','weekly-report':'주간 보고 작성','weekly-lounge':'주간 보고 라운지','project-management':'과제 관리','part-management':'파트 관리','admin-overview':'운영 현황'}[activePage]}</strong></nav>
          <a className="report-platform-return" href={PLATFORM_ORIGIN + '/'}><ArrowLeft size={15}/>AX for Works로 돌아가기</a>
        </header>
      <section className="workspace">
        {error && <div className="error">{error}</div>}
        {!isAdminAccount && partsConfig.enabled && activePage !== 'part-management' && <header className="part-context"><div className="part-context-icon"><Users size={30} aria-hidden="true" /></div><div className="part-context-copy"><span className="part-context-eyebrow">{currentTeam.department} · 현재 파트</span><h1>{selectedPart?.name || '미지정'}</h1><p>멤버 · 과제 · 일정 · 주간보고</p></div></header>}
        {!isAdminAccount && activePage === 'part-management' && <PartManagement teamId={currentTeam.team_id} request={request} onMembersChanged={() => refresh().catch((err) => setError(err.message))} config={partsConfig} onToggle={toggleParts} onCreate={createPart} onRename={renamePart} onDelete={deletePart} />}
        {!isAdminAccount && activePage === 'team-status' && (
          <TeamStatusPage
            currentTeam={currentTeam}
            members={members}
            projects={projects}
            teamProjects={teamProjects}
            weeklyReports={weeklyReports}
          />
        )}
        {!isAdminAccount && activePage === 'tasks' && (
          <>
            <div className="report-task-heading">
              <div className="page-head"><div><span className="report-eyebrow">PROJECT OVERVIEW</span><h1>과제 현황</h1><p>내가 참여한 과제의 진행 상황을 확인하고, 팀의 업무 흐름을 함께 살펴보세요.</p></div></div>
              <div className="project-toolbar" aria-label="과제 선택">
                <label className="report-all-projects"><input type="checkbox" checked={showAllProjects} onChange={e => setShowAllProjects(e.target.checked)} style={{width:16,height:16}}/>전체 과제 보기</label>
                <div className="project-toolbar-meta">
                  <span>{showAllProjects ? '전체 과제' : '참여 과제'}</span>
                  <b>{projects.length}개</b>
                </div>
                <select id="project-select" className="project-select" value={selectedProjectId || ''} onChange={(e) => setSelectedProjectId(e.target.value || null)} aria-label="과제 선택">
                  {projects.length === 0 && <option value="">선택 가능한 과제 없음</option>}
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
                </select>
              </div>
            </div>

            {loading && <div className="empty">불러오는 중</div>}
            {!loading && selectedProject && (
              <>
                <ProjectMemberPanel project={selectedProject} teamProject={selectedTeamProject} />
                <ProjectTimeline
                  project={selectedProject}
                  milestones={milestones}
                  addingMilestone={addingMilestone}
                  setAddingMilestone={setAddingMilestone}
                  milestoneDraft={milestoneDraft}
                  setMilestoneDraft={setMilestoneDraft}
                  onAddMilestone={createMilestone}
                  onUpdateMilestone={updateMilestone}
                  onRemoveMilestone={deleteMilestone}
                  onAddEpic={createEpic}
                  onUpdateEpic={updateEpic}
                  onRemoveEpic={deleteEpic}
                  onReorderEpics={reorderEpics}
                />
                <ProjectProgressHistory project={selectedProject} />
                <ProjectIssueManagement project={selectedProject} />
                <ProjectNextPlan project={selectedProject} />
              </>
            )}
          </>
        )}
        {!isAdminAccount && activePage === 'weekly-report' && (
          <WeeklyReportPage
            teamId={currentTeam.team_id}
            onMembersSaved={loadWeeklyReport}
            currentMemberId={currentTeam.member_id}
            completedWeeklyReports={completedWeeklyReports}
            onReopenWeeklyReport={reopenWeeklyReport}
            members={members}
            weeklyReports={weeklyReports}
            weeklyReportDraft={weeklyReportDraft}
            setWeeklyReportDraft={setWeeklyReportDraft}
            isWeeklyReportModalOpen={isWeeklyReportModalOpen}
            setIsWeeklyReportModalOpen={setIsWeeklyReportModalOpen}
            isWeeklyScheduleModalOpen={isWeeklyScheduleModalOpen}
            setIsWeeklyScheduleModalOpen={setIsWeeklyScheduleModalOpen}
            weeklyScheduleDraft={weeklyScheduleDraft}
            setWeeklyScheduleDraft={setWeeklyScheduleDraft}
            onSaveWeeklyReportSchedule={saveWeeklyReportSchedule}
            onCreateWeeklyReportPeriod={createWeeklyReportPeriod}
            weeklyWarningMessage={weeklyWarningMessage}
            setWeeklyWarningMessage={setWeeklyWarningMessage}
            onUpdateWeeklyReportPeriod={updateWeeklyReportPeriod}
            onDeleteWeeklyReport={deleteWeeklyReport}
            onCompleteWeeklyReport={completeWeeklyReport}
            onToggleWeeklyAbsence={toggleWeeklyAbsence}
            onOpenEntryAuthorization={openEntryAuthorization}
            onOpenWeeklyReportPreview={openWeeklyReportPreview}
            weeklyReportPreview={weeklyReportPreview}
            setWeeklyReportPreview={setWeeklyReportPreview}
            authorizationTarget={authorizationTarget}
            entryFormRef={entryFormRef}
            weeklyNeedsChange={weeklyNeedsChange}
            setAuthorizationTarget={setAuthorizationTarget}
            weeklyWritingEntry={weeklyWritingEntry}
            onReorderWeeklyProjects={reorderWeeklyProjects}
            weeklyEntryProjects={weeklyEntryProjects}
            weeklyEntryDraft={weeklyEntryDraft}
            weeklyDateCheckOn={weeklyDateCheckOn}
            setWeeklyEntryDraft={setWeeklyEntryDraft}
            selectedWeeklyEntryId={selectedWeeklyEntryId}
            onSelectWeeklyProject={selectWeeklyProject}
            onSaveWeeklyEntry={saveWeeklyEntry}
            onUpdateWeeklyEntryStatus={updateWeeklyEntryStatus}
            onCloseWeeklyEntryModal={closeWeeklyEntryModal}
          />
        )}
        {!isAdminAccount && activePage === 'weekly-lounge' && <WeeklyReportLoungePage currentTeam={currentTeam} />}
        {!isAdminAccount && activePage === 'project-management' && (
          <TeamManagementPage
            activeTeamTab="tasks"
            showTabs={false}
            setActiveTeamTab={setActiveTeamTab}
            currentTeam={currentTeam}
            members={members}
            teamProjects={teamProjects}
            teamProjectDraft={teamProjectDraft}
            setTeamProjectDraft={setTeamProjectDraft}
            isProjectModalOpen={isProjectModalOpen}
            setIsProjectModalOpen={setIsProjectModalOpen}
            editingTeamProjectId={editingTeamProjectId}
            setEditingTeamProjectId={setEditingTeamProjectId}
            projectAssignmentDrafts={projectAssignmentDrafts}
            setProjectAssignmentDrafts={setProjectAssignmentDrafts}
            memberDraft={memberDraft}
            setMemberDraft={setMemberDraft}
            onCreateTeamProject={createTeamProject}
            onEditTeamProject={openTeamProjectEditor}
            onSaveProjectMembers={saveProjectMembers}
            onUpdateTeamProjectStatus={updateTeamProjectStatus}
            onDeleteTeamProject={deleteTeamProject}
            onReorderProjects={reorderProjects}
            draggingMemberId={draggingMemberId}
            setDraggingMemberId={setDraggingMemberId}
          />
        )}
        {isAdminAccount && activePage === 'admin-overview' && (
          <AdminOverviewPage
            overview={overview}
            loading={overviewLoading}
            period={overviewPeriod}
            setPeriod={setOverviewPeriod}
            onRefresh={() => loadOverview(overviewPeriod)}
          />
        )}

      </section>

      </div>
      {isUsageGuideOpen && <UsageGuideModal onClose={() => setIsUsageGuideOpen(false)} />}
    </main>
  );
}

function UsageGuideModal({ onClose }) {
  return (
    <div className="modal-backdrop usage-guide-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <article className="usage-guide-modal" role="dialog" aria-modal="true" aria-labelledby="usage-guide-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="usage-guide-head">
          <div>
            <span>Markdown Guide</span>
            <h2 id="usage-guide-title">사용 가이드</h2>
          </div>
          <button className="usage-guide-close" type="button" onClick={onClose} aria-label="사용 가이드 닫기"><X size={18} /></button>
        </header>

        <div className="usage-guide-markdown">
          <p className="usage-guide-lead">WiaReport를 처음 세팅하고 주간보고를 완료본으로 확인하기까지의 기본 흐름입니다.</p>

          <ol>
            <li>
              <h3>통합 계정과 파트 배정</h3>
              <p>AX for Works에 로그인하면 통합 계정의 소속 팀으로 연결됩니다.</p>
              <ul>
                <li>팀 멤버는 통합 계정의 현재 팀 소속을 기준으로 자동 반영됩니다.</li>
                <li><strong>파트 관리</strong>에서 팀 멤버와 과제를 파트별로 배정합니다.</li>
                <li>계정 정보와 비밀번호는 AX for Works에서 관리합니다.</li>
              </ul>
            </li>
            <li>
              <h3>새로운 과제 생성</h3>
              <p><strong>과제 관리</strong>에서 과제명을 입력하고 담당 리더와 참여 멤버를 지정합니다.</p>
              <ul>
                <li>리더는 1명을 선택하고, 매니저는 여러 명을 선택할 수 있습니다.</li>
                <li>생성된 과제는 과제 현황과 주간보고 작성 화면에 연결됩니다.</li>
              </ul>
            </li>
            <li>
              <h3>팀 캘린더 작성</h3>
              <p><strong>팀 현황</strong>의 캘린더에서 날짜를 선택해 팀 일정 또는 개인 일정을 등록합니다.</p>
              <ul>
                <li>개인 일정은 휴가, 교육, 출장으로 구분합니다.</li>
                <li>기간 일정은 시작일과 종료일을 지정해 캘린더에 표시합니다.</li>
              </ul>
            </li>
            <li>
              <h3>과제 마일스톤 계획 생성</h3>
              <p><strong>과제 현황</strong>에는 내가 참여한 과제가 먼저 표시됩니다. <strong>전체 과제 보기</strong>를 선택하면 현재 팀·파트의 모든 과제를 볼 수 있습니다.</p>
              <ul>
                <li>마일스톤은 과제의 큰 기간 계획입니다.</li>
                <li>Work는 마일스톤 안에서 추적할 세부 작업입니다.</li>
              </ul>
            </li>
            <li>
              <h3>보고 주간 생성</h3>
              <p><strong>주간 보고 작성</strong>에서 새 보고 주간을 생성합니다.</p>
              <ul>
                <li>시작일과 종료일을 지정하면 팀원별 작성 카드가 생성됩니다.</li>
                <li>진행 중인 보고 주간이 있어도 새 보고 주간을 추가로 개설할 수 있습니다.</li>
              </ul>
            </li>
            <li>
              <h3>개인별 주간 보고 작성</h3>
              <p>내 이름의 카드에서 <strong>작성</strong>을 누른 뒤, 먼저 이번 주에 실제로 진행한 정규 과제를 선택합니다. 선택한 과제만 작성 화면 왼쪽 목록에 배치되고, 과제를 하나씩 눌러 주간 내용을 입력합니다.</p>
              <ul>
                <li>내가 참여 멤버로 지정된 진행 중 과제가 선택 화면에 자동으로 표시됩니다.</li>
                <li>작성 중에도 <strong>과제 다시 선택</strong>을 눌러 이번 주 작성 대상 과제를 언제든지 다시 고를 수 있습니다.</li>
                <li><strong>기타 업무 (교육/출장 등)</strong>는 정규 과제 선택 화면에는 포함되지 않고, 작성 화면의 <strong>기타 (교육, 출장 등) 업무 추가</strong> 버튼으로 별도 추가합니다.</li>
                <li>정규 과제 외 교육, 출장, 회의, 지원 업무처럼 별도 과제로 묶기 어려운 내용을 기타 업무에 입력합니다.</li>
              </ul>
              <div className="usage-guide-format">
                <h4>작성 포맷</h4>
                <dl>
                  <div>
                    <dt>진행 실적</dt>
                    <dd>이번 보고 주간에 실제로 수행한 업무입니다. 업무 내용, 완료/진행중 상태, 수행일을 함께 남깁니다.</dd>
                  </div>
                  <div>
                    <dt>리스크/이슈</dt>
                    <dd>일정 지연, 의사결정 필요, 외부 의존성, 품질 문제처럼 공유가 필요한 위험 요소입니다. 중요도와 함께 작성합니다.</dd>
                  </div>
                  <div>
                    <dt>차주 계획</dt>
                    <dd>다음 보고 주간에 진행할 예정 업무입니다. 실행할 작업과 목표 일정을 적어 다음 주 추적 기준으로 사용합니다.</dd>
                  </div>
                </dl>
              </div>
              <ul>
                <li>모든 과제 입력이 끝나면 작성 완료 상태로 저장합니다.</li>
              </ul>
            </li>
            <li>
              <h3>보고 라운지 확인</h3>
              <p>팀원 작성이 끝나면 보고 주간을 완료하고 <strong>주간 보고 라운지</strong>에서 결과를 확인합니다.</p>
              <ul>
                <li>완료된 보고 주간별로 멤버 리포트를 열람합니다.</li>
                <li>과제 현황 하단에서는 과제 기준의 주간보고 이력도 확인할 수 있습니다.</li>
              </ul>
            </li>
          </ol>
        </div>
      </article>
    </div>
  );
}

function TeamStatusPage({ currentTeam, members, projects, teamProjects, weeklyReports }) {
  const weeklyReport = weeklyReports[0] || null;
  const activeProjects = teamProjects.filter((project) => project.status !== 'done');
  const doneProjects = teamProjects.filter((project) => project.status === 'done');
  const reportEntries = weeklyReport?.members || [];

  return (
    <>
      <section className="team-status-hero" aria-label="팀 현황 환영 메시지">
        <div className="team-status-copy">
          <span className="report-eyebrow">WELCOME TO WIAREPORT</span>
          <h1>{currentTeam.full_name}님, 환영합니다.</h1>
          <p>팀의 과제와 일정을 한눈에 확인하고, 이번 주의 기록과 다음 계획을 함께 이어가세요.</p>
        </div>

      </section>

      <section className="team-status-grid" aria-label="팀 현황 요약">
        <article className="team-status-metric">
          <span>구성원</span>
          <strong>{members.length}</strong>
        </article>
        <article className="team-status-metric">
          <span>진행중 과제</span>
          <strong>{activeProjects.length || projects.length}</strong>
        </article>
        <article className="team-status-metric">
          <span>완료 과제</span>
          <strong>{doneProjects.length}</strong>
        </article>
        <article className="team-status-metric report-period">
          <span>금주 보고</span>
          <strong>{weeklyReport ? `${weeklyReport.start_date} ~ ${weeklyReport.end_date}` : '-'}</strong>
          <p>{weeklyReport ? weeklyCompletionText(reportEntries) : '개설된 보고 주간 없음'}</p>
        </article>
      </section>

      <TeamCalendar currentTeam={currentTeam} members={members} />
    </>
  );
}

function CalendarDayEvents({ iso, events, members, onClose, onOpen }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.querySelector('button')?.focus();
    function handleKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const buttons = [...dialog.querySelectorAll('button')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  const date = toDate(iso);
  return (
    <div className="modal-backdrop calendar-day-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="calendar-day-dialog" role="dialog" aria-modal="true" aria-labelledby="calendar-day-title">
        <div className="calendar-day-head">
          <div className="calendar-event-date-stamp" aria-hidden="true"><span>{date.getMonth() + 1}월</span><strong>{date.getDate()}</strong><small>{DOW[date.getDay()]}요일</small></div>
          <div className="calendar-day-heading"><span>{date.getFullYear()}년 {date.getMonth() + 1}월</span><h2 id="calendar-day-title">{date.getDate()}일 {DOW[date.getDay()]}요일 일정</h2><p>이날의 일정을 한눈에 확인하세요</p></div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="일정 목록 닫기"><X size={18} /></button>
        </div>
        <div className="calendar-day-summary"><strong>전체 일정 <span>{events.length}</span></strong><span>선택하면 상세 보기</span></div>
        <ul className="calendar-day-list">
          {events.map((item) => {
            const meta = calendarEventTypeMeta(item.event_type);
            const participants = item.members?.length ? item.members : members.filter((member) => item.member_ids?.includes(member.user_id));
            return <li key={item.event_id}>
              <button className={`calendar-day-item ${meta.className}`} type="button" onClick={() => onOpen(item)}>
                <span className="calendar-day-item-top"><span className="calendar-day-kind">{meta.label}</span><span className="calendar-day-period">종일</span></span>
                <strong>{item.title}</strong>
                {item.start_date !== item.end_date && <span className="calendar-day-range"><CalendarRange size={13} aria-hidden="true" />{item.start_date} ~ {item.end_date}</span>}
                <span className="calendar-day-item-footer"><span className="calendar-day-members"><User size={14} aria-hidden="true" /><span>{item.event_type === 'team' ? '팀 전체' : (participants.map((member) => [member.name, member.role].filter(Boolean).join(' ')).join(', ') || '참여 인원 없음')}</span></span><ChevronRight className="calendar-day-arrow" size={16} aria-hidden="true" /></span>
              </button>
            </li>;
          })}
        </ul>
      </div>
    </div>
  );
}

function TeamCalendar({ currentTeam, members }) {
  const [monthIso, setMonthIso] = useState(todayIso().slice(0, 7) + '-01');
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [calendarError, setCalendarError] = useState('');
  const [selection, setSelection] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [draft, setDraft] = useState(null);
  const [dayListIso, setDayListIso] = useState(null);

  useEffect(() => {
    if (!currentTeam?.team_id) return;
    setLoadingEvents(true);
    request(`/api/teams/${currentTeam.team_id}/events`)
      .then((list) => {
        setEvents(list);
        setCalendarError('');
      })
      .catch((err) => setCalendarError(err.message))
      .finally(() => setLoadingEvents(false));
  }, [currentTeam?.team_id]);

  const monthStart = useMemo(() => {
    const base = toDate(monthIso);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  }, [monthIso]);

  const monthTitle = `${monthStart.getFullYear()}년 ${monthStart.getMonth() + 1}월`;
  const calendarDays = useMemo(() => {
    const start = new Date(monthStart);
    start.setDate(1 - monthStart.getDay());
    return Array.from({ length: 42 }).map((_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const iso = isoOf(date);
      return {
        iso,
        day: date.getDate(),
        isCurrentMonth: date.getMonth() === monthStart.getMonth(),
        isToday: iso === todayIso(),
      };
    });
  }, [monthStart]);

  function sortEvents(list) {
    return [...list].sort((a, b) => `${a.start_date}${a.created_at || ''}`.localeCompare(`${b.start_date}${b.created_at || ''}`));
  }

  function moveMonth(delta) {
    setDayListIso(null);
    const next = new Date(monthStart);
    next.setMonth(next.getMonth() + delta);
    setMonthIso(isoOf(new Date(next.getFullYear(), next.getMonth(), 1)));
  }

  function normalizeRange(startIso, endIso) {
    return startIso <= endIso ? { start_date: startIso, end_date: endIso } : { start_date: endIso, end_date: startIso };
  }

  function openDraft(startIso, endIso) {
    const range = normalizeRange(startIso, endIso);
    setDraft({
      event_id: null,
      mode: 'edit',
      title: '',
      event_type: 'team',
      start_date: range.start_date,
      end_date: range.end_date,
      member_ids: [],
    });
    setCalendarError('');
  }

  function openEvent(item) {
    setIsSelecting(false);
    setSelection(null);
    setDraft({
      event_id: item.event_id,
      mode: 'view',
      title: item.title || '',
      event_type: item.event_type === 'personal' ? 'vacation' : (item.event_type || 'team'),
      start_date: item.start_date,
      end_date: item.end_date,
      member_ids: item.member_ids || item.members?.map((member) => member.user_id) || [],
    });
    setCalendarError('');
  }

  function beginSelection(iso) {
    setSelection({ start: iso, end: iso });
    setIsSelecting(true);
  }

  function updateSelection(iso) {
    if (!isSelecting || !selection) return;
    setSelection({ ...selection, end: iso });
  }

  function finishSelection(iso) {
    if (!isSelecting) return;
    const startIso = selection?.start || iso;
    setIsSelecting(false);
    setSelection(null);
    openDraft(startIso, iso);
  }

  function isSelected(iso) {
    if (!selection) return false;
    const range = normalizeRange(selection.start, selection.end);
    return range.start_date <= iso && iso <= range.end_date;
  }

  function eventsForDate(iso) {
    return events.filter((item) => item.start_date <= iso && iso <= item.end_date);
  }

  const calendarEventLayout = useMemo(() => {
    const layout = new Map();
    calendarDays.forEach((day) => layout.set(day.iso, []));

    for (let weekStart = 0; weekStart < calendarDays.length; weekStart += 7) {
      const week = calendarDays.slice(weekStart, weekStart + 7);
      const weekFirst = week[0]?.iso;
      const weekLast = week[week.length - 1]?.iso;
      if (!weekFirst || !weekLast) continue;

      const lanes = [];
      const weekEvents = sortEvents(events.filter((item) => item.start_date <= weekLast && item.end_date >= weekFirst));

      week.forEach((day) => layout.set(day.iso, []));

      weekEvents.forEach((item) => {
        const start = item.start_date < weekFirst ? weekFirst : item.start_date;
        const end = item.end_date > weekLast ? weekLast : item.end_date;
        let laneIndex = lanes.findIndex((laneEnd) => laneEnd < start);
        if (laneIndex === -1) {
          laneIndex = lanes.length;
          lanes.push(end);
        } else {
          lanes[laneIndex] = end;
        }

        week.forEach((day) => {
          if (start <= day.iso && day.iso <= end) {
            const slots = layout.get(day.iso) || [];
            while (slots.length <= laneIndex) slots.push(null);
            slots[laneIndex] = item;
            layout.set(day.iso, slots);
          }
        });
      });

      week.forEach((day) => {
        const slots = layout.get(day.iso) || [];
        while (slots.length < lanes.length) slots.push(null);
        layout.set(day.iso, slots);
      });
    }

    return layout;
  }, [calendarDays, events]);

  function setMemberSelected(userId, selected) {
    setDraft((prev) => {
      const ids = new Set(prev.member_ids);
      if (selected) ids.add(userId);
      else ids.delete(userId);
      return { ...prev, member_ids: Array.from(ids) };
    });
  }

  async function saveEvent() {
    if (!draft?.title.trim()) {
      setCalendarError('일정명을 입력하세요');
      return;
    }
    if (draft.end_date < draft.start_date) {
      setCalendarError('종료일은 시작일보다 빠를 수 없습니다');
      return;
    }
    const payload = {
      title: draft.title.trim(),
      event_type: draft.event_type,
      start_date: draft.start_date,
      end_date: draft.end_date,
      member_ids: draft.event_type === 'team' ? [] : draft.member_ids,
    };
    try {
      const saved = await request(draft.event_id ? `/api/team-events/${draft.event_id}` : `/api/teams/${currentTeam.team_id}/events`, {
        method: draft.event_id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      setEvents((prev) => sortEvents(draft.event_id ? prev.map((item) => (item.event_id === saved.event_id ? saved : item)) : [...prev, saved]));
      setDraft(null);
      setCalendarError('');
    } catch (err) {
      setCalendarError(err.message);
    }
  }

  async function deleteEvent() {
    if (!draft?.event_id) return;
    if (!window.confirm('이 일정을 삭제할까요?')) return;
    try {
      await request(`/api/team-events/${draft.event_id}`, { method: 'DELETE' });
      setEvents((prev) => prev.filter((item) => item.event_id !== draft.event_id));
      setDraft(null);
      setCalendarError('');
    } catch (err) {
      setCalendarError(err.message);
    }
  }

  return (
    <section className="team-calendar" aria-label="팀 캘린더">
      <div className="team-calendar-head">
        <div>
          <span>Team Calendar</span>
          <h2>팀 캘린더</h2>
        </div>
        <div className="team-calendar-controls" aria-label="월 이동">
          <button className="team-calendar-nav" type="button" onClick={() => moveMonth(-1)} aria-label="이전 달">◀</button>
          <strong>{monthTitle}</strong>
          <button className="team-calendar-nav" type="button" onClick={() => moveMonth(1)} aria-label="다음 달">▶</button>
        </div>
      </div>
      {calendarError && <div className="team-calendar-alert">{calendarError}</div>}
      <div className="team-calendar-weekdays" aria-hidden="true">
        {DOW.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="team-calendar-grid">
        {calendarDays.map((day) => {
          const dayEvents = eventsForDate(day.iso);
          const dayEventSlots = calendarEventLayout.get(day.iso) || [];
          const hiddenCount = dayEvents.length - dayEventSlots.slice(0, 3).filter(Boolean).length;
          return (
            <div
              key={day.iso}
              className={`team-calendar-day${day.isCurrentMonth ? '' : ' muted'}${day.isToday ? ' today' : ''}${isSelected(day.iso) ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                beginSelection(day.iso);
              }}
              onPointerEnter={() => updateSelection(day.iso)}
              onPointerUp={() => finishSelection(day.iso)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openDraft(day.iso, day.iso);
                }
              }}
            >
              <span className="team-calendar-day-num">{day.day}</span>
              <span className="team-calendar-events">
                {dayEventSlots.slice(0, 3).map((item, laneIndex) => {
                  if (!item) return <span key={`empty-${day.iso}-${laneIndex}`} className="team-calendar-event-placeholder" aria-hidden="true" />;
                  const meta = calendarEventTypeMeta(item.event_type);
                  const isPersonal = PERSONAL_CALENDAR_EVENT_TYPES.includes(item.event_type) || item.event_type === 'personal';
                  const peopleLabel = item.members?.length ? item.members.map((member) => `${member.name} ${member.role}`).join(', ') : '인원 없음';
                  const tooltip = isPersonal ? peopleLabel : item.title;
                  const isMultiDay = item.start_date !== item.end_date;
                  const dayOfWeek = toDate(day.iso).getDay();
                  const startsHere = item.start_date === day.iso || dayOfWeek === 0;
                  const endsHere = item.end_date === day.iso || dayOfWeek === 6;
                  const spanClass = isMultiDay ? `${startsHere ? ' span-start' : ' span-mid'}${endsHere ? ' span-end' : ''}` : ' span-single';
                  return (
                    <button
                      key={`${item.event_id}-${laneIndex}`}
                      className={`team-calendar-event ${meta.className}${spanClass}`}
                      type="button"
                      title={tooltip}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        openEvent(item);
                      }}
                    >
                      <b>{startsHere || !isMultiDay ? item.title : ''}</b>
                      <small>{startsHere || !isMultiDay ? (item.event_type === 'team' ? meta.label : `${meta.label} · ${item.members.length ? `${item.members.length}명` : '인원 없음'}`) : ''}</small>
                    </button>
                  );
                })}
                {hiddenCount > 0 && <button className="team-calendar-more" type="button"
                  aria-label={`${day.iso} 일정 ${dayEvents.length}개 전체 보기, 숨겨진 일정 ${hiddenCount}개`}
                  aria-haspopup="dialog"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation(); e.currentTarget.focus();
                    setIsSelecting(false); setSelection(null); setDayListIso(day.iso);
                  }}>+{hiddenCount}개 더보기</button>}
              </span>
            </div>
          );
        })}
      </div>
      {loadingEvents && <div className="team-calendar-loading">일정을 불러오는 중</div>}

      {dayListIso && !draft && <CalendarDayEvents iso={dayListIso}
        events={sortEvents(eventsForDate(dayListIso))} members={members}
        onClose={() => setDayListIso(null)} onOpen={openEvent} />}

      {draft && (() => {
        const isPersonalDraft = PERSONAL_CALENDAR_EVENT_TYPES.includes(draft.event_type);
        const draftMeta = calendarEventTypeMeta(draft.event_type);
        const selectedMembers = members.filter((member) => draft.member_ids.includes(member.user_id));
        const formatEventDate = (iso) => new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(toDate(iso));
        return (
          <div className="modal-backdrop" role="presentation">
            <div className={`team-calendar-modal${draft.mode === 'view' ? ' calendar-event-view' : ''}`} role="dialog" aria-modal="true" aria-labelledby="team-calendar-title">
              <div className="project-modal-head">
                <div>
                  {draft.mode !== 'view' && <span>Team Schedule</span>}
                  <h2 id="team-calendar-title" className={draft.mode === 'view' ? `calendar-event-kind ${draftMeta.className}` : undefined}>{draft.mode === 'view' ? draftMeta.label : (draft.event_id ? '팀 일정 수정' : '팀 일정 추가')}</h2>
                </div>
                <button className="icon-btn" type="button" onClick={() => setDraft(null)} aria-label="닫기"><X size={16} /></button>
              </div>

              {draft.mode === 'view' ? (
                <div className="team-calendar-detail">
                  <h3>{draft.title}</h3>
                  <div className="calendar-event-sections">
                    <section className="calendar-event-date-section" aria-label="일정 기간">
                      <div className="calendar-event-section-label"><CalendarRange size={16} aria-hidden="true" />일정 기간<span>종일</span></div>
                      <div className="calendar-event-date-content">
                        <div className="calendar-event-date-stamp" aria-hidden="true"><span>{toDate(draft.start_date).getMonth() + 1}월</span><strong>{toDate(draft.start_date).getDate()}</strong><small>{DOW[toDate(draft.start_date).getDay()]}요일</small></div>
                        <div className="calendar-event-date-text">
                          <span>{formatEventDate(draft.start_date)}</span>
                          {draft.start_date !== draft.end_date && <span className="calendar-event-end">~ {formatEventDate(draft.end_date)}</span>}
                        </div>
                      </div>
                    </section>
                    <section className="calendar-event-people-section" aria-label="참여자">
                      <div className="calendar-event-section-label"><User size={16} aria-hidden="true" />참여자<span>{isPersonalDraft ? `${selectedMembers.length}명` : '팀 전체'}</span></div>
                      <div className="calendar-event-roster">
                        {!isPersonalDraft ? <div className="calendar-event-person"><span className="calendar-event-avatar" aria-hidden="true"><User size={18} /></span><div><strong>{currentTeam.department}</strong><small>팀 전체가 함께하는 일정</small></div></div> : selectedMembers.length ? selectedMembers.map((member) => (
                          <div className="calendar-event-person" key={member.user_id}><span className="calendar-event-avatar" aria-hidden="true"><User size={18} /></span><div><strong>{member.name}</strong><small>{member.role}</small></div></div>
                        )) : <span className="calendar-event-unassigned">지정된 참여자가 없습니다</span>}
                      </div>
                    </section>
                  </div>
                </div>
              ) : (
                <div className="team-calendar-form">
                  <label>
                    일정명
                    <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="예: 고객사 점검, 내부 리뷰" autoFocus />
                  </label>
                  <div className="team-calendar-scope" role="group" aria-label="일정 범위">
                    <button className={draft.event_type === 'team' ? 'team active' : 'team'} type="button" onClick={() => setDraft({ ...draft, event_type: 'team', member_ids: [] })}>팀 일정</button>
                    <button className={isPersonalDraft ? 'personal active' : 'personal'} type="button" onClick={() => setDraft({ ...draft, event_type: isPersonalDraft ? draft.event_type : 'vacation', member_ids: draft.member_ids })}>개인 일정</button>
                  </div>
                  {isPersonalDraft && (
                    <div className="team-calendar-subtype" role="group" aria-label="개인 일정 유형">
                      {PERSONAL_CALENDAR_EVENT_TYPES.map((type) => {
                        const meta = calendarEventTypeMeta(type);
                        return (
                          <button
                            key={type}
                            className={`${meta.className}${draft.event_type === type ? ' active' : ''}`}
                            type="button"
                            onClick={() => setDraft({ ...draft, event_type: type, member_ids: draft.member_ids })}
                          >
                            {meta.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="team-calendar-date-row">
                    <label>
                      시작일
                      <input type="date" value={draft.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} />
                    </label>
                    <label>
                      종료일
                      <input type="date" value={draft.end_date} onChange={(e) => setDraft({ ...draft, end_date: e.target.value })} />
                    </label>
                  </div>
                  {isPersonalDraft && (
                    <>
                      <div className="team-calendar-people-head">
                        <strong>참여 인원</strong>
                        <div>
                          <button type="button" onClick={() => setDraft({ ...draft, member_ids: members.map((member) => member.user_id) })}>전체 선택</button>
                          <button type="button" onClick={() => setDraft({ ...draft, member_ids: [] })}>선택 해제</button>
                        </div>
                      </div>
                      <div className="team-calendar-people">
                        {members.map((member) => {
                          const selected = draft.member_ids.includes(member.user_id);
                          return (
                            <button key={member.user_id} className={`team-calendar-person${selected ? ' selected' : ''}`} type="button" onClick={() => setMemberSelected(member.user_id, !selected)}>
                              <span className="avatar-mini">{member.name.slice(0, 1)}</span>
                              <b>{member.name}</b>
                              <small>{member.role}</small>
                            </button>
                          );
                        })}
                        {members.length === 0 && <div className="empty team-calendar-empty">선택 가능한 팀원이 없습니다</div>}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className={`project-modal-actions team-calendar-actions${draft.mode === 'view' ? ' view-actions' : ''}`}>
                {draft.mode === 'view' ? (
                  <>
                    <button className="mt-btn danger" type="button" onClick={deleteEvent}><Trash2 size={15} />삭제</button>
                    <button className="mt-btn primary" type="button" onClick={() => setDraft({ ...draft, mode: 'edit' })}><Pencil size={15} />일정 수정</button>
                  </>
                ) : (
                  <>
                    {draft.event_id && <button className="mt-btn danger" type="button" onClick={deleteEvent}>제거</button>}
                    <button className="mt-btn" type="button" onClick={() => draft.event_id ? setDraft({ ...draft, mode: 'view' }) : setDraft(null)}>취소</button>
                    <button className="mt-btn primary" type="button" onClick={saveEvent}>{draft.event_id ? '수정 저장' : '저장'}</button>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}

    </section>
  );
}

function WeeklyReportPage({
  teamId, onMembersSaved,
  currentMemberId,
  completedWeeklyReports,
  onReopenWeeklyReport,
  members,
  weeklyReports,
  weeklyReportDraft,
  setWeeklyReportDraft,
  isWeeklyReportModalOpen,
  setIsWeeklyReportModalOpen,
  isWeeklyScheduleModalOpen,
  setIsWeeklyScheduleModalOpen,
  weeklyScheduleDraft,
  setWeeklyScheduleDraft,
  onSaveWeeklyReportSchedule,
  onCreateWeeklyReportPeriod,
  weeklyWarningMessage,
  setWeeklyWarningMessage,
  onUpdateWeeklyReportPeriod,
  onDeleteWeeklyReport,
  onCompleteWeeklyReport,
  onToggleWeeklyAbsence,
  onOpenEntryAuthorization,
  onOpenWeeklyReportPreview,
  weeklyReportPreview,
  setWeeklyReportPreview,
  authorizationTarget,
  entryFormRef,
  weeklyNeedsChange,
  onAuthorizeWeeklyEntry,
  setAuthorizationTarget,
  weeklyWritingEntry,
  weeklyEntryProjects,
  onReorderWeeklyProjects,
  weeklyEntryDraft,
  weeklyDateCheckOn,
  setWeeklyEntryDraft,
  selectedWeeklyEntryId,
  onSelectWeeklyProject,
  onSaveWeeklyEntry,
  onUpdateWeeklyEntryStatus,
  onCloseWeeklyEntryModal,
}) {
  const [membersOpen, setMembersOpen] = useState(false);
  const activeEntryName = authorizationTarget ? `${authorizationTarget.name} ${authorizationTarget.role}` : '';
  const writingEntryName = weeklyWritingEntry ? `${weeklyWritingEntry.name} ${weeklyWritingEntry.role}` : '';
  const [isWeeklyProjectPickerOpen, setIsWeeklyProjectPickerOpen] = useState(false);
  const [weeklySelectionDraft, setWeeklySelectionDraft] = useState([]);
  const [detailEditor, setDetailEditor] = useState(null);
  const [confluenceEditor, setConfluenceEditor] = useState(null);
  const [periodEditor, setPeriodEditor] = useState(null);
  const [periodBusy, setPeriodBusy] = useState(false);
  const [periodError, setPeriodError] = useState('');
  function openPeriodEditor(report) {
    setPeriodError('');
    setPeriodEditor({ report, start_date: report.start_date, end_date: report.end_date });
  }
  async function saveReportPeriod(event) {
    event.preventDefault();
    if (!periodEditor || periodBusy) return;
    if (!periodEditor.start_date || !periodEditor.end_date) { setPeriodError('시작일과 종료일을 입력해 주세요.'); return; }
    if (periodEditor.start_date > periodEditor.end_date) { setPeriodError('종료일은 시작일과 같거나 이후여야 합니다.'); return; }
    setPeriodBusy(true); setPeriodError('');
    try {
      await onUpdateWeeklyReportPeriod(periodEditor.report, { start_date: periodEditor.start_date, end_date: periodEditor.end_date });
      setPeriodEditor(null);
    } catch (err) { setPeriodError(err.message || '보고 기간을 저장하지 못했습니다.'); }
    finally { setPeriodBusy(false); }
  }
  const [deleteConfirmReport, setDeleteConfirmReport] = useState(null);
  const [isDeletingReport, setIsDeletingReport] = useState(false);
  const [archiveSelection, setArchiveSelection] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveMessage, setArchiveMessage] = useState('');
  const archiveSelectionValid = completedWeeklyReports.some((report) => report.report_id === archiveSelection);
  function archiveCompletionLabel(value) {
    if (!value) return '완료 일시 미기록';
    const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + 'Z');
    if (Number.isNaN(parsed.getTime())) return '완료 일시 미기록';
    return '완료 ' + new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
  }
  async function reopenArchiveSelection() {
    if (!archiveSelectionValid || archiveBusy) return;
    setArchiveBusy(true); setArchiveMessage('');
    try {
      await onReopenWeeklyReport(archiveSelection);
      setArchiveSelection('');
      setArchiveMessage('보고 주간을 다시 열었습니다. 위에서 이어서 작성할 수 있습니다.');
    } catch (err) { setArchiveMessage(err.message || '보고 주간을 열지 못했습니다.'); }
    finally { setArchiveBusy(false); }
  }

  const weeklyMissingDates = useMemo(
    () => (weeklyDateCheckOn ? findMissingWeeklyDates(weeklyEntryDraft) : { progress: [], plan: [] }),
    [weeklyDateCheckOn, weeklyEntryDraft],
  );
  const weeklyMissingDateCount = weeklyMissingDates.progress.length + weeklyMissingDates.plan.length;
  const regularWeeklyProjects = weeklyEntryProjects.filter((project) => project.project_name !== OTHER_WORK_PROJECT_NAME);
  const otherWeeklyProject = weeklyEntryProjects.find((project) => project.project_name === OTHER_WORK_PROJECT_NAME) || null;
  const writableWeeklyProjects = weeklyEntryProjects.filter((project) => !project.is_excluded);
  const selectedWeeklyProject = writableWeeklyProjects.find((project) => project.project_id === selectedWeeklyEntryId) || null;
  const weeklySelectionMax = Math.max(regularWeeklyProjects.length, 1);
  const weeklySelectionPercent = Math.round((weeklySelectionDraft.length / weeklySelectionMax) * 100);
  // 저장본과 현재 draft 를 같은 방식(compact)으로 정규화해 비교한다.
  // 공백/날짜 포맷 차이로 인한 오탐이 없고, 저장 성공 시 baseline 이 갱신되어 자동으로 해제된다.
  const weeklyEntryDirty = useMemo(() => {
    if (!selectedWeeklyProject) return false;
    return JSON.stringify(compactWeeklyDraft(weeklyEntryDraft))
      !== JSON.stringify(compactWeeklyDraft(weeklyDraftFromProject(selectedWeeklyProject)));
  }, [weeklyEntryDraft, selectedWeeklyProject]);
  const [pendingLeave, setPendingLeave] = useState(null);
  const [pendingOtherRemove, setPendingOtherRemove] = useState(false);
  // 기타 업무를 뺀 정규 과제 목록과, 추가되어 있는 기타 업무를 분리해서 렌더한다
  const writableRegularProjects = writableWeeklyProjects.filter((project) => project.project_name !== OTHER_WORK_PROJECT_NAME);
  const addedOtherProject = writableWeeklyProjects.find((project) => project.project_name === OTHER_WORK_PROJECT_NAME) || null;
  // 제외는 서버에서 작성 내용과 첨부 이미지를 되돌릴 수 없게 삭제하므로(main.py 의 exclusion 엔드포인트),
  // 지울 내용이 있으면 반드시 확인을 받는다. 저장 전 draft 도 함께 본다.
  const otherProjectHasContent = useMemo(() => {
    if (!addedOtherProject) return false;
    const saved = compactWeeklyDraft(weeklyDraftFromProject(addedOtherProject));
    const live = selectedWeeklyEntryId === addedOtherProject.project_id
      ? compactWeeklyDraft(weeklyEntryDraft)
      : { progress_log: [], risk_issue: [], next_plan: [] };
    return Boolean(saved.progress_log.length || saved.risk_issue.length || saved.next_plan.length
      || live.progress_log.length || live.risk_issue.length || live.next_plan.length);
  }, [addedOtherProject, selectedWeeklyEntryId, weeklyEntryDraft]);

  function requestRemoveOtherProject() {
    if (!addedOtherProject) return;
    if (otherProjectHasContent) { setPendingOtherRemove(true); return; }
    onUpdateWeeklyEntryStatus(addedOtherProject.project_id, true);
  }

  function confirmRemoveOtherProject() {
    setPendingOtherRemove(false);
    if (addedOtherProject) onUpdateWeeklyEntryStatus(addedOtherProject.project_id, true);
  }

  function requestCloseWeeklyEntry() {
    if (weeklyEntryDirty) { setPendingLeave({ type: 'close' }); return; }
    onCloseWeeklyEntryModal();
  }

  function requestSelectWeeklyProject(project) {
    if (project.project_id === selectedWeeklyEntryId) return;
    if (weeklyEntryDirty) { setPendingLeave({ type: 'switch', project }); return; }
    onSelectWeeklyProject(project);
  }

  function confirmPendingLeave() {
    const leave = pendingLeave;
    setPendingLeave(null);
    if (!leave) return;
    if (leave.type === 'close') onCloseWeeklyEntryModal();
    else onSelectWeeklyProject(leave.project);
  }
  const hasWeeklyReports = weeklyReports.length > 0;

  useEffect(() => {
    if (!weeklyWritingEntry) {
      setIsWeeklyProjectPickerOpen(false);
      setWeeklySelectionDraft([]);
      return;
    }
    const selectedProjectIds = regularWeeklyProjects.filter((project) => !project.is_excluded).map((project) => project.project_id);
    setWeeklySelectionDraft(selectedProjectIds);
    setIsWeeklyProjectPickerOpen(regularWeeklyProjects.length > 0 && selectedProjectIds.length === 0);
  }, [weeklyWritingEntry?.report_id, weeklyWritingEntry?.user_id]);

  function toggleWeeklySelectionDraft(projectId) {
    setWeeklySelectionDraft((prev) => (prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]));
  }

  async function applyWeeklyProjectSelection() {
    const selectedIds = new Set(weeklySelectionDraft);
    for (const project of regularWeeklyProjects) {
      const shouldBeExcluded = !selectedIds.has(project.project_id);
      if (project.is_excluded !== shouldBeExcluded) {
        await onUpdateWeeklyEntryStatus(project.project_id, shouldBeExcluded);
      }
    }
    const firstSelectedProject = regularWeeklyProjects.find((project) => selectedIds.has(project.project_id));
    if (firstSelectedProject) onSelectWeeklyProject(firstSelectedProject);
    setIsWeeklyProjectPickerOpen(false);
  }

  async function addOtherWeeklyProject() {
    if (!otherWeeklyProject) return;
    await onUpdateWeeklyEntryStatus(otherWeeklyProject.project_id, false);
    onSelectWeeklyProject(otherWeeklyProject);
  }

  function updateStructuredItem(kind, index, patch) {
    setWeeklyEntryDraft((prev) => ({ ...prev, [kind]: prev[kind].map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)) }));
  }

  function openDetailEditor(kind, index) {
    const item = weeklyEntryDraft[kind][index];
    setDetailEditor({ kind, index, detail: item.detail || "", images: Array.isArray(item.images) ? [...item.images] : [] });
  }

  function saveDetailEditor() {
    if (!detailEditor) return;
    updateStructuredItem(detailEditor.kind, detailEditor.index, { detail: detailEditor.detail, images: detailEditor.images });
    setDetailEditor(null);
  }

  async function addDetailImages(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length || !detailEditor) return;
    if (files.some((file) => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))) {
      window.alert("PNG, JPG, WEBP, GIF 이미지만 첨부할 수 있습니다.");
      return;
    }
    if (files.some((file) => file.size > 5 * 1024 * 1024)) {
      window.alert("이미지는 파일당 5MB 이하로 첨부해 주세요.");
      return;
    }
    const remaining = Math.max(0, 8 - detailEditor.images.length);
    if (!remaining) {
      window.alert("이미지는 항목당 최대 8장까지 첨부할 수 있습니다.");
      return;
    }
    const dataUrls = await Promise.all(files.slice(0, remaining).map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다"));
      reader.readAsDataURL(file);
    })));
    setDetailEditor((prev) => prev ? { ...prev, images: [...prev.images, ...dataUrls] } : prev);
  }

  function openConfluenceEditor(kind, index) {
    const item = weeklyEntryDraft[kind][index];
    setConfluenceEditor({ kind, index, url: item.confluence_url || "" });
  }

  function saveConfluenceEditor() {
    if (!confluenceEditor) return;
    let url = confluenceEditor.url.trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    if (url) {
      try { new URL(url); } catch { window.alert("올바른 URL을 입력해 주세요."); return; }
    }
    updateStructuredItem(confluenceEditor.kind, confluenceEditor.index, { confluence_url: url });
    setConfluenceEditor(null);
  }

  function updateProgressItem(index, key, value) {
    setWeeklyEntryDraft((prev) => ({ ...prev, progress_log: prev.progress_log.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }));
  }

  function addProgressItem() {
    setWeeklyEntryDraft((prev) => ({ ...prev, progress_log: [...prev.progress_log, { log: '', status: 'done', date: '', detail: '', images: [], confluence_url: '' }] }));
  }

  function removeProgressItem(index) {
    setWeeklyEntryDraft((prev) => {
      const next = prev.progress_log.filter((_, i) => i !== index);
      return { ...prev, progress_log: next.length ? next : [{ log: '', status: 'done', date: '', detail: '', images: [], confluence_url: '' }] };
    });
  }

  function updateRiskItem(index, key, value) {
    setWeeklyEntryDraft((prev) => ({ ...prev, risk_issue: prev.risk_issue.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }));
  }

  function addRiskItem() {
    setWeeklyEntryDraft((prev) => ({ ...prev, risk_issue: [...prev.risk_issue, { issue: '', importance: '중', detail: '', images: [], confluence_url: '' }] }));
  }

  function removeRiskItem(index) {
    setWeeklyEntryDraft((prev) => {
      const next = prev.risk_issue.filter((_, i) => i !== index);
      return { ...prev, risk_issue: next.length ? next : [{ issue: '', importance: '중', detail: '', images: [], confluence_url: '' }] };
    });
  }

  function updatePlanItem(index, key, value) {
    setWeeklyEntryDraft((prev) => ({ ...prev, next_plan: prev.next_plan.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }));
  }

  function addPlanItem() {
    setWeeklyEntryDraft((prev) => ({ ...prev, next_plan: [...prev.next_plan, { plan: '', due: '' }] }));
  }

  function removePlanItem(index) {
    setWeeklyEntryDraft((prev) => {
      const next = prev.next_plan.filter((_, i) => i !== index);
      return { ...prev, next_plan: next.length ? next : [{ plan: '', due: '' }] };
    });
  }

  async function confirmWeeklyReportDelete() {
    if (!deleteConfirmReport || isDeletingReport) return;
    setIsDeletingReport(true);
    const deleted = await onDeleteWeeklyReport(deleteConfirmReport.report_id);
    setIsDeletingReport(false);
    if (deleted) setDeleteConfirmReport(null);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="report-eyebrow">WEEKLY REPORT</span><h1>주간 보고 작성</h1><p>한 주의 진행 업무와 이슈, 다음 계획을 내 보고에 정리하세요.</p>
        </div>
        <div className="weekly-page-actions">
          <button className="weekly-schedule-btn" type="button" onClick={() => setMembersOpen(true)}><Users size={16} />멤버 관리</button>
          <button className="weekly-schedule-btn" type="button" onClick={() => setIsWeeklyScheduleModalOpen(true)}><CalendarClock size={16} />개설 스케쥴링</button>
          <button className="weekly-open-btn" type="button" onClick={() => setIsWeeklyReportModalOpen(true)}><Plus size={16} />새 보고 주간 개설</button>
        </div>
      </div>

      {membersOpen && <ReportMembersDialog teamId={teamId} request={request} onClose={() => setMembersOpen(false)} onSaved={onMembersSaved} />}
      {hasWeeklyReports ? (
        weeklyReports.map((weeklyReport, index) => {
          const reportMembers = weeklyReport?.members || [];
          const canCompleteReport = reportMembers.length > 0 && reportMembers.every((member) => member.status === 'done' || member.status === 'absent');
          return (
            <section className="weekly-report-section" key={weeklyReport.report_id}>
              <div className="weekly-report-head">
                <div>
                  <h2>{weeklyReport.start_date} ~ {weeklyReport.end_date}</h2>
                  <p>{weeklyCompletionText(reportMembers)}</p>
                </div>
                <div className="weekly-report-head-actions">
                  <button className="weekly-period-btn" type="button" onClick={() => openPeriodEditor(weeklyReport)}><CalendarRange size={14} />기간 수정</button>
                  <button className="weekly-complete-btn" type="button" disabled={!canCompleteReport} title={canCompleteReport ? '보고를 완료합니다' : '모든 멤버가 작성 완료 또는 부재 상태여야 활성화됩니다'} onClick={() => onCompleteWeeklyReport(weeklyReport.report_id)}>완료</button>
                  <button className="weekly-delete-btn" type="button" onClick={() => setDeleteConfirmReport(weeklyReport)}>삭제</button>
                </div>
              </div>
              <div className="weekly-member-grid">
                {reportMembers.map((member) => (
                  <article className={`weekly-member-card${member.status === 'absent' ? ' absent' : ''}${member.status === 'done' ? ' done' : ''}`} key={`${weeklyReport.report_id}-${member.user_id}`}>
                    <div className="weekly-card-main">
                      <strong>{member.name} {member.role}</strong>
                      <span className={`weekly-status-pill ${member.status || 'pending'}`}>{member.status === 'done' ? '작성 완료' : member.status === 'progress' ? '작성중' : member.status === 'absent' ? '부재' : '대기'}</span>
                    </div>
                    <div className="weekly-card-actions three">
                      <button className={`weekly-card-btn${member.status === 'absent' ? ' active' : ''}`} type="button" disabled={member.user_id !== currentMemberId} onClick={() => onToggleWeeklyAbsence(weeklyReport, member)}>부재</button>
                      <button className="weekly-card-btn primary" type="button" disabled={member.status === 'absent' || member.user_id !== currentMemberId} title={member.user_id === currentMemberId ? '내 주간보고 작성' : '본인만 작성할 수 있습니다'} onClick={() => onOpenEntryAuthorization(weeklyReport, member)}>작성</button>
                      <button className="weekly-card-btn report" type="button" disabled={member.status !== 'done'} title={member.status === 'done' ? '작성 리포트를 봅니다' : '작성 완료 후 리포트를 볼 수 있습니다'} onClick={() => onOpenWeeklyReportPreview(weeklyReport, member)}>리포트</button>
                    </div>
                  </article>
                ))}
                {reportMembers.length === 0 && <div className="empty compact">보고 대상 멤버가 없습니다</div>}
              </div>
            </section>
          );
        })
      ) : (
        <section className="weekly-report-section">
          <div className="weekly-report-head">
            <div>
              <h2>개설된 보고 주간이 없습니다</h2>
              <p>새 보고 주간을 개설하면 보고 대상 멤버가 표시됩니다.</p>
            </div>
          </div>
        </section>
      )}

      <section className="weekly-archive" aria-labelledby="weekly-archive-title">
        <div className="weekly-archive-head">
          <h2 id="weekly-archive-title">완료된 주간보고</h2>
          <div className="weekly-archive-actions">
          <button className="mt-btn" type="button" disabled={!archiveSelectionValid || archiveBusy} onClick={() => openPeriodEditor(completedWeeklyReports.find((report) => report.report_id === archiveSelection))}>기간 수정</button>
          <button className="mt-btn" type="button" disabled={!archiveSelectionValid || archiveBusy} onClick={reopenArchiveSelection}>{archiveBusy ? '여는 중…' : '다시 열기'}</button>
          </div>
        </div>
        {completedWeeklyReports.length ? <select className="weekly-archive-list" size={Math.min(5, Math.max(2, completedWeeklyReports.length))} aria-label="다시 열 주간보고 선택"
          value={archiveSelectionValid ? archiveSelection : ''} disabled={archiveBusy} onChange={(e) => setArchiveSelection(e.target.value)}>
          {completedWeeklyReports.map((report) => <option key={report.report_id} value={report.report_id}>{report.start_date} ~ {report.end_date}　·　{archiveCompletionLabel(report.completed_at)}</option>)}
        </select> : <p className="weekly-archive-empty">완료된 주간보고가 없습니다.</p>}
        {archiveMessage && <p className="weekly-archive-message" role="status">{archiveMessage}</p>}
      </section>

      {periodEditor && (
        <div className="modal-backdrop" role="presentation">
          <form className="weekly-report-modal compact-modal weekly-period-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-period-title" onSubmit={saveReportPeriod} noValidate>
            <div className="project-modal-head"><div><h2 id="weekly-period-title">주간보고 기간 수정</h2><p>작성 내용과 완료 상태는 그대로 유지됩니다.</p></div>
              <button className="icon-button" type="button" disabled={periodBusy} onClick={() => setPeriodEditor(null)} aria-label="기간 수정 닫기"><X size={18} /></button>
            </div>
            <div className="weekly-period-fields">
              <label>시작일<input type="date" value={periodEditor.start_date} disabled={periodBusy} onChange={(e) => setPeriodEditor((prev) => ({ ...prev, start_date: e.target.value }))} autoFocus required /></label>
              <label>종료일<input type="date" value={periodEditor.end_date} disabled={periodBusy} onChange={(e) => setPeriodEditor((prev) => ({ ...prev, end_date: e.target.value }))} required /></label>
            </div>
            {periodError && <p className="error compact" role="alert">{periodError}</p>}
            <div className="project-modal-actions"><button className="mt-btn" type="button" disabled={periodBusy} onClick={() => setPeriodEditor(null)}>취소</button><button className="mt-btn primary" type="submit" disabled={periodBusy}>{periodBusy ? '저장 중…' : '저장'}</button></div>
          </form>
        </div>
      )}

      {deleteConfirmReport && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-report-modal compact-modal weekly-delete-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="weekly-delete-confirm-title" aria-describedby="weekly-delete-confirm-description">
            <div className="weekly-delete-confirm-icon" aria-hidden="true"><AlertTriangle size={24} /></div>
            <div className="weekly-delete-confirm-copy">
              <h2 id="weekly-delete-confirm-title">이 보고 주간을 삭제할까요?</h2>
              <p className="weekly-delete-period">{deleteConfirmReport.start_date} ~ {deleteConfirmReport.end_date}</p>
              <p id="weekly-delete-confirm-description">이 주간에 멤버들이 작성한 모든 보고 내용이 영구적으로 사라집니다.</p>
              <ul>
                <li>Progress Log, Risk & Issue, Next Plan</li>
                <li>상세 작성 내용과 첨부 이미지</li>
                <li>연결된 Confluence 링크</li>
              </ul>
              <p>삭제한 회차는 자동으로 다시 생성되지 않습니다. 필요하면 새 보고 주간을 직접 개설할 수 있습니다.</p>
              <strong>삭제 후에는 복구할 수 없습니다.</strong>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" disabled={isDeletingReport} onClick={() => setDeleteConfirmReport(null)}>취소</button>
              <button className="mt-btn weekly-delete-confirm-btn" type="button" disabled={isDeletingReport} onClick={confirmWeeklyReportDelete}>{isDeletingReport ? "삭제 중..." : "보고 주간 삭제"}</button>
            </div>
          </div>
        </div>
      )}

      {isWeeklyScheduleModalOpen && (() => {
        const scheduleEnabled = !!weeklyScheduleDraft.enabled;
        const scheduleTime = weeklyScheduleDraft.time || DEFAULT_REPORT_SCHEDULE.time;
        const scheduleInterval = clampIntervalDays(weeklyScheduleDraft.interval_days);
        const nextRun = nextScheduleRun(weeklyScheduleDraft.weekday, scheduleTime);
        const nextEnd = new Date(nextRun);
        nextEnd.setDate(nextEnd.getDate() + scheduleInterval - 1);
        return (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setIsWeeklyScheduleModalOpen(false)}>
          <div className="weekly-report-modal weekly-schedule-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-schedule-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="project-modal-head weekly-schedule-head">
              <div className="weekly-schedule-head-copy">
                <span className="weekly-schedule-head-icon"><CalendarClock size={19} /></span>
                <div>
                  <h2 id="weekly-schedule-title">보고 주간 개설 스케쥴링</h2>
                  <p>설정한 주기에 맞춰 보고 주간이 자동으로 열립니다.</p>
                </div>
              </div>
              <button className="icon-btn" type="button" onClick={() => setIsWeeklyScheduleModalOpen(false)} aria-label="닫기"><X size={16} /></button>
            </div>

            <label className={`weekly-schedule-switch${scheduleEnabled ? " on" : ""}`}>
              <span className="weekly-schedule-switch-icon"><Zap size={16} /></span>
              <span className="weekly-schedule-switch-copy">
                <b>자동 개설 사용</b>
                <small>{scheduleEnabled ? "예약된 시각에 보고 주간이 자동 생성됩니다." : "직접 개설할 때만 보고 주간이 만들어집니다."}</small>
              </span>
              <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setWeeklyScheduleDraft({ ...weeklyScheduleDraft, enabled: e.target.checked })} />
              <span className="weekly-schedule-switch-track" aria-hidden="true"><i /></span>
            </label>

            <fieldset className="weekly-schedule-body" disabled={!scheduleEnabled}>
              <div className="weekly-schedule-field">
                <span className="weekly-schedule-label"><CalendarRange size={13} />개설 요일</span>
                <div className="weekly-schedule-days" role="radiogroup" aria-label="개설 요일">
                  {WEEKDAY_OPTIONS.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      role="radio"
                      aria-checked={Number(weeklyScheduleDraft.weekday) === day.value}
                      className={`weekly-schedule-day${Number(weeklyScheduleDraft.weekday) === day.value ? " active" : ""}${day.value >= 5 ? " weekend" : ""}`}
                      onClick={() => setWeeklyScheduleDraft({ ...weeklyScheduleDraft, weekday: day.value })}
                    >{day.label.charAt(0)}</button>
                  ))}
                </div>
              </div>

              <div className="weekly-schedule-row">
                <div className="weekly-schedule-field">
                  <span className="weekly-schedule-label"><Clock size={13} />개설 시간</span>
                  <input
                    className="weekly-schedule-time"
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setWeeklyScheduleDraft({ ...weeklyScheduleDraft, time: e.target.value })}
                  />
                </div>
                <div className="weekly-schedule-field">
                  <span className="weekly-schedule-label"><CalendarClock size={13} />보고 기간<em>{MIN_INTERVAL_DAYS}~{MAX_INTERVAL_DAYS}일</em></span>
                  <div className="weekly-schedule-interval-input">
                    <input
                      type="number"
                      min={MIN_INTERVAL_DAYS}
                      max={MAX_INTERVAL_DAYS}
                      step={1}
                      inputMode="numeric"
                      aria-label="보고 기간 (일)"
                      value={weeklyScheduleDraft.interval_days ?? ""}
                      onChange={(e) => setWeeklyScheduleDraft({ ...weeklyScheduleDraft, interval_days: e.target.value === "" ? "" : Number(e.target.value) })}
                      onBlur={(e) => setWeeklyScheduleDraft({ ...weeklyScheduleDraft, interval_days: clampIntervalDays(e.target.value) })}
                    />
                    <span>일</span>
                  </div>
                </div>
              </div>
            </fieldset>

            <div className={`weekly-schedule-preview${scheduleEnabled ? "" : " muted"}`}>
              <span className="weekly-schedule-preview-badge">{scheduleEnabled ? "다음 개설 예정" : "사용 안 함"}</span>
              {scheduleEnabled ? (
                <>
                  <strong>{formatKoreanDate(nextRun)} {scheduleTime}</strong>
                  <span>{formatShortDate(nextRun)} ~ {formatShortDate(nextEnd)} ({scheduleInterval}일)의 보고 기간이 한국시간 기준으로 생성됩니다.</span>
                </>
              ) : (
                <>
                  <strong>자동 개설이 꺼져 있습니다</strong>
                  <span>보고 주간은 &lsquo;새 보고 주간 개설&rsquo; 버튼으로만 만들 수 있습니다.</span>
                </>
              )}
            </div>

            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={() => setIsWeeklyScheduleModalOpen(false)}>취소</button>
              <button className="mt-btn primary" type="button" onClick={onSaveWeeklyReportSchedule}><Save size={13} />저장</button>
            </div>
          </div>
        </div>
        );
      })()}

      {isWeeklyReportModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-report-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-report-title">
            <div className="project-modal-head">
              <div>
                <h2 id="weekly-report-title">새 보고 주간 개설</h2>
                <p>멤버별 주간 보고를 작성할 업무 기간을 설정합니다.</p>
              </div>
              <button className="icon-btn" type="button" onClick={() => setIsWeeklyReportModalOpen(false)} aria-label="닫기"><X size={16} /></button>
            </div>
            <div className="weekly-period-fields">
              <label>
                <span>시작일</span>
                <input type="date" value={weeklyReportDraft.start_date} onChange={(e) => setWeeklyReportDraft({ ...weeklyReportDraft, start_date: e.target.value })} />
              </label>
              <label>
                <span>종료일</span>
                <input type="date" value={weeklyReportDraft.end_date} onChange={(e) => setWeeklyReportDraft({ ...weeklyReportDraft, end_date: e.target.value })} />
              </label>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={() => setIsWeeklyReportModalOpen(false)}>취소</button>
              <button className="mt-btn primary" type="button" onClick={onCreateWeeklyReportPeriod}>개설</button>
            </div>
          </div>
        </div>
      )}

      {weeklyWarningMessage && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-report-modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-warning-title">
            <div className="project-modal-head">
              <div>
                <h2 id="weekly-warning-title">확인 필요</h2>
                <p>{weeklyWarningMessage}</p>
              </div>
              <button className="icon-btn" type="button" onClick={() => setWeeklyWarningMessage('')} aria-label="닫기"><X size={16} /></button>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn primary" type="button" onClick={() => setWeeklyWarningMessage('')}>확인</button>
            </div>
          </div>
        </div>
      )}

      {weeklyReportPreview && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-preview-modal" role="dialog" aria-modal="true" aria-label="리포트 미리보기">
            <button className="weekly-preview-close" type="button" onClick={() => setWeeklyReportPreview(null)} aria-label="닫기"><X size={16} /></button>
            <iframe className="weekly-preview-frame" title="주간 업무 리포트" srcDoc={weeklyReportPreview.html} />
          </div>
        </div>
      )}

      {weeklyWritingEntry && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-entry-modal" data-project-order-scroll role="dialog" aria-modal="true" aria-labelledby="weekly-entry-title">
            <div className="project-modal-head weekly-entry-head">
              <div className="weekly-entry-head-copy">
                <span className="weekly-entry-head-icon"><ClipboardList size={19} /></span>
                <div>
                  <h2 id="weekly-entry-title">주간 보고 작성</h2>
                  <p>
                    <b>{writingEntryName}</b>
                    {weeklyWritingEntry.report_period && <><span className="weekly-entry-head-sep">·</span>{weeklyWritingEntry.report_period}</>}
                  </p>
                </div>
              </div>
              <button className="icon-btn" type="button" onClick={requestCloseWeeklyEntry} aria-label="닫기"><X size={16} /></button>
            </div>
            {isWeeklyProjectPickerOpen ? (
              <section className="weekly-project-picker">
                <div className="weekly-project-picker-body">
                  <div className="weekly-project-picker-head">
                    <div>
                      <h3>이번 주 진행 과제 선택</h3>
                      <p>금주에 실제로 진행한 정규 과제를 고르면 작성 화면에 배치됩니다.</p>
                    </div>
                    <div className="weekly-picker-ring" style={{ '--weekly-picker-progress': `${weeklySelectionPercent}%` }} aria-label={`${weeklySelectionDraft.length}개 선택`}>
                      <div>
                        <strong>{weeklySelectionDraft.length}</strong>
                        <span>/ {regularWeeklyProjects.length}</span>
                      </div>
                    </div>
                  </div>
                  <div className="weekly-project-choice-list">
                    {regularWeeklyProjects.map((project, index) => {
                      const checked = weeklySelectionDraft.includes(project.project_id);
                      return (
                        <button className={`weekly-project-choice${checked ? ' selected' : ''}`} type="button" key={`${project.entry_id}-${project.project_id}`} onClick={() => toggleWeeklySelectionDraft(project.project_id)}>
                          <span className="weekly-choice-index">{String(index + 1).padStart(2, '0')}</span>
                          <span className="weekly-choice-copy">
                            <strong>{project.project_name}</strong>
                            <small>{checked ? '작성 화면에 포함됩니다' : '이번 주 진행했다면 선택하세요'}</small>
                          </span>
                          <span className="weekly-choice-check">{checked && <Check size={12} strokeWidth={3} />}</span>
                        </button>
                      );
                    })}
                    {regularWeeklyProjects.length === 0 && <div className="empty compact">참여 중인 진행 과제가 없습니다</div>}
                  </div>
                </div>
                <div className="weekly-project-picker-actions">
                  <button className="mt-btn" type="button" onClick={onCloseWeeklyEntryModal}>닫기</button>
                  <button className="mt-btn primary" type="button" disabled={weeklySelectionDraft.length === 0 && regularWeeklyProjects.length > 0} onClick={applyWeeklyProjectSelection}>선택한 과제 작성하기 ({weeklySelectionDraft.length})</button>
                </div>
              </section>
            ) : (
            <div className="weekly-entry-layout">
              <aside className="weekly-project-list" aria-label="작성 과제">
                <div className="weekly-project-list-head">
                  <strong>작성 과제</strong>
                  <em className="weekly-project-count">{writableRegularProjects.length}</em>
                  <button type="button" onClick={() => setIsWeeklyProjectPickerOpen(true)}>과제 다시 선택</button>
                </div>
                <WeeklyProjectOrderList
                  key={writableRegularProjects[0]?.entry_id || 'empty'}
                  projects={writableRegularProjects}
                  selectedId={selectedWeeklyEntryId}
                  onSelect={requestSelectWeeklyProject}
                  onReorder={(ids, expected) => onReorderWeeklyProjects(writableRegularProjects[0]?.entry_id, ids, expected)}
                />

                {otherWeeklyProject && (
                <div className="weekly-other-section">
                  <div className="weekly-other-divider"><span>기타 업무</span></div>
                  {addedOtherProject ? (
                    <div className={`weekly-other-row${selectedWeeklyEntryId === addedOtherProject.project_id ? ' active' : ''}`}>
                      <button className="weekly-other-open" type="button" onClick={() => requestSelectWeeklyProject(addedOtherProject)}>
                        <span>{addedOtherProject.project_name}</span>
                        {addedOtherProject.status === 'done' && <b className="entry-state done">작성 완료</b>}
                      </button>
                      <button className="weekly-other-remove" type="button" onClick={requestRemoveOtherProject} title="기타 업무를 이번 주 보고에서 뺍니다" aria-label="기타 업무 제거"><X size={15} strokeWidth={2.6} /></button>
                    </div>
                  ) : (
                    <button className="weekly-other-add" type="button" onClick={addOtherWeeklyProject}><Plus size={14} /><span>기타 (교육, 출장 등) 업무 추가</span></button>
                  )}
                </div>
                )}
              </aside>
              <section className="weekly-entry-panel">
                {selectedWeeklyProject ? (
                  <>
                    {(() => {
                      const locked = selectedWeeklyProject.status === 'excluded';
                      return (
                    <>
                    <div className="weekly-entry-panel-head">
                      <div>
                        <h3>{selectedWeeklyProject.project_name}</h3>
                        <p>과제별로 이번 주 내용을 작성합니다.</p>
                      </div>
                    </div>
                    <div className="weekly-entry-list-fields">
                      <section className="weekly-list-block progress">
                        <div className="weekly-list-title">
                          <span className="weekly-list-name">Progress Log</span>
                          <em className="weekly-list-count">{weeklyEntryDraft.progress_log.length}</em>
                          <button type="button" disabled={locked} onClick={addProgressItem}><Plus size={14} />추가</button>
                        </div>
                        <div className="weekly-list-items">
                          {weeklyEntryDraft.progress_log.map((item, index) => (
                            <div className={`weekly-item-card progress${weeklyMissingDates.progress.includes(index) ? ' invalid' : ''}`} key={"progress-" + index}>
                              <div className="weekly-item-main">
                                <span className="weekly-item-index">{String(index + 1).padStart(2, '0')}</span>
                                <input disabled={locked} value={item.log} onChange={(e) => updateProgressItem(index, 'log', e.target.value)} placeholder="진행 내용을 입력하세요" />
                              </div>
                              <div className="weekly-item-meta">
                                <select className="weekly-item-status" disabled={locked} value={item.status} onChange={(e) => updateProgressItem(index, 'status', e.target.value)} aria-label="진행 상태">
                                  <option value="done">Done</option>
                                  <option value="in_progress">In Progress</option>
                                </select>
                                <input className={`weekly-due-input${weeklyMissingDates.progress.includes(index) ? ' date-missing' : ''}`} type="date" disabled={locked} value={item.date} onChange={(e) => updateProgressItem(index, 'date', e.target.value)} aria-label="Progress Log 날짜" aria-invalid={weeklyMissingDates.progress.includes(index)} />
                                <div className="weekly-item-actions">
                                  <button className={(item.detail || item.images?.length) ? 'has-content' : ''} type="button" disabled={locked} onClick={() => openDetailEditor('progress_log', index)} title="상세 글과 이미지를 작성합니다"><FileText size={14} />상세</button>
                                  <button className={item.confluence_url ? 'has-content' : ''} type="button" disabled={locked} onClick={() => openConfluenceEditor('progress_log', index)} title="Confluence 링크를 연결합니다"><Link2 size={14} />Confluence</button>
                                </div>
                                <button className="weekly-row-remove" type="button" disabled={locked} onClick={() => removeProgressItem(index)} aria-label="Progress Log 삭제"><Trash2 size={15} /></button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      <section className="weekly-list-block risk">
                        <div className="weekly-list-title">
                          <span className="weekly-list-name">Risk &amp; Issue</span>
                          <em className="weekly-list-count">{weeklyEntryDraft.risk_issue.length}</em>
                          <button type="button" disabled={locked} onClick={addRiskItem}><Plus size={14} />추가</button>
                        </div>
                        <div className="weekly-list-items">
                          {weeklyEntryDraft.risk_issue.map((item, index) => (
                            <div className="weekly-item-card risk" key={"risk-" + index}>
                              <div className="weekly-item-main">
                                <span className="weekly-item-index">{String(index + 1).padStart(2, '0')}</span>
                                <input disabled={locked} value={item.issue} onChange={(e) => updateRiskItem(index, 'issue', e.target.value)} placeholder="리스크와 이슈를 입력하세요" />
                              </div>
                              <div className="weekly-item-meta">
                                <select className="weekly-item-importance" disabled={locked} value={item.importance} onChange={(e) => updateRiskItem(index, 'importance', e.target.value)} aria-label="중요도">
                                  <option value="상">중요도 상</option>
                                  <option value="중">중요도 중</option>
                                  <option value="하">중요도 하</option>
                                </select>
                                <div className="weekly-item-actions">
                                  <button className={(item.detail || item.images?.length) ? 'has-content' : ''} type="button" disabled={locked} onClick={() => openDetailEditor('risk_issue', index)} title="상세 글과 이미지를 작성합니다"><FileText size={14} />상세</button>
                                  <button className={item.confluence_url ? 'has-content' : ''} type="button" disabled={locked} onClick={() => openConfluenceEditor('risk_issue', index)} title="Confluence 링크를 연결합니다"><Link2 size={14} />Confluence</button>
                                </div>
                                <button className="weekly-row-remove" type="button" disabled={locked} onClick={() => removeRiskItem(index)} aria-label="Risk & Issue 삭제"><Trash2 size={15} /></button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      <section className="weekly-list-block plan">
                        <div className="weekly-list-title">
                          <span className="weekly-list-name">Next Plan</span>
                          <em className="weekly-list-count">{weeklyEntryDraft.next_plan.length}</em>
                          <button type="button" disabled={locked} onClick={addPlanItem}><Plus size={14} />추가</button>
                        </div>
                        <div className="weekly-list-items">
                          {weeklyEntryDraft.next_plan.map((item, index) => (
                            <div className={`weekly-item-card plan${weeklyMissingDates.plan.includes(index) ? ' invalid' : ''}`} key={"plan-" + index}>
                              <div className="weekly-item-main">
                                <span className="weekly-item-index">{String(index + 1).padStart(2, '0')}</span>
                                <input disabled={locked} value={item.plan} onChange={(e) => updatePlanItem(index, 'plan', e.target.value)} placeholder="다음 계획을 입력하세요" />
                              </div>
                              <div className="weekly-item-meta">
                                <span className="weekly-item-duelabel">Due</span>
                                <input className={`weekly-due-input${weeklyMissingDates.plan.includes(index) ? ' date-missing' : ''}`} type="date" disabled={locked} value={item.due} onChange={(e) => updatePlanItem(index, 'due', e.target.value)} aria-label="Due" aria-invalid={weeklyMissingDates.plan.includes(index)} />
                                <button className="weekly-row-remove" type="button" disabled={locked} onClick={() => removePlanItem(index)} aria-label="Next Plan 삭제"><Trash2 size={15} /></button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    </div>
                    <div className="project-modal-actions weekly-entry-actions">
                      {weeklyMissingDateCount > 0 ? (
                        <p className="weekly-date-warning" role="alert">
                          <AlertTriangle size={14} />
                          날짜를 입력해야 저장할 수 있습니다.
                          <b>
                            {weeklyMissingDates.progress.length > 0 && `Progress Log ${weeklyMissingDates.progress.length}건`}
                            {weeklyMissingDates.progress.length > 0 && weeklyMissingDates.plan.length > 0 && ' · '}
                            {weeklyMissingDates.plan.length > 0 && `Next Plan ${weeklyMissingDates.plan.length}건`}
                          </b>
                        </p>
                      ) : weeklyEntryDirty ? (
                        <p className="weekly-dirty-chip"><span className="weekly-dirty-dot" />저장되지 않은 변경사항이 있습니다</p>
                      ) : null}
                      <button className="mt-btn" type="button" onClick={requestCloseWeeklyEntry}>닫기</button>
                      <button className="mt-btn primary" type="button" disabled={locked} onClick={() => onSaveWeeklyEntry(selectedWeeklyProject.project_id)}>저장</button>
                    </div>
                    </>
                      );
                    })()}
                  </>
                ) : (
                  <div className="empty">선택 가능한 과제가 없습니다</div>
                )}
              </section>
            </div>
            )}
          </div>
        </div>
      )}

      {pendingLeave && (
        <div className="modal-backdrop weekly-submodal-backdrop" role="presentation">
          <div className="weekly-report-modal compact-modal weekly-leave-modal" role="alertdialog" aria-modal="true" aria-labelledby="weekly-leave-title" aria-describedby="weekly-leave-desc">
            <div className="weekly-leave-icon"><AlertTriangle size={22} /></div>
            <div className="weekly-leave-copy">
              <h2 id="weekly-leave-title">저장하지 않고 나갈까요?</h2>
              <p id="weekly-leave-desc">
                {pendingLeave.type === 'switch'
                  ? '작성 중인 내용이 저장되지 않았습니다. 다른 과제로 이동하면 변경사항이 사라집니다.'
                  : '작성 중인 내용이 저장되지 않았습니다. 지금 닫으면 변경사항이 사라집니다.'}
              </p>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={() => setPendingLeave(null)}>계속 작성</button>
              <button className="mt-btn weekly-leave-discard" type="button" onClick={confirmPendingLeave}>저장 안 하고 나가기</button>
            </div>
          </div>
        </div>
      )}

      {pendingOtherRemove && (
        <div className="modal-backdrop weekly-submodal-backdrop" role="presentation">
          <div className="weekly-report-modal compact-modal weekly-otherdel-modal" role="alertdialog" aria-modal="true" aria-labelledby="weekly-otherdel-title" aria-describedby="weekly-otherdel-desc">
            <div className="weekly-otherdel-icon"><AlertTriangle size={22} /></div>
            <div className="weekly-otherdel-copy">
              <h2 id="weekly-otherdel-title">기타 업무를 뺄까요?</h2>
              <p id="weekly-otherdel-desc">
                <strong>{OTHER_WORK_PROJECT_NAME}</strong>에 작성한 내용이 있습니다.
                이번 주 보고에서 빼면 작성한 Progress Log · Risk &amp; Issue · Next Plan과 첨부한 이미지가 <b>모두 삭제되며 되돌릴 수 없습니다.</b>
              </p>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={() => setPendingOtherRemove(false)}>취소</button>
              <button className="mt-btn weekly-otherdel-confirm" type="button" onClick={confirmRemoveOtherProject}>내용 삭제하고 빼기</button>
            </div>
          </div>
        </div>
      )}

      {detailEditor && (
        <div className="modal-backdrop weekly-submodal-backdrop" role="presentation">
          <div className="weekly-detail-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-detail-title">
            <div className="project-modal-head">
              <div>
                <h2 id="weekly-detail-title">{detailEditor.kind === 'progress_log' ? 'Progress Log 상세 작성' : 'Risk & Issue 상세 작성'}</h2>
                <p>긴 설명과 현장 사진을 자유롭게 남겨 주세요.</p>
              </div>
              <button className="icon-btn" type="button" onClick={() => setDetailEditor(null)} aria-label="닫기"><X size={16} /></button>
            </div>
            <label className="weekly-detail-textarea">
              <span>상세 내용</span>
              <textarea value={detailEditor.detail} onChange={(event) => setDetailEditor((prev) => ({ ...prev, detail: event.target.value }))} placeholder="진행 과정, 결과, 의사결정, 대응 내용 등을 자유롭게 작성하세요." />
            </label>
            <div className="weekly-image-area">
              <div className="weekly-image-head">
                <div><strong>사진 첨부</strong><span>PNG, JPG, WEBP, GIF · 장당 5MB · 최대 8장</span></div>
                <label className="weekly-image-add"><ImagePlus size={15} />사진 선택<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={addDetailImages} /></label>
              </div>
              {detailEditor.images.length > 0 ? (
                <div className="weekly-image-grid">
                  {detailEditor.images.map((image, index) => (
                    <figure key={"detail-image-" + index}><AuthenticatedImage src={reportImageSrc(image)} alt={"첨부 이미지 " + (index + 1)} /><button type="button" onClick={() => setDetailEditor((prev) => ({ ...prev, images: prev.images.filter((_, imageIndex) => imageIndex !== index) }))} aria-label="이미지 삭제"><X size={13} /></button></figure>
                  ))}
                </div>
              ) : <div className="weekly-image-empty">첨부된 사진이 없습니다.</div>}
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={() => setDetailEditor(null)}>취소</button>
              <button className="mt-btn primary" type="button" onClick={saveDetailEditor}>상세 저장</button>
            </div>
          </div>
        </div>
      )}

      {confluenceEditor && (
        <div className="modal-backdrop weekly-submodal-backdrop" role="presentation">
          <div className="weekly-link-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-link-title">
            <div className="project-modal-head">
              <div><h2 id="weekly-link-title">Confluence 링크 연결</h2><p>업무 상세 페이지 URL을 입력하세요.</p></div>
              <button className="icon-btn" type="button" onClick={() => setConfluenceEditor(null)} aria-label="닫기"><X size={16} /></button>
            </div>
            <label className="weekly-link-field"><span>Confluence URL</span><div><Link2 size={16} /><input autoFocus type="url" value={confluenceEditor.url} onChange={(event) => setConfluenceEditor((prev) => ({ ...prev, url: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') saveConfluenceEditor(); }} placeholder="https://your-domain.atlassian.net/wiki/..." /></div></label>
            <div className="project-modal-actions">
              {confluenceEditor.url && <button className="mt-btn danger-link" type="button" onClick={() => setConfluenceEditor((prev) => ({ ...prev, url: '' }))}>링크 제거</button>}
              <button className="mt-btn" type="button" onClick={() => setConfluenceEditor(null)}>취소</button>
              <button className="mt-btn primary" type="button" onClick={saveConfluenceEditor}>연결</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


function WeeklyReportLoungePage({ currentTeam }) {
  const [completedReports, setCompletedReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [reportHtml, setReportHtml] = useState('');
  const [loadingReports, setLoadingReports] = useState(false);
  const [loungeError, setLoungeError] = useState('');

  const completedMembers = (selectedReport?.members || []).filter((member) => member.status === 'done');

  useEffect(() => {
    if (!currentTeam?.team_id) {
      setCompletedReports([]);
      setSelectedReport(null);
      setSelectedMemberId('');
      setReportHtml('');
      return;
    }
    setLoadingReports(true);
    request(`/api/teams/${currentTeam.team_id}/reports/completed`)
      .then((reports) => {
        setCompletedReports(reports || []);
        setSelectedReport(null);
        setSelectedMemberId('');
        setReportHtml('');
        setLoungeError('');
      })
      .catch((err) => setLoungeError(err.message))
      .finally(() => setLoadingReports(false));
  }, [currentTeam?.team_id]);

  async function openCompletedReport(report) {
    const doneMembers = (report.members || []).filter((member) => member.status === 'done');
    setSelectedReport(report);
    setReportHtml('');
    setLoungeError('');
    if (doneMembers.length === 0) {
      setSelectedMemberId('');
      return;
    }
    await openCompletedMemberReport(report, doneMembers[0]);
  }

  async function openCompletedMemberReport(report, member) {
    if (!report?.report_id || !member?.user_id) return;
    try {
      setSelectedMemberId(member.user_id);
      const result = await request(`/api/reports/${report.report_id}/users/${member.user_id}/html-report`);
      setReportHtml(result.html || '');
      setLoungeError('');
    } catch (err) {
      setReportHtml('');
      setLoungeError(err.message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="report-eyebrow">REPORT LOUNGE</span><h1>주간 보고 라운지</h1><p>팀이 쌓아 온 주간보고를 살펴보고, 지난 기록에서 다음 업무의 방향을 찾아보세요.</p>
        </div>
      </div>
      <section className="weekly-lounge-layout">
        <div className="weekly-lounge-list">
          <div className="weekly-lounge-head">
            <h2>주간보고 목록</h2>
            <span>{completedReports.length}</span>
          </div>
          {loadingReports && <div className="empty compact">불러오는 중입니다</div>}
          {!loadingReports && completedReports.length === 0 && <div className="empty compact">열람 가능한 주간보고가 없습니다</div>}
          {!loadingReports && completedReports.map((report) => {
            const doneCount = (report.members || []).filter((member) => member.status === 'done').length;
            const absentCount = (report.members || []).filter((member) => member.status === 'absent').length;
            return (
              <button className={`weekly-lounge-card${selectedReport?.report_id === report.report_id ? ' active' : ''}`} type="button" key={report.report_id} onClick={() => openCompletedReport(report)}>
                <span className="weekly-lounge-card-title">
                  <strong>{report.start_date} ~ {report.end_date}</strong>
                  <b className={`weekly-lounge-status ${report.status === 'done' ? 'done' : 'progress'}`}>{report.status === 'done' ? '완료' : '작성중'}</b>
                </span>
                <span>작성 완료 {doneCount}명 · 부재 {absentCount}명</span>
              </button>
            );
          })}
        </div>

        <div className="weekly-lounge-viewer">
          {selectedReport ? (
            <>
              <div className="weekly-lounge-tabs">
                {completedMembers.map((member) => (
                  <button className={selectedMemberId === member.user_id ? 'active' : ''} type="button" key={member.user_id} onClick={() => openCompletedMemberReport(selectedReport, member)}>
                    {member.name} {member.role}
                  </button>
                ))}
                {completedMembers.length === 0 && <span>수집 완료된 멤버가 없습니다</span>}
              </div>
              {loungeError && <div className="error compact">{loungeError}</div>}
              {reportHtml ? <iframe className="weekly-lounge-frame" title="주간 업무 리포트" srcDoc={reportHtml} /> : !loungeError && <div className="empty">리포트를 선택하세요</div>}
            </>
          ) : (
            <div className="empty weekly-lounge-empty">주간보고 카드를 선택하세요</div>
          )}
        </div>
      </section>
    </>
  );
}

function ProjectMemberPanel({ project, teamProject }) {
  const assignedMembers = teamProject?.members || [];
  const leaders = assignedMembers.filter((member) => member.role === 'L');
  const participants = assignedMembers.filter((member) => member.role !== 'L');

  function renderPerson(member, variant = '') {
    const label = `${member.name} ${member.member_role || ''}`.trim();
    return (
      <span className={`project-member-chip${variant ? ` ${variant}` : ''}`} key={member.user_id}>
        <span className="avatar-mini">{member.name.slice(0, 1)}</span>
        <span>{label}</span>
      </span>
    );
  }

  return (
    <section className="project-member-panel" aria-label="과제 멤버 구성">
      <div className="project-member-panel-head">
        <div>
          <span>Project Members</span>
          <strong>{project?.title || '선택된 과제'}</strong>
          <em>{assignedMembers.length}명 참여</em>
        </div>
      </div>
      <div className="project-member-groups">
        <div className="project-member-group leader">
          <span className="group-label">리더</span>
          <div className="project-member-chips">
            {leaders.length ? leaders.map((member) => renderPerson(member, 'leader')) : <span className="project-member-empty">없음</span>}
          </div>
        </div>
        <div className="project-member-group">
          <span className="group-label">멤버</span>
          <div className="project-member-chips">
            {participants.length ? participants.map((member) => renderPerson(member)) : <span className="project-member-empty">없음</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function TeamManagementPage(props) {
  return <section className="report-project-management"><div className="page-head"><div><span className="report-eyebrow">PROJECT MANAGEMENT</span><h1>과제 관리</h1><p>{props.currentTeam.department} 팀의 과제와 참여 멤버를 관리합니다.</p></div></div><ProjectManagementBoard {...props}/></section>;
}

function ProjectManagementBoard({ onReorderProjects, members, teamProjects, teamProjectDraft, setTeamProjectDraft, isProjectModalOpen, setIsProjectModalOpen, editingTeamProjectId, setEditingTeamProjectId, onCreateTeamProject, onEditTeamProject, onUpdateTeamProjectStatus, onDeleteTeamProject }) {
  const order = useProjectOrder(teamProjects, onReorderProjects);
  const inProgressProjects = teamProjects.filter((project) => project.status !== 'done');
  const doneProjects = teamProjects.filter((project) => project.status === 'done');

  const existingMembers = teamProjects.find((project) => project.project_id === editingTeamProjectId)?.members || [];
  const availableMembers = [...members, ...existingMembers.filter((assigned) => !members.some((member) => member.user_id === assigned.user_id)).map((assigned) => ({ ...assigned, role: assigned.member_role }))];
  const selectedLeader = availableMembers.find((member) => member.user_id === teamProjectDraft.leaderId);
  const selectedMemberCount = (teamProjectDraft.memberIds || []).length;
  const canSaveProject = Boolean(teamProjectDraft.project_name.trim() && teamProjectDraft.leaderId);

  function updateDraftMember(userId, checked) {
    setTeamProjectDraft((prev) => {
      const currentIds = prev.memberIds || [];
      const nextIds = checked
        ? Array.from(new Set([...currentIds, userId]))
        : currentIds.filter((id) => id !== userId);
      return { ...prev, memberIds: nextIds };
    });
  }

  function closeModal() {
    setIsProjectModalOpen(false);
    setEditingTeamProjectId(null);
    setTeamProjectDraft({ project_name: '', leaderId: '', memberIds: [], status: 'in_progress' });
  }

  return (
    <>
      <section className="project-board-toolbar">
        <div>
          <h2>과제 관리</h2>
          <p>카드의 손잡이를 드래그해 같은 상태 안에서 순서를 변경하세요.</p>
        </div>
        <div className="project-order-actions">
          <button className="mt-btn" type="button" disabled={order.locked || teamProjects.length < 2} onClick={order.sortAscending}><span aria-hidden="true">↑</span>과제명 오름차순</button>
        <button className="mt-btn primary" type="button" disabled={order.locked} onClick={() => { setEditingTeamProjectId(null); setTeamProjectDraft({ project_name: '', leaderId: '', memberIds: [], status: 'in_progress' }); setIsProjectModalOpen(true); }}><Plus size={15} />과제 추가</button>
        </div>
      </section>
      {order.error && <p className="parts-error" role="alert">{order.error}</p>}
      <p className="project-order-status" role="status">{order.saving ? '순서를 저장하고 있습니다…' : order.notice}</p>
      {order.drag && <div className="project-order-ghost" aria-hidden="true" style={{ left: Math.min(order.drag.x + 14, window.innerWidth - 225), top: Math.min(order.drag.y + 14, window.innerHeight - 65) }}>{order.drag.project.project_name}</div>}

      <div className="project-board-grid">
        <ProjectColumn
          order={order}
          title="진행중인 과제"
          projects={inProgressProjects}
          emptyText="진행중인 과제가 없습니다"
          nextActionLabel="과제 완료"
          nextStatus="done"
          onMove={onUpdateTeamProjectStatus}
          onEdit={onEditTeamProject}
          onDelete={onDeleteTeamProject}
        />
        <ProjectColumn
          order={order}
          title="완료된 과제"
          projects={doneProjects}
          emptyText="완료된 과제가 없습니다"
          nextActionLabel="진행중으로 이동"
          nextStatus="in_progress"
          onMove={onUpdateTeamProjectStatus}
          onEdit={onEditTeamProject}
          onDelete={onDeleteTeamProject}
        />
      </div>

      {isProjectModalOpen && (
        <div className="modal-backdrop" role="presentation">
          <div className="project-modal project-create-modal" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
            <div className="project-modal-head">
              <div>
                <h2 id="project-create-title">{editingTeamProjectId ? '과제 수정' : '과제 추가'}</h2>
                <p>과제 정보와 참여 멤버를 지정합니다.</p>
              </div>
              <button className="icon-btn" type="button" onClick={closeModal} aria-label="닫기"><X size={16} /></button>
            </div>
            <div className="project-create-summary" aria-label="과제 구성 요약">
              <div><span>리더</span><strong>{selectedLeader ? selectedLeader.name : "미지정"}</strong></div>
              <div><span>참여 멤버</span><strong>{selectedMemberCount}명</strong></div>
            </div>
            <label className="project-leader-field">
              <span>과제명</span>
              <input autoFocus placeholder="과제명을 입력하세요" value={teamProjectDraft.project_name} onChange={(e) => setTeamProjectDraft((prev) => ({ ...prev, project_name: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && canSaveProject && onCreateTeamProject()} />
            </label>
            <label className="project-leader-field">
              <span>과제 리더</span>
              <select value={teamProjectDraft.leaderId || ''} onChange={(e) => setTeamProjectDraft((prev) => ({ ...prev, leaderId: e.target.value, memberIds: (prev.memberIds || []).filter((userId) => userId !== e.target.value) }))}>
                <option value="">리더 선택</option>
                {availableMembers.map((member) => <option key={member.user_id} value={member.user_id}>{member.name} ({ROLE_LABELS[member.role] || member.role})</option>)}
              </select>
            </label>
            <div className="project-member-picker">
              <span>과제 멤버</span>
              <div className="project-member-options modal-options">
                <button className={`project-member-none${(teamProjectDraft.memberIds || []).length === 0 ? ' active' : ''}`} type="button" onClick={() => setTeamProjectDraft((prev) => ({ ...prev, memberIds: [] }))}>없음</button>
                {availableMembers.map((member) => {
                  const disabled = member.user_id === teamProjectDraft.leaderId;
                  const checked = !disabled && (teamProjectDraft.memberIds || []).includes(member.user_id);
                  return (
                    <label className={`project-member-option${disabled ? ' disabled' : ''}`} key={member.user_id}>
                      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => updateDraftMember(member.user_id, e.target.checked)} />
                      <span className="project-member-option-copy"><b>{member.name}</b><small>{disabled ? "리더" : ROLE_LABELS[member.role] || member.role}</small></span>
                    </label>
                  );
                })}
                {availableMembers.length === 0 && <div className="empty compact">등록된 멤버가 없습니다</div>}
              </div>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={closeModal}>취소</button>
              <button className="mt-btn primary" type="button" disabled={!canSaveProject} onClick={onCreateTeamProject}><Save size={13} />{editingTeamProjectId ? '저장' : '추가'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ProjectColumn({ order, title, projects, emptyText, nextActionLabel, nextStatus, onMove, onEdit, onDelete }) {
  return (
    <section className="project-column" data-project-order-status={nextStatus === 'done' ? 'in_progress' : 'done'}>
      <div className="project-column-head">
        <h3>{title}</h3>
        <span>{projects.length}</span>
      </div>
      <div className="project-card-list">
        {projects.map((project) => <ProjectCard order={order} key={project.project_id} project={project} actionLabel={nextActionLabel} nextStatus={nextStatus} onMove={onMove} onEdit={onEdit} onDelete={onDelete} />)}
        {order.drag?.target?.beforeId === null && order.drag.target.status === (nextStatus === 'done' ? 'in_progress' : 'done') && <div className="project-order-tail" aria-hidden="true">맨 뒤에 놓기</div>}
        {projects.length === 0 && <div className="empty compact">{emptyText}</div>}
      </div>
    </section>
  );
}

function ProjectCard({ order, project, actionLabel, nextStatus, onMove, onEdit, onDelete }) {
  const leader = project.members.find((member) => member.role === 'L');
  const projectMembers = project.members.filter((member) => member.role === 'M');
  return (
    <article data-project-order-card={project.project_id} className={`team-project-card${order.drag?.project.project_id === project.project_id ? ' is-order-dragging' : ''}${order.drag?.target?.beforeId === project.project_id ? ' is-order-before' : ''}`}>
      <div className="team-project-card-head">
        <button type="button" className="project-order-handle" aria-label={`${project.project_name} 순서 변경`} title="드래그 또는 위·아래 방향키로 순서 변경" disabled={order.saving} {...order.handleProps(project)}><GripVertical size={17} /></button>
        <div>
          <strong>{project.project_name}</strong>
        </div>
        {project.status === 'done' && <span className="project-status done">완료</span>}
      </div>
      <div className="project-role-lines">
        <div><b>리더</b><span>{leader ? leader.name : '미지정'}</span></div>
        <div><b>멤버</b><span>{projectMembers.length ? projectMembers.map((member) => member.name).join(', ') : '없음'}</span></div>
      </div>
      <div className="team-project-card-actions">
        <button className="project-card-btn" type="button" disabled={order.locked} onClick={() => onEdit(project)}><Pencil size={13} />수정</button>
        <button className="project-card-btn primary" type="button" disabled={order.locked} onClick={() => onMove(project.project_id, nextStatus)}>{actionLabel}</button>
        <button className="project-card-btn danger" type="button" disabled={order.locked} onClick={() => onDelete(project.project_id)}><Trash2 size={13} />삭제</button>
      </div>
    </article>
  );
}


function OverviewStat({ icon, label, value, hint, tone }) {
  return (
    <div className={`ov-stat${tone ? ` ${tone}` : ''}`}>
      <div className="ov-stat-icon">{icon}</div>
      <div className="ov-stat-body">
        <span className="ov-stat-label">{label}</span>
        <b className="ov-stat-value">{value}</b>
        {hint && <span className="ov-stat-hint">{hint}</span>}
      </div>
    </div>
  );
}

function OverviewRankTable({ title, subtitle, columns, rows, renderRow }) {
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const start = currentPage * pageSize;
  const visible = rows.slice(start, start + pageSize);

  useEffect(() => {
    setPage(0);
  }, [rows]);

  return (
    <section className="ov-panel">
      <div className="ov-panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      <div className="ov-table" style={{ '--ov-cols': columns.map((c) => c.width).join(' ') }}>
        <div className="ov-table-head">
          {columns.map((col) => <span key={col.key} className={col.align === 'right' ? 'right' : undefined}>{col.label}</span>)}
        </div>
        <div className="ov-table-body">
          {visible.map(renderRow)}
          {visible.length === 0 && <div className="empty">기간 내 데이터가 없습니다</div>}
        </div>
      </div>
      {rows.length > pageSize && (
        <div className="ov-pagination">
          <span>{start + 1}-{Math.min(start + pageSize, rows.length)} / {rows.length}</span>
          <div>
            <button type="button" disabled={currentPage === 0} onClick={() => setPage((prev) => Math.max(0, prev - 1))}>이전</button>
            <button type="button" disabled={currentPage >= totalPages - 1} onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}>다음</button>
          </div>
        </div>
      )}
    </section>
  );
}

function AdminOverviewPage({ overview, loading, period, setPeriod, onRefresh }) {
  const summary = overview?.summary;
  const periodLabel = OVERVIEW_PERIODS.find((item) => item.value === period)?.label || '';
  const scopeHint = period === 'all' ? '전체 기간' : `최근 ${periodLabel}`;
  const recentWritersWithProjects = (overview?.recent_writers || []).filter((row) => Number(row.project_count) > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="report-eyebrow">SERVICE OVERVIEW</span><h1>운영 현황</h1>
          <p>
            팀별 업무와 서비스 활동 현황을 집계합니다
            {overview && ` · ${formatUtcStamp(overview.generated_at)} 기준`}
          </p>
        </div>
        <div className="ov-toolbar">
          <div className="ov-period" role="group" aria-label="집계 기간">
            {OVERVIEW_PERIODS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`ov-period-btn${period === item.value ? ' active' : ''}`}
                onClick={() => setPeriod(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="mt-btn sm" type="button" onClick={onRefresh} disabled={loading}>
            {loading ? '불러오는 중…' : '새로고침'}
          </button>
        </div>
      </div>

      {!overview && loading && <div className="empty">운영 현황을 불러오는 중입니다…</div>}
      {!overview && !loading && <div className="empty">운영 현황을 불러오지 못했습니다</div>}

      {overview && (
        <>
          <section className="ov-stat-grid">
            <OverviewStat
              tone="live"
              icon={<Wifi size={18} />}
              label="활동 중인 팀"
              value={summary.online_accounts}
              hint={`전체 ${summary.total_accounts}개 팀 · 최근 ${overview.online_window_minutes}분 활동 기준`}
            />
            <OverviewStat
              icon={<FileText size={18} />}
              label="진행중인 보고"
              value={summary.in_progress_reports}
              hint="멤버가 배정된 작성 마감 전 주간 보고"
            />
            <OverviewStat
              icon={<Check size={18} />}
              label="완료된 보고"
              value={summary.done_reports}
              hint="마감 처리된 주간 보고"
            />
            <OverviewStat
              icon={<ClipboardList size={18} />}
              label="등록된 진행 과제"
              value={summary.in_progress_projects}
              hint="상태가 진행중인 과제"
            />
            <OverviewStat
              icon={<Check size={18} />}
              label="완료된 진행 과제"
              value={summary.done_projects}
              hint="상태가 완료인 과제"
            />
          </section>

          <OverviewRankTable
            title="최근 보고 작성 멤버"
            subtitle={scopeHint + " 내 작성 기록 " + recentWritersWithProjects.length + "건 (최대 100건)"}
            columns={[
              { key: "time", label: "작성 시간", width: "minmax(150px, 1.1fr)" },
              { key: "team", label: "팀", width: "minmax(120px, 1fr)" },
              { key: "member", label: "멤버", width: "minmax(90px, .7fr)" },
              { key: "week", label: "보고 주차", width: "minmax(160px, 1.1fr)" },
              { key: "count", label: "작성 과제 수", width: "96px", align: "right" },
            ]}
            rows={recentWritersWithProjects}
            renderRow={(row, index) => (
              <div className="ov-row" key={`${row.updated_at}-${row.login_id}-${row.member_name}-${index}`}>
                <span className="ov-mono">{formatUtcStamp(row.updated_at)}</span>
                <span>{row.department}</span>
                <strong>{row.member_name}</strong>
                <span className="ov-mono">{row.report_range}</span>
                <span className="right"><b>{row.project_count}</b></span>
              </div>
            )}
          />

          <div className="ov-panel-grid">
            <OverviewRankTable
              title="팀별 멤버 수"
              subtitle={`괄호 안은 ${scopeHint} 내 신규 등록`}
              columns={[
                { key: 'team', label: '팀', width: 'minmax(0, 1fr)' },
                { key: 'count', label: '멤버 수', width: '96px', align: 'right' },
              ]}
              rows={overview.team_members}
              renderRow={(row) => (
                <div className="ov-row" key={row.team_id}>
                  <span>{row.department}</span>
                  <span className="right"><b>{row.total}</b>{row.recent > 0 && <em className="ov-delta"> (+{row.recent})</em>}</span>
                </div>
              )}
            />

            <OverviewRankTable
              title="팀별 과제 수"
              subtitle={`괄호 안은 ${scopeHint} 내 신규 등록`}
              columns={[
                { key: 'team', label: '팀', width: 'minmax(0, 1fr)' },
                { key: 'ip', label: '진행중', width: '54px', align: 'right' },
                { key: 'done', label: '완료', width: '44px', align: 'right' },
                { key: 'total', label: '합계', width: '78px', align: 'right' },
              ]}
              rows={overview.team_projects}
              renderRow={(row) => (
                <div className="ov-row" key={row.team_id}>
                  <span>{row.department}</span>
                  <span className="right">{row.in_progress}</span>
                  <span className="right">{row.done}</span>
                  <span className="right"><b>{row.total}</b>{row.recent > 0 && <em className="ov-delta"> (+{row.recent})</em>}</span>
                </div>
              )}
            />

            <OverviewRankTable
              title="팀별 활동 멤버"
              subtitle={`${scopeHint} 내 활동한 멤버 수`}
              columns={[
                { key: 'team', label: '팀', width: 'minmax(0, 1fr)' },
                { key: 'last', label: '최근 접속', width: '92px' },
                { key: 'count', label: '멤버 수', width: '68px', align: 'right' },
              ]}
              rows={overview.account_logins}
              renderRow={(row) => (
                <div className="ov-row" key={row.team_id}>
                  <span className="ov-account">
                    {row.is_online && <i className="ov-dot" title="접속 중" />}
                    {row.department}
                  </span>
                  <span className="ov-mono">{formatUtcStampShort(row.last_login_at)}</span>
                  <span className="right"><b>{row.login_count}</b></span>
                </div>
              )}
            />

            <OverviewRankTable
              title="팀별 완료된 보고"
              subtitle="전체 완료 처리된 주간보고"
              columns={[
                { key: "team", label: "팀", width: "minmax(0, 1fr)" },
                { key: "last", label: "최근 완료 보고", width: "minmax(130px, 1.1fr)" },
                { key: "count", label: "완료", width: "68px", align: "right" },
              ]}
              rows={overview.account_completed_reports || []}
              renderRow={(row) => (
                <div className="ov-row" key={row.team_id}>
                  <span>{row.department}</span>
                  <span className="ov-mono">{row.last_report_range || "-"}</span>
                  <span className="right"><b>{row.count}</b></span>
                </div>
              )}
            />

            <OverviewRankTable
              title="팀별 마일스톤 수"
              subtitle={`${scopeHint} 내 생성된 마일스톤`}
              columns={[
                { key: 'team', label: '팀', width: 'minmax(0, 1fr)' },
                { key: 'count', label: '마일스톤', width: '88px', align: 'right' },
              ]}
              rows={overview.account_milestones}
              renderRow={(row) => (
                <div className="ov-row" key={row.team_id}>
                  <span>{row.department}</span>
                  <span className="right"><b>{row.count}</b></span>
                </div>
              )}
            />

            <OverviewRankTable
              title="팀별 일정 작성 수"
              subtitle={`${scopeHint} 내 등록된 팀 일정`}
              columns={[
                { key: 'team', label: '팀', width: 'minmax(0, 1fr)' },
                { key: 'count', label: '일정', width: '88px', align: 'right' },
              ]}
              rows={overview.account_events}
              renderRow={(row) => (
                <div className="ov-row" key={row.team_id}>
                  <span>{row.department}</span>
                  <span className="right"><b>{row.count}</b></span>
                </div>
              )}
            />
          </div>
        </>
      )}
    </>
  );
}


function ProjectProgressHistory({ project }) {
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyImagePreview, setHistoryImagePreview] = useState(null);
  const [removingHistoryId, setRemovingHistoryId] = useState("");

  useEffect(() => {
    let active = true;
    if (!project?.id) {
      setHistory([]);
      return () => { active = false; };
    }
    setHistoryImagePreview(null);
    setLoadingHistory(true);
    setHistoryError("");
    request("/api/projects/" + project.id + "/progress-history")
      .then((items) => { if (active) setHistory(items || []); })
      .catch((err) => { if (active) { setHistory([]); setHistoryError(err.message || "Progress History를 불러오지 못했습니다"); } })
      .finally(() => { if (active) setLoadingHistory(false); });
    return () => { active = false; };
  }, [project?.id]);

  useEffect(() => {
    if (!historyImagePreview) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setHistoryImagePreview(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyImagePreview]);

  async function hideProgressFromHistory(progressId) {
    setRemovingHistoryId(progressId);
    setHistoryError("");
    try {
      await request("/api/project-progress/" + progressId + "/history-visibility", {
        method: "PUT",
        body: JSON.stringify({ is_hidden: true }),
      });
      setHistory((prev) => prev.filter((item) => (item.progress_id || item.history_id) !== progressId));
    } catch (err) {
      setHistoryError(err.message || "Progress 이력 표시를 제거하지 못했습니다");
    } finally {
      setRemovingHistoryId("");
    }
  }

  return (
    <section className="progress-history-card" aria-labelledby="progress-history-title">
      <div className="progress-history-head">
        <div>
          <p className="mt-card-eyebrow"><History size={15} />Progress History</p>
          <h2 id="progress-history-title">과제 진행 이력</h2>
          <p>주간보고에서 Done 처리된 Progress Log를 최신 수행일 순으로 확인합니다.</p>
        </div>
        <span className="progress-history-count"><b>{history.length}</b> logs</span>
      </div>

      {loadingHistory && <div className="progress-history-empty">진행 이력을 불러오는 중입니다.</div>}
      {!loadingHistory && historyError && <div className="error compact">{historyError}</div>}
      {!loadingHistory && !historyError && history.length === 0 && <div className="progress-history-empty">아직 Done 처리된 Progress Log가 없습니다.</div>}
      {!loadingHistory && !historyError && history.length > 0 && (
        <div className="progress-history-list">
          {history.map((item) => (
            <article className="progress-history-item" key={item.history_id}>
              <div className="progress-history-rail" aria-hidden="true"><span className="done"></span></div>
              <div className="progress-history-content">
                <div className="progress-history-meta">
                  <time dateTime={item.occurred_on}>{String(item.occurred_on || "").replaceAll("-", ".")}</time>
                  <span className="progress-history-status done">Done</span>
                  <span className="progress-history-author">{item.reported_by} {ROLE_LABELS[item.reported_role] || item.reported_role}</span>
                </div>
                <h3>{item.log}</h3>
                {(item.detail || item.images?.length > 0) && (
                  <details className="progress-history-details">
                    <summary><span>상세 내용{item.images?.length ? " · 이미지 " + item.images.length + "장" : ""}</span></summary>
                    <div className="progress-history-detail-body">
                      {item.detail && <p className="progress-history-detail">{item.detail}</p>}
                      {item.images?.length > 0 && (
                        <div className="progress-history-images">
                          {item.images.map((image, imageIndex) => (
                            <button type="button" key={item.history_id + "-image-" + imageIndex} onClick={() => setHistoryImagePreview({ src: reportImageSrc(image), alt: item.log + " 첨부 이미지 " + (imageIndex + 1) })}>
                              <AuthenticatedImage src={reportImageSrc(image)} alt={item.log + " 첨부 이미지 " + (imageIndex + 1)} />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>
                )}
                <div className="progress-history-footer">
                  <span>보고 주간 {item.report_start_date} ~ {item.report_end_date}</span>
                  <div className="progress-history-actions">
                    {item.confluence_url && <a href={item.confluence_url} target="_blank" rel="noopener noreferrer">Confluence 상세 <ExternalLink size={12} /></a>}
                    <button className="progress-history-remove" type="button" disabled={removingHistoryId === (item.progress_id || item.history_id)} onClick={() => hideProgressFromHistory(item.progress_id || item.history_id)} aria-label="Progress History에서 제거" title="Progress History에서 제거"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {historyImagePreview && (
        <div className="modal-backdrop progress-history-image-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setHistoryImagePreview(null); }}>
          <div className="progress-history-image-modal" role="dialog" aria-modal="true" aria-label="Progress History 첨부 이미지 확대">
            <button type="button" onClick={() => setHistoryImagePreview(null)} aria-label="확대 이미지 닫기"><X size={18} /></button>
            <AuthenticatedImage src={historyImagePreview.src} alt={historyImagePreview.alt} />
          </div>
        </div>
      )}
    </section>
  );
}


function ProjectNextPlan({ project }) {
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [planError, setPlanError] = useState("");

  useEffect(() => {
    let active = true;
    if (!project?.id) {
      setPlans([]);
      return () => { active = false; };
    }
    setLoadingPlans(true);
    setPlanError("");
    request("/api/projects/" + project.id + "/upcoming-next-plans")
      .then((items) => { if (active) setPlans(items || []); })
      .catch((err) => { if (active) { setPlans([]); setPlanError(err.message || "Next Plan을 불러오지 못했습니다"); } })
      .finally(() => { if (active) setLoadingPlans(false); });
    return () => { active = false; };
  }, [project?.id]);

  return (
    <section className="progress-history-card next-plan-card" aria-labelledby="next-plan-title">
      <div className="progress-history-head next-plan-head">
        <div>
          <p className="mt-card-eyebrow"><ClipboardList size={15} />Next Plan</p>
          <h2 id="next-plan-title">Next Plan</h2>
          <p>한국 날짜 기준 오늘 이후의 Next Plan을 예정일 순으로 확인합니다.</p>
        </div>
        <span className="progress-history-count next-plan-count"><b>{plans.length}</b> plans</span>
      </div>

      {loadingPlans && <div className="progress-history-empty next-plan-empty">Next Plan을 불러오는 중입니다.</div>}
      {!loadingPlans && planError && <div className="error compact">{planError}</div>}
      {!loadingPlans && !planError && plans.length === 0 && <div className="progress-history-empty next-plan-empty">오늘 이후 예정된 Next Plan이 없습니다.</div>}
      {!loadingPlans && !planError && plans.length > 0 && (
        <div className="progress-history-list next-plan-list">
          {plans.map((item) => (
            <article className="progress-history-item next-plan-item" key={item.plan_id}>
              <div className="progress-history-rail next-plan-rail" aria-hidden="true"><span className="in-progress"></span></div>
              <div className="progress-history-content next-plan-content">
                <div className="progress-history-meta">
                  <time dateTime={item.due}>{String(item.due || "").replaceAll("-", ".")}</time>
                  <span className="progress-history-status in-progress">Plan</span>
                  <span className="progress-history-author">{item.reported_by} {ROLE_LABELS[item.reported_role] || item.reported_role}</span>
                </div>
                <h3>{item.plan}</h3>
                <div className="progress-history-footer">
                  <span>보고 주간 {item.report_start_date} ~ {item.report_end_date}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}


function ProjectIssueManagement({ project }) {
  const [issues, setIssues] = useState([]);
  const [progressItems, setProgressItems] = useState([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [issueError, setIssueError] = useState("");
  const [importanceFilter, setImportanceFilter] = useState("all");
  const [issueImagePreview, setIssueImagePreview] = useState(null);
  const [updatingIssueId, setUpdatingIssueId] = useState("");
  const [resolutionModal, setResolutionModal] = useState(null);

  useEffect(() => {
    let active = true;
    if (!project?.id) {
      setIssues([]);
      setProgressItems([]);
      return () => { active = false; };
    }
    setImportanceFilter("all");
    setIssueImagePreview(null);
    setResolutionModal(null);
    setLoadingIssues(true);
    setLoadingProgress(true);
    setIssueError("");
    request("/api/projects/" + project.id + "/issue-management")
      .then((items) => { if (active) setIssues(items || []); })
      .catch((err) => { if (active) { setIssues([]); setIssueError(err.message || "Issue & Risk를 불러오지 못했습니다"); } })
      .finally(() => { if (active) setLoadingIssues(false); });
    request("/api/projects/" + project.id + "/progress-history?include_hidden=1")
      .then((items) => { if (active) setProgressItems(items || []); })
      .catch(() => { if (active) setProgressItems([]); })
      .finally(() => { if (active) setLoadingProgress(false); });
    return () => { active = false; };
  }, [project?.id]);

  useEffect(() => {
    if (!issueImagePreview && !resolutionModal) return undefined;
    const closeOnEscape = (event) => {
      if (event.key !== "Escape") return;
      if (issueImagePreview) setIssueImagePreview(null);
      else setResolutionModal(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [issueImagePreview, resolutionModal]);

  const progressById = useMemo(() => {
    const map = new Map();
    progressItems.forEach((item) => map.set(item.progress_id || item.history_id, item));
    return map;
  }, [progressItems]);
  const openIssues = useMemo(() => issues.filter((item) => item.status !== "resolved"), [issues]);
  const resolvedIssues = useMemo(() => issues.filter((item) => item.status === "resolved"), [issues]);
  const issueCounts = useMemo(() => ({
    all: openIssues.length,
    resolved: resolvedIssues.length,
    high: openIssues.filter((item) => item.importance === "상").length,
    medium: openIssues.filter((item) => item.importance === "중").length,
    low: openIssues.filter((item) => item.importance === "하").length,
  }), [openIssues, resolvedIssues]);

  const filteredOpenIssues = useMemo(() => filterIssuesByImportance(openIssues, importanceFilter), [openIssues, importanceFilter]);
  const filteredResolvedIssues = useMemo(() => filterIssuesByImportance(resolvedIssues, importanceFilter), [resolvedIssues, importanceFilter]);

  function filterIssuesByImportance(items, filter) {
    const value = { high: "상", medium: "중", low: "하" }[filter];
    return value ? items.filter((item) => item.importance === value) : items;
  }

  function formatResolvedDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const utc = new Date(/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw + "Z");
  if (Number.isNaN(utc.getTime())) return raw.slice(0, 10).replaceAll("-", ".");
  const kst = new Date(utc.getTime() + 9 * 3600000);
  return kst.getUTCFullYear() + "." + String(kst.getUTCMonth() + 1).padStart(2, "0") + "." + String(kst.getUTCDate()).padStart(2, "0");
}

function importanceClass(value) {
    if (value === "상") return "high";
    if (value === "하") return "low";
    return "medium";
  }

  function openResolutionModal(issue) {
    setResolutionModal({
      issue,
      selectedIds: Array.isArray(issue.resolution_progress_ids) ? issue.resolution_progress_ids : [],
      comment: issue.resolution_comment || "",
    });
  }

  function toggleResolutionProgress(progressId) {
    setResolutionModal((prev) => {
      if (!prev) return prev;
      const selected = new Set(prev.selectedIds || []);
      if (selected.has(progressId)) selected.delete(progressId);
      else selected.add(progressId);
      return { ...prev, selectedIds: Array.from(selected) };
    });
  }

  async function updateIssueStatus(issueId, status, options = {}) {
    setUpdatingIssueId(issueId);
    setIssueError("");
    try {
      const updated = await request("/api/project-issues/" + issueId + "/status", {
        method: "PUT",
        body: JSON.stringify({ status, ...options }),
      });
      setIssues((prev) => prev.map((item) => (item.issue_id === issueId ? {
        ...item,
        status: updated.status,
        resolved_at: updated.resolved_at || "",
        updated_at: updated.updated_at || item.updated_at,
        resolution_progress_ids: updated.resolution_progress_ids || item.resolution_progress_ids || [],
        resolution_comment: updated.resolution_comment || "",
      } : item)));
      setResolutionModal(null);
    } catch (err) {
      setIssueError(err.message || "Issue 상태를 변경하지 못했습니다");
    } finally {
      setUpdatingIssueId("");
    }
  }

  function submitIssueResolution() {
    if (!resolutionModal?.issue) return;
    updateIssueStatus(resolutionModal.issue.issue_id, "resolved", {
      resolution_progress_ids: resolutionModal.selectedIds || [],
      resolution_comment: resolutionModal.comment || "",
    });
  }

  function renderResolvedMeta(item) {
    const linkedIds = Array.isArray(item.resolution_progress_ids) ? item.resolution_progress_ids : [];
    const linkedProgress = linkedIds.map((id) => progressById.get(id)).filter(Boolean);
    if (!linkedProgress.length && !item.resolution_comment) return null;
    return (
      <div className="issue-resolution-summary">
        {linkedProgress.length > 0 && (
          <div className="issue-resolution-linked">
            <span>관련 Process</span>
            <ul>
              {linkedProgress.map((progress) => (
                <li key={progress.progress_id || progress.history_id}>
                  <time dateTime={progress.occurred_on}>{String(progress.occurred_on || "").replaceAll("-", ".")}</time>
                  <p>{progress.log}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {item.resolution_comment && (
          <div className="issue-resolution-comment-block">
            <span>종합 의견</span>
            <p>{item.resolution_comment}</p>
          </div>
        )}
      </div>
    );
  }

  function renderIssueList(items, emptyText, isResolvedSection = false) {
    if (items.length === 0) return <div className="issue-management-empty section-empty">{emptyText}</div>;
    return (
      <div className="issue-management-list">
        {items.map((item) => {
          const level = importanceClass(item.importance);
          const isUpdating = updatingIssueId === item.issue_id;
          return (
            <article className={"issue-management-item " + level + (isResolvedSection ? " resolved" : "")} key={item.issue_id}>
              <div className="issue-management-item-head">
                {isResolvedSection && <span className="issue-resolved-chip"><Check size={11} strokeWidth={3} />해결</span>}
                <span className={"issue-importance " + level}>중요도 {item.importance}</span>
                <span className="issue-management-author">{item.reported_by} {ROLE_LABELS[item.reported_role] || item.reported_role}</span>
              </div>
              <h3>{item.issue}</h3>
              {(item.detail || item.images?.length > 0) && (
                <details className="progress-history-details">
                  <summary><span>상세 내용{item.images?.length ? " · 이미지 " + item.images.length + "장" : ""}</span></summary>
                  <div className="progress-history-detail-body">
                    {item.detail && <p className="progress-history-detail">{item.detail}</p>}
                    {item.images?.length > 0 && (
                      <div className="progress-history-images">
                        {item.images.map((image, imageIndex) => (
                          <button type="button" key={item.issue_id + "-image-" + imageIndex} onClick={() => setIssueImagePreview({ src: reportImageSrc(image), alt: item.issue + " 첨부 이미지 " + (imageIndex + 1) })}>
                            <AuthenticatedImage src={reportImageSrc(image)} alt={item.issue + " 첨부 이미지 " + (imageIndex + 1)} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              )}
              {isResolvedSection && renderResolvedMeta(item)}
              <div className="issue-management-footer">
                <span className="issue-management-period">
                  보고 주간 {item.report_start_date} ~ {item.report_end_date}
                  {isResolvedSection && formatResolvedDate(item.resolved_at) && (
                    <b className="issue-resolved-date">해결 {formatResolvedDate(item.resolved_at)}</b>
                  )}
                </span>
                <div className="issue-management-actions">
                  {item.confluence_url && <a href={item.confluence_url} target="_blank" rel="noopener noreferrer">Confluence 상세 <ExternalLink size={12} /></a>}
                  {isResolvedSection ? (
                    <button className="issue-resolve-btn secondary" type="button" disabled={isUpdating} onClick={() => updateIssueStatus(item.issue_id, "open")}>미해결로 되돌리기</button>
                  ) : (
                    <button className="issue-resolve-btn" type="button" disabled={isUpdating} onClick={() => openResolutionModal(item)}><Check size={13} />Issue 해결</button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <section className="issue-management-card" aria-labelledby="issue-management-title">
      <div className="issue-management-head">
        <div>
          <p className="mt-card-eyebrow"><AlertTriangle size={15} />Issue Management</p>
          <h2 id="issue-management-title">Issue &amp; Risk 관리</h2>
          <p>모든 주간보고에 작성된 Issue &amp; Risk를 미해결 항목과 해결된 항목으로 나누어 관리합니다.</p>
        </div>
        <span className="issue-management-count"><b>{issueCounts.all}</b> 미해결 · {issueCounts.resolved} 해결</span>
      </div>

      <div className="issue-management-toolbar">
        <div className="issue-management-summary" aria-label="미해결 Issue 중요도 요약">
          <span className="high"><b>{issueCounts.high}</b> 상</span>
          <span className="medium"><b>{issueCounts.medium}</b> 중</span>
          <span className="low"><b>{issueCounts.low}</b> 하</span>
        </div>
        <div className="issue-management-filters" aria-label="Issue 중요도 필터">
          {[["all", "전체"], ["high", "상"], ["medium", "중"], ["low", "하"]].map(([value, label]) => (
            <button type="button" key={value} className={importanceFilter === value ? "active" : ""} onClick={() => setImportanceFilter(value)}>
              {label} <b>{issueCounts[value]}</b>
            </button>
          ))}
        </div>
      </div>

      {loadingIssues && <div className="issue-management-empty">Issue &amp; Risk를 불러오는 중입니다.</div>}
      {!loadingIssues && issueError && <div className="error compact">{issueError}</div>}
      {!loadingIssues && !issueError && issues.length === 0 && <div className="issue-management-empty">아직 작성된 Issue &amp; Risk가 없습니다.</div>}
      {!loadingIssues && !issueError && issues.length > 0 && (
        <div className="issue-management-sections">
          <section className="issue-management-section ongoing" aria-label="미해결 Issue">
            <div className="issue-management-section-head">
              <span className="issue-section-mark"><AlertTriangle size={15} /></span>
              <div><h3>미해결</h3><p>아직 해결되지 않아 계속 추적해야 하는 Issue입니다.</p></div>
              <span className="issue-section-count">{filteredOpenIssues.length}건</span>
            </div>
            {renderIssueList(filteredOpenIssues, importanceFilter === "all" ? "미해결 Issue가 없습니다." : "선택한 중요도의 미해결 Issue가 없습니다.")}
          </section>
          <section className="issue-management-section resolved" aria-label="해결된 Issue">
            <div className="issue-management-section-head">
              <span className="issue-section-mark"><Check size={15} strokeWidth={3} /></span>
              <div><h3>해결</h3><p>해결 처리되어 기록으로 보관되는 Issue입니다.</p></div>
              <span className="issue-section-count">{filteredResolvedIssues.length}건</span>
            </div>
            {renderIssueList(filteredResolvedIssues, importanceFilter === "all" ? "해결된 Issue가 없습니다." : "선택한 중요도의 해결 Issue가 없습니다.", true)}
          </section>
        </div>
      )}

      {resolutionModal && (
        <div className="modal-backdrop issue-resolution-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setResolutionModal(null); }}>
          <div className="issue-resolution-modal" role="dialog" aria-modal="true" aria-labelledby="issue-resolution-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="project-modal-head">
              <div>
                <h2 id="issue-resolution-title">Issue 해결</h2>
                <p>{resolutionModal.issue.issue}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setResolutionModal(null)} aria-label="Issue 해결 팝업 닫기"><X size={18} /></button>
            </div>
            <div className="issue-resolution-body">
              <section className="issue-resolution-panel">
                <div className="issue-resolution-panel-head">
                  <h3>관련 Progress 연동</h3>
                  <span>{resolutionModal.selectedIds.length}개 선택</span>
                </div>
                {loadingProgress && <div className="issue-resolution-empty">Progress를 불러오는 중입니다.</div>}
                {!loadingProgress && progressItems.length === 0 && <div className="issue-resolution-empty">연동할 Done Progress가 없습니다.</div>}
                {!loadingProgress && progressItems.length > 0 && (
                  <div className="issue-resolution-progress-list">
                    {progressItems.map((progress) => {
                      const progressId = progress.progress_id || progress.history_id;
                      const checked = resolutionModal.selectedIds.includes(progressId);
                      return (
                        <button type="button" key={progressId} className={checked ? "selected" : ""} onClick={() => toggleResolutionProgress(progressId)}>
                          <span className="issue-resolution-check">{checked && <Check size={12} />}</span>
                          <span className="issue-resolution-progress-main">
                            <b>{progress.log}</b>
                            <small>{progress.occurred_on} · {progress.reported_by} · {progress.report_start_date} ~ {progress.report_end_date}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
              <label className="issue-resolution-comment-field">
                <span>종합 의견</span>
                <textarea value={resolutionModal.comment} onChange={(event) => setResolutionModal((prev) => prev ? { ...prev, comment: event.target.value } : prev)} placeholder="Issue가 어떻게 해결되었는지, 남은 확인 사항이 있는지 작성하세요." maxLength={4000} />
              </label>
            </div>
            <div className="issue-resolution-actions">
              <button className="issue-resolution-cancel" type="button" onClick={() => setResolutionModal(null)}>취소</button>
              <button className="issue-resolution-submit" type="button" disabled={updatingIssueId === resolutionModal.issue.issue_id} onClick={submitIssueResolution}>해결</button>
            </div>
          </div>
        </div>
      )}

      {issueImagePreview && (
        <div className="modal-backdrop progress-history-image-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setIssueImagePreview(null); }}>
          <div className="progress-history-image-modal" role="dialog" aria-modal="true" aria-label="Issue & Risk 첨부 이미지 확대">
            <button type="button" onClick={() => setIssueImagePreview(null)} aria-label="확대 이미지 닫기"><X size={18} /></button>
            <AuthenticatedImage src={issueImagePreview.src} alt={issueImagePreview.alt} />
          </div>
        </div>
      )}
    </section>
  );
}


function ProjectTimeline({
  project,
  milestones,
  addingMilestone,
  setAddingMilestone,
  milestoneDraft,
  setMilestoneDraft,
  onAddMilestone,
  onUpdateMilestone,
  onRemoveMilestone,
  onAddEpic,
  onUpdateEpic,
  onRemoveEpic,
  onReorderEpics,
}) {
  const [workModal, setWorkModal] = useState(null);
  const [milestoneModal, setMilestoneModal] = useState(null);
  const [epicDraft, setEpicDraft] = useState({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });
  const [milestoneEditDraft, setMilestoneEditDraft] = useState({ title: '', start_date: todayIso(), end_date: todayIso() });
  const [editDraft, setEditDraft] = useState({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });
  const [timelineActionId, setTimelineActionId] = useState('');
  const [workDrag, setWorkDrag] = useState(null);
  const workDragRef = useRef(null);
  const orderSavingRef = useRef(false);
  const [orderSaving, setOrderSaving] = useState(false);
  const [orderMessage, setOrderMessage] = useState('');
  async function saveWorkOrder(milestoneId, sourceId, targetId, after) {
    if (orderSavingRef.current || sourceId === targetId) return;
    const milestone = milestones.find((item) => item.id === milestoneId);
    if (!milestone) return;
    const ids = milestone.epics.map((item) => item.id);
    if (!ids.includes(sourceId) || !ids.includes(targetId)) return;
    const next = ids.filter((id) => id !== sourceId);
    next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
    if (next.every((id, index) => id === ids[index])) return;
    orderSavingRef.current = true;
    setOrderSaving(true);
    setOrderMessage('');
    try {
      await onReorderEpics(milestoneId, next);
      setOrderMessage('워크 순서를 저장했습니다.');
    } catch (err) {
      setOrderMessage(err.message || '순서를 저장하지 못했습니다. 다시 시도하세요.');
    } finally {
      orderSavingRef.current = false;
      setOrderSaving(false);
    }
  }
  function moveWorkPointer(event) {
    const drag = workDragRef.current;
    if (!drag) return;
    const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-work-id]');
    const valid = row?.dataset.milestoneId === drag.milestoneId;
    const next = { ...drag, targetId: valid ? row.dataset.workId : null,
      after: valid && event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 };
    workDragRef.current = next;
    setWorkDrag(next);
  }
  function cancelWorkDrag() { workDragRef.current = null; setWorkDrag(null); }
  function finishWorkPointer(event) {
    moveWorkPointer(event);
    const drag = workDragRef.current;
    cancelWorkDrag();
    if (drag?.targetId) saveWorkOrder(drag.milestoneId, drag.sourceId, drag.targetId, drag.after);
  }
  const [hideDoneWorks, setHideDoneWorks] = useState(false);
  const [collapsedMilestones, setCollapsedMilestones] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('wiareport_collapsed_milestones') || '[]');
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem('wiareport_collapsed_milestones', JSON.stringify([...collapsedMilestones])); } catch {}
  }, [collapsedMilestones]);
  function toggleMilestoneWorks(id) {
    cancelWorkDrag();
    setCollapsedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const timelineScrollRef = useRef(null);
  const [timelineScale, setTimelineScale] = useState('day');
  const [timeFilter, setTimeFilter] = useState(null);
  const [timeFilterDraft, setTimeFilterDraft] = useState(null);
  const [timeFilterError, setTimeFilterError] = useState(null);

  const fullRange = useMemo(() => {
    const dates = milestones.flatMap((milestone) => [milestone.start_date, milestone.end_date]);
    if (dates.length === 0) return { start: milestoneDraft.start_date, end: milestoneDraft.end_date };
    return { start: dates.reduce((a, b) => (a < b ? a : b)), end: dates.reduce((a, b) => (a > b ? a : b)) };
  }, [milestones, milestoneDraft.start_date, milestoneDraft.end_date]);

  const range = timeFilter?.projectId === project?.id ? timeFilter : fullRange;
  const filterDraft = timeFilterDraft?.projectId === project?.id ? timeFilterDraft : range;
  const filterError = timeFilterError?.projectId === project?.id ? timeFilterError.message : '';
  function changeTimeFilter(key, value) {
    setTimeFilterDraft({ ...filterDraft, projectId: project?.id, [key]: value });
    setTimeFilterError(null);
  }
  function applyTimeFilter(event) {
    event.preventDefault();
    const { start, end } = filterDraft;
    if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      setTimeFilterError({ projectId: project?.id, message: '시작일과 종료일을 입력해 주세요.' });
      return;
    }
    if (start > end) {
      setTimeFilterError({ projectId: project?.id, message: '종료일은 시작일과 같거나 이후여야 합니다.' });
      return;
    }
    setTimeFilter({ projectId: project?.id, start, end });
    setTimeFilterError(null);
  }
  function resetTimeFilter() {
    setTimeFilter(null);
    setTimeFilterDraft(null);
    setTimeFilterError(null);
  }

  const axis = useMemo(() => buildTimelineAxis(range.start, range.end, timelineScale), [range.start, range.end, timelineScale]);
  const colCount = axis.cells.length;
  const dateGridTemplate = `repeat(${colCount}, minmax(0, 1fr))`;
  const calendarWidth = `max(100%, ${axis.groups.length * 64}px)`;
  const today = kstTodayIso();
  const todayIndex = axis.todayIndex(today);
  function isDoneWork(epic) {
    const status = normalizeStatus(epic.status);
    return status === 'done' || status === 'done_delayed';
  }
  const completedMilestoneCount = useMemo(() => milestones.filter((milestone) => {
    const works = milestone.epics || [];
    return works.length > 0 && works.every(isDoneWork);
  }).length, [milestones]);
  const visibleMilestones = useMemo(() => {
    if (!hideDoneWorks) return milestones;
    return milestones.filter((milestone) => {
      const works = milestone.epics || [];
      return !(works.length > 0 && works.every(isDoneWork));
    });
  }, [milestones, hideDoneWorks]);
  const timelineAlerts = useMemo(() => {
    const alerts = [];
    visibleMilestones.forEach((milestone) => {
      (milestone.epics || []).forEach((epic) => {
        const status = normalizeStatus(epic.status);
        const isDone = isDoneWork(epic);
        const isActive = status === 'in_progress' || status === 'in_progress_delayed';
        if (epic.end_date < today && !isDone) {
          alerts.push({ type: 'ended', milestone, epic });
          return;
        }
        if (epic.start_date <= today && !isActive && !isDone) {
          alerts.push({ type: 'started', milestone, epic });
        }
      });
    });
    return alerts.sort((a, b) => {
      const aDate = a.type === 'ended' ? a.epic.end_date : a.epic.start_date;
      const bDate = b.type === 'ended' ? b.epic.end_date : b.epic.start_date;
      return aDate.localeCompare(bDate) || a.epic.title.localeCompare(b.epic.title);
    });
  }, [visibleMilestones, today]);

  useEffect(() => {
    const scroller = timelineScrollRef.current;
    if (!scroller || colCount < 1) return;
    if (todayIndex < 0) { scroller.scrollLeft = 0; return; }
    const dayWidth = scroller.firstElementChild.getBoundingClientRect().width / colCount;
    const todayLeft = todayIndex * dayWidth;
    const targetLeft = todayLeft - (scroller.clientWidth - dayWidth) / 2;
    scroller.scrollLeft = Math.max(0, Math.min(targetLeft, scroller.scrollWidth - scroller.clientWidth));
  }, [project?.id, todayIndex, colCount, dateGridTemplate, timelineScale, range.start, range.end]);

  const spanFor = axis.spanFor;

  function startAddEpic(milestone) {
    setCollapsedMilestones((prev) => { const next = new Set(prev); next.delete(milestone.id); return next; });
    setEpicDraft({ name: '', owner: '', status: 'planned', start_date: milestone.start_date, end_date: milestone.start_date });
    setWorkModal({ mode: 'add', milestone });
  }

  function commitAddEpic() {
    if (!workModal?.milestone || !epicDraft.name.trim()) {
      setWorkModal(null);
      return;
    }
    onAddEpic(workModal.milestone, epicDraft);
    setEpicDraft({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });
    setWorkModal(null);
  }

  function startEditEpic(epic, milestone) {
    setEditDraft({
      name: epic.title,
      owner: epic.owner || '',
      status: normalizeStatus(epic.status),
      start_date: epic.start_date,
      end_date: epic.end_date,
    });
    setWorkModal({ mode: 'edit', milestone, epic });
  }

  function commitEditEpic() {
    if (!workModal?.epic || !editDraft.name.trim()) {
      setWorkModal(null);
      return;
    }
    onUpdateEpic(workModal.epic, editDraft);
    setWorkModal(null);
  }

  async function updateWorkStatusFromAlert(epic, status) {
    setTimelineActionId(epic.id + ':' + status);
    try {
      await onUpdateEpic(epic, {
        name: epic.title,
        owner: epic.owner || '',
        status,
        start_date: epic.start_date,
        end_date: epic.end_date,
      });
    } finally {
      setTimelineActionId('');
    }
  }

  function openAddMilestoneModal() {
    setWorkModal(null);
    setMilestoneDraft((prev) => ({
      ...prev,
      title: prev.title || '',
      start_date: prev.start_date || todayIso(),
      end_date: prev.end_date || prev.start_date || todayIso(),
    }));
    setAddingMilestone(true);
    setMilestoneModal({ mode: 'add' });
  }

  function startEditMilestone(milestone) {
    setWorkModal(null);
    setAddingMilestone(false);
    setMilestoneEditDraft({ title: milestone.title, start_date: milestone.start_date, end_date: milestone.end_date });
    setMilestoneModal({ mode: 'edit', milestone });
  }

  function closeMilestoneModal() {
    setMilestoneModal(null);
    setAddingMilestone(false);
  }

  function commitAddMilestoneModal() {
    if (!milestoneDraft.title.trim()) {
      closeMilestoneModal();
      return;
    }
    onAddMilestone();
    closeMilestoneModal();
  }

  function commitEditMilestoneModal() {
    if (!milestoneModal?.milestone || !milestoneEditDraft.title.trim()) {
      closeMilestoneModal();
      return;
    }
    onUpdateMilestone(milestoneModal.milestone, milestoneEditDraft);
    closeMilestoneModal();
  }

  function renderMilestoneLabel(milestone) {
    return (
      <div className="mt-row-label milestone-label" key={`axis-${milestone.id}`}>
        <button className="milestone-collapse" type="button"
          aria-label={`${milestone.title} 워크 ${collapsedMilestones.has(milestone.id) ? '펼치기' : '접기'}`}
          aria-expanded={!collapsedMilestones.has(milestone.id)}
          title={`${collapsedMilestones.has(milestone.id) ? '워크 펼치기' : '워크 전체 숨기기'} (${milestone.epics.length}개)`}
          disabled={milestone.epics.length === 0}
          onClick={() => toggleMilestoneWorks(milestone.id)}>
          <ChevronRight size={16} />
        </button>
        <div className="milestone-label-copy">
          <div className="name" title={milestone.title}>{milestone.title}</div>
          <div className="meta">{milestone.start_date} → {milestone.end_date}</div>
        </div>
        <div className="row-actions">
          <button className="mt-add-work-inline" onClick={() => startAddEpic(milestone)}><Plus size={12} />Work</button>
          <button className="mt-icon-action always" onClick={() => startEditMilestone(milestone)} aria-label="마일스톤 편집"><Pencil size={13} /></button>
          <button className="mt-delete always" onClick={() => onRemoveMilestone(milestone.id)} aria-label="마일스톤 삭제"><Trash2 size={13} /></button>
        </div>
      </div>
    );
  }

  function renderEpicLabel(epic, milestone, isLast) {
    const statusKey = normalizeStatus(epic.status);
    const status = STATUS_STYLE[statusKey] || STATUS_STYLE.planned;
    return (
      <div data-work-id={epic.id} data-milestone-id={milestone.id}
        className={"mt-row-label epic status-row-" + statusKey + (isLast ? " last" : "") + (workDrag?.sourceId === epic.id ? " work-dragging" : "") + (workDrag?.targetId === epic.id && workDrag.sourceId !== epic.id ? (workDrag.after ? " work-drop-after" : " work-drop-before") : "")} key={`axis-${epic.id}`}>
        <button className="work-drag-handle" type="button" disabled={orderSaving}
          aria-label={`${epic.title} 순서 이동`} title="드래그로 순서 이동 · 키보드 ↑↓"
          onPointerDown={(e) => {
            if (e.button !== 0 || orderSavingRef.current) return;
            e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
            const drag = { milestoneId: milestone.id, sourceId: epic.id, targetId: null, after: false };
            workDragRef.current = drag; setWorkDrag(drag);
          }}
          onPointerMove={moveWorkPointer} onPointerUp={finishWorkPointer}
          onPointerCancel={cancelWorkDrag} onLostPointerCapture={cancelWorkDrag}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { cancelWorkDrag(); return; }
            if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
            e.preventDefault();
            const index = milestone.epics.findIndex((item) => item.id === epic.id);
            const target = milestone.epics[index + (e.key === 'ArrowUp' ? -1 : 1)];
            if (target) saveWorkOrder(milestone.id, epic.id, target.id, e.key === 'ArrowDown');
          }}><GripVertical size={15} /></button>
        <div className="work-label-copy">
          <div className="work-title-line"><div className="name">{epic.title}</div><span className={"mt-badge status-" + statusKey} style={{ background: status.bg, color: status.text, borderColor: status.border }}>{status.label}</span></div>
          <div className="meta"><span className="mt-avatar"><User size={9} /></span>{epic.owner || "담당 미지정"}</div>
        </div>
        <div className="row-actions">
          <button className="mt-icon-action" onClick={() => startEditEpic(epic, milestone)} aria-label="Work 편집"><Pencil size={13} /></button>
          <button className="mt-delete" onClick={() => onRemoveEpic(epic.id)} aria-label="Work 삭제"><Trash2 size={13} /></button>
        </div>
      </div>
    );
  }


  const activeWorkDraft = workModal?.mode === 'edit' ? editDraft : epicDraft;
  const setActiveWorkDraft = workModal?.mode === 'edit' ? setEditDraft : setEpicDraft;

  return (
    <>
    <article className="mt-card project-card">
      <div className="mt-card-head">
        <p className="mt-card-eyebrow"><AudioWaveform size={14} color="#4F46E5" />Project Timeline</p>
        <p className="mt-card-sub mono">{range.start} → {range.end} · Milestone {visibleMilestones.length}/{milestones.length}개</p>
      </div>

      {timelineAlerts.length > 0 && (
        <section className="timeline-alert-panel" aria-label="Project Timeline 알림">
          <div className="timeline-alert-head">
            <div>
              <h3>오늘 확인할 Work</h3>
              <p>한국 날짜 {today.replaceAll('-', '.')} 기준으로 시작 또는 종료된 Work입니다.</p>
            </div>
            <span>{timelineAlerts.length}건</span>
          </div>
          <div className="timeline-alert-list">
            {timelineAlerts.map(({ type, milestone, epic }) => {
              const isEnded = type === 'ended';
              return (
                <article className={"timeline-alert-item " + (isEnded ? 'ended' : 'started')} key={epic.id + '-' + type}>
                  <div className="timeline-alert-copy">
                    <span>{isEnded ? '수행 기간 종료' : '수행 시작'}</span>
                    <h4>{epic.title}</h4>
                    <p>{milestone.title} · {epic.owner || '담당 미지정'} · {epic.start_date} ~ {epic.end_date}</p>
                  </div>
                  <div className="timeline-alert-actions">
                    {isEnded ? (
                      <>
                        <button type="button" disabled={!!timelineActionId} onClick={() => updateWorkStatusFromAlert(epic, 'done')}>완료</button>
                        <button type="button" className="delay" disabled={!!timelineActionId} onClick={() => updateWorkStatusFromAlert(epic, 'done_delayed')}>완료 지연</button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={!!timelineActionId} onClick={() => updateWorkStatusFromAlert(epic, 'in_progress')}>진행중</button>
                        <button type="button" className="delay" disabled={!!timelineActionId} onClick={() => updateWorkStatusFromAlert(epic, 'in_progress_delayed')}>진행 지연</button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="timeline-scale-toolbar">
        <form className="timeline-time-filter" onSubmit={applyTimeFilter} noValidate aria-label="타임라인 기간 필터">
          <span className="timeline-filter-label">기간</span>
          <label><span>시작일</span><input type="date" aria-label="타임라인 시작일" value={filterDraft.start} onChange={(e) => changeTimeFilter('start', e.target.value)} required /></label>
          <span className="timeline-date-separator" aria-hidden="true">–</span>
          <label><span>종료일</span><input type="date" aria-label="타임라인 종료일" value={filterDraft.end} onChange={(e) => changeTimeFilter('end', e.target.value)} required /></label>
          <button className="timeline-filter-apply" type="submit">적용</button>
          <button className="timeline-filter-reset" type="button" onClick={resetTimeFilter}>전체 기간</button>
        </form>
        <div className="timeline-scale-controls">
        <span>타임라인 기준</span>
        <div className="timeline-scale-switch" role="group" aria-label="타임라인 가로축 기준">
          {[['day', '일간'], ['week', '주간'], ['month', '월간']].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={timelineScale === value} onClick={() => setTimelineScale(value)}>{label}</button>
          ))}
        </div>
        </div>
      </div>
      {filterError && <p className="timeline-filter-error" role="alert">{filterError}</p>}
      <div className="work-order-status" role="status" aria-live="polite">{orderSaving ? '워크 순서 저장 중…' : orderMessage || '워크 왼쪽 손잡이를 드래그해 순서를 바꿀 수 있습니다.'}</div>
      <div className="mt-split-wrap">
        <div className="mt-axis-col">
          <div className="mt-headercell timeline-axis-head">
            <span>Milestone / Work</span>
            <label className="timeline-hide-done-toggle">
              <input type="checkbox" checked={hideDoneWorks} onChange={(e) => setHideDoneWorks(e.target.checked)} />
              <span>완료 숨기기</span>
              <b>{completedMilestoneCount}</b>
            </label>
          </div>
          {visibleMilestones.map((milestone) => (
            <React.Fragment key={`axis-${milestone.id}`}>
              {renderMilestoneLabel(milestone)}
              {!collapsedMilestones.has(milestone.id) && milestone.epics.map((epic, index) => renderEpicLabel(epic, milestone, index === milestone.epics.length - 1))}
            </React.Fragment>
          ))}
          <div className="timeline-add-milestone axis">
            <button className="add-milestone-btn" onClick={openAddMilestoneModal}><Plus size={15} />마일스톤 추가</button>
          </div>
        </div>

        <div className="mt-calendar-scroll" ref={timelineScrollRef}>
          <div className={`mt-calendar-grid timeline-scale-${timelineScale}`} style={{ gridTemplateColumns: dateGridTemplate, width: calendarWidth }}>
            <div className="mt-calendar-bg-layer" aria-hidden="true">
              {axis.cells.map((cell) => <div key={`bg-${cell.key}`} className={`mt-calendar-bg-cell${cell.boundary ? ' period-boundary' : ''}`} />)}
            </div>
            {axis.groups.map((group) => (
              <div key={group.key} title={group.hint} className={`mt-daycell mt-period-cell${todayIndex >= group.startCol && todayIndex < group.startCol + group.count ? ' today' : ''}`} style={{ gridColumn: `${group.startCol + 1} / span ${group.count}` }}>
                <div className="mt-period-title">{group.label}</div>
                <div className="mt-period-subcells" style={{ gridTemplateColumns: `repeat(${group.count}, minmax(0, 1fr))` }}>
                  {axis.cells.slice(group.startCol, group.startCol + group.count).map((cell, index) => <span key={cell.key} className={todayIndex === group.startCol + index ? 'is-today' : ''}>{cell.label}</span>)}
                </div>
              </div>
            ))}

            {visibleMilestones.map((milestone) => {
              const milestoneSpan = spanFor(milestone.start_date, milestone.end_date);
              return (
                <React.Fragment key={`calendar-${milestone.id}`}>
                  <div className="mt-track milestone-track" style={{ gridColumn: `1 / span ${colCount}`, gridTemplateColumns: dateGridTemplate }}>
                    {milestoneSpan && <div className="milestone-bar" title={`${milestone.title} · ${milestone.start_date} ~ ${milestone.end_date}`} style={{ gridColumn: `${milestoneSpan.startCol + 1} / span ${milestoneSpan.colSpan}` }}>
                      <AudioWaveform size={14} className="icon" />
                      <span className="label">{milestone.title}</span>
                      <span className="count">{milestone.epics.length} works</span>
                    </div>}
                  </div>

                  {!collapsedMilestones.has(milestone.id) && milestone.epics.map((epic, index) => {
                    const epicSpan = spanFor(epic.start_date, epic.end_date);
                    return (
                      <div className="mt-track" key={`calendar-${epic.id}`} style={{ gridColumn: `1 / span ${colCount}`, gridTemplateColumns: dateGridTemplate }}>
                        {epicSpan && <div className="mt-bar" title={`${epic.title} · ${epic.start_date} ~ ${epic.end_date}`} style={{ gridColumn: `${epicSpan.startCol + 1} / span ${epicSpan.colSpan}`, background: epic.color || accentFor(index).bar }}>
                          <span className="label">{epic.title}</span>
                        </div>}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}

            <div className="timeline-add-milestone calendar" style={{ gridColumn: `1 / span ${colCount}` }}></div>
          </div>
        </div>
      </div>
    </article>

    {milestoneModal && (
      <div className="modal-backdrop" role="presentation">
        <div className="project-modal work-modal milestone-modal" role="dialog" aria-modal="true" aria-labelledby="milestone-modal-title">
          <div className="project-modal-head">
            <div>
              <h2 id="milestone-modal-title">{milestoneModal.mode === 'edit' ? '마일스톤 수정' : '마일스톤 추가'}</h2>
              <p>{project?.title || 'Project Timeline'}</p>
            </div>
            <button className="icon-btn" type="button" onClick={closeMilestoneModal} aria-label="닫기"><X size={16} /></button>
          </div>
          <div className="work-modal-form">
            <label>
              <span>마일스톤 이름</span>
              <input value={milestoneModal.mode === 'edit' ? milestoneEditDraft.title : milestoneDraft.title} autoFocus onChange={(e) => milestoneModal.mode === 'edit' ? setMilestoneEditDraft({ ...milestoneEditDraft, title: e.target.value }) : setMilestoneDraft({ ...milestoneDraft, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (milestoneModal.mode === 'edit' ? commitEditMilestoneModal() : commitAddMilestoneModal())} />
            </label>
            <label>
              <span>시작일</span>
              <input type="date" value={milestoneModal.mode === 'edit' ? milestoneEditDraft.start_date : milestoneDraft.start_date} onChange={(e) => milestoneModal.mode === 'edit' ? setMilestoneEditDraft({ ...milestoneEditDraft, start_date: e.target.value }) : setMilestoneDraft({ ...milestoneDraft, start_date: e.target.value })} />
            </label>
            <label>
              <span>종료일</span>
              <input type="date" value={milestoneModal.mode === 'edit' ? milestoneEditDraft.end_date : milestoneDraft.end_date} onChange={(e) => milestoneModal.mode === 'edit' ? setMilestoneEditDraft({ ...milestoneEditDraft, end_date: e.target.value }) : setMilestoneDraft({ ...milestoneDraft, end_date: e.target.value })} />
            </label>
          </div>
          <div className="project-modal-actions">
            <button className="mt-btn" type="button" onClick={closeMilestoneModal}>취소</button>
            <button className="mt-btn primary" type="button" onClick={milestoneModal.mode === 'edit' ? commitEditMilestoneModal : commitAddMilestoneModal}>{milestoneModal.mode === 'edit' ? '저장' : '추가'}</button>
          </div>
        </div>
      </div>
    )}

    {workModal && (
      <div className="modal-backdrop" role="presentation">
        <div className="project-modal work-modal" role="dialog" aria-modal="true" aria-labelledby="work-modal-title">
          <div className="project-modal-head">
            <div>
              <h2 id="work-modal-title">{workModal.mode === 'edit' ? 'Work 수정' : 'Work 추가'}</h2>
              <p>{workModal.milestone?.title} · {workModal.milestone?.start_date} ~ {workModal.milestone?.end_date}</p>
            </div>
            <button className="icon-btn" type="button" onClick={() => setWorkModal(null)} aria-label="닫기"><X size={16} /></button>
          </div>
          <div className="work-modal-form">
            <label>
              <span>Work 이름</span>
              <input value={activeWorkDraft.name} autoFocus onChange={(e) => setActiveWorkDraft({ ...activeWorkDraft, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (workModal.mode === 'edit' ? commitEditEpic() : commitAddEpic())} />
            </label>
            <label>
              <span>담당</span>
              <input value={activeWorkDraft.owner} placeholder="담당 미지정" onChange={(e) => setActiveWorkDraft({ ...activeWorkDraft, owner: e.target.value })} />
            </label>
            <label>
              <span>상태</span>
              <select value={activeWorkDraft.status} onChange={(e) => setActiveWorkDraft({ ...activeWorkDraft, status: e.target.value })}>
                <option value="planned">예정</option>
                <option value="in_progress">진행중</option>
                <option value="in_progress_delayed">진행 지연</option>
                <option value="done">완료</option>
                <option value="done_delayed">완료 지연</option>
              </select>
            </label>
            <label>
              <span>시작일</span>
              <input type="date" min={workModal.milestone?.start_date} max={workModal.milestone?.end_date} value={activeWorkDraft.start_date} onChange={(e) => setActiveWorkDraft({ ...activeWorkDraft, start_date: e.target.value })} />
            </label>
            <label>
              <span>종료일</span>
              <input type="date" min={workModal.milestone?.start_date} max={workModal.milestone?.end_date} value={activeWorkDraft.end_date} onChange={(e) => setActiveWorkDraft({ ...activeWorkDraft, end_date: e.target.value })} />
            </label>
          </div>
          <div className="project-modal-actions">
            <button className="mt-btn" type="button" onClick={() => setWorkModal(null)}>취소</button>
            <button className="mt-btn primary" type="button" onClick={workModal.mode === 'edit' ? commitEditEpic : commitAddEpic}>{workModal.mode === 'edit' ? '저장' : '추가'}</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// Normalize the service route so relative build assets also work after refresh.
const servicePath = window.location.pathname.slice(SERVICE_PREFIX.length) || '/';
if (servicePath === '/agent/') {
  window.location.replace(SERVICE_PREFIX + '/agent' + window.location.search + window.location.hash);
} else {
  const isIntroduction = servicePath === '/';
  document.title = isIntroduction ? 'WiaReport · 서비스 소개' : 'WiaReport · 주간보고';
  createRoot(document.getElementById('root')).render(isIntroduction ? <Introduction /> : <App />);
}
