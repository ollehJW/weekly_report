import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, AudioWaveform, User, ChevronRight, CornerDownRight, Pencil, Save, X, KeyRound, LogOut, Users, ClipboardList, GripVertical } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:9601';
const DAY = 24 * 60 * 60 * 1000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const INITIAL_PASSWORD = 'wia1234!';
const ACCENTS = [
  { id: 'indigo', bar: '#4F46E5' },
  { id: 'teal', bar: '#0F8B8D' },
  { id: 'coral', bar: '#D8592F' },
  { id: 'amber', bar: '#B8790F' },
];
const STATUS_STYLE = {
  planned: { label: '예정', bg: '#F1F0EC', text: '#6B6A63' },
  in_progress: { label: '진행중', bg: '#EEEDFE', text: '#4F46E5' },
  done: { label: '완료', bg: '#E4F5EC', text: '#0E8F52' },
  blocked: { label: '차단', bg: '#FCF1EC', text: '#B0331C' },
};
const ROLE_LABELS = { L: '리더', CM: '책임매니저', M: '매니저' };
const WAVE_PATTERN = [4, 9, 6, 13, 8, 15, 7, 11, 5, 10, 6, 14, 9, 4, 12, 7];

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

function plusDays(iso, days) {
  const date = toDate(iso);
  date.setDate(date.getDate() + days);
  return isoOf(date);
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
  if (status === '완료') return 'done';
  return status || 'planned';
}

function accentFor(index) {
  return ACCENTS[index % ACCENTS.length];
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail)
      ? body.detail.map((item) => item.msg || JSON.stringify(item)).join(', ')
      : body.detail;
    throw new Error(detail || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function WaveBar({ widthPx, color }) {
  const bars = Math.max(6, Math.round(widthPx / 9));
  return (
    <svg width="100%" height="14" viewBox={`0 0 ${bars * 6} 16`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const amp = WAVE_PATTERN[i % WAVE_PATTERN.length];
        return <rect key={i} x={i * 6 + 1} y={(16 - amp) / 2} width="3" height={amp} rx="1.5" fill={color} opacity="0.9" />;
      })}
    </svg>
  );
}

function App() {
  const [activePage, setActivePage] = useState('tasks');
  const [activeTeamTab, setActiveTeamTab] = useState('members');
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [teams, setTeams] = useState([]);
  const [members, setMembers] = useState([]);
  const [teamProjects, setTeamProjects] = useState([]);
  const [currentTeam, setCurrentTeam] = useState(() => {
    const stored = localStorage.getItem('wiareport_team');
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      return parsed?.team_id ? parsed : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [milestoneDraft, setMilestoneDraft] = useState({ title: '', start_date: todayIso(), end_date: plusDays(todayIso(), 14) });
  const [weeklyReport, setWeeklyReport] = useState(null);
  const [weeklyReportDraft, setWeeklyReportDraft] = useState({ start_date: todayIso(), end_date: plusDays(todayIso(), 7) });
  const [isWeeklyReportModalOpen, setIsWeeklyReportModalOpen] = useState(false);
  const [weeklyWarningMessage, setWeeklyWarningMessage] = useState('');
  const [weeklyPasswordEntry, setWeeklyPasswordEntry] = useState(null);
  const [weeklyPasswordDraft, setWeeklyPasswordDraft] = useState('');
  const [weeklyWritingEntry, setWeeklyWritingEntry] = useState(null);
  const [weeklyEntryProjects, setWeeklyEntryProjects] = useState([]);
  const [selectedWeeklyEntryId, setSelectedWeeklyEntryId] = useState('');
  const [weeklyEntryDraft, setWeeklyEntryDraft] = useState({ progress_log: '', risk_issue: '', next_plan: '' });
  const [teamDraft, setTeamDraft] = useState({ department: '', login_id: '' });
  const [memberDraft, setMemberDraft] = useState({ name: '', role: 'M' });
  const [teamProjectDraft, setTeamProjectDraft] = useState({ project_name: '', leaderId: '', memberIds: [] });
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [editingTeamProjectId, setEditingTeamProjectId] = useState(null);
  const [projectAssignmentDrafts, setProjectAssignmentDrafts] = useState({});
  const [memberPasswordDrafts, setMemberPasswordDrafts] = useState({});
  const [draggingMemberId, setDraggingMemberId] = useState(null);
  const [loginDraft, setLoginDraft] = useState({ login_id: '', password: '' });
  const [passwordDraft, setPasswordDraft] = useState({ current_password: INITIAL_PASSWORD, new_password: '', confirm_password: '' });

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;

  async function loadProjects(nextProjectId, teamId = currentTeam?.team_id) {
    if (!teamId) {
      setProjects([]);
      setSelectedProjectId(null);
      return null;
    }
    const list = await request(`/api/teams/${teamId}/timeline-projects`);
    setProjects(list);
    const fallbackId = list[0]?.id || null;
    const currentStillExists = selectedProjectId && list.some((project) => project.id === selectedProjectId);
    const id = nextProjectId !== undefined ? nextProjectId : currentStillExists ? selectedProjectId : fallbackId;
    setSelectedProjectId(id);
    if (!id) setMilestones([]);
    return id;
  }

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
      setWeeklyReport(null);
      return;
    }
    const report = await request(`/api/teams/${teamId}/reports/active`);
    setWeeklyReport(report);
  }

  async function refresh(projectId) {
    setError('');
    const id = await loadProjects(projectId, currentTeam?.team_id);
    await Promise.all([
      loadMilestones(id),
      loadTeams(),
      currentTeam?.team_id ? loadMembers(currentTeam.team_id) : Promise.resolve(),
      currentTeam?.team_id ? loadTeamProjects(currentTeam.team_id) : Promise.resolve(),
      currentTeam?.team_id ? loadWeeklyReport(currentTeam.team_id) : Promise.resolve(),
    ]);
  }

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    loadMilestones(selectedProjectId).catch((err) => setError(err.message));
  }, [selectedProjectId]);

  useEffect(() => {
    if (currentTeam) localStorage.setItem('wiareport_team', JSON.stringify(currentTeam));
    else localStorage.removeItem('wiareport_team');
  }, [currentTeam]);

  useEffect(() => {
    if (!currentTeam?.team_id) return;
    Promise.all([
      loadMembers(currentTeam.team_id),
      loadTeamProjects(currentTeam.team_id),
      loadWeeklyReport(currentTeam.team_id),
      loadProjects(undefined, currentTeam.team_id).then((projectId) => loadMilestones(projectId)),
    ]).catch((err) => setError(err.message));
  }, [currentTeam?.team_id]);

  async function login() {
    if (!loginDraft.login_id.trim() || !loginDraft.password) return;
    try {
      const team = await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ login_id: loginDraft.login_id.trim(), password: loginDraft.password }),
      });
      setCurrentTeam(team);
      setLoginDraft({ login_id: '', password: '' });
      setPasswordDraft({ current_password: loginDraft.password, new_password: '', confirm_password: '' });
    } catch (err) {
      setError(err.message);
    }
  }

  function logout() {
    setCurrentTeam(null);
    setPasswordDraft({ current_password: INITIAL_PASSWORD, new_password: '', confirm_password: '' });
  }

  async function changePassword() {
    if (!currentTeam?.team_id) {
      setError('로그인 정보가 올바르지 않습니다. 다시 로그인하세요');
      logout();
      return;
    }
    if (!passwordDraft.new_password.trim()) {
      setError('새 비밀번호를 입력하세요');
      return;
    }
    if (passwordDraft.new_password !== passwordDraft.confirm_password) {
      setError('새 비밀번호 확인이 일치하지 않습니다');
      return;
    }
    try {
      const team = await request('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          team_id: currentTeam.team_id,
          current_password: passwordDraft.current_password,
          new_password: passwordDraft.new_password,
        }),
      });
      setCurrentTeam(team);
      setPasswordDraft({ current_password: '', new_password: '', confirm_password: '' });
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function createTeam() {
    if (!teamDraft.department.trim() || !teamDraft.login_id.trim()) return;
    try {
      await request('/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          department: teamDraft.department.trim(),
          login_id: teamDraft.login_id.trim(),
        }),
      });
      setTeamDraft({ department: '', login_id: '' });
      await loadTeams();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createMember() {
    if (!currentTeam?.team_id || !memberDraft.name.trim()) return;
    try {
      await request(`/api/teams/${currentTeam.team_id}/users`, {
        method: 'POST',
        body: JSON.stringify({ name: memberDraft.name.trim(), role: memberDraft.role }),
      });
      setMemberDraft({ name: '', role: 'M' });
      await loadMembers(currentTeam.team_id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createTeamProject() {
    if (!currentTeam?.team_id || !teamProjectDraft.project_name.trim()) return;
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

  async function deleteMember(userId) {
    try {
      await request(`/api/users/${userId}`, { method: 'DELETE' });
      await loadMembers(currentTeam.team_id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateMemberRole(userId, role) {
    if (!currentTeam?.team_id) return;
    const previousMembers = members;
    setMembers((prev) => prev.map((member) => (member.user_id === userId ? { ...member, role } : member)));
    try {
      await request(`/api/users/${userId}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role }),
      });
      await Promise.all([
        loadMembers(currentTeam.team_id),
        loadTeamProjects(currentTeam.team_id),
      ]);
      setError('');
    } catch (err) {
      setMembers(previousMembers);
      setError(err.message);
    }
  }

  async function setMemberPassword(userId) {
    const password = memberPasswordDrafts[userId] || '';
    if (!password.trim()) {
      setError('설정할 비밀번호를 입력하세요');
      return;
    }
    try {
      await request(`/api/users/${userId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      });
      setMemberPasswordDrafts((prev) => ({ ...prev, [userId]: '' }));
      await loadMembers(currentTeam.team_id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetMemberPassword(userId) {
    try {
      await request("/api/users/" + userId + "/password", {
        method: 'PUT',
        body: JSON.stringify({ password: INITIAL_PASSWORD }),
      });
      setMemberPasswordDrafts((prev) => ({ ...prev, [userId]: '' }));
      await loadMembers(currentTeam.team_id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function reorderMembers(nextMembers) {
    if (!currentTeam?.team_id) return;
    const previousMembers = members;
    setMembers(nextMembers);
    try {
      const savedMembers = await request(`/api/teams/${currentTeam.team_id}/users/order`, {
        method: 'PUT',
        body: JSON.stringify({ user_ids: nextMembers.map((member) => member.user_id) }),
      });
      setMembers(savedMembers);
      setError('');
    } catch (err) {
      setMembers(previousMembers);
      setError(err.message);
      await loadMembers(currentTeam.team_id).catch(() => {});
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

  async function createEpic(milestone, draft) {
    if (!draft.name.trim()) return;
    try {
      const accent = accentFor(milestone.epics.length);
      await request(`/api/milestones/${milestone.id}/epics`, {
        method: 'POST',
        body: JSON.stringify({
          title: draft.name.trim(),
          owner: draft.owner.trim(),
          status: 'planned',
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
      setWeeklyReport(report);
      setIsWeeklyReportModalOpen(false);
      setError('');
    } catch (err) {
      if (err.message === '이미 진행중인 보고가 있습니다') {
        setWeeklyWarningMessage(err.message);
        setError('');
      } else {
        setError(err.message);
      }
    }
  }

  async function deleteWeeklyReport(reportId) {
    if (!reportId) return;
    try {
      await request(`/api/reports/${reportId}`, { method: 'DELETE' });
      setWeeklyReport(null);
      setWeeklyPasswordEntry(null);
      setWeeklyPasswordDraft('');
      closeWeeklyEntryModal();
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function completeWeeklyReport(reportId) {
    if (!reportId) return;
    try {
      await request(`/api/reports/${reportId}/complete`, { method: 'PUT' });
      setWeeklyReport(null);
      setWeeklyPasswordEntry(null);
      setWeeklyPasswordDraft('');
      closeWeeklyEntryModal();
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleWeeklyAbsence(member) {
    if (!weeklyReport?.report_id) return;
    try {
      const report = await request(`/api/reports/${weeklyReport.report_id}/users/${member.user_id}/absence`, { method: 'PUT' });
      setWeeklyReport(report);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  function openWeeklyPassword(entry) {
    setWeeklyPasswordEntry(entry);
    setWeeklyPasswordDraft('');
    setError('');
  }

  async function authorizeWeeklyEntry() {
    if (!weeklyPasswordEntry || !weeklyPasswordDraft || !weeklyReport?.report_id) {
      setError('비밀번호를 입력하세요');
      return;
    }
    try {
      const result = await request(`/api/reports/${weeklyReport.report_id}/users/${weeklyPasswordEntry.user_id}/authorize`, {
        method: 'POST',
        body: JSON.stringify({ password: weeklyPasswordDraft }),
      });
      const nextProjects = result.projects || [];
      const firstProject = nextProjects[0] || null;
      setWeeklyEntryProjects(nextProjects);
      setSelectedWeeklyEntryId(firstProject?.project_id || '');
      setWeeklyWritingEntry(weeklyPasswordEntry);
      setWeeklyEntryDraft({
        progress_log: firstProject?.progress_log || '',
        risk_issue: firstProject?.risk_issue || '',
        next_plan: firstProject?.next_plan || '',
      });
      setWeeklyPasswordEntry(null);
      setWeeklyPasswordDraft('');
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  function selectWeeklyProject(project) {
    setSelectedWeeklyEntryId(project.project_id);
    setWeeklyEntryDraft({
      progress_log: project.progress_log || '',
      risk_issue: project.risk_issue || '',
      next_plan: project.next_plan || '',
    });
  }

  async function saveWeeklyEntry(projectId = selectedWeeklyEntryId) {
    const project = weeklyEntryProjects.find((item) => item.project_id === projectId);
    if (!weeklyWritingEntry || !project) return;
    try {
      const report = await request(`/api/report-entries/${project.entry_id}/projects/${project.project_id}`, {
        method: 'PUT',
        body: JSON.stringify(weeklyEntryDraft),
      });
      setWeeklyReport(report);
      setWeeklyEntryProjects((prev) => prev.map((item) => (item.project_id === project.project_id ? { ...item, ...weeklyEntryDraft, is_excluded: false, status: 'done' } : item)));
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
      setWeeklyReport(report);
      setWeeklyEntryProjects((prev) => prev.map((item) => (item.project_id === project.project_id ? { ...item, is_excluded: isExcluded, status: isExcluded ? 'excluded' : 'pending', progress_log: isExcluded ? '' : item.progress_log, risk_issue: isExcluded ? '' : item.risk_issue, next_plan: isExcluded ? '' : item.next_plan } : item)));
      if (selectedWeeklyEntryId === project.project_id && isExcluded) {
        setWeeklyEntryDraft({ progress_log: '', risk_issue: '', next_plan: '' });
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
    setWeeklyEntryDraft({ progress_log: '', risk_issue: '', next_plan: '' });
  }

  if (!currentTeam) {
    return (
      <LoginPage
        loginDraft={loginDraft}
        setLoginDraft={setLoginDraft}
        onLogin={login}
        teams={teams}
        teamDraft={teamDraft}
        setTeamDraft={setTeamDraft}
        onCreateTeam={createTeam}
        error={error}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <AudioWaveform size={22} />
          <div>
            <h1>WiaReport</h1>
            <span>task timeline</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="주요 메뉴">
          <button className={`side-tab${activePage === 'tasks' ? ' active' : ''}`} type="button" onClick={() => setActivePage('tasks')}>과제 현황</button>
          <button className={`side-tab${activePage === 'weekly-report' ? ' active' : ''}`} type="button" onClick={() => setActivePage('weekly-report')}>주간 보고 작성</button>
          <button className={`side-tab${activePage === 'weekly-lounge' ? ' active' : ''}`} type="button" onClick={() => setActivePage('weekly-lounge')}>주간 보고 라운지</button>
          <button className={`side-tab${activePage === 'team' ? ' active' : ''}`} type="button" onClick={() => setActivePage('team')}>팀 관리</button>
          <button className={`side-tab${activePage === 'accounts' ? ' active' : ''}`} type="button" onClick={() => setActivePage('accounts')}>계정 관리</button>
        </nav>

        <div className="side-user">
          <div className="avatar">{currentTeam.department.slice(0, 1)}</div>
          <div className="side-user-info">
            <b>{currentTeam.department}</b>
            <span>{currentTeam.login_id}</span>
          </div>
          <button className="side-logout" type="button" onClick={logout} aria-label="로그아웃"><LogOut size={16} /></button>
        </div>
      </aside>

      <section className="workspace">
        {error && <div className="error">{error}</div>}
        {activePage === 'tasks' && (
          <>
            <div className="page-head">
              <div>
                <h1>과제 현황</h1>
              </div>
              <div className="project-toolbar" aria-label="과제 선택">
                <div className="project-toolbar-meta">
                  <span>진행중 과제</span>
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
              />
            )}
          </>
        )}
        {activePage === 'weekly-report' && (
          <WeeklyReportPage
            members={members}
            weeklyReport={weeklyReport}
            weeklyReportDraft={weeklyReportDraft}
            setWeeklyReportDraft={setWeeklyReportDraft}
            isWeeklyReportModalOpen={isWeeklyReportModalOpen}
            setIsWeeklyReportModalOpen={setIsWeeklyReportModalOpen}
            onCreateWeeklyReportPeriod={createWeeklyReportPeriod}
            weeklyWarningMessage={weeklyWarningMessage}
            setWeeklyWarningMessage={setWeeklyWarningMessage}
            onDeleteWeeklyReport={deleteWeeklyReport}
            onCompleteWeeklyReport={completeWeeklyReport}
            onToggleWeeklyAbsence={toggleWeeklyAbsence}
            onOpenWeeklyPassword={openWeeklyPassword}
            weeklyPasswordEntry={weeklyPasswordEntry}
            weeklyPasswordDraft={weeklyPasswordDraft}
            setWeeklyPasswordDraft={setWeeklyPasswordDraft}
            onAuthorizeWeeklyEntry={authorizeWeeklyEntry}
            setWeeklyPasswordEntry={setWeeklyPasswordEntry}
            weeklyWritingEntry={weeklyWritingEntry}
            weeklyEntryProjects={weeklyEntryProjects}
            weeklyEntryDraft={weeklyEntryDraft}
            setWeeklyEntryDraft={setWeeklyEntryDraft}
            selectedWeeklyEntryId={selectedWeeklyEntryId}
            onSelectWeeklyProject={selectWeeklyProject}
            onSaveWeeklyEntry={saveWeeklyEntry}
            onUpdateWeeklyEntryStatus={updateWeeklyEntryStatus}
            onCloseWeeklyEntryModal={closeWeeklyEntryModal}
          />
        )}
        {activePage === 'weekly-lounge' && <WeeklyReportLoungePage />}
        {activePage === 'team' && (
          <TeamManagementPage
            activeTeamTab={activeTeamTab}
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
            memberPasswordDrafts={memberPasswordDrafts}
            setMemberPasswordDrafts={setMemberPasswordDrafts}
            onCreateMember={createMember}
            onCreateTeamProject={createTeamProject}
            onEditTeamProject={openTeamProjectEditor}
            onSaveProjectMembers={saveProjectMembers}
            onUpdateTeamProjectStatus={updateTeamProjectStatus}
            onDeleteTeamProject={deleteTeamProject}
            onDeleteMember={deleteMember}
            onUpdateMemberRole={updateMemberRole}
            onSetMemberPassword={setMemberPassword}
            onResetMemberPassword={resetMemberPassword}
            onReorderMembers={reorderMembers}
            draggingMemberId={draggingMemberId}
            setDraggingMemberId={setDraggingMemberId}
          />
        )}
        {activePage === 'accounts' && (
          <AccountManagementPage teams={teams} teamDraft={teamDraft} setTeamDraft={setTeamDraft} onCreateTeam={createTeam} />
        )}
      </section>

      {currentTeam?.must_change_password && (
        <PasswordChangeModal passwordDraft={passwordDraft} setPasswordDraft={setPasswordDraft} onChangePassword={changePassword} />
      )}
    </main>
  );
}

function WeeklyReportPage({
  members,
  weeklyReport,
  weeklyReportDraft,
  setWeeklyReportDraft,
  isWeeklyReportModalOpen,
  setIsWeeklyReportModalOpen,
  onCreateWeeklyReportPeriod,
  weeklyWarningMessage,
  setWeeklyWarningMessage,
  onDeleteWeeklyReport,
  onCompleteWeeklyReport,
  onToggleWeeklyAbsence,
  onOpenWeeklyPassword,
  weeklyPasswordEntry,
  weeklyPasswordDraft,
  setWeeklyPasswordDraft,
  onAuthorizeWeeklyEntry,
  setWeeklyPasswordEntry,
  weeklyWritingEntry,
  weeklyEntryProjects,
  weeklyEntryDraft,
  setWeeklyEntryDraft,
  selectedWeeklyEntryId,
  onSelectWeeklyProject,
  onSaveWeeklyEntry,
  onUpdateWeeklyEntryStatus,
  onCloseWeeklyEntryModal,
}) {
  const entries = weeklyReport?.entries || [];
  const activeEntryName = weeklyPasswordEntry ? `${weeklyPasswordEntry.name} ${weeklyPasswordEntry.role}` : '';
  const writingEntryName = weeklyWritingEntry ? `${weeklyWritingEntry.name} ${weeklyWritingEntry.role}` : '';
  const selectedWeeklyProject = weeklyEntryProjects.find((project) => project.project_id === selectedWeeklyEntryId) || null;
  const reportMembers = weeklyReport?.members || [];
  const canCompleteReport = reportMembers.length > 0 && reportMembers.every((member) => member.status === 'done' || member.status === 'absent');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>주간 보고 작성</h1>
        </div>
        <button className="weekly-open-btn" type="button" onClick={() => setIsWeeklyReportModalOpen(true)}><Plus size={16} />새 보고 주간 개설</button>
      </div>

      {weeklyReport ? (
        <section className="weekly-report-section">
          <div className="weekly-report-head">
            <div>
              <h2>진행중인 보고</h2>
              <p>{weeklyReport.start_date} ~ {weeklyReport.end_date}</p>
            </div>
            <div className="weekly-report-head-actions">
              <button className="weekly-complete-btn" type="button" disabled={!canCompleteReport} title={canCompleteReport ? '보고를 완료합니다' : '모든 멤버가 작성 완료 또는 부재 상태여야 활성화됩니다'} onClick={() => onCompleteWeeklyReport(weeklyReport.report_id)}>완료</button>
              <button className="weekly-delete-btn" type="button" onClick={() => onDeleteWeeklyReport(weeklyReport.report_id)}>삭제</button>
            </div>
          </div>
          <div className="weekly-member-grid">
            {(weeklyReport.members || []).map((member) => (
              <article className={`weekly-member-card${member.status === 'absent' ? ' absent' : ''}${member.status === 'done' ? ' done' : ''}`} key={member.user_id}>
                <div className="weekly-card-main">
                  <strong>{member.name} {member.role}</strong>
                  <span className={`weekly-status-pill ${member.status || 'pending'}`}>{member.status === 'done' ? '작성 완료' : member.status === 'progress' ? '작성중' : member.status === 'absent' ? '부재' : '대기'}</span>
                </div>
                <div className="weekly-card-actions">
                  <button className={`weekly-card-btn${member.status === 'absent' ? ' active' : ''}`} type="button" onClick={() => onToggleWeeklyAbsence(member)}>부재</button>
                  <button className="weekly-card-btn primary" type="button" disabled={member.status === 'absent'} onClick={() => onOpenWeeklyPassword(member)}>작성</button>
                </div>
              </article>
            ))}
            {(weeklyReport.members || []).length === 0 && <div className="empty compact">보고 대상 멤버가 없습니다</div>}
          </div>
        </section>
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

      {weeklyPasswordEntry && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-report-modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-password-title">
            <div className="project-modal-head">
              <div>
                <h2 id="weekly-password-title">비밀번호 확인</h2>
                <p>{activeEntryName} 보고 작성을 시작합니다.</p>
              </div>
              <button className="icon-btn" type="button" onClick={() => setWeeklyPasswordEntry(null)} aria-label="닫기"><X size={16} /></button>
            </div>
            <input type="password" placeholder="멤버 비밀번호" value={weeklyPasswordDraft} onChange={(e) => setWeeklyPasswordDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAuthorizeWeeklyEntry()} autoFocus />
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={() => setWeeklyPasswordEntry(null)}>취소</button>
              <button className="mt-btn primary" type="button" onClick={onAuthorizeWeeklyEntry}>확인</button>
            </div>
          </div>
        </div>
      )}

      {weeklyWritingEntry && (
        <div className="modal-backdrop" role="presentation">
          <div className="weekly-entry-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-entry-title">
            <div className="project-modal-head">
              <div>
                <h2 id="weekly-entry-title">주간 보고 작성</h2>
                <p>{writingEntryName}</p>
              </div>
              <button className="icon-btn" type="button" onClick={onCloseWeeklyEntryModal} aria-label="닫기"><X size={16} /></button>
            </div>
            <div className="weekly-entry-layout">
              <aside className="weekly-project-list" aria-label="참여 과제">
                {weeklyEntryProjects.map((project) => (
                  <button className={selectedWeeklyEntryId === project.project_id ? 'active' : ''} type="button" key={`${project.entry_id}-${project.project_id}`} onClick={() => onSelectWeeklyProject(project)}>
                    <span>{project.project_name}</span>
                    {project.status === 'done' && <b className="entry-state done">작성 완료</b>}
                    {project.status === 'excluded' && <b className="entry-state excluded">제외</b>}
                  </button>
                ))}
                {weeklyEntryProjects.length === 0 && <div className="empty compact">참여 중인 진행 과제가 없습니다</div>}
              </aside>
              <section className="weekly-entry-panel">
                {selectedWeeklyProject ? (
                  <>
                    <div className="weekly-entry-panel-head">
                      <div>
                        <h3>{selectedWeeklyProject.project_name}</h3>
                        <p>과제별로 이번 주 내용을 작성합니다.</p>
                      </div>
                      <button className={`weekly-exclude-btn${selectedWeeklyProject.status === 'excluded' ? ' active' : ''}`} type="button" onClick={() => onUpdateWeeklyEntryStatus(selectedWeeklyProject.project_id, selectedWeeklyProject.status !== 'excluded')}>
                        {selectedWeeklyProject.status === 'excluded' ? '제외 해제' : '이번 주 제외'}
                      </button>
                    </div>
                    <div className="weekly-entry-fields stacked">
                      <label>
                        <span>Progress Log</span>
                        <textarea disabled={selectedWeeklyProject.status === 'excluded'} value={weeklyEntryDraft.progress_log} onChange={(e) => setWeeklyEntryDraft({ ...weeklyEntryDraft, progress_log: e.target.value })} placeholder="이번 주 진행 내용을 입력하세요" />
                      </label>
                      <label>
                        <span>Risk & Issue</span>
                        <textarea disabled={selectedWeeklyProject.status === 'excluded'} value={weeklyEntryDraft.risk_issue} onChange={(e) => setWeeklyEntryDraft({ ...weeklyEntryDraft, risk_issue: e.target.value })} placeholder="리스크와 이슈를 입력하세요" />
                      </label>
                      <label>
                        <span>Next Plan</span>
                        <textarea disabled={selectedWeeklyProject.status === 'excluded'} value={weeklyEntryDraft.next_plan} onChange={(e) => setWeeklyEntryDraft({ ...weeklyEntryDraft, next_plan: e.target.value })} placeholder="다음 주 계획을 입력하세요" />
                      </label>
                    </div>
                    <div className="project-modal-actions">
                      <button className="mt-btn" type="button" onClick={onCloseWeeklyEntryModal}>닫기</button>
                      <button className="mt-btn primary" type="button" disabled={selectedWeeklyProject.status === 'excluded'} onClick={() => onSaveWeeklyEntry(selectedWeeklyProject.project_id)}>저장</button>
                    </div>
                  </>
                ) : (
                  <div className="empty">선택 가능한 과제가 없습니다</div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


function WeeklyReportLoungePage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>주간 보고 라운지</h1>
        </div>
      </div>
      <section className="weekly-report-section empty-lounge" />
    </>
  );
}

function LoginPage({ loginDraft, setLoginDraft, onLogin, teams, teamDraft, setTeamDraft, onCreateTeam, error }) {
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-brand">
          <div className="wia-mark">WIA</div>
          <div>
            <b>WiaReport</b>
            <p>프로젝트 마일스톤과 팀 계정을 한 곳에서 관리합니다.</p>
          </div>
        </div>
        <div className="login-card">
          <div className="login-card-head">
            <span>TEAM ACCESS</span>
            <h1>로그인</h1>
            <p>부여받은 팀 ID와 비밀번호로 접속하세요.</p>
          </div>
          {error && <div className="login-error">{error}</div>}
          <label className="login-field">
            <span>ID</span>
            <input value={loginDraft.login_id} onChange={(e) => setLoginDraft({ ...loginDraft, login_id: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onLogin()} autoFocus />
          </label>
          <label className="login-field">
            <span>비밀번호</span>
            <input type="password" value={loginDraft.password} onChange={(e) => setLoginDraft({ ...loginDraft, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onLogin()} />
          </label>
          <button className="primary-btn login-submit" type="button" onClick={onLogin}><KeyRound size={15} />로그인</button>

          {teams.length === 0 && (
            <div className="first-team-box">
              <div>
                <b>첫 팀 계정 생성</b>
                <p>등록된 팀 계정이 없습니다. 초기 접속용 팀 계정을 먼저 부여하세요.</p>
              </div>
              <input placeholder="소속" value={teamDraft.department} onChange={(e) => setTeamDraft({ ...teamDraft, department: e.target.value })} />
              <input placeholder="ID" value={teamDraft.login_id} onChange={(e) => setTeamDraft({ ...teamDraft, login_id: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onCreateTeam()} />
              <button className="line-btn" type="button" onClick={onCreateTeam}>계정 부여</button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}


function TeamManagementPage({ activeTeamTab, setActiveTeamTab, currentTeam, members, teamProjects, teamProjectDraft, setTeamProjectDraft, isProjectModalOpen, setIsProjectModalOpen, editingTeamProjectId, setEditingTeamProjectId, projectAssignmentDrafts, setProjectAssignmentDrafts, memberDraft, setMemberDraft, memberPasswordDrafts, setMemberPasswordDrafts, onCreateMember, onCreateTeamProject, onEditTeamProject, onSaveProjectMembers, onUpdateTeamProjectStatus, onDeleteTeamProject, onDeleteMember, onUpdateMemberRole, onSetMemberPassword, onResetMemberPassword, onReorderMembers, draggingMemberId, setDraggingMemberId }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>팀 관리</h1>
          <p>{currentTeam.department} 팀의 멤버와 과제 기준 정보를 관리합니다</p>
        </div>
      </div>

      <div className="subtab-row">
        <button className={`subtab${activeTeamTab === 'members' ? ' active' : ''}`} type="button" onClick={() => setActiveTeamTab('members')}><Users size={15} />멤버 관리</button>
        <button className={`subtab${activeTeamTab === 'tasks' ? ' active' : ''}`} type="button" onClick={() => setActiveTeamTab('tasks')}><ClipboardList size={15} />과제 관리</button>
      </div>

      {activeTeamTab === 'members' ? (
        <section className="account-card">
          <div className="member-guide">
            <strong>초기 비밀번호: {INITIAL_PASSWORD}</strong>
            <span>초기 비밀번호 상태의 멤버는 개인 비밀번호 설정이 필요합니다.</span>
          </div>
          <div className="member-form">
            <input placeholder="이름" value={memberDraft.name} onChange={(e) => setMemberDraft({ ...memberDraft, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onCreateMember()} />
            <select value={memberDraft.role} onChange={(e) => setMemberDraft({ ...memberDraft, role: e.target.value })}>
              <option value="L">리더</option>
              <option value="CM">책임매니저</option>
              <option value="M">매니저</option>
            </select>
            <button className="mt-btn primary" type="button" onClick={onCreateMember}><Plus size={15} />멤버 추가</button>
          </div>
          <div className="member-table">
            <div className="member-table-head"><span>이름</span><span>직급</span><span>User ID</span><span>비밀번호 상태/관리</span><span></span></div>
            {members.map((member) => (
              <div
                className={`member-row${draggingMemberId === member.user_id ? ' dragging' : ''}`}
                key={member.user_id}
                draggable
                onDragStart={(event) => {
                  setDraggingMemberId(member.user_id);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', member.user_id);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId = event.dataTransfer.getData('text/plain') || draggingMemberId;
                  if (!sourceId || sourceId === member.user_id) return;
                  const fromIndex = members.findIndex((item) => item.user_id === sourceId);
                  const toIndex = members.findIndex((item) => item.user_id === member.user_id);
                  if (fromIndex < 0 || toIndex < 0) return;
                  const nextMembers = [...members];
                  const [movedMember] = nextMembers.splice(fromIndex, 1);
                  nextMembers.splice(toIndex, 0, movedMember);
                  onReorderMembers(nextMembers);
                }}
                onDragEnd={() => setDraggingMemberId(null)}
              >
                <strong className="member-name"><GripVertical className="member-drag-icon" size={15} aria-hidden="true" />{member.name}</strong>
                <select className="member-role-select" value={member.role} onChange={(event) => onUpdateMemberRole(member.user_id, event.target.value)} onMouseDown={(event) => event.stopPropagation()}>
                  <option value="L">리더</option>
                  <option value="CM">책임매니저</option>
                  <option value="M">매니저</option>
                </select>
                <code>{member.user_id}</code>
                <div className="member-password-box">
                  {member.must_change_password ? (
                    <div className="member-password-inline">
                      <span className="password-state initial">비밀번호 설정 필요</span>
                      <input type="password" placeholder="새 비밀번호" value={memberPasswordDrafts[member.user_id] || ''} onChange={(e) => setMemberPasswordDrafts((prev) => ({ ...prev, [member.user_id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && onSetMemberPassword(member.user_id)} />
                      <button className="mt-btn sm" type="button" onClick={() => onSetMemberPassword(member.user_id)}>설정</button>
                    </div>
                  ) : (
                    <>
                      <span className="password-state">비밀번호 설정 완료</span>
                      <button className="mt-btn sm" type="button" onClick={() => onResetMemberPassword(member.user_id)}>초기화</button>
                    </>
                  )}
                </div>
                <button className="mt-btn danger sm" type="button" onClick={() => onDeleteMember(member.user_id)}><Trash2 size={13} />제거</button>
              </div>
            ))}
            {members.length === 0 && <div className="empty">등록된 멤버가 없습니다</div>}
          </div>
        </section>
      ) : (
        <ProjectManagementBoard
          members={members}
          teamProjects={teamProjects}
          teamProjectDraft={teamProjectDraft}
          setTeamProjectDraft={setTeamProjectDraft}
          isProjectModalOpen={isProjectModalOpen}
          setIsProjectModalOpen={setIsProjectModalOpen}
          editingTeamProjectId={editingTeamProjectId}
          setEditingTeamProjectId={setEditingTeamProjectId}
          onCreateTeamProject={onCreateTeamProject}
          onEditTeamProject={onEditTeamProject}
          onUpdateTeamProjectStatus={onUpdateTeamProjectStatus}
          onDeleteTeamProject={onDeleteTeamProject}
        />
      )}
    </>
  );
}


function ProjectManagementBoard({ members, teamProjects, teamProjectDraft, setTeamProjectDraft, isProjectModalOpen, setIsProjectModalOpen, editingTeamProjectId, setEditingTeamProjectId, onCreateTeamProject, onEditTeamProject, onUpdateTeamProjectStatus, onDeleteTeamProject }) {
  const inProgressProjects = teamProjects.filter((project) => project.status !== 'done');
  const doneProjects = teamProjects.filter((project) => project.status === 'done');

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
          <p>진행중인 과제와 완료된 과제를 분리해서 관리합니다.</p>
        </div>
        <button className="mt-btn primary" type="button" onClick={() => { setEditingTeamProjectId(null); setTeamProjectDraft({ project_name: '', leaderId: '', memberIds: [], status: 'in_progress' }); setIsProjectModalOpen(true); }}><Plus size={15} />과제 추가</button>
      </section>

      <div className="project-board-grid">
        <ProjectColumn
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
          <div className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
            <div className="project-modal-head">
              <div>
                <h2 id="project-create-title">{editingTeamProjectId ? '과제 수정' : '과제 추가'}</h2>
                <p>과제 정보와 참여 멤버를 지정합니다.</p>
              </div>
              <button className="icon-btn" type="button" onClick={closeModal} aria-label="닫기"><X size={16} /></button>
            </div>
            <label className="project-leader-field">
              <span>과제명</span>
              <input autoFocus placeholder="과제명을 입력하세요" value={teamProjectDraft.project_name} onChange={(e) => setTeamProjectDraft((prev) => ({ ...prev, project_name: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && onCreateTeamProject()} />
            </label>
            <label className="project-leader-field">
              <span>과제 리더</span>
              <select value={teamProjectDraft.leaderId || ''} onChange={(e) => setTeamProjectDraft((prev) => ({ ...prev, leaderId: e.target.value, memberIds: (prev.memberIds || []).filter((userId) => userId !== e.target.value) }))}>
                <option value="">리더 선택</option>
                {members.map((member) => <option key={member.user_id} value={member.user_id}>{member.name} ({ROLE_LABELS[member.role] || member.role})</option>)}
              </select>
            </label>
            <div className="project-member-picker">
              <span>과제 멤버</span>
              <div className="project-member-options modal-options">
                <button className={`project-member-none${(teamProjectDraft.memberIds || []).length === 0 ? ' active' : ''}`} type="button" onClick={() => setTeamProjectDraft((prev) => ({ ...prev, memberIds: [] }))}>없음</button>
                {members.map((member) => {
                  const disabled = member.user_id === teamProjectDraft.leaderId;
                  const checked = !disabled && (teamProjectDraft.memberIds || []).includes(member.user_id);
                  return (
                    <label className={`project-member-option${disabled ? ' disabled' : ''}`} key={member.user_id}>
                      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => updateDraftMember(member.user_id, e.target.checked)} />
                      <span>{member.name}</span>
                    </label>
                  );
                })}
                {members.length === 0 && <div className="empty compact">등록된 멤버가 없습니다</div>}
              </div>
            </div>
            <div className="project-modal-actions">
              <button className="mt-btn" type="button" onClick={closeModal}>취소</button>
              <button className="mt-btn primary" type="button" onClick={onCreateTeamProject}><Save size={13} />{editingTeamProjectId ? '저장' : '추가'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ProjectColumn({ title, projects, emptyText, nextActionLabel, nextStatus, onMove, onEdit, onDelete }) {
  return (
    <section className="project-column">
      <div className="project-column-head">
        <h3>{title}</h3>
        <span>{projects.length}</span>
      </div>
      <div className="project-card-list">
        {projects.map((project) => <ProjectCard key={project.project_id} project={project} actionLabel={nextActionLabel} nextStatus={nextStatus} onMove={onMove} onEdit={onEdit} onDelete={onDelete} />)}
        {projects.length === 0 && <div className="empty compact">{emptyText}</div>}
      </div>
    </section>
  );
}

function ProjectCard({ project, actionLabel, nextStatus, onMove, onEdit, onDelete }) {
  const leader = project.members.find((member) => member.role === 'L');
  const projectMembers = project.members.filter((member) => member.role === 'M');
  return (
    <article className="team-project-card">
      <div className="team-project-card-head">
        <div>
          <strong>{project.project_name}</strong>
        </div>
        <span className={`project-status ${project.status === 'done' ? 'done' : 'active'}`}>{project.status === 'done' ? '완료' : '진행중'}</span>
      </div>
      <div className="project-role-lines">
        <div><b>리더</b><span>{leader ? leader.name : '미지정'}</span></div>
        <div><b>멤버</b><span>{projectMembers.length ? projectMembers.map((member) => member.name).join(', ') : '없음'}</span></div>
      </div>
      <div className="team-project-card-actions">
        <button className="project-card-btn" type="button" onClick={() => onEdit(project)}><Pencil size={13} />수정</button>
        <button className="project-card-btn primary" type="button" onClick={() => onMove(project.project_id, nextStatus)}>{actionLabel}</button>
        <button className="project-card-btn danger" type="button" onClick={() => onDelete(project.project_id)}><Trash2 size={13} />삭제</button>
      </div>
    </article>
  );
}


function AccountManagementPage({ teams, teamDraft, setTeamDraft, onCreateTeam }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>계정 관리</h1>
          <p>팀 계정을 부여하면 초기 비밀번호는 {INITIAL_PASSWORD}로 설정됩니다</p>
        </div>
      </div>

      <section className="account-card">
        <div className="account-form team-form">
          <input placeholder="소속" value={teamDraft.department} onChange={(e) => setTeamDraft({ ...teamDraft, department: e.target.value })} />
          <input placeholder="ID" value={teamDraft.login_id} onChange={(e) => setTeamDraft({ ...teamDraft, login_id: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onCreateTeam()} />
          <button className="mt-btn primary" type="button" onClick={onCreateTeam}><Plus size={15} />계정 부여</button>
        </div>
      </section>

      <section className="account-card">
        <div className="account-table team-table">
          <div className="account-table-head">
            <span>소속</span><span>ID</span><span>Team ID</span><span>상태</span>
          </div>
          {teams.map((team) => (
            <div className="account-row" key={team.team_id}>
              <strong>{team.department}</strong>
              <span>{team.login_id}</span>
              <code>{team.team_id}</code>
              <span className={`password-state${team.must_change_password ? ' initial' : ''}`}>{team.must_change_password ? '초기 비밀번호' : '변경 완료'}</span>
            </div>
          ))}
          {teams.length === 0 && <div className="empty">등록된 팀 계정이 없습니다</div>}
        </div>
      </section>
    </>
  );
}


function PasswordChangeModal({ passwordDraft, setPasswordDraft, onChangePassword }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="password-modal" role="dialog" aria-modal="true" aria-labelledby="password-change-title">
        <div>
          <h2 id="password-change-title">비밀번호 변경</h2>
          <p>초기 비밀번호를 사용 중입니다. 계속하려면 새 비밀번호로 변경하세요.</p>
        </div>
        <input type="password" placeholder="현재 비밀번호" value={passwordDraft.current_password} onChange={(e) => setPasswordDraft({ ...passwordDraft, current_password: e.target.value })} />
        <input type="password" placeholder="새 비밀번호" value={passwordDraft.new_password} onChange={(e) => setPasswordDraft({ ...passwordDraft, new_password: e.target.value })} />
        <input type="password" placeholder="새 비밀번호 확인" value={passwordDraft.confirm_password} onChange={(e) => setPasswordDraft({ ...passwordDraft, confirm_password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onChangePassword()} />
        <button className="mt-btn primary" type="button" onClick={onChangePassword}>변경</button>
      </div>
    </div>
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
}) {
  const [addingEpicId, setAddingEpicId] = useState(null);
  const [epicDraft, setEpicDraft] = useState({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });
  const [editingEpicId, setEditingEpicId] = useState(null);
  const [editingMilestoneId, setEditingMilestoneId] = useState(null);
  const [milestoneEditDraft, setMilestoneEditDraft] = useState({ title: '', start_date: todayIso(), end_date: todayIso() });
  const [editDraft, setEditDraft] = useState({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });

  const range = useMemo(() => {
    const dates = milestones.flatMap((milestone) => [milestone.start_date, milestone.end_date]);
    if (dates.length === 0) return { start: milestoneDraft.start_date, end: milestoneDraft.end_date };
    return { start: dates.reduce((a, b) => (a < b ? a : b)), end: dates.reduce((a, b) => (a > b ? a : b)) };
  }, [milestones, milestoneDraft.start_date, milestoneDraft.end_date]);

  const days = useMemo(() => businessDaysBetween(range.start, range.end), [range.start, range.end]);
  const colCount = Math.max(1, days.length);
  const dayIndex = useMemo(() => {
    const map = new Map();
    days.forEach((day, i) => map.set(isoOf(day), i));
    return map;
  }, [days]);
  const gridTemplate = `240px repeat(${colCount}, minmax(64px, 1fr))`;

  function spanFor(startDate, endDate) {
    const itemDays = businessDaysBetween(startDate, endDate);
    const first = itemDays[0] ? isoOf(itemDays[0]) : startDate;
    const last = itemDays[itemDays.length - 1] ? isoOf(itemDays[itemDays.length - 1]) : endDate;
    const startCol = dayIndex.has(first) ? dayIndex.get(first) : 0;
    const endCol = dayIndex.has(last) ? dayIndex.get(last) : colCount - 1;
    return { startCol, colSpan: Math.max(1, endCol - startCol + 1) };
  }

  function startAddEpic(milestone) {
    setAddingEpicId(milestone.id);
    setEditingEpicId(null);
    setEditingMilestoneId(null);
    setEpicDraft({ name: '', owner: '', status: 'planned', start_date: milestone.start_date, end_date: milestone.start_date });
  }

  function commitAddEpic(milestone) {
    if (!epicDraft.name.trim()) {
      setAddingEpicId(null);
      return;
    }
    onAddEpic(milestone, epicDraft);
    setEpicDraft({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });
    setAddingEpicId(null);
  }

  function startEditEpic(epic) {
    setAddingEpicId(null);
    setEditingMilestoneId(null);
    setEditingEpicId(epic.id);
    setEditDraft({
      name: epic.title,
      owner: epic.owner || '',
      status: normalizeStatus(epic.status),
      start_date: epic.start_date,
      end_date: epic.end_date,
    });
  }

  function commitEditEpic(epic) {
    if (!editDraft.name.trim()) {
      setEditingEpicId(null);
      return;
    }
    onUpdateEpic(epic, editDraft);
    setEditingEpicId(null);
  }

  function startEditMilestone(milestone) {
    setAddingEpicId(null);
    setEditingEpicId(null);
    setEditingMilestoneId(milestone.id);
    setMilestoneEditDraft({ title: milestone.title, start_date: milestone.start_date, end_date: milestone.end_date });
  }

  function commitEditMilestone(milestone) {
    if (!milestoneEditDraft.title.trim()) {
      setEditingMilestoneId(null);
      return;
    }
    onUpdateMilestone(milestone, milestoneEditDraft);
    setEditingMilestoneId(null);
  }

  return (
    <article className="mt-card project-card">
      <div className="mt-card-titlebar">
        <div>
          <h2 className="mt-title">{project.title}</h2>
        </div>
      </div>

      <div className="mt-card-head">
        <p className="mt-card-eyebrow"><AudioWaveform size={14} color="#4F46E5" />Project Timeline</p>
        <p className="mt-card-sub mono">{range.start} → {range.end} · Milestone {milestones.length}개</p>
      </div>

      <div className="mt-grid-wrap">
        <div className="mt-grid project-grid" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="mt-headercell">Milestone / Epic</div>
          {days.map((day) => (
            <div key={isoOf(day)} className={`mt-daycell${day.getDay() === 1 ? ' weekend-adjacent' : ''}`}>
              <div className="num">{String(day.getDate()).padStart(2, '0')}</div>
              <div className="dow">{DOW[day.getDay()]}</div>
            </div>
          ))}

          {milestones.map((milestone) => {
            const milestoneSpan = spanFor(milestone.start_date, milestone.end_date);
            const isAddingEpic = addingEpicId === milestone.id;
            const isEditingMilestone = editingMilestoneId === milestone.id;
            return (
              <React.Fragment key={milestone.id}>
                <div className={`mt-row-label milestone-label${isEditingMilestone ? ' editing' : ''}`}>
                  {isEditingMilestone ? (
                    <div className="milestone-edit-fields">
                      <input value={milestoneEditDraft.title} autoFocus onChange={(e) => setMilestoneEditDraft({ ...milestoneEditDraft, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitEditMilestone(milestone)} />
                      <div className="meta">{milestone.start_date} → {milestone.end_date}</div>
                    </div>
                  ) : (
                    <div>
                      <div className="name">{milestone.title}</div>
                      <div className="meta">{milestone.start_date} → {milestone.end_date}</div>
                    </div>
                  )}
                  <div className="row-actions">
                    {isEditingMilestone ? (
                      <>
                        <button className="mt-icon-action save" onClick={() => commitEditMilestone(milestone)} aria-label="마일스톤 저장"><Save size={13} /></button>
                        <button className="mt-icon-action" onClick={() => setEditingMilestoneId(null)} aria-label="마일스톤 편집 취소"><X size={13} /></button>
                      </>
                    ) : (
                      <>
                        <button className="mt-icon-action always" onClick={() => startEditMilestone(milestone)} aria-label="마일스톤 편집"><Pencil size={13} /></button>
                        <button className="mt-delete always" onClick={() => onRemoveMilestone(milestone.id)} aria-label="마일스톤 삭제"><Trash2 size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
                <div className={`mt-track milestone-track${isEditingMilestone ? ' editing' : ''}`} style={{ gridColumn: `2 / span ${colCount}`, gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                  {days.map((day, i) => <div key={isoOf(day)} className={`mt-daybg${day.getDay() === 1 ? ' weekend-adjacent' : ''}`} style={{ gridRow: 1, gridColumn: i + 1 }} />)}
                  {isEditingMilestone ? (
                    <div className="mt-date-inputs milestone-edit-track" style={{ gridColumn: `1 / span ${colCount}` }}>
                      <input type="date" value={milestoneEditDraft.start_date} onChange={(e) => setMilestoneEditDraft({ ...milestoneEditDraft, start_date: e.target.value })} />
                      <span>→</span>
                      <input type="date" value={milestoneEditDraft.end_date} onChange={(e) => setMilestoneEditDraft({ ...milestoneEditDraft, end_date: e.target.value })} />
                    </div>
                  ) : (
                    <div className="milestone-bar" style={{ gridColumn: `${milestoneSpan.startCol + 1} / span ${milestoneSpan.colSpan}` }}>
                      <AudioWaveform size={14} className="icon" />
                      <span className="label">{milestone.title}</span>
                      <span className="count">{milestone.epics.length} epics</span>
                    </div>
                  )}
                </div>

                {milestone.epics.map((epic, index) => {
                  const epicSpan = spanFor(epic.start_date, epic.end_date);
                  const status = STATUS_STYLE[normalizeStatus(epic.status)] || STATUS_STYLE.planned;
                  const isLast = index === milestone.epics.length - 1 && !isAddingEpic;
                  const isEditing = editingEpicId === epic.id;
                  return (
                    <React.Fragment key={epic.id}>
                      <div className={`mt-row-label epic${isLast ? ' last' : ''}${isEditing ? ' editing' : ''}`}>
                        {isEditing ? (
                          <div className="epic-edit-fields">
                            <input value={editDraft.name} autoFocus onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitEditEpic(epic)} />
                            <input value={editDraft.owner} placeholder="담당" onChange={(e) => setEditDraft({ ...editDraft, owner: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitEditEpic(epic)} />
                          </div>
                        ) : (
                          <div><div className="name">{epic.title}</div><div className="meta"><span className="mt-avatar"><User size={9} /></span>{epic.owner || '담당 미지정'} · <span className="mt-badge" style={{ background: status.bg, color: status.text }}>{status.label}</span></div></div>
                        )}
                        <div className="row-actions">
                          {isEditing ? (
                            <>
                              <button className="mt-icon-action save" onClick={() => commitEditEpic(epic)} aria-label="Epic 저장"><Save size={13} /></button>
                              <button className="mt-icon-action" onClick={() => setEditingEpicId(null)} aria-label="Epic 편집 취소"><X size={13} /></button>
                            </>
                          ) : (
                            <>
                              <button className="mt-icon-action" onClick={() => startEditEpic(epic)} aria-label="Epic 편집"><Pencil size={13} /></button>
                              <button className="mt-delete" onClick={() => onRemoveEpic(epic.id)} aria-label="Epic 삭제"><Trash2 size={13} /></button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="mt-track" style={{ gridColumn: `2 / span ${colCount}`, gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                        {days.map((day, i) => <div key={isoOf(day)} className={`mt-daybg${day.getDay() === 1 ? ' weekend-adjacent' : ''}`} style={{ gridRow: 1, gridColumn: i + 1 }} />)}
                        {isEditing ? (
                          <div className="mt-date-inputs epic-edit-track" style={{ gridColumn: `1 / span ${colCount}` }}>
                            <select value={editDraft.status} onChange={(e) => setEditDraft({ ...editDraft, status: e.target.value })}>
                              <option value="planned">예정</option>
                              <option value="in_progress">진행중</option>
                              <option value="done">완료</option>
                              <option value="blocked">차단</option>
                            </select>
                            <input type="date" min={milestone.start_date} max={milestone.end_date} value={editDraft.start_date} onChange={(e) => setEditDraft({ ...editDraft, start_date: e.target.value })} />
                            <span>→</span>
                            <input type="date" min={milestone.start_date} max={milestone.end_date} value={editDraft.end_date} onChange={(e) => setEditDraft({ ...editDraft, end_date: e.target.value })} />
                          </div>
                        ) : (
                          <div className="mt-bar" style={{ gridColumn: `${epicSpan.startCol + 1} / span ${epicSpan.colSpan}`, background: epic.color || accentFor(index).bar }}>
                            <div className="wave"><WaveBar widthPx={epicSpan.colSpan * 70} color="#FFFFFF" /></div>
                            <span className="label">{epic.title}</span>
                          </div>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}

                <div className={`mt-row-label epic last add-slot${isAddingEpic ? ' editing' : ''}`}>
                  {isAddingEpic ? (
                    <div className="mt-add-form"><input name="name" placeholder="Epic 이름" value={epicDraft.name} autoFocus onChange={(e) => setEpicDraft({ ...epicDraft, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitAddEpic(milestone)} /></div>
                  ) : (
                    <button className="mt-add-leaf" onClick={() => startAddEpic(milestone)}><CornerDownRight size={13} />Epic 추가</button>
                  )}
                </div>
                <div className={`mt-track add-track${isAddingEpic ? ' editing' : ''}`} style={{ gridColumn: `2 / span ${colCount}`, gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                  {days.map((day, i) => <div key={isoOf(day)} className="mt-daybg" style={{ gridRow: 1, gridColumn: i + 1 }} />)}
                  {isAddingEpic && (
                    <div className="mt-date-inputs" style={{ gridColumn: `1 / span ${colCount}` }}>
                      <input placeholder="담당" value={epicDraft.owner} onChange={(e) => setEpicDraft({ ...epicDraft, owner: e.target.value })} />
                      <input type="date" min={milestone.start_date} max={milestone.end_date} value={epicDraft.start_date} onChange={(e) => setEpicDraft({ ...epicDraft, start_date: e.target.value })} />
                      <span>→</span>
                      <input type="date" min={milestone.start_date} max={milestone.end_date} value={epicDraft.end_date} onChange={(e) => setEpicDraft({ ...epicDraft, end_date: e.target.value })} />
                      <button className="mt-btn primary sm" onMouseDown={(e) => e.preventDefault()} onClick={() => commitAddEpic(milestone)}>추가</button>
                      <button className="mt-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setAddingEpicId(null)}>취소</button>
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}

          <div className={`timeline-add-milestone${addingMilestone ? ' editing' : ''}`} style={{ gridColumn: `1 / span ${colCount + 1}` }}>
            {addingMilestone ? (
              <div className="add-milestone-form">
                <input name="mtitle" placeholder="마일스톤 이름" value={milestoneDraft.title} autoFocus onChange={(e) => setMilestoneDraft({ ...milestoneDraft, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onAddMilestone()} />
                <input type="date" value={milestoneDraft.start_date} onChange={(e) => setMilestoneDraft({ ...milestoneDraft, start_date: e.target.value })} />
                <span>→</span>
                <input type="date" value={milestoneDraft.end_date} onChange={(e) => setMilestoneDraft({ ...milestoneDraft, end_date: e.target.value })} />
                <button className="mt-btn primary sm" onClick={onAddMilestone}>추가</button>
                <button className="mt-btn sm" onClick={() => setAddingMilestone(false)}>취소</button>
              </div>
            ) : (
              <button className="add-milestone-btn" onClick={() => setAddingMilestone(true)}><Plus size={15} />마일스톤 추가</button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

createRoot(document.getElementById('root')).render(<App />);
