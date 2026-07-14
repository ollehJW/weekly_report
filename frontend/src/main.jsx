import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, AudioWaveform, User, ChevronRight, CornerDownRight, Pencil, Save, X, KeyRound, LogOut, Users, ClipboardList } from 'lucide-react';
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
  const [teamDraft, setTeamDraft] = useState({ department: '', login_id: '' });
  const [memberDraft, setMemberDraft] = useState({ name: '', role: 'M' });
  const [memberPasswordDrafts, setMemberPasswordDrafts] = useState({});
  const [loginDraft, setLoginDraft] = useState({ login_id: '', password: '' });
  const [passwordDraft, setPasswordDraft] = useState({ current_password: INITIAL_PASSWORD, new_password: '', confirm_password: '' });

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;

  async function loadProjects(nextProjectId) {
    const list = await request('/api/projects');
    setProjects(list);
    const id = nextProjectId !== undefined ? nextProjectId : selectedProjectId || list[0]?.id || null;
    setSelectedProjectId(id);
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

  async function refresh(projectId) {
    setError('');
    const id = await loadProjects(projectId);
    await Promise.all([loadMilestones(id), loadTeams(), currentTeam?.team_id ? loadMembers(currentTeam.team_id) : Promise.resolve()]);
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
    loadMembers(currentTeam.team_id).catch((err) => setError(err.message));
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

  async function deleteMember(userId) {
    try {
      await request(`/api/users/${userId}`, { method: 'DELETE' });
      await loadMembers(currentTeam.team_id);
    } catch (err) {
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
                <p>{selectedProject ? `${milestones.length}개의 마일스톤 · ${selectedProject.title}` : '프로젝트를 선택하세요'}</p>
              </div>
              <div className="project-toolbar">
                <label htmlFor="project-select">프로젝트</label>
                <select id="project-select" className="project-select" value={selectedProjectId || ''} onChange={(e) => setSelectedProjectId(Number(e.target.value) || null)}>
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
                onRemoveMilestone={deleteMilestone}
                onAddEpic={createEpic}
                onUpdateEpic={updateEpic}
                onRemoveEpic={deleteEpic}
              />
            )}
          </>
        )}
        {activePage === 'team' && (
          <TeamManagementPage
            activeTeamTab={activeTeamTab}
            setActiveTeamTab={setActiveTeamTab}
            currentTeam={currentTeam}
            members={members}
            memberDraft={memberDraft}
            setMemberDraft={setMemberDraft}
            memberPasswordDrafts={memberPasswordDrafts}
            setMemberPasswordDrafts={setMemberPasswordDrafts}
            onCreateMember={createMember}
            onDeleteMember={deleteMember}
            onSetMemberPassword={setMemberPassword}
            onResetMemberPassword={resetMemberPassword}
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


function TeamManagementPage({ activeTeamTab, setActiveTeamTab, currentTeam, members, memberDraft, setMemberDraft, memberPasswordDrafts, setMemberPasswordDrafts, onCreateMember, onDeleteMember, onSetMemberPassword, onResetMemberPassword }) {
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
              <div className="member-row" key={member.user_id}>
                <strong>{member.name}</strong>
                <span>{ROLE_LABELS[member.role] || member.role}</span>
                <code>{member.user_id}</code>
                <div className="member-password-box">
                  {member.must_change_password ? (
                    <>
                      <div className="member-password-status">
                        <span className="password-state initial">초기 비밀번호</span>
                        <span className="member-password-warning">비밀번호 설정 필요</span>
                      </div>
                      <div className="member-password-action">
                        <input type="password" placeholder="새 비밀번호" value={memberPasswordDrafts[member.user_id] || ''} onChange={(e) => setMemberPasswordDrafts((prev) => ({ ...prev, [member.user_id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && onSetMemberPassword(member.user_id)} />
                        <button className="mt-btn sm" type="button" onClick={() => onSetMemberPassword(member.user_id)}>설정</button>
                      </div>
                    </>
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
        <section className="account-card team-placeholder">
          <ClipboardList size={22} />
          <div>
            <h2>과제 관리</h2>
            <p>팀 단위 과제 관리 기준을 이 영역에 확장할 수 있도록 준비했습니다.</p>
          </div>
        </section>
      )}
    </>
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
  onRemoveMilestone,
  onAddEpic,
  onUpdateEpic,
  onRemoveEpic,
}) {
  const [addingEpicId, setAddingEpicId] = useState(null);
  const [epicDraft, setEpicDraft] = useState({ name: '', owner: '', status: 'planned', start_date: todayIso(), end_date: todayIso() });
  const [editingEpicId, setEditingEpicId] = useState(null);
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
            return (
              <React.Fragment key={milestone.id}>
                <div className="mt-row-label milestone-label">
                  <div>
                    <div className="name">{milestone.title}</div>
                    <div className="meta">{milestone.start_date} → {milestone.end_date}</div>
                  </div>
                  <button className="mt-delete always" onClick={() => onRemoveMilestone(milestone.id)} aria-label="마일스톤 삭제"><Trash2 size={13} /></button>
                </div>
                <div className="mt-track milestone-track" style={{ gridColumn: `2 / span ${colCount}`, gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                  {days.map((day, i) => <div key={isoOf(day)} className={`mt-daybg${day.getDay() === 1 ? ' weekend-adjacent' : ''}`} style={{ gridRow: 1, gridColumn: i + 1 }} />)}
                  <div className="milestone-bar" style={{ gridColumn: `${milestoneSpan.startCol + 1} / span ${milestoneSpan.colSpan}` }}>
                    <AudioWaveform size={14} className="icon" />
                    <span className="label">{milestone.title}</span>
                    <span className="count">{milestone.epics.length} epics</span>
                  </div>
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
